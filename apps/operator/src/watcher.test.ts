import assert from "node:assert/strict";
import test from "node:test";

import type { Hash32 } from "@ckb-automata/core";

import type { OperatorConfiguration } from "./config.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { createOperatorWatcher } from "./watcher.ts";

const hash = (value: string): Hash32 => `0x${value.repeat(64).slice(0, 64)}` as Hash32;

function config(overrides: Partial<OperatorConfiguration> = {}): OperatorConfiguration {
  return Object.freeze({
    rpcUrl: "https://rpc.example/",
    indexerUrl: "https://indexer.example/",
    privateKey: `0x${"1".repeat(64)}`,
    minimumProfitMargin: 0n,
    feeRatePerKilobyte: 1_000n,
    transactionFee: 50_000n,
    confirmationDepth: 5n,
    healthPort: 9464,
    watcherEnabled: true,
    watcherPollIntervalMs: 60_000,
    watcherRetryBaseMs: 1_000,
    watcherRetryMaximumMs: 8_000,
    watcherConfirmationTimeoutMs: 60_000,
    watcherMaximumJobsPerScan: 100,
    operatorServices: ["deadline", "recurring"] as const,
    ...overrides,
  });
}

const rpc: JsonRpcClient = Object.freeze({
  async call<T>(): Promise<T> {
    throw new Error("unexpected RPC call");
  },
});

const job = Object.freeze({
  service: "deadline" as const,
  kind: "scheduled" as const,
  jobId: hash("1"),
  sequence: "0",
  state: 0,
  notBeforeSince: "100",
  takeoverBlock: "112",
  remainingRuns: "1",
  outPoint: Object.freeze({ txHash: hash("2"), index: "0" }),
  blockNumber: "90",
});

test("watcher submits once and suppresses a confirmed job until discovery advances", async () => {
  let executions = 0;
  let confirmation = "pending";
  let jobs = [job] as readonly (typeof job)[];
  const watcher = createOperatorWatcher(
    { config: config(), rpc, indexer: rpc },
    {
      discover: async () => jobs,
      execute: async () => {
        executions += 1;
        return hash("3");
      },
      confirm: async () => confirmation,
    },
  );

  await watcher.runOnce();
  await watcher.runOnce();
  assert.equal(executions, 1);
  assert.equal(watcher.snapshot().pendingTransactions, 1);

  confirmation = "confirmed";
  await watcher.runOnce();
  assert.equal(executions, 1);
  assert.equal(watcher.snapshot().confirmedTransactions, 1);

  jobs = [];
  await watcher.runOnce();
  jobs = [job];
  await watcher.runOnce();
  assert.equal(executions, 2);
});

test("watcher applies bounded per-job retry backoff", async () => {
  let currentTime = 1_000;
  let executions = 0;
  const watcher = createOperatorWatcher(
    { config: config(), rpc, indexer: rpc },
    {
      now: () => currentTime,
      discover: async () => [job],
      execute: async () => {
        executions += 1;
        throw new Error("not eligible yet");
      },
    },
  );

  await watcher.runOnce();
  await watcher.runOnce();
  assert.equal(executions, 1);
  currentTime += 1_000;
  await watcher.runOnce();
  assert.equal(executions, 2);
  currentTime += 1_999;
  await watcher.runOnce();
  assert.equal(executions, 2);
  currentTime += 1;
  await watcher.runOnce();
  assert.equal(executions, 3);
});

test("watcher serializes overlapping scans and drains on close", async () => {
  let release: (() => void) | undefined;
  let discoveries = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const watcher = createOperatorWatcher(
    { config: config(), rpc, indexer: rpc },
    {
      discover: async () => {
        discoveries += 1;
        await gate;
        return [];
      },
    },
  );

  const first = watcher.runOnce();
  const second = watcher.runOnce();
  release?.();
  await Promise.all([first, second]);
  assert.equal(discoveries, 1);
  await watcher.close();
  assert.equal(watcher.snapshot().status, "stopped");
});

test("watcher allows only one submitted transaction at a time", async () => {
  let executions = 0;
  const second = Object.freeze({
    ...job,
    jobId: hash("4"),
    outPoint: Object.freeze({ txHash: hash("5"), index: "0" }),
  });
  const watcher = createOperatorWatcher(
    { config: config(), rpc, indexer: rpc },
    {
      discover: async () => [job, second],
      execute: async () => {
        executions += 1;
        return hash("6");
      },
      confirm: async () => "pending",
    },
  );

  await watcher.runOnce();
  await watcher.runOnce();
  assert.equal(executions, 1);
  assert.equal(watcher.snapshot().pendingTransactions, 1);
});
