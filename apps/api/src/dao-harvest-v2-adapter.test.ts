import assert from "node:assert/strict";
import test from "node:test";

import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  type CellDepIdentity,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import {
  DaoHarvestV2TransactionAdapter,
  type DaoHarvestV2Deployment,
} from "./dao-harvest-v2-adapter.ts";

const hash = (value: string) => parseHash32(`0x${value.repeat(64)}`);
const outPoint = (value: string, index: `0x${string}` = "0x0") => ({
  txHash: hash(value),
  index,
});
const cellDep = (value: string): CellDepIdentity => ({
  outPoint: outPoint(value),
  depType: "code",
});

const owner: ScriptIdentity = {
  codeHash: hash("a"),
  hashType: "type",
  args: `0x${"12".repeat(20)}`,
};
const payout: ScriptIdentity = {
  codeHash: hash("a"),
  hashType: "type",
  args: `0x${"34".repeat(20)}`,
};
const ownerLockHash = scriptToHash(owner);
const payoutLockHash = scriptToHash(payout);

const deployment: DaoHarvestV2Deployment = {
  genesisHash: hash("1"),
  secp256k1Blake160: { codeHash: hash("2"), hashType: "type", cellDep: cellDep("2") },
  nervosDao: { codeHash: hash("3"), hashType: "type", cellDep: cellDep("3") },
  contracts: {
    jobLock: { codeHash: hash("4"), hashType: "data1", cellDep: cellDep("4") },
    policy: { codeHash: hash("5"), hashType: "data1", cellDep: cellDep("5") },
    vaultLock: { codeHash: hash("6"), hashType: "data1", cellDep: cellDep("6") },
    compensationLock: { codeHash: hash("7"), hashType: "data1", cellDep: cellDep("7") },
  },
  preferredPrepareOperatorLockHash: hash("8"),
  fallbackPrepareOperatorLockHashes: [hash("9")],
};

function chain(lock: ScriptIdentity = owner) {
  return {
    getCellLive: async () =>
      ({
        cellOutput: { capacity: 700n * 100_000_000n, lock, type: undefined },
        outputData: { toString: () => "0x" },
      }) as never,
    getTipHeader: async () =>
      ({
        epoch: { integer: 13_920n, numerator: 1_151n, denominator: 1_800n },
        hash: hash("b"),
        number: 22_583_952n,
      }) as never,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    creatorNonce: "42",
    identityOutPoint: outPoint("c"),
    ownerLock: owner,
    ownerLockHash,
    payoutLock: payout,
    payoutLockHash,
    principal: "24200000000",
    totalCycles: 2,
    ...overrides,
  };
}

test("V2 setup binds a live owner input and creates the exact three-cell state", async () => {
  const adapter = new DaoHarvestV2TransactionAdapter(chain(), deployment);
  const first = await adapter.build("setup", request());
  const second = await adapter.build("setup", request());
  const transaction = first.transaction as UnsignedDeadlineTransaction;
  assert.deepEqual(second, first);
  assert.equal(first.version, 2);
  assert.equal(first.operation, "setup");
  assert.match(first.jobId, /^0x[0-9a-f]{64}$/);
  assert.equal(transaction.inputs.length, 1);
  assert.deepEqual(transaction.inputs[0]!.previousOutput, outPoint("c"));
  assert.equal(transaction.outputs.length, 3);
  assert.equal(BigInt(transaction.outputs[0]!.capacity), 400n * 100_000_000n);
  assert.equal(BigInt(transaction.outputs[1]!.capacity), 242n * 100_000_000n);
  assert.equal(BigInt(transaction.outputs[2]!.capacity), 201n * 100_000_000n);
  assert.equal(transaction.outputs[1]!.type?.codeHash, deployment.nervosDao.codeHash);
  assert.equal(transaction.outputsData[1], "0x0000000000000000");
  assert.equal(first.completion.requiredInputCount, 1);
  assert.deepEqual(first.completion.allowedFundingLockHashes, [ownerLockHash]);
  assert.equal(first.review.originalAmount, "24200000000");
  assert.equal(first.review.recoverableReserve, "20100000000");
  assert.equal(first.review.completedWorkCharges.maximumTotal, "500000000");
  assert.equal(first.review.totalLockedAmount, "84300000000");

  const changedNonce = await adapter.build("setup", request({ creatorNonce: "43" }));
  assert.notEqual(changedNonce.jobId, first.jobId);
});

test("V2 setup rejects stale identity cells, wrong owners, weak principal, and extra fields", async () => {
  const missing = new DaoHarvestV2TransactionAdapter(
    { ...chain(), getCellLive: async () => undefined },
    deployment,
  );
  await assert.rejects(missing.build("setup", request()), /no longer live/);
  await assert.rejects(
    new DaoHarvestV2TransactionAdapter(chain(payout), deployment).build("setup", request()),
    /not a plain owner cell/,
  );
  const adapter = new DaoHarvestV2TransactionAdapter(chain(), deployment);
  await assert.rejects(adapter.build("setup", request({ principal: "24199999999" })), /242 CKB/);
  await assert.rejects(
    adapter.build("setup", request({ unsupported: true })),
    /unsupported fields/,
  );
  await assert.rejects(
    adapter.build("setup", request({ ownerLockHash: payoutLockHash })),
    /reviewed hashes/,
  );
  await assert.rejects(adapter.build("sweep", {}), /after the harvest automation is indexed/);
});

test("V2 setup registration accepts only a chain-known setup and stores a pending marker", async () => {
  const txHash = hash("f");
  let observed: unknown;
  const inserted: Record<string, unknown>[] = [];
  const database = {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        inserted.push(value);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  } as never;
  const adapter = new DaoHarvestV2TransactionAdapter(
    {
      ...chain(),
      getTransactionStatus: async () => observed as never,
    },
    deployment,
    database,
    "ckb_testnet",
  );
  const build = await adapter.build("setup", request());
  observed = {
    status: "pending",
    transaction: {
      ...(build.transaction as UnsignedDeadlineTransaction),
      hash: () => txHash,
    },
  };
  const pending = await adapter.registerSetup(txHash);
  assert.equal(pending.transactionHash, txHash);
  assert.equal(pending.status, "submitting");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.["networkId"], "ckb_testnet");
  const stored = inserted[0];
  assert.ok(stored);
  assert.equal((stored["simulation"] as Record<string, unknown>)["kind"], "pending_dao_harvest_v2");

  observed = undefined;
  await assert.rejects(adapter.registerSetup(txHash), /not known on CKB/);
});
