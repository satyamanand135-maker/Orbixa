-- migrations/pg/001_initial_schema.sql
-- Gap 5: PostgreSQL as primary store for tenant-isolated entities
-- Uses Row-Level Security (RLS) to enforce tenant isolation at DB level.
-- MongoDB remains for backward compat; new writes go to BOTH (dual-write).

-- ---------------------------------------------------------------------------
-- Enable UUID extension
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organizations (billing, quotas, settings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  storage_used_bytes   BIGINT NOT NULL DEFAULT 0,
  storage_quota_bytes  BIGINT NOT NULL DEFAULT 104857600,  -- 100 MB
  document_quota       INT NOT NULL DEFAULT 50,
  refinement_quota     INT NOT NULL DEFAULT 5,
  refinement_count     INT NOT NULL DEFAULT 0,
  chunking_strategy    TEXT NOT NULL DEFAULT 'paragraph',
  chunking_overlap     INT NOT NULL DEFAULT 15,
  locale               TEXT NOT NULL DEFAULT 'en',
  billing_email        TEXT,
  stripe_customer_id   TEXT,
  stripe_subscription_id TEXT,
  subscription_status  TEXT NOT NULL DEFAULT 'inactive',
  webhook_url          TEXT,
  retention_days       INT NOT NULL DEFAULT 0,
  ip_allowlist         TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mongo_id        TEXT UNIQUE,        -- bridge: MongoDB _id
  tenant_id       TEXT NOT NULL REFERENCES organizations(tenant_id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'viewer')),
  saml_subject    TEXT,
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  gdpr_erased_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

-- ---------------------------------------------------------------------------
-- Documents (metadata only — large blobs remain in MongoDB / S3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mongo_id        TEXT UNIQUE,        -- bridge: MongoDB _id
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'TXT',
  status          TEXT NOT NULL DEFAULT 'raw',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  connector       TEXT,
  readiness_score JSONB,
  pii_findings_count INT NOT NULL DEFAULT 0,
  chunks_count    INT NOT NULL DEFAULT 0,
  vector_synced   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Audit Logs (immutable — no UPDATE or DELETE allowed via RLS)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT,
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  resource_id     TEXT,
  changes         JSONB,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Connectors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connectors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mongo_id        TEXT UNIQUE,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  frequency       TEXT NOT NULL DEFAULT 'manual',
  files_count     INT NOT NULL DEFAULT 0,
  last_synced     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_tenant  ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_documents_status  ON documents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_tenant      ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connectors_tenant ON connectors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant      ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors    ENABLE ROW LEVEL SECURITY;

-- Policies: each row is visible only to the tenant matching app.tenant_id
CREATE POLICY IF NOT EXISTS rls_organizations ON organizations
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY IF NOT EXISTS rls_users ON users
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY IF NOT EXISTS rls_documents ON documents
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY IF NOT EXISTS rls_audit_logs ON audit_logs
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY IF NOT EXISTS rls_connectors ON connectors
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Audit logs: INSERT only — no UPDATE or DELETE
CREATE POLICY IF NOT EXISTS rls_audit_logs_insert ON audit_logs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Prevent UPDATE/DELETE on audit_logs entirely (append-only)
CREATE POLICY IF NOT EXISTS rls_audit_logs_no_update ON audit_logs
  FOR UPDATE USING (FALSE);

CREATE POLICY IF NOT EXISTS rls_audit_logs_no_delete ON audit_logs
  FOR DELETE USING (FALSE);

-- ---------------------------------------------------------------------------
-- updated_at auto-trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_orgs_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_docs_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
