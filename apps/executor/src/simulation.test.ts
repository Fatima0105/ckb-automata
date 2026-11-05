import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1 } from "@ckb-automata/molecule";
import { bytesToHex, rawTransactionToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  parseShannons,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import {
  SimulationGateService,
  type SimulationAttempt,
  type SimulationRecord,
  type SimulationStore,
} from "./simulation.ts";
import { operatorLockArgs } from "./signing.ts";

const PRIVATE_KEY = `0x${"01".repeat(32)}`;
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000073";

function rewardLock(): ScriptIdentity {
  return Object.freeze({
    codeHash: parseHash32(`0x${"88".repeat(32)}`),
    hashType: "type",
    args: operatorLockArgs(PRIVATE_KEY),
  });
}

function jobData(reward: bigint): `0x${string}` {
  return bytesToHex(
    JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: Array(32).fill(1),
      sequence: "0",
      state: 0,
      trigger_kind: 0,
      trigger_params_hash: Array(32).fill(2),
      policy_script_hash: Array(32).fill(3),
      payload_hash: Array(32).fill(4),
      reward: reward.toString(),
      remaining_budget: reward.toString(),
      not_before: "1",
      not_after: "0",
      remaining_runs: 1,
      cancel_lock_hash: Array(32).fill(5),
    }),
  ) as `0x${string}`;
}

function fixture(reward = 5_000_000_000n): SimulationAttempt {
  const jobHash = parseHash32(`0x${"11".repeat(32)}`);
  const feeHash = parseHash32(`0x${"22".repeat(32)}`);
  const applicationHash = parseHash32(`0x${"33".repeat(32)}`);
  const lock = rewardLock();
  const ownerLock = Object.freeze({ ...lock, args: `0x${"44".repeat(20)}` as const });
  const transaction: UnsignedDeadlineTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: "0x0",
        previousOutput: Object.freeze({ txHash: jobHash, index: "0x0" }),
      }),
      Object.freeze({
        since: "0x0",
        previousOutput: Object.freeze({ txHash: feeHash, index: "0x0" }),
      }),
      Object.freeze({
        since: "0x0",
        previousOutput: Object.freeze({ txHash: applicationHash, index: "0x0" }),
      }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ capacity: `0x${reward.toString(16)}` as const, lock, type: null }),
      Object.freeze({ capacity: "0x37e11d600" as const, lock: ownerLock, type: null }),
      Object.freeze({ capacity: "0x253fca1c0" as const, lock, type: null }),
      Object.freeze({ capacity: "0x12a05f200" as const, lock: ownerLock, type: null }),
    ]),
    outputsData: Object.freeze(["0x" as const, "0x" as const, "0x" as const, "0x" as const]),
    witnesses: Object.freeze(["0x" as const, "0x" as const, "0x1234" as const]),
  });
  const intentHash = parseHash32(
    rawTransactionToHash(transaction as unknown as Parameters<typeof rawTransactionToHash>[0]),
  );
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    intentHash,
    transaction: JSON.parse(JSON.stringify(transaction)) as Record<string, unknown>,
    snapshot: Object.freeze({
      job: Object.freeze({
        outPoint: Object.freeze({ txHash: jobHash, index: "0" }),
        output: Object.freeze({ capacity: "0x4a817c800" }),
        data: jobData(reward),
      }),
      applicationCells: Object.freeze([
        Object.freeze({
          outPoint: Object.freeze({ txHash: applicationHash, index: "0" }),
          output: Object.freeze({ capacity: "0x12a05f200", lock: ownerLock, type: null }),
        }),
      ]),
      feeCells: Object.freeze([
        Object.freeze({
          outPoint: Object.freeze({ txHash: feeHash, index: "0" }),
          output: Object.freeze({ capacity: "0x2540be400", lock, type: null }),
        }),
      ]),
    }),
  });
}

class MemoryStore implements SimulationStore {
  readonly attempt: SimulationAttempt;
  approved: SimulationRecord | undefined;
  rejected: string | undefined;

  constructor(attempt = fixture()) {
    this.attempt = attempt;
  }

  async load(attemptId: string, intentHash: string): Promise<SimulationAttempt | undefined> {
    return attemptId === this.attempt.attemptId && intentHash === this.attempt.intentHash
      ? this.attempt
      : undefined;
  }

  async approve(_attempt: SimulationAttempt, record: SimulationRecord): Promise<boolean> {
    this.approved = record;
    return true;
  }

  async reject(_attempt: SimulationAttempt, errorCode: string): Promise<void> {
    this.rejected = errorCode;
  }
}

function service(
  store: MemoryStore,
  options: { readonly cycles?: bigint; readonly margin?: bigint; readonly fail?: boolean } = {},
) {
  const signed: UnsignedDeadlineTransaction[] = [];
  return {
    signed,
    gate: new SimulationGateService({
      store,
      chain: {
        async dryRun(transaction) {
          signed.push(transaction);
          if (options.fail) throw new Error("node rejected the transaction");
          return options.cycles ?? 1_000n;
        },
      },
      rewardLock: rewardLock(),
      privateKey: PRIVATE_KEY,
      transactionFee: parseShannons("1000000"),
      maxCycles: 10_000n,
      minimumMargin: parseShannons(options.margin ?? 1_000_000n),
    }),
  };
}

test("a profitable dry-run records bounded simulation evidence", async () => {
  const store = new MemoryStore();
  const { gate, signed } = service(store);
  const result = await gate.evaluate({
    attemptId: store.attempt.attemptId,
    intentHash: store.attempt.intentHash,
  });
  assert.equal(result.status, "approved");
  assert.deepEqual(store.approved, {
    cycles: "1000",
    fee: "1000000",
    reward: "5000000000",
    margin: "4999000000",
    intentHash: store.attempt.intentHash,
    feeInputIndex: 1,
  });
  assert.equal(store.rejected, undefined);
  assert.equal(signed.length, 1);
  assert.notEqual(signed[0]?.witnesses[1], "0x");
  assert.equal(signed[0]?.witnesses[2], "0x1234");
});

test("uneconomic or altered rewards are rejected before node execution", async () => {
  const uneconomic = new MemoryStore();
  const first = service(uneconomic, { margin: 5_000_000_000n });
  const result = await first.gate.evaluate({
    attemptId: uneconomic.attempt.attemptId,
    intentHash: uneconomic.attempt.intentHash,
  });
  assert.deepEqual(result, {
    status: "rejected",
    attemptId: ATTEMPT_ID,
    errorCode: "EXECUTOR_UNPROFITABLE",
  });
  assert.equal(first.signed.length, 0);

  const alteredAttempt = fixture();
  const alteredTransaction = structuredClone(alteredAttempt.transaction);
  const outputs = alteredTransaction["outputs"] as Record<string, unknown>[];
  outputs[0]!["capacity"] = "0x1";
  const altered = new MemoryStore({ ...alteredAttempt, transaction: alteredTransaction });
  const second = service(altered);
  const rejected = await second.gate.evaluate({
    attemptId: altered.attempt.attemptId,
    intentHash: altered.attempt.intentHash,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(altered.rejected, "EXECUTOR_BUILD_RECORD_INVALID");
  assert.equal(second.signed.length, 0);
});

test("node rejection and excessive cycles never approve an attempt", async () => {
  const rejectedStore = new MemoryStore();
  const rejectedGate = service(rejectedStore, { fail: true });
  const rejected = await rejectedGate.gate.evaluate({
    attemptId: ATTEMPT_ID,
    intentHash: rejectedStore.attempt.intentHash,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejectedStore.rejected, "EXECUTOR_SIMULATION_REJECTED");
  assert.equal(rejectedStore.approved, undefined);

  const expensiveStore = new MemoryStore();
  const expensiveGate = service(expensiveStore, { cycles: 10_001n });
  const expensive = await expensiveGate.gate.evaluate({
    attemptId: ATTEMPT_ID,
    intentHash: expensiveStore.attempt.intentHash,
  });
  assert.equal(expensive.status, "rejected");
  assert.equal(expensiveStore.rejected, "EXECUTOR_CYCLE_LIMIT_EXCEEDED");
  assert.equal(expensiveStore.approved, undefined);
});
