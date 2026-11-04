import assert from "node:assert/strict";
import test from "node:test";

import type { ApiActivity } from "@ckb-automata/api-client";

import {
  activityLabel,
  activityOutcome,
  filterActivity,
  groupActivity,
  mergeActivity,
} from "./activity-model.ts";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;

function event(
  eventId: string,
  jobId: string,
  source: "indexed" | "operational",
  state: string,
): ApiActivity["items"][number] {
  return {
    attempt: {
      committedBlockNumber: source === "indexed" ? "100" : null,
      id: "11111111-1111-4111-8111-111111111111",
      operation: "execute",
      receipt: null,
      state,
      transactionHash: HASH_A,
    },
    block:
      source === "indexed"
        ? { hash: HASH_B, number: "100", transactionHash: HASH_A, transactionIndex: "0" }
        : null,
    category: "transaction",
    confidence: source === "indexed" ? "confirmed" : "observed",
    details: {},
    eventId,
    eventType: `transaction_${state}`,
    jobId,
    occurredAt: "2026-09-24T10:00:00.000Z",
    orphanedAt: null,
    recordedAt: "2026-09-24T10:00:01.000Z",
    replacement: null,
    source,
  };
}

test("activity groups by job without merging operational and canonical evidence", () => {
  const submitted = event("3", HASH_A, "operational", "submitted");
  const confirmed = event("4", HASH_A, "indexed", "confirmed");
  const groups = groupActivity([
    confirmed,
    submitted,
    event("2", HASH_B, "operational", "dropped"),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.items, [confirmed, submitted]);
  assert.notEqual(groups[0]?.items[0]?.source, groups[0]?.items[1]?.source);
});

test("harvest operator activity uses plain preferred and backup language", () => {
  assert.equal(
    activityLabel({
      ...event("9", HASH_A, "indexed", "confirmed"),
      eventType: "dao_harvest_v2_preferred_claim",
    }),
    "Preferred operator completed the harvest",
  );
  assert.equal(
    activityLabel({
      ...event("10", HASH_A, "indexed", "confirmed"),
      eventType: "dao_harvest_v2_fallback_prepare",
    }),
    "Backup operator started the harvest",
  );
});

test("outcome filters cover contention, drops, reorgs, cancellation, and recovery", () => {
  const values = ["conflicted", "dropped", "reorged", "cancelled"];
  const items = values.map((state, index) =>
    event(String(index + 1), HASH_A, "operational", state),
  );
  for (const value of values) {
    assert.equal(filterActivity(items, value as "conflicted").length, 1);
  }
  const recovery = {
    ...event("8", HASH_A, "operational", "recovery_required"),
    eventType: "job_recovery_required",
  };
  assert.equal(activityOutcome(recovery), "recovery_required");
  assert.deepEqual(filterActivity([recovery], "recovery"), [recovery]);
});

test("stable page merging keeps descending event order and replaces duplicates", () => {
  const first = event("8", HASH_A, "operational", "submitted");
  const older = event("7", HASH_B, "indexed", "confirmed");
  const updated = { ...first, confidence: "committed" as const };
  const merged = mergeActivity([first], [older, updated]);
  assert.deepEqual(
    merged.map(({ eventId }) => eventId),
    ["8", "7"],
  );
  assert.equal(merged[0]?.confidence, "committed");
});
