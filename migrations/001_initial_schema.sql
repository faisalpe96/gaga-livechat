-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE conversation_status AS ENUM
  ('bot_active', 'handoff_queued', 'agent_active', 'resolved');

CREATE TYPE sender_type AS ENUM ('player', 'bot', 'agent', 'system');

CREATE TABLE markets (
  code              text PRIMARY KEY,
  name              text NOT NULL,
  default_locale    text NOT NULL,
  supported_locales text[] NOT NULL,
  timezone          text NOT NULL,
  currency          text NOT NULL,
  hours_start       time NOT NULL,
  hours_end         time NOT NULL,
  is_bot_enabled    boolean NOT NULL DEFAULT false
);

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  locales         text[] NOT NULL,
  max_concurrent  int NOT NULL DEFAULT 3,
  status          text NOT NULL DEFAULT 'offline'
);

CREATE TABLE conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_uid        text NOT NULL,
  market            text NOT NULL REFERENCES markets(code),
  locale            text NOT NULL,
  status            conversation_status NOT NULL DEFAULT 'bot_active',
  stage             text NOT NULL DEFAULT 'greeting',
  assigned_agent_id uuid REFERENCES agents(id),
  category          text,
  subcategory       text,
  priority          text,
  sla_due_at        timestamptz,
  resolution_reason text,
  ticket_id         text,
  page_context      jsonb NOT NULL DEFAULT '{}',
  started_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);

CREATE INDEX idx_conversations_status_locale_started ON conversations (status, locale, started_at);
CREATE INDEX idx_conversations_player_started ON conversations (player_uid, started_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sender_type     sender_type NOT NULL,
  sender_id       text,
  text            text NOT NULL,
  translated      boolean NOT NULL DEFAULT false,
  original_text   text,
  meta            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  reason          text NOT NULL,
  bot_summary     text NOT NULL,
  locale          text NOT NULL,
  fallback_mode   text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  picked_at       timestamptz,
  agent_id        uuid REFERENCES agents(id)
);

CREATE TABLE kb_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_key     text NOT NULL,
  locale      text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  is_policy   boolean NOT NULL DEFAULT false,
  version     int NOT NULL DEFAULT 1,
  reviewed_by text,
  reviewed_at timestamptz,
  embedding   vector(1536),
  UNIQUE (doc_key, locale)
);

CREATE TABLE canned_responses (
  template_id text NOT NULL,
  locale      text NOT NULL,
  category    text NOT NULL,
  body        text NOT NULL,
  PRIMARY KEY (template_id, locale)
);

CREATE TABLE guardrail_phrases (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key  text NOT NULL,
  locale    text NOT NULL,
  phrase    text NOT NULL,
  author    text NOT NULL
);

CREATE TABLE bot_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid NOT NULL REFERENCES messages(id),
  verdict        text NOT NULL,
  corrected_text text,
  reviewer_id    uuid REFERENCES agents(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  tool_name       text NOT NULL,
  arguments       jsonb NOT NULL,
  result_status   text NOT NULL,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_reply_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent         text NOT NULL,
  locale         text NOT NULL,
  is_enabled     boolean NOT NULL DEFAULT false,
  min_confidence numeric NOT NULL DEFAULT 0.85,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent, locale)
);

-- Down Migration
DROP TABLE IF EXISTS auto_reply_rules CASCADE;
DROP TABLE IF EXISTS category_field_sets CASCADE;
DROP TABLE IF EXISTS tool_calls CASCADE;
DROP TABLE IF EXISTS bot_feedback CASCADE;
DROP TABLE IF EXISTS guardrail_phrases CASCADE;
DROP TABLE IF EXISTS canned_responses CASCADE;
DROP TABLE IF EXISTS kb_documents CASCADE;
DROP TABLE IF EXISTS handoffs CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS markets CASCADE;

DROP TYPE IF EXISTS sender_type CASCADE;
DROP TYPE IF EXISTS conversation_status CASCADE;

DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS vector;
