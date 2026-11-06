import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1 } from "@ckb-automata/molecule";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  CONTRACT_CAPACITY,
  buildRecurringCreation,
  deploymentRegistry,
  deriveAbsoluteBlockTriggerHash,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
  toRpcHex,
  type OperatorAutomationDeployment,
  type RegisteredDeployment,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ExecutorAdapterRegistry, runExecutorAdapter, type ExecutorSnapshot } from "../adapter.ts";
import { RECURRING_EXECUTOR_ADAPTER, RecurringAdapterError } from "./recurring.ts";

async function deployment(): Promise<RegisteredDeployment> {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
  return loaded.deployment;
}

function lock(value: RegisteredDeployment, byte: string, argsBytes = 20): ScriptIdentity {
  return {
    codeHash: value.manifest.secp256k1Blake160.codeHash,
    hashType: value.manifest.secp256k1Blake160.hashType,
    args: `0x${byte.repeat(argsBytes * 2)}`,
  };
}

function operatorContract(byte: string) {
  return {
    script: { codeHash: parseHash32(`0x${byte.repeat(64)}`), hashType: "data1" as const },
    cellDep: {
      outPoint: { txHash: parseHash32(`0x${byte.repeat(64)}`), index: "0x0" as const },
      depType: "code" as const,
    },
    binarySha256: byte.repeat(64),
    sizeBytes: 1,
  };
}

function operatorDeployment(value: RegisteredDeployment): OperatorAutomationDeployment {
  return {
    genesisHash: value.genesisHash,
    manifestSha256: "a".repeat(64),
    secp256k1Blake160: value.manifest.secp256k1Blake160,
    contracts: {
      jobLock: operatorContract("d"),
      deadlinePolicy: operatorContract("e"),
      recurringPolicy: operatorContract("f"),
    },
    defaultPreferredOperatorLockHash: parseHash32(`0x${"33".repeat(32)}`),
  };
}

function header(number: bigint) {
  return Object.freeze({
    hash: parseHash32(`0x${number.toString(16).padStart(64, "0")}`),
    number: parseBlockNumber(number),
    epoch: "0x0" as const,
    timestamp: `0x${(number * 1_000n).toString(16)}` as const,
  });
}

async function recurringFixture(
  sequence: bigint,
  tip: bigint,
  amount = 10_000_000_000n,
  recipientArgsBytes = 20,
  operator?: Readonly<{ preferredByte: string; takeoverDelayBlocks: bigint }>,
): Promise<{
  readonly snapshot: ExecutorSnapshot;
  readonly executorLock: ScriptIdentity;
  readonly ownerLock: ScriptIdentity;
  readonly recipientLock: ScriptIdentity;
}> {
  const registered = await deployment();
  const ownerLock = lock(registered, "11");
  const recipientLock = lock(registered, "22", recipientArgsBytes);
  const executorLock = lock(registered, "33");
  const operatorContracts = operatorDeployment(registered);
  const reward = 10_000_000_000n;
  const totalRuns = 4n;
  const interval = 10n;
  const first = 100n;
  const creation = buildRecurringCreation({
    deployment: registered,
    ownerLockHash: parseHash32(scriptToHash(ownerLock)),
    recipientLockHash: parseHash32(scriptToHash(recipientLock)),
    amount,
    intervalBlocks: interval,
    firstNotBefore: first,
    totalRuns,
    reward,
    creatorNonce: "51",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
    ...(operator === undefined
      ? {}
      : {
          operator: {
            deployment: operatorContracts,
            preferredExecutorLockHash: parseHash32(
              scriptToHash(lock(registered, operator.preferredByte)),
            ),
            takeoverDelayBlocks: operator.takeoverDelayBlocks,
          },
        }),
  });
  const remainingRuns = totalRuns - sequence;
  const remainingBudget = (amount + reward) * remainingRuns;
  const notBefore = first + sequence * interval;
  const initial = JobDataV1.unpack(hexToBytes(creation.jobData));
  const jobData = bytesToHex(
    JobDataV1.pack({
      ...initial,
      sequence: sequence.toString(),
      trigger_params_hash: [...deriveAbsoluteBlockTriggerHash(parseBlockNumber(notBefore))],
      remaining_budget: remainingBudget.toString(),
      not_before: notBefore.toString(),
      remaining_runs: Number(remainingRuns),
    }),
  ) as `0x${string}`;
  const createdAt = header(90n);
  const jobOutput = creation.transaction.outputs[0]!;
  return {
    executorLock,
    ownerLock,
    recipientLock,
    snapshot: Object.freeze({
      deployment: registered,
      tip: header(tip),
      job: Object.freeze({
        outPoint: parseOutPoint({ txHash: `0x${"51".repeat(32)}`, index: "0" }),
        output: Object.freeze({
          ...jobOutput,
          capacity: toRpcHex(parseShannons(CONTRACT_CAPACITY.jobCellV1 + remainingBudget)),
        }),
        data: jobData,
        blockHash: createdAt.hash,
        blockNumber: createdAt.number,
      }),
      applicationCells: Object.freeze([]),
      feeCells: Object.freeze([
        Object.freeze({
          outPoint: parseOutPoint({ txHash: `0x${"52".repeat(32)}`, index: "0" }),
          output: Object.freeze({
            capacity: "0x2540be400" as const,
            lock: executorLock,
            type: null,
          }),
          data: "0x" as const,
          blockHash: createdAt.hash,
          blockNumber: createdAt.number,
        }),
      ]),
      headers: Object.freeze([createdAt]),
      resolvedLocks: Object.freeze([ownerLock, recipientLock]),
      payloads: Object.freeze([
        operator === undefined ? creation.recurringPayload : creation.intent.operatorPayload!,
      ]),
      claims: Object.freeze({}),
      ...(operator === undefined ? {} : { operatorDeployment: operatorContracts }),
    }),
  };
}

function execute(fixture: Awaited<ReturnType<typeof recurringFixture>>) {
  return runExecutorAdapter(
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    fixture.snapshot,
    { rewardLock: fixture.executorLock, transactionFee: parseShannons("1000000") },
  );
}

test("recurring adapter rejects a payout below the resolved recipient minimum", async () => {
  const fixture = await recurringFixture(0n, 100n, 6_100_000_000n, 22);
  await assert.rejects(
    async () => execute(fixture),
    (error: unknown) =>
      error instanceof RecurringAdapterError && error.code === "INVALID_RECURRING_JOB",
  );
});

for (const [label, sequence, tip, expectedNext] of [
  ["first", 0n, 100n, 110n],
  ["middle", 1n, 110n, 120n],
  ["late", 2n, 999n, 130n],
] as const) {
  test(`recurring adapter derives the ${label} successor from the original schedule`, async () => {
    const fixture = await recurringFixture(sequence, tip);
    const first = await execute(fixture);
    const second = await execute(fixture);
    assert.deepEqual(first, second);
    assert.equal(first.status, "built");
    if (first.status !== "built") return;
    assert.equal(first.build.summary["sequence"], sequence.toString());
    assert.equal(first.build.summary["final"], false);
    const successor = JobDataV1.unpack(hexToBytes(first.build.transaction.outputsData[2]!));
    assert.equal(BigInt(successor.sequence.toString()), sequence + 1n);
    assert.equal(BigInt(successor.not_before.toString()), expectedNext);
    assert.equal(
      first.build.transaction.inputs[0]?.since,
      toRpcHex(parseBlockNumber(100n + sequence * 10n)),
    );
  });
}

test("recurring adapter returns the exact residual to the owner on the final run", async () => {
  const fixture = await recurringFixture(3n, 130n);
  const result = await execute(fixture);
  assert.equal(result.status, "built");
  if (result.status !== "built") return;
  assert.equal(result.build.summary["final"], true);
  assert.deepEqual(result.build.transaction.outputs[2]?.lock, fixture.ownerLock);
  assert.equal(result.build.transaction.outputs[2]?.type, null);
  assert.equal(result.build.transaction.outputsData[2], "0x");
  assert.equal(BigInt(result.build.transaction.outputs[2]!.capacity), CONTRACT_CAPACITY.jobCellV1);
});

test("recurring adapter stops before building until the committed schedule bound", async () => {
  const fixture = await recurringFixture(0n, 99n);
  const result = await execute(fixture);
  assert.equal(result.status, "ineligible");
  if (result.status === "ineligible") {
    assert.equal(result.eligibility.reason, "EXECUTOR_NOT_YET_ELIGIBLE");
  }
});

test("operator-bound recurring jobs open to other executors only after takeover", async () => {
  const preferred = await recurringFixture(0n, 100n, 10_000_000_000n, 20, {
    preferredByte: "33",
    takeoverDelayBlocks: 12n,
  });
  const preferredResult = await execute(preferred);
  assert.equal(preferredResult.status, "built");
  if (preferredResult.status !== "built") return;
  assert.equal(
    preferredResult.build.transaction.inputs[0]?.since,
    toRpcHex(parseBlockNumber(100n)),
  );

  const fallback = await recurringFixture(0n, 100n, 10_000_000_000n, 20, {
    preferredByte: "44",
    takeoverDelayBlocks: 12n,
  });
  const waiting = await execute(fallback);
  assert.equal(waiting.status, "ineligible");

  const takeover = await execute({
    ...fallback,
    snapshot: { ...fallback.snapshot, tip: header(112n) },
  });
  assert.equal(takeover.status, "built");
  if (takeover.status !== "built") return;
  assert.equal(takeover.build.transaction.inputs[0]?.since, toRpcHex(parseBlockNumber(112n)));
  const successor = JobDataV1.unpack(hexToBytes(takeover.build.transaction.outputsData[2]!));
  assert.equal(BigInt(successor.not_after.toString()), 122n);
});

test("recurring adapter rejects unresolved or mismatched payload commitments", async () => {
  const fixture = await recurringFixture(0n, 100n);
  await assert.rejects(
    async () =>
      execute({ ...fixture, snapshot: { ...fixture.snapshot, payloads: Object.freeze([]) } }),
    (error: unknown) =>
      error instanceof RecurringAdapterError && error.code === "INVALID_COMMITMENT",
  );
  await assert.rejects(
    async () =>
      execute({
        ...fixture,
        snapshot: { ...fixture.snapshot, resolvedLocks: Object.freeze([fixture.ownerLock]) },
      }),
    (error: unknown) =>
      error instanceof RecurringAdapterError && error.code === "MISSING_RESOLUTION",
  );
});

test("recurring adapter rejects application fee cells and ambiguous executor payouts", async () => {
  const fixture = await recurringFixture(0n, 100n);
  const feeCell = fixture.snapshot.feeCells[0]!;
  await assert.rejects(
    async () =>
      execute({
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          applicationCells: Object.freeze([feeCell]),
        },
      }),
    (error: unknown) => error instanceof RecurringAdapterError && error.code === "INVALID_FEE_CELL",
  );

  const recipientFeeCell = Object.freeze({
    ...feeCell,
    output: Object.freeze({ ...feeCell.output, lock: fixture.recipientLock }),
  });
  await assert.rejects(
    async () =>
      runExecutorAdapter(
        new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
        { ...fixture.snapshot, feeCells: Object.freeze([recipientFeeCell]) },
        { rewardLock: fixture.recipientLock, transactionFee: parseShannons("1000000") },
      ),
    (error: unknown) => error instanceof RecurringAdapterError && error.code === "AMBIGUOUS_PAYOUT",
  );
});
