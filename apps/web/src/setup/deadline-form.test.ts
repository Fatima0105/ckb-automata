import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import {
  clientAcceptsDeadlineRequest,
  deadlineTarget,
  scheduleToBlock,
  validateDeadlineStep,
} from "./deadline-form.ts";
import { ckbToShannons } from "./ckb-amount.ts";

const STANDARD_LOCK = Object.freeze({
  codeHash: parseHash32(`0x${"11".repeat(32)}`),
  hashType: "type" as const,
  args: `0x${"22".repeat(20)}` as const,
});
const CCC_LOCK = Object.freeze({ ...STANDARD_LOCK, args: `0x${"22".repeat(22)}` as const });

interface Fixture {
  readonly valid: Record<string, unknown> & {
    readonly pledges: readonly Record<string, unknown>[];
  };
  readonly invalid: readonly {
    readonly name: string;
    readonly patch?: Readonly<Record<string, unknown>>;
    readonly pledgePatch?: Readonly<Record<string, unknown>>;
    readonly outPointPatch?: Readonly<Record<string, unknown>>;
  }[];
}

function invalidRequest(valid: Fixture["valid"], invalid: Fixture["invalid"][number]) {
  const pledge = valid.pledges[0] ?? {};
  const outPoint = (pledge["outPoint"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...valid,
    ...invalid.patch,
    pledges: [
      {
        ...pledge,
        ...invalid.pledgePatch,
        outPoint: { ...outPoint, ...invalid.outPointPatch },
      },
    ],
  };
}

test("deadline form converts CKB without floating-point loss", () => {
  assert.equal(ckbToShannons("61"), "6100000000");
  assert.equal(ckbToShannons("61.00000001"), "6100000001");
  assert.equal(ckbToShannons("184467440737.09551615"), "18446744073709551615");
  assert.equal(ckbToShannons("90071992.54740993"), "9007199254740993");
  assert.throws(() => ckbToShannons("1.000000001"));
  assert.throws(() => ckbToShannons("01"));
});

test("deadline outcome derives the hidden target without exposing condition amounts", () => {
  assert.equal(deadlineTarget("61", "success"), "6100000000");
  assert.equal(deadlineTarget("61", "refund"), "6100000001");
  assert.throws(() => deadlineTarget("61", "unknown"), /Choose whether/);
});

test("deadline schedule converts future local time from the current tip", () => {
  const now = Date.parse("2026-09-26T10:00:00.000Z");
  assert.equal(scheduleToBlock("2026-09-26T10:02:00.000Z", "100", now), "112");
  assert.throws(() => scheduleToBlock("2026-09-26T09:59:59.000Z", "100", now), /future/);
});

test("deadline form rejects the connected wallet as the recipient", async () => {
  const ownerLockHash = `0x${"22".repeat(32)}`;
  const errors = await validateDeadlineStep(
    "details",
    {
      pledgeCkb: "61",
      outcome: "success",
      successAddress: "owner",
      refundAddress: "refund",
    },
    {
      ownerLockHash,
      resolveLock: async () => STANDARD_LOCK,
      resolveLockHash: async (address) =>
        address === "owner" ? ownerLockHash : `0x${"33".repeat(32)}`,
      walletReady: true,
    },
  );
  assert.equal(
    errors["successAddress"],
    "Recipient address must be different from your connected wallet.",
  );
});

test("deadline form uses the larger recipient or refund address minimum", async () => {
  const errors = await validateDeadlineStep(
    "details",
    {
      pledgeCkb: "61",
      outcome: "success",
      successAddress: "recipient",
      refundAddress: "refund",
    },
    {
      ownerLockHash: undefined,
      resolveLock: async (address) => (address === "recipient" ? CCC_LOCK : STANDARD_LOCK),
      resolveLockHash: async (address) =>
        address === "recipient" ? `0x${"33".repeat(32)}` : `0x${"44".repeat(32)}`,
      walletReady: true,
    },
  );
  assert.equal(
    errors["pledgeCkb"],
    "Recipient amount must be at least 63 CKB for the selected recipient and refund addresses.",
  );
});

test("deadline form validates a custom preferred operator address", async () => {
  const errors = await validateDeadlineStep(
    "details",
    {
      pledgeCkb: "80",
      outcome: "success",
      successAddress: "recipient",
      refundAddress: "refund",
      operatorMode: "custom",
      preferredOperatorAddress: "invalid-operator",
    },
    {
      ownerLockHash: `0x${"55".repeat(32)}`,
      resolveLock: async () => STANDARD_LOCK,
      resolveLockHash: async (address) => {
        if (address === "invalid-operator") throw new Error("invalid address");
        return address === "recipient" ? `0x${"33".repeat(32)}` : `0x${"44".repeat(32)}`;
      },
      walletReady: true,
    },
  );
  assert.equal(errors["preferredOperatorAddress"], "Enter a valid CKB testnet operator address.");
});

test("deadline client rejects every invalid API fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../contracts/fixtures/deadline_request_validation_v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Fixture;
  assert.equal(clientAcceptsDeadlineRequest(fixture.valid), true);
  for (const invalid of fixture.invalid) {
    assert.equal(
      clientAcceptsDeadlineRequest(invalidRequest(fixture.valid, invalid)),
      false,
      invalid.name,
    );
  }
});

test("deadline form asks for addresses and never raw scripts or hashes", async () => {
  const source = await readFile(new URL("./deadline-setup.tsx", import.meta.url), "utf8");
  for (const field of [
    "title",
    "pledgeCkb",
    "successAddress",
    "refundAddress",
    "scheduleAt",
    "ownerAddress",
  ]) {
    assert.match(source, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(source, /name="[^"]*(?:script|hash|outPoint)/i);
  assert.equal(source.match(/label: "Use mine"/g)?.length, 1);
  assert.match(source, /endAction=\{\{/);
  assert.doesNotMatch(source, /Use connected wallet/);
  assert.doesNotMatch(source, /name="(?:targetCkb|deadlineBlock|rewardCkb)"/);
  assert.match(source, /Pay recipient/);
  assert.match(source, /Refund amount/);
});
