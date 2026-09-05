import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import runner from 'node-pg-migrate';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

describe('TASK-01: Database Migrations and Seed Tests', () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    // Pastikan koneksi ke database berhasil
    const client = await pool.connect();
    client.release();
  });

  after(async () => {
    await pool.end();
  });

  test('1. Migrasi UP jalan bersih: seluruh ekstensi, enum, tabel, dan kolom terbuat', async () => {
    // Jalankan runner up
    await runner({
      databaseUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // 1.1 Verifikasi ekstensi
    const extRes = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'uuid-ossp')"
    );
    const installedExts = extRes.rows.map((r) => r.extname);
    assert.ok(installedExts.includes('vector'), 'Ekstensi vector wajib terpasang');
    assert.ok(installedExts.includes('uuid-ossp'), 'Ekstensi uuid-ossp wajib terpasang');

    // 1.2 Verifikasi enum
    const enumRes = await pool.query(
      "SELECT typname FROM pg_type WHERE typname IN ('conversation_status', 'sender_type')"
    );
    const installedEnums = enumRes.rows.map((r) => r.typname);
    assert.ok(installedEnums.includes('conversation_status'), 'Enum conversation_status harus ada');
    assert.ok(installedEnums.includes('sender_type'), 'Enum sender_type harus ada');

    // 1.3 Verifikasi tabel yang disyaratkan
    const requiredTables = [
      'markets',
      'agents',
      'conversations',
      'messages',
      'handoffs',
      'kb_documents',
      'canned_responses',
      'guardrail_phrases',
      'bot_feedback',
      'tool_calls'
    ];
    const tableRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [requiredTables]
    );
    const createdTables = tableRes.rows.map((r) => r.table_name);
    for (const tbl of requiredTables) {
      assert.ok(createdTables.includes(tbl), `Tabel ${tbl} harus ada di database`);
    }

    // 1.4 Verifikasi kolom khusus di conversations
    const convColRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' AND column_name IN ('resolution_reason', 'ticket_id')`
    );
    const convCols = convColRes.rows.map((r) => r.column_name);
    assert.ok(convCols.includes('resolution_reason'), 'Kolom resolution_reason wajib ada di conversations');
    assert.ok(convCols.includes('ticket_id'), 'Kolom ticket_id wajib ada di conversations');

    // 1.5 Verifikasi kolom embedding di kb_documents
    const kbColRes = await pool.query(
      `SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'kb_documents' AND column_name = 'embedding'`
    );
    assert.equal(kbColRes.rows.length, 1, 'Kolom embedding harus ada di kb_documents');
    assert.equal(kbColRes.rows[0].udt_name, 'vector', 'Tipe kolom embedding harus vector');
  });

  test('2. Enam pasar ter-seed dengan benar sesuai spec/05-lokalisasi.md', async () => {
    const res = await pool.query('SELECT * FROM markets ORDER BY code ASC');
    assert.equal(res.rows.length, 6, 'Tepat ada 6 pasar ter-seed di tabel markets');

    const expectedMarkets: Record<string, { name: string; locale: string; tz: string; curr: string; locales: string[] }> = {
      TH: { name: 'Thailand', locale: 'th-TH', tz: 'Asia/Bangkok', curr: 'THB', locales: ['th-TH', 'en'] },
      PH: { name: 'Philippines', locale: 'fil-PH', tz: 'Asia/Manila', curr: 'PHP', locales: ['fil-PH', 'en'] },
      ID: { name: 'Indonesia', locale: 'id-ID', tz: 'Asia/Jakarta', curr: 'IDR', locales: ['id-ID', 'en'] },
      MY: { name: 'Malaysia', locale: 'ms-MY', tz: 'Asia/Kuala_Lumpur', curr: 'MYR', locales: ['ms-MY', 'en', 'zh-Hans'] },
      VN: { name: 'Vietnam', locale: 'vi-VN', tz: 'Asia/Ho_Chi_Minh', curr: 'VND', locales: ['vi-VN', 'en'] },
      SG: { name: 'Singapore', locale: 'en', tz: 'Asia/Singapore', curr: 'SGD', locales: ['en', 'zh-Hans'] },
    };

    for (const row of res.rows) {
      const exp = expectedMarkets[row.code];
      assert.ok(exp, `Pasar tidak dikenal: ${row.code}`);
      assert.equal(row.name, exp.name, `Nama pasar untuk ${row.code} tidak cocok`);
      assert.equal(row.default_locale, exp.locale, `Default locale untuk ${row.code} tidak cocok`);
      assert.equal(row.timezone, exp.tz, `Timezone untuk ${row.code} tidak cocok`);
      assert.equal(row.currency, exp.curr, `Currency untuk ${row.code} tidak cocok`);
      assert.deepEqual(row.supported_locales, exp.locales, `Supported locales untuk ${row.code} tidak cocok`);
      assert.equal(row.is_bot_enabled, false, `is_bot_enabled untuk ${row.code} wajib bernilai false`);
      assert.equal(row.hours_start, '09:00:00', `hours_start untuk ${row.code} wajib 09:00:00`);
      assert.equal(row.hours_end, '22:00:00', `hours_end untuk ${row.code} wajib 22:00:00`);
    }
  });

  test('3. Rollback (DOWN) jalan bersih tanpa sisa, lalu re-migrate UP', async () => {
    // 3.1 Rollback 002_seed_markets
    await runner({
      databaseUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'down',
      count: 1,
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    const marketCount = await pool.query('SELECT count(*) FROM markets');
    assert.equal(parseInt(marketCount.rows[0].count, 10), 0, 'Seluruh pasar harus terhapus setelah rollback seed');

    // 3.2 Rollback 001_initial_schema
    await runner({
      databaseUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'down',
      count: 1,
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // Verifikasi tabel dan type terhapus bersih
    const tableRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name != 'pgmigrations'"
    );
    assert.equal(tableRes.rows.length, 0, 'Semua tabel harus terhapus setelah rollback schema');

    const enumRes = await pool.query(
      "SELECT typname FROM pg_type WHERE typname IN ('conversation_status', 'sender_type')"
    );
    assert.equal(enumRes.rows.length, 0, 'Seluruh custom enum harus terhapus setelah rollback schema');

    // 3.3 Re-migrate UP kembali agar database tetap dalam status siap untuk task selanjutnya
    await runner({
      databaseUrl,
      dir: path.resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    const recheckMarkets = await pool.query('SELECT count(*) FROM markets');
    assert.equal(parseInt(recheckMarkets.rows[0].count, 10), 6, 'Database harus kembali memiliki 6 pasar setelah re-migrate');
  });
});
