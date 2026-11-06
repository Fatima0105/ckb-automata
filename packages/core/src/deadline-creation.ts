import { CampaignDataV1, JobDataV1 } from "@ckb-automata/molecule";
import {
  PERSONAL,
  blake2b,
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  deriveCampaignId,
  deriveDeadlinePayloadHash,
  deriveRefundCommitment,
  encodeOutPoint,
  isAbsoluteBlockDeadline,
} from "./campaign.ts";
import {
  hash32FromBytes,
  hash32ToBytes,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseSequence,
  parseShannons,
  sameCellDepValue,
  toRpcHex,
  uint64ToLittleEndian,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type Shannons,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";
import type { CellDepIdentity, ScriptIdentity } from "./job-inspection.ts";
import { deriveJobId } from "./job-identity.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import type { OperatorAutomationDeployment } from "./operator-deployment.ts";
import {
  deriveOperatorPayloadHash,
  normalizeOperatorSelection,
  operatorTakeoverBlock,
  packOperatorPayload,
} from "./operator-selection.ts";
import { calculateDeadlineQuote, type DeadlineQuote, type FeeRangeInput } from "./quotes.ts";
import { ABSOLUTE_BLOCK_TRIGGER_KIND, deriveAbsoluteBlockTriggerHash } from "./triggers.ts";

export const DEADLINE_CREATION_INTENT_DOMAIN = "ckb-automata/deadline-creation-intent/v1" as const;

type Hex = `0x${string}`;

export interface DeadlinePledgeInput {
  readonly outPoint: OutPoint;
  readonly refundLockHash: Hash32;
  readonly amount: IntegerInput;
}

export interface DeadlineCreationInput {
  readonly deployment: RegisteredDeployment;
  readonly pledges: readonly DeadlinePledgeInput[];
  readonly target: IntegerInput;
  readonly deadlineBlock: IntegerInput;
  readonly successLockHash: Hash32;
  readonly cancelLockHash: Hash32;
  readonly reward: IntegerInput;
  readonly creatorNonce: IntegerInput;
  readonly creationFee: FeeRangeInput;
  readonly operator?: {
    readonly deployment: OperatorAutomationDeployment;
    readonly preferredExecutorLockHash: Hash32;
    readonly takeoverDelayBlocks?: bigint;
  };
}

export interface UnsignedCellInput {
  readonly since: Hex;
  readonly previousOutput: { readonly txHash: Hash32; readonly index: Hex };
}

export interface UnsignedCellOutput {
  readonly capacity: Hex;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
}

export interface UnsignedDeadlineTransaction {
  readonly version: "0x0";
  readonly cellDeps: readonly CellDepIdentity[];
  readonly headerDeps: readonly Hash32[];
  readonly inputs: readonly UnsignedCellInput[];
  readonly outputs: readonly UnsignedCellOutput[];
  readonly outputsData: readonly Hex[];
  readonly witnesses: readonly Hex[];
}

export interface NormalizedDeadlineIntent {
  readonly version: 1 | 2;
  readonly genesisHash: Hash32;
  readonly deploymentManifestSha256: string;
  readonly anchorOutPoint: OutPoint;
  readonly campaignOutputIndex: 0;
  readonly jobOutputIndex: 1;
  readonly creatorNonce: string;
  readonly pledged: string;
  readonly pledgeCount: number;
  readonly target: string;
  readonly deadlineBlock: string;
  readonly successLockHash: Hash32;
  readonly refundCommitment: Hash32;
  readonly cancelLockHash: Hash32;
  readonly reward: string;
  readonly campaignCapacity: string;
  readonly jobCapacity: string;
  readonly campaignTypeHash: Hash32;
  readonly policyScriptHash: Hash32;
  readonly payloadHash: Hash32;
  readonly triggerParamsHash: Hash32;
  readonly pledgeRecords: Hex;
  readonly preferredExecutorLockHash?: Hash32;
  readonly takeoverBlock?: string;
  readonly operatorPayload?: Hex;
  readonly operatorDeploymentManifestSha256?: string;
}

export interface DeadlineCompletionContract {
  readonly requiredInputCount: number;
  readonly requiredOutputCount: 2;
  readonly requiredOutputType: Hex;
  readonly requiredInputType?: Hex;
  readonly maximumFee: Shannons;
  readonly rules: readonly [
    "preserve-required-input-prefix",
    "append-owner-inputs-only",
    "preserve-committed-output-prefix",
    "append-change-outputs-only",
    "preserve-first-witness-output-type",
  ];
}

export interface DeadlineCreationBuild {
  readonly transaction: UnsignedDeadlineTransaction;
  readonly intent: NormalizedDeadlineIntent;
  readonly intentBytes: Hex;
  readonly intentHash: Hash32;
  readonly campaignId: Hash32;
  readonly jobId: Hash32;
  readonly campaignData: Hex;
  readonly jobData: Hex;
  readonly quote: DeadlineQuote;
  readonly completion: DeadlineCompletionContract;
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
  const length = uint32(body.length);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(length);
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

function script(
  contract: { readonly script: Omit<ScriptIdentity, "args"> },
  args: Hex,
): ScriptIdentity {
  return Object.freeze({ ...contract.script, args });
}

function normalizedPledges(pledges: readonly DeadlinePledgeInput[]): readonly {
  readonly outPoint: OutPoint;
  readonly refundLockHash: Hash32;
  readonly amount: Shannons;
}[] {
  if (pledges.length === 0 || pledges.length > 0xffff_ffff) {
    throw new RangeError("deadline creation requires between 1 and uint32 pledges");
  }
  const normalized = pledges.map((pledge) => {
    const amount = parseShannons(pledge.amount);
    if (amount < CONTRACT_CAPACITY.plainWalletCell) {
      throw new RangeError("each pledge must fund a future plain refund output");
    }
    const refundLockHash = parseHash32(pledge.refundLockHash);
    if (/^0x0{64}$/.test(refundLockHash)) {
      throw new RangeError("refundLockHash must not be zero");
    }
    return Object.freeze({
      outPoint: parseOutPoint(pledge.outPoint),
      refundLockHash,
      amount,
    });
  });
  normalized.sort((left, right) => {
    const hashOrder = left.outPoint.txHash.localeCompare(right.outPoint.txHash);
    return hashOrder === 0 ? Number(left.outPoint.index - right.outPoint.index) : hashOrder;
  });
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (!previous || !current) throw new Error("missing normalized pledge");
    if (
      previous?.outPoint.txHash === current?.outPoint.txHash &&
      previous.outPoint.index === current.outPoint.index
    ) {
      throw new Error("pledge outpoints must be unique");
    }
  }
  return Object.freeze(normalized);
}

function pledgeRecords(
  pledges: readonly {
    readonly outPoint: OutPoint;
    readonly refundLockHash: Hash32;
    readonly amount: Shannons;
  }[],
): Uint8Array {
  return concatenate(
    ...pledges.map((pledge) =>
      concatenate(
        encodeOutPoint(pledge.outPoint),
        hash32ToBytes(pledge.refundLockHash),
        uint64ToLittleEndian(pledge.amount),
      ),
    ),
  );
}

function intentBody(intent: NormalizedDeadlineIntent): Uint8Array {
  const digest = intent.deploymentManifestSha256;
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError("deployment manifest digest must be a lowercase SHA-256 value");
  }
  const base = concatenate(
    hash32ToBytes(intent.genesisHash),
    hexToBytes(`0x${digest}`),
    encodeOutPoint(intent.anchorOutPoint),
    uint32(intent.campaignOutputIndex),
    uint32(intent.jobOutputIndex),
    uint64ToLittleEndian(parseSequence(intent.creatorNonce)),
    uint64ToLittleEndian(parseShannons(intent.pledged)),
    uint32(intent.pledgeCount),
    uint64ToLittleEndian(parseShannons(intent.target)),
    uint64ToLittleEndian(parseBlockNumber(intent.deadlineBlock)),
    hash32ToBytes(intent.successLockHash),
    hash32ToBytes(intent.refundCommitment),
    hash32ToBytes(intent.cancelLockHash),
    uint64ToLittleEndian(parseShannons(intent.reward)),
    uint64ToLittleEndian(parseShannons(intent.campaignCapacity)),
    uint64ToLittleEndian(parseShannons(intent.jobCapacity)),
    hash32ToBytes(intent.campaignTypeHash),
    hash32ToBytes(intent.policyScriptHash),
    hash32ToBytes(intent.payloadHash),
    hash32ToBytes(intent.triggerParamsHash),
    uint32(hexToBytes(intent.pledgeRecords).length),
    hexToBytes(intent.pledgeRecords),
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

function freezeIntent(intent: NormalizedDeadlineIntent): NormalizedDeadlineIntent {
  Object.freeze(intent.anchorOutPoint);
  return Object.freeze(intent);
}

function requireNonzeroHash(value: Hash32, name: string): Hash32 {
  const hash = parseHash32(value);
  if (/^0x0{64}$/.test(hash)) throw new RangeError(`${name} must not be zero`);
  return hash;
}

export function buildDeadlineCreation(input: DeadlineCreationInput): DeadlineCreationBuild {
  const pledges = normalizedPledges(input.pledges);
  const records = pledgeRecords(pledges);
  const pledged = parseShannons(pledges.reduce((total, pledge) => total + pledge.amount, 0n));
  const target = parseShannons(input.target);
  if (target === 0n) throw new RangeError("target must be greater than zero");
  const deadlineBlock = parseBlockNumber(input.deadlineBlock);
  if (!isAbsoluteBlockDeadline(deadlineBlock)) {
    throw new RangeError("deadlineBlock must be a non-zero absolute block number");
  }
  const reward = parseShannons(input.reward);
  const creatorNonce = parseSequence(input.creatorNonce);
  const successLockHash = requireNonzeroHash(input.successLockHash, "successLockHash");
  const cancelLockHash = requireNonzeroHash(input.cancelLockHash, "cancelLockHash");
  if (successLockHash === cancelLockHash) {
    throw new RangeError("recipient address must differ from the recovery address");
  }
  const quote = calculateDeadlineQuote({
    pledgedAmount: pledged,
    reward,
    creationFee: input.creationFee,
  });

  const anchorOutPoint = pledges[0]?.outPoint;
  if (!anchorOutPoint) throw new Error("missing normalized pledge anchor");
  const campaignIdBytes = deriveCampaignId(anchorOutPoint, parseOutputIndex(0n));
  const campaignId = hash32FromBytes(campaignIdBytes);
  const campaignType = script(input.deployment.contracts["demo-campaign-type"], campaignId as Hex);
  const campaignTypeHash = parseHash32(scriptToHash(campaignType));
  const operator = input.operator;
  const policyContract = operator?.deployment.contracts.deadlinePolicy;
  const policyScript = script(
    policyContract ?? input.deployment.contracts["deadline-policy"],
    campaignTypeHash as Hex,
  );
  const policyScriptHash = parseHash32(scriptToHash(policyScript));
  const applicationPayload = concatenate(Uint8Array.of(1), hash32ToBytes(campaignTypeHash));
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
    selection === undefined ? undefined : packOperatorPayload(selection, applicationPayload);
  const payloadHash = hash32FromBytes(
    operatorPayloadBytes === undefined
      ? deriveDeadlinePayloadHash(policyScriptHash, campaignTypeHash)
      : deriveOperatorPayloadHash(hash32ToBytes(policyScriptHash), operatorPayloadBytes),
  );
  const takeoverBlock =
    selection === undefined
      ? undefined
      : operatorTakeoverBlock(deadlineBlock, selection.takeoverDelayBlocks);
  const triggerParamsHash = hash32FromBytes(deriveAbsoluteBlockTriggerHash(deadlineBlock));
  const refundCommitment = hash32FromBytes(deriveRefundCommitment(pledges.length, records));
  const campaignCapacity = quote.occupiedCapacity.applicationCell + pledged;
  const jobCapacity = quote.occupiedCapacity.jobCell + reward;
  const normalizedIntent = freezeIntent({
    version: operator === undefined ? 1 : 2,
    genesisHash: input.deployment.genesisHash,
    deploymentManifestSha256: input.deployment.manifestSha256,
    anchorOutPoint,
    campaignOutputIndex: 0,
    jobOutputIndex: 1,
    creatorNonce: creatorNonce.toString(),
    pledged: pledged.toString(),
    pledgeCount: pledges.length,
    target: target.toString(),
    deadlineBlock: deadlineBlock.toString(),
    successLockHash,
    refundCommitment,
    cancelLockHash,
    reward: reward.toString(),
    campaignCapacity: campaignCapacity.toString(),
    jobCapacity: jobCapacity.toString(),
    campaignTypeHash,
    policyScriptHash,
    payloadHash,
    triggerParamsHash,
    pledgeRecords: bytesToHex(records) as Hex,
    ...(selection === undefined || takeoverBlock === undefined || operatorPayloadBytes === undefined
      ? {}
      : {
          preferredExecutorLockHash: selection.preferredExecutorLockHash,
          takeoverBlock: takeoverBlock.toString(),
          operatorPayload: bytesToHex(operatorPayloadBytes) as Hex,
          operatorDeploymentManifestSha256: operator!.deployment.manifestSha256,
        }),
  });
  const encodedIntent = intentBody(normalizedIntent);
  const intentHashBytes = protocolHash(DEADLINE_CREATION_INTENT_DOMAIN, encodedIntent);
  const intentHash = hash32FromBytes(intentHashBytes);
  const jobIdBytes = deriveJobId({
    genesisHash: hash32ToBytes(input.deployment.genesisHash),
    protocolVersion: operator === undefined ? 1 : 2,
    creationCommitment: intentHashBytes,
    anchor: { kind: "output_index", outputIndex: 1n },
    creatorNonce,
    policyScriptHash: hash32ToBytes(policyScriptHash),
  });
  const jobId = hash32FromBytes(jobIdBytes);
  const campaignDataBytes = CampaignDataV1.pack({
    version: 1,
    state: 0,
    campaign_id: [...campaignIdBytes],
    pledged: pledged.toString(),
    pledge_count: pledges.length,
    target: target.toString(),
    deadline_since: deadlineBlock.toString(),
    success_lock_hash: [...hash32ToBytes(successLockHash)],
    refund_commitment: [...hash32ToBytes(refundCommitment)],
  });
  const jobDataBytes = JobDataV1.pack({
    version: 1,
    flags: 0,
    job_id: [...jobIdBytes],
    sequence: "0",
    state: 0,
    trigger_kind: ABSOLUTE_BLOCK_TRIGGER_KIND,
    trigger_params_hash: [...hash32ToBytes(triggerParamsHash)],
    policy_script_hash: [...hash32ToBytes(policyScriptHash)],
    payload_hash: [...hash32ToBytes(payloadHash)],
    reward: reward.toString(),
    remaining_budget: reward.toString(),
    not_before: deadlineBlock.toString(),
    not_after: takeoverBlock?.toString() ?? "0",
    remaining_runs: 1,
    cancel_lock_hash: [...hash32ToBytes(cancelLockHash)],
  });
  const campaignLock = script(input.deployment.contracts["campaign-lock"], "0x");
  const jobLock = script(
    operator?.deployment.contracts.jobLock ?? input.deployment.contracts["job-lock"],
    "0x",
  );
  const transaction: UnsignedDeadlineTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      operator?.deployment.secp256k1Blake160.cellDep ??
        input.deployment.manifest.secp256k1Blake160.cellDep,
      operator?.deployment.contracts.jobLock.cellDep ??
        input.deployment.contracts["job-lock"].cellDep,
      operator?.deployment.contracts.deadlinePolicy.cellDep ??
        input.deployment.contracts["deadline-policy"].cellDep,
      input.deployment.contracts["demo-campaign-type"].cellDep,
      input.deployment.contracts["campaign-lock"].cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze(
      pledges.map((pledge) =>
        Object.freeze({
          since: "0x0" as const,
          previousOutput: Object.freeze({
            txHash: pledge.outPoint.txHash,
            index: toRpcHex(pledge.outPoint.index),
          }),
        }),
      ),
    ),
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(parseShannons(campaignCapacity)),
        lock: campaignLock,
        type: campaignType,
      }),
      Object.freeze({
        capacity: toRpcHex(parseShannons(jobCapacity)),
        lock: jobLock,
        type: policyScript,
      }),
    ]),
    outputsData: Object.freeze([
      bytesToHex(campaignDataBytes) as Hex,
      bytesToHex(jobDataBytes) as Hex,
    ]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: "",
        inputType: operatorPayloadBytes === undefined ? "" : bytesToHex(operatorPayloadBytes),
        outputType: bytesToHex(records),
      }) as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    intent: normalizedIntent,
    intentBytes: bytesToHex(encodedIntent) as Hex,
    intentHash,
    campaignId,
    jobId,
    campaignData: bytesToHex(campaignDataBytes) as Hex,
    jobData: bytesToHex(jobDataBytes) as Hex,
    quote,
    completion: Object.freeze({
      requiredInputCount: transaction.inputs.length,
      requiredOutputCount: 2,
      requiredOutputType: bytesToHex(records) as Hex,
      ...(operatorPayloadBytes === undefined
        ? {}
        : { requiredInputType: bytesToHex(operatorPayloadBytes) as Hex }),
      maximumFee: quote.estimatedFee.maximum,
      rules: Object.freeze([
        "preserve-required-input-prefix",
        "append-owner-inputs-only",
        "preserve-committed-output-prefix",
        "append-change-outputs-only",
        "preserve-first-witness-output-type",
      ] as const),
    }),
  });
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sameInput(
  left: UnsignedDeadlineTransaction["inputs"][number],
  right: UnsignedDeadlineTransaction["inputs"][number],
): boolean {
  return (
    left.previousOutput.txHash === right.previousOutput.txHash &&
    BigInt(left.previousOutput.index) === BigInt(right.previousOutput.index) &&
    BigInt(left.since) === BigInt(right.since)
  );
}

function witnessOutputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) throw new Error("completed witness 0 is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || outputOffset > total) {
    throw new Error("completed witness 0 has invalid Molecule offsets");
  }
  const field = bytes.slice(outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("completed witness 0 has an invalid output_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

function witnessInputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) throw new Error("completed witness 0 is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) {
    throw new Error("completed witness 0 has invalid Molecule offsets");
  }
  const field = bytes.slice(inputOffset, outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("completed witness 0 has an invalid input_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

export function assertDeadlineCompletion(
  build: DeadlineCreationBuild,
  completed: UnsignedDeadlineTransaction,
): void {
  if (
    completed.version !== build.transaction.version ||
    stable(completed.headerDeps) !== stable(build.transaction.headerDeps)
  ) {
    throw new Error("wallet completion changed transaction metadata");
  }
  if (completed.inputs.length < build.completion.requiredInputCount) {
    throw new Error("wallet completion removed required inputs");
  }
  for (let index = 0; index < build.completion.requiredInputCount; index += 1) {
    const required = build.transaction.inputs[index];
    const actual = completed.inputs[index];
    if (!required || !actual || !sameInput(actual, required)) {
      throw new Error(
        `wallet completion changed required input outpoint or since at index ${index}`,
      );
    }
  }
  if (completed.outputs.length < build.completion.requiredOutputCount) {
    throw new Error("wallet completion removed committed outputs");
  }
  for (let index = 0; index < build.completion.requiredOutputCount; index += 1) {
    if (
      stable(completed.outputs[index]) !== stable(build.transaction.outputs[index]) ||
      completed.outputsData[index] !== build.transaction.outputsData[index]
    ) {
      throw new Error(`wallet completion changed committed output ${index}`);
    }
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
    throw new Error("wallet completion changed the pledge records in witness 0");
  }
  if (
    build.completion.requiredInputType !== undefined &&
    witnessInputType(firstWitness) !== build.completion.requiredInputType
  ) {
    throw new Error("wallet completion changed the operator policy in witness 0");
  }
}
