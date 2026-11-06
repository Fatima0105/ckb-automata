import {
  JobDataV1,
  RecurringPayloadV1,
  type RecurringPayloadV1Value,
} from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  ABSOLUTE_BLOCK_TRIGGER_KIND,
  CONTRACT_CAPACITY,
  deriveAbsoluteBlockTriggerHash,
  deriveRecurringPayloadHash,
  deriveOperatorPayloadHash,
  hash32FromBytes,
  hash32ToBytes,
  isValidRecurringSchedule,
  minimumPlainCellCapacity,
  parseBlockNumber,
  parseHash32,
  parseRunCount,
  parseShannons,
  operatorTakeoverBlock,
  toRpcHex,
  type Hash32,
  type ScriptIdentity,
  type SinceValue,
  type Shannons,
  type UnsignedDeadlineTransaction,
  unpackOperatorPayload,
} from "@ckb-automata/core";

import {
  defineExecutorAdapter,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorEligibilityContext,
  type EligibilityDecision,
} from "../adapter.ts";

type Hex = `0x${string}`;
const EXECUTION_MODE = 0;

function evaluateRecurringEligibility(
  context: ExecutorEligibilityContext,
): EligibilityDecision<RecurringEvidence> {
  const scheduledBlock = context.jobInspection.job.notBefore;
  const observedTip = context.snapshot.tip.number;
  const evidence = Object.freeze({
    scheduledBlock,
    observedTip,
    sequence: context.jobInspection.job.sequence,
  });
  return observedTip >= scheduledBlock
    ? Object.freeze({ status: "eligible", evidence })
    : Object.freeze({
        status: "ineligible",
        reason: "EXECUTOR_NOT_YET_ELIGIBLE",
        terminal: false,
        evidence,
      });
}

export const RECURRING_EXECUTOR_REGISTRATION = Object.freeze({
  id: "recurring-v1",
  policy: "recurring",
  supports: (policy) => policy.kind === "recurring",
  evaluateEligibility: evaluateRecurringEligibility,
} satisfies ExecutorAdapterRegistration);

export type RecurringAdapterErrorCode =
  | "INVALID_RECURRING_JOB"
  | "INVALID_COMMITMENT"
  | "MISSING_RESOLUTION"
  | "INVALID_FEE_CELL"
  | "AMBIGUOUS_PAYOUT";

export class RecurringAdapterError extends Error {
  override readonly name = "RecurringAdapterError";
  readonly code: RecurringAdapterErrorCode;

  constructor(code: RecurringAdapterErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RecurringInspection {
  readonly payload: RecurringPayloadV1Value;
  readonly payloadHex: Hex;
  readonly ownerLock: ScriptIdentity;
  readonly recipientLock: ScriptIdentity;
  readonly feeCell: ExecutorCellSnapshot;
  readonly executorLockHash: Hash32;
  readonly amount: Shannons;
  readonly final: boolean;
  readonly operatorSelection?: ReturnType<typeof unpackOperatorPayload>["selection"];
}

export interface RecurringEvidence {
  readonly scheduledBlock: bigint;
  readonly observedTip: bigint;
  readonly sequence: bigint;
  readonly executionSince?: SinceValue;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function scriptHash(script: ScriptIdentity): Hash32 {
  return parseHash32(scriptToHash(script));
}

function findLock(context: ExecutorContext, hash: Hash32, name: string): ScriptIdentity {
  const matches = context.snapshot.resolvedLocks.filter((lock) => scriptHash(lock) === hash);
  const unique = new Map(matches.map((lock) => [stable(lock), lock]));
  if (unique.size !== 1) {
    throw new RecurringAdapterError(
      "MISSING_RESOLUTION",
      `${name} requires exactly one resolved lock script matching ${hash}`,
    );
  }
  return unique.values().next().value!;
}

function compareCells(left: ExecutorCellSnapshot, right: ExecutorCellSnapshot): number {
  const hashOrder = left.outPoint.txHash.localeCompare(right.outPoint.txHash);
  return hashOrder === 0 ? Number(left.outPoint.index - right.outPoint.index) : hashOrder;
}

function selectFeeCell(context: ExecutorContext): ExecutorCellSnapshot {
  const fee = parseShannons(context.identity.transactionFee);
  const candidates = context.snapshot.feeCells
    .filter(
      (cell) =>
        stable(cell.output.lock) === stable(context.identity.rewardLock) &&
        cell.output.type === null &&
        cell.data === "0x" &&
        stable(cell.outPoint) !== stable(context.snapshot.job.outPoint) &&
        !context.snapshot.applicationCells.some(
          (application) => stable(application.outPoint) === stable(cell.outPoint),
        ) &&
        parseShannons(cell.output.capacity) >= fee + CONTRACT_CAPACITY.plainWalletCell,
    )
    .toSorted(compareCells);
  if (candidates.length === 0) {
    throw new RecurringAdapterError(
      "INVALID_FEE_CELL",
      "no plain executor cell can fund the configured fee and a valid change output",
    );
  }
  return candidates[0]!;
}

function resolvePayload(context: ExecutorContext): { payload: RecurringPayloadV1Value; hex: Hex } {
  const policyHash = hash32ToBytes(context.jobInspection.job.policyScriptHash);
  const expectedHash = context.jobInspection.job.payloadHash;
  const matches: { payload: RecurringPayloadV1Value; hex: Hex }[] = [];
  for (const hex of new Set(context.snapshot.payloads)) {
    try {
      const bytes = hexToBytes(hex);
      const operatorBound =
        context.jobInspection.policy.kind === "recurring" &&
        context.jobInspection.policy.contract === "recurring-policy-v2";
      const committedHash = operatorBound
        ? deriveOperatorPayloadHash(policyHash, bytes)
        : deriveRecurringPayloadHash(policyHash, bytes);
      if (hash32FromBytes(committedHash) !== expectedHash) continue;
      const application = operatorBound ? unpackOperatorPayload(bytes).applicationPayload : bytes;
      matches.push({ payload: RecurringPayloadV1.unpack(application), hex });
    } catch {
      // Malformed and non-matching candidates are not evidence for this job.
    }
  }
  if (matches.length !== 1) {
    throw new RecurringAdapterError(
      "INVALID_COMMITMENT",
      "the snapshot must resolve exactly one recurring payload matching the job commitment",
    );
  }
  return matches[0]!;
}

function inspectRecurring(context: ExecutorContext): RecurringInspection {
  if (context.jobInspection.policy.kind !== "recurring") {
    throw new RecurringAdapterError(
      "INVALID_RECURRING_JOB",
      "recurring adapter received another policy",
    );
  }
  const operatorBound = context.jobInspection.policy.contract === "recurring-policy-v2";
  const operatorDeployment = context.snapshot.operatorDeployment;
  if (operatorBound && operatorDeployment === undefined) {
    throw new RecurringAdapterError("INVALID_RECURRING_JOB", "operator deployment is unavailable");
  }
  const expectedJobLock = {
    ...(operatorBound
      ? operatorDeployment!.contracts.jobLock.script
      : context.snapshot.deployment.contracts["job-lock"].script),
    args: "0x" as const,
  };
  const expectedPolicy = {
    ...(operatorBound
      ? operatorDeployment!.contracts.recurringPolicy.script
      : context.snapshot.deployment.contracts["recurring-policy"].script),
    args: "0x" as const,
  };
  if (
    stable(context.snapshot.job.output.lock) !== stable(expectedJobLock) ||
    stable(context.snapshot.job.output.type) !== stable(expectedPolicy)
  ) {
    throw new RecurringAdapterError(
      "INVALID_RECURRING_JOB",
      "job input does not use the registered Job Lock and recurring policy",
    );
  }

  const resolved = resolvePayload(context);
  const operatorPayload = operatorBound
    ? unpackOperatorPayload(hexToBytes(resolved.hex))
    : undefined;
  const payload = resolved.payload;
  const amount = parseShannons(payload.amount.toString());
  const interval = parseBlockNumber(payload.interval_blocks.toString());
  const first = parseBlockNumber(payload.first_not_before.toString());
  const totalRuns = parseRunCount(BigInt(payload.total_runs));
  const reward = parseShannons(payload.reward.toString());
  const job = context.jobInspection.job;
  const scheduled = parseBlockNumber(first + job.sequence * interval);
  const expectedTrigger = hash32FromBytes(deriveAbsoluteBlockTriggerHash(scheduled));
  const ownerHash = hash32FromBytes(Uint8Array.from(payload.owner_lock_hash));
  const recipientHash = hash32FromBytes(Uint8Array.from(payload.recipient_lock_hash));
  const requiredBudget = parseShannons((amount + reward) * job.remainingRuns);
  if (
    Number(payload.version) !== 1 ||
    Number(payload.final_refund_kind) !== 0 ||
    !isValidRecurringSchedule({
      amount,
      intervalBlocks: interval,
      firstNotBefore: first,
      totalRuns,
      finalRefundKind: Number(payload.final_refund_kind),
    }) ||
    reward !== job.reward ||
    ownerHash !== job.cancelLockHash ||
    job.trigger.kind !== ABSOLUTE_BLOCK_TRIGGER_KIND ||
    (operatorPayload === undefined
      ? job.notAfter !== 0n
      : job.notAfter !==
        operatorTakeoverBlock(job.notBefore, operatorPayload.selection.takeoverDelayBlocks)) ||
    job.sequence + job.remainingRuns !== totalRuns ||
    BigInt(job.notBefore) !== BigInt(scheduled) ||
    job.trigger.paramsHash !== expectedTrigger ||
    job.remainingBudget < requiredBudget ||
    parseShannons(context.snapshot.job.output.capacity) !==
      CONTRACT_CAPACITY.jobCellV1 + job.remainingBudget
  ) {
    throw new RecurringAdapterError(
      "INVALID_RECURRING_JOB",
      "recurring job state is inconsistent with its committed schedule and budget",
    );
  }

  const ownerLock = findLock(context, ownerHash, "recurring owner");
  const recipientLock = findLock(context, recipientHash, "recurring recipient");
  const executorLockHash = scriptHash(context.identity.rewardLock);
  const jobLockHash = scriptHash(expectedJobLock);
  const feeCell = selectFeeCell(context);
  const feeChange = parseShannons(
    parseShannons(feeCell.output.capacity) - context.identity.transactionFee,
  );
  if (
    ownerHash === jobLockHash ||
    recipientHash === jobLockHash ||
    (job.remainingRuns > 1n &&
      executorLockHash === recipientHash &&
      (reward === amount || feeChange === amount))
  ) {
    throw new RecurringAdapterError(
      "AMBIGUOUS_PAYOUT",
      "resolved locks would make the payout ambiguous or create an unintended Job Lock output",
    );
  }
  return Object.freeze({
    payload,
    payloadHex: resolved.hex,
    ownerLock,
    recipientLock,
    feeCell,
    executorLockHash,
    amount,
    final: job.remainingRuns === 1n,
    ...(operatorPayload === undefined ? {} : { operatorSelection: operatorPayload.selection }),
  });
}

function executionWitness(executorLockHash: Hash32, payload: Hex): Hex {
  const request = new Uint8Array(50);
  const view = new DataView(request.buffer);
  request[0] = EXECUTION_MODE;
  view.setUint32(1, 0, true);
  request.set(hash32ToBytes(executorLockHash), 5);
  request[37] = 3;
  view.setUint32(38, 0, true);
  view.setUint32(42, 1, true);
  view.setUint32(46, 2, true);
  return serializeWitnessArgs({
    lock: "",
    inputType: bytesToHex(request),
    outputType: payload,
  }) as Hex;
}

function plainOutput(capacity: Shannons, lock: ScriptIdentity) {
  return Object.freeze({ capacity: toRpcHex(capacity), lock, type: null });
}

function buildRecurring(
  context: ExecutorContext,
  inspection: RecurringInspection,
  executionSince = context.jobInspection.job.notBefore,
): ExecutorBuild {
  const job = context.jobInspection.job;
  const reward = parseShannons(job.reward);
  const consumed = parseShannons(reward + inspection.amount);
  const jobCapacity = parseShannons(context.snapshot.job.output.capacity);
  const residual = parseShannons(jobCapacity - consumed);
  const feeCapacity = parseShannons(inspection.feeCell.output.capacity);
  const feeChange = parseShannons(feeCapacity - context.identity.transactionFee);
  if (inspection.amount < minimumPlainCellCapacity(inspection.recipientLock)) {
    throw new RecurringAdapterError(
      "INVALID_RECURRING_JOB",
      "recurring amount cannot fund the resolved recipient output",
    );
  }
  const outputs: UnsignedDeadlineTransaction["outputs"][number][] = [
    plainOutput(reward, context.identity.rewardLock),
    plainOutput(inspection.amount, inspection.recipientLock),
  ];
  const outputsData: Hex[] = ["0x", "0x"];

  if (inspection.final) {
    outputs.push(plainOutput(residual, inspection.ownerLock));
    outputsData.push("0x");
  } else {
    const sequence = job.sequence + 1n;
    const remainingRuns = job.remainingRuns - 1n;
    const remainingBudget = parseShannons(job.remainingBudget - consumed);
    const first = parseBlockNumber(inspection.payload.first_not_before.toString());
    const interval = parseBlockNumber(inspection.payload.interval_blocks.toString());
    const notBefore = parseBlockNumber(first + sequence * interval);
    const current = JobDataV1.unpack(hexToBytes(context.snapshot.job.data));
    const successorData = bytesToHex(
      JobDataV1.pack({
        ...current,
        sequence: sequence.toString(),
        trigger_params_hash: [...deriveAbsoluteBlockTriggerHash(notBefore)],
        remaining_budget: remainingBudget.toString(),
        not_before: notBefore.toString(),
        not_after:
          inspection.operatorSelection === undefined
            ? "0"
            : operatorTakeoverBlock(
                notBefore,
                inspection.operatorSelection.takeoverDelayBlocks,
              ).toString(),
        remaining_runs: Number(remainingRuns),
      }),
    ) as Hex;
    outputs.push(
      Object.freeze({
        capacity: toRpcHex(residual),
        lock: context.snapshot.job.output.lock,
        type: context.snapshot.job.output.type,
      }),
    );
    outputsData.push(successorData);
  }
  outputs.push(plainOutput(feeChange, context.identity.rewardLock));
  outputsData.push("0x");

  const transaction: UnsignedDeadlineTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.manifest.secp256k1Blake160.cellDep
        : context.snapshot.operatorDeployment!.secp256k1Blake160.cellDep,
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.contracts["job-lock"].cellDep
        : context.snapshot.operatorDeployment!.contracts.jobLock.cellDep,
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.contracts["recurring-policy"].cellDep
        : context.snapshot.operatorDeployment!.contracts.recurringPolicy.cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: toRpcHex(executionSince),
        previousOutput: Object.freeze({
          txHash: context.snapshot.job.outPoint.txHash,
          index: toRpcHex(context.snapshot.job.outPoint.index),
        }),
      }),
      Object.freeze({
        since: "0x0" as const,
        previousOutput: Object.freeze({
          txHash: inspection.feeCell.outPoint.txHash,
          index: toRpcHex(inspection.feeCell.outPoint.index),
        }),
      }),
    ]),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze([
      executionWitness(inspection.executorLockHash, inspection.payloadHex),
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    summary: Object.freeze({
      policy: "recurring",
      sequence: job.sequence.toString(),
      final: inspection.final,
      scheduledBlock: job.notBefore.toString(),
      observedTip: context.snapshot.tip.number.toString(),
      reward: reward.toString(),
      payout: inspection.amount.toString(),
      controlledOutputIndices: Object.freeze([0, 1, 2]),
    }),
  });
}

export const RECURRING_EXECUTOR_ADAPTER = defineExecutorAdapter<
  RecurringInspection,
  RecurringEvidence
>({
  registration: RECURRING_EXECUTOR_REGISTRATION,
  inspect: inspectRecurring,
  eligibility: (context, inspection) => {
    const base = evaluateRecurringEligibility(context);
    if (base.status === "ineligible" || inspection.operatorSelection === undefined) return base;
    const executor = scriptHash(context.identity.rewardLock);
    const preferred = inspection.operatorSelection.preferredExecutorLockHash;
    const executionSince =
      executor === preferred
        ? context.jobInspection.job.notBefore
        : context.jobInspection.job.notAfter;
    return context.snapshot.tip.number >= executionSince
      ? Object.freeze({
          status: "eligible" as const,
          evidence: { ...base.evidence, executionSince },
        })
      : Object.freeze({
          status: "ineligible" as const,
          reason: "EXECUTOR_NOT_YET_ELIGIBLE" as const,
          terminal: false,
          evidence: { ...base.evidence, executionSince },
        });
  },
  build: (context, inspection, eligibility) =>
    buildRecurring(context, inspection, eligibility.evidence.executionSince),
  verifyBuilt: (context, inspection, eligibility, build) => {
    const expected = buildRecurring(context, inspection, eligibility.evidence.executionSince);
    return stable(build) === stable(expected)
      ? Object.freeze({ status: "valid" })
      : Object.freeze({
          status: "invalid",
          reason: "EXECUTOR_SIMULATION_REJECTED",
          message: "recurring transaction differs from the transaction reconstructed from inputs",
        });
  },
});
