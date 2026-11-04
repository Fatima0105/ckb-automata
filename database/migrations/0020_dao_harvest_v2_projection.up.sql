CREATE TABLE dao_harvest_v2_events (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  event_id varchar(160) NOT NULL,
  job_id varchar(66) NOT NULL,
  operation varchar(32) NOT NULL,
  transaction_hash varchar(66) NOT NULL,
  transaction_index numeric(10, 0) NOT NULL,
  block_number numeric(20, 0) NOT NULL,
  block_hash varchar(66) NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  projection jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  orphaned_at timestamptz,
  PRIMARY KEY (network_id, event_id),
  CONSTRAINT dao_harvest_v2_events_job_ck CHECK (job_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_events_tx_ck CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_events_block_ck CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_events_operation_ck CHECK (
    operation IN (
      'setup', 'preferred_prepare', 'fallback_prepare', 'preferred_claim',
      'fallback_claim', 'owner_complete', 'sweep', 'close', 'rotate', 'recover'
    )
  ),
  CONSTRAINT dao_harvest_v2_events_canonicality_ck CHECK (
    (canonical AND orphaned_at IS NULL) OR (NOT canonical AND orphaned_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX dao_harvest_v2_events_chain_uq
  ON dao_harvest_v2_events(network_id, transaction_hash, transaction_index, operation);
CREATE INDEX dao_harvest_v2_events_rebuild_idx
  ON dao_harvest_v2_events(network_id, job_id, canonical, block_number, transaction_index);

CREATE TABLE dao_harvest_v2_jobs (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  job_id varchar(66) NOT NULL,
  owner_lock_hash varchar(66) NOT NULL,
  payout_lock_hash varchar(66) NOT NULL,
  payload_hash varchar(66) NOT NULL,
  job_outpoint jsonb,
  vault_outpoint jsonb,
  compensation_outpoint jsonb,
  lifecycle_state varchar(24) NOT NULL,
  cycle_index numeric(10, 0) NOT NULL,
  total_cycles numeric(10, 0) NOT NULL,
  principal_capacity numeric(20, 0) NOT NULL,
  compensation_capacity numeric(20, 0),
  accumulated_compensation numeric(20, 0),
  prepare_credit jsonb,
  operator_window jsonb NOT NULL,
  service_settlement jsonb NOT NULL,
  canonical_tx_status varchar(24) NOT NULL,
  projection_completeness varchar(16) NOT NULL,
  observed_block_number numeric(20, 0) NOT NULL,
  observed_block_hash varchar(66) NOT NULL,
  observed_transaction_hash varchar(66) NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, job_id),
  CONSTRAINT dao_harvest_v2_jobs_job_ck CHECK (job_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_owner_ck CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_payout_ck CHECK (payout_lock_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_payload_ck CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_block_ck CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_tx_ck CHECK (observed_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v2_jobs_state_ck CHECK (
    lifecycle_state IN ('deposited', 'withdrawing', 'completed', 'recovered', 'closed')
  ),
  CONSTRAINT dao_harvest_v2_jobs_cycle_ck CHECK (
    cycle_index >= 0 AND total_cycles > 0 AND cycle_index <= total_cycles
  ),
  CONSTRAINT dao_harvest_v2_jobs_capacity_ck CHECK (
    principal_capacity > 0
    AND (compensation_capacity IS NULL OR compensation_capacity >= 0)
    AND (accumulated_compensation IS NULL OR accumulated_compensation >= 0)
  ),
  CONSTRAINT dao_harvest_v2_jobs_status_ck CHECK (
    canonical_tx_status IN ('pending', 'proposed', 'committed', 'confirmed', 'conflicted', 'orphaned')
  ),
  CONSTRAINT dao_harvest_v2_jobs_completeness_ck CHECK (
    projection_completeness IN ('complete', 'partial')
  )
);

CREATE INDEX dao_harvest_v2_jobs_owner_idx
  ON dao_harvest_v2_jobs(network_id, owner_lock_hash, observed_block_number DESC);
CREATE INDEX dao_harvest_v2_jobs_schedule_idx
  ON dao_harvest_v2_jobs(network_id, lifecycle_state, observed_block_number DESC);
