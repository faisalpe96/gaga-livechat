import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

export async function importPersonasFromCsv(pool: pg.Pool, csvFilePath?: string): Promise<number> {
  const filePath = csvFilePath || path.resolve(process.cwd(), 'data/personas/bot_personas.csv');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Berkas CSV tidak ditemukan di: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length <= 1) return 0;

  // Header: persona,locale,display_name,avatar_url
  const records: Array<{ persona: string; locale: string; display_name: string; avatar_url: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts.length >= 4) {
      records.push({
        persona: parts[0],
        locale: parts[1],
        display_name: parts[2],
        avatar_url: parts[3],
      });
    }
  }

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_personas (
      persona      text NOT NULL,
      locale       text NOT NULL,
      display_name text NOT NULL,
      avatar_url   text NOT NULL,
      PRIMARY KEY (persona, locale)
    )
  `);

  for (const r of records) {
    await pool.query(
      `INSERT INTO bot_personas (persona, locale, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (persona, locale) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url`,
      [r.persona, r.locale, r.display_name, r.avatar_url]
    );
  }

  return records.length;
}

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    console.log('=== Mengimpor Data Bot Personas dari CSV ===');
    const count = await importPersonasFromCsv(pool);
    console.log(`✓ Berhasil mengimpor/memperbarui ${count} baris bot_personas.`);
  } catch (err) {
    console.error('Gagal mengimpor bot_personas:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed-personas.ts')) {
  main();
}
