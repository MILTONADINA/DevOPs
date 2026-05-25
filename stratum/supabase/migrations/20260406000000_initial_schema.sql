-- Migration: 20260406000000_initial_schema.sql
-- Initial schema for Startum
-- Run via: npx supabase db push

-- ─── Organizations ───────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'starter'
              CHECK (plan IN ('starter', 'growth', 'enterprise', 'custom')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Developers ──────────────────────────────────────────────────────────────

CREATE TABLE developers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  UNIQUE (org_id, email)
);

-- ─── Org Configuration ───────────────────────────────────────────────────────

CREATE TABLE org_config (
  org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lambda          FLOAT NOT NULL DEFAULT 0.97
                  CHECK (lambda > 0 AND lambda <= 1),
  gain_shift      FLOAT NOT NULL DEFAULT 0.0,
  theta           FLOAT NOT NULL DEFAULT 1.0 CHECK (theta > 0),
  zk_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  audit_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_url     TEXT,
  webhook_secret  TEXT
);

-- ─── Sessions ────────────────────────────────────────────────────────────────

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  model         TEXT NOT NULL,
  lambda        FLOAT NOT NULL DEFAULT 0.97,
  gain_shift    FLOAT NOT NULL DEFAULT 0.0,
  theta         FLOAT NOT NULL DEFAULT 1.0,
  zk_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  audit_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX sessions_org_id_idx ON sessions(org_id);
CREATE INDEX sessions_developer_id_idx ON sessions(developer_id);
CREATE INDEX sessions_created_at_idx ON sessions(created_at DESC);

-- ─── Pruning Logs ─────────────────────────────────────────────────────────────

CREATE TABLE pruning_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id        UUID NOT NULL REFERENCES sessions(id),
  turns_total       INTEGER NOT NULL CHECK (turns_total >= 0),
  turns_selected    INTEGER[] NOT NULL DEFAULT '{}',
  turns_pruned      INTEGER[] NOT NULL DEFAULT '{}',
  relevance_scores  FLOAT[] NOT NULL DEFAULT '{}',
  spans_selected    INT4RANGE[] NOT NULL DEFAULT '{}',
  lambda_used       FLOAT NOT NULL,
  gain_shift_used   FLOAT NOT NULL,
  theta_used        FLOAT NOT NULL
);

CREATE INDEX pruning_logs_session_id_idx ON pruning_logs(session_id);

-- ─── Billing Records (Append-Only) ───────────────────────────────────────────

CREATE TABLE billing_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id            UUID NOT NULL REFERENCES sessions(id),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  original_tokens       INTEGER NOT NULL CHECK (original_tokens > 0),
  quarantined_tokens    INTEGER NOT NULL CHECK (quarantined_tokens >= 0),
  token_delta           INTEGER GENERATED ALWAYS AS (original_tokens - quarantined_tokens) STORED,
  api_price_per_token   NUMERIC(12,8) NOT NULL CHECK (api_price_per_token > 0),
  cost_delta_usd        NUMERIC(12,6) GENERATED ALWAYS AS
                          ((original_tokens - quarantined_tokens) * api_price_per_token) STORED,
  cq_fee_usd            NUMERIC(12,6) GENERATED ALWAYS AS
                          ((original_tokens - quarantined_tokens) * api_price_per_token * 0.20) STORED,
  pruning_log_id        UUID REFERENCES pruning_logs(id),
  signed_hash           TEXT NOT NULL
);

-- Enforce append-only: prevent updates and deletes
CREATE RULE no_update_billing AS ON UPDATE TO billing_records DO INSTEAD NOTHING;
CREATE RULE no_delete_billing AS ON DELETE TO billing_records DO INSTEAD NOTHING;

CREATE INDEX billing_records_org_id_idx ON billing_records(org_id);
CREATE INDEX billing_records_session_id_idx ON billing_records(session_id);
CREATE INDEX billing_records_created_at_idx ON billing_records(created_at DESC);

-- ─── Structured Fact Tables ───────────────────────────────────────────────────

-- Shared base columns (applied to each fact table via convention, not inheritance)

CREATE TABLE function_changes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fact-specific
  old_name      TEXT NOT NULL,
  new_name      TEXT,
  change_type   TEXT NOT NULL
                CHECK (change_type IN ('deprecated', 'renamed', 'signature_changed', 'deleted', 'added')),
  file_path     TEXT,
  language      TEXT
);

CREATE TABLE tech_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fact-specific
  decision_text TEXT NOT NULL,
  domain        TEXT NOT NULL,
  rationale     TEXT,
  supersedes_id UUID REFERENCES tech_decisions(id)
);

CREATE TABLE policy_updates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fact-specific
  policy_name   TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT NOT NULL,
  policy_type   TEXT NOT NULL
                CHECK (policy_type IN ('security', 'compliance', 'process', 'infrastructure')),
  effective_date DATE
);

CREATE TABLE todos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fact-specific
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'done', 'cancelled')),
  due_date      DATE,
  assigned_to   UUID REFERENCES developers(id)
);

CREATE TABLE variable_changes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  developer_id  UUID REFERENCES developers(id),
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fact-specific
  var_name      TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT NOT NULL,
  context       TEXT
);

-- Indexes for all fact tables
CREATE INDEX fc_org_id_idx ON function_changes(org_id);
CREATE INDEX fc_session_id_idx ON function_changes(session_id);
CREATE INDEX fc_promoted_idx ON function_changes(promoted_to_t3) WHERE promoted_to_t3 = FALSE;

CREATE INDEX td_org_id_idx ON tech_decisions(org_id);
CREATE INDEX pu_org_id_idx ON policy_updates(org_id);
CREATE INDEX todos_org_id_idx ON todos(org_id);
CREATE INDEX vc_org_id_idx ON variable_changes(org_id);

-- ─── Audit Conflicts ──────────────────────────────────────────────────────────

CREATE TABLE audit_conflicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  fact_table      TEXT NOT NULL,
  fact_id         UUID NOT NULL,
  claimed_state   TEXT NOT NULL,
  actual_state    TEXT NOT NULL,
  conflict_commit TEXT,
  suppressed      BOOLEAN NOT NULL DEFAULT TRUE,
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES developers(id)
);

CREATE INDEX audit_conflicts_org_id_idx ON audit_conflicts(org_id);
CREATE INDEX audit_conflicts_acknowledged_idx ON audit_conflicts(acknowledged) WHERE acknowledged = FALSE;

-- ─── API Keys ─────────────────────────────────────────────────────────────────

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  key_hash    TEXT NOT NULL UNIQUE,  -- store only the hash, never the raw key
  name        TEXT NOT NULL,
  last_used   TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
