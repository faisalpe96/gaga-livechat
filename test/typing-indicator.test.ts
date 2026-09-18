import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../services/gateway/src/server.js';
import { Database } from '../services/gateway/src/db.js';
import { RedisPubSub } from '../services/gateway/src/redis.js';
import {
  calculateTypingDelay,
  isHardTriggerMessage,
} from '../services/gateway/src/typing-indicator.js';

describe('Typing Indicator & Delay Bounds Tests', { timeout: 30000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let gatewayApp: any;
  let port: number;
  const clientSockets: WebSocket[] = [];

  // Mock Orchestrator dengan kontrol simulasi error dan delay
  let mockShouldThrow = false;
  let mockReplyDelayMs = 0;
  let mockReplyText = 'Ini adalah panduan resmi cara melakukan top up diamond di Gaga Games.';

  const mockOrchestrator = {
    process: async (req: any) => {
      if (mockShouldThrow) {
        throw new Error('SIMULATED_ORCHESTRATOR_FAILURE');
      }
      if (mockReplyDelayMs > 0) {
        await new Promise((r) => setTimeout(r, mockReplyDelayMs));
      }

      const text = req.history?.[req.history.length - 1]?.text || '';
      const lower = text.toLowerCase();

      // Pemicu keras -> Handoff langsung
      if (
        lower.includes('refund') ||
        lower.includes('banned') ||
        lower.includes('unban') ||
        lower.includes('cs manusia') ||
        lower.includes('bunuh diri')
      ) {
        return {
          action: 'handoff',
          reason: lower.includes('refund') ? 'refund' : 'minta_manusia',
          bot_summary: 'Eskalasi ke agen manusia',
          meta: {
            intent: 'hard_trigger',
            confidence: 1.0,
            sources: [],
            tools_used: [],
            locale_out: req.locale,
            guardrail_flags: [],
          },
        };
      }

      // Default balasan auto-reply
      return {
        action: 'reply',
        text: mockReplyText,
        meta: {
          intent: 'topup_inquiry',
          confidence: 0.95,
          stage: 'resolution',
          sources: ['faq_topup'],
          tools_used: [],
          locale_out: req.locale,
          guardrail_flags: [],
        },
      };
    },
  };

  function createClientSocket(url: string): WebSocket {
    const ws = new WebSocket(url);
    clientSockets.push(ws);
    return ws;
  }

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    await db.ensureAutoReplyTable();
    await db.setMarketBotStatus('ID', true);
    await db.pool.query(`
      INSERT INTO auto_reply_rules (intent, locale, is_enabled, min_confidence)
      VALUES ('topup_inquiry', 'id-ID', true, 0.85)
      ON CONFLICT (intent, locale) DO UPDATE SET is_enabled = true
    `);

    // Inisialisasi gateway server dengan konfigurasi typing delay alami
    const res = await buildGatewayServer({
      db,
      pubsub,
      orchestrator: mockOrchestrator,
      typingDelay: {
        enabled: true,
        msPerChar: 50,
        minMs: 800,
        maxMs: 3000,
      },
    });

    gatewayApp = res.app;
    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    port = (gatewayApp.server.address() as any).port;
  });

  after(async () => {
    for (const ws of clientSockets) {
      try { ws.close(); } catch {}
    }
    try {
      gatewayApp?.server?.closeAllConnections?.();
      await gatewayApp?.close();
    } catch {}
    try { await pubsub?.close(); } catch {}
    try { await db?.close(); } catch {}
  });

  beforeEach(async () => {
    mockShouldThrow = false;
    mockReplyDelayMs = 0;
    mockReplyText = 'Ini adalah panduan resmi cara melakukan top up diamond di Gaga Games.';

    await db.pool.query('DELETE FROM bot_feedback').catch(() => {});
    await db.pool.query('DELETE FROM messages');
    await db.pool.query('DELETE FROM handoffs');
    await db.pool.query('DELETE FROM conversations');
  });

  // =========================================================================
  // PENGUJIAN 1: UJI BATAS JEDA PENGETIKAN (DELAY BOUNDS & SCALING)
  // =========================================================================
  describe('1. Unit Tests: Batas Jeda Pengetikan Alami (calculateTypingDelay)', () => {
    test('1.1 Balasan sangat pendek dibatasi minimum 800 ms', () => {
      // 0 karakter
      assert.equal(calculateTypingDelay(0), 800);
      // 5 karakter (5 * 50 = 250 ms -> clamped ke 800 ms)
      assert.equal(calculateTypingDelay(5), 800);
      // 10 karakter (10 * 50 = 500 ms -> clamped ke 800 ms)
      assert.equal(calculateTypingDelay(10), 800);
      // 16 karakter (16 * 50 = 800 ms tepat batas bawah)
      assert.equal(calculateTypingDelay(16), 800);
    });

    test('1.2 Balasan menengah diskalakan proporsional ~50 ms per karakter', () => {
      // 20 karakter: 20 * 50 = 1000 ms
      assert.equal(calculateTypingDelay(20), 1000);
      // 30 karakter: 30 * 50 = 1500 ms
      assert.equal(calculateTypingDelay(30), 1500);
      // 40 karakter: 40 * 50 = 2000 ms
      assert.equal(calculateTypingDelay(40), 2000);
      // 50 karakter: 50 * 50 = 2500 ms
      assert.equal(calculateTypingDelay(50), 2500);
    });

    test('1.3 Balasan panjang dibatasi maksimum 3000 ms (3 detik)', () => {
      // 60 karakter: 60 * 50 = 3000 ms (tepat batas atas)
      assert.equal(calculateTypingDelay(60), 3000);
      // 80 karakter: 80 * 50 = 4000 ms -> clamped ke 3000 ms
      assert.equal(calculateTypingDelay(80), 3000);
      // 200 karakter -> clamped ke 3000 ms
      assert.equal(calculateTypingDelay(200), 3000);
      // 1000 karakter -> clamped ke 3000 ms
      assert.equal(calculateTypingDelay(1000), 3000);
    });

    test('1.4 Skala kustom 40 ms/karakter dan 60 ms/karakter bekerja akurat', () => {
      // Skala 40 ms: 30 karakter * 40 = 1200 ms
      assert.equal(calculateTypingDelay(30, 40), 1200);
      // Skala 60 ms: 30 karakter * 60 = 1800 ms
      assert.equal(calculateTypingDelay(30, 60), 1800);
    });
  });

  // =========================================================================
  // PENGUJIAN 2: SIKLUS INDIKATOR PENGETIKAN BOT (START, DELAY, STOP)
  // =========================================================================
  test('2. Siklus Indikator Pengetikan: broadcast typing = true, delay >= 800ms, lalu typing = false saat pesan dikirim', async () => {
    // Siapkan percakapan bot_active
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_typing_test', 'ID', 'id-ID', 'bot_active', 'greeting', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedTypingEvents: any[] = [];
    let receivedBotMessage: any = null;
    let typingStartTime = 0;
    let messageReceivedTime = 0;

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'typing') {
        if (data.is_typing && typingStartTime === 0) {
          typingStartTime = Date.now();
        }
        receivedTypingEvents.push(data);
      }
      if (data.event === 'message' && data.sender_type === 'bot') {
        messageReceivedTime = Date.now();
        receivedBotMessage = data;
      }
    });

    await new Promise((r) => ws.once('open', r));

    // Kirim pesan pemain
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Bagaimana cara top up?',
    }));

    // Tunggu balasan dan event pengetikan selesai (minimal 800ms + buffer)
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4500;
      const interval = setInterval(() => {
        const hasStopped = receivedTypingEvents.some((e) => e.is_typing === false);
        if (receivedBotMessage && hasStopped) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu siklus pengetikan dan balasan pesan bot'));
        }
      }, 50);
    });

    // Verifikasi event typing pertama bernilai true dan menyertakan persona bot
    const startTyping = receivedTypingEvents.find((e) => e.is_typing === true);
    assert.ok(startTyping, 'Widget wajib menerima event typing: true saat bot mulai membalas');
    assert.equal(startTyping.sender_type, 'bot');
    assert.ok(startTyping.sender_name, 'Wajib memuat nama persona bot (Mira/Reza)');

    // Verifikasi pesan bot diterima
    assert.ok(receivedBotMessage, 'Widget wajib menerima balasan bot');

    // Verifikasi event typing kedua bernilai false (indikator berhenti tepat saat pesan dikirim)
    const stopTyping = receivedTypingEvents.find((e) => e.is_typing === false);
    assert.ok(stopTyping, 'Widget wajib menerima event typing: false saat pesan terkirim');

    // Verifikasi durasi jeda pengetikan memenuhi batas minimum (>= 800 ms)
    const elapsed = messageReceivedTime - typingStartTime;
    assert.ok(
      elapsed >= 750,
      `Durasi jeda pengetikan (${elapsed} ms) harus memenuhi batas minimum (~800 ms)`
    );
  });

  // =========================================================================
  // PENGUJIAN 3: BERSIHKAN INDIKATOR JIKA ORCHESTRATOR ERROR / TIMEOUT (FALLBACK)
  // =========================================================================
  test('3. Pembersihan Indikator Saat Error: typing dibersihkan (is_typing = false) dan pesan fallback terkirim saat orchestrator gagal', async () => {
    mockShouldThrow = true; // Simulasikan kegagalan / exception pada orchestrator

    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_error_test', 'ID', 'id-ID', 'bot_active', 'greeting', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedTypingEvents: any[] = [];
    let receivedFallbackMessage: any = null;

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'typing') {
        receivedTypingEvents.push(data);
      }
      if (data.event === 'message' && data.sender_type === 'bot') {
        receivedFallbackMessage = data;
      }
    });

    await new Promise((r) => ws.once('open', r));

    // Kirim pesan pemain
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Tolong bantuan topup saya',
    }));

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const interval = setInterval(() => {
        const hasStopped = receivedTypingEvents.some((e) => e.is_typing === false);
        if (receivedFallbackMessage && hasStopped) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu pembersihan indikator dan pesan fallback saat error'));
        }
      }, 50);
    });

    // 1. Indikator sempat menyala di awal
    assert.ok(
      receivedTypingEvents.some((e) => e.is_typing === true),
      'Indikator pengetikan sempat menyala saat pesan tiba'
    );

    // 2. Indikator WAJIB dimatikan (is_typing: false) sehingga tidak berputar selamanya
    const stopEvent = receivedTypingEvents.find((e) => e.is_typing === false);
    assert.ok(stopEvent, 'Indikator pengetikan WAJIB dibersihkan (is_typing: false) saat terjadi error');

    // 3. Pesan fallback graceful dikirimkan ke pemain
    assert.ok(receivedFallbackMessage, 'Pesan fallback manusiawi wajib diterima pemain');
    assert.ok(
      receivedFallbackMessage.text.includes('kendala teknis') ||
      receivedFallbackMessage.text.includes('coba lagi'),
      `Pesan fallback harus bernada sopan: ${receivedFallbackMessage.text}`
    );
  });

  // =========================================================================
  // PENGUJIAN 4: PEMICU KERAS HANDOFF TIDAK PERNAH MENAMPILKAN INDIKATOR TYPING
  // =========================================================================
  test('4. Tanpa Indikator Pada Hard Trigger: pesan refund / handoff menghasilkan 0 event typing ke pemain', async () => {
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_hard_trigger_test', 'ID', 'id-ID', 'bot_active', 'greeting', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedTypingEvents: any[] = [];
    let receivedStatusChange: any = null;

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'typing') {
        receivedTypingEvents.push(data);
      }
      if (data.event === 'status_change') {
        receivedStatusChange = data;
      }
    });

    await new Promise((r) => ws.once('open', r));

    // Kirim pesan pemicu keras refund
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Saya minta refund dana topup saya sekarang juga!',
    }));

    // Tunggu proses handoff
    await new Promise((r) => setTimeout(r, 600));

    // Verifikasi: NOL (0) event typing terkirim ke widget pemain!
    assert.equal(
      receivedTypingEvents.length,
      0,
      'Pemicu keras refund DILARANG memicu event typing apa pun ke widget pemain'
    );

    // Verifikasi status berpindah ke antrean handoff agen
    const conv = await db.getConversation(convId);
    assert.equal(conv?.status, 'handoff_queued');
  });

  // =========================================================================
  // PENGUJIAN 5: KONSISTENSI INDIKATOR PENGETIKAN AGEN MANUSIA (SYARAT 6)
  // =========================================================================
  test('5. Reusable Typing Event Untuk Agen: REST & WebSocket menyiarkan typing agent ke pemain secara konsisten', async () => {
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_agent_typing', 'ID', 'id-ID', 'agent_active', 'resolution', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedTypingEvents: any[] = [];
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'typing') receivedTypingEvents.push(data);
    });

    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ event: 'join_conversation', conversation_id: convId }));
    await new Promise((r) => setTimeout(r, 100));

    // 5.1 Agen mulai mengetik via endpoint REST /v1/conversations/:id/typing
    const typingStartRes = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_typing: true, agent_name: 'Agent Sarah' }),
    });
    assert.equal(typingStartRes.status, 200);

    await new Promise((r) => setTimeout(r, 100));

    const agentTypingOn = receivedTypingEvents.find(
      (e) => e.sender_type === 'agent' && e.is_typing === true
    );
    assert.ok(agentTypingOn, 'Pemain harus menerima event typing: true dari agen');
    assert.equal(agentTypingOn.sender_name, 'Agent Sarah');

    // 5.2 Agen mengirim balasan pesan -> otomatis menghentikan indikator pengetikan
    const msgRes = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Halo kak, saya Agent Sarah siap membantu masalah top-up Anda.',
        sender_type: 'agent',
        sender_id: 'agent_sarah_1',
      }),
    });
    assert.equal(msgRes.status, 201);

    await new Promise((r) => setTimeout(r, 100));

    const agentTypingOff = receivedTypingEvents.find(
      (e) => e.sender_type === 'agent' && e.is_typing === false
    );
    assert.ok(agentTypingOff, 'Pemain harus menerima event typing: false saat pesan agen terkirim');
  });
});
