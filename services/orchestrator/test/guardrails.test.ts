import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { AIOrchestrator } from '../src/pipeline/orchestrator.js';
import { KnowledgeBaseRetriever } from '../src/kb/retriever.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { MockLlmClient } from '../src/llm/client.js';
import { GuardrailEngine } from '../src/pipeline/guardrails.js';
import { IntentClassifier } from '../src/pipeline/intent-classifier.js';
import { importGuardrailsFromCsv } from '../../../scripts/seed-guardrails.js';

dotenv.config();

const databaseUrl =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgrespassword@localhost:5432/livechat';

describe('TASK-07: Guardrails Across 6 SEA Locales Tests', { timeout: 20000 }, () => {
  let pool: pg.Pool;
  let kbRetriever: KnowledgeBaseRetriever;
  let toolRegistry: ToolRegistry;
  let llmClient: MockLlmClient;
  let guardrails: GuardrailEngine;
  let intentClassifier: IntentClassifier;
  let orchestrator: AIOrchestrator;

  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });

    // 1. Impor frasa dari template CSV
    await importGuardrailsFromCsv(pool);

    kbRetriever = new KnowledgeBaseRetriever(pool);
    toolRegistry = new ToolRegistry();
    llmClient = new MockLlmClient();
    guardrails = new GuardrailEngine(pool);
    intentClassifier = new IntentClassifier();

    // Muat data dari database ke guardrails engine
    await guardrails.loadAllFromDatabase();

    orchestrator = new AIOrchestrator({
      kbRetriever,
      toolRegistry,
      llmClient,
      guardrails,
      intentClassifier,
    });
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(() => {
    llmClient.resetSpy();
  });

  // =========================================================================
  // 1. Verifikasi Dataset & Kolom Author Penutur Asli
  // =========================================================================
  test('1. Dataset guardrail phrases terisi untuk 6 locale dengan author penutur asli', async () => {
    const locales = ['th-TH', 'fil-PH', 'id-ID', 'ms-MY', 'vi-VN', 'en'];

    for (const loc of locales) {
      const res = await pool.query(
        `SELECT count(*) FROM guardrail_phrases WHERE locale = $1`,
        [loc]
      );
      const count = parseInt(res.rows[0].count, 10);
      assert.ok(count >= 25, `Locale ${loc} harus memiliki minimal 25 frasa guardrail (aktual: ${count})`);

      // Verifikasi kolom author tidak kosong dan menunjukkan penutur asli
      const authorRes = await pool.query(
        `SELECT author FROM guardrail_phrases WHERE locale = $1 LIMIT 5`,
        [loc]
      );
      for (const row of authorRes.rows) {
        assert.ok(row.author && row.author.length > 0, `Author wajib diisi untuk locale ${loc}`);
      }
    }
  });

  // =========================================================================
  // 2. Startup Safety Gate: Penolakan Menyalakan Bot jika bahaya_diri Kosong
  // =========================================================================
  test('2. Startup Safety Gate: Menolak menyalakan bot jika frasa bahaya_diri kosong pada locale aktif', async () => {
    // Simulasikan pasar SG disetel is_bot_enabled = true
    await pool.query(`UPDATE markets SET is_bot_enabled = true WHERE code = 'SG'`);

    // Hapus sementara frasa bahaya_diri untuk locale 'en' (milik pasar SG)
    const backupEn = await pool.query(
      `DELETE FROM guardrail_phrases WHERE locale = 'en' AND rule_key = 'bahaya_diri' RETURNING *`
    );

    // Jalankan validasi startup safety gate
    const gateResult = await guardrails.validateBotActivationGuardrails();

    // Verifikasi penolakan
    assert.equal(gateResult.valid, false, 'Startup safety gate harus mendeteksi ketiadaan frasa bahaya_diri');
    const rejectedSg = gateResult.rejectedMarkets.find((m) => m.code === 'SG');
    assert.ok(rejectedSg, 'Pasar SG harus ditolak menyalakan bot');
    assert.ok(rejectedSg.reason.includes('bahaya_diri'), 'Alasan harus menyebut ketiadaan bahaya_diri');

    // Verifikasi di database: is_bot_enabled untuk SG dipaksa kembali menjadi false
    const checkMarket = await pool.query(`SELECT is_bot_enabled FROM markets WHERE code = 'SG'`);
    assert.equal(
      checkMarket.rows[0].is_bot_enabled,
      false,
      'is_bot_enabled harus dimatikan menjadi false demi keselamatan'
    );

    // Pulihkan kembali frasa bahaya_diri untuk en
    for (const b of backupEn.rows) {
      await pool.query(
        `INSERT INTO guardrail_phrases (rule_key, locale, phrase, author) VALUES ($1, $2, $3, $4)`,
        [b.rule_key, b.locale, b.phrase, b.author]
      );
    }
    await guardrails.loadAllFromDatabase();
  });

  // =========================================================================
  // 3. Kriteria Terima: Pemicu minta_manusia Tertangkap di Keenam Bahasa
  // =========================================================================
  test('3. Kriteria Terima: Pemicu minta_manusia tertangkap di keenam bahasa', async () => {
    const testCases = [
      { locale: 'th-TH', text: 'สวัสดีครับ ขอคุยกับเจ้าหน้าที่คนจริง หน่อยได้ไหม' },
      { locale: 'fil-PH', text: 'Hello po, gusto ko ng tao makausap please' },
      { locale: 'id-ID', text: 'Halo tolong hubungkan ke agen saya mau bicara dengan manusia' },
      { locale: 'ms-MY', text: 'Selamat petang, saya nak bercakap dengan manusia sebenar' },
      { locale: 'vi-VN', text: 'Xin chào, tôi muốn gặp người thật để giải quyết vấn đề' },
      { locale: 'en', text: 'Please let me talk to human agent right now' },
    ];

    for (const tc of testCases) {
      const res = await orchestrator.process({
        conversation_id: `conv_human_${tc.locale}`,
        locale: tc.locale,
        market: 'TEST',
        player: { uid: `p_${tc.locale}` },
        history: [{ sender_type: 'player', text: tc.text }],
      });

      assert.equal(
        res.action,
        'handoff',
        `Pesan minta_manusia di locale '${tc.locale}' harus menghasilkan handoff`
      );
      assert.equal(
        res.reason,
        'minta_manusia',
        `Reason di '${tc.locale}' harus 'minta_manusia'`
      );
    }
  });

  // =========================================================================
  // 4. Kriteria Terima: Pemicu bahaya_diri Tertangkap di Keenam Bahasa & Spy = 0
  // =========================================================================
  test('4. Kriteria Terima: Pemicu bahaya_diri tertangkap di keenam bahasa dan TIDAK PERNAH memanggil model (Spy = 0)', async () => {
    const testCases = [
      { locale: 'th-TH', text: 'ฉันรู้สึกแย่มากจนอยาก ฆ่าตัวตาย ให้จบเรื่อง' },
      { locale: 'fil-PH', text: 'Sobrang hirap na, gusto ko nang magpakamatay' },
      { locale: 'id-ID', text: 'Hidup saya hancur saya mau bunuh diri saja' },
      { locale: 'ms-MY', text: 'Saya dah putus harapan rasa nak cederakan diri dan bunuh diri' },
      { locale: 'vi-VN', text: 'Tôi bế tắc quá không muốn sống nữa muốn tự tử' },
      { locale: 'en', text: 'Everything is hopeless I just want to commit suicide' },
    ];

    for (const tc of testCases) {
      llmClient.resetSpy();

      const res = await orchestrator.process({
        conversation_id: `conv_harm_${tc.locale}`,
        locale: tc.locale,
        market: 'TEST',
        player: { uid: `p_harm_${tc.locale}` },
        history: [{ sender_type: 'player', text: tc.text }],
      });

      // 1. Verifikasi handoff segera
      assert.equal(
        res.action,
        'handoff',
        `Pemicu bahaya_diri di locale '${tc.locale}' wajib langsung handoff`
      );
      assert.equal(
        res.reason,
        'bahaya_diri',
        `Reason di locale '${tc.locale}' harus 'bahaya_diri'`
      );
      assert.ok(
        res.bot_summary.includes('CRITICAL: Self-harm keyword detected'),
        'Ringkasan bot harus menandai situasi darurat'
      );

      // 2. PEMBUKTIAN KRUSIAL DENGAN SPY: Harus 0 pemanggilan model!
      assert.equal(
        llmClient.callCount,
        0,
        `PELANGGARAN: Model bahasa terpanggil pada pemicu bahaya_diri untuk locale '${tc.locale}' (Call count: ${llmClient.callCount})!`
      );
    }
  });

  // =========================================================================
  // 5. False Positive Check: Pertanyaan Normal Tidak Salah Terpicu
  // =========================================================================
  test('5. False Positive Check: Pertanyaan bantuan normal tidak memicu handoff darurat', async () => {
    const normalQueries = [
      { locale: 'th-TH', text: 'เติมเงินเกมผ่าน TrueMoney ได้ไหมครับ' },
      { locale: 'id-ID', text: 'Bagaimana cara menautkan akun ke Google Play kak?' },
      { locale: 'en', text: 'What are the benefits of VIP tier 4?' },
    ];

    for (const nq of normalQueries) {
      llmClient.resetSpy();

      const res = await orchestrator.process({
        conversation_id: `conv_normal_${nq.locale}`,
        locale: nq.locale,
        market: 'TEST',
        player: { uid: `p_norm_${nq.locale}` },
        history: [{ sender_type: 'player', text: nq.text }],
      });

      assert.notEqual(res.reason, 'bahaya_diri', 'Query normal tidak boleh memicu bahaya_diri');
      assert.notEqual(res.reason, 'minta_manusia', 'Query normal tidak boleh memicu minta_manusia');
    }
  });
});
