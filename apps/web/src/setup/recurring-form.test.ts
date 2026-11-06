import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import {
  clientAcceptsRecurringRequest,
  intervalMinutesToBlocks,
  recurringFundingPreview,
  validateRecurringStep,
} from "./recurring-form.ts";

const HASH = `0x${"22".repeat(32)}`;
const STANDARD_LOCK = Object.freeze({
  codeHash: parseHash32(`0x${"11".repeat(32)}`),
  hashType: "type" as const,
  args: `0x${"22".repeat(20)}` as const,
});
const CCC_LOCK = Object.freeze({ ...STANDARD_LOCK, args: `0x${"22".repeat(22)}` as const });
const VALID_DRAFT = {
  amountCkb: "100",
  firstExecutionAt: "2099-09-24T10:00",
  intervalMinutes: "17",
  recipientAddress: "recipient",
  runCount: "3",
};
const CONTEXT = {
  balanceShannons: 100_000_000_000n,
  ownerLockHash: HASH,
  resolveLock: async () => STANDARD_LOCK,
  resolveLockHash: async () => HASH,
  walletReady: true,
};

interface Fixture {
  readonly valid: Readonly<Record<string, unknown>>;
  readonly invalid: readonly {
    readonly name: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }[];
}

test("recurring preview exposes every component of the locked total", () => {
  const preview = recurringFundingPreview({ ...VALID_DRAFT, rewardCkb: "999" });
  assert.equal(preview.amountPerRun, 10_000_000_000n);
  assert.equal(preview.payoutTotal, 30_000_000_000n);
  assert.equal(preview.rewardTotal, 18_300_000_000n);
  assert.equal(preview.occupiedCapacity, 38_100_000_000n);
  assert.equal(preview.totalLocked, 86_400_000_000n);
  assert.equal(preview.totalLockedCkb, "864");
});

test("recurring intervals convert readable minutes to the internal schedule cadence", () => {
  assert.equal(intervalMinutesToBlocks("1"), "6");
  assert.equal(intervalMinutesToBlocks("60"), "360");
  assert.throws(() => intervalMinutesToBlocks("0"), /at least 1 minute/);
});

test("recurring validation rejects invalid addresses, intervals, and run counts", async () => {
  const addressErrors = await validateRecurringStep("details", VALID_DRAFT, {
    ...CONTEXT,
    resolveLockHash: async () => {
      throw new Error("invalid address");
    },
  });
  assert.match(addressErrors["recipientAddress"] ?? "", /valid CKB testnet/);

  const intervalErrors = await validateRecurringStep(
    "timing",
    { ...VALID_DRAFT, intervalMinutes: "0" },
    CONTEXT,
  );
  assert.match(intervalErrors["intervalMinutes"] ?? "", /at least 1 minute/);

  const runErrors = await validateRecurringStep(
    "timing",
    { ...VALID_DRAFT, runCount: "4294967296" },
    CONTEXT,
  );
  assert.match(runErrors["runCount"] ?? "", /4,294,967,295/);
});

test("recurring validation rejects overflow and insufficient wallet balance", async () => {
  assert.throws(() =>
    recurringFundingPreview({
      ...VALID_DRAFT,
      amountCkb: "184467440737.09551615",
      runCount: "2",
    }),
  );
  const errors = await validateRecurringStep("timing", VALID_DRAFT, {
    ...CONTEXT,
    balanceShannons: 86_399_999_999n,
  });
  assert.equal(
    errors["ownerAddress"],
    "Wallet needs at least 864 CKB to cover all payments and charges.",
  );
});

test("recurring validation uses the resolved recipient address minimum", async () => {
  const errors = await validateRecurringStep(
    "details",
    { ...VALID_DRAFT, amountCkb: "61" },
    { ...CONTEXT, resolveLock: async () => CCC_LOCK },
  );
  assert.equal(
    errors["amountCkb"],
    "Payment amount must be at least 63 CKB for this recipient address.",
  );
});

test("recurring validation requires a valid custom preferred operator", async () => {
  const errors = await validateRecurringStep(
    "details",
    {
      ...VALID_DRAFT,
      operatorMode: "custom",
      preferredOperatorAddress: "invalid-operator",
    },
    {
      ...CONTEXT,
      resolveLockHash: async (address) => {
        if (address === "invalid-operator") throw new Error("invalid address");
        return HASH;
      },
    },
  );
  assert.equal(errors["preferredOperatorAddress"], "Enter a valid CKB testnet operator address.");
});

test("recurring client rejects every invalid API fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../contracts/fixtures/recurring_request_validation_v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Fixture;
  assert.equal(clientAcceptsRecurringRequest(fixture.valid), true);
  for (const invalid of fixture.invalid) {
    assert.equal(
      clientAcceptsRecurringRequest({ ...fixture.valid, ...invalid.patch }),
      false,
      invalid.name,
    );
  }
});

test("recurring form asks for plain-language values and no raw scripts", async () => {
  const [source, reviewSource] = await Promise.all([
    readFile(new URL("./recurring-setup.tsx", import.meta.url), "utf8"),
    readFile(new URL("./creation-review.tsx", import.meta.url), "utf8"),
  ]);
  for (const field of [
    "recipientAddress",
    "amountCkb",
    "firstExecutionAt",
    "intervalMinutes",
    "runCount",
    "ownerAddress",
  ]) {
    assert.match(source, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(source, /name="(?:rewardCkb|finalRefund)"/);
  assert.doesNotMatch(source, /Funding and final refund|Executor reward per run/);
  assert.match(reviewSource, /reward: ckbToShannons\(RECURRING_SERVICE_CHARGE_CKB\)/);
  assert.doesNotMatch(source, /name="[^"]*(?:script|hash|outPoint)/i);
});
