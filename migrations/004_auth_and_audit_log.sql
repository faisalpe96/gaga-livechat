-- Up Migration
-- Bagian 1 spec/09-produksi.md: Autentikasi panel agent & AI Studio, sesi cookie, RBAC, dan audit_log

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS email          text UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash  text,
  ADD COLUMN IF NOT EXISTS role           text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'supervisor', 'admin')),
  ADD COLUMN IF NOT EXISTS external_id    text,
  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at  timestamptz;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_token ON agent_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES agents(id),
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created ON audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log (action, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS agent_sessions CASCADE;
ALTER TABLE agents
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS external_id,
  DROP COLUMN IF EXISTS is_active,
  DROP COLUMN IF EXISTS last_login_at;
