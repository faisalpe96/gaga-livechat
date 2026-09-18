import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';
import { WebSocketHub } from '../src/websocket-hub.js';

describe('TASK-09: Limited Auto-Reply per Intent & Locale Tests', { timeout: 30000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let gatewayApp: any;
  let hub: WebSocketHub;
  let port: number;

  const clientSockets: WebSocket[] = [];

  function createClientSocket(url: string): WebSocket {
    const ws = new WebSocket(url);
    clientSockets.push(ws);
    return ws;
  }

  let nextOrchestratorOverride: any = null;

  const mockOrchestrator = {
    process: async (req: any) => {
      if (nextOrchestratorOverride) {
        const res = nextOrchestratorOverride;
        nextOrchestratorOverride = null;
        return res;
      }

      const latestMsg = req.history?.[req.history.length - 1]?.text || '';
      const lower = latestMsg.toLowerCase();

      // Pemicu keras (Hard Triggers)
      if (lower.includes('refund') || lower.includes('kembalikan uang')) {
        return {
          action: 'handoff',
          reason: 'refund',
          bot_summary: 'Pemain meminta refund',
          meta: { intent: 'refund', confidence: 0.99, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['refund'] },
        };
      }
      if (lower.includes('banned') || lower.includes('blokir') || lower.includes('banned_appeal')) {
        return {
          action: 'handoff',
          reason: 'banding_banned',
          bot_summary: 'Banding akun diblokir',
          meta: { intent: 'banding_banned', confidence: 0.99, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['banding_banned'] },
        };
      }
      if (lower.includes('terkunci') || lower.includes('hack')) {
        return {
          action: 'handoff',
          reason: 'akun_terkunci',
          bot_summary: 'Akun terkunci atau diretas',
          meta: { intent: 'akun_terkunci', confidence: 0.99, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['akun_terkunci'] },
        };
      }
      if (lower.includes('bunuh diri') || lower.includes('mati')) {
        return {
          action: 'handoff',
          reason: 'bahaya_diri',
          bot_summary: 'Indikasi bahaya diri pemain',
          meta: { intent: 'bahaya_diri', confidence: 1.0, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['bahaya_diri'] },
        };
      }
      if (lower.includes('anak') && (lower.includes('beli') || lower.includes('topup'))) {
        return {
          action: 'handoff',
          reason: 'pembelian_anak',
          bot_summary: 'Transaksi tanpa izin oleh anak',
          meta: { intent: 'pembelian_anak', confidence: 0.96, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['pembelian_anak'] },
        };
      }
      if (lower.includes('somasi') || lower.includes('polisi') || lower.includes('media')) {
        return {
          action: 'handoff',
          reason: 'hukum_media',
          bot_summary: 'Ancaman jalur hukum/media publik',
          meta: { intent: 'hukum_media', confidence: 0.95, sources: [], tools_used: [], locale_out: req.locale, guardrail_flags: ['hukum_media'] },
        };
      }

      // Top up inquiry (Standard Intent)
      if (lower.includes('topup') || lower.includes('top up') || lower.includes('diamond')) {
        return {
          action: 'reply',
          text: 'Pemain dapat melakukan top-up melalui Google Play, Apple App Store, atau mitra resmi Gaga Games.',
          meta: {
            intent: 'topup_inquiry',
            confidence: 0.92,
            sources: ['faq_topup_guide'],
            tools_used: [],
            locale_out: req.locale,
            guardrail_flags: [],
          },
        };
      }

      // Default FAQ reply
      return {
        action: 'reply',
        text: `Jawaban standar bot Gaga Games untuk: "${latestMsg}"`,
        meta: {
          intent: 'faq_inquiry',
          confidence: 0.88,
          sources: ['faq_general'],
          tools_used: [],
          locale_out: req.locale,
          guardrail_flags: [],
        },
      };
    },
  };

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    await db.ensureAutoReplyTable();

    // Bersihkan tabel untuk isolasi pengujian
    await db.pool.query('TRUNCATE bot_feedback, messages, handoffs, conversations, auto_reply_rules CASCADE');

    // Ensure 6 pasar SEA terdaftar dan aktif
    await db.pool.query(`
      INSERT INTO markets (code, name, default_locale, supported_locales, timezone, currency, hours_start, hours_end, is_bot_enabled)
      VALUES
        ('TH', 'Thailand', 'th-TH', ARRAY['th-TH', 'en'], 'Asia/Bangkok', 'THB', '09:00:00', '22:00:00', true),
        ('PH', 'Philippines', 'fil-PH', ARRAY['fil-PH', 'en'], 'Asia/Manila', 'PHP', '09:00:00', '22:00:00', true),
        ('ID', 'Indonesia', 'id-ID', ARRAY['id-ID', 'en'], 'Asia/Jakarta', 'IDR', '09:00:00', '22:00:00', true),
        ('MY', 'Malaysia', 'ms-MY', ARRAY['ms-MY', 'en', 'zh-Hans'], 'Asia/Kuala_Lumpur', 'MYR', '09:00:00', '22:00:00', true),
        ('VN', 'Vietnam', 'vi-VN', ARRAY['vi-VN', 'en'], 'Asia/Ho_Chi_Minh', 'VND', '09:00:00', '22:00:00', true),
        ('SG', 'Singapore', 'en', ARRAY['en', 'zh-Hans'], 'Asia/Singapore', 'SGD', '09:00:00', '22:00:00', true)
      ON CONFLICT (code) DO UPDATE SET 
        is_bot_enabled = true,
        default_locale = EXCLUDED.default_locale
    `);

    // Ensure guardrail 'bahaya_diri' terdaftar untuk locale pengujian
    for (const loc of ['id-ID', 'th-TH', 'vi-VN', 'fil-PH', 'ms-MY', 'en']) {
      await db.pool.query(`
        INSERT INTO guardrail_phrases (locale, rule_key, phrase, author)
        VALUES ($1, 'bahaya_diri', 'frasa_bahaya_diri_wajib', 'system_test')
        ON CONFLICT DO NOTHING
      `, [loc]);
    }

    // Seed agent penguji
    await db.pool.query(`
      INSERT INTO agents (id, name, locales, max_concurrent, status) VALUES 
      ('33333333-3333-3333-3333-333333333333', 'Agent AutoReply Tester', ARRAY['id-ID', 'th-TH', 'en'], 5, 'online')
      ON CONFLICT (id) DO NOTHING
    `);

    // Inisialisasi gateway server
    const res = await buildGatewayServer({
      db,
      pubsub,
      orchestrator: mockOrchestrator,
    });
    gatewayApp = res.app;
    hub = res.hub;
    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    port = (gatewayApp.server.address() as any).port;

    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    for (const ws of clientSockets) {
      try {
        ws.terminate();
      } catch {}
    }
    clientSockets.length = 0;

    try {
      hub?.close();
    } catch {}

    try {
      gatewayApp?.server?.closeAllConnections?.();
      await gatewayApp?.close();
    } catch {}

    try {
      await pubsub?.close();
    } catch {}

    try {
      await db?.pool?.query('DROP TABLE IF EXISTS auto_reply_rules CASCADE');
      await db?.pool?.query('UPDATE markets SET is_bot_enabled = false');
    } catch {}

    try {
      await db?.close();
    } catch {}
  });

  beforeEach(async () => {
    nextOrchestratorOverride = null;
  });

  // =========================================================================
  // TEST 1: DEFAULT SEMUA MATI -> HANYA DRAF AGENT, WIDGET PEMAIN NOL PESAN
  // =========================================================================
  test('1. Default semua mati: intent tanpa daftar izin menghasilkan draf agent (is_draft: true), widget pemain menerima 0 pesan', async () => {
    // Pastikan tidak ada aturan aktif untuk topup_inquiry di id-ID
    await db.pool.query(`DELETE FROM auto_reply_rules WHERE intent = 'topup_inquiry' AND locale = 'id-ID'`);

    // Buat percakapan pemain
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_default_off', nickname: 'PlayerOff', level: 10, vip_tier: 1 },
      { market: 'ID', locale: 'id-ID', server: 'SEA-1', ip_address: '127.0.0.1' }
    );
    const convId = conv.id;

    // Hubungkan widget pemain dan agent panel
    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_off&agent=false&conversation_id=${convId}`;
    const agentWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_agent_33333333-3333-3333-3333-333333333333&agent=true&conversation_id=${convId}`;

    const playerSocket = createClientSocket(playerWsUrl);
    const agentSocket = createClientSocket(agentWsUrl);

    await Promise.all([
      new Promise<void>((r) => playerSocket.on('open', () => r())),
      new Promise<void>((r) => agentSocket.on('open', () => r())),
    ]);

    const playerReceived: any[] = [];
    playerSocket.on('message', (d) => {
      try { playerReceived.push(JSON.parse(d.toString())); } catch {}
    });

    const agentReceived: any[] = [];
    agentSocket.on('message', (d) => {
      try { agentReceived.push(JSON.parse(d.toString())); } catch {}
    });

    // Pemain kirim pertanyaan topup
    playerSocket.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Bagaimana cara topup diamond game?',
    }));

    // Tunggu draf diterima agent
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const interval = setInterval(() => {
        const found = agentReceived.find((e) => e.event === 'bot_draft');
        if (found) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu bot_draft pada panel agent'));
        }
      }, 50);
    });

    // Agent menerima bot_draft
    const draftEvent = agentReceived.find((e) => e.event === 'bot_draft');
    assert.ok(draftEvent, 'Agent wajib menerima event bot_draft');
    assert.equal(draftEvent.is_draft, true);
    assert.equal(draftEvent.meta?.intent, 'topup_inquiry');

    // Widget pemain menerima NOL balasan bot
    const playerBotMessages = playerReceived.filter(
      (e) => (e.event === 'message' && e.sender_type === 'bot') || e.event === 'bot_draft'
    );
    assert.equal(playerBotMessages.length, 0, 'Widget pemain tidak boleh menerima pesan bot saat auto-reply mati');

    // Di database tersimpan sebagai is_draft: true
    const savedDrafts = await db.getDraftMessages(convId);
    assert.ok(savedDrafts.length >= 1);
    assert.equal(savedDrafts[0].meta?.is_draft, true);
  });

  // =========================================================================
  // TEST 2: AUTO-REPLY AKTIF -> PESAN LANGSUNG TERKIRIM KE PEMAIN
  // =========================================================================
  test('2. Auto-reply aktif: jika intent diizinkan dan confidence cukup, pesan langsung terkirim ke pemain (sender_type: bot, is_draft: false)', async () => {
    // Aktifkan auto-reply untuk topup_inquiry pada id-ID
    const enableRes = await gatewayApp.inject({
      method: 'PUT',
      url: '/v1/studio/auto-reply-rules',
      payload: {
        intent: 'topup_inquiry',
        locale: 'id-ID',
        is_enabled: true,
        min_confidence: 0.85,
      },
    });
    assert.equal(enableRes.statusCode, 200, 'Berhasil mengaktifkan auto-reply via API');

    // Buat percakapan pemain
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_auto_on', nickname: 'PlayerOn', level: 15, vip_tier: 2 },
      { market: 'ID', locale: 'id-ID', server: 'SEA-1', ip_address: '127.0.0.1' }
    );
    const convId = conv.id;

    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_on&agent=false&conversation_id=${convId}`;
    const agentWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_agent_33333333-3333-3333-3333-333333333333&agent=true&conversation_id=${convId}`;

    const playerSocket = createClientSocket(playerWsUrl);
    const agentSocket = createClientSocket(agentWsUrl);

    await Promise.all([
      new Promise<void>((r) => playerSocket.on('open', () => r())),
      new Promise<void>((r) => agentSocket.on('open', () => r())),
    ]);

    const playerReceived: any[] = [];
    playerSocket.on('message', (d) => {
      try { playerReceived.push(JSON.parse(d.toString())); } catch {}
    });

    const agentReceived: any[] = [];
    agentSocket.on('message', (d) => {
      try { agentReceived.push(JSON.parse(d.toString())); } catch {}
    });

    // Pemain kirim pertanyaan topup
    playerSocket.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Bisa beli topup diamond lewat mana saja?',
    }));

    // Tunggu pesan bot diterima oleh pemain
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const interval = setInterval(() => {
        const found = playerReceived.find(
          (e) => e.event === 'message' && e.sender_type === 'bot'
        );
        if (found) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu auto-reply diterima oleh pemain'));
        }
      }, 50);
    });

    // Verifikasi pesan diterima oleh pemain secara publik
    const botMsgToPlayer = playerReceived.find(
      (e) => e.event === 'message' && e.sender_type === 'bot'
    );
    assert.ok(botMsgToPlayer, 'Pemain wajib menerima auto-reply langsung');
    assert.equal(botMsgToPlayer.sender_type, 'bot');
    assert.equal(botMsgToPlayer.meta?.is_draft, false);
    assert.equal(botMsgToPlayer.meta?.auto_replied, true);
    assert.ok(botMsgToPlayer.text.includes('Google Play'));

    // Agent juga menerima pesan siaran ini
    const botMsgToAgent = agentReceived.find(
      (e) => e.event === 'message' && e.sender_type === 'bot'
    );
    assert.ok(botMsgToAgent, 'Agent juga wajib menerima siaran auto-reply');
  });

  // =========================================================================
  // TEST 3: SYARAT 1 - PEMICU KERAS TIDAK PERNAH AUTO-REPLY
  // =========================================================================
  test('3. Syarat 1 Mutlak: Pemicu keras (akun_terkunci, refund, banding_banned, pembelian_anak, hukum_media, bahaya_diri) TIDAK PERNAH auto-reply', async () => {
    const HARD_TRIGGERS = [
      'akun_terkunci',
      'refund',
      'banding_banned',
      'pembelian_anak',
      'hukum_media',
      'bahaya_diri',
    ];

    // Bagian A: Ditolak di level API jika dicoba di-toggle (HTTP 403 Forbidden)
    for (const ht of HARD_TRIGGERS) {
      const apiRes = await gatewayApp.inject({
        method: 'PUT',
        url: '/v1/studio/auto-reply-rules',
        payload: {
          intent: ht,
          locale: 'id-ID',
          is_enabled: true,
        },
      });
      assert.equal(
        apiRes.statusCode,
        403,
        `API wajib mengembalikan HTTP 403 Forbidden untuk pemicu keras: ${ht}`
      );
      const body = JSON.parse(apiRes.payload);
      assert.equal(body.code, 'HARD_TRIGGER_AUTO_REPLY_FORBIDDEN');
    }

    // Bagian B: Cek langsung method Database isAutoReplyAllowed
    for (const ht of HARD_TRIGGERS) {
      const check = await db.isAutoReplyAllowed(ht, 'id-ID', 1.0);
      assert.equal(check.allowed, false, `db.isAutoReplyAllowed wajib false untuk: ${ht}`);
    }

    // Bagian C: End-to-End WebSocket: Pemain kirim kata-kata refund & bunuh diri
    // Pastikan tidak ada auto-reply terkirim ke pemain (langsung handoff)
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_hard_trigger', nickname: 'TriggerPlayer', level: 50, vip_tier: 4 },
      { market: 'ID', locale: 'id-ID', server: 'SEA-1', ip_address: '127.0.0.1' }
    );
    const convId = conv.id;

    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_ht&agent=false&conversation_id=${convId}`;
    const playerSocket = createClientSocket(playerWsUrl);
    await new Promise<void>((r) => playerSocket.on('open', () => r()));

    const playerReceived: any[] = [];
    playerSocket.on('message', (d) => {
      try { playerReceived.push(JSON.parse(d.toString())); } catch {}
    });

    // Kirim pesan refund
    playerSocket.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Saya minta refund uang topup saya segera!',
    }));

    // Tunggu sejenak untuk memverifikasi tidak ada balasan bot auto-reply
    await new Promise((r) => setTimeout(r, 600));

    const botReplies = playerReceived.filter(
      (e) => e.event === 'message' && e.sender_type === 'bot'
    );
    assert.equal(botReplies.length, 0, 'Pemicu keras refund dilarang keras menghasilkan auto-reply ke pemain');

    // Status percakapan beralih ke handoff
    const convAfter = await db.getConversation(convId);
    assert.equal(convAfter?.status, 'handoff_queued', 'Percakapan wajib masuk antrean handoff agen');
  });

  // =========================================================================
  // TEST 4: SYARAT 2 - STRICT SAFETY GATE DI LEVEL API
  // =========================================================================
  test('4. Syarat 2 Mutlak: Locale dengan is_bot_enabled = false atau guardrail bahaya_diri kosong DITOLAK di level API (HTTP 400)', async () => {
    // Kasus A: markets.is_bot_enabled = false
    // Matikan bot untuk pasar TH
    await db.setMarketBotStatus('TH', false);

    const resDisabledBot = await gatewayApp.inject({
      method: 'PUT',
      url: '/v1/studio/auto-reply-rules',
      payload: {
        intent: 'faq_inquiry',
        locale: 'th-TH',
        is_enabled: true,
      },
    });

    assert.equal(
      resDisabledBot.statusCode,
      400,
      'API wajib menolak aktivasi saat is_bot_enabled = false'
    );
    const bodyA = JSON.parse(resDisabledBot.payload);
    assert.equal(bodyA.code, 'MARKET_BOT_DISABLED');

    // Method db.isAutoReplyAllowed juga harus menolak
    const checkBotDisabled = await db.isAutoReplyAllowed('faq_inquiry', 'th-TH', 0.95);
    assert.equal(checkBotDisabled.allowed, false);
    assert.ok(checkBotDisabled.reason?.includes('is_bot_enabled = false'));

    // Kembalikan status bot pasar TH
    await db.setMarketBotStatus('TH', true);

    // Kasus B: Guardrail bahaya_diri kosong
    // Hapus frasa bahaya_diri untuk vi-VN
    await db.pool.query(`DELETE FROM guardrail_phrases WHERE rule_key = 'bahaya_diri' AND locale = 'vi-VN'`);

    const resMissingGuardrail = await gatewayApp.inject({
      method: 'PUT',
      url: '/v1/studio/auto-reply-rules',
      payload: {
        intent: 'faq_inquiry',
        locale: 'vi-VN',
        is_enabled: true,
      },
    });

    assert.equal(
      resMissingGuardrail.statusCode,
      400,
      'API wajib menolak aktivasi saat guardrail bahaya_diri kosong'
    );
    const bodyB = JSON.parse(resMissingGuardrail.payload);
    assert.equal(bodyB.code, 'GUARDRAIL_INCOMPLETE');

    // Method db.isAutoReplyAllowed juga harus menolak
    const checkGuardrailMissing = await db.isAutoReplyAllowed('faq_inquiry', 'vi-VN', 0.95);
    assert.equal(checkGuardrailMissing.allowed, false);
    assert.ok(checkGuardrailMissing.reason?.includes('bahaya_diri'));

    // Pulihkan frasa bahaya_diri untuk vi-VN
    await db.pool.query(`
      INSERT INTO guardrail_phrases (locale, rule_key, phrase, author)
      VALUES ('vi-VN', 'bahaya_diri', 'frasa_bahaya_diri_wajib', 'system_test')
    `);
  });

  // =========================================================================
  // TEST 5: SYARAT 3 - AUDIT BOT_FEEDBACK & AGENT REVIEW REJECTION
  // =========================================================================
  test('5. Syarat 3 Mutlak: Auto-reply tercatat otomatis di bot_feedback (auto_replied), dan agen bisa menandainya salah (rejected)', async () => {
    // Pastikan auto-reply aktif untuk topup_inquiry di id-ID
    await db.updateAutoReplyRule('topup_inquiry', 'id-ID', true, 0.85);

    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_audit_test', nickname: 'AuditPlayer', level: 30, vip_tier: 3 },
      { market: 'ID', locale: 'id-ID', server: 'SEA-1', ip_address: '127.0.0.1' }
    );
    const convId = conv.id;

    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_audit&agent=false&conversation_id=${convId}`;
    const playerSocket = createClientSocket(playerWsUrl);
    await new Promise<void>((r) => playerSocket.on('open', () => r()));

    const playerReceived: any[] = [];
    playerSocket.on('message', (d) => {
      try { playerReceived.push(JSON.parse(d.toString())); } catch {}
    });

    // Pemain kirim pertanyaan topup
    playerSocket.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Bagaimana cara topup diamond game?',
    }));

    // Tunggu pesan bot diterima pemain
    let botMsgEvent: any = null;
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const interval = setInterval(() => {
        botMsgEvent = playerReceived.find(
          (e) => e.event === 'message' && e.sender_type === 'bot'
        );
        if (botMsgEvent) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu auto-reply pada audit test'));
        }
      }, 50);
    });

    const messageId = botMsgEvent.message_id;
    assert.ok(messageId, 'Pesan auto-reply harus memiliki message_id');

    // 1. Verifikasi entri bot_feedback otomatis tercatat dengan verdict: 'auto_replied'
    const fbResBefore = await db.pool.query(
      `SELECT * FROM bot_feedback WHERE message_id = $1`,
      [messageId]
    );
    assert.equal(fbResBefore.rows.length, 1, 'Wajib ada 1 entri bot_feedback otomatis');
    assert.equal(
      fbResBefore.rows[0].verdict,
      'auto_replied',
      'Verdict awal wajib auto_replied'
    );

    // 2. Agen meninjau percakapan dan menandai jawaban bot salah (rejected)
    const rejectRes = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${messageId}/feedback`,
      payload: {
        verdict: 'rejected',
        reviewer_id: '33333333-3333-3333-3333-333333333333',
      },
    });

    assert.equal(rejectRes.statusCode, 201, 'Agent berhasil memberikan feedback review');
    const rejectData = JSON.parse(rejectRes.payload);
    assert.equal(rejectData.verdict, 'rejected');

    // 3. Verifikasi DB telah terupdate
    const fbResAfter = await db.pool.query(
      `SELECT * FROM bot_feedback WHERE message_id = $1`,
      [messageId]
    );
    assert.equal(fbResAfter.rows[0].verdict, 'rejected');
    assert.equal(fbResAfter.rows[0].reviewer_id, '33333333-3333-3333-3333-333333333333');
  });

  // =========================================================================
  // TEST 6: PERINGATAN KELAYAKAN SYARAT 90%
  // =========================================================================
  test('6. Peringatan syarat 90%: API mengembalikan peringatan jika draf tanpa edit di bawah 90%', async () => {
    // Tambahkan feedback buatan dengan rejected (unedited rate: 0% < 90%)
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_warn_test', nickname: 'WarnPlayer', level: 1 },
      { market: 'ID', locale: 'id-ID' }
    );
    const msg = await db.saveMessage({
      conversation_id: conv.id,
      sender_type: 'bot',
      text: 'Contoh balasan',
      meta: { intent: 'vip_benefits', confidence: 0.9 },
    });

    await db.saveBotFeedback({
      message_id: msg.id,
      verdict: 'rejected',
      reviewer_id: '33333333-3333-3333-3333-333333333333',
    });

    const apiRes = await gatewayApp.inject({
      method: 'PUT',
      url: '/v1/studio/auto-reply-rules',
      payload: {
        intent: 'vip_benefits',
        locale: 'id-ID',
        is_enabled: true,
      },
    });

    assert.equal(apiRes.statusCode, 200);
    const data = JSON.parse(apiRes.payload);
    assert.ok(data.warning, 'Wajib memuat properti warning');
    assert.ok(
      data.warning.includes('90%'),
      'Peringatan wajib menyebutkan batas ambang 90%'
    );
  });

  // =========================================================================
  // TEST 7: AMBANG BATAS KEYAKINAN (CONFIDENCE THRESHOLD)
  // =========================================================================
  test('7. Ambang keyakinan: jika confidence di bawah min_confidence (0.85), bot TIDAK auto-reply dan dialihkan ke draf agent', async () => {
    // Aktifkan auto-reply untuk account_link dengan min_confidence 0.85
    await db.updateAutoReplyRule('account_link', 'id-ID', true, 0.85);

    // Override orchestrator agar mengembalikan confidence 0.70 (< 0.85)
    nextOrchestratorOverride = {
      action: 'reply',
      text: 'Untuk menautkan akun Google, buka Pengaturan > Akun.',
      meta: {
        intent: 'account_link',
        confidence: 0.70, // Di bawah ambang 0.85
        sources: ['faq_account'],
        tools_used: [],
        locale_out: 'id-ID',
        guardrail_flags: [],
      },
    };

    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_low_conf', nickname: 'LowConfPlayer', level: 5 },
      { market: 'ID', locale: 'id-ID' }
    );
    const convId = conv.id;

    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_low_conf&agent=false&conversation_id=${convId}`;
    const agentWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_agent_33333333-3333-3333-3333-333333333333&agent=true&conversation_id=${convId}`;

    const playerSocket = createClientSocket(playerWsUrl);
    const agentSocket = createClientSocket(agentWsUrl);

    await Promise.all([
      new Promise<void>((r) => playerSocket.on('open', () => r())),
      new Promise<void>((r) => agentSocket.on('open', () => r())),
    ]);

    const playerReceived: any[] = [];
    playerSocket.on('message', (d) => {
      try { playerReceived.push(JSON.parse(d.toString())); } catch {}
    });

    const agentReceived: any[] = [];
    agentSocket.on('message', (d) => {
      try { agentReceived.push(JSON.parse(d.toString())); } catch {}
    });

    playerSocket.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Bagaimana cara tautkan akun ke Google?',
    }));

    // Tunggu draf diterima agent
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const interval = setInterval(() => {
        const found = agentReceived.find((e) => e.event === 'bot_draft');
        if (found) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu bot_draft'));
        }
      }, 50);
    });

    // Agent menerima draf dengan keterangan auto_reply_disallowed_reason
    const draft = agentReceived.find((e) => e.event === 'bot_draft');
    assert.ok(draft);
    assert.equal(draft.is_draft, true);
    assert.ok(draft.meta?.auto_reply_disallowed_reason?.includes('Confidence'));

    // Pemain NOL pesan
    const playerBotMsgs = playerReceived.filter(
      (e) => (e.event === 'message' && e.sender_type === 'bot') || e.event === 'bot_draft'
    );
    assert.equal(playerBotMsgs.length, 0, 'Pemain tidak boleh menerima pesan jika confidence di bawah ambang');
  });

  // =========================================================================
  // TEST 8: ISOLASI LOCALE
  // =========================================================================
  test('8. Isolasi locale: mengubah status aturan th-TH tidak memengaruhi status aturan id-ID', async () => {
    // Aktifkan id-ID
    await db.updateAutoReplyRule('topup_inquiry', 'id-ID', true, 0.85);
    // Matikan th-TH
    await db.updateAutoReplyRule('topup_inquiry', 'th-TH', false, 0.85);

    const ruleId = await db.getAutoReplyRule('topup_inquiry', 'id-ID');
    const ruleTh = await db.getAutoReplyRule('topup_inquiry', 'th-TH');

    assert.equal(ruleId?.is_enabled, true, 'id-ID harus tetap aktif');
    assert.equal(ruleTh?.is_enabled, false, 'th-TH harus tetap mati');

    // Ambil matriks lengkap via GET /v1/studio/auto-reply-rules
    const listRes = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/auto-reply-rules',
    });
    assert.equal(listRes.statusCode, 200);
    const data = JSON.parse(listRes.payload);
    assert.ok(data.rules.length >= 24, 'Matriks 4 intent x 6 locale minimal 24 aturan');

    const idEntry = data.rules.find((r: any) => r.intent === 'topup_inquiry' && r.locale === 'id-ID');
    const thEntry = data.rules.find((r: any) => r.intent === 'topup_inquiry' && r.locale === 'th-TH');

    assert.equal(idEntry.is_enabled, true);
    assert.equal(thEntry.is_enabled, false);
  });
});
