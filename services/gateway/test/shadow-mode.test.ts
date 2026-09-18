import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';
import { WebSocketHub } from '../src/websocket-hub.js';

describe('TASK-08: Shadow Mode & Bot Feedback Tests', { timeout: 20000 }, () => {
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

  // Mock Orchestrator untuk shadow mode
  let orchestratorCalls: any[] = [];
  const mockOrchestrator = {
    process: async (req: any) => {
      orchestratorCalls.push(req);
      const latestMsg = req.history?.[req.history.length - 1]?.text || '';

      if (latestMsg.includes('error_trigger')) {
        return { action: 'handoff', reason: 'error', bot_summary: 'Handed off' };
      }

      return {
        action: 'reply',
        text: `Draf Bot: Jawaban otomatis untuk "${latestMsg}"`,
        meta: {
          intent: 'faq',
          confidence: 0.95,
          sources: ['faq_rules_sea'],
          tools_used: ['check_server_status'],
          locale_out: req.locale || 'id-ID',
          guardrail_flags: [],
        },
      };
    },
  };

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    // Bersihkan tabel untuk pengujian
    await db.pool.query('TRUNCATE bot_feedback, messages, handoffs, conversations, agents CASCADE');

    // Seed agent uji
    await db.pool.query(`
      INSERT INTO agents (id, name, locales, max_concurrent, status) VALUES 
      ('11111111-1111-1111-1111-111111111111', 'Agent Budi', ARRAY['id-ID', 'en'], 5, 'online'),
      ('22222222-2222-2222-2222-222222222222', 'Agent Somchai', ARRAY['th-TH', 'en'], 5, 'online')
    `);

    // Inisialisasi gateway server dengan mockOrchestrator
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
      await db?.close();
    } catch {}
  });

  test('Kriteria Terima 1 (Strict Spy): Draf bot disiarkan ke agent, tapi NOL pesan draf sampai ke widget pemain', async () => {
    orchestratorCalls = [];

    // 1. Buat percakapan aktif di DB
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_shadow_test', nickname: 'ShadowPlayer', level: 25, vip_tier: 2 },
      { market: 'ID', locale: 'id-ID', server: 'SEA-1', ip_address: '127.0.0.1' }
    );
    const convId = conv.id;

    // 2. Hubungkan koneksi Widget Pemain (isAgent = false)
    const playerWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_player_shadow_test&agent=false&conversation_id=${convId}`;
    const playerSocket = createClientSocket(playerWsUrl);

    // 3. Hubungkan koneksi Panel Agent (isAgent = true)
    const agentWsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_agent_11111111-1111-1111-1111-111111111111&agent=true&conversation_id=${convId}`;
    const agentSocket = createClientSocket(agentWsUrl);

    await Promise.all([
      new Promise<void>((r) => playerSocket.on('open', () => r())),
      new Promise<void>((r) => agentSocket.on('open', () => r())),
    ]);

    // 4. Pasang SPY pada seluruh siaran yang diterima kedua koneksi
    const playerEventsReceived: any[] = [];
    playerSocket.on('message', (data) => {
      try {
        playerEventsReceived.push(JSON.parse(data.toString()));
      } catch {}
    });

    const agentEventsReceived: any[] = [];
    agentSocket.on('message', (data) => {
      try {
        agentEventsReceived.push(JSON.parse(data.toString()));
      } catch {}
    });

    // 5. Pemain kirim pesan pertanyaan
    const playerQuestion = 'Berapa drop rate SSR di banner saat ini?';
    playerSocket.send(
      JSON.stringify({
        event: 'message',
        conversation_id: convId,
        text: playerQuestion,
      })
    );

    // 6. Tunggu hingga orchestrator menghasilkan draf dan disiarkan
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const interval = setInterval(() => {
        const foundDraft = agentEventsReceived.find((e) => e.event === 'bot_draft');
        if (foundDraft) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Timeout menunggu bot_draft diterima oleh agent'));
        }
      }, 50);
    });

    // 7. Verifikasi pada Panel Agent: Menerima event 'bot_draft'
    const botDraftEvent = agentEventsReceived.find((e) => e.event === 'bot_draft');
    assert.ok(botDraftEvent, 'Agent wajib menerima event bot_draft');
    assert.equal(botDraftEvent.conversation_id, convId);
    assert.equal(botDraftEvent.is_draft, true);
    assert.ok(botDraftEvent.text.includes('Draf Bot: Jawaban otomatis'));
    assert.equal(botDraftEvent.meta?.intent, 'faq');

    // 8. PEMBUKTIAN KRITERIA TERIMA NOMOR 1 (SPY PADA WIDGET PEMAIN):
    // Memastikan seluruh siaran yang masuk ke koneksi widget (isAgent = false)
    // dan memverifikasi jumlah pesan draf yang terkirim ke sana adalah tepat NOL (0).
    const playerDraftsReceived = playerEventsReceived.filter(
      (e) => e.event === 'bot_draft' || e.is_draft === true || (e.meta && e.meta.is_draft === true)
    );

    assert.equal(
      playerDraftsReceived.length,
      0,
      `PELANGGARAN MODE BAYANGAN: Ditemukan ${playerDraftsReceived.length} draf bot bocor ke koneksi widget pemain!`
    );

    // Pemain hanya menerima pesan broadcast normal miliknya sendiri
    const playerNormalMessages = playerEventsReceived.filter((e) => e.event === 'message');
    assert.ok(playerNormalMessages.length >= 1, 'Pemain menerima konfirmasi broadcast pesan sendiri');
    assert.equal(playerNormalMessages[0].text, playerQuestion);

    // 9. Verifikasi juga endpoint REST /v1/conversations/:id/messages untuk widget:
    // Secara default tidak boleh menyertakan draf bot
    const restRes = await gatewayApp.inject({
      method: 'GET',
      url: `/v1/conversations/${convId}/messages`,
    });
    const restData = JSON.parse(restRes.payload);
    const leakedRestDrafts = restData.messages.filter(
      (m: any) => m.sender_type === 'bot' && m.meta?.is_draft === true
    );
    assert.equal(
      leakedRestDrafts.length,
      0,
      'Endpoint riwayat pesan widget tidak boleh mengembalikan draf bot!'
    );
  });

  test('Kriteria Terima 2: Audit & Version Tracking (Versi Sebelum dan Sesudah Tersimpan)', async () => {
    // 1. Ambil draf yang tersimpan dari pengujian sebelumnya
    const conv = await db.pool.query(
      `SELECT id FROM conversations WHERE player_uid = 'player_shadow_test' LIMIT 1`
    );
    const convId = conv.rows[0].id;

    const draftsRes = await gatewayApp.inject({
      method: 'GET',
      url: `/v1/conversations/${convId}/drafts`,
    });
    const draftsData = JSON.parse(draftsRes.payload);
    assert.ok(draftsData.drafts.length >= 1, 'Draf bot harus ditemukan di database');

    const draftMessage = draftsData.drafts[0];
    const originalDraftText = draftMessage.text;
    const draftId = draftMessage.id;

    // 2. Agent meninjau draf, melakukan edit, dan menyimpan feedback
    const editedText =
      'Rate drop SSR saat ini 2.5% dengan pity counter 90 tarikan. Semoga beruntung!';
    const reviewerId = '11111111-1111-1111-1111-111111111111';

    const feedbackRes = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${draftId}/feedback`,
      payload: {
        verdict: 'edited',
        corrected_text: editedText,
        reviewer_id: reviewerId,
      },
    });

    assert.equal(feedbackRes.statusCode, 201);
    const feedbackData = JSON.parse(feedbackRes.payload);
    assert.equal(feedbackData.verdict, 'edited');
    assert.equal(feedbackData.corrected_text, editedText);

    // 3. Verifikasi Integritas Audit Database:
    // - Versi SEBELUM: tetap utuh di tabel messages.text
    const msgCheck = await db.pool.query(`SELECT * FROM messages WHERE id = $1`, [draftId]);
    assert.equal(
      msgCheck.rows[0].text,
      originalDraftText,
      'Versi sebelum diedit wajib tetap tersimpan utuh di messages.text tanpa dimodifikasi'
    );

    // - Versi SESUDAH: tersimpan di bot_feedback.corrected_text
    const fbCheck = await db.pool.query(
      `SELECT * FROM bot_feedback WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [draftId]
    );
    assert.equal(
      fbCheck.rows[0].corrected_text,
      editedText,
      'Versi sesudah diedit wajib tersimpan di bot_feedback.corrected_text'
    );
    assert.equal(fbCheck.rows[0].verdict, 'edited');
    assert.equal(fbCheck.rows[0].reviewer_id, reviewerId);
  });

  test('Feedback verdict: accepted dan rejected tercatat dengan benar', async () => {
    // 1. Buat 2 pesan draf bot baru untuk pengujian
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_feedback_test', nickname: 'FBPlayer' },
      { market: 'TH', locale: 'th-TH' }
    );

    const draft1 = await db.saveMessage({
      conversation_id: conv.id,
      sender_type: 'bot',
      text: 'Original draft accepted test',
      meta: { is_draft: true, intent: 'gacha_rate' },
    });

    const draft2 = await db.saveMessage({
      conversation_id: conv.id,
      sender_type: 'bot',
      text: 'Original draft rejected test',
      meta: { is_draft: true, intent: 'billing' },
    });

    // 2. Feedback 'accepted'
    const acceptRes = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${draft1.id}/feedback`,
      payload: {
        verdict: 'accepted',
        reviewer_id: '22222222-2222-2222-2222-222222222222',
      },
    });
    assert.equal(acceptRes.statusCode, 201);
    const acceptData = JSON.parse(acceptRes.payload);
    assert.equal(acceptData.verdict, 'accepted');
    assert.equal(acceptData.corrected_text, null);

    // 3. Feedback 'rejected'
    const rejectRes = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${draft2.id}/feedback`,
      payload: {
        verdict: 'rejected',
      },
    });
    assert.equal(rejectRes.statusCode, 201);
    const rejectData = JSON.parse(rejectRes.payload);
    assert.equal(rejectData.verdict, 'rejected');
  });

  test('Validasi endpoint feedback menolak input tidak valid', async () => {
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'player_val_test' },
      { market: 'ID', locale: 'id-ID' }
    );
    const draft = await db.saveMessage({
      conversation_id: conv.id,
      sender_type: 'bot',
      text: 'Draft validation test',
      meta: { is_draft: true },
    });

    // Verdict tidak valid
    const res1 = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${draft.id}/feedback`,
      payload: { verdict: 'approved' },
    });
    assert.equal(res1.statusCode, 400);
    assert.equal(JSON.parse(res1.payload).code, 'INVALID_VERDICT');

    // Verdict 'edited' tapi tidak menyertakan corrected_text
    const res2 = await gatewayApp.inject({
      method: 'POST',
      url: `/v1/messages/${draft.id}/feedback`,
      payload: { verdict: 'edited', corrected_text: '' },
    });
    assert.equal(res2.statusCode, 400);
    assert.equal(JSON.parse(res2.payload).code, 'MISSING_CORRECTED_TEXT');
  });

  test('Query Pelaporan Draft Usage: Dikelompokkan per intent & locale dengan persentase akurat', async () => {
    // Bersihkan feedback sebelumnya agar data laporan terisolasi
    await db.pool.query('TRUNCATE bot_feedback CASCADE');

    // Siapkan data terkontrol untuk laporan:
    // Buat percakapan locale 'id-ID' dengan intent 'faq':
    // 3 accepted, 1 edited -> total 4 -> unedited_rate = 75.0%
    const convID = await db.getOrCreateActiveConversation(
      { uid: 'report_p1' },
      { market: 'ID', locale: 'id-ID' }
    );

    for (let i = 0; i < 3; i++) {
      const m = await db.saveMessage({
        conversation_id: convID.id,
        sender_type: 'bot',
        text: `Draft FAQ ID ${i}`,
        meta: { is_draft: true, intent: 'faq' },
      });
      await db.saveBotFeedback({ message_id: m.id, verdict: 'accepted' });
    }
    const mEdited = await db.saveMessage({
      conversation_id: convID.id,
      sender_type: 'bot',
      text: `Draft FAQ ID edited`,
      meta: { is_draft: true, intent: 'faq' },
    });
    await db.saveBotFeedback({
      message_id: mEdited.id,
      verdict: 'edited',
      corrected_text: 'Edited text',
    });

    // Buat percakapan locale 'th-TH' dengan intent 'topup':
    // 9 accepted, 1 edited -> total 10 -> unedited_rate = 90.0%
    const convTH = await db.getOrCreateActiveConversation(
      { uid: 'report_p2' },
      { market: 'TH', locale: 'th-TH' }
    );

    for (let i = 0; i < 9; i++) {
      const m = await db.saveMessage({
        conversation_id: convTH.id,
        sender_type: 'bot',
        text: `Draft Topup TH ${i}`,
        meta: { is_draft: true, intent: 'topup' },
      });
      await db.saveBotFeedback({ message_id: m.id, verdict: 'accepted' });
    }
    const mTopupEdited = await db.saveMessage({
      conversation_id: convTH.id,
      sender_type: 'bot',
      text: `Draft Topup TH edited`,
      meta: { is_draft: true, intent: 'topup' },
    });
    await db.saveBotFeedback({
      message_id: mTopupEdited.id,
      verdict: 'edited',
      corrected_text: 'Edited topup guide',
    });

    // Panggil GET /v1/reports/draft-usage
    const reportRes = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/reports/draft-usage',
    });

    assert.equal(reportRes.statusCode, 200);
    const reportData = JSON.parse(reportRes.payload);
    assert.ok(Array.isArray(reportData.report), 'Response wajib memiliki array report');
    assert.ok(reportData.total_categories >= 2);

    // Temukan item 'topup' / 'th-TH'
    const topupTH = reportData.report.find(
      (r: any) => r.intent === 'topup' && r.locale === 'th-TH'
    );
    assert.ok(topupTH, 'Harus ada grup intent topup untuk locale th-TH');
    assert.equal(topupTH.total_reviewed, 10);
    assert.equal(topupTH.used_unedited_count, 9);
    assert.equal(topupTH.edited_count, 1);
    assert.equal(topupTH.rejected_count, 0);
    assert.equal(topupTH.unedited_rate_percentage, 90); // 9/10 * 100%

    // Temukan item 'faq' / 'id-ID'
    const faqID = reportData.report.find(
      (r: any) => r.intent === 'faq' && r.locale === 'id-ID'
    );
    assert.ok(faqID, 'Harus ada grup intent faq untuk locale id-ID');
    assert.equal(faqID.total_reviewed, 4);
    assert.equal(faqID.used_unedited_count, 3);
    assert.equal(faqID.edited_count, 1);
    assert.equal(faqID.rejected_count, 0);
    assert.equal(faqID.unedited_rate_percentage, 75); // 3/4 * 100%
  });
});
