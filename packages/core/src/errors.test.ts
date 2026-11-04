import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ERROR_CATALOG, INVALID_TRANSITION_DIAGNOSTICS, type ErrorDomain } from "./errors.ts";

const ranges: Record<ErrorDomain, readonly [number, number]> = {
  script: [10, 99],
  sdk: [1000, 1099],
  api: [2000, 2099],
  executor: [3000, 3099],
};

test("error codes are unique, allocated, and have plain copy", () => {
  const codes = new Set<number>();
  for (const [key, definition] of Object.entries(ERROR_CATALOG)) {
    assert.ok(!codes.has(definition.code), `duplicate error code ${definition.code}`);
    codes.add(definition.code);
    const [minimum, maximum] = ranges[definition.domain];
    assert.ok(
      definition.code >= minimum && definition.code <= maximum,
      `${key} is outside the ${definition.domain} range`,
    );
    assert.match(definition.copy, /^[A-Z].+[.!]$/);
  }
});

test("every planned invalid transition has a script diagnostic", () => {
  assert.equal(Object.keys(INVALID_TRANSITION_DIAGNOSTICS).length, 47);
  for (const codeKey of Object.values(INVALID_TRANSITION_DIAGNOSTICS)) {
    assert.equal(ERROR_CATALOG[codeKey].domain, "script");
  }
});

test("all planned executor failures have stable codes", () => {
  const required = [
    "NOT_YET_ELIGIBLE",
    "PREPARE_WINDOW_MISSED",
    "ALREADY_CONSUMED",
    "INPUT_CONFLICT",
    "INSUFFICIENT_JOB_BUDGET",
    "REWARD_BELOW_MINIMUM",
    "POLICY_VERSION_UNSUPPORTED",
    "PAYLOAD_HASH_MISMATCH",
    "INVALID_APPLICATION_STATE",
    "MISSING_HEADER",
    "IMMATURE_SINCE",
    "SIMULATION_REJECTED",
    "NODE_REJECTED",
    "FEE_INPUT_UNAVAILABLE",
    "TX_DROPPED",
    "TX_REORGED",
    "JOB_EXPIRED",
    "JOB_CANCELLED",
    "RECOVERY_REQUIRED",
    "BUILD_FAILED",
    "ADAPTER_MISMATCH",
    "BUILD_CLAIM_LOST",
    "CHAIN_SNAPSHOT_MOVED",
    "STALE_OUTPOINT",
    "BUILD_RECORD_INVALID",
    "FEE_MISMATCH",
    "REWARD_INVALID",
    "CYCLE_LIMIT_EXCEEDED",
    "UNPROFITABLE",
    "SUBMISSION_RECORD_INVALID",
    "SUBMISSION_HASH_MISMATCH",
  ];
  const actual = Object.keys(ERROR_CATALOG)
    .filter((key) => key.startsWith("EXECUTOR_"))
    .map((key) => key.slice("EXECUTOR_".length));
  assert.deepEqual(actual, required);
});

test("Rust and TypeScript script allocations match", async () => {
  const rust = await readFile(
    new URL("../../../contracts/shared/error_codes.rs", import.meta.url),
    "utf8",
  );
  const scriptDefinitions = Object.values(ERROR_CATALOG).filter(
    (definition) => definition.domain === "script",
  );

  for (const definition of scriptDefinitions) {
    assert.ok(definition.rustVariant);
    assert.match(rust, new RegExp(`\\b${definition.rustVariant}\\s*=\\s*${definition.code},`));
  }
  assert.equal((rust.match(/^    \w+ = \d+,$/gm) ?? []).length, scriptDefinitions.length);
});
