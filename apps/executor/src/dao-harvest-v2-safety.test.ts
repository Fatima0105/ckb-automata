import assert from "node:assert/strict";
import test from "node:test";

import {
  createEpoch,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  packEpoch,
  parseHash32,
  parseOutputIndex,
  type Hash32,
  type OutPoint,
} from "@ckb-automata/core";

import {
  DAO_HARVEST_V1_ADAPTER_ID,
  DAO_HARVEST_V2_ADAPTER_ID,
  assertSingleCanonicalDaoHarvestV2Successor,
  createDaoHarvestV2ExecutionPlan,
  daoHarvestAdapterId,
  evaluateDaoHarvestV2Schedule,
  reconcileDaoHarvestV2Attempt,
  validateDaoHarvestV2Reload,
  type DaoHarvestV2ScheduleRecord,
} from "./dao-harvest-v2-safety.ts";

const hash = (value: string): Hash32 => parseHash32(`0x${value.repeat(64)}`);
const jobId = hash("a");
const preferred = hash("1");
const fallbackA = hash("2");
const fallbackB = hash("3");
const stranger = hash("4");
const submitted = hash("b");
const competing = hash("c");
const absolute = (number: bigint) =>
  encodeAbsoluteEpochSince(createEpoch({ number, index: 0n, length: 0n }));
const relative = (number: bigint) =>
  encodeRelativeEpochSince(createEpoch({ number, index: 0n, length: 0n }));
const tip = (number: bigint) => packEpoch(createEpoch({ number, index: 0n, length: 0n }));
const outPoint = (value: string, index = 0n): OutPoint => ({
  txHash: hash(value),
  index: parseOutputIndex(index),
});

function record(overrides: Partial<DaoHarvestV2ScheduleRecord> = {}): DaoHarvestV2ScheduleRecord {
  return {
    jobId,
    sequence: 0n,
    state: "deposited",
    cycleIndex: 0n,
    totalCycles: 2n,
    live: true,
    canonical: true,
    notBeforeSince: absolute(100n),
    prepareCutoffSince: absolute(110n),
    takeoverDelaySince: relative(4n),
    endEpochSince: 0n,
    preferredPrepareOperatorLockHash: preferred,
    creditedPrepareOperatorLockHash: null,
    fallbackPrepareOperatorLockHashes: [fallbackA, fallbackB],
    ...overrides,
  };
}

const consumedInputs = [outPoint("5"), outPoint("6"), outPoint("7"), outPoint("8")];

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    adapterId: DAO_HARVEST_V2_ADAPTER_ID,
    record: record(),
    tipEpoch: tip(100n),
    operatorLockHash: preferred,
    consumedInputs,
    economics: {
      signedTransactionBytes: 1_500,
      maximumSignedTransactionBytes: 2_000,
      feeRatePerKilobyte: 1_000n,
      minimumFeeRatePerKilobyte: 1_000n,
      maximumFeeRatePerKilobyte: 2_000n,
      maximumNetworkFee: 2_000n,
      expectedServicePayment: 5_000n,
      servicePaymentCap: 5_000n,
      minimumProfitMargin: 3_000n,
    },
    dryRun: { cycles: 900_000n, maximumCycles: 1_100_000n },
    ...overrides,
  };
}

test("preferred preparation opens first and backup preparation waits for takeover", () => {
  assert.equal(evaluateDaoHarvestV2Schedule(record(), tip(99n), preferred).status, "waiting");
  assert.equal(evaluateDaoHarvestV2Schedule(record(), tip(100n), preferred).status, "ready");
  const backupWaiting = evaluateDaoHarvestV2Schedule(record(), tip(103n), fallbackA);
  assert.equal(backupWaiting.status, "waiting");
  if (backupWaiting.status === "waiting") assert.equal(backupWaiting.reason, "preferred_window");
  assert.deepEqual(evaluateDaoHarvestV2Schedule(record(), tip(104n), fallbackA), {
    status: "ready",
    operation: "fallback_prepare",
    jobId,
    sequence: "0",
    cycleIndex: "0",
  });
  assert.equal(evaluateDaoHarvestV2Schedule(record(), tip(104n), stranger).status, "unavailable");
});

test("credited preparer claims first and another executor takes over after timeout", () => {
  const withdrawing = record({
    state: "withdrawing",
    sequence: 1n,
    notBeforeSince: absolute(280n),
    prepareCutoffSince: null,
    creditedPrepareOperatorLockHash: fallbackA,
  });
  assert.equal(evaluateDaoHarvestV2Schedule(withdrawing, tip(280n), fallbackA).status, "ready");
  const waiting = evaluateDaoHarvestV2Schedule(withdrawing, tip(283n), fallbackB);
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(evaluateDaoHarvestV2Schedule(withdrawing, tip(284n), fallbackB), {
    status: "ready",
    operation: "fallback_claim",
    jobId,
    sequence: "1",
    cycleIndex: "0",
  });
});

test("prepare authorization uses the owner lock while preferred claim uses its accumulator", () => {
  const accumulator = hash("9");
  const identity = { ownerLockHash: preferred, accumulatorLockHash: accumulator } as const;
  assert.equal(evaluateDaoHarvestV2Schedule(record(), tip(100n), identity).status, "ready");
  const withdrawing = record({
    state: "withdrawing",
    sequence: 1n,
    notBeforeSince: absolute(280n),
    prepareCutoffSince: null,
    creditedPrepareOperatorLockHash: accumulator,
  });
  const decision = evaluateDaoHarvestV2Schedule(withdrawing, tip(280n), identity);
  assert.equal(decision.status, "ready");
  if (decision.status === "ready") assert.equal(decision.operation, "preferred_claim");
});

test("missed windows, end bounds, spent jobs, cycle limits, and reorgs fail closed", () => {
  assert.equal(evaluateDaoHarvestV2Schedule(record(), tip(110n), preferred).status, "unavailable");
  assert.equal(
    evaluateDaoHarvestV2Schedule(record({ endEpochSince: absolute(100n) }), tip(100n), preferred)
      .status,
    "terminal",
  );
  assert.equal(
    evaluateDaoHarvestV2Schedule(record({ live: false }), tip(100n), preferred).status,
    "terminal",
  );
  assert.equal(
    evaluateDaoHarvestV2Schedule(record({ cycleIndex: 2n }), tip(100n), preferred).status,
    "terminal",
  );
  const reorg = evaluateDaoHarvestV2Schedule(record({ canonical: false }), tip(100n), preferred);
  assert.equal(reorg.status, "waiting");
  if (reorg.status === "waiting") assert.equal(reorg.reason, "reorg_recovery");
});

test("execution plans bind operation keys, bounded fees, profitability, and dry-run limits", () => {
  const first = createDaoHarvestV2ExecutionPlan(planInput());
  const restarted = createDaoHarvestV2ExecutionPlan(planInput());
  assert.deepEqual(first, restarted);
  assert.equal(first.networkFee, 1_500n);
  assert.equal(first.expectedMargin, 3_500n);
  assert.equal(first.queueKey, `v2/${jobId}/0/preferred_prepare/0`);

  assert.throws(
    () =>
      createDaoHarvestV2ExecutionPlan(
        planInput({
          economics: { ...planInput().economics, expectedServicePayment: 4_499n },
        }),
      ),
    /does not cover/,
  );
  assert.throws(
    () =>
      createDaoHarvestV2ExecutionPlan(
        planInput({ economics: { ...planInput().economics, feeRatePerKilobyte: 2_001n } }),
      ),
    /outside/,
  );
  assert.throws(
    () =>
      createDaoHarvestV2ExecutionPlan(
        planInput({
          economics: { ...planInput().economics, signedTransactionBytes: 2_001 },
        }),
      ),
    /transaction exceeds/,
  );
  assert.throws(
    () =>
      createDaoHarvestV2ExecutionPlan(
        planInput({ dryRun: { cycles: 1_100_001n, maximumCycles: 1_100_000n } }),
      ),
    /cycles/,
  );
});

test("fresh reload accepts the plan while owner races and stale fee inputs stop it", () => {
  const plan = createDaoHarvestV2ExecutionPlan(planInput());
  assert.doesNotThrow(() =>
    validateDaoHarvestV2Reload(plan, {
      record: record(),
      tipEpoch: tip(100n),
      operatorLockHash: preferred,
      consumedInputs,
    }),
  );
  assert.throws(
    () =>
      validateDaoHarvestV2Reload(plan, {
        record: record({ live: false }),
        tipEpoch: tip(100n),
        operatorLockHash: preferred,
        consumedInputs,
      }),
    /changed/,
  );
  assert.throws(
    () =>
      validateDaoHarvestV2Reload(plan, {
        record: record(),
        tipEpoch: tip(100n),
        operatorLockHash: preferred,
        consumedInputs: [...consumedInputs.slice(0, -1), outPoint("9")],
      }),
    /changed/,
  );
});

test("two backup executors contend safely and only one canonical successor is accepted", () => {
  const first = createDaoHarvestV2ExecutionPlan(
    planInput({ tipEpoch: tip(104n), operatorLockHash: fallbackA }),
  );
  const second = createDaoHarvestV2ExecutionPlan(
    planInput({ tipEpoch: tip(104n), operatorLockHash: fallbackB }),
  );
  assert.equal(first.queueKey, second.queueKey);
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, {
      kind: "spent",
      spendingTxHash: competing,
    }),
    "conflicted",
  );
  assert.equal(
    assertSingleCanonicalDaoHarvestV2Successor([
      { txHash: submitted, canonical: true, consumedInputKey: "job" },
      { txHash: submitted, canonical: true, consumedInputKey: "vault" },
      { txHash: competing, canonical: false, consumedInputKey: "job" },
    ]),
    submitted,
  );
  assert.throws(() =>
    assertSingleCanonicalDaoHarvestV2Successor([
      { txHash: submitted, canonical: true, consumedInputKey: "job" },
      { txHash: competing, canonical: true, consumedInputKey: "job" },
    ]),
  );
});

test("drops, restarts, and reorgs retry only after every input is restored", () => {
  assert.equal(reconcileDaoHarvestV2Attempt(submitted, { kind: "pending" }), "pending");
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, {
      kind: "committed",
      txHash: submitted,
      canonical: true,
    }),
    "confirmed",
  );
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, { kind: "dropped", inputsRestored: true }),
    "retry",
  );
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, { kind: "reorged", inputsRestored: false }),
    "recovery_required",
  );
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, {
      kind: "committed",
      txHash: submitted,
      canonical: false,
    }),
    "recovery_required",
  );
  assert.equal(
    reconcileDaoHarvestV2Attempt(submitted, {
      kind: "committed",
      txHash: submitted,
      canonical: false,
      inputsRestored: true,
    }),
    "retry",
  );
});

test("V1 and V2 adapter identities cannot be confused", () => {
  assert.equal(daoHarvestAdapterId(1n), DAO_HARVEST_V1_ADAPTER_ID);
  assert.equal(daoHarvestAdapterId(2n), DAO_HARVEST_V2_ADAPTER_ID);
  assert.throws(() =>
    createDaoHarvestV2ExecutionPlan(planInput({ adapterId: DAO_HARVEST_V1_ADAPTER_ID })),
  );
  assert.throws(() => daoHarvestAdapterId(3n));
});
