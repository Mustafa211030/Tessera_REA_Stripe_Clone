export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  created bigint NOT NULL,
  data json NOT NULL
);
-- Connect: connected accounts point at the platform that created them.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform text;
CREATE INDEX IF NOT EXISTS accounts_platform_idx ON accounts (platform, created DESC);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id),
  created bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  csrf text NOT NULL,
  expires bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  type text NOT NULL,              -- secret | publishable | restricted
  name text,
  token text UNIQUE NOT NULL,
  permissions jsonb,
  created bigint NOT NULL,
  expires bigint,
  last_used bigint
);

-- The API object store (objects) is created by OBJECTS_DDL below: it is sharded.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status text NOT NULL,            -- in_progress | complete
  response_code int,
  response_body text,
  created bigint NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- Append-only double-entry ledger. Every group of entries sums to zero.
CREATE TABLE IF NOT EXISTS ledger_entries (
  seq bigserial PRIMARY KEY,
  account_id text NOT NULL,
  group_id text NOT NULL,
  ledger_account text NOT NULL,
  amount bigint NOT NULL,          -- debit positive, credit negative, minor units
  currency text NOT NULL,
  source text,
  description text,
  created bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries (account_id, ledger_account, currency);
CREATE INDEX IF NOT EXISTS ledger_group_idx ON ledger_entries (group_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  endpoint_id text NOT NULL,
  event_id text NOT NULL,
  status text NOT NULL,            -- pending | succeeded | failed
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at bigint,
  last_response_code int,
  last_error text,
  created bigint NOT NULL,
  updated bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_due_idx ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_attempts (
  seq bigserial PRIMARY KEY,
  delivery_id text NOT NULL,
  attempted_at bigint NOT NULL,
  response_code int,
  duration_ms int,
  error text,
  response_body text
);

CREATE TABLE IF NOT EXISTS request_logs (
  seq bigserial PRIMARY KEY,
  id text NOT NULL,
  account_id text,
  method text NOT NULL,
  path text NOT NULL,
  status int NOT NULL,
  duration_ms int NOT NULL,
  idempotency_key text,
  api_version text,
  source text,
  created bigint NOT NULL,
  request_body jsonb,
  response_body jsonb
);
CREATE INDEX IF NOT EXISTS request_logs_idx ON request_logs (account_id, seq DESC);

-- Team members: roles, names and two-step sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created);

CREATE TABLE IF NOT EXISTS invitations (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  token text UNIQUE NOT NULL,
  invited_by text,
  created bigint NOT NULL,
  expires bigint NOT NULL,
  accepted_at bigint,
  revoked_at bigint
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  token text PRIMARY KEY,
  user_id text NOT NULL,
  expires bigint NOT NULL,
  attempts int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  seq bigserial PRIMARY KEY,
  id text NOT NULL,
  account_id text NOT NULL,
  user_id text,
  actor text,
  action text NOT NULL,
  target text,
  details jsonb,
  ip text,
  created bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_idx ON audit_logs (account_id, seq DESC);

-- Uploaded file bytes (POST /v1/files); the file object itself lives in objects.
CREATE TABLE IF NOT EXISTS file_blobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  data bytea NOT NULL
);

-- One-click checkout: saved customer details shared across Tessera businesses (keyed by email).
CREATE TABLE IF NOT EXISTS oneclick_profiles (
  email text PRIMARY KEY,
  data jsonb NOT NULL,
  created bigint NOT NULL,
  updated bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS oneclick_challenges (
  id text PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires bigint NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS oneclick_sessions (
  token text PRIMARY KEY,
  email text NOT NULL,
  expires bigint NOT NULL
);
`;

/**
 * Sharded document store for API objects (cf. DocDB).
 *
 * One row per object; json (not jsonb) keeps the key order of API objects stable. The table is
 * partitioned by shard (LIST): each shard is its own physical table (objects_s0, objects_s1, …)
 * with its own indexes. shard_directory maps each account to its shard (the "chunk metadata");
 * tessera_shard() places an account on first write. Ids are unique per account.
 */
export const OBJECTS_DDL = `
CREATE TABLE IF NOT EXISTS objects (
  seq bigserial,
  id text NOT NULL,
  account_id text NOT NULL,
  type text NOT NULL,
  created bigint NOT NULL,
  data json NOT NULL,
  shard int NOT NULL,
  PRIMARY KEY (shard, account_id, id)
) PARTITION BY LIST (shard);
CREATE INDEX IF NOT EXISTS objects_list_idx ON objects (account_id, type, seq DESC);
CREATE INDEX IF NOT EXISTS objects_id_idx ON objects (id);
CREATE INDEX IF NOT EXISTS objects_acct_idx ON objects (account_id, id);
CREATE INDEX IF NOT EXISTS objects_seq_idx ON objects (seq);
-- Time-window counts (fraud velocity rules, reports) and the background workers' queue scans.
CREATE INDEX IF NOT EXISTS objects_created_idx ON objects (account_id, type, created);
CREATE INDEX IF NOT EXISTS objects_type_idx ON objects (type, account_id);

CREATE TABLE IF NOT EXISTS shard_config (id int PRIMARY KEY DEFAULT 1, shard_count int NOT NULL);
CREATE TABLE IF NOT EXISTS shard_directory (
  account_id text PRIMARY KEY,
  shard int NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS shard_directory_shard_idx ON shard_directory (shard);

-- Placement: an account's shard comes from the directory; a new account goes to the shard
-- with the fewest accounts.
CREATE OR REPLACE FUNCTION tessera_shard(acct text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE s int; n int;
BEGIN
  SELECT shard INTO s FROM shard_directory WHERE account_id = acct;
  IF s IS NOT NULL THEN RETURN s; END IF;
  SELECT shard_count INTO n FROM shard_config WHERE id = 1;
  SELECT g INTO s FROM generate_series(0, coalesce(n, 1) - 1) g LEFT JOIN shard_directory d ON d.shard = g GROUP BY g ORDER BY count(d.account_id), g LIMIT 1;
  INSERT INTO shard_directory (account_id, shard, updated) VALUES (acct, s, extract(epoch from now())::bigint);
  RETURN s;
END $$;

-- Data movement: registered moves, the change log captured while one runs, and the copy.
CREATE TABLE IF NOT EXISTS shard_moves (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  source int NOT NULL,
  target int NOT NULL,
  status text NOT NULL,
  created bigint NOT NULL,
  updated bigint NOT NULL,
  data json NOT NULL
);
CREATE TABLE IF NOT EXISTS shard_oplog (
  seq bigserial PRIMARY KEY,
  move_id text NOT NULL,
  op text NOT NULL,
  object_id text NOT NULL,
  obj_seq bigint,
  type text,
  created bigint,
  data json
);
CREATE INDEX IF NOT EXISTS shard_oplog_move_idx ON shard_oplog (move_id, seq);
CREATE TABLE IF NOT EXISTS shard_staging (
  move_id text NOT NULL,
  id text NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  created bigint NOT NULL,
  data json NOT NULL,
  PRIMARY KEY (move_id, id)
);

-- Change capture: while an account is being moved, every write to its objects is logged so
-- the copy can catch up (cf. replaying the oplog).
CREATE OR REPLACE FUNCTION tessera_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m text; acct text;
BEGIN
  IF TG_OP = 'DELETE' THEN acct := OLD.account_id; ELSE acct := NEW.account_id; END IF;
  SELECT id INTO m FROM shard_moves WHERE account_id = acct AND status IN ('copying', 'replicating', 'verifying');
  IF m IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO shard_oplog (move_id, op, object_id) VALUES (m, 'delete', OLD.id);
  ELSE
    INSERT INTO shard_oplog (move_id, op, object_id, obj_seq, type, created, data) VALUES (m, 'upsert', NEW.id, NEW.seq, NEW.type, NEW.created, NEW.data);
  END IF;
  RETURN NULL;
END $$;
`;

export const CAPTURE_TRIGGER = `CREATE OR REPLACE TRIGGER objects_capture AFTER INSERT OR UPDATE OR DELETE ON objects FOR EACH ROW EXECUTE FUNCTION tessera_capture();`;
