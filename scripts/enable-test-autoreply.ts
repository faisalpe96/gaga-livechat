import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl =
  process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // 1. Enable bot for market ID
  await pool.query(`UPDATE markets SET is_bot_enabled = true WHERE code = 'ID'`);

  // 2. Ensure auto_reply_rules table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      intent text NOT NULL,
      locale text NOT NULL,
      is_enabled boolean NOT NULL DEFAULT false,
      min_confidence numeric(3,2) NOT NULL DEFAULT 0.85,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(intent, locale)
    );
  `);

  // 3. Activate auto-reply rules for topup and faq
  const rules = [
    { intent: 'topup_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
    { intent: 'topup_uncredited', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
    { intent: 'faq_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
    { intent: 'greeting', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
    { intent: 'vague_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
  ];

  for (const r of rules) {
    await pool.query(
      `INSERT INTO auto_reply_rules (intent, locale, is_enabled, min_confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (intent, locale)
       DO UPDATE SET is_enabled = EXCLUDED.is_enabled, min_confidence = EXCLUDED.min_confidence`,
      [r.intent, r.locale, r.is_enabled, r.min_confidence]
    );
  }

  console.log('Successfully enabled bot for market ID and activated auto-reply rules:');
  const res = await pool.query(`SELECT intent, locale, is_enabled, min_confidence FROM auto_reply_rules WHERE locale = 'id-ID'`);
  console.table(res.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
