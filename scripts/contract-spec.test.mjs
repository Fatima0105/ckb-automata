import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const spec = await readFile(new URL("docs/protocol/contract-specification-v1.md", root), "utf8");

test("contract specification publishes every normative surface", () => {
  for (const heading of [
    "## Canonical Schemas",
    "## Witness Envelopes",
    "## Script Invariants",
    "## Output Ordering Policy",
    "## Error Codes",
    "## Deployment Manifest",
    "## Recovery Recipes",
    "## Reproducible Vectors",
  ]) {
    assert.ok(spec.includes(heading), `missing ${heading}`);
  }
  assert.match(
    spec,
    /76-byte pledge records containing `tx_hash:32`, `output_index:u32`, `refund_lock_hash:32`, and `amount:u64`/,
  );
});

test("every relative specification link resolves", async () => {
  const specificationUrl = new URL("docs/protocol/contract-specification-v1.md", root);
  const links = [...spec.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]+)?\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length >= 12);
  await Promise.all(links.map((link) => access(new URL(link, specificationUrl))));
});

test("published schema names and field order match canonical Molecule sources", async () => {
  const schemas = [
    ["job_v1.mol", "JobDataV1"],
    ["recurring_v1.mol", "RecurringPayloadV1"],
    ["campaign_v1.mol", "CampaignDataV1"],
    ["dao_harvest_v1.mol", "DaoHarvestPayloadV1"],
  ];
  for (const [file, table] of schemas) {
    const molecule = await readFile(new URL(`contracts/schemas/${file}`, root), "utf8");
    const body = molecule.match(new RegExp(`table ${table} \\{([\\s\\S]*?)\\}`))?.[1];
    assert.ok(body, `${table} table is missing`);
    const fields = [...body.matchAll(/^\s+([a-z_]+):/gm)].map((match) => match[1]);
    const schemaRow = spec.split(/\r?\n/).find((line) => line.includes(`\`${table}\``));
    assert.ok(schemaRow, `${table} specification row is missing`);
    let previous = -1;
    for (const field of fields) {
      const position = schemaRow.indexOf(`\`${field}:`);
      assert.ok(position > previous, `${table}.${field} is absent or out of order`);
      previous = position;
    }
    assert.ok(spec.includes(`\`${file}\``));
  }
});

test("witness modes and every script error are documented from Rust sources", async () => {
  const witness = await readFile(new URL("contracts/shared/execution_witness.rs", root), "utf8");
  for (const [mode, operation] of [
    ["0", "Execute"],
    ["1", "Cancel"],
    ["2", "Recover"],
    ["3", "Top up"],
  ]) {
    assert.match(spec, new RegExp(`\\|\\s*\\\`${mode}\\\`\\s*\\|\\s*${operation}`));
  }
  assert.match(witness, /\[1\].*WitnessOperation::Cancel/s);
  assert.match(witness, /\[2\].*WitnessOperation::Recover/s);
  assert.match(witness, /\[3, index @ \.\.\].*WitnessOperation::TopUp/s);
  assert.match(witness, /execution\[0\] == 0/);

  const errors = await readFile(new URL("contracts/shared/error_codes.rs", root), "utf8");
  const variants = [...errors.matchAll(/^\s+([A-Za-z]+) = (\d+),$/gm)];
  const v1Variants = variants.filter(([, , code]) => Number(code) <= 43);
  assert.equal(v1Variants.length, 34);
  for (const [, variant, code] of v1Variants) {
    assert.match(
      spec,
      new RegExp(`\\|\\s*\\\`${code}\\\`\\s*\\|\\s*\\\`${variant}\\\``),
      `${variant} is undocumented`,
    );
  }
  const v2Variants = variants.filter(([, , code]) => Number(code) >= 44);
  assert.deepEqual(
    v2Variants.map(([, , code]) => Number(code)),
    Array.from({ length: 13 }, (_, index) => index + 44),
  );
  const v2Spec = await readFile(
    new URL("docs/protocol/dao-harvest-v2-wire-format.md", root),
    "utf8",
  );
  assert.match(v2Spec, /V2 adds script codes 44 through 56/);
});

test("deployment schema and reproduction vectors point to checked artifacts", async () => {
  for (const filename of ["local.json", "testnet.json"]) {
    const manifest = JSON.parse(
      await readFile(new URL(`deploy/manifests/${filename}`, root), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.match(manifest.genesisHash, /^0x[0-9a-f]{64}$/);
    assert.equal(manifest.verification.status, "committed");
    for (const name of [
      "job-lock",
      "deadline-policy",
      "recurring-policy",
      "demo-campaign-type",
      "campaign-lock",
    ]) {
      assert.equal(manifest.contracts[name].hashType, "data1");
      assert.ok(spec.includes(`\`${name}\``));
    }
  }

  const vectors = await readFile(new URL("contracts/tests/src/campaign_creation.rs", root), "utf8");
  for (const vector of [
    "deterministic_campaign_fixture_can_be_created",
    "campaign_creation_rejects_malformed_target_and_deadline",
  ]) {
    assert.ok(vectors.includes(`fn ${vector}()`));
    assert.ok(spec.includes(`campaign_creation::${vector}`));
  }
});
