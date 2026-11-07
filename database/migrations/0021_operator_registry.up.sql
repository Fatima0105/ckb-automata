CREATE TABLE operator_registrations (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  lock_hash varchar(66) NOT NULL,
  display_name varchar(64) NOT NULL,
  address varchar(128) NOT NULL,
  endpoint varchar(512) NOT NULL,
  services jsonb NOT NULL,
  harvest_manifest_sha256 varchar(64),
  payment_manifest_sha256 varchar(64),
  status varchar(16) NOT NULL DEFAULT 'active',
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, lock_hash),
  UNIQUE (network_id, endpoint),
  CHECK (lock_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK (length(display_name) BETWEEN 2 AND 64 AND display_name !~ '[[:cntrl:]]'),
  CHECK (address ~ '^ckt1[0-9a-z]{20,124}$'),
  CHECK (endpoint ~ '^https://[^/?#]+$'),
  CHECK (
    jsonb_typeof(services) = 'array'
    AND jsonb_array_length(services) BETWEEN 1 AND 3
    AND services <@ '["dao-harvest", "deadline", "recurring"]'::jsonb
  ),
  CHECK (harvest_manifest_sha256 IS NULL OR harvest_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (payment_manifest_sha256 IS NULL OR payment_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (status IN ('active', 'offline')),
  CHECK (consecutive_failures >= 0),
  CHECK (last_seen_at <= last_checked_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX operator_registrations_active_idx
  ON operator_registrations (network_id, status, display_name, lock_hash);

CREATE INDEX operator_registrations_health_idx
  ON operator_registrations (status, last_checked_at);
