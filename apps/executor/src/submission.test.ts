import assert from "node:assert/strict";
import test from "node:test";

import { ErrorClientDuplicatedTransaction } from "@ckb-ccc/shell";
import { rawTransactionToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type UnsignedDeadlineTransaction } from "@ckb-automata/core";

import {
  SubmissionService,
  type SubmissionAcceptance,
  type SubmissionAttempt,
  type SubmissionStore,
} from "./submission.ts";

const PRIVATE_KEY = `0x${"01".repeat(32)}`;
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000074";

function transaction(): UnsignedDeadlineTransaction {
  return Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: "0x0",
        previousOutput: Object.freeze({
          txHash: parseHash32(`0x${"11".repeat(32)}`),
          index: "0x0" as const,
        }),
      }),
      Object.freeze({
        since: "0x0",
        previousOutput: Object.freeze({
          txHash: parseHash32(`0x${"22".repeat(32)}`),
          index: "0x0" as const,
        }),
      }),
    ]),
    outputs: Object.freeze([]),
    outputsData: Object.freeze([]),
    witnesses: Object.freeze(["0x1234" as const, "0x" as const]),
  });
}

function awaiting(): SubmissionAttempt {
  const unsigned = transaction();
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    intentHash: parseHash32(
      rawTransactionToHash(unsigned as unknown as Parameters<typeof rawTransactionToHash>[0]),
    ),
    state: "awaiting_signature",
    transaction: JSON.parse(JSON.stringify(unsigned)) as Record<string, unknown>,
    feeInputIndex: 1,
  });
}

class MemoryStore implements SubmissionStore {
  attempt: SubmissionAttempt | undefined;
  readonly acceptances: SubmissionAcceptance[] = [];

  constructor(attempt: SubmissionAttempt | undefined = awaiting()) {
    this.attempt = attempt;
  }

  async load(attemptId: string, intentHash: string): Promise<SubmissionAttempt | undefined> {
    return this.attempt?.attemptId === attemptId && this.attempt.intentHash === intentHash
      ? this.attempt
      : undefined;
  }

  async markSubmitted(
    attempt: SubmissionAttempt,
    transactionHash: string,
    acceptance: SubmissionAcceptance,
  ): Promise<boolean> {
    if (this.attempt?.state !== "awaiting_signature") return false;
    this.acceptances.push(acceptance);
    this.attempt = Object.freeze({
      attemptId: attempt.attemptId,
      intentHash: attempt.intentHash,
      state: "submitted",
      transactionHash: parseHash32(transactionHash),
    });
    return true;
  }
}

function payload(attempt: SubmissionAttempt) {
  return Object.freeze({ attemptId: attempt.attemptId, intentHash: attempt.intentHash });
}

test("broadcast preserves the signed transaction hash and records acceptance once", async () => {
  const store = new MemoryStore();
  const sent: UnsignedDeadlineTransaction[] = [];
  const expected = store.attempt!;
  const service = new SubmissionService({
    store,
    privateKey: PRIVATE_KEY,
    chain: {
      async send(signed) {
        sent.push(signed);
        return expected.intentHash;
      },
      async getTransactionStatus() {
        throw new Error("hash lookup must not run after a successful response");
      },
    },
  });
  const result = await service.submit(payload(expected));
  assert.deepEqual(result, {
    status: "submitted",
    attemptId: ATTEMPT_ID,
    transactionHash: expected.intentHash,
    acceptance: "broadcast",
  });
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0]?.witnesses[1], "0x");
  assert.deepEqual(store.acceptances, ["broadcast"]);

  const replay = await service.submit(payload(expected));
  assert.equal(replay.status, "already_submitted");
  assert.equal(sent.length, 1);
});

test("a duplicate-known response is accepted only for the preserved hash", async () => {
  const store = new MemoryStore();
  const expected = store.attempt!;
  let duplicateHash = expected.intentHash;
  const service = new SubmissionService({
    store,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        const duplicate = new ErrorClientDuplicatedTransaction(
          { message: "duplicate", data: "duplicate" },
          duplicateHash,
        );
        throw new Error("submission failed", { cause: duplicate });
      },
      async getTransactionStatus() {
        throw new Error("duplicate classification must not need a lookup");
      },
    },
  });
  const result = await service.submit(payload(expected));
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") assert.equal(result.acceptance, "duplicate_known");

  const mismatched = new MemoryStore();
  duplicateHash = parseHash32(`0x${"99".repeat(32)}`);
  const mismatchedService = new SubmissionService({
    store: mismatched,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        const duplicate = new ErrorClientDuplicatedTransaction(
          { message: "duplicate", data: "duplicate" },
          duplicateHash,
        );
        throw new Error("submission failed", { cause: duplicate });
      },
      async getTransactionStatus() {
        throw new Error("mismatched duplicates must fail before lookup");
      },
    },
  });
  await assert.rejects(
    mismatchedService.submit(payload(mismatched.attempt!)),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, "code") === "EXECUTOR_SUBMISSION_HASH_MISMATCH",
  );
});

test("an ambiguous send failure resolves by exact hash instead of blind broadcast", async () => {
  const store = new MemoryStore();
  const expected = store.attempt!;
  let sends = 0;
  const accepted = new SubmissionService({
    store,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        sends += 1;
        throw new Error("endpoint timed out");
      },
      async getTransactionStatus(transactionHash) {
        assert.equal(transactionHash, expected.intentHash);
        return {
          status: "pending",
          transaction: { hash: () => expected.intentHash },
        };
      },
    },
  });
  const result = await accepted.submit(payload(expected));
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") assert.equal(result.acceptance, "hash_lookup");
  assert.equal(sends, 1);

  const unknownStore = new MemoryStore();
  const unknown = new SubmissionService({
    store: unknownStore,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        throw new Error("endpoint timed out");
      },
      async getTransactionStatus() {
        return undefined;
      },
    },
  });
  await assert.rejects(unknown.submit(payload(unknownStore.attempt!)), /endpoint timed out/);
  assert.deepEqual(unknownStore.acceptances, []);

  const wrongLookupStore = new MemoryStore();
  const wrongLookup = new SubmissionService({
    store: wrongLookupStore,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        throw new Error("endpoint timed out");
      },
      async getTransactionStatus() {
        return {
          status: "pending",
          transaction: { hash: () => parseHash32(`0x${"55".repeat(32)}`) },
        };
      },
    },
  });
  await assert.rejects(
    wrongLookup.submit(payload(wrongLookupStore.attempt!)),
    /endpoint timed out/,
  );
  assert.deepEqual(wrongLookupStore.acceptances, []);
});

test("a node-returned hash mismatch never advances the attempt", async () => {
  const store = new MemoryStore();
  const expected = store.attempt!;
  const service = new SubmissionService({
    store,
    privateKey: PRIVATE_KEY,
    chain: {
      async send() {
        return parseHash32(`0x${"77".repeat(32)}`);
      },
      async getTransactionStatus() {
        return undefined;
      },
    },
  });
  await assert.rejects(
    service.submit(payload(expected)),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, "code") === "EXECUTOR_SUBMISSION_HASH_MISMATCH",
  );
  assert.deepEqual(store.acceptances, []);
});

test("submission refuses an unverified or out-of-range fee input index", async () => {
  const base = awaiting();
  const { feeInputIndex: _verifiedIndex, ...withoutFeeInputIndex } = base;
  const attempts: readonly SubmissionAttempt[] = Object.freeze([
    Object.freeze(withoutFeeInputIndex),
    Object.freeze({ ...base, feeInputIndex: 2 }),
  ]);
  for (const attempt of attempts) {
    const store = new MemoryStore(attempt);
    let sends = 0;
    const service = new SubmissionService({
      store,
      privateKey: PRIVATE_KEY,
      chain: {
        async send() {
          sends += 1;
          return attempt.intentHash;
        },
        async getTransactionStatus() {
          return undefined;
        },
      },
    });
    await assert.rejects(
      service.submit(payload(attempt)),
      (error: unknown) =>
        error instanceof Error &&
        Reflect.get(error, "code") === "EXECUTOR_SUBMISSION_RECORD_INVALID",
    );
    assert.equal(sends, 0);
  }
});
