import dotenv from 'dotenv';
import pg from 'pg';
import runner from 'node-pg-migrate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const migrationsDir = path.resolve(rootDir, 'migrations');

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

async function waitForDatabase(pool: pg.Pool, maxRetries = 15, delayMs = 2000): Promise<void> {
  console.log('[Deploy Migrate] Menghubungkan ke PostgreSQL...');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(`[Deploy Migrate] Koneksi ke database berhasil (Percobaan ke-${attempt}).`);
      return;
    } catch (err: any) {
      console.warn(`[Deploy Migrate] Percobaan ke-${attempt}/${maxRetries} gagal: ${err.message}. Menunggu ${delayMs / 1000}s...`);
      if (attempt === maxRetries) {
        throw new Error(`Tidak dapat terhubung ke database setelah ${maxRetries} percobaan: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function ensureExtensions(pool: pg.Pool): Promise<void> {
  console.log('[Deploy Migrate] Memastikan ekstensi database (vector, uuid-ossp, pgcrypto)...');
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "vector";');
    console.log('[Deploy Migrate] Ekstensi berhasil diverifikasi.');
  } catch (err: any) {
    console.warn('[Deploy Migrate] Catatan saat inisialisasi ekstensi:', err.message);
  }
}

async function runMigrations(): Promise<void> {
  console.log(`[Deploy Migrate] Menjalankan migrasi SQL dari ${migrationsDir}...`);
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: true,
  });
  console.log('[Deploy Migrate] Seluruh migrasi berhasil dijalankan (UP).');
}

async function ensureEssentialSeeds(pool: pg.Pool): Promise<void> {
  // 1. Cek tabel markets
  const marketRes = await pool.query('SELECT count(*)::int AS cnt FROM markets');
  if ((marketRes.rows[0]?.cnt || 0) === 0) {
    console.log('[Deploy Migrate] Tabel markets kosong, melakukan seeding 6 pasar SEA...');
    await pool.query(`
      INSERT INTO markets (code, name, default_locale, timezone, operating_hours, is_bot_enabled, created_at, updated_at)
      VALUES
        ('ID', 'Indonesia', 'id-ID', 'Asia/Jakarta', '{"start": "09:00", "end": "21:00"}', false, now(), now()),
        ('SG', 'Singapore', 'en', 'Asia/Singapore', '{"start": "09:00", "end": "21:00"}', false, now(), now()),
        ('MY', 'Malaysia', 'ms-MY', 'Asia/Kuala_Lumpur', '{"start": "09:00", "end": "21:00"}', false, now(), now()),
        ('TH', 'Thailand', 'th-TH', 'Asia/Bangkok', '{"start": "09:00", "end": "21:00"}', false, now(), now()),
        ('PH', 'Philippines', 'fil-PH', 'Asia/Manila', '{"start": "09:00", "end": "21:00"}', false, now(), now()),
        ('VN', 'Vietnam', 'vi-VN', 'Asia/Ho_Chi_Minh', '{"start": "09:00", "end": "21:00"}', false, now(), now())
      ON CONFLICT (code) DO NOTHING;
    `);
    console.log('[Deploy Migrate] 6 Pasar SEA berhasil di-seed.');
  }

  // 2. Cek akun admin
  const adminRes = await pool.query("SELECT count(*)::int AS cnt FROM agents WHERE role = 'admin'");
  if ((adminRes.rows[0]?.cnt || 0) === 0) {
    console.log('-------------------------------------------------------------------');
    console.log('[PERINGATAN OPERASIONAL DEPLOY]');
    console.log('Belum ada akun peran ADMIN di database.');
    console.log('Jalankan perintah berikut untuk membuat akun admin pertama:');
    console.log('  npm run admin:create -- --email admin@gagagames.com --password YourPasswordHere');
    console.log('-------------------------------------------------------------------');
  }
}

async function main() {
  console.log('===================================================================');
  console.log('  GAGA LIVECHAT — AUTOMATED DEPLOYMENT MIGRATION & HEALTH CHECK   ');
  console.log('  (spec/09-produksi.md Bagian 3 & 4)                              ');
  console.log('===================================================================');

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    await waitForDatabase(pool);
    await ensureExtensions(pool);
    await runMigrations();
    await ensureEssentialSeeds(pool);

    console.log('===================================================================');
    console.log('  MIGRASI DEPLOYMENT SELESAI DENGAN SUKSES                       ');
    console.log('===================================================================');
    process.exit(0);
  } catch (err: any) {
    console.error('[Deploy Migrate FATAL ERROR]', err.message || err);
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}

main();
