import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgrespassword@localhost:5432/livechat';

const MANDATORY_RULE_KEYS = [
  'bahaya_diri',
  'akun_terkunci',
  'refund',
  'banding_banned',
  'pembelian_anak',
  'hukum_media',
  'minta_manusia',
  'frustrasi',
  'no_promise',
];

interface CsvEntry {
  rule_key: string;
  phrase: string;
  author: string;
  locale: string;
}

export async function importGuardrailsFromCsv(pool: pg.Pool): Promise<{
  totalImported: number;
  localeStats: Record<string, number>;
  entries: CsvEntry[];
}> {
  const templatesDir = path.resolve(process.cwd(), 'data/guardrails/templates');
  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Direktori template ${templatesDir} tidak ditemukan.`);
  }

  const files = fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.csv'));

  const allEntries: CsvEntry[] = [];
  const localeStats: Record<string, number> = {};

  for (const file of files) {
    const locale = path.basename(file, '.csv');
    const filePath = path.join(templatesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');

    if (lines.length <= 1) continue; // Hanya header

    const header = lines[0].split(',').map((h) => h.trim());
    const ruleKeyIdx = header.indexOf('rule_key');
    const phraseIdx = header.indexOf('phrase');
    const authorIdx = header.indexOf('author');

    if (ruleKeyIdx === -1 || phraseIdx === -1 || authorIdx === -1) {
      throw new Error(
        `File ${file} tidak memiliki format header CSV yang valid (wajib: rule_key,phrase,author).`
      );
    }

    const presentKeys = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim());
      if (parts.length < 3) continue;

      const rule_key = parts[ruleKeyIdx];
      const phrase = parts[phraseIdx];
      const author = parts[authorIdx];

      if (!rule_key || !phrase || !author) continue;

      presentKeys.add(rule_key);
      allEntries.push({ rule_key, phrase, author, locale });
    }

    // Validasi kelengkapan aturan kunci untuk locale ini
    for (const mandatory of MANDATORY_RULE_KEYS) {
      if (!presentKeys.has(mandatory)) {
        console.warn(
          `[PERINGATAN] Locale '${locale}' belum memiliki frasa untuk rule_key wajib '${mandatory}'!`
        );
      }
    }

    localeStats[locale] = (localeStats[locale] || 0) + (lines.length - 1);
  }

  // Bersihkan tabel guardrail_phrases sebelum memasukkan data baru
  await pool.query('DELETE FROM guardrail_phrases');

  for (const entry of allEntries) {
    await pool.query(
      `INSERT INTO guardrail_phrases (rule_key, locale, phrase, author)
       VALUES ($1, $2, $3, $4)`,
      [entry.rule_key, entry.locale, entry.phrase, entry.author]
    );
  }

  // Simpan salinan JSON untuk portabilitas
  const jsonPath = path.resolve(process.cwd(), 'data/guardrails/phrases.json');
  fs.writeFileSync(jsonPath, JSON.stringify(allEntries, null, 2), 'utf-8');

  return {
    totalImported: allEntries.length,
    localeStats,
    entries: allEntries,
  };
}

async function main() {
  console.log('=== Memulai Validasi dan Impor Guardrail Phrases ===');
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const result = await importGuardrailsFromCsv(pool);
    console.log(`\nBerhasil mengimpor ${result.totalImported} frasa pagar pengaman:`);
    for (const [loc, count] of Object.entries(result.localeStats)) {
      console.log(`  ✓ Locale '${loc}': ${count} frasa`);
    }
    console.log(`\nData tersimpan ke tabel PostgreSQL 'guardrail_phrases' dan salinan 'data/guardrails/phrases.json'.`);
  } catch (err) {
    console.error('Gagal mengimpor guardrail phrases:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('seed-guardrails.ts')) {
  main();
}
