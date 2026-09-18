-- Up Migration
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_persona text;

CREATE TABLE IF NOT EXISTS bot_personas (
  persona      text NOT NULL,
  locale       text NOT NULL,
  display_name text NOT NULL,
  avatar_url   text NOT NULL,
  PRIMARY KEY (persona, locale)
);

INSERT INTO bot_personas (persona, locale, display_name, avatar_url) VALUES
  ('mira', 'id-ID', 'Mira', '/assets/agent-mira.png'),
  ('mira', 'ms-MY', 'Mira', '/assets/agent-mira.png'),
  ('mira', 'en', 'Mira', '/assets/agent-mira.png'),
  ('mira', 'fil-PH', 'Mira', '/assets/agent-mira.png'),
  ('mira', 'th-TH', 'Ploy', '/assets/agent-mira.png'),
  ('mira', 'vi-VN', 'Linh', '/assets/agent-mira.png'),
  ('reza', 'id-ID', 'Reza', '/assets/agent-reza.png'),
  ('reza', 'ms-MY', 'Reza', '/assets/agent-reza.png'),
  ('reza', 'en', 'Ray', '/assets/agent-reza.png'),
  ('reza', 'fil-PH', 'Ray', '/assets/agent-reza.png'),
  ('reza', 'th-TH', 'Ton', '/assets/agent-reza.png'),
  ('reza', 'vi-VN', 'Minh', '/assets/agent-reza.png')
ON CONFLICT (persona, locale) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  avatar_url = EXCLUDED.avatar_url;

-- Down Migration
DROP TABLE IF EXISTS bot_personas CASCADE;
ALTER TABLE conversations DROP COLUMN IF EXISTS bot_persona;
