import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function document(path) {
  return readFile(new URL(path, root), "utf8");
}

test("DAO Harvest V2 requirements close every reviewed economic and availability case", async () => {
  const requirements = await document("docs/protocol/dao-harvest-v2-requirements.md");

  for (const required of [
    "Operator A prepares and operator B claims",
    "Owner completes the claim",
    "Compensation is below total fees",
    "Preferred operator is unavailable",
    "The preparation window is missed",
    "The automation finishes",
    "One job and one transition per transaction",
    "No cross-user or cross-job batching",
    "No automatic migration is allowed",
  ]) {
    assert.ok(requirements.includes(required), `missing requirement: ${required}`);
  }

  assert.match(requirements, /re-deposit exactly `principal_capacity`/i);
  assert.match(requirements, /no shortfall is carried forward/i);
  assert.match(requirements, /Public executors: never authorized for prepare/);
  assert.match(requirements, /owner may complete or recover at maturity/);
  assert.match(requirements, /do not promise cancellation/);
});

test("accepted ADRs keep V1 compatible and principal outside every fee source", async () => {
  const paths = [
    "docs/architecture/0009-settle-harvest-service-fees-from-compensation.md",
    "docs/architecture/0010-accumulate-harvest-compensation-in-an-owner-vault.md",
    "docs/architecture/0011-use-preferred-harvest-operators-with-delayed-fallback.md",
  ];
  const records = await Promise.all(paths.map(document));

  for (const record of records) {
    assert.match(record, /Status: Accepted/);
  }
  assert.match(records[0], /never deducts miner fees from\s+principal/);
  assert.match(records[0], /V1 keeps its pre-funded reward rules/);
  assert.match(records[1], /seed is a recoverable reserve, not a service fee/);
  assert.match(records[1], /V1 continues to\s+pay compensation directly/);
  assert.match(records[2], /arbitrary permissionless prepare is never enabled/);
  assert.match(records[2], /owner may complete or recover at maturity/);
});

test("the shared vocabulary distinguishes V2 charges and owner reserves from V1 rewards", async () => {
  const vocabulary = await document("docs/protocol/vocabulary.md");

  for (const term of [
    "`service_fee`",
    "`preferred_operator`",
    "`fallback_operator`",
    "`compensation_cell`",
    "`compensation_seed`",
  ]) {
    assert.ok(vocabulary.includes(term), `missing vocabulary term: ${term}`);
  }
  assert.match(vocabulary, /Existing V1 `reward` remains a separately pre-funded/);
});
