import {
  addEpochFractions,
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  encodeAbsoluteEpochSince,
  parseEpoch,
  parseHash32,
  parseSequence,
  parseShannons,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type Shannons,
} from "@ckb-automata/core";

export const DAO_HARVEST_V2_ADAPTER_ID = "dao-harvest-v2" as const;
export const DAO_HARVEST_V1_ADAPTER_ID = "dao-harvest-v1" as const;
export const DAO_HARVEST_V2_MIN_WAKE_DELAY_MS = 1_000;
export const DAO_HARVEST_V2_MAX_WAKE_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

export type DaoHarvestAdapterId =
  typeof DAO_HARVEST_V1_ADAPTER_ID | typeof DAO_HARVEST_V2_ADAPTER_ID;
export type DaoHarvestV2Operation =
  "preferred_prepare" | "fallback_prepare" | "preferred_claim" | "fallback_claim";

export class DaoHarvestV2SafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DaoHarvestV2SafetyError";
    this.code = code;
  }
}

export function daoHarvestAdapterId(version: IntegerInput): DaoHarvestAdapterId {
  const parsed = parseSequence(version);
  if (parsed === 1n) return DAO_HARVEST_V1_ADAPTER_ID;
  if (parsed === 2n) return DAO_HARVEST_V2_ADAPTER_ID;
  throw new RangeError("DAO harvest policy version is unsupported");
}

export interface DaoHarvestV2ScheduleRecord {
  readonly jobId: Hash32;
  readonly sequence: IntegerInput;
  readonly state: "deposited" | "withdrawing";
  readonly cycleIndex: IntegerInput;
  readonly totalCycles: IntegerInput;
  readonly live: boolean;
  readonly canonical: boolean;
  readonly notBeforeSince: IntegerInput;
  readonly prepareCutoffSince: IntegerInput | null;
  readonly takeoverDelaySince: IntegerInput;
  readonly endEpochSince: IntegerInput;
  readonly preferredPrepareOperatorLockHash: Hash32;
  readonly creditedPrepareOperatorLockHash: Hash32 | null;
  readonly fallbackPrepareOperatorLockHashes: readonly Hash32[];
}

export type DaoHarvestV2ScheduleDecision =
  | {
      readonly status: "ready";
      readonly operation: DaoHarvestV2Operation;
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly cycleIndex: string;
    }
  | {
      readonly status: "waiting";
      readonly operation: DaoHarvestV2Operation;
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly cycleIndex: string;
      readonly notBefore: string;
      readonly delayMs: number;
      readonly reason: "early" | "preferred_window" | "reorg_recovery";
    }
  | {
      readonly status: "unavailable";
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly cycleIndex: string;
      readonly reason: "not_an_approved_operator" | "missed_prepare_window";
    }
  | {
      readonly status: "terminal";
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly cycleIndex: string;
      readonly reason: "spent" | "cycle_limit" | "end_epoch_reached";
    };

function wakeDelay(
  target: ReturnType<typeof decodeAbsoluteEpochSince>,
  tip: ReturnType<typeof parseEpoch>,
): number {
  if (compareEpochFractions(tip, target) >= 0) return DAO_HARVEST_V2_MIN_WAKE_DELAY_MS;
  const wholeEpochs = target.number - tip.number;
  const estimate = wholeEpochs <= 0n ? 60_000n : wholeEpochs * 4n * 60n * 60n * 1_000n;
  return Number(
    estimate > BigInt(DAO_HARVEST_V2_MAX_WAKE_DELAY_MS)
      ? DAO_HARVEST_V2_MAX_WAKE_DELAY_MS
      : estimate < BigInt(DAO_HARVEST_V2_MIN_WAKE_DELAY_MS)
        ? DAO_HARVEST_V2_MIN_WAKE_DELAY_MS
        : estimate,
  );
}

function validateSchedule(record: DaoHarvestV2ScheduleRecord) {
  const jobId = parseHash32(record.jobId);
  const sequence = parseSequence(record.sequence);
  const cycleIndex = parseSequence(record.cycleIndex);
  const totalCycles = parseSequence(record.totalCycles);
  const notBefore = decodeAbsoluteEpochSince(record.notBeforeSince);
  const takeover = addEpochFractions(
    notBefore,
    decodeRelativeEpochSince(record.takeoverDelaySince),
  );
  const end = parseSequence(record.endEpochSince);
  if (totalCycles === 0n || cycleIndex > totalCycles) {
    throw new RangeError("DAO harvest cycle counters are invalid");
  }
  const fallback = record.fallbackPrepareOperatorLockHashes.map(parseHash32);
  if (
    fallback.length === 0 ||
    fallback.length > 8 ||
    new Set(fallback).size !== fallback.length ||
    fallback.some((value, index) => index > 0 && fallback[index - 1]! >= value)
  ) {
    throw new RangeError("DAO harvest fallback operator set is invalid");
  }
  const cutoff =
    record.prepareCutoffSince === null ? null : decodeAbsoluteEpochSince(record.prepareCutoffSince);
  if (
    record.state === "deposited" &&
    (cutoff === null ||
      compareEpochFractions(notBefore, cutoff) >= 0 ||
      compareEpochFractions(takeover, cutoff) >= 0)
  ) {
    throw new RangeError("DAO harvest prepare window is invalid");
  }
  return Object.freeze({
    jobId,
    sequence,
    cycleIndex,
    totalCycles,
    notBefore,
    takeover,
    cutoff,
    end: end === 0n ? null : decodeAbsoluteEpochSince(end),
    preferred: parseHash32(record.preferredPrepareOperatorLockHash),
    credited:
      record.creditedPrepareOperatorLockHash === null
        ? null
        : parseHash32(record.creditedPrepareOperatorLockHash),
    fallback,
  });
}

export function evaluateDaoHarvestV2Schedule(
  record: DaoHarvestV2ScheduleRecord,
  tipEpochValue: IntegerInput,
  operatorLockHashValue: Hash32,
): DaoHarvestV2ScheduleDecision {
  const parsed = validateSchedule(record);
  const operator = parseHash32(operatorLockHashValue);
  const tip = parseEpoch(tipEpochValue);
  const base = Object.freeze({
    jobId: parsed.jobId,
    sequence: parsed.sequence.toString(),
    cycleIndex: parsed.cycleIndex.toString(),
  });
  if (!record.live) return Object.freeze({ status: "terminal", ...base, reason: "spent" });
  if (parsed.cycleIndex >= parsed.totalCycles) {
    return Object.freeze({ status: "terminal", ...base, reason: "cycle_limit" });
  }
  if (
    record.state === "deposited" &&
    parsed.end !== null &&
    compareEpochFractions(tip, parsed.end) >= 0
  ) {
    return Object.freeze({ status: "terminal", ...base, reason: "end_epoch_reached" });
  }

  const isPreferred =
    record.state === "deposited" ? operator === parsed.preferred : operator === parsed.credited;
  const isFallbackPrepare = parsed.fallback.includes(operator);
  const preferredOperation = record.state === "deposited" ? "preferred_prepare" : "preferred_claim";
  const fallbackOperation = record.state === "deposited" ? "fallback_prepare" : "fallback_claim";
  const operation = isPreferred ? preferredOperation : fallbackOperation;
  const target = isPreferred ? parsed.notBefore : parsed.takeover;

  if (!record.canonical) {
    return Object.freeze({
      status: "waiting",
      operation,
      ...base,
      notBefore: encodeAbsoluteEpochSince(target).toString(),
      delayMs: DAO_HARVEST_V2_MIN_WAKE_DELAY_MS,
      reason: "reorg_recovery",
    });
  }
  if (record.state === "deposited" && parsed.cutoff !== null) {
    if (compareEpochFractions(tip, parsed.cutoff) >= 0) {
      return Object.freeze({ status: "unavailable", ...base, reason: "missed_prepare_window" });
    }
    if (!isPreferred && !isFallbackPrepare) {
      return Object.freeze({
        status: "unavailable",
        ...base,
        reason: "not_an_approved_operator",
      });
    }
  }
  if (compareEpochFractions(tip, target) < 0) {
    return Object.freeze({
      status: "waiting",
      operation,
      ...base,
      notBefore: encodeAbsoluteEpochSince(target).toString(),
      delayMs: wakeDelay(target, tip),
      reason: isPreferred ? "early" : "preferred_window",
    });
  }
  return Object.freeze({ status: "ready", operation, ...base });
}

export interface DaoHarvestV2ExecutionEconomics {
  readonly signedTransactionBytes: number;
  readonly maximumSignedTransactionBytes: number;
  readonly feeRatePerKilobyte: IntegerInput;
  readonly minimumFeeRatePerKilobyte: IntegerInput;
  readonly maximumFeeRatePerKilobyte: IntegerInput;
  readonly maximumNetworkFee: IntegerInput;
  readonly expectedServicePayment: IntegerInput;
  readonly servicePaymentCap: IntegerInput;
  readonly minimumProfitMargin: IntegerInput;
}

export interface DaoHarvestV2DryRunEvidence {
  readonly cycles: IntegerInput;
  readonly maximumCycles: IntegerInput;
}

export interface DaoHarvestV2ExecutionPlan {
  readonly adapterId: typeof DAO_HARVEST_V2_ADAPTER_ID;
  readonly operation: DaoHarvestV2Operation;
  readonly queueKey: string;
  readonly jobId: Hash32;
  readonly sequence: string;
  readonly cycleIndex: string;
  readonly consumedInputs: readonly OutPoint[];
  readonly networkFee: Shannons;
  readonly expectedServicePayment: Shannons;
  readonly expectedMargin: Shannons;
  readonly dryRunCycles: string;
}

function positiveSafeInteger(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} is invalid`);
  return BigInt(value);
}

function outPointKey(value: OutPoint): string {
  return `${parseHash32(value.txHash)}/${parseSequence(value.index).toString()}`;
}

export function createDaoHarvestV2ExecutionPlan(input: {
  readonly adapterId: DaoHarvestAdapterId;
  readonly record: DaoHarvestV2ScheduleRecord;
  readonly tipEpoch: IntegerInput;
  readonly operatorLockHash: Hash32;
  readonly consumedInputs: readonly OutPoint[];
  readonly economics: DaoHarvestV2ExecutionEconomics;
  readonly dryRun: DaoHarvestV2DryRunEvidence;
}): DaoHarvestV2ExecutionPlan {
  if (input.adapterId !== DAO_HARVEST_V2_ADAPTER_ID) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_ADAPTER_MISMATCH",
      "a V1 adapter cannot execute a V2 harvest job",
    );
  }
  const decision = evaluateDaoHarvestV2Schedule(
    input.record,
    input.tipEpoch,
    input.operatorLockHash,
  );
  if (decision.status !== "ready") {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_NOT_YET_ELIGIBLE",
      `DAO harvest V2 execution is not ready (${decision.reason})`,
    );
  }
  if (input.consumedInputs.length < 3) {
    throw new RangeError("DAO harvest V2 execution must bind all state inputs");
  }
  const inputKeys = input.consumedInputs.map(outPointKey);
  if (new Set(inputKeys).size !== inputKeys.length) {
    throw new RangeError("DAO harvest V2 execution inputs must be unique");
  }

  const bytes = positiveSafeInteger(
    input.economics.signedTransactionBytes,
    "signed transaction size",
  );
  const maximumBytes = positiveSafeInteger(
    input.economics.maximumSignedTransactionBytes,
    "maximum signed transaction size",
  );
  if (bytes > maximumBytes) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_TRANSACTION_SIZE_EXCEEDED",
      "signed transaction exceeds the operation limit",
    );
  }
  const rate = parseShannons(input.economics.feeRatePerKilobyte);
  const minimumRate = parseShannons(input.economics.minimumFeeRatePerKilobyte);
  const maximumRate = parseShannons(input.economics.maximumFeeRatePerKilobyte);
  if (rate < minimumRate || rate > maximumRate) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_FEE_RATE_OUT_OF_RANGE",
      "network fee rate is outside the configured bounds",
    );
  }
  const networkFee = parseShannons((bytes * rate + 999n) / 1_000n);
  if (networkFee > parseShannons(input.economics.maximumNetworkFee)) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_FEE_MISMATCH",
      "network fee exceeds the operation limit",
    );
  }
  const payment = parseShannons(input.economics.expectedServicePayment);
  if (payment > parseShannons(input.economics.servicePaymentCap)) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_REWARD_INVALID",
      "expected service payment exceeds the committed cap",
    );
  }
  const minimumMargin = parseShannons(input.economics.minimumProfitMargin);
  if (payment < networkFee || payment - networkFee < minimumMargin) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_UNPROFITABLE",
      "available compensation does not cover the bounded fee and margin",
    );
  }
  const cycles = parseSequence(input.dryRun.cycles);
  const maximumCycles = parseSequence(input.dryRun.maximumCycles);
  if (maximumCycles === 0n || cycles > maximumCycles) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_CYCLE_LIMIT_EXCEEDED",
      "dry-run cycles exceed the operation limit",
    );
  }
  return Object.freeze({
    adapterId: DAO_HARVEST_V2_ADAPTER_ID,
    operation: decision.operation,
    queueKey: `v2/${decision.jobId}/${decision.cycleIndex}/${decision.operation}/${decision.sequence}`,
    jobId: decision.jobId,
    sequence: decision.sequence,
    cycleIndex: decision.cycleIndex,
    consumedInputs: Object.freeze([...input.consumedInputs]),
    networkFee,
    expectedServicePayment: payment,
    expectedMargin: parseShannons(payment - networkFee),
    dryRunCycles: cycles.toString(),
  });
}

export function validateDaoHarvestV2Reload(
  plan: DaoHarvestV2ExecutionPlan,
  input: {
    readonly record: DaoHarvestV2ScheduleRecord;
    readonly tipEpoch: IntegerInput;
    readonly operatorLockHash: Hash32;
    readonly consumedInputs: readonly OutPoint[];
  },
): void {
  const decision = evaluateDaoHarvestV2Schedule(
    input.record,
    input.tipEpoch,
    input.operatorLockHash,
  );
  const actualInputs = input.consumedInputs.map(outPointKey);
  const plannedInputs = plan.consumedInputs.map(outPointKey);
  if (
    decision.status !== "ready" ||
    decision.operation !== plan.operation ||
    decision.jobId !== plan.jobId ||
    decision.sequence !== plan.sequence ||
    JSON.stringify(actualInputs) !== JSON.stringify(plannedInputs)
  ) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_STALE_OUTPOINT",
      "live harvest state changed after the execution plan was prepared",
    );
  }
}

export type DaoHarvestV2AttemptObservation =
  | { readonly kind: "pending" }
  | {
      readonly kind: "committed";
      readonly txHash: Hash32;
      readonly canonical: boolean;
      readonly inputsRestored?: boolean;
    }
  | { readonly kind: "spent"; readonly spendingTxHash: Hash32 }
  | { readonly kind: "dropped"; readonly inputsRestored: boolean }
  | { readonly kind: "reorged"; readonly inputsRestored: boolean };

export function reconcileDaoHarvestV2Attempt(
  submittedTxHashValue: Hash32,
  observation: DaoHarvestV2AttemptObservation,
): "pending" | "confirmed" | "conflicted" | "retry" | "recovery_required" {
  const submittedTxHash = parseHash32(submittedTxHashValue);
  switch (observation.kind) {
    case "pending":
      return "pending";
    case "committed":
      return parseHash32(observation.txHash) === submittedTxHash && observation.canonical
        ? "confirmed"
        : observation.canonical
          ? "conflicted"
          : observation.inputsRestored === true
            ? "retry"
            : "recovery_required";
    case "spent":
      return parseHash32(observation.spendingTxHash) === submittedTxHash ? "pending" : "conflicted";
    case "dropped":
    case "reorged":
      return observation.inputsRestored ? "retry" : "recovery_required";
  }
}

export function assertSingleCanonicalDaoHarvestV2Successor(
  observations: readonly {
    readonly txHash: Hash32;
    readonly canonical: boolean;
    readonly consumedInputKey: string;
  }[],
): Hash32 | undefined {
  const canonical = observations.filter((observation) => observation.canonical);
  const byInput = new Map<string, Hash32>();
  for (const observation of canonical) {
    const txHash = parseHash32(observation.txHash);
    const existing = byInput.get(observation.consumedInputKey);
    if (existing !== undefined && existing !== txHash) {
      throw new DaoHarvestV2SafetyError(
        "EXECUTOR_CHAIN_CONTRADICTION",
        "more than one canonical successor consumes the same harvest state",
      );
    }
    byInput.set(observation.consumedInputKey, txHash);
  }
  const transactionHashes = new Set(byInput.values());
  if (transactionHashes.size > 1) {
    throw new DaoHarvestV2SafetyError(
      "EXECUTOR_CHAIN_CONTRADICTION",
      "canonical harvest evidence disagrees across state inputs",
    );
  }
  return transactionHashes.values().next().value;
}
