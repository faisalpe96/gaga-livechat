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
import { EmotionDetector } from '../src/pipeline/emotion-detector.js';
import { ConversationFlowManager } from '../src/pipeline/conversation-flow.js';
import { Database } from '../../gateway/src/db.js';

dotenv.config();

const databaseUrl =
  process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

describe('Continuous Conversation: Stage Awareness, No-Doc Fallback, Sequential Slots, & Emotion Recognition', { timeout: 25000 }, () => {
  let pool: pg.Pool;
  let db: Database;
  let kbRetriever: KnowledgeBaseRetriever;
  let toolRegistry: ToolRegistry;
  let llmClient: MockLlmClient;
  let guardrails: GuardrailEngine;
  let intentClassifier: IntentClassifier;
  let emotionDetector: EmotionDetector;
  let flowManager: ConversationFlowManager;
  let orchestrator: AIOrchestrator;

  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    db = new Database(databaseUrl);
    kbRetriever = new KnowledgeBaseRetriever(pool);
    toolRegistry = new ToolRegistry();
    llmClient = new MockLlmClient();
    guardrails = new GuardrailEngine(pool);
    await guardrails.loadAllFromDatabase();
    intentClassifier = new IntentClassifier();
    emotionDetector = new EmotionDetector();
    flowManager = new ConversationFlowManager();

    orchestrator = new AIOrchestrator({
      kbRetriever,
      toolRegistry,
      llmClient,
      guardrails,
      intentClassifier,
      emotionDetector,
      flowManager,
    });
  });

  after(async () => {
    try {
      await db.close();
    } catch {}
    try {
      await pool.end();
    } catch {}
  });

  beforeEach(() => {
    llmClient.resetSpy();
    intentClassifier.setOverrideConfidence(undefined);
  });

  // =========================================================================
  // FITUR 1: Kasus Tanpa Dokumen Cocok (Humane No-Doc Fallback)
  // =========================================================================
  describe('Fitur 1: Humane No-Doc Fallback', () => {
    test('1.1 Pertanyaan tanpa dokumen cocok TIDAK diam dan TIDAK handoff, melainkan membalas dengan template manusiawi per locale (id-ID)', async () => {
      const req = {
        conversation_id: 'conv_nodoc_id',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_nodoc_1' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'Bagaimana cara memancing ikan paus purba di kolam rahasia?',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply', 'Bot harus tetap membalas, tidak boleh diam atau handoff senyap');
      assert.ok(result.text.length > 0, 'Balasan tidak boleh kosong');
      // Menjawab secara manusiawi dengan template no-doc: mengakui belum ada panduan & menawarkan bantuan CS
      assert.ok(
        result.text.includes('belum menemukan panduan') || result.text.includes('belum menemukan rujukan'),
        `Teks harus ramah dan mengakui belum ada panduan. Aktual: "${result.text}"`
      );
      assert.ok(
        result.text.includes('customer service') || result.text.includes('agen CS'),
        'Harus menawarkan opsi bantuan CS atau meminta detail tambahan'
      );
      assert.ok(
        result.meta.sources.includes('canned_no_doc_fallback'),
        'meta.sources wajib mencatat canned_no_doc_fallback'
      );
      assert.ok(result.meta.confidence >= 0.75, 'Confidence harus di atas ambang minimum');
    });

    test('1.2 Pertanyaan tanpa dokumen cocok pada locale bahasa Inggris (en)', async () => {
      const req = {
        conversation_id: 'conv_nodoc_en',
        locale: 'en',
        market: 'GLOBAL',
        player: { uid: 'player_nodoc_2' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'How do I tame a legendary mythical flying dragon on level 99?',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.ok(
        result.text.includes('could not find specific documentation') || result.text.includes('do not have reference guides'),
        `Teks balasan Inggris harus sesuai template fallback. Aktual: "${result.text}"`
      );
      assert.ok(result.meta.sources.includes('canned_no_doc_fallback'));
    });

    test('1.3 Pertanyaan tanpa dokumen cocok pada locale Thailand (th-TH)', async () => {
      const req = {
        conversation_id: 'conv_nodoc_th',
        locale: 'th-TH',
        market: 'TH',
        player: { uid: 'player_nodoc_3' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'วิธีจับมังกรโบราณในป่าลึกลับทำอย่างไรครับ',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.ok(
        result.text.includes('ไม่พบคู่มือ') || result.text.includes('ไม่พบข้อมูล'),
        `Teks balasan Thailand harus sesuai template fallback. Aktual: "${result.text}"`
      );
      assert.ok(result.meta.sources.includes('canned_no_doc_fallback'));
    });
  });

  // =========================================================================
  // FITUR 2: Pengenalan Emosi & Empati Pemain Kesal
  // =========================================================================
  describe('Fitur 2: Emotion Recognition & Empathy for Frustrated Players', () => {
    test('2.1 Pemain dengan nada kesal ("woi lambat banget pelayanan kalian kesal saya diamond belum masuk juga!!") diakui dulu perasaannya', async () => {
      const req = {
        conversation_id: 'conv_frustrated_id',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_upset_1' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'woi lambat banget pelayanan kalian, kesal saya diamond belum masuk juga!!',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.emotion, 'frustrated', 'Emosi pemain harus terdeteksi frustrated');

      // SYARAT MUTLAK: Akui dulu keluhannya sebelum masuk ke solusi/pertanyaan
      assert.ok(
        result.text.includes('Paham banget kak, pasti kesal dan tidak nyaman'),
        `Balasan wajib diawali empati yang mengakui kekesalan pemain. Aktual: "${result.text}"`
      );

      // Setelah empati, bot menanyakan data yang diperlukan (order ID)
      assert.ok(
        result.text.includes('Order ID') || result.text.includes('order_123'),
        'Setelah empati, bot meminta data yang diperlukan'
      );
    });

    test('2.2 Pemain kesal dalam bahasa Inggris diakui perasaannya sebelum solusi', async () => {
      const req = {
        conversation_id: 'conv_frustrated_en',
        locale: 'en',
        market: 'GLOBAL',
        player: { uid: 'player_upset_2' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'I am so frustrated, this is ridiculous! My diamonds are not credited!!',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.emotion, 'frustrated');
      assert.ok(
        result.text.includes('understand your frustration') || result.text.includes('apologize for the inconvenience'),
        `Harus ada kalimat empati bahasa Inggris. Aktual: "${result.text}"`
      );
    });

    test('2.3 Pemain tenang/netral tidak mendapatkan pembuka permohonan maaf berlebihan', async () => {
      const req = {
        conversation_id: 'conv_calm_id',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_calm_1' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'Halo min, mau tanya diamond saya belum masuk ya',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.emotion, 'neutral');
      // Tidak boleh mendramatisir kalimat emosi kesal jika pemain netral
      assert.ok(
        !result.text.includes('Paham banget kak, pasti kesal'),
        'Pemain netral tidak perlu diawali empati kekesalan'
      );
      assert.ok(result.text.includes('Order ID') || result.text.includes('order_123'));
    });
  });

  // =========================================================================
  // FITUR 3: Pengumpulan Data Bertahap (Sequential Slot Filling)
  // =========================================================================
  describe('Fitur 3: Sequential Slot Filling (Menanyakan Satu per Satu)', () => {
    test('3.1 Alur multi-turn lengkap: bot menanyakan order ID, lalu nominal, lalu metode, lalu jam transaksi satu per satu', async () => {
      const convId = 'conv_slot_progression';
      let history: Array<{ sender_type: 'player' | 'bot'; text: string }> = [];
      let collectedSlots: Record<string, string> = {};

      // Turn 1: Pemain mengeluh topup belum masuk
      history.push({ sender_type: 'player', text: 'Halo min, saldo saya terpotong tapi diamond belum masuk' });
      let res1 = await orchestrator.process({
        conversation_id: convId,
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_multi_1' },
        stage: 'discovery',
        collected_slots: collectedSlots,
        history,
      });

      assert.equal(res1.action, 'reply');
      assert.equal(res1.meta.stage, 'data_collection', 'Stage harus masuk ke data_collection');
      assert.equal(res1.meta.current_slot, 'order_id', 'Slot pertama yang diminta wajib order_id');
      assert.ok(res1.text.includes('Order ID') || res1.text.includes('order_123'));
      // Verifikasi TIDAK menanyakan nominal, metode, dan jam sekaligus di pesan pertama
      assert.ok(!res1.text.includes('nominal top-up'), 'Tidak boleh menanyakan nominal di pesan pertama');
      assert.ok(!res1.text.includes('metode pembayaran apa'), 'Tidak boleh menanyakan metode pembayaran di pesan pertama');
      assert.ok(!res1.text.includes('sekitar jam berapa'), 'Tidak boleh menanyakan jam di pesan pertama');

      history.push({ sender_type: 'bot', text: res1.text });
      collectedSlots = res1.meta.collected_slots || {};

      // Turn 2: Pemain memberikan Order ID
      history.push({ sender_type: 'player', text: 'Order ID saya order_998877 kak' });
      let res2 = await orchestrator.process({
        conversation_id: convId,
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_multi_1' },
        stage: 'data_collection',
        page_context: { current_slot: 'order_id' },
        collected_slots: collectedSlots,
        history,
      });

      assert.equal(res2.action, 'reply');
      assert.equal(res2.meta.stage, 'data_collection');
      assert.equal(res2.meta.collected_slots?.order_id, 'order_998877', 'Order ID berhasil terekstrak');
      assert.equal(res2.meta.current_slot, 'amount', 'Slot kedua yang diminta wajib nominal (amount)');
      assert.ok(res2.text.includes('nominal') || res2.text.includes('diamond yang dibeli'));
      // Verifikasi TIDAK menanyakan metode dan jam
      assert.ok(!res2.text.includes('metode pembayaran apa'));
      assert.ok(!res2.text.includes('sekitar jam berapa'));

      history.push({ sender_type: 'bot', text: res2.text });
      collectedSlots = res2.meta.collected_slots || {};

      // Turn 3: Pemain memberikan nominal
      history.push({ sender_type: 'player', text: 'Nominalnya 50rb dapat 100 diamond' });
      let res3 = await orchestrator.process({
        conversation_id: convId,
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_multi_1' },
        stage: 'data_collection',
        page_context: { current_slot: 'amount' },
        collected_slots: collectedSlots,
        history,
      });

      assert.equal(res3.action, 'reply');
      assert.equal(res3.meta.stage, 'data_collection');
      assert.ok(res3.meta.collected_slots?.amount, 'Nominal berhasil terekstrak');
      assert.equal(res3.meta.current_slot, 'payment_method', 'Slot ketiga yang diminta wajib payment_method');
      assert.ok(res3.text.includes('metode pembayaran'));
      assert.ok(!res3.text.includes('sekitar jam berapa'));

      history.push({ sender_type: 'bot', text: res3.text });
      collectedSlots = res3.meta.collected_slots || {};

      // Turn 4: Pemain memberikan metode pembayaran
      history.push({ sender_type: 'player', text: 'Saya bayar via QRIS' });
      let res4 = await orchestrator.process({
        conversation_id: convId,
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_multi_1' },
        stage: 'data_collection',
        page_context: { current_slot: 'payment_method' },
        collected_slots: collectedSlots,
        history,
      });

      assert.equal(res4.action, 'reply');
      assert.equal(res4.meta.stage, 'data_collection');
      assert.equal(res4.meta.collected_slots?.payment_method, 'QRIS', 'Metode pembayaran QRIS terekstrak');
      assert.equal(res4.meta.current_slot, 'transaction_time', 'Slot keempat yang diminta wajib waktu transaksi');
      assert.ok(res4.text.includes('jam berapa') || res4.text.includes('transaksinya'));

      history.push({ sender_type: 'bot', text: res4.text });
      collectedSlots = res4.meta.collected_slots || {};

      // Turn 5: Pemain memberikan jam transaksi
      history.push({ sender_type: 'player', text: 'Kira-kira jam 14:30 tadi siang' });
      let res5 = await orchestrator.process({
        conversation_id: convId,
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_multi_1' },
        stage: 'data_collection',
        page_context: { current_slot: 'transaction_time' },
        collected_slots: collectedSlots,
        history,
      });

      assert.equal(res5.action, 'reply');
      assert.equal(res5.meta.stage, 'resolution', 'Semua slot lengkap, stage harus berpindah ke resolution');
      assert.ok(res5.meta.collected_slots?.transaction_time, 'Waktu transaksi terekstrak');

      // Verifikasi rangkuman lengkap terlampir
      assert.ok(res5.text.includes('Data transaksi kakak sudah kami catat') || res5.text.includes('Terima kasih'));
      assert.ok(res5.text.includes('order_998877'));
      assert.ok(res5.text.includes('QRIS'));
    });

    test('3.2 Pemain langsung memberikan sebagian data di pesan pertama: bot langsung melompat ke slot yang belum ada', async () => {
      // Pemain sudah langsung menyertakan Order ID dan Nominal di pesan awal
      const req = {
        conversation_id: 'conv_partial_slots',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_smart_1' },
        history: [
          {
            sender_type: 'player' as const,
            text: 'Halo min, order_554433 nominal 100rb diamond belum masuk juga',
          },
        ],
      };

      const result = await orchestrator.process(req);

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.stage, 'data_collection');
      // Order ID dan Amount sudah terekstrak otomatis
      assert.equal(result.meta.collected_slots?.order_id, 'order_554433');
      assert.ok(result.meta.collected_slots?.amount);

      // Bot langsung menanyakan payment_method, TIDAK menanyakan order ID atau amount lagi!
      assert.equal(result.meta.current_slot, 'payment_method');
      assert.ok(result.text.includes('metode pembayaran'));
      assert.ok(!result.text.includes('nomor Order ID'));
    });
  });

  // =========================================================================
  // FITUR 4: Kesadaran & Ketahanan Tahap di Database (Stage Persistence)
  // =========================================================================
  describe('Fitur 4: Stage Awareness & Database Persistence', () => {
    test('4.1 Percakapan baru tersimpan dengan stage "greeting", lalu dapat diupdate ke "discovery" dan "data_collection"', async () => {
      const uid = `player_stage_test_${Date.now()}`;
      const conv = await db.getOrCreateActiveConversation(
        { uid },
        { market: 'ID', locale: 'id-ID' }
      );

      assert.ok(conv.id);
      assert.equal(conv.stage, 'greeting', 'Tahap awal percakapan wajib "greeting"');

      // Update stage ke discovery
      const updatedDiscovery = await db.updateConversationStage(conv.id, 'discovery');
      assert.equal(updatedDiscovery.stage, 'discovery');

      // Update stage ke data_collection beserta slot data
      const updatedSlots = await db.updateConversationStage(conv.id, 'data_collection', {
        order_id: 'order_persist_777',
      });
      assert.equal(updatedSlots.stage, 'data_collection');
      assert.equal(updatedSlots.page_context?.collected_slots?.order_id, 'order_persist_777');

      // Ambil kembali dari database langsung
      const fetched = await db.getConversation(conv.id);
      assert.equal(fetched?.stage, 'data_collection');
      assert.equal(fetched?.page_context?.collected_slots?.order_id, 'order_persist_777');
    });

    test('4.2 Sapaan murni ("halo") menetapkan stage "greeting"', async () => {
      const result = await orchestrator.process({
        conversation_id: 'conv_greeting_test',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_greet_1' },
        history: [{ sender_type: 'player', text: 'Halo min' }],
      });

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.stage, 'greeting');
      assert.ok(result.text.includes('Halo kak! Ada yang bisa dibantu?'));
    });

    test('4.3 Pertanyaan kabur ("bagaimana kendala topup") menetapkan stage "discovery"', async () => {
      const result = await orchestrator.process({
        conversation_id: 'conv_discovery_test',
        locale: 'id-ID',
        market: 'ID',
        player: { uid: 'player_disc_1' },
        history: [{ sender_type: 'player', text: 'bagaimana kendala topup' }],
      });

      assert.equal(result.action, 'reply');
      assert.equal(result.meta.stage, 'discovery');
      assert.ok(result.text.includes('diamond belum masuk atau pembayarannya yang gagal'));
    });
  });
});
