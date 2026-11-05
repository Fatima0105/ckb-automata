import assert from "node:assert/strict";
import test from "node:test";

import { rawTransactionToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type UnsignedDeadlineTransaction } from "@ckb-automata/core";

import { operatorLockArgs, signOperatorFeeInput } from "./signing.ts";

const PRIVATE_KEY = `0x${"01".repeat(32)}`;

function transaction(): UnsignedDeadlineTransaction {
  return Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: "0x0",
        previousOutput: {
          txHash: parseHash32(`0x${"11".repeat(32)}`),
          index: "0x0" as const,
        },
      }),
      Object.freeze({
        since: "0x0",
        previousOutput: {
          txHash: parseHash32(`0x${"22".repeat(32)}`),
          index: "0x0" as const,
        },
      }),
    ]),
    outputs: Object.freeze([]),
    outputsData: Object.freeze([]),
    witnesses: Object.freeze(["0x1234" as const, "0x" as const]),
  });
}

test("operator signing derives the configured lock and preserves raw intent", () => {
  assert.equal(operatorLockArgs(PRIVATE_KEY), "0xb6ac779881b4fe05a167e413ff534469b6b5f6c0");
  const unsigned = transaction();
  const signed = signOperatorFeeInput(unsigned, PRIVATE_KEY, 1);
  assert.equal(signed.witnesses[0], unsigned.witnesses[0]);
  assert.match(signed.witnesses[1] ?? "", /^0x[0-9a-f]+$/);
  assert.notEqual(signed.witnesses[1], "0x");
  assert.equal(
    rawTransactionToHash(signed as unknown as Parameters<typeof rawTransactionToHash>[0]),
    rawTransactionToHash(unsigned as unknown as Parameters<typeof rawTransactionToHash>[0]),
  );
  assert.deepEqual(signOperatorFeeInput(unsigned, PRIVATE_KEY, 1), signed);
});

test("operator signing rejects invalid keys and input indices", () => {
  assert.throws(() => operatorLockArgs("redacted"), /invalid/);
  assert.throws(() => signOperatorFeeInput(transaction(), PRIVATE_KEY, 2), /input index/);
});

test("operator signing uses the explicitly verified input rather than a positional default", () => {
  const unsigned = transaction();
  const signed = signOperatorFeeInput(unsigned, PRIVATE_KEY, 0);
  assert.notEqual(signed.witnesses[0], unsigned.witnesses[0]);
  assert.equal(signed.witnesses[1], unsigned.witnesses[1]);
});
