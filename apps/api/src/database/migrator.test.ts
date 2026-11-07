import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadMigrations } from "./migrator.ts";

async function withMigrationDirectory(
  files: Readonly<Record<string, string>>,
  run: (directory: URL) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "automata-migrations-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)),
    );
    await run(new URL(`file:///${directory.replaceAll("\\", "/")}/`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads paired migrations in numeric order with stable checksums", async () => {
  await withMigrationDirectory(
    {
      "0002_second.down.sql": "DROP TABLE second;",
      "0001_first.up.sql": "CREATE TABLE first (id integer);",
      "0002_second.up.sql": "CREATE TABLE second (id integer);",
      "0001_first.down.sql": "DROP TABLE first;",
      "notes.md": "ignored",
    },
    async (directory) => {
      const first = await loadMigrations(directory);
      const second = await loadMigrations(directory);
      assert.deepEqual(
        first.map(({ version, name }) => ({ version, name })),
        [
          { version: 1, name: "first" },
          { version: 2, name: "second" },
        ],
      );
      assert.match(first[0]?.checksum ?? "", /^[0-9a-f]{64}$/);
      assert.equal(first[0]?.checksum, second[0]?.checksum);
      await writeFile(
        join(fileURLToPath(directory), "0001_first.down.sql"),
        "DROP TABLE first CASCADE;",
      );
      const rollbackChanged = await loadMigrations(directory);
      assert.notEqual(first[0]?.checksum, rollbackChanged[0]?.checksum);
    },
  );
});

test("repository migrations retain confirmation policy and register the harvest deployment", async () => {
  const migrations = await loadMigrations();
  const confirmations = migrations.find(({ version }) => version === 13);
  const harvestProjection = migrations.find(({ version }) => version === 14);
  const harvestManifest = migrations.find(({ version }) => version === 15);
  const harvestPolicyFix = migrations.find(({ version }) => version === 16);
  const ownerCompensation = migrations.find(({ version }) => version === 17);
  const reviewRemediation = migrations.find(({ version }) => version === 18);
  const latest = migrations.at(-1);
  const harvestV2Projection = migrations.find(({ version }) => version === 20);
  const operatorRegistry = migrations.find(({ version }) => version === 21);

  assert.equal(confirmations?.name, "testnet_confirmation_depth");
  assert.match(confirmations?.upSql ?? "", /confirmation_depth = 5/);
  assert.match(confirmations?.downSql ?? "", /confirmation_depth = 24/);
  assert.equal(harvestProjection?.name, "dao_harvest_projection");
  assert.match(harvestProjection?.upSql ?? "", /CREATE TABLE dao_harvest_jobs/);
  assert.match(harvestProjection?.downSql ?? "", /DROP TABLE IF EXISTS dao_harvest_jobs/);
  assert.equal(harvestManifest?.name, "dao_harvest_manifest");
  for (const sql of [harvestManifest?.upSql ?? "", harvestManifest?.downSql ?? ""]) {
    assert.match(sql, /8902af74/);
    assert.match(sql, /cddc2e92/);
    assert.match(sql, /10639e08/);
  }
  assert.equal(harvestPolicyFix?.name, "dao_harvest_policy_fix");
  for (const sql of [harvestPolicyFix?.upSql ?? "", harvestPolicyFix?.downSql ?? ""]) {
    assert.match(sql, /cddc2e92/);
    assert.match(sql, /857e3125/);
    assert.match(sql, /10639e08/);
  }
  assert.equal(ownerCompensation?.name, "owner_compensation_policy");
  for (const sql of [ownerCompensation?.upSql ?? "", ownerCompensation?.downSql ?? ""]) {
    assert.match(sql, /857e3125/);
    assert.match(sql, /0fe4b1f4/);
    assert.match(sql, /10639e08/);
  }
  assert.equal(reviewRemediation?.name, "review_remediation_contracts");
  for (const sql of [reviewRemediation?.upSql ?? "", reviewRemediation?.downSql ?? ""]) {
    assert.match(sql, /0fe4b1f4/);
    assert.match(sql, /709b8414/);
    assert.match(sql, /10639e08/);
  }
  const securityRemediation = migrations.find(({ version }) => version === 19);
  assert.equal(securityRemediation?.name, "security_remediation_contracts");
  for (const sql of [securityRemediation?.upSql ?? "", securityRemediation?.downSql ?? ""]) {
    assert.match(sql, /709b8414/);
    assert.match(sql, /f3e4e82e/);
    assert.match(sql, /10639e08/);
  }
  assert.equal(latest?.version, 21);
  assert.equal(harvestV2Projection?.name, "dao_harvest_v2_projection");
  assert.match(harvestV2Projection?.upSql ?? "", /CREATE TABLE dao_harvest_v2_events/);
  assert.match(harvestV2Projection?.upSql ?? "", /CREATE TABLE dao_harvest_v2_jobs/);
  assert.match(harvestV2Projection?.downSql ?? "", /DROP TABLE IF EXISTS dao_harvest_v2_jobs/);
  assert.equal(operatorRegistry?.name, "operator_registry");
  assert.match(operatorRegistry?.upSql ?? "", /CREATE TABLE operator_registrations/);
  assert.match(operatorRegistry?.downSql ?? "", /DROP TABLE IF EXISTS operator_registrations/);
});

test("rejects gaps and unpaired migration files", async () => {
  await withMigrationDirectory(
    {
      "0002_second.up.sql": "SELECT 1;",
      "0002_second.down.sql": "SELECT 1;",
    },
    async (directory) => {
      await assert.rejects(loadMigrations(directory), /contiguous from 0001/);
    },
  );

  await withMigrationDirectory({ "0001_first.up.sql": "SELECT 1;" }, async (directory) => {
    await assert.rejects(loadMigrations(directory), /matching up and down SQL/);
  });
});

test("application startup has no migration or schema mutation path", async () => {
  const sourceDirectory = new URL("../", import.meta.url);
  const startupSources = await Promise.all(
    ["main.ts", "bootstrap.ts", "app.module.ts"].map((name) =>
      readFile(new URL(name, sourceDirectory), "utf8"),
    ),
  );
  const combined = startupSources.join("\n");
  assert.doesNotMatch(combined, /database\/migrator|migrateDatabase|rollbackDatabase/);
  assert.doesNotMatch(combined, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/i);
});
