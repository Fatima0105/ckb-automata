import { randomUUID } from "node:crypto";

import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";
import { and, eq } from "drizzle-orm";

import type { CkbReadClient } from "./ckb-client.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestV2Jobs, transactionAttempts } from "./database/schema.ts";
import type {
  DaoHarvestV2MutationAdapter,
  DaoHarvestV2PendingReadModel,
  DaoHarvestV2UnsignedBuild,
} from "./dao-harvest-v2.ts";
import { extractDaoHarvestV2ProjectionEvents } from "./indexer/dao-harvest-v2-projection.ts";

import {
  addEpochs,
  absentDaoHarvestV2Indices,
  buildDaoHarvestV2Transaction,
  calculateDaoMaximumWithdraw,
  createEpoch,
  DAO_HARVEST_V2_OPERATIONS,
  decodeDaoHarvestV2CompensationLockArgs,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  deriveDaoHarvestV2VaultTermsHash,
  deriveJobId,
  encodeAbsoluteEpochSince,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2FallbackOperatorProof,
  encodeDaoHarvestV2VaultLockArgs,
  encodeRelativeEpochSince,
  hash32FromBytes,
  minimumPlainCellCapacity,
  parseHash32,
  parseOutPoint,
  parseEpoch,
  parseSequence,
  parseShannons,
  selectDaoPrepareWindow,
  type CellDepIdentity,
  type Hash32,
  type ScriptIdentity,
} from "@ckb-automata/core";
import { packClientEpoch } from "@ckb-automata/ccc";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  JobDataV1,
} from "@ckb-automata/molecule";
import { clientDaoAccumulatedRate } from "@ckb-automata/ccc";

type Hex = `0x${string}`;

const CKB = 100_000_000n;
const JOB_CAPACITY = 400n * CKB;
const COMPENSATION_SEED = 201n * CKB;
const PREPARE_SERVICE_FEE = 2n * CKB;
const CLAIM_SERVICE_FEE = 3n * CKB;
const MAXIMUM_NETWORK_FEE = 1n * CKB;
const PREPARE_BUFFER_EPOCHS = 4n;
const CONFIRMATION_MARGIN_EPOCHS = 1n;
const MINIMUM_PRINCIPAL = 242n * CKB;
const MAXIMUM_CYCLES = 12;

export interface DaoHarvestV2DeploymentContract {
  readonly codeHash: Hash32;
  readonly hashType: "data1";
  readonly cellDep: CellDepIdentity;
}

export interface DaoHarvestV2Deployment {
  readonly genesisHash: Hash32;
  readonly secp256k1Blake160: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly nervosDao: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly contracts: {
    readonly jobLock: DaoHarvestV2DeploymentContract;
    readonly policy: DaoHarvestV2DeploymentContract;
    readonly vaultLock: DaoHarvestV2DeploymentContract;
    readonly compensationLock: DaoHarvestV2DeploymentContract;
  };
  readonly preferredPrepareOperatorLockHash: Hash32;
  readonly fallbackPrepareOperatorLockHashes: readonly Hash32[];
}

interface SetupRequest {
  readonly creatorNonce: bigint;
  readonly identityOutPoint: ReturnType<typeof parseOutPoint>;
  readonly ownerLock: ScriptIdentity;
  readonly ownerLockHash: Hash32;
  readonly payoutLock: ScriptIdentity;
  readonly payoutLockHash: Hash32;
  readonly principal: bigint;
  readonly totalCycles: number;
}

interface OwnerRequest {
  readonly jobId: Hash32;
  readonly identityOutPoint: ReturnType<typeof parseOutPoint>;
  readonly ownerLock: ScriptIdentity;
  readonly payoutLock?: ScriptIdentity;
  readonly preferredOperatorLockHash?: Hash32;
  readonly backupOperatorLockHashes?: readonly Hash32[];
}

const SETUP_KEYS = [
  "creatorNonce",
  "identityOutPoint",
  "ownerLock",
  "ownerLockHash",
  "payoutLock",
  "payoutLockHash",
  "principal",
  "totalCycles",
] as const;

function script(value: unknown, name: string): ScriptIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a lock script`);
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).toSorted().join(",");
  if (
    keys !== "args,codeHash,hashType" ||
    typeof item["codeHash"] !== "string" ||
    typeof item["args"] !== "string" ||
    !/^(?:0x)(?:[0-9a-f]{2})*$/.test(item["args"]) ||
    !["data", "data1", "type"].includes(String(item["hashType"]))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(item["codeHash"]),
    hashType: item["hashType"] as ScriptIdentity["hashType"],
    args: item["args"] as Hex,
  });
}

function setupRequest(value: unknown): SetupRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("DAO harvest setup must be an object");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== SETUP_KEYS.length || SETUP_KEYS.some((key) => !(key in item))) {
    throw new BadRequestException("DAO harvest setup contains unsupported fields");
  }
  try {
    const ownerLock = script(item["ownerLock"], "ownerLock");
    const payoutLock = script(item["payoutLock"], "payoutLock");
    const ownerLockHash = parseHash32(String(item["ownerLockHash"]));
    const payoutLockHash = parseHash32(String(item["payoutLockHash"]));
    if (scriptToHash(ownerLock) !== ownerLockHash || scriptToHash(payoutLock) !== payoutLockHash) {
      throw new TypeError("lock scripts do not match their reviewed hashes");
    }
    if (typeof item["principal"] !== "string" || typeof item["creatorNonce"] !== "string") {
      throw new TypeError("principal and creatorNonce must be decimal strings");
    }
    const principal = parseShannons(item["principal"]);
    const creatorNonce = parseSequence(item["creatorNonce"]);
    const totalCycles = item["totalCycles"];
    if (principal < MINIMUM_PRINCIPAL)
      throw new RangeError("original amount must be at least 242 CKB");
    if (
      !Number.isSafeInteger(totalCycles) ||
      Number(totalCycles) < 1 ||
      Number(totalCycles) > MAXIMUM_CYCLES
    ) {
      throw new RangeError(`number of harvests must be between 1 and ${MAXIMUM_CYCLES}`);
    }
    return Object.freeze({
      creatorNonce,
      identityOutPoint: parseOutPoint(item["identityOutPoint"]),
      ownerLock,
      ownerLockHash,
      payoutLock,
      payoutLockHash,
      principal,
      totalCycles: Number(totalCycles),
    });
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid setup");
  }
}

function ownerRequest(
  value: unknown,
  operation: "sweep" | "close" | "rotate" | "recover",
): OwnerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("DAO harvest owner action must be an object");
  }
  const item = value as Record<string, unknown>;
  const required = ["identityOutPoint", "jobId", "ownerLock"];
  if (operation === "sweep" || operation === "close") required.push("payoutLock");
  if (operation === "rotate") {
    required.push("preferredOperatorLockHash", "backupOperatorLockHashes");
  }
  if (Object.keys(item).length !== required.length || required.some((key) => !(key in item))) {
    throw new BadRequestException("DAO harvest owner action contains unsupported fields");
  }
  try {
    const backup = item["backupOperatorLockHashes"];
    if (
      operation === "rotate" &&
      (!Array.isArray(backup) || backup.length < 1 || backup.length > 8)
    ) {
      throw new TypeError("backupOperatorLockHashes must contain 1 to 8 lock hashes");
    }
    return Object.freeze({
      jobId: parseHash32(String(item["jobId"])),
      identityOutPoint: parseOutPoint(item["identityOutPoint"]),
      ownerLock: script(item["ownerLock"], "ownerLock"),
      ...((operation === "sweep" || operation === "close") && {
        payoutLock: script(item["payoutLock"], "payoutLock"),
      }),
      ...(operation === "rotate" && {
        preferredOperatorLockHash: parseHash32(String(item["preferredOperatorLockHash"])),
        backupOperatorLockHashes: Object.freeze(
          (backup as unknown[]).map((operatorHash) => parseHash32(String(operatorHash))),
        ),
      }),
    });
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid owner action");
  }
}

function u64(value: bigint): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function u16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, true);
  return result;
}

function chainScript(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  return script(
    {
      codeHash: String(value.codeHash),
      hashType: String(value.hashType),
      args: String(value.args),
    },
    "identity cell lock",
  );
}

function output(capacity: bigint, lock: ScriptIdentity, type: ScriptIdentity | null) {
  return Object.freeze({ capacity: `0x${capacity.toString(16)}` as Hex, lock, type });
}

function witnessOutputType(value: string): Uint8Array {
  const encoded = hexToBytes(value);
  if (encoded.length < 16) throw new Error("stored V2 witness is truncated");
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const total = view.getUint32(0, true);
  const start = view.getUint32(12, true);
  if (total !== encoded.length || start > total || total - start < 4) {
    throw new Error("stored V2 witness is invalid");
  }
  const length = view.getUint32(start, true);
  if (length !== total - start - 4) throw new Error("stored V2 witness output type is invalid");
  return encoded.slice(start + 4);
}

function storedOutPoint(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("indexed V2 outpoint is unavailable");
  }
  const item = value as Record<string, unknown>;
  return parseOutPoint({ txHash: String(item["txHash"]), index: String(item["index"]) });
}

function transactionInput(outPoint: ReturnType<typeof parseOutPoint>): {
  readonly since: Hex;
  readonly previousOutput: { readonly txHash: Hash32; readonly index: Hex };
} {
  return Object.freeze({
    since: "0x0" as const,
    previousOutput: Object.freeze({
      txHash: outPoint.txHash,
      index: `0x${outPoint.index.toString(16)}` as Hex,
    }),
  });
}

export class DaoHarvestV2TransactionAdapter implements DaoHarvestV2MutationAdapter {
  readonly #chain: Pick<CkbReadClient, "getCellLive" | "getTipHeader"> &
    Partial<Pick<CkbReadClient, "getBlockByNumber" | "getTransactionStatus">>;
  readonly #database: AutomataDatabase | undefined;
  readonly #deployments: readonly DaoHarvestV2Deployment[];
  readonly #network: string | undefined;

  constructor(
    chain: Pick<CkbReadClient, "getCellLive" | "getTipHeader"> &
      Partial<Pick<CkbReadClient, "getBlockByNumber" | "getTransactionStatus">>,
    deployment: DaoHarvestV2Deployment | readonly DaoHarvestV2Deployment[],
    database?: AutomataDatabase,
    network?: string,
  ) {
    this.#chain = chain;
    this.#deployments = Object.freeze(Array.isArray(deployment) ? [...deployment] : [deployment]);
    if (this.#deployments.length === 0)
      throw new RangeError("at least one V2 deployment is required");
    this.#database = database;
    this.#network = network;
  }

  async build(
    operation: "setup" | "sweep" | "close" | "rotate" | "recover",
    body: unknown,
  ): Promise<DaoHarvestV2UnsignedBuild> {
    return operation === "setup" ? this.#setup(body) : this.#ownerAction(operation, body);
  }

  async registerSetup(transactionHash: string): Promise<DaoHarvestV2PendingReadModel> {
    if (
      !this.#chain.getTransactionStatus ||
      this.#database === undefined ||
      this.#network === undefined
    ) {
      throw new ServiceUnavailableException(
        "DAO harvest V2 submission registration is not configured",
      );
    }
    const [observed, tip] = await Promise.all([
      this.#chain.getTransactionStatus(transactionHash),
      this.#chain.getTipHeader(),
    ]);
    if (
      !observed ||
      !["sent", "pending", "proposed", "committed"].includes(observed.status) ||
      parseHash32(observed.transaction.hash()) !== transactionHash
    ) {
      throw new BadRequestException("The submitted DAO harvest V2 transaction is not known on CKB");
    }
    const deployment = this.#deployments[0]!;
    const extraction = extractDaoHarvestV2ProjectionEvents(
      { header: tip, transactions: [observed.transaction] } as never,
      {
        networkId: this.#network,
        jobLock: { codeHash: deployment.contracts.jobLock.codeHash, hashType: "data1" },
        policy: {
          codeHash: deployment.contracts.policy.codeHash,
          hashType: "data1",
          args: deployment.contracts.jobLock.codeHash as Hex,
        },
        vaultLock: { codeHash: deployment.contracts.vaultLock.codeHash, hashType: "data1" },
        compensationLock: {
          codeHash: deployment.contracts.compensationLock.codeHash,
          hashType: "data1",
        },
        daoTypeHash: parseHash32(
          scriptToHash({ codeHash: deployment.nervosDao.codeHash, hashType: "type", args: "0x" }),
        ),
      },
    );
    const event = extraction.events[0];
    if (
      event === undefined ||
      extraction.events.length !== 1 ||
      extraction.malformed !== 0 ||
      event.operation !== "setup"
    ) {
      throw new BadRequestException(
        "The submitted transaction is not a valid DAO harvest V2 setup",
      );
    }
    const submittedAt = new Date();
    await this.#database
      .insert(transactionAttempts)
      .values({
        id: randomUUID(),
        networkId: this.#network,
        operation: "create",
        simulation: { kind: "pending_dao_harvest_v2", jobId: event.jobId },
        state: "submitted",
        submittedAt,
        txHash: transactionHash,
      })
      .onConflictDoNothing();
    return Object.freeze({
      transactionHash,
      submittedAt: submittedAt.toISOString(),
      status:
        observed.status === "sent" || observed.status === "pending" ? "submitting" : "confirming",
      lastKnownStatus: observed.status,
    });
  }

  async #setup(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    const request = setupRequest(body);
    const identity = await this.#chain.getCellLive(request.identityOutPoint);
    if (!identity) throw new BadRequestException("the selected owner cell is no longer live");
    if (
      identity.cellOutput.type !== undefined ||
      identity.outputData.toString() !== "0x" ||
      scriptToHash(chainScript(identity.cellOutput.lock)) !== request.ownerLockHash
    ) {
      throw new BadRequestException("the selected identity cell is not a plain owner cell");
    }

    const deployment = this.#deployments[0]!;
    const jobLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.jobLock.codeHash,
      hashType: "data1",
      args: "0x",
    });
    const policy: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1",
      args: deployment.contracts.jobLock.codeHash as Hex,
    });
    const daoType: ScriptIdentity = Object.freeze({
      codeHash: deployment.nervosDao.codeHash,
      hashType: "type",
      args: "0x",
    });
    const policyScriptHash = parseHash32(scriptToHash(policy));
    const jobLockHash = parseHash32(scriptToHash(jobLock));
    const daoTypeHash = parseHash32(scriptToHash(daoType));
    const fallback = deployment.fallbackPrepareOperatorLockHashes.map((value) => hexToBytes(value));
    const fallbackSetHash = deriveDaoHarvestV2FallbackOperatorSetHash(fallback);
    const proof = encodeDaoHarvestV2FallbackOperatorProof(fallback);
    const tip = await this.#chain.getTipHeader();
    const anticipatedDeposit = addEpochs(parseEpoch(packClientEpoch(tip.epoch)), 1n);
    const window = selectDaoPrepareWindow({
      deposit: anticipatedDeposit,
      tip: anticipatedDeposit,
      bufferEpochs: PREPARE_BUFFER_EPOCHS,
      confirmationMarginEpochs: CONFIRMATION_MARGIN_EPOCHS,
    });
    const prepareBuffer = encodeRelativeEpochSince(
      createEpoch({ number: PREPARE_BUFFER_EPOCHS, index: 0n, length: 1n }),
    );
    const takeoverDelay = encodeRelativeEpochSince(
      createEpoch({ number: 0n, index: 1n, length: 20n }),
    );
    const confirmationMargin = encodeRelativeEpochSince(
      createEpoch({ number: CONFIRMATION_MARGIN_EPOCHS, index: 0n, length: 1n }),
    );
    const endEpochSince = 0n;
    const payload = DaoHarvestPayloadV2.pack({
      version: 2,
      owner_lock_hash: [...hexToBytes(request.ownerLockHash)],
      payout_lock_hash: [...hexToBytes(request.payoutLockHash)],
      vault_lock_code_hash: [...hexToBytes(deployment.contracts.vaultLock.codeHash)],
      compensation_lock_code_hash: [...hexToBytes(deployment.contracts.compensationLock.codeHash)],
      dao_type_hash: [...hexToBytes(daoTypeHash)],
      principal_capacity: request.principal.toString(),
      preferred_prepare_operator_lock_hash: [
        ...hexToBytes(deployment.preferredPrepareOperatorLockHash),
      ],
      fallback_prepare_executor_set_hash: [...fallbackSetHash],
      prepare_service_fee: PREPARE_SERVICE_FEE.toString(),
      claim_service_fee: CLAIM_SERVICE_FEE.toString(),
      compensation_seed_capacity: COMPENSATION_SEED.toString(),
      prepare_buffer_epochs: prepareBuffer.toString(),
      takeover_delay_epochs: takeoverDelay.toString(),
      confirmation_margin_epochs: confirmationMargin.toString(),
      total_cycles: request.totalCycles,
      end_epoch_since: endEpochSince.toString(),
    });
    const payloadHashBytes = deriveDaoHarvestV2PayloadHash(hexToBytes(policyScriptHash), payload);
    const jobIdBytes = deriveJobId({
      genesisHash: hexToBytes(deployment.genesisHash),
      protocolVersion: 2,
      creationCommitment: payloadHashBytes,
      anchor: { kind: "output_index", outputIndex: 0n },
      creatorNonce: request.creatorNonce,
      policyScriptHash: hexToBytes(policyScriptHash),
    });
    const jobId = hash32FromBytes(jobIdBytes);
    const payloadHash = hash32FromBytes(payloadHashBytes);
    const progress = DaoHarvestProgressV2.pack({
      version: 2,
      state: 0,
      cycle_index: 0,
      prepare_credit_hash: Array(32).fill(0),
    });
    const progressHash = hash32FromBytes(deriveDaoHarvestV2ProgressHash(progress));
    const termsHash = deriveDaoHarvestV2VaultTermsHash([
      u16(2),
      hexToBytes(request.ownerLockHash),
      hexToBytes(request.payoutLockHash),
      hexToBytes(daoTypeHash),
      u64(request.principal),
      u64(PREPARE_SERVICE_FEE),
      u64(CLAIM_SERVICE_FEE),
      u64(COMPENSATION_SEED),
      u64(prepareBuffer),
      u64(takeoverDelay),
      u64(confirmationMargin),
      u32(request.totalCycles),
      u64(endEpochSince),
    ]);
    const vaultLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.vaultLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV2VaultLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(request.ownerLockHash),
          jobLockHash: hexToBytes(jobLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          immutableTermsHash: termsHash,
        }),
      ) as Hex,
    });
    const compensationLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.compensationLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV2CompensationLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(request.ownerLockHash),
          payoutLockHash: hexToBytes(request.payoutLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          payloadHash: payloadHashBytes,
        }),
      ) as Hex,
    });
    const jobData = JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: [...jobIdBytes],
      sequence: "0",
      state: 0,
      trigger_kind: 2,
      trigger_params_hash: [...hexToBytes(progressHash)],
      policy_script_hash: [...hexToBytes(policyScriptHash)],
      payload_hash: [...payloadHashBytes],
      reward: "0",
      remaining_budget: "0",
      not_before: encodeAbsoluteEpochSince(window.startsAt).toString(),
      not_after: "0",
      remaining_runs: request.totalCycles,
      cancel_lock_hash: [...hexToBytes(request.ownerLockHash)],
    });
    const totalLockedAmount = JOB_CAPACITY + request.principal + COMPENSATION_SEED;
    const build = buildDaoHarvestV2Transaction({
      operation: 0,
      policyScriptHash,
      payload,
      progress,
      operatorProof: proof,
      indices: {
        ...absentDaoHarvestV2Indices(),
        identityInputIndex: 0,
        jobOutputIndex: 0,
        vaultOutputIndex: 1,
        compensationOutputIndex: 2,
      },
      cellDeps: [
        deployment.secp256k1Blake160.cellDep,
        deployment.contracts.jobLock.cellDep,
        deployment.contracts.policy.cellDep,
        deployment.contracts.vaultLock.cellDep,
        deployment.contracts.compensationLock.cellDep,
        deployment.nervosDao.cellDep,
      ],
      headerDeps: [],
      inputs: [
        {
          since: "0x0",
          previousOutput: {
            txHash: request.identityOutPoint.txHash,
            index: `0x${request.identityOutPoint.index.toString(16)}`,
          },
        },
      ],
      inputCapacities: [parseShannons(identity.cellOutput.capacity.toString())],
      outputs: [
        output(JOB_CAPACITY, jobLock, policy),
        output(request.principal, vaultLock, daoType),
        output(COMPENSATION_SEED, compensationLock, null),
      ],
      outputsData: [bytesToHex(jobData) as Hex, "0x0000000000000000", "0x"],
      allowedFundingLockHashes: [request.ownerLockHash],
      economics: {
        originalAmount: request.principal,
        expectedCompensation: 0n,
        prepareServiceCharge: PREPARE_SERVICE_FEE,
        claimServiceCharge: CLAIM_SERVICE_FEE,
        maximumNetworkFee: MAXIMUM_NETWORK_FEE,
        recoverableReserve: COMPENSATION_SEED,
        accumulatedCompensation: 0n,
        totalLockedAmount,
      },
    });
    return Object.freeze({
      version: 2 as const,
      jobId,
      operation: "setup" as const,
      transaction: build.transaction,
      intentHash: build.intentHash,
      payloadHash,
      progressHash,
      prepareCreditHash: build.prepareCreditHash,
      review: Object.freeze({
        originalAmount: build.review.originalAmount.toString(),
        expectedCompensation: build.review.expectedCompensation.toString(),
        completedWorkCharges: Object.freeze({
          prepare: build.review.completedWorkCharges.prepare.toString(),
          claim: build.review.completedWorkCharges.claim.toString(),
          maximumTotal: build.review.completedWorkCharges.maximumTotal.toString(),
        }),
        maximumNetworkFee: build.review.maximumNetworkFee.toString(),
        recoverableReserve: build.review.recoverableReserve.toString(),
        accumulatedCompensation: build.review.accumulatedCompensation.toString(),
        totalLockedAmount: build.review.totalLockedAmount.toString(),
        notes: build.review.notes,
      }),
      completion: Object.freeze({
        requiredInputCount: build.completion.requiredInputCount,
        requiredOutputCount: build.completion.requiredOutputCount,
        requiredInputCapacity: build.completion.requiredInputCapacity.toString(),
        maximumFee: build.completion.maximumFee.toString(),
        allowedFundingLockHashes: build.completion.allowedFundingLockHashes,
      }),
    });
  }

  async #ownerAction(
    operation: "sweep" | "close" | "rotate" | "recover",
    body: unknown,
  ): Promise<DaoHarvestV2UnsignedBuild> {
    if (
      this.#database === undefined ||
      this.#network === undefined ||
      !this.#chain.getTransactionStatus
    ) {
      throw new ServiceUnavailableException("DAO harvest V2 owner actions are not configured");
    }
    const request = ownerRequest(body, operation);
    const [row] = await this.#database
      .select()
      .from(daoHarvestV2Jobs)
      .where(
        and(
          eq(daoHarvestV2Jobs.networkId, this.#network),
          eq(daoHarvestV2Jobs.jobId, request.jobId),
          eq(daoHarvestV2Jobs.canonical, true),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException("DAO harvest automation is not indexed");
    const ownerLockHash = parseHash32(scriptToHash(request.ownerLock));
    if (ownerLockHash !== row.ownerLockHash) {
      throw new BadRequestException("the connected wallet is not the automation owner");
    }
    if (request.payoutLock && scriptToHash(request.payoutLock) !== row.payoutLockHash) {
      throw new BadRequestException("payout address does not match the automation");
    }
    if (operation === "sweep" && row.lifecycleState === "completed") {
      throw new BadRequestException("close a completed automation instead of withdrawing from it");
    }
    if (operation === "close" && row.lifecycleState !== "completed") {
      throw new BadRequestException("only a completed automation can be closed");
    }
    if (operation === "rotate" && row.lifecycleState !== "deposited") {
      throw new BadRequestException("operators can be updated only while the deposit is waiting");
    }
    if (
      operation === "recover" &&
      row.lifecycleState !== "deposited" &&
      row.lifecycleState !== "withdrawing"
    ) {
      throw new BadRequestException("this automation is not available for owner recovery");
    }

    const identity = await this.#chain.getCellLive(request.identityOutPoint);
    if (
      !identity ||
      identity.cellOutput.type !== undefined ||
      identity.outputData.toString() !== "0x" ||
      scriptToHash(chainScript(identity.cellOutput.lock)) !== ownerLockHash
    ) {
      throw new BadRequestException("the selected owner cell is no longer available");
    }
    const source = await this.#chain.getTransactionStatus(row.observedTransactionHash);
    if (!source || source.status !== "committed") {
      throw new BadRequestException("the indexed harvest state is no longer canonical");
    }
    const sourceWitness = source.transaction.witnesses[0]?.toString();
    if (!sourceWitness) throw new Error("indexed V2 transaction has no protocol witness");
    const envelope = DaoHarvestEnvelopeV2.unpack(witnessOutputType(sourceWitness));
    const payload = Uint8Array.from(envelope.payload);
    let progress: Uint8Array = Uint8Array.from(envelope.progress);
    const payloadValue = DaoHarvestPayloadV2.unpack(payload);
    let progressValue = DaoHarvestProgressV2.unpack(progress);
    const seed = parseShannons(payloadValue.compensation_seed_capacity.toString());
    const principal = parseShannons(payloadValue.principal_capacity.toString());
    const vaultCodeHash = hash32FromBytes(Uint8Array.from(payloadValue.vault_lock_code_hash));
    const compensationCodeHash = hash32FromBytes(
      Uint8Array.from(payloadValue.compensation_lock_code_hash),
    );
    const deployment = this.#deployments.find(
      (candidate) =>
        candidate.contracts.vaultLock.codeHash === vaultCodeHash &&
        candidate.contracts.compensationLock.codeHash === compensationCodeHash,
    );
    if (deployment === undefined) {
      throw new ServiceUnavailableException("the automation contract revision is unavailable");
    }
    const jobPoint = row.jobOutpoint === null ? undefined : storedOutPoint(row.jobOutpoint);
    const vaultPoint = row.vaultOutpoint === null ? undefined : storedOutPoint(row.vaultOutpoint);
    const compensationPoint = storedOutPoint(row.compensationOutpoint);
    const [jobCell, vaultCell, compensationCell] = await Promise.all([
      jobPoint ? this.#chain.getCellLive(jobPoint) : undefined,
      vaultPoint ? this.#chain.getCellLive(vaultPoint) : undefined,
      this.#chain.getCellLive(compensationPoint),
    ]);
    if (!compensationCell || (jobPoint && !jobCell) || (operation === "recover" && !vaultCell)) {
      throw new BadRequestException("the indexed harvest state has already changed");
    }
    const compensationCapacity = parseShannons(compensationCell.cellOutput.capacity.toString());
    const accumulated = compensationCapacity - seed;
    if (
      (operation === "sweep" || operation === "close") &&
      compensationCapacity - (operation === "sweep" ? seed : 0n) <
        minimumPlainCellCapacity(request.payoutLock!)
    ) {
      throw new BadRequestException("the available compensation is too small to withdraw yet");
    }
    if (operation === "close") {
      const args = decodeDaoHarvestV2CompensationLockArgs(
        hexToBytes(chainScript(compensationCell.cellOutput.lock).args),
      );
      if (args.jobId.some((byte) => byte !== 0)) {
        throw new BadRequestException("the completed compensation cell is not ready to close");
      }
    }
    let prepareCredit: Uint8Array | undefined;
    let headerDeps: Hash32[] = [];
    let additionalWitnesses: Hex[] | undefined;
    let effectiveVaultCapacity: bigint | undefined;
    let expectedCompensation = accumulated;
    if (operation === "recover" && row.lifecycleState === "withdrawing") {
      if (Number(progressValue.state) !== 1) {
        throw new BadRequestException("the indexed withdrawal progress is inconsistent");
      }
      if (!this.#chain.getBlockByNumber || source.blockNumber === undefined) {
        throw new ServiceUnavailableException("DAO recovery headers are not configured");
      }
      prepareCredit = Uint8Array.from(envelope.prepare_credit);
      const creditValue = DaoHarvestPrepareCreditV2.unpack(prepareCredit);
      const creditHash = deriveDaoHarvestV2PrepareCreditHash(prepareCredit);
      progress = DaoHarvestProgressV2.pack({
        version: 2,
        state: 1,
        cycle_index: creditValue.cycle_index,
        prepare_credit_hash: [...creditHash],
      });
      progressValue = DaoHarvestProgressV2.unpack(progress);
      if (!vaultCell || !jobCell)
        throw new BadRequestException("the recovery cells are unavailable");
      const vaultData = hexToBytes(vaultCell.outputData.toString());
      if (vaultData.length !== 8)
        throw new BadRequestException("the DAO withdrawal data is invalid");
      const depositBlockNumber = new DataView(
        vaultData.buffer,
        vaultData.byteOffset,
        vaultData.byteLength,
      ).getBigUint64(0, true);
      const prepareBlockNumber = BigInt(source.blockNumber.toString());
      const [depositBlock, prepareBlock] = await Promise.all([
        this.#chain.getBlockByNumber(depositBlockNumber),
        this.#chain.getBlockByNumber(prepareBlockNumber),
      ]);
      if (!depositBlock || !prepareBlock) {
        throw new BadRequestException("the canonical DAO recovery headers are unavailable");
      }
      effectiveVaultCapacity = calculateDaoMaximumWithdraw({
        principal,
        occupiedCapacity: MINIMUM_PRINCIPAL,
        depositAccumulatedRate: clientDaoAccumulatedRate(depositBlock.header.dao),
        withdrawingAccumulatedRate: clientDaoAccumulatedRate(prepareBlock.header.dao),
      });
      expectedCompensation = effectiveVaultCapacity - principal;
      headerDeps = [parseHash32(depositBlock.header.hash), parseHash32(prepareBlock.header.hash)];
      additionalWitnesses = [
        serializeWitnessArgs({
          lock: "",
          inputType: bytesToHex(u64(depositBlockNumber)),
          outputType: "",
        }) as Hex,
      ];
    }
    const inputs = [] as ReturnType<typeof transactionInput>[];
    const inputCapacities: bigint[] = [];
    const addInput = (
      point: ReturnType<typeof parseOutPoint>,
      capacity: bigint,
      since: bigint = 0n,
    ) => {
      inputs.push({ ...transactionInput(point), since: `0x${since.toString(16)}` as Hex });
      inputCapacities.push(capacity);
      return inputs.length - 1;
    };
    const indices = { ...absentDaoHarvestV2Indices() };
    if (jobPoint && jobCell) {
      indices.jobInputIndex = addInput(
        jobPoint,
        parseShannons(jobCell.cellOutput.capacity.toString()),
      );
    }
    if (operation === "recover" && vaultPoint && vaultCell) {
      const jobValue = jobCell
        ? JobDataV1.unpack(hexToBytes(jobCell.outputData.toString()))
        : undefined;
      indices.vaultInputIndex = addInput(
        vaultPoint,
        effectiveVaultCapacity ?? parseShannons(vaultCell.cellOutput.capacity.toString()),
        row.lifecycleState === "withdrawing" && jobValue
          ? BigInt(jobValue.not_before.toString())
          : 0n,
      );
    }
    indices.compensationInputIndex = addInput(compensationPoint, compensationCapacity);
    indices.identityInputIndex = addInput(
      request.identityOutPoint,
      parseShannons(identity.cellOutput.capacity.toString()),
    );

    const outputs = [] as ReturnType<typeof output>[];
    const outputsData: Hex[] = [];
    let successorPayload: Uint8Array | undefined;
    let operatorProof: Uint8Array | undefined;
    if (operation === "sweep" || operation === "rotate") {
      if (!jobCell) throw new BadRequestException("the live harvest Job Cell is unavailable");
      let jobData = jobCell.outputData.toString() as Hex;
      let compensationLock = chainScript(compensationCell.cellOutput.lock);
      if (operation === "rotate") {
        const fallback = request.backupOperatorLockHashes!.map((value) => hexToBytes(value));
        operatorProof = encodeDaoHarvestV2FallbackOperatorProof(fallback);
        const fallbackSetHash = deriveDaoHarvestV2FallbackOperatorSetHash(fallback);
        successorPayload = DaoHarvestPayloadV2.pack({
          ...payloadValue,
          preferred_prepare_operator_lock_hash: [...hexToBytes(request.preferredOperatorLockHash!)],
          fallback_prepare_executor_set_hash: [...fallbackSetHash],
        });
        const policyHash = parseHash32(scriptToHash(chainScript(jobCell.cellOutput.type!)));
        const nextPayloadHash = deriveDaoHarvestV2PayloadHash(
          hexToBytes(policyHash),
          successorPayload,
        );
        const jobValue = JobDataV1.unpack(hexToBytes(jobData));
        jobData = bytesToHex(
          JobDataV1.pack({ ...jobValue, payload_hash: [...nextPayloadHash] }),
        ) as Hex;
        const compensationArgs = decodeDaoHarvestV2CompensationLockArgs(
          hexToBytes(compensationLock.args),
        );
        compensationLock = Object.freeze({
          ...compensationLock,
          args: bytesToHex(
            encodeDaoHarvestV2CompensationLockArgs({
              ...compensationArgs,
              payloadHash: nextPayloadHash,
            }),
          ) as Hex,
        });
      }
      indices.jobOutputIndex = outputs.length;
      outputs.push(
        output(
          parseShannons(jobCell.cellOutput.capacity.toString()),
          chainScript(jobCell.cellOutput.lock),
          chainScript(jobCell.cellOutput.type!),
        ),
      );
      outputsData.push(jobData);
      indices.compensationOutputIndex = outputs.length;
      outputs.push(
        output(operation === "sweep" ? seed : compensationCapacity, compensationLock, null),
      );
      outputsData.push("0x");
      if (operation === "sweep") {
        if (accumulated === 0n)
          throw new BadRequestException("there is no compensation to withdraw");
        outputs.push(output(accumulated, request.payoutLock!, null));
        outputsData.push("0x");
      }
    } else if (operation === "close") {
      outputs.push(output(compensationCapacity, request.payoutLock!, null));
      outputsData.push("0x");
    } else {
      if (!jobCell || !vaultCell)
        throw new BadRequestException("the recovery cells are unavailable");
      const refund =
        parseShannons(jobCell.cellOutput.capacity.toString()) +
        (effectiveVaultCapacity ?? parseShannons(vaultCell.cellOutput.capacity.toString())) +
        compensationCapacity;
      outputs.push(output(refund, request.ownerLock, null));
      outputsData.push("0x");
    }

    const operationNumber = {
      sweep: DAO_HARVEST_V2_OPERATIONS.SWEEP,
      close: DAO_HARVEST_V2_OPERATIONS.CLOSE,
      rotate: DAO_HARVEST_V2_OPERATIONS.ROTATE,
      recover: DAO_HARVEST_V2_OPERATIONS.RECOVER,
    }[operation];
    const policyScriptHash = parseHash32(
      scriptToHash({
        codeHash: deployment.contracts.policy.codeHash,
        hashType: "data1",
        args: deployment.contracts.jobLock.codeHash as Hex,
      }),
    );
    const build = buildDaoHarvestV2Transaction({
      operation: operationNumber,
      policyScriptHash,
      payload,
      progress,
      ...(successorPayload === undefined ? {} : { successorPayload }),
      ...(operatorProof === undefined ? {} : { operatorProof }),
      ...(prepareCredit === undefined ? {} : { prepareCredit }),
      indices,
      cellDeps: [
        deployment.secp256k1Blake160.cellDep,
        deployment.contracts.jobLock.cellDep,
        deployment.contracts.policy.cellDep,
        deployment.contracts.vaultLock.cellDep,
        deployment.contracts.compensationLock.cellDep,
        deployment.nervosDao.cellDep,
      ],
      headerDeps,
      inputs,
      ...(additionalWitnesses === undefined ? {} : { additionalWitnesses }),
      inputCapacities,
      outputs,
      outputsData,
      allowedFundingLockHashes: [ownerLockHash],
      economics: {
        originalAmount: principal,
        expectedCompensation,
        prepareServiceCharge: parseShannons(payloadValue.prepare_service_fee.toString()),
        claimServiceCharge: parseShannons(payloadValue.claim_service_fee.toString()),
        maximumNetworkFee: MAXIMUM_NETWORK_FEE,
        recoverableReserve: seed,
        accumulatedCompensation: accumulated,
        totalLockedAmount: outputs.reduce(
          (total, candidate) => total + parseShannons(BigInt(candidate.capacity)),
          0n,
        ),
      },
    });
    return Object.freeze({
      version: 2 as const,
      jobId: request.jobId,
      operation,
      transaction: build.transaction,
      intentHash: build.intentHash,
      payloadHash: build.payloadHash,
      progressHash: build.progressHash,
      prepareCreditHash: build.prepareCreditHash,
      review: Object.freeze({
        originalAmount: build.review.originalAmount.toString(),
        expectedCompensation: build.review.expectedCompensation.toString(),
        completedWorkCharges: Object.freeze({
          prepare: build.review.completedWorkCharges.prepare.toString(),
          claim: build.review.completedWorkCharges.claim.toString(),
          maximumTotal: build.review.completedWorkCharges.maximumTotal.toString(),
        }),
        maximumNetworkFee: build.review.maximumNetworkFee.toString(),
        recoverableReserve: build.review.recoverableReserve.toString(),
        accumulatedCompensation: build.review.accumulatedCompensation.toString(),
        totalLockedAmount: build.review.totalLockedAmount.toString(),
        notes: build.review.notes,
      }),
      completion: Object.freeze({
        requiredInputCount: build.completion.requiredInputCount,
        requiredOutputCount: build.completion.requiredOutputCount,
        requiredInputCapacity: build.completion.requiredInputCapacity.toString(),
        maximumFee: build.completion.maximumFee.toString(),
        allowedFundingLockHashes: build.completion.allowedFundingLockHashes,
      }),
    });
  }
}
