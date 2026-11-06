import assert from "node:assert/strict";
import test from "node:test";

import { CampaignDataV1 } from "@ckb-automata/molecule";
import { hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  buildDeadlineCreation,
  deploymentRegistry,
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
import { DEADLINE_EXECUTOR_ADAPTER, DeadlineAdapterError } from "./deadline.ts";

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
      jobLock: operatorContract("a"),
      deadlinePolicy: operatorContract("b"),
      recurringPolicy: operatorContract("c"),
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

async function deadlineFixture(
  outcome: "SUCCEEDED" | "REFUNDING",
  pledged = 10_000_000_000n,
  successArgsBytes = 20,
  operator?: Readonly<{ preferredByte: string; takeoverDelayBlocks: bigint }>,
): Promise<{
  readonly snapshot: ExecutorSnapshot;
  readonly executorLock: ScriptIdentity;
  readonly successLock: ScriptIdentity;
}> {
  const registered = await deployment();
  const ownerLock = lock(registered, "11");
  const successLock = lock(registered, "22", successArgsBytes);
  const executorLock = lock(registered, "33");
  const operatorContracts = operatorDeployment(registered);
  const deadline = 100n;
  const creation = buildDeadlineCreation({
    deployment: registered,
    pledges: [
      {
        outPoint: parseOutPoint({ txHash: `0x${"50".repeat(32)}`, index: "0" }),
        refundLockHash: parseHash32(scriptToHash(ownerLock)),
        amount: pledged,
      },
    ],
    target: outcome === "SUCCEEDED" ? pledged : pledged + 1n,
    deadlineBlock: deadline,
    successLockHash: parseHash32(scriptToHash(successLock)),
    cancelLockHash: parseHash32(scriptToHash(ownerLock)),
    reward: "10000000000",
    creatorNonce: "50",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "1200" },
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
  const campaignOutput = creation.transaction.outputs[0];
  const jobOutput = creation.transaction.outputs[1];
  assert.ok(campaignOutput && jobOutput);
  const createdAt = header(80n);
  return {
    executorLock,
    successLock,
    snapshot: Object.freeze({
      deployment: registered,
      tip: header(deadline),
      job: Object.freeze({
        outPoint: parseOutPoint({ txHash: `0x${"51".repeat(32)}`, index: "1" }),
        output: jobOutput,
        data: creation.jobData,
        blockHash: createdAt.hash,
        blockNumber: createdAt.number,
      }),
      applicationCells: Object.freeze([
        Object.freeze({
          outPoint: parseOutPoint({ txHash: `0x${"51".repeat(32)}`, index: "0" }),
          output: campaignOutput,
          data: creation.campaignData,
          blockHash: createdAt.hash,
          blockNumber: createdAt.number,
        }),
      ]),
      feeCells: Object.freeze([
        Object.freeze({
          outPoint: parseOutPoint({ txHash: `0x${"52".repeat(32)}`, index: "0" }),
          output: Object.freeze({
            capacity: "0x2540be400",
            lock: executorLock,
            type: null,
          }),
          data: "0x" as const,
          blockHash: createdAt.hash,
          blockNumber: createdAt.number,
        }),
      ]),
      headers: Object.freeze([createdAt]),
      resolvedLocks: Object.freeze([ownerLock, successLock]),
      payloads: Object.freeze([
        creation.intent.pledgeRecords,
        ...(creation.intent.operatorPayload === undefined ? [] : [creation.intent.operatorPayload]),
      ]),
      claims: Object.freeze({}),
      ...(operator === undefined ? {} : { operatorDeployment: operatorContracts }),
    }),
  };
}

function execute(fixture: Awaited<ReturnType<typeof deadlineFixture>>) {
  return runExecutorAdapter(
    new ExecutorAdapterRegistry([DEADLINE_EXECUTOR_ADAPTER]),
    fixture.snapshot,
    {
      rewardLock: fixture.executorLock,
      transactionFee: parseShannons("1000000"),
    },
  );
}

test("deadline adapter derives success and binds every terminal output", async () => {
  const fixture = await deadlineFixture("SUCCEEDED");
  const first = await execute(fixture);
  const second = await execute(fixture);
  assert.deepEqual(first, second);
  assert.equal(first.status, "built");
  if (first.status !== "built") return;
  assert.equal(first.build.summary["outcome"], "SUCCEEDED");
  assert.deepEqual(first.build.transaction.outputs[2]?.lock, fixture.successLock);
  assert.equal(first.build.transaction.outputs[2]?.capacity, "0x2540be400");
  const terminal = CampaignDataV1.unpack(hexToBytes(first.build.transaction.outputsData[3]!));
  assert.equal(terminal.state, 1);
});

test("deadline adapter rejects a payout below the resolved recipient minimum", async () => {
  const fixture = await deadlineFixture("SUCCEEDED", 6_100_000_000n, 22);
  await assert.rejects(
    async () => execute(fixture),
    (error: unknown) => error instanceof DeadlineAdapterError && error.code === "INVALID_CAMPAIGN",
  );
});

test("deadline adapter derives refund outputs from committed records", async () => {
  const fixture = await deadlineFixture("REFUNDING");
  const result = await execute(fixture);
  assert.equal(result.status, "built");
  if (result.status !== "built") return;
  assert.equal(result.build.summary["outcome"], "REFUNDING");
  assert.equal(result.build.transaction.outputs[2]?.capacity, "0x2540be400");
  assert.deepEqual(result.build.transaction.outputs[2]?.lock, fixture.snapshot.resolvedLocks[0]);
  const terminal = CampaignDataV1.unpack(hexToBytes(result.build.transaction.outputsData[3]!));
  assert.equal(terminal.state, 2);
});

test("deadline adapter stops before building until the committed block", async () => {
  const fixture = await deadlineFixture("SUCCEEDED");
  const result = await execute({
    ...fixture,
    snapshot: { ...fixture.snapshot, tip: header(99n) },
  });
  assert.equal(result.status, "ineligible");
  if (result.status === "ineligible") {
    assert.equal(result.eligibility.reason, "EXECUTOR_NOT_YET_ELIGIBLE");
  }
});

test("operator-bound deadline gives the preferred executor the first window", async () => {
  const preferred = await deadlineFixture("SUCCEEDED", 10_000_000_000n, 20, {
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

  const fallback = await deadlineFixture("SUCCEEDED", 10_000_000_000n, 20, {
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
});

test("deadline adapter rejects contradicted claims and uncommitted refund data", async () => {
  const fixture = await deadlineFixture("REFUNDING");
  await assert.rejects(
    async () =>
      execute({
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          claims: Object.freeze({ deadlineOutcome: "SUCCEEDED" }),
        },
      }),
    (error: unknown) => error instanceof DeadlineAdapterError && error.code === "UNSUPPORTED_CLAIM",
  );
  const records = fixture.snapshot.payloads[0]!;
  const last = records.endsWith("00") ? "01" : "00";
  await assert.rejects(
    async () =>
      execute({
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          payloads: Object.freeze([`${records.slice(0, -2)}${last}` as `0x${string}`]),
        },
      }),
    (error: unknown) =>
      error instanceof DeadlineAdapterError && error.code === "INVALID_COMMITMENT",
  );
});
