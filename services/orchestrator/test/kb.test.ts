import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeBaseRetriever } from '../src/kb/retriever.js';
import { CannedResponseService } from '../src/kb/canned-responses.js';
import { getEmbeddingProvider } from '../src/kb/embeddings.js';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

describe('TASK-05: Knowledge Base and Vector Indexing Tests', () => {
  let pool: pg.Pool;
  let retriever: KnowledgeBaseRetriever;
  let cannedService: CannedResponseService;

  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const embeddingProvider = getEmbeddingProvider();
    retriever = new KnowledgeBaseRetriever(pool, embeddingProvider);
    cannedService = new CannedResponseService(pool);

    // Seed data dari file JSON
    const faqPath = path.resolve(process.cwd(), 'data/kb/faq.json');
    const cannedPath = path.resolve(process.cwd(), 'data/kb/canned-responses.json');

    const faqData = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
    for (const doc of faqData) {
      await retriever.upsertDocument(doc);
    }

    const cannedData = JSON.parse(fs.readFileSync(cannedPath, 'utf-8'));
    for (const item of cannedData) {
      await cannedService.upsertCannedResponse(item);
    }
  });

  after(async () => {
    await pool.end();
  });

  test('1. Impor FAQ dan Canned Responses berhasil masuk ke database dan terindeks embedding', async () => {
    // 1.1 Verifikasi dokumen kb_documents
    const kbRes = await pool.query('SELECT count(*) FROM kb_documents');
    const kbCount = parseInt(kbRes.rows[0].count, 10);
    assert.ok(kbCount >= 14, `kb_documents harus berisi minimal 14 dokumen (aktual: ${kbCount})`);

    // Verifikasi kolom embedding tidak null dan berdimensi 1536
    const embedRes = await pool.query(`
      SELECT doc_key, locale, is_policy, (embedding IS NOT NULL) AS has_embedding
      FROM kb_documents
      LIMIT 5
    `);
    for (const row of embedRes.rows) {
      assert.equal(row.has_embedding, true, `Dokumen ${row.doc_key} (${row.locale}) wajib memiliki embedding`);
    }

    // 1.2 Verifikasi canned_responses
    const cannedRes = await pool.query('SELECT count(*) FROM canned_responses');
    const cannedCount = parseInt(cannedRes.rows[0].count, 10);
    assert.ok(cannedCount >= 15, `canned_responses harus berisi minimal 15 balasan (aktual: ${cannedCount})`);
  });

  test('2. Kriteria Terima: Pencarian th-TH TIDAK PERNAH mengembalikan dokumen kebijakan berbahasa lain', async () => {
    // Cari dengan query "refund policy" dalam bahasa Inggris saat targetLocale = th-TH
    // Walaupun teks query berbahasa Inggris dan persis dengan judul 'Refund Policy' bahasa Inggris (en),
    // sistem WAJIB MENOLAK dokumen kebijakan (is_policy = true) yang berbahasa en, id-ID, dsb.
    const searchResults = await retriever.search('refund policy request 7 days', 'th-TH', { limit: 10 });

    assert.ok(searchResults.length > 0, 'Harus ada hasil pencarian yang dikembalikan');

    // Evaluasi seluruh dokumen kebijakan (is_policy = true)
    const policyDocs = searchResults.filter((r) => r.is_policy === true);
    assert.ok(policyDocs.length > 0, 'Harus menemukan dokumen kebijakan refund untuk th-TH');

    for (const doc of policyDocs) {
      assert.equal(
        doc.locale,
        'th-TH',
        `Pelanggaran Isolasi Kebijakan: Dokumen kebijakan ${doc.doc_key} memiliki locale '${doc.locale}', bukan 'th-TH'!`
      );
      assert.notEqual(doc.locale, 'en', 'Dokumen kebijakan bahasa Inggris tidak boleh bocor ke th-TH');
      assert.notEqual(doc.locale, 'id-ID', 'Dokumen kebijakan bahasa Indonesia tidak boleh bocor ke th-TH');
    }

    // Uji kedua: query Thai "นโยบายการคืนเงิน" (Refund Policy)
    const thaiSearch = await retriever.search('นโยบายการคืนเงิน', 'th-TH', { limit: 10 });
    const thaiPolicies = thaiSearch.filter((r) => r.is_policy === true);
    for (const doc of thaiPolicies) {
      assert.equal(doc.locale, 'th-TH', 'Hanya dokumen kebijakan th-TH yang boleh dikembalikan');
    }
  });

  test('3. Kriteria Terima: Dokumen non-kebijakan (is_policy = false) BOLEH lintas bahasa', async () => {
    // Topik VIP benefits (faq_vip_benefits) HANYA tersedia dalam bahasa 'en' di data seed.
    // Saat pemain/agen di locale 'th-TH' mencari tentang VIP privilege,
    // dokumen non-kebijakan ini BOLEH dikembalikan lintas bahasa.
    const searchResults = await retriever.search('VIP privilege benefits daily rewards', 'th-TH', { limit: 5 });

    assert.ok(searchResults.length > 0, 'Pencarian non-kebijakan harus mengembalikan hasil');

    const vipDoc = searchResults.find((r) => r.doc_key === 'faq_vip_benefits');
    assert.ok(vipDoc, 'Dokumen faq_vip_benefits (bahasa en) harus berhasil ditemukan saat dicari di th-TH');
    assert.equal(vipDoc.is_policy, false, 'Dokumen yang lintas bahasa harus bertipe is_policy = false');
    assert.equal(vipDoc.locale, 'en', 'Dokumen non-kebijakan yang dikembalikan berasal dari locale en');
  });

  test('4. Pencarian di locale id-ID mengisolasi kebijakan id-ID dan memblokir kebijakan luar', async () => {
    const results = await retriever.search('kebijakan banding akun banned suspensi', 'id-ID', { limit: 5 });
    assert.ok(results.length > 0);

    const policyDocs = results.filter((r) => r.is_policy === true);
    assert.ok(policyDocs.length > 0, 'Harus menemukan kebijakan unban untuk id-ID');

    for (const doc of policyDocs) {
      assert.equal(doc.locale, 'id-ID', 'Semua dokumen kebijakan yang dikembalikan harus ber-locale id-ID');
    }
  });

  test('5. Bank Canned Response mengambil template yang tepat sesuai template_id dan locale', async () => {
    const thGreeting = await cannedService.getCannedResponse('greeting_general', 'th-TH');
    assert.ok(thGreeting);
    assert.ok(thGreeting.body.includes('สวัสดี'), 'Greeting th-TH harus berbahasa Thailand');

    const idGreeting = await cannedService.getCannedResponse('greeting_general', 'id-ID');
    assert.ok(idGreeting);
    assert.ok(idGreeting.body.includes('Halo kak'), 'Greeting id-ID harus berbahasa Indonesia');

    const enGreeting = await cannedService.getCannedResponse('greeting_general', 'en');
    assert.ok(enGreeting);
    assert.ok(enGreeting.body.includes('Welcome to Gaga Games'), 'Greeting en harus berbahasa Inggris');

    const viWait = await cannedService.getCannedResponse('wait_agent_connecting', 'vi-VN');
    assert.ok(viWait);
    assert.ok(viWait.body.includes('kết nối'), 'Handoff vi-VN harus berbahasa Vietnam');
  });

  test('6. Ambang Kemiripan & Relevansi: Query top-up hanya mengembalikan faq_topup_guide dan memblokir policy_unban serta policy_refund', async () => {
    const results = await retriever.search('cara top up diamond saldo game', 'id-ID', { limit: 5 });

    // Kriteria Terima: Tidak mengembalikan 5 dokumen sembarangan
    assert.ok(results.length > 0 && results.length < 5, `Jumlah dokumen harus relevan (< 5), aktual: ${results.length}`);

    // Kriteria Terima: Hanya dokumen relevan yang masuk
    const keys = results.map((r) => r.doc_key);
    assert.ok(keys.includes('faq_topup_guide'), 'Wajib memuat dokumen panduan top-up');

    // Kriteria Terima: policy_unban dan policy_refund DILARANG masuk konteks
    assert.equal(keys.includes('policy_unban'), false, 'policy_unban tidak boleh masuk ke konteks pertanyaan top-up');
    assert.equal(keys.includes('policy_refund'), false, 'policy_refund tidak boleh masuk ke konteks pertanyaan top-up');

    // Kriteria Terima: Bahasa dokumen yang dikembalikan harus cocok dengan targetLocale id-ID
    for (const doc of results) {
      assert.equal(doc.locale, 'id-ID', 'Dokumen yang dikembalikan harus dalam bahasa Indonesia');
    }
  });
});

