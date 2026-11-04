import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { migrateDatabase, rollbackDatabase } from "../apps/api/src/database/migrator.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const sourceMigrations = new URL("../database/migrations/", import.meta.url);
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for database verification");

const suffix = randomBytes(6).toString("hex");
const names = ["empty", "previous", "failure"].map(
  (scenario) => `automata_migration_${suffix}_${scenario}`,
);
for (const name of names) {
  if (!/^automata_migration_[0-9a-f]{12}_[a-z]+$/.test(name)) {
    throw new Error("Refusing to manage an unexpected database name");
  }
}

const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });

function databaseUrl(name) {
  const value = new URL(adminConnectionString);
  value.pathname = `/${name}`;
  return value.href;
}

async function createDatabase(name) {
  await admin.unsafe(`CREATE DATABASE "${name}"`);
}

async function dropDatabase(name) {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

async function withClient(name, run) {
  const client = postgres(databaseUrl(name), { max: 1, onnotice: () => undefined });
  try {
    return await run(client);
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function copyMigrations(target) {
  const entries = await readdir(sourceMigrations, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => copyFile(new URL(entry.name, sourceMigrations), join(target, entry.name))),
  );
}

try {
  for (const name of names) await createDatabase(name);

  const emptyUrl = databaseUrl(names[0]);
  const installed = await migrateDatabase({ connectionString: emptyUrl });
  assert.deepEqual(
    installed.changed,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  const repeated = await migrateDatabase({ connectionString: emptyUrl });
  assert.deepEqual(repeated.changed, []);
  await withClient(names[0], async (sql) => {
    const [{ count }] = await sql`
      SELECT count(*)::integer AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    assert.equal(count, 23);
    await assert.rejects(
      sql`INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES ('invalid', 'not-a-hash', 'local', 1, ${"0".repeat(64)})`,
    );
    await sql`INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES (
      'ckb_testnet', ${`0x${"03".repeat(32)}`}, 'testnet-public', 5, ${"04".repeat(32)}
    )`;
  });

  const rolledBackV2Projection = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackV2Projection.changed, [20]);
  await withClient(names[0], async (sql) => {
    const [{ jobs, events }] = await sql`
      SELECT
        to_regclass('public.dao_harvest_v2_jobs')::text AS jobs,
        to_regclass('public.dao_harvest_v2_events')::text AS events
    `;
    assert.equal(jobs, null);
    assert.equal(events, null);
  });
  for (const version of [19, 18, 17, 16, 15, 14]) {
    const result = await rollbackDatabase({ connectionString: emptyUrl });
    assert.deepEqual(result.changed, [version]);
  }
  const rolledBackConfirmationDepth = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackConfirmationDepth.changed, [13]);
  await withClient(names[0], async (sql) => {
    const [{ confirmation_depth: confirmationDepth }] =
      await sql`SELECT confirmation_depth FROM networks WHERE id = 'ckb_testnet'`;
    assert.equal(confirmationDepth, 24);
  });
  const rolledBackBuilderIdentity = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackBuilderIdentity.changed, [12]);
  await withClient(names[0], async (sql) => {
    const [column] = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'transaction_attempts'
        AND column_name = 'builder_lock_hash'
    `;
    assert.equal(column, undefined);
  });
  const rolledBackLockResolutions = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackLockResolutions.changed, [11]);
  await withClient(names[0], async (sql) => {
    const [{ table_name: lockResolutionsTable }] =
      await sql`SELECT to_regclass('public.lock_resolutions')::text AS table_name`;
    assert.equal(lockResolutionsTable, null);
  });
  const rolledBack = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBack.changed, [10]);
  const rolledBackSimulation = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackSimulation.changed, [9]);
  const rolledBackWebhooks = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackWebhooks.changed, [8]);
  const rolledBackPreferences = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackPreferences.changed, [7]);
  const rolledBackNotificationPreferences = await rollbackDatabase({
    connectionString: emptyUrl,
  });
  assert.deepEqual(rolledBackNotificationPreferences.changed, [6]);
  await withClient(names[0], async (sql) => {
    const [{ table_name: preferencesTable }] =
      await sql`SELECT to_regclass('public.notification_preferences')::text AS table_name`;
    assert.equal(preferencesTable, null);
  });
  const rolledBackSessions = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackSessions.changed, [5]);
  await withClient(names[0], async (sql) => {
    const [{ table_name: authSessionsTable }] =
      await sql`SELECT to_regclass('public.auth_sessions')::text AS table_name`;
    assert.equal(authSessionsTable, null);
  });
  const rolledBackCanonicality = await rollbackDatabase({ connectionString: emptyUrl });
  assert.deepEqual(rolledBackCanonicality.changed, [4]);
  await withClient(names[0], async (sql) => {
    const [column] = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'job_events'
        AND column_name = 'canonical'
    `;
    assert.equal(column, undefined);
  });
  const reapplied = await migrateDatabase({ connectionString: emptyUrl });
  assert.deepEqual(
    reapplied.changed,
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  await withClient(names[0], async (sql) => {
    const [{ confirmation_depth: confirmationDepth }] =
      await sql`SELECT confirmation_depth FROM networks WHERE id = 'ckb_testnet'`;
    assert.equal(confirmationDepth, 5);
  });

  const previousUrl = databaseUrl(names[1]);
  const previous = await migrateDatabase({ connectionString: previousUrl, targetVersion: 3 });
  assert.deepEqual(previous.changed, [1, 2, 3]);
  await withClient(names[1], async (sql) => {
    await sql`INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES (
      'fixture', ${`0x${"01".repeat(32)}`}, 'local', 12, ${"02".repeat(32)}
    ), (
      'ckb_testnet', ${`0x${"03".repeat(32)}`}, 'testnet-public', 24, ${"04".repeat(32)}
    )`;
  });
  const upgraded = await migrateDatabase({ connectionString: previousUrl });
  assert.deepEqual(
    upgraded.changed,
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  await withClient(names[1], async (sql) => {
    const [{ count }] =
      await sql`SELECT count(*)::integer AS count FROM networks WHERE id = 'fixture'`;
    assert.equal(count, 1);
    const [{ confirmation_depth: confirmationDepth }] =
      await sql`SELECT confirmation_depth FROM networks WHERE id = 'ckb_testnet'`;
    assert.equal(confirmationDepth, 5);
    const [{ table_name: tableName }] =
      await sql`SELECT to_regclass('public.transaction_attempts')::text AS table_name`;
    assert.equal(tableName, "transaction_attempts");
  });

  const failureUrl = databaseUrl(names[2]);
  await migrateDatabase({ connectionString: failureUrl });
  const temporaryMigrations = await mkdtemp(join(tmpdir(), "automata-migration-failure-"));
  try {
    await copyMigrations(temporaryMigrations);
    await writeFile(
      join(temporaryMigrations, "0021_forced_failure.up.sql"),
      "CREATE TABLE must_rollback (id integer); SELECT 1 / 0;",
    );
    await writeFile(
      join(temporaryMigrations, "0021_forced_failure.down.sql"),
      "DROP TABLE must_rollback;",
    );
    const migrationsDirectory = new URL(`file:///${temporaryMigrations.replaceAll("\\", "/")}/`);
    await assert.rejects(
      migrateDatabase({ connectionString: failureUrl, migrationsDirectory }),
      /division by zero/,
    );
  } finally {
    await rm(temporaryMigrations, { recursive: true, force: true });
  }
  await withClient(names[2], async (sql) => {
    const [{ table_name: tableName }] =
      await sql`SELECT to_regclass('public.must_rollback')::text AS table_name`;
    assert.equal(tableName, null);
    const [{ maximum }] =
      await sql`SELECT max(version)::integer AS maximum FROM automata_schema_migrations`;
    assert.equal(maximum, 20);
  });

  console.log(
    "Database migrations verified: empty install, idempotence, rollback, previous fixture, and atomic failure",
  );
} finally {
  for (const name of names.toReversed()) await dropDatabase(name);
  await admin.end({ timeout: 2 });
}
