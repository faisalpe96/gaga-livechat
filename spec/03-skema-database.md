# 03 — Skema database

Postgres 15+. Semua timestamp `timestamptz`, disimpan UTC, ditampilkan menurut
zona waktu pasar (lihat `05-lokalisasi.md`).

```sql
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

CREATE TABLE conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_uid        text NOT NULL,
  market            text NOT NULL REFERENCES markets(code),
  locale            text NOT NULL,
  status            conversation_status NOT NULL DEFAULT 'bot_active',
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

CREATE INDEX ON conversations (status, locale, started_at);
CREATE INDEX ON conversations (player_uid, started_at DESC);

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

CREATE INDEX ON messages (conversation_id, created_at);

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

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  locales         text[] NOT NULL,
  max_concurrent  int NOT NULL DEFAULT 3,
  status          text NOT NULL DEFAULT 'offline'
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
```

## Catatan implementasi

`canned_responses` memakai kunci gabungan `template_id` + `locale`. Satu template
punya enam varian bahasa, bukan enam template terpisah — kalau dipisah, isinya
lama-lama tidak sinkron. Ini yang perlu ditambahkan ke tab Bank Canned Response
di sheet: satu kolom `locale`, `template_id` sama di semua baris sebahasa.

`guardrail_phrases` dipisah per locale dan wajib punya kolom `author`. Frasa
terlarang harus ditulis penutur asli, bukan hasil terjemahan mesin. Kolom author
memaksa itu terlihat saat audit.

`markets.is_bot_enabled` default `false`. Bahasa baru tidak otomatis menyala
begitu knowledge base-nya masuk; harus dinyalakan sadar setelah pagar pengaman
bahasa itu lengkap.

`tool_calls.idempotency_key` unik. Ini yang mencegah kompensasi terkirim dua kali
saat ada retry.

`messages.original_text` diisi hanya kalau `translated = true`, menyimpan teks
sebelum diterjemahkan supaya audit tetap bisa melihat yang sebenarnya ditulis agent.
