-- Up Migration
INSERT INTO markets (code, name, default_locale, supported_locales, timezone, currency, hours_start, hours_end, is_bot_enabled)
VALUES
  ('TH', 'Thailand', 'th-TH', ARRAY['th-TH', 'en'], 'Asia/Bangkok', 'THB', '09:00:00', '22:00:00', false),
  ('PH', 'Philippines', 'fil-PH', ARRAY['fil-PH', 'en'], 'Asia/Manila', 'PHP', '09:00:00', '22:00:00', false),
  ('ID', 'Indonesia', 'id-ID', ARRAY['id-ID', 'en'], 'Asia/Jakarta', 'IDR', '09:00:00', '22:00:00', false),
  ('MY', 'Malaysia', 'ms-MY', ARRAY['ms-MY', 'en', 'zh-Hans'], 'Asia/Kuala_Lumpur', 'MYR', '09:00:00', '22:00:00', false),
  ('VN', 'Vietnam', 'vi-VN', ARRAY['vi-VN', 'en'], 'Asia/Ho_Chi_Minh', 'VND', '09:00:00', '22:00:00', false),
  ('SG', 'Singapore', 'en', ARRAY['en', 'zh-Hans'], 'Asia/Singapore', 'SGD', '09:00:00', '22:00:00', false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  default_locale = EXCLUDED.default_locale,
  supported_locales = EXCLUDED.supported_locales,
  timezone = EXCLUDED.timezone,
  currency = EXCLUDED.currency,
  hours_start = EXCLUDED.hours_start,
  hours_end = EXCLUDED.hours_end,
  is_bot_enabled = EXCLUDED.is_bot_enabled;

-- Down Migration
DELETE FROM markets WHERE code IN ('TH', 'PH', 'ID', 'MY', 'VN', 'SG');
