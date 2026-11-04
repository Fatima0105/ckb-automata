import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const hash = (name: string) => varchar(name, { length: 66 });
const uint32 = (name: string) => numeric(name, { precision: 10, scale: 0 });
const uint64 = (name: string) => numeric(name, { precision: 20, scale: 0 });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const networks = pgTable(
  "networks",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    genesisHash: hash("genesis_hash").notNull(),
    rpcProfile: varchar("rpc_profile", { length: 64 }).notNull(),
    confirmationDepth: integer("confirmation_depth").notNull(),
    deploymentManifestHash: varchar("deployment_manifest_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("networks_genesis_hash_uq").on(table.genesisHash),
    check("networks_genesis_hash_ck", sql`${table.genesisHash} ~ '^0x[0-9a-f]{64}$'`),
    check("networks_rpc_profile_ck", sql`${table.rpcProfile} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
    check("networks_confirmation_depth_ck", sql`${table.confirmationDepth} > 0`),
    check("networks_manifest_hash_ck", sql`${table.deploymentManifestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const lockResolutions = pgTable(
  "lock_resolutions",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    lockHash: hash("lock_hash").notNull(),
    codeHash: hash("code_hash").notNull(),
    hashType: varchar("hash_type", { length: 5 }).notNull(),
    args: text("args").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.lockHash] }),
    check("lock_resolutions_lock_hash_ck", sql`${table.lockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("lock_resolutions_code_hash_ck", sql`${table.codeHash} ~ '^0x[0-9a-f]{64}$'`),
    check("lock_resolutions_hash_type_ck", sql`${table.hashType} IN ('data', 'type', 'data1')`),
    check("lock_resolutions_args_ck", sql`${table.args} ~ '^0x(?:[0-9a-f]{2})*$'`),
  ],
);

export const scriptDeployments = pgTable(
  "script_deployments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    codeHash: hash("code_hash").notNull(),
    hashType: varchar("hash_type", { length: 8 }).notNull(),
    deploymentTxHash: hash("deployment_tx_hash").notNull(),
    outputIndex: uint32("output_index").notNull(),
    depType: varchar("dep_type", { length: 10 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("script_deployments_network_name_uq").on(table.networkId, table.name),
    check("script_deployments_code_hash_ck", sql`${table.codeHash} ~ '^0x[0-9a-f]{64}$'`),
    check("script_deployments_tx_hash_ck", sql`${table.deploymentTxHash} ~ '^0x[0-9a-f]{64}$'`),
    check("script_deployments_hash_type_ck", sql`${table.hashType} IN ('data', 'type', 'data1')`),
    check("script_deployments_dep_type_ck", sql`${table.depType} IN ('code', 'dep_group')`),
    check("script_deployments_output_index_ck", sql`${table.outputIndex} BETWEEN 0 AND 4294967295`),
  ],
);

export const indexerCheckpoints = pgTable(
  "indexer_checkpoints",
  {
    networkId: varchar("network_id", { length: 64 })
      .primaryKey()
      .references(() => networks.id, { onDelete: "cascade" }),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("indexer_checkpoints_block_number_ck", sql`${table.blockNumber} >= 0`),
    check("indexer_checkpoints_block_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

export const canonicalBlocks = pgTable(
  "canonical_blocks",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    parentHash: hash("parent_hash").notNull(),
    blockTimestamp: uint64("block_timestamp").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.blockNumber] }),
    uniqueIndex("canonical_blocks_network_hash_uq").on(table.networkId, table.blockHash),
    index("canonical_blocks_network_height_idx").on(table.networkId, table.blockNumber),
    check("canonical_blocks_block_number_ck", sql`${table.blockNumber} >= 0`),
    check("canonical_blocks_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("canonical_blocks_parent_hash_ck", sql`${table.parentHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    jobId: hash("job_id").notNull(),
    outpointTxHash: hash("outpoint_tx_hash").notNull(),
    outpointIndex: uint32("outpoint_index").notNull(),
    sequence: uint64("sequence").notNull(),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    policyScriptHash: hash("policy_script_hash").notNull(),
    policyKind: varchar("policy_kind", { length: 32 }).notNull(),
    state: varchar("state", { length: 24 }).notNull(),
    capacity: uint64("capacity").notNull(),
    data: bytea("data").notNull(),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    transactionIndex: uint32("transaction_index").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.jobId] }),
    uniqueIndex("jobs_network_outpoint_uq").on(
      table.networkId,
      table.outpointTxHash,
      table.outpointIndex,
    ),
    index("jobs_network_state_idx").on(table.networkId, table.state, table.blockNumber),
    index("jobs_owner_lock_hash_idx").on(table.networkId, table.ownerLockHash),
    check("jobs_job_id_ck", sql`${table.jobId} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_outpoint_hash_ck", sql`${table.outpointTxHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_owner_hash_ck", sql`${table.ownerLockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_policy_hash_ck", sql`${table.policyScriptHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_block_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_state_ck", sql`${table.state} IN ('live', 'spent', 'orphaned')`),
    check(
      "jobs_unsigned_values_ck",
      sql`${table.outpointIndex} >= 0 AND ${table.sequence} >= 0 AND ${table.capacity} >= 0 AND ${table.blockNumber} >= 0 AND ${table.transactionIndex} >= 0`,
    ),
  ],
);

export const jobVersions = pgTable(
  "job_versions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    sequence: uint64("sequence").notNull(),
    outpointTxHash: hash("outpoint_tx_hash").notNull(),
    outpointIndex: uint32("outpoint_index").notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    capacity: uint64("capacity").notNull(),
    data: bytea("data").notNull(),
    observedBlockNumber: uint64("observed_block_number").notNull(),
    observedBlockHash: hash("observed_block_hash").notNull(),
    transactionIndex: uint32("transaction_index").notNull().default("0"),
    spentTxHash: hash("spent_tx_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("cascade"),
    uniqueIndex("job_versions_network_outpoint_uq").on(
      table.networkId,
      table.outpointTxHash,
      table.outpointIndex,
    ),
    index("job_versions_job_idx").on(table.networkId, table.jobId, table.sequence),
    check("job_versions_status_ck", sql`${table.status} IN ('live', 'spent', 'orphaned')`),
    check(
      "job_versions_transaction_index_ck",
      sql`${table.transactionIndex} BETWEEN 0 AND 4294967295`,
    ),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    blockNumber: uint64("block_number"),
    blockHash: hash("block_hash"),
    txHash: hash("tx_hash"),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    canonical: boolean("canonical").notNull().default(true),
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("cascade"),
    index("job_events_job_timeline_idx").on(
      table.networkId,
      table.jobId,
      table.occurredAt,
      table.id,
    ),
    index("job_events_canonical_block_idx")
      .on(table.networkId, table.canonical, table.blockNumber)
      .where(sql`${table.source} = 'indexed'`),
    check("job_events_source_ck", sql`${table.source} IN ('indexed', 'operational')`),
    check(
      "job_events_block_pair_ck",
      sql`(${table.blockNumber} IS NULL) = (${table.blockHash} IS NULL)`,
    ),
    check(
      "job_events_canonicality_ck",
      sql`(${table.canonical} AND ${table.orphanedAt} IS NULL) OR (NOT ${table.canonical} AND ${table.orphanedAt} IS NOT NULL)`,
    ),
  ],
);

export const daoHarvestJobs = pgTable(
  "dao_harvest_jobs",
  {
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    vaultOutpointTxHash: hash("vault_outpoint_tx_hash").notNull(),
    vaultOutpointIndex: uint32("vault_outpoint_index").notNull(),
    vaultState: varchar("vault_state", { length: 24 }).notNull(),
    depositEpochSince: uint64("deposit_epoch_since").notNull(),
    prepareStartSince: uint64("prepare_start_since").notNull(),
    prepareCutoffSince: uint64("prepare_cutoff_since").notNull(),
    claimMaturitySince: uint64("claim_maturity_since"),
    prepareBlockHash: hash("prepare_block_hash"),
    prepareBlockNumber: uint64("prepare_block_number"),
    completedCycles: uint32("completed_cycles").notNull().default("0"),
    totalCycles: uint32("total_cycles").notNull(),
    principalCapacity: uint64("principal_capacity").notNull(),
    payoutLockHash: hash("payout_lock_hash").notNull(),
    economicsSnapshot: jsonb("economics_snapshot").notNull(),
    payload: bytea("payload").notNull(),
    observedBlockNumber: uint64("observed_block_number").notNull(),
    observedBlockHash: hash("observed_block_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.jobId] }),
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("cascade"),
    uniqueIndex("dao_harvest_jobs_vault_uq").on(
      table.networkId,
      table.vaultOutpointTxHash,
      table.vaultOutpointIndex,
    ),
    index("dao_harvest_jobs_state_schedule_idx").on(
      table.networkId,
      table.vaultState,
      table.prepareStartSince,
      table.claimMaturitySince,
    ),
    check(
      "dao_harvest_jobs_state_ck",
      sql`${table.vaultState} IN ('deposited', 'withdrawing', 'claim_ready', 'completed', 'recovery_required')`,
    ),
    check(
      "dao_harvest_jobs_prepare_header_pair_ck",
      sql`(${table.prepareBlockHash} IS NULL) = (${table.prepareBlockNumber} IS NULL)`,
    ),
    check(
      "dao_harvest_jobs_economics_ck",
      sql`jsonb_typeof(${table.economicsSnapshot}) = 'object'`,
    ),
  ],
);

export const daoHarvestV2Events = pgTable(
  "dao_harvest_v2_events",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    eventId: varchar("event_id", { length: 160 }).notNull(),
    jobId: hash("job_id").notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    transactionHash: hash("transaction_hash").notNull(),
    transactionIndex: uint32("transaction_index").notNull(),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    projection: jsonb("projection").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.eventId] }),
    uniqueIndex("dao_harvest_v2_events_chain_uq").on(
      table.networkId,
      table.transactionHash,
      table.transactionIndex,
      table.operation,
    ),
    index("dao_harvest_v2_events_rebuild_idx").on(
      table.networkId,
      table.jobId,
      table.canonical,
      table.blockNumber,
      table.transactionIndex,
    ),
    check("dao_harvest_v2_events_job_ck", sql`${table.jobId} ~ '^0x[0-9a-f]{64}$'`),
    check(
      "dao_harvest_v2_events_canonicality_ck",
      sql`(${table.canonical} AND ${table.orphanedAt} IS NULL) OR (NOT ${table.canonical} AND ${table.orphanedAt} IS NOT NULL)`,
    ),
  ],
);

export const daoHarvestV2Jobs = pgTable(
  "dao_harvest_v2_jobs",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    jobId: hash("job_id").notNull(),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    payoutLockHash: hash("payout_lock_hash").notNull(),
    payloadHash: hash("payload_hash").notNull(),
    jobOutpoint: jsonb("job_outpoint"),
    vaultOutpoint: jsonb("vault_outpoint"),
    compensationOutpoint: jsonb("compensation_outpoint"),
    lifecycleState: varchar("lifecycle_state", { length: 24 }).notNull(),
    cycleIndex: uint32("cycle_index").notNull(),
    totalCycles: uint32("total_cycles").notNull(),
    principalCapacity: uint64("principal_capacity").notNull(),
    compensationCapacity: uint64("compensation_capacity"),
    accumulatedCompensation: uint64("accumulated_compensation"),
    prepareCredit: jsonb("prepare_credit"),
    operatorWindow: jsonb("operator_window").notNull(),
    serviceSettlement: jsonb("service_settlement").notNull(),
    canonicalTxStatus: varchar("canonical_tx_status", { length: 24 }).notNull(),
    projectionCompleteness: varchar("projection_completeness", { length: 16 }).notNull(),
    observedBlockNumber: uint64("observed_block_number").notNull(),
    observedBlockHash: hash("observed_block_hash").notNull(),
    observedTransactionHash: hash("observed_transaction_hash").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.jobId] }),
    index("dao_harvest_v2_jobs_owner_idx").on(
      table.networkId,
      table.ownerLockHash,
      table.observedBlockNumber,
    ),
    index("dao_harvest_v2_jobs_schedule_idx").on(
      table.networkId,
      table.lifecycleState,
      table.observedBlockNumber,
    ),
    check("dao_harvest_v2_jobs_job_ck", sql`${table.jobId} ~ '^0x[0-9a-f]{64}$'`),
    check(
      "dao_harvest_v2_jobs_cycle_ck",
      sql`${table.cycleIndex} >= 0 AND ${table.totalCycles} > 0 AND ${table.cycleIndex} <= ${table.totalCycles}`,
    ),
    check(
      "dao_harvest_v2_jobs_completeness_ck",
      sql`${table.projectionCompleteness} IN ('complete', 'partial')`,
    ),
  ],
);

export const daoHarvestTransitionAttempts = pgTable(
  "dao_harvest_transition_attempts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    sequence: uint64("sequence").notNull(),
    operation: varchar("operation", { length: 24 }).notNull(),
    state: varchar("state", { length: 24 }).notNull(),
    txHash: hash("tx_hash"),
    blockNumber: uint64("block_number"),
    blockHash: hash("block_hash"),
    evidence: jsonb("evidence").notNull().default({}),
    canonical: boolean("canonical").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [daoHarvestJobs.networkId, daoHarvestJobs.jobId],
    }).onDelete("cascade"),
    uniqueIndex("dao_harvest_attempts_tx_uq")
      .on(table.networkId, table.txHash)
      .where(sql`${table.txHash} IS NOT NULL`),
    index("dao_harvest_attempts_job_idx").on(
      table.networkId,
      table.jobId,
      table.sequence,
      table.createdAt,
    ),
    check(
      "dao_harvest_attempts_operation_ck",
      sql`${table.operation} IN ('setup', 'prepare', 'roll', 'stop', 'exit', 'recover')`,
    ),
    check(
      "dao_harvest_attempts_state_ck",
      sql`${table.state} IN ('ready', 'submitted', 'committed', 'confirmed', 'conflicted', 'dropped', 'reorged', 'failed')`,
    ),
    check(
      "dao_harvest_attempts_block_pair_ck",
      sql`(${table.blockNumber} IS NULL) = (${table.blockHash} IS NULL)`,
    ),
  ],
);

export const transactionAttempts = pgTable(
  "transaction_attempts",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    jobId: hash("job_id"),
    sequence: uint64("sequence"),
    operation: varchar("operation", { length: 24 }).notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    chainSnapshot: jsonb("chain_snapshot"),
    intentHash: hash("intent_hash"),
    unsignedTransaction: jsonb("unsigned_transaction"),
    simulation: jsonb("simulation"),
    buildClaimToken: uuid("build_claim_token"),
    buildClaimExpiresAt: timestamp("build_claim_expires_at", { withTimezone: true }),
    builderLockHash: hash("builder_lock_hash"),
    unsignedTxHash: hash("unsigned_tx_hash"),
    txHash: hash("tx_hash"),
    errorCode: varchar("error_code", { length: 96 }),
    errorDetail: jsonb("error_detail"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    committedBlockNumber: uint64("committed_block_number"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("restrict"),
    index("transaction_attempts_job_idx").on(table.networkId, table.jobId, table.createdAt),
    index("transaction_attempts_state_idx").on(table.networkId, table.state, table.updatedAt),
    uniqueIndex("transaction_attempts_network_tx_hash_uq")
      .on(table.networkId, table.txHash)
      .where(sql`${table.txHash} IS NOT NULL`),
    uniqueIndex("transaction_attempts_active_execute_uq")
      .on(table.networkId, table.jobId, table.sequence)
      .where(
        sql`${table.operation} = 'execute' AND ${table.sequence} IS NOT NULL AND ${table.state} IN ('draft', 'awaiting_signature', 'submitted', 'proposed', 'committed', 'confirmed')`,
      ),
    check(
      "transaction_attempts_operation_ck",
      sql`${table.operation} IN ('create', 'execute', 'cancel', 'recover', 'top_up')`,
    ),
    check(
      "transaction_attempts_state_ck",
      sql`${table.state} IN ('draft', 'awaiting_signature', 'submitted', 'proposed', 'committed', 'confirmed', 'conflicted', 'dropped', 'cancelled', 'recovery_required', 'reorged')`,
    ),
    check(
      "transaction_attempts_build_record_ck",
      sql`((${table.chainSnapshot} IS NULL AND ${table.intentHash} IS NULL AND ${table.unsignedTransaction} IS NULL) OR (${table.chainSnapshot} IS NOT NULL AND ${table.intentHash} IS NOT NULL AND ${table.unsignedTransaction} IS NOT NULL))`,
    ),
    check(
      "transaction_attempts_build_claim_ck",
      sql`(${table.buildClaimToken} IS NULL) = (${table.buildClaimExpiresAt} IS NULL)`,
    ),
    check(
      "transaction_attempts_builder_lock_hash_ck",
      sql`${table.builderLockHash} IS NULL OR ${table.builderLockHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
  ],
);

export const executorReceipts = pgTable(
  "executor_receipts",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => transactionAttempts.id, { onDelete: "cascade" }),
    executorLockHash: hash("executor_lock_hash").notNull(),
    payload: jsonb("payload").notNull(),
    signature: text("signature").notNull(),
    keyId: varchar("key_id", { length: 128 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("executor_receipts_attempt_uq").on(table.attemptId),
    check(
      "executor_receipts_executor_hash_ck",
      sql`${table.executorLockHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
  ],
);

export const notificationSubscriptions = pgTable(
  "notification_subscriptions",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    destinationCiphertext: text("destination_ciphertext").notNull(),
    eventTypes: jsonb("event_types").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    secretVersion: integer("secret_version").default(1).notNull(),
    nextReplayNumber: integer("next_replay_number").default(1).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("notification_subscriptions_owner_idx").on(table.networkId, table.ownerLockHash),
    check("notification_subscriptions_channel_ck", sql`${table.channel} IN ('email', 'webhook')`),
    check(
      "notification_subscriptions_event_types_ck",
      sql`jsonb_typeof(${table.eventTypes}) = 'array' AND jsonb_array_length(${table.eventTypes}) BETWEEN 1 AND 7 AND ${table.eventTypes} <@ '["ready", "submitted", "confirmed", "failed", "budget_low", "cancelled", "recovery_required"]'::jsonb`,
    ),
    check("notification_subscriptions_secret_version_ck", sql`${table.secretVersion} > 0`),
    check("notification_subscriptions_next_replay_number_ck", sql`${table.nextReplayNumber} > 0`),
    check(
      "notification_subscriptions_disabled_ck",
      sql`(${table.enabled} AND ${table.disabledAt} IS NULL) OR (NOT ${table.enabled} AND ${table.disabledAt} IS NOT NULL)`,
    ),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    eventTypes: jsonb("event_types").notNull(),
    destinationCiphertext: text("destination_ciphertext"),
    enabled: boolean("enabled").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("notification_preferences_owner_channel_uq").on(
      table.networkId,
      table.ownerLockHash,
      table.channel,
    ),
    index("notification_preferences_owner_idx").on(table.networkId, table.ownerLockHash),
    check(
      "notification_preferences_owner_hash_ck",
      sql`${table.ownerLockHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check("notification_preferences_channel_ck", sql`${table.channel} IN ('browser', 'email')`),
    check(
      "notification_preferences_event_types_ck",
      sql`jsonb_typeof(${table.eventTypes}) = 'array' AND jsonb_array_length(${table.eventTypes}) <= 7 AND ${table.eventTypes} <@ '["ready", "submitted", "confirmed", "failed", "budget_low", "cancelled", "recovery_required"]'::jsonb`,
    ),
    check(
      "notification_preferences_destination_ck",
      sql`(${table.channel} = 'browser' AND ${table.destinationCiphertext} IS NULL) OR ${table.channel} = 'email'`,
    ),
    check(
      "notification_preferences_enabled_ck",
      sql`NOT ${table.enabled} OR jsonb_array_length(${table.eventTypes}) > 0`,
    ),
    check(
      "notification_preferences_email_enabled_ck",
      sql`${table.channel} <> 'email' OR NOT ${table.enabled} OR ${table.destinationCiphertext} IS NOT NULL`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => notificationSubscriptions.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "bigint" })
      .notNull()
      .references(() => jobEvents.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    replayNumber: integer("replay_number").default(0).notNull(),
    notificationType: varchar("notification_type", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    requestSignature: text("request_signature").notNull(),
    status: varchar("status", { length: 24 }).default("pending").notNull(),
    responseCode: integer("response_code"),
    responseExcerpt: text("response_excerpt"),
    errorCode: varchar("error_code", { length: 64 }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_attempt_uq").on(
      table.subscriptionId,
      table.eventId,
      table.replayNumber,
      table.attemptNumber,
    ),
    index("webhook_deliveries_history_idx").on(table.subscriptionId, table.createdAt, table.id),
    index("webhook_deliveries_retry_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.deliveredAt} IS NULL AND ${table.nextAttemptAt} IS NOT NULL`),
    check("webhook_deliveries_attempt_number_ck", sql`${table.attemptNumber} > 0`),
    check("webhook_deliveries_replay_number_ck", sql`${table.replayNumber} >= 0`),
    check("webhook_deliveries_idempotency_key_ck", sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "webhook_deliveries_notification_type_ck",
      sql`${table.notificationType} IN ('ready', 'submitted', 'confirmed', 'failed', 'budget_low', 'cancelled', 'recovery_required')`,
    ),
    check(
      "webhook_deliveries_status_ck",
      sql`${table.status} IN ('pending', 'retry_scheduled', 'delivered', 'failed')`,
    ),
    check(
      "webhook_deliveries_response_code_ck",
      sql`${table.responseCode} IS NULL OR ${table.responseCode} BETWEEN 100 AND 599`,
    ),
    check(
      "webhook_deliveries_terminal_ck",
      sql`(${table.status} = 'pending' AND ${table.finishedAt} IS NULL AND ${table.nextAttemptAt} IS NULL) OR (${table.status} = 'retry_scheduled' AND ${table.finishedAt} IS NOT NULL AND ${table.nextAttemptAt} IS NOT NULL) OR (${table.status} IN ('delivered', 'failed') AND ${table.finishedAt} IS NOT NULL AND ${table.nextAttemptAt} IS NULL)`,
    ),
    check(
      "webhook_deliveries_delivered_ck",
      sql`(${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL) OR (${table.status} <> 'delivered' AND ${table.deliveredAt} IS NULL)`,
    ),
  ],
);

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_challenges_nonce_hash_uq").on(table.nonceHash),
    index("auth_challenges_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    check("auth_challenges_nonce_hash_ck", sql`${table.nonceHash} ~ '^[0-9a-f]{64}$'`),
    check("auth_challenges_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "auth_challenges_consumed_ck",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_uq").on(table.tokenHash),
    index("auth_sessions_token_active_idx")
      .on(table.tokenHash, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index("auth_sessions_owner_idx").on(table.networkId, table.ownerLockHash, table.createdAt),
    check("auth_sessions_owner_hash_ck", sql`${table.ownerLockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("auth_sessions_token_hash_ck", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("auth_sessions_scope_ck", sql`${table.scope} = 'off_chain_settings'`),
    check("auth_sessions_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "auth_sessions_revoked_ck",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const deadLetters = pgTable(
  "dead_letters",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    queue: varchar("queue", { length: 64 }).notNull(),
    jobKey: varchar("job_key", { length: 256 }).notNull(),
    reason: varchar("reason", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("dead_letters_queue_job_uq").on(table.queue, table.jobKey),
    index("dead_letters_unresolved_idx")
      .on(table.queue, table.failedAt)
      .where(sql`${table.resolvedAt} IS NULL`),
    check("dead_letters_attempts_ck", sql`${table.attempts} > 0`),
    check(
      "dead_letters_resolution_ck",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.failedAt}`,
    ),
  ],
);

export const deadLetterActions = pgTable(
  "dead_letter_actions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    deadLetterId: bigint("dead_letter_id", { mode: "number" })
      .notNull()
      .references(() => deadLetters.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 16 }).notNull(),
    operator: varchar("operator", { length: 128 }).notNull(),
    reason: varchar("reason", { length: 512 }),
    replayJobId: varchar("replay_job_id", { length: 256 }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("dead_letter_actions_timeline_idx").on(table.deadLetterId, table.id),
    uniqueIndex("dead_letter_actions_replay_uq")
      .on(table.deadLetterId)
      .where(sql`${table.action} = 'replay'`),
    uniqueIndex("dead_letter_actions_close_uq")
      .on(table.deadLetterId)
      .where(sql`${table.action} = 'close'`),
    check("dead_letter_actions_action_ck", sql`${table.action} IN ('inspect', 'replay', 'close')`),
    check(
      "dead_letter_actions_operator_ck",
      sql`${table.operator} ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$'`,
    ),
    check(
      "dead_letter_actions_reason_ck",
      sql`((${table.action} = 'inspect' AND ${table.reason} IS NULL) OR (${table.action} IN ('replay', 'close') AND ${table.reason} IS NOT NULL AND length(${table.reason}) BETWEEN 8 AND 512))`,
    ),
    check(
      "dead_letter_actions_replay_job_ck",
      sql`((${table.action} = 'replay' AND ${table.replayJobId} IS NOT NULL) OR (${table.action} <> 'replay' AND ${table.replayJobId} IS NULL))`,
    ),
    check(
      "dead_letter_actions_dispatch_ck",
      sql`${table.action} = 'replay' OR ${table.dispatchedAt} IS NULL`,
    ),
  ],
);

export const demoScenarios = pgTable(
  "demo_scenarios",
  {
    id: varchar("id", { length: 96 }).primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    fixtureId: varchar("fixture_id", { length: 128 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("demo_scenarios_fixture_uq").on(table.networkId, table.fixtureId)],
);

export const schema = {
  authChallenges,
  authSessions,
  canonicalBlocks,
  daoHarvestJobs,
  daoHarvestV2Events,
  daoHarvestV2Jobs,
  daoHarvestTransitionAttempts,
  deadLetterActions,
  deadLetters,
  demoScenarios,
  executorReceipts,
  indexerCheckpoints,
  jobEvents,
  jobVersions,
  jobs,
  lockResolutions,
  networks,
  notificationPreferences,
  notificationSubscriptions,
  scriptDeployments,
  transactionAttempts,
  webhookDeliveries,
} as const;
