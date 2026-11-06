import { JobDataV1, RecurringPayloadV1 } from "@ckb-automata/molecule";
import {
  PERSONAL,
  blake2b,
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  hash32FromBytes,
  hash32ToBytes,
  parseBlockNumber,
  parseHash32,
  parseRunCount,
  parseSequence,
  parseShannons,
  sameCellDepValue,
  toRpcHex,
  uint64ToLittleEndian,
  type Hash32,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";
import type {
  UnsignedCellOutput,
  UnsignedDeadlineTransaction as UnsignedTransaction,
} from "./deadline-creation.ts";
import type { ScriptIdentity } from "./job-inspection.ts";
import { deriveJobId } from "./job-identity.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import type { OperatorAutomationDeployment } from "./operator-deployment.ts";
import {
  deriveOperatorPayloadHash,
  normalizeOperatorSelection,
  operatorTakeoverBlock,
  packOperatorPayload,
  unpackOperatorPayload,
} from "./operator-selection.ts";
import {
  deriveRecurringPayloadHash,
  isValidRecurringSchedule,
  type RecurringSchedule,
} from "./recurring.ts";
import { calculateRecurringQuote, type FeeRangeInput, type RecurringQuote } from "./quotes.ts";
import { ABSOLUTE_BLOCK_TRIGGER_KIND, deriveAbsoluteBlockTriggerHash } from "./triggers.ts";

export const RECURRING_CREATION_INTENT_DOMAIN =
  "ckb-automata/recurring-creation-intent/v1" as const;

type Hex = `0x${string}`;

export interface RecurringCreationInput {
  readonly deployment: RegisteredDeployment;
  readonly ownerLockHash: Hash32;
  readonly recipientLockHash: Hash32;
  readonly amount: IntegerInput;
  readonly intervalBlocks: IntegerInput;
  readonly firstNotBefore: IntegerInput;
  readonly totalRuns: IntegerInput;
  readonly reward: IntegerInput;
  readonly creatorNonce: IntegerInput;
  readonly creationFee: FeeRangeInput;
  readonly operator?: {
    readonly deployment: OperatorAutomationDeployment;
    readonly preferredExecutorLockHash: Hash32;
    readonly takeoverDelayBlocks?: bigint;
  };
}

export interface RecurringDisplayIntent {
  readonly kind: "recurring";
  readonly jobId: Hash32;
  readonly ownerLockHash: Hash32;
  readonly recipientLockHash: Hash32;
  readonly amount: string;
  readonly intervalBlocks: string;
  readonly firstNotBefore: string;
  readonly totalRuns: string;
  readonly reward: string;
  readonly finalRefund: "owner";
  readonly policyScriptHash: Hash32;
  readonly payloadHash: Hash32;
  readonly preferredExecutorLockHash?: Hash32;
  readonly takeoverBlock?: string;
}

export interface NormalizedRecurringIntent {
  readonly version: 1 | 2;
  readonly genesisHash: Hash32;
  readonly deploymentManifestSha256: string;
  readonly jobOutputIndex: 0;
  readonly ownerLockHash: Hash32;
  readonly recipientLockHash: Hash32;
  readonly amount: string;
  readonly intervalBlocks: string;
  readonly firstNotBefore: string;
  readonly totalRuns: string;
  readonly reward: string;
  readonly remainingBudget: string;
  readonly jobCapacity: string;
  readonly policyScriptHash: Hash32;
  readonly payloadHash: Hash32;
  readonly triggerParamsHash: Hash32;
  readonly recurringPayload: Hex;
  readonly preferredExecutorLockHash?: Hash32;
  readonly takeoverBlock?: string;
  readonly operatorPayload?: Hex;
  readonly operatorDeploymentManifestSha256?: string;
}

export interface RecurringCreationBuild {
  readonly transaction: UnsignedTransaction;
  readonly intent: NormalizedRecurringIntent;
  readonly displayIntent: RecurringDisplayIntent;
  readonly intentBytes: Hex;
  readonly intentHash: Hash32;
  readonly jobId: Hash32;
  readonly recurringPayload: Hex;
  readonly jobData: Hex;
  readonly quote: RecurringQuote;
  readonly completion: {
    readonly requiredOutputCount: 1;
    readonly requiredOutputType: Hex;
    readonly maximumFee: Shannons;
  };
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function protocolHash(domain: string, body: Uint8Array): Uint8Array {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(uint32(body.length));
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

function requireNonzeroHash(value: Hash32, name: string): Hash32 {
  const hash = parseHash32(value);
  if (/^0x0{64}$/.test(hash)) throw new RangeError(`${name} must not be zero`);
  return hash;
}

function script(
  contract: { readonly script: Omit<ScriptIdentity, "args"> },
  args: Hex,
): ScriptIdentity {
  return Object.freeze({ ...contract.script, args });
}

function validateLastRun(schedule: RecurringSchedule): void {
  const last = schedule.firstNotBefore + (schedule.totalRuns - 1n) * schedule.intervalBlocks;
  if (last > (1n << 56n) - 1n) {
    throw new RangeError("recurring schedule exceeds the absolute block-number range");
  }
}

function intentBody(intent: NormalizedRecurringIntent): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(intent.deploymentManifestSha256)) {
    throw new TypeError("deployment manifest digest must be a lowercase SHA-256 value");
  }
  const payload = hexToBytes(intent.recurringPayload);
  const base = concatenate(
    hash32ToBytes(intent.genesisHash),
    hexToBytes(`0x${intent.deploymentManifestSha256}`),
    uint32(intent.jobOutputIndex),
    hash32ToBytes(intent.ownerLockHash),
    hash32ToBytes(intent.recipientLockHash),
    uint64ToLittleEndian(parseShannons(intent.amount)),
    uint64ToLittleEndian(parseBlockNumber(intent.intervalBlocks)),
    uint64ToLittleEndian(parseBlockNumber(intent.firstNotBefore)),
    uint32(Number(parseRunCount(intent.totalRuns))),
    uint64ToLittleEndian(parseShannons(intent.reward)),
    uint64ToLittleEndian(parseShannons(intent.remainingBudget)),
    uint64ToLittleEndian(parseShannons(intent.jobCapacity)),
    hash32ToBytes(intent.policyScriptHash),
    hash32ToBytes(intent.payloadHash),
    hash32ToBytes(intent.triggerParamsHash),
    uint32(payload.length),
    payload,
  );
  if (intent.version === 1) return base;
  if (
    intent.preferredExecutorLockHash === undefined ||
    intent.takeoverBlock === undefined ||
    intent.operatorPayload === undefined ||
    intent.operatorDeploymentManifestSha256 === undefined
  ) {
    throw new TypeError("operator intent fields are incomplete");
  }
  return concatenate(
    base,
    hash32ToBytes(intent.preferredExecutorLockHash),
    uint64ToLittleEndian(parseBlockNumber(intent.takeoverBlock)),
    hexToBytes(`0x${intent.operatorDeploymentManifestSha256}`),
    uint32(hexToBytes(intent.operatorPayload).length),
    hexToBytes(intent.operatorPayload),
  );
}

function witnessOutputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) throw new Error("witness 0 is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || outputOffset > total) {
    throw new Error("witness 0 has invalid Molecule offsets");
  }
  const field = bytes.slice(outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("witness 0 has an invalid output_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function outputMatches(
  output: UnsignedCellOutput | undefined,
  expected: UnsignedCellOutput,
): boolean {
  return stable(output) === stable(expected);
}

export function buildRecurringCreation(input: RecurringCreationInput): RecurringCreationBuild {
  const ownerLockHash = requireNonzeroHash(input.ownerLockHash, "ownerLockHash");
  const recipientLockHash = requireNonzeroHash(input.recipientLockHash, "recipientLockHash");
  const amount = parseShannons(input.amount);
  const reward = parseShannons(input.reward);
  const intervalBlocks = parseBlockNumber(input.intervalBlocks);
  const firstNotBefore = parseBlockNumber(input.firstNotBefore);
  const totalRuns = parseRunCount(input.totalRuns);
  const creatorNonce = parseSequence(input.creatorNonce);
  const schedule: RecurringSchedule = {
    amount,
    intervalBlocks,
    firstNotBefore,
    totalRuns,
    finalRefundKind: 0,
  };
  if (!isValidRecurringSchedule(schedule)) {
    throw new RangeError("recurring schedule contains an unsupported boundary");
  }
  validateLastRun(schedule);
  const quote = calculateRecurringQuote({
    amountPerExecution: amount,
    rewardPerExecution: reward,
    executions: totalRuns,
    creationFee: input.creationFee,
  });
  const recurringPayloadBytes = RecurringPayloadV1.pack({
    version: 1,
    owner_lock_hash: [...hash32ToBytes(ownerLockHash)],
    recipient_lock_hash: [...hash32ToBytes(recipientLockHash)],
    amount: amount.toString(),
    interval_blocks: intervalBlocks.toString(),
    first_not_before: firstNotBefore.toString(),
    total_runs: Number(totalRuns),
    reward: reward.toString(),
    final_refund_kind: 0,
  });
  const recurringPayload = bytesToHex(recurringPayloadBytes) as Hex;
  const operator = input.operator;
  const selection =
    operator === undefined
      ? undefined
      : normalizeOperatorSelection({
          preferredExecutorLockHash: operator.preferredExecutorLockHash,
          ...(operator.takeoverDelayBlocks === undefined
            ? {}
            : { takeoverDelayBlocks: operator.takeoverDelayBlocks }),
        });
  const operatorPayloadBytes =
    selection === undefined ? undefined : packOperatorPayload(selection, recurringPayloadBytes);
  const policyScript = script(
    operator?.deployment.contracts.recurringPolicy ??
      input.deployment.contracts["recurring-policy"],
    "0x",
  );
  const policyScriptHash = parseHash32(scriptToHash(policyScript));
  const payloadHashBytes =
    operatorPayloadBytes === undefined
      ? deriveRecurringPayloadHash(hash32ToBytes(policyScriptHash), recurringPayloadBytes)
      : deriveOperatorPayloadHash(hash32ToBytes(policyScriptHash), operatorPayloadBytes);
  const payloadHash = hash32FromBytes(payloadHashBytes);
  const takeoverBlock =
    selection === undefined
      ? undefined
      : operatorTakeoverBlock(firstNotBefore, selection.takeoverDelayBlocks);
  const triggerParamsHash = hash32FromBytes(deriveAbsoluteBlockTriggerHash(firstNotBefore));
  const intent = Object.freeze({
    version: operator === undefined ? (1 as const) : (2 as const),
    genesisHash: input.deployment.genesisHash,
    deploymentManifestSha256: input.deployment.manifestSha256,
    jobOutputIndex: 0 as const,
    ownerLockHash,
    recipientLockHash,
    amount: amount.toString(),
    intervalBlocks: intervalBlocks.toString(),
    firstNotBefore: firstNotBefore.toString(),
    totalRuns: totalRuns.toString(),
    reward: reward.toString(),
    remainingBudget: quote.remainingBudget.toString(),
    jobCapacity: quote.maximumLockedTotal.toString(),
    policyScriptHash,
    payloadHash,
    triggerParamsHash,
    recurringPayload,
    ...(selection === undefined || takeoverBlock === undefined || operatorPayloadBytes === undefined
      ? {}
      : {
          preferredExecutorLockHash: selection.preferredExecutorLockHash,
          takeoverBlock: takeoverBlock.toString(),
          operatorPayload: bytesToHex(operatorPayloadBytes) as Hex,
          operatorDeploymentManifestSha256: operator!.deployment.manifestSha256,
        }),
  });
  const encodedIntent = intentBody(intent);
  const intentHashBytes = protocolHash(RECURRING_CREATION_INTENT_DOMAIN, encodedIntent);
  const intentHash = hash32FromBytes(intentHashBytes);
  const jobIdBytes = deriveJobId({
    genesisHash: hash32ToBytes(input.deployment.genesisHash),
    protocolVersion: operator === undefined ? 1 : 2,
    creationCommitment: intentHashBytes,
    anchor: { kind: "output_index", outputIndex: 0n },
    creatorNonce,
    policyScriptHash: hash32ToBytes(policyScriptHash),
  });
  const jobId = hash32FromBytes(jobIdBytes);
  const jobDataBytes = JobDataV1.pack({
    version: 1,
    flags: 0,
    job_id: [...jobIdBytes],
    sequence: "0",
    state: 0,
    trigger_kind: ABSOLUTE_BLOCK_TRIGGER_KIND,
    trigger_params_hash: [...hash32ToBytes(triggerParamsHash)],
    policy_script_hash: [...hash32ToBytes(policyScriptHash)],
    payload_hash: [...payloadHashBytes],
    reward: reward.toString(),
    remaining_budget: quote.remainingBudget.toString(),
    not_before: firstNotBefore.toString(),
    not_after: takeoverBlock?.toString() ?? "0",
    remaining_runs: Number(totalRuns),
    cancel_lock_hash: [...hash32ToBytes(ownerLockHash)],
  });
  const jobData = bytesToHex(jobDataBytes) as Hex;
  const jobLock = script(
    operator?.deployment.contracts.jobLock ?? input.deployment.contracts["job-lock"],
    "0x",
  );
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      operator?.deployment.secp256k1Blake160.cellDep ??
        input.deployment.manifest.secp256k1Blake160.cellDep,
      operator?.deployment.contracts.jobLock.cellDep ??
        input.deployment.contracts["job-lock"].cellDep,
      operator?.deployment.contracts.recurringPolicy.cellDep ??
        input.deployment.contracts["recurring-policy"].cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([]),
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(quote.maximumLockedTotal),
        lock: jobLock,
        type: policyScript,
      }),
    ]),
    outputsData: Object.freeze([jobData]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: "",
        inputType: "",
        outputType:
          operatorPayloadBytes === undefined ? recurringPayload : bytesToHex(operatorPayloadBytes),
      }) as Hex,
    ]),
  });
  const displayIntent: RecurringDisplayIntent = Object.freeze({
    kind: "recurring",
    jobId,
    ownerLockHash,
    recipientLockHash,
    amount: amount.toString(),
    intervalBlocks: intervalBlocks.toString(),
    firstNotBefore: firstNotBefore.toString(),
    totalRuns: totalRuns.toString(),
    reward: reward.toString(),
    finalRefund: "owner",
    policyScriptHash,
    payloadHash,
    ...(selection === undefined || takeoverBlock === undefined
      ? {}
      : {
          preferredExecutorLockHash: selection.preferredExecutorLockHash,
          takeoverBlock: takeoverBlock.toString(),
        }),
  });
  return Object.freeze({
    transaction,
    intent,
    displayIntent,
    intentBytes: bytesToHex(encodedIntent) as Hex,
    intentHash,
    jobId,
    recurringPayload,
    jobData,
    quote,
    completion: Object.freeze({
      requiredOutputCount: 1,
      requiredOutputType:
        operatorPayloadBytes === undefined
          ? recurringPayload
          : (bytesToHex(operatorPayloadBytes) as Hex),
      maximumFee: quote.estimatedFee.maximum,
    }),
  });
}

export function assertRecurringCompletion(
  build: RecurringCreationBuild,
  completed: UnsignedTransaction,
): void {
  if (
    completed.version !== build.transaction.version ||
    stable(completed.headerDeps) !== stable(build.transaction.headerDeps)
  ) {
    throw new Error("wallet completion changed transaction metadata");
  }
  if (completed.inputs.length === 0) {
    throw new Error("wallet completion did not add a funding input");
  }
  if (
    !outputMatches(completed.outputs[0], build.transaction.outputs[0] as UnsignedCellOutput) ||
    completed.outputsData[0] !== build.transaction.outputsData[0]
  ) {
    throw new Error("wallet completion changed the recurring Job Cell output");
  }
  if (completed.outputs.length !== completed.outputsData.length) {
    throw new Error("completed outputs and data lengths differ");
  }
  for (const requiredDep of build.transaction.cellDeps) {
    if (!completed.cellDeps.some((candidate) => sameCellDepValue(candidate, requiredDep))) {
      throw new Error("wallet completion removed a required cell dependency");
    }
  }
  const firstWitness = completed.witnesses[0];
  if (!firstWitness || witnessOutputType(firstWitness) !== build.completion.requiredOutputType) {
    throw new Error("wallet completion changed the recurring payload in witness 0");
  }
}

export function reconstructRecurringDisplayIntent(
  transaction: UnsignedTransaction,
  deployment: RegisteredDeployment,
  operatorDeployment?: OperatorAutomationDeployment,
): RecurringDisplayIntent {
  const output = transaction.outputs[0];
  const data = transaction.outputsData[0];
  const witness = transaction.witnesses[0];
  if (!output || !data || !witness) throw new Error("recurring creation is incomplete");
  const v2Lock =
    operatorDeployment === undefined
      ? undefined
      : script(operatorDeployment.contracts.jobLock, "0x");
  const usesOperatorPolicy = v2Lock !== undefined && stable(output.lock) === stable(v2Lock);
  const expectedLock = usesOperatorPolicy ? v2Lock : script(deployment.contracts["job-lock"], "0x");
  const expectedPolicy = usesOperatorPolicy
    ? script(operatorDeployment!.contracts.recurringPolicy, "0x")
    : script(deployment.contracts["recurring-policy"], "0x");
  if (!outputMatches(output, { ...output, lock: expectedLock, type: expectedPolicy })) {
    throw new Error("recurring creation uses an unexpected script deployment");
  }
  const payloadHex = witnessOutputType(witness);
  if (!payloadHex) throw new Error("recurring creation is missing its payload witness");
  const job = JobDataV1.unpack(hexToBytes(data));
  const committedPayload = hexToBytes(payloadHex);
  const operatorPayload = usesOperatorPolicy ? unpackOperatorPayload(committedPayload) : undefined;
  const recurringPayloadBytes = operatorPayload?.applicationPayload ?? committedPayload;
  const payload = RecurringPayloadV1.unpack(recurringPayloadBytes);
  const policyScriptHash = parseHash32(scriptToHash(expectedPolicy));
  const payloadHash = hash32FromBytes(
    usesOperatorPolicy
      ? deriveOperatorPayloadHash(hash32ToBytes(policyScriptHash), committedPayload)
      : deriveRecurringPayloadHash(hash32ToBytes(policyScriptHash), committedPayload),
  );
  const jobPolicyHash = hash32FromBytes(Uint8Array.from(job.policy_script_hash));
  const jobPayloadHash = hash32FromBytes(Uint8Array.from(job.payload_hash));
  if (jobPolicyHash !== policyScriptHash || jobPayloadHash !== payloadHash) {
    throw new Error("recurring creation data does not match its policy commitment");
  }
  const ownerLockHash = hash32FromBytes(Uint8Array.from(payload.owner_lock_hash));
  const recipientLockHash = hash32FromBytes(Uint8Array.from(payload.recipient_lock_hash));
  const amount = BigInt(payload.amount.toString());
  const intervalBlocks = BigInt(payload.interval_blocks.toString());
  const firstNotBefore = BigInt(payload.first_not_before.toString());
  const totalRuns = BigInt(payload.total_runs.toString());
  const reward = BigInt(payload.reward.toString());
  const remainingBudget = (amount + reward) * totalRuns;
  const decodedSchedule: RecurringSchedule = {
    amount: parseShannons(amount),
    intervalBlocks: parseBlockNumber(intervalBlocks),
    firstNotBefore: parseBlockNumber(firstNotBefore),
    totalRuns: parseRunCount(totalRuns),
    finalRefundKind: Number(payload.final_refund_kind),
  };
  validateLastRun(decodedSchedule);
  const triggerParamsHash = hash32FromBytes(Uint8Array.from(job.trigger_params_hash));
  const expectedTriggerHash = hash32FromBytes(
    deriveAbsoluteBlockTriggerHash(parseBlockNumber(firstNotBefore)),
  );
  if (
    Number(payload.version.toString()) !== 1 ||
    Number(payload.final_refund_kind) !== 0 ||
    Number(job.version.toString()) !== 1 ||
    BigInt(job.flags.toString()) !== 0n ||
    BigInt(job.sequence.toString()) !== 0n ||
    Number(job.state) !== 0 ||
    Number(job.trigger_kind.toString()) !== ABSOLUTE_BLOCK_TRIGGER_KIND ||
    !isValidRecurringSchedule(decodedSchedule) ||
    amount < CONTRACT_CAPACITY.plainWalletCell ||
    reward < CONTRACT_CAPACITY.plainWalletCell ||
    triggerParamsHash !== expectedTriggerHash ||
    ownerLockHash !== hash32FromBytes(Uint8Array.from(job.cancel_lock_hash)) ||
    reward !== BigInt(job.reward.toString()) ||
    firstNotBefore !== BigInt(job.not_before.toString()) ||
    (usesOperatorPolicy
      ? operatorTakeoverBlock(firstNotBefore, operatorPayload!.selection.takeoverDelayBlocks) !==
        BigInt(job.not_after.toString())
      : BigInt(job.not_after.toString()) !== 0n) ||
    totalRuns !== BigInt(job.remaining_runs.toString()) ||
    remainingBudget !== BigInt(job.remaining_budget.toString()) ||
    BigInt(output.capacity) !== CONTRACT_CAPACITY.jobCellV1 + remainingBudget
  ) {
    throw new Error("recurring creation contains inconsistent display fields");
  }
  return Object.freeze({
    kind: "recurring",
    jobId: hash32FromBytes(Uint8Array.from(job.job_id)),
    ownerLockHash,
    recipientLockHash,
    amount: amount.toString(),
    intervalBlocks: intervalBlocks.toString(),
    firstNotBefore: firstNotBefore.toString(),
    totalRuns: totalRuns.toString(),
    reward: reward.toString(),
    finalRefund: "owner",
    policyScriptHash,
    payloadHash,
    ...(operatorPayload === undefined
      ? {}
      : {
          preferredExecutorLockHash: operatorPayload.selection.preferredExecutorLockHash,
          takeoverBlock: BigInt(job.not_after.toString()).toString(),
        }),
  });
}
