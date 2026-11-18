CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
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

CREATE UNIQUE INDEX IF NOT EXISTS runs_active_ticket
  ON runs (ticket_card_id)
  WHERE finished_at IS NULL;

CREATE INDEX IF NOT EXISTS runs_state_idx ON runs (state);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at DESC);

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
