import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
} from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  hash32FromBytes,
  parseHash32,
  parseShannons,
  sameCellDepValue,
  type Hash32,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";
import type {
  UnsignedCellInput,
  UnsignedCellOutput,
  UnsignedDeadlineTransaction,
} from "./deadline-creation.ts";
import type { CellDepIdentity } from "./job-inspection.ts";
import {
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_VERSION,
  assertDaoHarvestV2WitnessLayout,
  decodeDaoHarvestV2FallbackOperatorProof,
  deriveDaoHarvestV2IntentHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  type DaoHarvestV2Operation,
  type DaoHarvestV2WitnessIndices,
} from "./dao-harvest-v2.ts";

type Hex = `0x${string}`;

export interface DaoHarvestV2EconomicsInput {
  readonly originalAmount: IntegerInput;
  readonly expectedCompensation: IntegerInput;
  readonly prepareServiceCharge: IntegerInput;
  readonly claimServiceCharge: IntegerInput;
  readonly maximumNetworkFee: IntegerInput;
  readonly recoverableReserve: IntegerInput;
  readonly accumulatedCompensation: IntegerInput;
  readonly totalLockedAmount: IntegerInput;
}

export interface DaoHarvestV2Review {
  readonly originalAmount: Shannons;
  readonly expectedCompensation: Shannons;
  readonly completedWorkCharges: {
    readonly prepare: Shannons;
    readonly claim: Shannons;
    readonly maximumTotal: Shannons;
  };
  readonly maximumNetworkFee: Shannons;
  readonly recoverableReserve: Shannons;
  readonly accumulatedCompensation: Shannons;
  readonly totalLockedAmount: Shannons;
  readonly notes: readonly string[];
}

export interface DaoHarvestV2BuilderInput {
  readonly operation: DaoHarvestV2Operation;
  readonly policyScriptHash: Hash32;
  readonly payload: Uint8Array;
  readonly progress: Uint8Array;
  readonly prepareCredit?: Uint8Array;
  readonly operatorProof?: Uint8Array;
  readonly successorPayload?: Uint8Array;
  readonly indices: DaoHarvestV2WitnessIndices;
  readonly cellDeps: readonly CellDepIdentity[];
  readonly headerDeps: readonly Hash32[];
  readonly inputs: readonly UnsignedCellInput[];
  readonly inputCapacities: readonly IntegerInput[];
  readonly outputs: readonly UnsignedCellOutput[];
  readonly outputsData: readonly Hex[];
  readonly allowedFundingLockHashes: readonly Hash32[];
  readonly economics: DaoHarvestV2EconomicsInput;
}

export interface DaoHarvestV2Build {
  readonly operation: DaoHarvestV2Operation;
  readonly transaction: UnsignedDeadlineTransaction;
  readonly intentHash: Hash32;
  readonly payloadHash: Hash32;
  readonly progressHash: Hash32;
  readonly prepareCreditHash: Hash32;
  readonly review: DaoHarvestV2Review;
  readonly completion: {
    readonly requiredInputCount: number;
    readonly requiredOutputCount: number;
    readonly requiredInputCapacity: Shannons;
    readonly maximumFee: Shannons;
    readonly allowedFundingLockHashes: readonly Hash32[];
  };
}

export interface ResolvedDaoHarvestV2FundingInput {
  readonly outPoint: UnsignedCellInput["previousOutput"];
  readonly capacity: IntegerInput;
  readonly lockHash: Hash32;
}

function freezeReview(input: DaoHarvestV2EconomicsInput): DaoHarvestV2Review {
  const originalAmount = parseShannons(input.originalAmount);
  const expectedCompensation = parseShannons(input.expectedCompensation);
  const prepare = parseShannons(input.prepareServiceCharge);
  const claim = parseShannons(input.claimServiceCharge);
  const maximumTotal = parseShannons(prepare + claim);
  const maximumNetworkFee = parseShannons(input.maximumNetworkFee);
  const recoverableReserve = parseShannons(input.recoverableReserve);
  const accumulatedCompensation = parseShannons(input.accumulatedCompensation);
  const totalLockedAmount = parseShannons(input.totalLockedAmount);
  return Object.freeze({
    originalAmount,
    expectedCompensation,
    completedWorkCharges: Object.freeze({ prepare, claim, maximumTotal }),
    maximumNetworkFee,
    recoverableReserve,
    accumulatedCompensation,
    totalLockedAmount,
    notes: Object.freeze([
      "The original amount cannot pay service charges or network fees.",
      "A service charge is paid only for work completed on-chain and may be lower than the maximum.",
      "The recoverable reserve remains yours and returns on close or recovery.",
    ]),
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytes(value?: Uint8Array): Uint8Array {
  return value === undefined ? new Uint8Array() : Uint8Array.from(value);
}

function sum(values: readonly IntegerInput[]): Shannons {
  return parseShannons(values.reduce<bigint>((total, value) => total + parseShannons(value), 0n));
}

function assertLengths(input: DaoHarvestV2BuilderInput): void {
  if (input.inputs.length !== input.inputCapacities.length) {
    throw new RangeError("every reviewed input requires an exact capacity");
  }
  if (input.outputs.length !== input.outputsData.length) {
    throw new RangeError("reviewed outputs and output data lengths differ");
  }
  for (const [name, index] of Object.entries(input.indices)) {
    if (index === DAO_HARVEST_V2_ABSENT_INDEX) continue;
    const sourceLength = name.endsWith("InputIndex") ? input.inputs.length : input.outputs.length;
    if (index >= sourceLength)
      throw new RangeError(`${name} points outside the reviewed transaction`);
  }
  const inputKeys = input.inputs.map((cellInput) => outPointKey(cellInput.previousOutput));
  if (new Set(inputKeys).size !== inputKeys.length) {
    throw new RangeError("reviewed inputs contain a duplicate outpoint");
  }
}

function outputCapacity(outputs: readonly UnsignedCellOutput[]): Shannons {
  return parseShannons(
    outputs.reduce((total, output) => total + parseShannons(BigInt(output.capacity)), 0n),
  );
}

function assertReviewedEconomics(
  input: DaoHarvestV2BuilderInput,
  payload: ReturnType<typeof DaoHarvestPayloadV2.unpack>,
): void {
  const bindings = [
    [input.economics.originalAmount, payload.principal_capacity, "original amount"],
    [input.economics.prepareServiceCharge, payload.prepare_service_fee, "prepare service charge"],
    [input.economics.claimServiceCharge, payload.claim_service_fee, "claim service charge"],
    [input.economics.recoverableReserve, payload.compensation_seed_capacity, "recoverable reserve"],
    [input.economics.totalLockedAmount, outputCapacity(input.outputs), "total locked amount"],
  ] as const;
  for (const [reviewed, committed, name] of bindings) {
    if (parseShannons(reviewed) !== parseShannons(committed.toString())) {
      throw new RangeError(`${name} does not match the reviewed transaction`);
    }
  }
}

export function buildDaoHarvestV2Transaction(input: DaoHarvestV2BuilderInput): DaoHarvestV2Build {
  assertDaoHarvestV2WitnessLayout(input.operation, 0, input.indices);
  assertLengths(input);
  const payloadValue = DaoHarvestPayloadV2.unpack(input.payload);
  const progressValue = DaoHarvestProgressV2.unpack(input.progress);
  const credit = bytes(input.prepareCredit);
  if (credit.length > 0) DaoHarvestPrepareCreditV2.unpack(credit);
  const proof = bytes(input.operatorProof);
  const successor = bytes(input.successorPayload);
  const creditRequired =
    [1, 2, 3, 4, 5].includes(input.operation) ||
    (input.operation === 9 && progressValue.state === 1);
  const proofRequired = [0, 2, 8].includes(input.operation);
  if (creditRequired === (credit.length === 0)) {
    throw new RangeError("operation has an invalid prepare credit envelope");
  }
  if (proofRequired === (proof.length === 0)) {
    throw new RangeError("operation has an invalid operator proof envelope");
  }
  if ((input.operation === 8) === (successor.length === 0)) {
    throw new RangeError("operation has an invalid successor payload envelope");
  }
  if (proof.length > 0) {
    const proofPayload =
      input.operation === 8 ? DaoHarvestPayloadV2.unpack(successor) : payloadValue;
    decodeDaoHarvestV2FallbackOperatorProof(
      proof,
      Uint8Array.from(proofPayload.fallback_prepare_executor_set_hash),
    );
  }
  assertReviewedEconomics(input, payloadValue);
  const policyScriptHash = parseHash32(input.policyScriptHash);
  const payloadHashBytes = deriveDaoHarvestV2PayloadHash(
    hexToBytes(policyScriptHash),
    input.payload,
  );
  const progressHashBytes = deriveDaoHarvestV2ProgressHash(input.progress);
  const creditHashBytes =
    credit.length === 0 ? new Uint8Array(32) : deriveDaoHarvestV2PrepareCreditHash(credit);
  const witness = DaoHarvestWitnessV2.pack({
    version: DAO_HARVEST_V2_VERSION,
    operation: input.operation,
    flags: 0,
    job_input_index: input.indices.jobInputIndex,
    vault_input_index: input.indices.vaultInputIndex,
    compensation_input_index: input.indices.compensationInputIndex,
    identity_input_index: input.indices.identityInputIndex,
    prepare_accumulator_input_index: input.indices.prepareAccumulatorInputIndex,
    claim_accumulator_input_index: input.indices.claimAccumulatorInputIndex,
    job_output_index: input.indices.jobOutputIndex,
    vault_output_index: input.indices.vaultOutputIndex,
    compensation_output_index: input.indices.compensationOutputIndex,
    prepare_accumulator_output_index: input.indices.prepareAccumulatorOutputIndex,
    claim_accumulator_output_index: input.indices.claimAccumulatorOutputIndex,
    payload_hash: [...payloadHashBytes],
    progress_hash: [...progressHashBytes],
    prepare_credit_hash: [...creditHashBytes],
  });
  const envelope = DaoHarvestEnvelopeV2.pack({
    payload: [...input.payload],
    progress: [...input.progress],
    prepare_credit: [...credit],
    operator_proof: [...proof],
    successor_payload: [...successor],
  });
  const transaction = Object.freeze<UnsignedDeadlineTransaction>({
    version: "0x0",
    cellDeps: Object.freeze([...input.cellDeps]),
    headerDeps: Object.freeze(input.headerDeps.map(parseHash32)),
    inputs: Object.freeze([...input.inputs]),
    outputs: Object.freeze([...input.outputs]),
    outputsData: Object.freeze([...input.outputsData]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: "",
        inputType: bytesToHex(witness),
        outputType: bytesToHex(envelope),
      }) as Hex,
    ]),
  });
  const review = freezeReview(input.economics);
  const normalizedIntent = {
    operation: input.operation,
    policyScriptHash,
    payloadHash: hash32FromBytes(payloadHashBytes),
    progressHash: hash32FromBytes(progressHashBytes),
    prepareCreditHash: hash32FromBytes(creditHashBytes),
    transaction,
    review: {
      originalAmount: review.originalAmount.toString(),
      expectedCompensation: review.expectedCompensation.toString(),
      prepareCharge: review.completedWorkCharges.prepare.toString(),
      claimCharge: review.completedWorkCharges.claim.toString(),
      maximumNetworkFee: review.maximumNetworkFee.toString(),
      recoverableReserve: review.recoverableReserve.toString(),
      accumulatedCompensation: review.accumulatedCompensation.toString(),
      totalLockedAmount: review.totalLockedAmount.toString(),
    },
  };
  const intentHash = hash32FromBytes(
    deriveDaoHarvestV2IntentHash(new TextEncoder().encode(stable(normalizedIntent))),
  );
  return Object.freeze({
    operation: input.operation,
    transaction,
    intentHash,
    payloadHash: normalizedIntent.payloadHash,
    progressHash: normalizedIntent.progressHash,
    prepareCreditHash: normalizedIntent.prepareCreditHash,
    review,
    completion: Object.freeze({
      requiredInputCount: transaction.inputs.length,
      requiredOutputCount: transaction.outputs.length,
      requiredInputCapacity: sum(input.inputCapacities),
      maximumFee: review.maximumNetworkFee,
      allowedFundingLockHashes: Object.freeze(input.allowedFundingLockHashes.map(parseHash32)),
    }),
  });
}

function sameInput(left: UnsignedCellInput, right: UnsignedCellInput): boolean {
  return stable(left) === stable(right);
}

function outPointKey(value: UnsignedCellInput["previousOutput"]): string {
  return `${value.txHash}:${BigInt(value.index).toString()}`;
}

export function verifyCompletedDaoHarvestV2Transaction(
  build: DaoHarvestV2Build,
  completed: UnsignedDeadlineTransaction,
  fundingInputs: readonly ResolvedDaoHarvestV2FundingInput[],
): { readonly fee: Shannons; readonly addedInputCapacity: Shannons } {
  if (completed.version !== build.transaction.version)
    throw new Error("wallet changed the version");
  if (stable(completed.headerDeps) !== stable(build.transaction.headerDeps)) {
    throw new Error("wallet changed reviewed header dependencies");
  }
  if (
    completed.cellDeps.length !== build.transaction.cellDeps.length ||
    !build.transaction.cellDeps.every((dep, index) =>
      sameCellDepValue(dep, completed.cellDeps[index]!),
    )
  ) {
    throw new Error("wallet changed reviewed cell dependencies");
  }
  if (completed.inputs.length < build.completion.requiredInputCount) {
    throw new Error("wallet removed a reviewed input");
  }
  build.transaction.inputs.forEach((required, index) => {
    if (!sameInput(required, completed.inputs[index]!)) {
      throw new Error(`wallet changed reviewed input ${index}`);
    }
  });
  if (completed.outputs.length < build.completion.requiredOutputCount) {
    throw new Error("wallet removed a reviewed output");
  }
  if (completed.outputs.length !== completed.outputsData.length) {
    throw new Error("wallet returned mismatched outputs and data");
  }
  build.transaction.outputs.forEach((required, index) => {
    if (
      stable(required) !== stable(completed.outputs[index]) ||
      build.transaction.outputsData[index] !== completed.outputsData[index]
    ) {
      throw new Error(`wallet changed reviewed output ${index}`);
    }
  });
  build.transaction.witnesses.forEach((required, index) => {
    if (completed.witnesses[index] !== required) {
      throw new Error(`wallet changed reviewed witness ${index}`);
    }
  });
  const allowed = new Set(build.completion.allowedFundingLockHashes);
  const resolved = new Map<string, ResolvedDaoHarvestV2FundingInput>();
  for (const input of fundingInputs) {
    const key = outPointKey(input.outPoint);
    if (resolved.has(key))
      throw new Error("funding input resolutions contain a duplicate outpoint");
    resolved.set(key, input);
  }
  const consumed = new Set(
    build.transaction.inputs.map((input) => outPointKey(input.previousOutput)),
  );
  let addedInputCapacity = 0n;
  for (const input of completed.inputs.slice(build.completion.requiredInputCount)) {
    const key = outPointKey(input.previousOutput);
    if (consumed.has(key)) throw new Error("wallet duplicated an input outpoint");
    consumed.add(key);
    const cell = resolved.get(key);
    if (!cell || !allowed.has(parseHash32(cell.lockHash))) {
      throw new Error("wallet added an input outside the reviewed funding locks");
    }
    addedInputCapacity += parseShannons(cell.capacity);
  }
  for (
    let index = build.completion.requiredOutputCount;
    index < completed.outputs.length;
    index += 1
  ) {
    const output = completed.outputs[index]!;
    if (
      output.type !== null ||
      completed.outputsData[index] !== "0x" ||
      !allowed.has(parseHash32(scriptToHash(output.lock)))
    ) {
      throw new Error("wallet added a non-plain or unreviewed change output");
    }
  }
  const totalInput = build.completion.requiredInputCapacity + addedInputCapacity;
  const totalOutput = outputCapacity(completed.outputs);
  if (totalOutput > totalInput) throw new Error("wallet outputs exceed resolved inputs");
  const fee = parseShannons(totalInput - totalOutput);
  if (fee > build.completion.maximumFee) throw new Error("wallet fee exceeds the reviewed maximum");
  return Object.freeze({ fee, addedInputCapacity: parseShannons(addedInputCapacity) });
}

export const absentDaoHarvestV2Indices = (): DaoHarvestV2WitnessIndices =>
  Object.freeze({
    jobInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    vaultInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    compensationInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    identityInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    prepareAccumulatorInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    claimAccumulatorInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    jobOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    vaultOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    compensationOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    prepareAccumulatorOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
    claimAccumulatorOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  });
