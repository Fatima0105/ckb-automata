import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredDeployment } from "@ckb-automata/core";

import {
  LiveJobReconciler,
  RECONCILIATION_INITIAL_LOOKBACK_BLOCKS,
  RECONCILIATION_PAGE_SIZE,
} from "./reconciliation.ts";

const deployment = {
  network: "ckb_testnet",
  confirmation: { requiredDepth: 24 },
  contracts: {
    "job-lock": {
      script: { codeHash: `0x${"11".repeat(32)}`, hashType: "data1", args: "0x" },
    },
  },
} as unknown as RegisteredDeployment;

function block(number: bigint) {
  return { header: { number }, transactions: [] } as never;
}

test("reconciles only confirmed Job Cell transaction blocks ahead of a stale checkpoint", async () => {
  const queries: unknown[][] = [];
  const loadedBlocks: bigint[] = [];
  const discoveries: bigint[] = [];
  const transitions: bigint[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const reconciler = new LiveJobReconciler(
    {
      getTipHeader: async () => ({ number: 150n }),
      findTransactionsPaged: async (...args: unknown[]) => {
        queries.push(args);
        return {
          lastCursor: "done",
          transactions: [
            { blockNumber: 120n, cells: [], txHash: `0x${"22".repeat(32)}`, txIndex: 0n },
            { blockNumber: 110n, cells: [], txHash: `0x${"33".repeat(32)}`, txIndex: 0n },
            { blockNumber: 120n, cells: [], txHash: `0x${"44".repeat(32)}`, txIndex: 1n },
          ],
        };
      },
      getBlockByNumber: async (number: bigint) => {
        loadedBlocks.push(number);
        return block(number);
      },
    } as never,
    { load: async () => ({ blockNumber: 100n }) } as never,
    {
      projectBlock: async (candidate: { header: { number: bigint } }) => {
        discoveries.push(candidate.header.number);
        return {} as never;
      },
    },
    {
      indexBlock: async (candidate: { header: { number: bigint } }) => {
        transitions.push(candidate.header.number);
        return {} as never;
      },
    },
    {
      error: () => undefined,
      info: (_event, _message, fields = {}) => logs.push(fields),
    },
    { enabled: true, loadDeployment: async () => deployment },
  );

  assert.deepEqual(await reconciler.runOnce(), {
    firstBlock: 101n,
    lastBlock: 127n,
    projectedBlocks: 2,
    stableTip: 127n,
  });
  assert.deepEqual(loadedBlocks, [110n, 120n]);
  assert.deepEqual(discoveries, [110n, 120n]);
  assert.deepEqual(transitions, [110n, 120n]);
  assert.equal(queries.length, 1);
  const [query] = queries;
  assert.ok(query);
  assert.deepEqual(query.slice(1), ["asc", RECONCILIATION_PAGE_SIZE, undefined]);
  assert.deepEqual((query[0] as { filter: { blockRange: bigint[] } }).filter.blockRange, [
    101n,
    128n,
  ]);
  assert.equal(logs[0]?.["projectedBlocks"], 2);
});

test("reconciles V2 Job Cell blocks and projects each canonical block once", async () => {
  const queries: string[] = [];
  const v2Blocks: bigint[] = [];
  const reconciler = new LiveJobReconciler(
    {
      getTipHeader: async () => ({ number: 150n }),
      findTransactionsPaged: async (query: { script: { codeHash: string } }) => {
        queries.push(query.script.codeHash);
        return {
          lastCursor: "done",
          transactions: [
            { blockNumber: 120n, cells: [], txHash: `0x${"22".repeat(32)}`, txIndex: 0n },
          ],
        };
      },
      getBlockByNumber: async (number: bigint) => block(number),
    } as never,
    { load: async () => ({ blockNumber: 100n }) } as never,
    { projectBlock: async () => undefined } as never,
    { indexBlock: async () => undefined } as never,
    { error: () => undefined, info: () => undefined },
    {
      enabled: true,
      loadDeployment: async () => deployment,
      daoHarvestV2: {
        deployment: {
          contracts: {
            jobLock: { codeHash: `0x${"55".repeat(32)}` },
            vaultLock: { codeHash: `0x${"66".repeat(32)}` },
            compensationLock: { codeHash: `0x${"77".repeat(32)}` },
          },
        } as never,
        indexer: {
          projectBlock: async (candidate: { header: { number: bigint } }) => {
            v2Blocks.push(candidate.header.number);
            return {} as never;
          },
        },
      },
    },
  );

  assert.equal((await reconciler.runOnce()).projectedBlocks, 1);
  assert.deepEqual(queries, [
    deployment.contracts["job-lock"].script.codeHash,
    `0x${"55".repeat(32)}`,
    `0x${"66".repeat(32)}`,
    `0x${"77".repeat(32)}`,
  ]);
  assert.deepEqual(v2Blocks, [120n]);
});

test("remembers the reconciled tip and scans only the new confirmed range", async () => {
  let tip = 150n;
  const ranges: bigint[][] = [];
  const reconciler = new LiveJobReconciler(
    {
      getTipHeader: async () => ({ number: tip }),
      findTransactionsPaged: async (query: { filter: { blockRange: bigint[] } }) => {
        ranges.push(query.filter.blockRange);
        return { lastCursor: "done", transactions: [] };
      },
      getBlockByNumber: async () => assert.fail("empty ranges must not load blocks"),
    } as never,
    { load: async () => ({ blockNumber: 100n }) } as never,
    { projectBlock: async () => assert.fail("empty ranges must not project") } as never,
    { indexBlock: async () => assert.fail("empty ranges must not project") } as never,
    { error: () => undefined, info: () => undefined },
    { enabled: true, loadDeployment: async () => deployment },
  );

  await reconciler.runOnce();
  tip = 151n;
  await reconciler.runOnce();
  assert.deepEqual(ranges, [
    [101n, 128n],
    [128n, 129n],
  ]);
});

test("an empty checkpoint uses the bounded initial lookback", async () => {
  let range: bigint[] | undefined;
  const reconciler = new LiveJobReconciler(
    {
      getTipHeader: async () => ({ number: 1_000n }),
      findTransactionsPaged: async (query: { filter: { blockRange: bigint[] } }) => {
        range = query.filter.blockRange;
        return { lastCursor: "done", transactions: [] };
      },
      getBlockByNumber: async () => undefined,
    } as never,
    { load: async () => undefined } as never,
    { projectBlock: async () => undefined } as never,
    { indexBlock: async () => undefined } as never,
    { error: () => undefined, info: () => undefined },
    { enabled: true, loadDeployment: async () => deployment },
  );

  await reconciler.runOnce();
  const stable = 1_000n - 23n;
  assert.deepEqual(range, [stable - RECONCILIATION_INITIAL_LOOKBACK_BLOCKS + 1n, stable + 1n]);
});

test("disabled reconciliation never schedules chain work", () => {
  let loaded = false;
  const reconciler = new LiveJobReconciler(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { error: () => undefined, info: () => undefined },
    {
      enabled: false,
      loadDeployment: async () => {
        loaded = true;
        return deployment;
      },
    },
  );
  reconciler.start();
  reconciler.onApplicationBootstrap();
  reconciler.onApplicationShutdown();
  assert.equal(loaded, false);
});
