import { createHash } from "node:crypto";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { rawTransactionToHash, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  CREATION_REVIEW_EXPIRY_CONDITION,
  CREATION_REVIEW_WINDOW_BLOCKS,
  CancellationBuildError,
  RECOVERY_REASONS,
  RecoveryBuildError,
  TopUpBuildError,
  assertCancellationCompletion,
  assertDeadlineCompletion,
  assertRecoveryCompletion,
  assertRecurringCompletion,
  assertTopUpCompletion,
  buildCancellation,
  buildDeadlineCreation,
  buildRecovery,
  buildRecurringCreation,
  buildTopUp,
  deploymentRegistry,
  minimumPlainCellCapacity,
  parseDeadlineCreationRequest,
  parseHash32,
  parseOutPoint,
  parseRecurringCreationRequest,
  parseShannons,
  type LiveCellResolver,
  type OperatorAutomationDeployment,
  type RegisteredDeployment,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import { CkbClientError, type CkbClient } from "./ckb-client.ts";
import { LockResolutionStoreError, type LockResolutionRecorder } from "./lock-resolutions.ts";
import { JOB_QUOTE_ASSUMPTIONS, JobQuoteService, type JobQuote } from "./quotes.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const BYTE_HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const NUMERIC_HEX_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export const TRANSACTION_OPERATIONS = [
  "create_deadline_job",
  "create_recurring_job",
  "cancel_job",
  "recover_job",
  "top_up_job",
] as const;

export type TransactionOperation = (typeof TRANSACTION_OPERATIONS)[number];
export type TransactionChainClient = Pick<
  CkbClient,
  "dryRun" | "getBlockByNumber" | "getTipHeader" | "getTransactionStatus"
>;

export interface TransactionBuildResponse {
  readonly operation: TransactionOperation;
  readonly transaction: UnsignedDeadlineTransaction;
  readonly signingEntries: readonly {
    readonly role: "funding" | "owner_authorization" | "pledge";
    readonly inputIndices: readonly string[];
    readonly walletAction: "append_inputs_and_change" | "sign_existing_inputs";
  }[];
  readonly intent: unknown;
  readonly intentHash: string;
  readonly protocolIntentHash: string | null;
  readonly policyCriticalHash: string;
  readonly chainSnapshot: unknown;
  readonly quoteExpiry: unknown;
  readonly quote: unknown;
}

export interface SignedTransactionValidation {
  readonly valid: true;
  readonly operation: TransactionOperation;
  readonly intentHash: string;
  readonly policyCriticalHash: string;
  readonly dryRunCycles: string;
}

interface BuiltArtifact {
  readonly response: TransactionBuildResponse;
  readonly assertCompletion: (transaction: UnsignedDeadlineTransaction) => void;
  readonly lockResolutions?: readonly ScriptIdentity[];
  readonly pendingCreation?: PendingCreationMetadata;
}

export interface PendingCreationMetadata {
  readonly jobId: string;
  readonly notBefore: string;
  readonly ownerLockHash: string;
  readonly recipientAmount: {
    readonly perExecution: string;
    readonly total: string;
  };
  readonly remainingRuns: string;
  readonly template: "deadline" | "recurring";
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${name} contains unsupported fields`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function hash(value: unknown, name: string): ReturnType<typeof parseHash32> {
  const parsed = text(value, name);
  if (!HASH_PATTERN.test(parsed)) throw new TypeError(`${name} must be a lowercase 32-byte hash`);
  return parseHash32(parsed);
}

function bytes(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!BYTE_HEX_PATTERN.test(parsed)) throw new TypeError(`${name} must be canonical byte hex`);
  return parsed as `0x${string}`;
}

function numericHex(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!NUMERIC_HEX_PATTERN.test(parsed)) {
    throw new TypeError(`${name} must be canonical lowercase numeric hex`);
  }
  return parsed as `0x${string}`;
}

function decimal(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!DECIMAL_PATTERN.test(parsed)) throw new TypeError(`${name} must be a canonical decimal`);
  return parsed;
}

function script(value: unknown, name: string): ScriptIdentity {
  const parsed = record(value, name);
  exact(parsed, ["codeHash", "hashType", "args"], name);
  const hashType = text(parsed["hashType"], `${name}.hashType`);
  if (hashType !== "data" && hashType !== "data1" && hashType !== "type") {
    throw new TypeError(`${name}.hashType is unsupported`);
  }
  return Object.freeze({
    codeHash: hash(parsed["codeHash"], `${name}.codeHash`),
    hashType,
    args: bytes(parsed["args"], `${name}.args`),
  });
}

function creationInput(
  value: unknown,
  name: string,
): { readonly request: Record<string, unknown>; readonly resolutions: readonly ScriptIdentity[] } {
  const parsed = record(value, name);
  const values = parsed["lockResolutions"];
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new TypeError(`${name}.lockResolutions must contain between one and 32 scripts`);
  }
  return Object.freeze({
    request: Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "lockResolutions"),
    ),
    resolutions: Object.freeze(
      values.map((item, index) => script(item, `${name}.lockResolutions[${index}]`)),
    ),
  });
}

function verifiedResolutions(
  values: readonly ScriptIdentity[],
  requiredHashes: readonly string[],
): readonly ScriptIdentity[] {
  const required = new Set(requiredHashes.map((value) => parseHash32(value)));
  const resolved = new Map<string, ScriptIdentity>();
  for (const value of values) {
    const lockHash = parseHash32(scriptToHash(value));
    if (!required.has(lockHash)) {
      throw new TypeError("lockResolutions contains a script that is not used by this automation");
    }
    const existing = resolved.get(lockHash);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new TypeError("lockResolutions contains conflicting scripts for one hash");
    }
    resolved.set(lockHash, value);
  }
  const missing = [...required].filter((lockHash) => !resolved.has(lockHash));
  if (missing.length > 0) {
    throw new TypeError("lockResolutions must resolve every recipient and recovery address");
  }
  return Object.freeze([...resolved.values()]);
}

function resolvedLock(resolutions: readonly ScriptIdentity[], lockHash: string): ScriptIdentity {
  const expected = parseHash32(lockHash);
  const lock = resolutions.find((value) => parseHash32(scriptToHash(value)) === expected);
  if (!lock) throw new TypeError("resolved lock is unavailable");
  return lock;
}

function requirePlainOutputCapacity(value: string, lock: ScriptIdentity, name: string): void {
  const amount = parseShannons(value);
  const minimum = minimumPlainCellCapacity(lock);
  if (amount < minimum) {
    throw new RangeError(`${name} must be at least ${minimum} shannons for this address`);
  }
}

function parseTransaction(value: unknown): UnsignedDeadlineTransaction {
  const parsed = record(value, "transaction");
  exact(
    parsed,
    ["version", "cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"],
    "transaction",
  );
  const version = numericHex(parsed["version"], "transaction.version");
  if (version !== "0x0") throw new TypeError("transaction.version must be 0x0");
  if (!Array.isArray(parsed["cellDeps"]))
    throw new TypeError("transaction.cellDeps must be an array");
  if (!Array.isArray(parsed["headerDeps"]))
    throw new TypeError("transaction.headerDeps must be an array");
  if (!Array.isArray(parsed["inputs"])) throw new TypeError("transaction.inputs must be an array");
  if (!Array.isArray(parsed["outputs"]))
    throw new TypeError("transaction.outputs must be an array");
  if (!Array.isArray(parsed["outputsData"]))
    throw new TypeError("transaction.outputsData must be an array");
  if (!Array.isArray(parsed["witnesses"]))
    throw new TypeError("transaction.witnesses must be an array");

  const cellDeps = parsed["cellDeps"].map((item, index) => {
    const dep = record(item, `transaction.cellDeps[${index}]`);
    exact(dep, ["outPoint", "depType"], `transaction.cellDeps[${index}]`);
    const point = record(dep["outPoint"], `transaction.cellDeps[${index}].outPoint`);
    exact(point, ["txHash", "index"], `transaction.cellDeps[${index}].outPoint`);
    const depType = text(dep["depType"], `transaction.cellDeps[${index}].depType`);
    if (depType !== "code" && depType !== "depGroup") {
      throw new TypeError(`transaction.cellDeps[${index}].depType is unsupported`);
    }
    return Object.freeze({
      outPoint: Object.freeze({
        txHash: hash(point["txHash"], `transaction.cellDeps[${index}].outPoint.txHash`),
        index: numericHex(point["index"], `transaction.cellDeps[${index}].outPoint.index`),
      }),
      depType,
    });
  });
  const inputs = parsed["inputs"].map((item, index) => {
    const input = record(item, `transaction.inputs[${index}]`);
    exact(input, ["since", "previousOutput"], `transaction.inputs[${index}]`);
    const point = record(input["previousOutput"], `transaction.inputs[${index}].previousOutput`);
    exact(point, ["txHash", "index"], `transaction.inputs[${index}].previousOutput`);
    return Object.freeze({
      since: numericHex(input["since"], `transaction.inputs[${index}].since`),
      previousOutput: Object.freeze({
        txHash: hash(point["txHash"], `transaction.inputs[${index}].previousOutput.txHash`),
        index: numericHex(point["index"], `transaction.inputs[${index}].previousOutput.index`),
      }),
    });
  });
  const outputs = parsed["outputs"].map((item, index) => {
    const output = record(item, `transaction.outputs[${index}]`);
    exact(output, ["capacity", "lock", "type"], `transaction.outputs[${index}]`);
    return Object.freeze({
      capacity: numericHex(output["capacity"], `transaction.outputs[${index}].capacity`),
      lock: script(output["lock"], `transaction.outputs[${index}].lock`),
      type:
        output["type"] === null
          ? null
          : script(output["type"], `transaction.outputs[${index}].type`),
    });
  });
  const outputsData = parsed["outputsData"].map((item, index) =>
    bytes(item, `transaction.outputsData[${index}]`),
  );
  if (outputs.length !== outputsData.length) {
    throw new TypeError("transaction outputs and outputsData lengths differ");
  }
  return Object.freeze({
    version,
    cellDeps: Object.freeze(cellDeps),
    headerDeps: Object.freeze(
      parsed["headerDeps"].map((item, index) => hash(item, `transaction.headerDeps[${index}]`)),
    ),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze(
      parsed["witnesses"].map((item, index) => bytes(item, `transaction.witnesses[${index}]`)),
    ),
  });
}

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function dataHash(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(value.slice(2), "hex"))
    .digest("hex");
}

function quoteAmounts(quote: {
  readonly occupiedCapacity: {
    readonly jobCell: bigint;
    readonly applicationCell: bigint;
    readonly total: bigint;
  };
  readonly applicationAmount: { readonly perExecution: bigint; readonly total: bigint };
  readonly rewards: { readonly perExecution: bigint; readonly total: bigint };
  readonly remainingBudget: bigint;
  readonly residualRefund: bigint;
  readonly retainedTerminalCapacity: bigint;
  readonly estimatedFee: { readonly minimum: bigint; readonly maximum: bigint };
  readonly maximumLockedTotal: bigint;
  readonly maximumOwnerFunding: bigint;
}): unknown {
  return normalized(quote);
}

function creationSigningEntries(operation: TransactionOperation, pledgeCount = 0) {
  const entries: TransactionBuildResponse["signingEntries"][number][] = [];
  if (operation === "create_deadline_job") {
    entries.push({
      role: "pledge",
      inputIndices: Array.from({ length: pledgeCount }, (_, index) => index.toString()),
      walletAction: "sign_existing_inputs",
    });
  }
  entries.push({
    role: "funding",
    inputIndices: [],
    walletAction: "append_inputs_and_change",
  });
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

const ownerSigningEntries = Object.freeze([
  Object.freeze({
    role: "owner_authorization" as const,
    inputIndices: Object.freeze([] as string[]),
    walletAction: "append_inputs_and_change" as const,
  }),
]);

function envelope(input: {
  operation: TransactionOperation;
  transaction: UnsignedDeadlineTransaction;
  signingEntries: TransactionBuildResponse["signingEntries"];
  intent: unknown;
  protocolIntentHash?: string;
  chainSnapshot: unknown;
  quoteExpiry: unknown;
  quote: unknown;
}): TransactionBuildResponse {
  const intent = normalized(input.intent);
  const quote = normalized(input.quote);
  const intentHash = digest({ operation: input.operation, intent });
  const critical = policyCriticalContext({
    operation: input.operation,
    intentHash,
    quote,
    chainSnapshot: input.chainSnapshot,
    quoteExpiry: input.quoteExpiry,
    transaction: input.transaction,
  });
  return Object.freeze({
    operation: input.operation,
    transaction: input.transaction,
    signingEntries: input.signingEntries,
    intent,
    intentHash,
    protocolIntentHash: input.protocolIntentHash ?? null,
    policyCriticalHash: digest(critical),
    chainSnapshot: normalized(input.chainSnapshot),
    quoteExpiry: normalized(input.quoteExpiry),
    quote,
  });
}

function policyCriticalContext(input: {
  readonly operation: TransactionOperation;
  readonly intentHash: string;
  readonly quote: unknown;
  readonly chainSnapshot: unknown;
  readonly quoteExpiry: unknown;
  readonly transaction: UnsignedDeadlineTransaction;
}) {
  if (input.operation !== "create_deadline_job" && input.operation !== "create_recurring_job") {
    return Object.freeze({
      operation: input.operation,
      intentHash: input.intentHash,
      transaction: input.transaction,
    });
  }
  return Object.freeze({
    operation: input.operation,
    intentHash: input.intentHash,
    quote: normalized(input.quote),
    chainSnapshot: normalized(input.chainSnapshot),
    quoteExpiry: normalized(input.quoteExpiry),
    transaction: input.transaction,
  });
}

function creationExpiry(blockNumber: bigint) {
  return Object.freeze({
    afterBlock: (blockNumber + CREATION_REVIEW_WINDOW_BLOCKS).toString(),
    condition: CREATION_REVIEW_EXPIRY_CONDITION,
  });
}

function parseOperation(value: unknown): TransactionOperation {
  const operation = text(value, "operation");
  if (!TRANSACTION_OPERATIONS.includes(operation as TransactionOperation)) {
    throw new TypeError("operation is unsupported");
  }
  return operation as TransactionOperation;
}

function creationSnapshot(
  tip: { readonly number: bigint; readonly hash: string },
  deployment: RegisteredDeployment,
) {
  return Object.freeze({
    tip: Object.freeze({ blockNumber: tip.number.toString(), blockHash: tip.hash }),
    deploymentManifestSha256: deployment.manifestSha256,
  });
}

function parseCreationReviewContext(value: unknown) {
  const context = record(value, "reviewContext");
  exact(context, ["chainSnapshot", "quoteExpiry"], "reviewContext");
  const chainSnapshot = record(context["chainSnapshot"], "reviewContext.chainSnapshot");
  exact(chainSnapshot, ["tip", "deploymentManifestSha256"], "reviewContext.chainSnapshot");
  const tip = record(chainSnapshot["tip"], "reviewContext.chainSnapshot.tip");
  exact(tip, ["blockNumber", "blockHash"], "reviewContext.chainSnapshot.tip");
  const blockNumber = decimal(tip["blockNumber"], "reviewContext.chainSnapshot.tip.blockNumber");
  const blockHash = hash(tip["blockHash"], "reviewContext.chainSnapshot.tip.blockHash");
  const deploymentManifestSha256 = text(
    chainSnapshot["deploymentManifestSha256"],
    "reviewContext.chainSnapshot.deploymentManifestSha256",
  );
  if (!/^[0-9a-f]{64}$/.test(deploymentManifestSha256)) {
    throw new TypeError("reviewContext deployment manifest must be a lowercase SHA-256 digest");
  }
  const quoteExpiry = record(context["quoteExpiry"], "reviewContext.quoteExpiry");
  exact(quoteExpiry, ["afterBlock", "condition"], "reviewContext.quoteExpiry");
  const afterBlock = decimal(quoteExpiry["afterBlock"], "reviewContext.quoteExpiry.afterBlock");
  if (quoteExpiry["condition"] !== CREATION_REVIEW_EXPIRY_CONDITION) {
    throw new TypeError("reviewContext quote expiry condition is unsupported");
  }
  return Object.freeze({
    blockNumber: BigInt(blockNumber),
    blockHash,
    afterBlock: BigInt(afterBlock),
    chainSnapshot: Object.freeze({
      tip: Object.freeze({ blockNumber, blockHash }),
      deploymentManifestSha256,
    }),
    quoteExpiry: Object.freeze({
      afterBlock,
      condition: CREATION_REVIEW_EXPIRY_CONDITION,
    }),
  });
}

export class TransactionBuildService {
  readonly #quotes: JobQuoteService;
  readonly #chain: TransactionChainClient;
  readonly #genesisHash: string;
  readonly #resolutions: LockResolutionRecorder;
  readonly #operatorDeployment: OperatorAutomationDeployment | undefined;
  #deployment: Promise<RegisteredDeployment> | undefined;

  constructor(
    quotes: JobQuoteService,
    chain: TransactionChainClient,
    genesisHash: string,
    resolutions: LockResolutionRecorder,
    operatorDeployment?: OperatorAutomationDeployment,
  ) {
    this.#quotes = quotes;
    this.#chain = chain;
    this.#genesisHash = genesisHash;
    this.#resolutions = resolutions;
    this.#operatorDeployment = operatorDeployment;
  }

  #loadDeployment(): Promise<RegisteredDeployment> {
    this.#deployment ??= deploymentRegistry.load(this.#genesisHash).then((result) => {
      if (result.status !== "ok") {
        throw new ServiceUnavailableException({
          status: "unavailable",
          code: "DEPLOYMENT_UNAVAILABLE",
        });
      }
      return result.deployment;
    });
    return this.#deployment;
  }

  async construct(
    operation: TransactionOperation,
    input: unknown,
  ): Promise<TransactionBuildResponse> {
    try {
      return (await this.#artifact(operation, input)).response;
    } catch (error) {
      return this.#mapBuildError(error);
    }
  }

  validate(input: unknown): Promise<SignedTransactionValidation> {
    return this.#validate(input);
  }

  validateSubmitted(
    input: unknown,
    transactionHashInput: unknown,
  ): Promise<SignedTransactionValidation> {
    let transactionHash: ReturnType<typeof parseHash32>;
    try {
      transactionHash = hash(transactionHashInput, "transactionHash");
    } catch (error) {
      return this.#mapBuildError(error);
    }
    return this.#validate(input, transactionHash);
  }

  async #validate(
    input: unknown,
    submittedTransactionHash?: ReturnType<typeof parseHash32>,
  ): Promise<SignedTransactionValidation> {
    let request: Record<string, unknown>;
    let operation: TransactionOperation;
    let artifact: BuiltArtifact;
    try {
      request = record(input, "validation request");
      exact(
        request,
        [
          "operation",
          "request",
          "intentHash",
          "policyCriticalHash",
          "reviewContext",
          "transaction",
        ],
        "validation request",
      );
      operation = parseOperation(request["operation"]);
      artifact = await this.#artifact(operation, request["request"]);
    } catch (error) {
      return this.#mapBuildError(error);
    }
    let reviewedIntentHash: string;
    try {
      reviewedIntentHash = text(request["intentHash"], "intentHash");
      if (!/^[0-9a-f]{64}$/.test(reviewedIntentHash)) {
        throw new TypeError("intentHash must be a lowercase SHA-256 digest");
      }
    } catch (error) {
      return this.#mapBuildError(error);
    }
    if (reviewedIntentHash !== artifact.response.intentHash) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_TRANSACTION_INTENT",
        message: "the quote or chain snapshot changed; review a newly built transaction",
      });
    }
    let reviewedPolicyHash: string;
    try {
      reviewedPolicyHash = text(request["policyCriticalHash"], "policyCriticalHash");
      if (!/^[0-9a-f]{64}$/.test(reviewedPolicyHash)) {
        throw new TypeError("policyCriticalHash must be a lowercase SHA-256 digest");
      }
    } catch (error) {
      return this.#mapBuildError(error);
    }
    if (request["reviewContext"] === undefined) {
      if (reviewedPolicyHash !== artifact.response.policyCriticalHash) {
        throw new ConflictException({
          status: "conflict",
          code: "STALE_POLICY_CONTEXT",
          message: "the quote or chain snapshot changed; review a newly built transaction",
        });
      }
    } else {
      if (operation !== "create_deadline_job" && operation !== "create_recurring_job") {
        return this.#mapBuildError(
          new TypeError("reviewContext is supported only for creation transactions"),
        );
      }
      try {
        await this.#assertCreationReviewContext(
          artifact.response,
          request["reviewContext"],
          reviewedPolicyHash,
        );
      } catch (error) {
        return this.#mapBuildError(error);
      }
    }

    let transaction: UnsignedDeadlineTransaction;
    try {
      transaction = parseTransaction(request["transaction"]);
      artifact.assertCompletion(transaction);
    } catch (error) {
      throw new BadRequestException({
        status: "invalid_request",
        code: "SIGNED_TRANSACTION_MISMATCH",
        message: error instanceof Error ? error.message : "signed transaction is invalid",
      });
    }

    let cycles: bigint;
    try {
      cycles = await this.#chain.dryRun(transaction as never);
    } catch (error) {
      let submitted = false;
      if (submittedTransactionHash !== undefined) {
        try {
          submitted = await this.#isKnownSubmittedTransaction(
            transaction,
            submittedTransactionHash,
          );
        } catch (statusError) {
          return this.#mapBuildError(statusError);
        }
      }
      if (!submitted) {
        throw new UnprocessableEntityException(
          { status: "invalid_transaction", code: "DRY_RUN_FAILED" },
          { cause: error },
        );
      }
      cycles = 0n;
    }
    if (artifact.lockResolutions) {
      try {
        await this.#resolutions.remember(artifact.lockResolutions);
      } catch (error) {
        return this.#mapBuildError(error);
      }
    }
    return Object.freeze({
      valid: true,
      operation,
      intentHash: artifact.response.intentHash,
      policyCriticalHash: reviewedPolicyHash,
      dryRunCycles: cycles.toString(),
    });
  }

  async #isKnownSubmittedTransaction(
    transaction: UnsignedDeadlineTransaction,
    expectedHash: ReturnType<typeof parseHash32>,
  ): Promise<boolean> {
    const actualHash = parseHash32(
      rawTransactionToHash(transaction as unknown as Parameters<typeof rawTransactionToHash>[0]),
    );
    if (actualHash !== expectedHash) return false;
    const response = await this.#chain.getTransactionStatus(expectedHash);
    if (
      response === undefined ||
      !["sent", "pending", "proposed", "committed"].includes(response.status)
    ) {
      return false;
    }
    return parseHash32(response.transaction.hash()) === expectedHash;
  }

  async creationMetadata(
    operationInput: unknown,
    request: unknown,
  ): Promise<PendingCreationMetadata> {
    let operation: TransactionOperation;
    try {
      operation = parseOperation(operationInput);
      if (operation !== "create_deadline_job" && operation !== "create_recurring_job") {
        throw new TypeError("only creation transactions can be registered");
      }
      const artifact = await this.#artifact(operation, request);
      if (artifact.pendingCreation === undefined) {
        throw new TypeError("creation transaction metadata is unavailable");
      }
      return artifact.pendingCreation;
    } catch (error) {
      return this.#mapBuildError(error);
    }
  }

  async #assertCreationReviewContext(
    artifact: TransactionBuildResponse,
    value: unknown,
    reviewedPolicyHash: string,
  ): Promise<void> {
    const reviewed = parseCreationReviewContext(value);
    const currentSnapshot = record(artifact.chainSnapshot, "current chain snapshot");
    const currentTip = record(currentSnapshot["tip"], "current chain snapshot tip");
    const currentBlock = BigInt(decimal(currentTip["blockNumber"], "current tip block"));
    const currentManifest = text(
      currentSnapshot["deploymentManifestSha256"],
      "current deployment manifest",
    );
    if (
      reviewed.chainSnapshot.deploymentManifestSha256 !== currentManifest ||
      reviewed.afterBlock !== reviewed.blockNumber + CREATION_REVIEW_WINDOW_BLOCKS
    ) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_POLICY_CONTEXT",
        message: "the reviewed policy context is no longer valid",
      });
    }
    if (currentBlock < reviewed.blockNumber || currentBlock > reviewed.afterBlock) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_CHAIN_SNAPSHOT",
        message: "the reviewed chain snapshot expired",
      });
    }
    const canonicalBlock = await this.#chain.getBlockByNumber(reviewed.blockNumber);
    if (canonicalBlock?.header.hash !== reviewed.blockHash) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_CHAIN_SNAPSHOT",
        message: "the reviewed chain snapshot is no longer canonical",
      });
    }
    const expectedPolicyHash = digest(
      policyCriticalContext({
        operation: artifact.operation,
        intentHash: artifact.intentHash,
        quote: artifact.quote,
        chainSnapshot: reviewed.chainSnapshot,
        quoteExpiry: reviewed.quoteExpiry,
        transaction: artifact.transaction,
      }),
    );
    if (reviewedPolicyHash !== expectedPolicyHash) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_POLICY_CONTEXT",
        message: "the reviewed policy context does not match the transaction",
      });
    }
  }

  async #artifact(operation: TransactionOperation, input: unknown): Promise<BuiltArtifact> {
    const deployment = await this.#loadDeployment();
    if (operation === "create_deadline_job") return this.#deadline(input, deployment);
    if (operation === "create_recurring_job") return this.#recurring(input, deployment);
    return this.#ownerAction(operation, input, deployment);
  }

  async #deadline(input: unknown, deployment: RegisteredDeployment): Promise<BuiltArtifact> {
    const creation = creationInput(input, "deadline creation request");
    const request = parseDeadlineCreationRequest(creation.request);
    const resolutions = verifiedResolutions(creation.resolutions, [
      request.successLockHash,
      request.cancelLockHash,
      ...request.pledges.map(({ refundLockHash }) => refundLockHash),
      ...(request.preferredExecutorLockHash ? [request.preferredExecutorLockHash] : []),
    ]);
    const pledged = request.pledges.reduce(
      (total, pledge) => parseShannons(total + parseShannons(pledge.amount)),
      parseShannons(0n),
    );
    requirePlainOutputCapacity(
      pledged.toString(),
      resolvedLock(resolutions, request.successLockHash),
      "recipient amount",
    );
    for (const [index, pledge] of request.pledges.entries()) {
      requirePlainOutputCapacity(
        pledge.amount,
        resolvedLock(resolutions, pledge.refundLockHash),
        `pledges[${index}].amount`,
      );
    }
    const build = buildDeadlineCreation({
      deployment,
      pledges: request.pledges,
      target: request.target,
      deadlineBlock: request.deadlineBlock,
      successLockHash: request.successLockHash,
      cancelLockHash: request.cancelLockHash,
      reward: request.reward,
      creatorNonce: request.creatorNonce,
      creationFee: JOB_QUOTE_ASSUMPTIONS.deadline,
      ...(this.#operatorDeployment === undefined
        ? {}
        : {
            operator: {
              deployment: this.#operatorDeployment,
              preferredExecutorLockHash:
                request.preferredExecutorLockHash ??
                this.#operatorDeployment.defaultPreferredOperatorLockHash,
            },
          }),
    });
    if (request.preferredExecutorLockHash !== undefined && this.#operatorDeployment === undefined) {
      throw new ServiceUnavailableException({
        status: "unavailable",
        code: "OPERATOR_AUTOMATION_DEPLOYMENT_UNAVAILABLE",
      });
    }
    const tip = await this.#chain.getTipHeader();
    const response = envelope({
      operation: "create_deadline_job",
      transaction: build.transaction,
      signingEntries: creationSigningEntries("create_deadline_job", request.pledges.length),
      intent: build.intent,
      protocolIntentHash: build.intentHash,
      chainSnapshot: creationSnapshot(tip, deployment),
      quoteExpiry: creationExpiry(tip.number),
      quote: quoteAmounts(build.quote),
    });
    return Object.freeze({
      response,
      lockResolutions: resolutions,
      pendingCreation: Object.freeze({
        jobId: build.jobId,
        notBefore: request.deadlineBlock,
        ownerLockHash: request.cancelLockHash,
        recipientAmount: Object.freeze({
          perExecution: pledged.toString(),
          total: pledged.toString(),
        }),
        remainingRuns: "1",
        template: "deadline" as const,
      }),
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertDeadlineCompletion(build, transaction),
    });
  }

  async #recurring(input: unknown, deployment: RegisteredDeployment): Promise<BuiltArtifact> {
    const creation = creationInput(input, "recurring creation request");
    const request = parseRecurringCreationRequest(creation.request);
    const resolutions = verifiedResolutions(creation.resolutions, [
      request.ownerLockHash,
      request.recipientLockHash,
      ...(request.preferredExecutorLockHash ? [request.preferredExecutorLockHash] : []),
    ]);
    requirePlainOutputCapacity(
      request.amount,
      resolvedLock(resolutions, request.recipientLockHash),
      "amount",
    );
    const build = buildRecurringCreation({
      deployment,
      ownerLockHash: request.ownerLockHash,
      recipientLockHash: request.recipientLockHash,
      amount: request.amount,
      intervalBlocks: request.intervalBlocks,
      firstNotBefore: request.firstNotBefore,
      totalRuns: request.totalRuns,
      reward: request.reward,
      creatorNonce: request.creatorNonce,
      creationFee: JOB_QUOTE_ASSUMPTIONS.recurring,
      ...(this.#operatorDeployment === undefined
        ? {}
        : {
            operator: {
              deployment: this.#operatorDeployment,
              preferredExecutorLockHash:
                request.preferredExecutorLockHash ??
                this.#operatorDeployment.defaultPreferredOperatorLockHash,
            },
          }),
    });
    if (request.preferredExecutorLockHash !== undefined && this.#operatorDeployment === undefined) {
      throw new ServiceUnavailableException({
        status: "unavailable",
        code: "OPERATOR_AUTOMATION_DEPLOYMENT_UNAVAILABLE",
      });
    }
    const tip = await this.#chain.getTipHeader();
    const response = envelope({
      operation: "create_recurring_job",
      transaction: build.transaction,
      signingEntries: creationSigningEntries("create_recurring_job"),
      intent: build.intent,
      protocolIntentHash: build.intentHash,
      chainSnapshot: creationSnapshot(tip, deployment),
      quoteExpiry: creationExpiry(tip.number),
      quote: quoteAmounts(build.quote),
    });
    return Object.freeze({
      response,
      lockResolutions: resolutions,
      pendingCreation: Object.freeze({
        jobId: build.jobId,
        notBefore: request.firstNotBefore,
        ownerLockHash: request.ownerLockHash,
        recipientAmount: Object.freeze({
          perExecution: request.amount,
          total: (BigInt(request.amount) * BigInt(request.totalRuns)).toString(),
        }),
        remainingRuns: request.totalRuns,
        template: "recurring" as const,
      }),
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertRecurringCompletion(build, transaction),
    });
  }

  async #ownerAction(
    operation: Exclude<TransactionOperation, "create_deadline_job" | "create_recurring_job">,
    input: unknown,
    deployment: RegisteredDeployment,
  ): Promise<BuiltArtifact> {
    const request = record(input, "owner action request");
    const extra =
      operation === "recover_job"
        ? ["reason"]
        : operation === "top_up_job"
          ? ["rewardIncrease", "budgetIncrease", "capacityIncrease"]
          : [];
    exact(request, ["jobId", "quoteId", "ownerLock", ...extra], "owner action request");
    const jobId = hash(request["jobId"], "jobId");
    const quoteId = text(request["quoteId"], "quoteId");
    const ownerLock = script(request["ownerLock"], "ownerLock");
    const quote = await this.#quotes.assertFresh(jobId, quoteId);
    const resolver = this.#resolver(quote);
    const jobOutPoint = parseOutPoint({
      txHash: hash(quote.snapshot.jobOutPoint.txHash, "quote job outpoint"),
      index: quote.snapshot.jobOutPoint.index,
    });

    if (operation === "cancel_job") {
      const build = await buildCancellation({ deployment, resolver, jobOutPoint, ownerLock });
      const intent = {
        action: "cancel",
        jobId: build.jobId,
        ownerLockHash: build.ownerLockHash,
        refundCapacity: build.refundCapacity.toString(),
        policy: build.policy.kind,
      };
      return Object.freeze({
        response: envelope({
          operation,
          transaction: build.transaction,
          signingEntries: ownerSigningEntries,
          intent,
          chainSnapshot: quote.snapshot,
          quoteExpiry: quote.expiry,
          quote,
        }),
        assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
          assertCancellationCompletion(build, transaction),
      });
    }
    if (operation === "recover_job") {
      const reason = text(request["reason"], "reason");
      if (!RECOVERY_REASONS.includes(reason as (typeof RECOVERY_REASONS)[number])) {
        throw new TypeError("reason is unsupported");
      }
      const build = await buildRecovery({
        deployment,
        resolver,
        jobOutPoint,
        ownerLock,
        reason: reason as (typeof RECOVERY_REASONS)[number],
      });
      return Object.freeze({
        response: envelope({
          operation,
          transaction: build.transaction,
          signingEntries: ownerSigningEntries,
          intent: build.preview,
          chainSnapshot: quote.snapshot,
          quoteExpiry: quote.expiry,
          quote,
        }),
        assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
          assertRecoveryCompletion(build, transaction),
      });
    }
    const build = await buildTopUp({
      deployment,
      resolver,
      jobOutPoint,
      ownerLock,
      rewardIncrease: decimal(request["rewardIncrease"], "rewardIncrease"),
      budgetIncrease: decimal(request["budgetIncrease"], "budgetIncrease"),
      capacityIncrease: decimal(request["capacityIncrease"], "capacityIncrease"),
    });
    return Object.freeze({
      response: envelope({
        operation,
        transaction: build.transaction,
        signingEntries: ownerSigningEntries,
        intent: {
          action: "top_up",
          jobId: build.jobId,
          ownerLockHash: build.ownerLockHash,
          diff: build.diff,
        },
        chainSnapshot: quote.snapshot,
        quoteExpiry: quote.expiry,
        quote,
      }),
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertTopUpCompletion(build, transaction),
    });
  }

  #resolver(quote: JobQuote): LiveCellResolver {
    return {
      resolve: async (point) => {
        if (
          point.txHash !== quote.snapshot.jobOutPoint.txHash ||
          point.index.toString() !== quote.snapshot.jobOutPoint.index
        ) {
          return null;
        }
        const response = await this.#chain.getTransactionStatus(point.txHash);
        if (!response || response.status !== "committed") return null;
        const index = Number(point.index);
        const output = response.transaction.outputs[index];
        const data = response.transaction.outputsData[index];
        if (!output || !data || dataHash(data) !== quote.snapshot.jobDataHash) return null;
        return Object.freeze({
          outPoint: point,
          output: Object.freeze({
            capacity: output.capacity,
            lock: script(output.lock, "committed output lock"),
            type: output.type ? script(output.type, "committed output type") : null,
          }),
          data,
        });
      },
    };
  }

  #mapBuildError(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof CkbClientError) {
      throw new ServiceUnavailableException(
        { status: "unavailable", code: error.code },
        { cause: error },
      );
    }
    if (error instanceof LockResolutionStoreError) {
      throw new ServiceUnavailableException(
        { status: "unavailable", code: error.code },
        { cause: error },
      );
    }
    if (
      error instanceof CancellationBuildError ||
      error instanceof RecoveryBuildError ||
      error instanceof TopUpBuildError
    ) {
      const response = { status: "invalid_request", code: error.code, message: error.message };
      if (error.code === "STALE_OUTPOINT") throw new ConflictException(response);
      throw new BadRequestException(response);
    }
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_TRANSACTION_REQUEST",
      message: error instanceof Error ? error.message : "transaction request is invalid",
    });
  }
}

export class TransactionController {
  readonly #transactions: TransactionBuildService;

  constructor(transactions: TransactionBuildService) {
    this.#transactions = transactions;
  }

  createDeadline(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("create_deadline_job", body);
  }

  createRecurring(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("create_recurring_job", body);
  }

  cancel(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("cancel_job", body);
  }

  recover(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("recover_job", body);
  }

  topUp(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("top_up_job", body);
  }

  validateSigned(body: unknown): Promise<SignedTransactionValidation> {
    return this.#transactions.validate(body);
  }
}

const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const scriptSchema = {
  type: "object",
  required: ["codeHash", "hashType", "args"],
  additionalProperties: false,
  properties: {
    codeHash: hashSchema,
    hashType: { type: "string", enum: ["data", "data1", "type"] },
    args: { type: "string", pattern: "^0x(?:[0-9a-f]{2})*$" },
  },
};
const ownerProperties = {
  jobId: hashSchema,
  quoteId: { type: "string", pattern: "^[0-9a-f]{64}$" },
  ownerLock: scriptSchema,
};
const numericHexSchema = { type: "string", pattern: "^0x(?:0|[1-9a-f][0-9a-f]*)$" };
const bytesSchema = { type: "string", pattern: "^0x(?:[0-9a-f]{2})*$" };
const hexOutPointSchema = {
  type: "object",
  required: ["txHash", "index"],
  additionalProperties: false,
  properties: { txHash: hashSchema, index: numericHexSchema },
};
const transactionSchema = {
  type: "object",
  required: ["version", "cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"],
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["0x0"] },
    cellDeps: {
      type: "array",
      items: {
        type: "object",
        required: ["outPoint", "depType"],
        additionalProperties: false,
        properties: {
          outPoint: hexOutPointSchema,
          depType: { type: "string", enum: ["code", "depGroup"] },
        },
      },
    },
    headerDeps: { type: "array", items: hashSchema },
    inputs: {
      type: "array",
      items: {
        type: "object",
        required: ["since", "previousOutput"],
        additionalProperties: false,
        properties: { since: numericHexSchema, previousOutput: hexOutPointSchema },
      },
    },
    outputs: {
      type: "array",
      items: {
        type: "object",
        required: ["capacity", "lock", "type"],
        additionalProperties: false,
        properties: {
          capacity: numericHexSchema,
          lock: scriptSchema,
          type: { ...scriptSchema, nullable: true },
        },
      },
    },
    outputsData: { type: "array", items: bytesSchema },
    witnesses: { type: "array", items: bytesSchema },
  },
};
const responseSchema = {
  type: "object",
  required: [
    "operation",
    "transaction",
    "signingEntries",
    "intent",
    "intentHash",
    "protocolIntentHash",
    "policyCriticalHash",
    "chainSnapshot",
    "quoteExpiry",
    "quote",
  ],
  properties: {
    operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
    transaction: transactionSchema,
    signingEntries: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "inputIndices", "walletAction"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["funding", "owner_authorization", "pledge"] },
          inputIndices: { type: "array", items: decimalSchema },
          walletAction: {
            type: "string",
            enum: ["append_inputs_and_change", "sign_existing_inputs"],
          },
        },
      },
    },
    intent: { type: "object" },
    intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    protocolIntentHash: { ...hashSchema, nullable: true },
    policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    chainSnapshot: { type: "object" },
    quoteExpiry: {
      type: "object",
      required: ["afterBlock", "condition"],
      properties: {
        afterBlock: decimalSchema,
        condition: {
          type: "string",
          enum: [
            "canonical_snapshot_window",
            "tip_change_before_signing",
            "tip_or_job_snapshot_change",
          ],
        },
      },
    },
    quote: { type: "object" },
  },
};

Injectable()(TransactionBuildService);
Inject(TransactionBuildService)(TransactionController, undefined, 0);
Controller("transactions")(TransactionController);
ApiTags("transactions")(TransactionController);

const routes = [
  ["createDeadline", "create-deadline-job", "Build a deadline Job transaction"],
  ["createRecurring", "create-recurring-job", "Build a recurring Job transaction"],
  ["cancel", "cancel-job", "Build an owner cancellation transaction"],
  ["recover", "recover-job", "Build an owner recovery transaction"],
  ["topUp", "top-up-job", "Build an owner top-up transaction"],
  ["validateSigned", "validate-signed", "Validate and dry-run a wallet-completed transaction"],
] as const;
for (const [method, path, summary] of routes) {
  const descriptor = Object.getOwnPropertyDescriptor(TransactionController.prototype, method)!;
  Post(path)(TransactionController.prototype, method, descriptor);
  HttpCode(200)(TransactionController.prototype, method, descriptor);
  Body()(TransactionController.prototype, method, 0);
  ApiOperation({ summary })(TransactionController.prototype, method, descriptor);
  ApiBadRequestResponse({ description: "Malformed or policy-inconsistent transaction request" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
  ApiConflictResponse({ description: "Quote or live outpoint is stale" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
  ApiServiceUnavailableResponse({ description: "Chain or deployment evidence is unavailable" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
}

const deadlineBodySchema = {
  type: "object",
  required: [
    "pledges",
    "target",
    "deadlineBlock",
    "successLockHash",
    "cancelLockHash",
    "reward",
    "creatorNonce",
    "lockResolutions",
  ],
  additionalProperties: false,
  properties: {
    pledges: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["outPoint", "refundLockHash", "amount"],
        additionalProperties: false,
        properties: {
          outPoint: {
            type: "object",
            required: ["txHash", "index"],
            properties: { txHash: hashSchema, index: decimalSchema },
          },
          refundLockHash: hashSchema,
          amount: decimalSchema,
        },
      },
    },
    target: decimalSchema,
    deadlineBlock: decimalSchema,
    successLockHash: hashSchema,
    cancelLockHash: hashSchema,
    reward: decimalSchema,
    creatorNonce: decimalSchema,
    preferredExecutorLockHash: hashSchema,
    lockResolutions: { type: "array", minItems: 1, maxItems: 32, items: scriptSchema },
  },
};
const recurringBodySchema = {
  type: "object",
  required: [
    "ownerLockHash",
    "recipientLockHash",
    "amount",
    "intervalBlocks",
    "firstNotBefore",
    "totalRuns",
    "reward",
    "creatorNonce",
    "lockResolutions",
  ],
  additionalProperties: false,
  properties: {
    ownerLockHash: hashSchema,
    recipientLockHash: hashSchema,
    amount: decimalSchema,
    intervalBlocks: decimalSchema,
    firstNotBefore: decimalSchema,
    totalRuns: decimalSchema,
    reward: decimalSchema,
    creatorNonce: decimalSchema,
    preferredExecutorLockHash: hashSchema,
    lockResolutions: { type: "array", minItems: 1, maxItems: 32, items: scriptSchema },
  },
};
const ownerBodySchema = {
  type: "object",
  required: ["jobId", "quoteId", "ownerLock"],
  additionalProperties: false,
  properties: ownerProperties,
};
const recoveryBodySchema = {
  ...ownerBodySchema,
  required: [...ownerBodySchema.required, "reason"],
  properties: {
    ...ownerProperties,
    reason: { type: "string", enum: [...RECOVERY_REASONS] },
  },
};
const topUpBodySchema = {
  ...ownerBodySchema,
  required: [...ownerBodySchema.required, "rewardIncrease", "budgetIncrease", "capacityIncrease"],
  properties: {
    ...ownerProperties,
    rewardIncrease: decimalSchema,
    budgetIncrease: decimalSchema,
    capacityIncrease: decimalSchema,
  },
};

for (const [method, schema] of [
  ["createDeadline", deadlineBodySchema],
  ["createRecurring", recurringBodySchema],
  ["cancel", ownerBodySchema],
  ["recover", recoveryBodySchema],
  ["topUp", topUpBodySchema],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(TransactionController.prototype, method)!;
  ApiBody({ schema: schema as never })(TransactionController.prototype, method, descriptor);
  ApiOkResponse({ schema: responseSchema as never })(
    TransactionController.prototype,
    method,
    descriptor,
  );
}

const validateDescriptor = Object.getOwnPropertyDescriptor(
  TransactionController.prototype,
  "validateSigned",
)!;
ApiBody({
  schema: {
    type: "object",
    required: ["operation", "request", "intentHash", "policyCriticalHash", "transaction"],
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
      request: {
        oneOf: [
          deadlineBodySchema,
          recurringBodySchema,
          ownerBodySchema,
          recoveryBodySchema,
          topUpBodySchema,
        ],
      },
      intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      reviewContext: {
        type: "object",
        required: ["chainSnapshot", "quoteExpiry"],
        additionalProperties: false,
        properties: {
          chainSnapshot: { type: "object" },
          quoteExpiry: {
            type: "object",
            required: ["afterBlock", "condition"],
            additionalProperties: false,
            properties: {
              afterBlock: decimalSchema,
              condition: { type: "string", enum: ["canonical_snapshot_window"] },
            },
          },
        },
      },
      transaction: transactionSchema,
    },
  },
})(TransactionController.prototype, "validateSigned", validateDescriptor);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["valid", "operation", "intentHash", "policyCriticalHash", "dryRunCycles"],
    properties: {
      valid: { type: "boolean", enum: [true] },
      operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
      intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      dryRunCycles: decimalSchema,
    },
  },
})(TransactionController.prototype, "validateSigned", validateDescriptor);
ApiUnprocessableEntityResponse({ description: "Completed transaction fails CKB dry-run" })(
  TransactionController.prototype,
  "validateSigned",
  validateDescriptor,
);
