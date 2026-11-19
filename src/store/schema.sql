CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  owner_user_id text,
  ticket_card_id text NOT NULL,
  ticket_ref text NOT NULL,
  ticket_title text NOT NULL,
  ticket_description text NOT NULL DEFAULT '',
  ticket_url text NOT NULL DEFAULT '',
  ticket_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  ticket_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL,
  repo_url text NOT NULL DEFAULT '',
  base_branch text NOT NULL DEFAULT 'main',
  setup_command text,
  test_command text,
  branch text,
  worktree text,
  rework_count integer NOT NULL DEFAULT 0,
  pr_url text,
  block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS runs_state_idx ON runs (state);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at DESC);

-- Runs are owned by the webapp user that created them. Legacy runs may have no
-- owner and are never returned by the user-facing API.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS owner_user_id text;
DROP INDEX IF EXISTS runs_active_ticket;
CREATE UNIQUE INDEX IF NOT EXISTS runs_active_owner_ticket
  ON runs (owner_user_id, ticket_card_id)
  WHERE finished_at IS NULL AND owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_owner_created_idx
  ON runs (owner_user_id, created_at DESC);

-- Forward-compatible additions for databases created by earlier versions.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS repo_url text NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS base_branch text NOT NULL DEFAULT 'main';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS setup_command text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS test_command text;

CREATE TABLE IF NOT EXISTS artifacts (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  agent text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id, id);

CREATE TABLE IF NOT EXISTS processed_feedback (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  feedback_id text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, feedback_id)
);

CREATE TABLE IF NOT EXISTS run_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repo text NOT NULL,
  issue_number integer,
  pr_number integer,
  dedup_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS run_jobs_pending_idx
  ON run_jobs (status, available_at, created_at);

-- Webapp accounts. The web container owns authentication; the factory
-- migration creates the table so a least-privilege WEB_DATABASE_URL role can
-- be granted DML on users without DDL permissions.
-- Existing installations created `web_users`; rename it without losing rows.
DO $$
BEGIN
  IF to_regclass('public.web_users') IS NOT NULL
     AND to_regclass('public.users') IS NULL THEN
    ALTER TABLE web_users RENAME TO users;
    IF to_regclass('public.web_users_email_lower_idx') IS NOT NULL
       AND to_regclass('public.users_email_lower_idx') IS NULL THEN
      ALTER INDEX web_users_email_lower_idx RENAME TO users_email_lower_idx;
    END IF;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  image text,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Forward-compatible additions for databases created by earlier versions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (lower(email));

-- OAuth identities linked to local accounts. A user may have credentials and
-- several OAuth providers; (provider, provider_account_id) is the stable key.
CREATE TABLE IF NOT EXISTS user_identities (
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS user_identities_user_idx
  ON user_identities (user_id);

-- Runs must be owned by a user. Existing runs are backfilled only when there is
-- exactly one account; otherwise legacy runs stay ownerless and invisible.
DO $$
DECLARE
  only_user text;
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    IF (SELECT count(*) FROM users) = 1 THEN
      SELECT id INTO only_user FROM users LIMIT 1;
      UPDATE runs SET owner_user_id = only_user WHERE owner_user_id IS NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'runs_owner_user_fk'
         AND conrelid = 'runs'::regclass
    ) THEN
      ALTER TABLE runs
        ADD CONSTRAINT runs_owner_user_fk
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'runs_owner_user_required'
         AND conrelid = 'runs'::regclass
    ) THEN
      ALTER TABLE runs
        ADD CONSTRAINT runs_owner_user_required
        CHECK (owner_user_id IS NOT NULL) NOT VALID;
    END IF;
  END IF;
END;
$$;
