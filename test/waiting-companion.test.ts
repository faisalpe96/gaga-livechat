import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../services/gateway/src/server.js';
import { Database } from '../services/gateway/src/db.js';
import { RedisPubSub } from '../services/gateway/src/redis.js';
import { WebSocketHub } from '../services/gateway/src/websocket-hub.js';
import { WaitingCompanion } from '../services/orchestrator/src/pipeline/waiting-companion.js';
import { AIOrchestrator } from '../services/orchestrator/src/pipeline/orchestrator.js';
import { KnowledgeBaseRetriever } from '../services/orchestrator/src/kb/retriever.js';
import { GuardrailEngine } from '../services/orchestrator/src/pipeline/guardrails.js';
import { ToolRegistry } from '../services/orchestrator/src/tools/registry.js';
import { MockLlmClient } from '../services/orchestrator/src/llm/client.js';
import { IntentClassifier } from '../services/orchestrator/src/pipeline/intent-classifier.js';

describe('Waiting-Companion Behaviour in handoff_queued Tests', { timeout: 30000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let gatewayApp: any;
  let hub: WebSocketHub;
  let orchestrator: AIOrchestrator;
  let waitingCompanion: WaitingCompanion;
  let port: number;
  const clientSockets: WebSocket[] = [];

  function createClientSocket(url: string): WebSocket {
    const ws = new WebSocket(url);
    clientSockets.push(ws);
    return ws;
  }

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    const kbRetriever = new KnowledgeBaseRetriever(db.pool);
    const guardrails = new GuardrailEngine(db.pool);
    await guardrails.loadAllFromDatabase();
    const toolRegistry = new ToolRegistry();
    const llmClient = new MockLlmClient();
    const intentClassifier = new IntentClassifier();

    orchestrator = new AIOrchestrator({
      kbRetriever,
      guardrails,
      toolRegistry,
      llmClient,
      intentClassifier,
    });

    waitingCompanion = new WaitingCompanion({
      guardrails,
      kbRetriever,
      intentClassifier,
    });

    // Pastikan pasar ID aktif dan tabel disiapkan
    await db.ensureAutoReplyTable();
    await db.setMarketBotStatus('ID', true);

    const res = await buildGatewayServer({
      db,
      pubsub,
      orchestrator,
      waitingCompanion,
      typingDelay: { enabled: false },
    });

    gatewayApp = res.app;
    hub = res.hub;
    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    port = (gatewayApp.server.address() as any).port;
  });

  after(async () => {
    for (const ws of clientSockets) {
      try {
        ws.close();
      } catch {}
    }
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

  beforeEach(async () => {
    await db.pool.query('DELETE FROM bot_feedback').catch(() => {});
    await db.pool.query('DELETE FROM messages');
    await db.pool.query('DELETE FROM handoffs');
    await db.pool.query('DELETE FROM conversations');
  });

  test('1. Segera akui keluhan dan informasikan estimasi waktu tunggu antrean saat handoff dipicu', async () => {
    // Buat percakapan awal
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_wait_1', 'ID', 'id-ID', 'bot_active', 'greeting', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedMessages: any[] = [];
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'message') receivedMessages.push(data);
    });

    await new Promise((r) => ws.once('open', r));

    // Player kirim pesan minta bantuan CS
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Hubungkan dengan CS Manusia',
    }));

    // Tunggu balasan segera dari bot
    await new Promise((r) => setTimeout(r, 600));

    // Verifikasi status percakapan berubah menjadi handoff_queued
    const updatedConv = await db.getConversation(convId);
    assert.equal(updatedConv?.status, 'handoff_queued');

    // Verifikasi pesan masuk ke pemain (bot TIDAK boleh diam!)
    const botMessages = receivedMessages.filter((m) => m.sender_type === 'bot');
    assert.ok(botMessages.length >= 1, 'Bot wajib segera membalas saat handoff dipicu');

    const ackText = botMessages[0].text;
    assert.ok(
      ackText.toLowerCase().includes('estimasi waktu tunggu') || ackText.toLowerCase().includes('menit'),
      `Pesan harus memuat estimasi waktu tunggu antrean: ${ackText}`
    );
    assert.ok(
      ackText.toLowerCase().includes('customer support') || ackText.toLowerCase().includes('cs kami'),
      `Pesan harus mengonfirmasi sedang disambungkan ke CS: ${ackText}`
    );
  });

  test('2. Bot tetap membalas secara manusiawi saat handoff_queued dan mengumpulkan data satu per satu', async () => {
    // Siapkan percakapan yang sudah berstatus handoff_queued
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_wait_2', 'ID', 'id-ID', 'handoff_queued', 'escalation', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    // Masukkan entri handoff awal
    await db.pool.query(`
      INSERT INTO handoffs (conversation_id, reason, bot_summary, locale, queued_at)
      VALUES ($1, 'minta_manusia', 'Inisiasi handoff', 'id-ID', now())
    `, [convId]);

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    const receivedMessages: any[] = [];
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'message') receivedMessages.push(data);
    });

    await new Promise((r) => ws.once('open', r));

    // Pemain memberikan Order ID
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Order ID saya order_998877',
    }));

    await new Promise((r) => setTimeout(r, 600));

    // Bot harus membalas (TIDAK boleh diam!), mengakui Order ID, dan menanyakan slot berikutnya (nominal)
    const reply1 = receivedMessages.find((m) => m.sender_type === 'bot' && m.text.includes('order_998877') || m.text.includes('nominal'));
    assert.ok(reply1, 'Bot harus membalas dan menanyakan nominal setelah Order ID diberikan');

    // Pemain memberikan nominal
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Nominalnya 100 ribu',
    }));

    await new Promise((r) => setTimeout(r, 600));

    // Bot harus membalas lagi, menanyakan metode pembayaran
    const reply2 = receivedMessages.find((m) => m.sender_type === 'bot' && m.text.toLowerCase().includes('metode pembayaran'));
    assert.ok(reply2, 'Bot harus membalas dan menanyakan metode pembayaran secara berurutan');
  });

  test('3. Topik pemicu keras (refund, unban, akun terkunci) HANYA diakui dan TIDAK PERNAH diberi janji/solusi', async () => {
    // Skenario A: Pertanyaan Refund saat handoff_queued
    const refundRes = await waitingCompanion.processWaitingMessage({
      text: 'Saya minta refund uang saya kembali sekarang juga!',
      locale: 'id-ID',
      botPersona: 'mira',
    });

    assert.equal(refundRes.isHardTriggerTopic, true);
    assert.ok(
      refundRes.text.toLowerCase().includes('pengembalian dana') || refundRes.text.toLowerCase().includes('refund'),
      'Harus mengakui topik refund'
    );
    assert.ok(
      refundRes.text.toLowerCase().includes('customer support') || refundRes.text.toLowerCase().includes('tim cs kami'),
      'Harus mengonfirmasi CS yang akan menangani langsung'
    );
    // Verifikasi TIDAK ADA janji / keputusan mandiri
    assert.ok(!refundRes.text.toLowerCase().includes('kami jamin uang kembali'));
    assert.ok(!refundRes.text.toLowerCase().includes('pasti dana kembali'));

    // Skenario B: Permintaan Unban akun saat handoff_queued
    const unbanRes = await waitingCompanion.processWaitingMessage({
      text: 'Tolong unban akun saya sekarang juga saya tidak bersalah',
      locale: 'id-ID',
      botPersona: 'reza',
    });

    assert.equal(unbanRes.isHardTriggerTopic, true);
    assert.ok(
      unbanRes.text.toLowerCase().includes('pemblokiran') || unbanRes.text.toLowerCase().includes('unban') || unbanRes.text.toLowerCase().includes('sanksi'),
      'Harus mengakui topik pemblokiran akun'
    );
    assert.ok(!unbanRes.text.toLowerCase().includes('pasti kami unban'));

    // Skenario C: Akun Terkunci / Hack
    const hackRes = await waitingCompanion.processWaitingMessage({
      text: 'Akun saya kena hack dan terkunci',
      locale: 'id-ID',
      botPersona: 'mira',
    });

    assert.equal(hackRes.isHardTriggerTopic, true);
    assert.ok(
      hackRes.text.toLowerCase().includes('akun terkunci') || hackRes.text.toLowerCase().includes('kepemilikan'),
      'Harus mengakui kendala akun terkunci'
    );
  });

  test('4. Jeda waktu status update saat pemain diam: maksimal sekali tiap 3 menit (Throttle)', async () => {
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_throttle', 'ID', 'id-ID', 'handoff_queued', 'escalation', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    // 4.1 Panggilan pertama berhasil karena belum pernah dikirim
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/waiting-status-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.sent, true);

    // 4.2 Panggilan kedua langsung (kurang dari 3 menit) WAJIB ditolak (HTTP 429 / throttled)
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/waiting-status-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res2.status, 429);
    const data2 = await res2.json();
    assert.equal(data2.throttled, true);
    assert.ok(data2.message.includes('3 menit'));

    // 4.3 Simulasi waktu sudah berlalu >= 3 menit di database
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    await db.pool.query(
      `UPDATE conversations
       SET page_context = jsonb_set(COALESCE(page_context, '{}'::jsonb), '{last_status_update_at}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(fourMinutesAgo), convId]
    );

    // Panggilan ketiga setelah 3 menit harus berhasil kembali
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/waiting-status-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res3.status, 200);
    const data3 = await res3.json();
    assert.equal(data3.sent, true);
  });

  test('5. Seluruh data terkumpul saat menunggu ditulis ke handoffs.bot_summary', async () => {
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_summary_1', 'ID', 'id-ID', 'handoff_queued', 'escalation', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    await db.pool.query(`
      INSERT INTO handoffs (conversation_id, reason, bot_summary, locale, queued_at)
      VALUES ($1, 'topup_uncredited', 'Ringkasan awal', 'id-ID', now())
    `, [convId]);

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    await new Promise((r) => ws.once('open', r));

    // Kirim pesan berisi detail transaksi lengkap
    ws.send(JSON.stringify({
      event: 'message',
      conversation_id: convId,
      text: 'Order ID saya order_778899 sebesar Rp 50.000 via QRIS jam 14:30 WIB',
    }));

    await new Promise((r) => setTimeout(r, 600));

    // Periksa tabel handoffs: bot_summary harus memuat data yang dikumpulkan
    const handoffRow = await db.pool.query(
      `SELECT bot_summary FROM handoffs WHERE conversation_id = $1`,
      [convId]
    );
    assert.equal(handoffRow.rows.length, 1);
    const summary = handoffRow.rows[0].bot_summary;

    assert.ok(summary.includes('order_778899'), 'bot_summary harus memuat Order ID');
    assert.ok(summary.includes('50.000') || summary.includes('50'), 'bot_summary harus memuat nominal');
    assert.ok(summary.includes('QRIS'), 'bot_summary harus memuat metode pembayaran');
    assert.ok(summary.includes('14:30'), 'bot_summary harus memuat waktu transaksi');
  });

  test('6. Saat agent mengklaim percakapan: kirim pesan sistem dan alihkan identitas bot ke agent manusia', async () => {
    // Siapkan percakapan dalam status handoff_queued
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, stage, started_at)
      VALUES ('player_claim_test', 'ID', 'id-ID', 'handoff_queued', 'escalation', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    await db.pool.query(`
      INSERT INTO handoffs (conversation_id, reason, bot_summary, locale, queued_at)
      VALUES ($1, 'minta_manusia', 'Antrean handoff', 'id-ID', now())
    `, [convId]);

    // Daftarkan agent
    const agentId = '11111111-1111-1111-1111-111111111111';
    await db.pool.query(`
      INSERT INTO agents (id, name, locales, max_concurrent, status)
      VALUES ($1, 'Agent Budi', ARRAY['id-ID', 'en'], 5, 'online')
      ON CONFLICT (id) DO UPDATE SET name = 'Agent Budi'
    `, [agentId]);

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=test_token`;
    const ws = createClientSocket(wsUrl);

    let receivedStatusChange: any = null;
    let receivedSystemMessage: any = null;

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.event === 'status_change') receivedStatusChange = data;
      if (data.event === 'message' && data.sender_type === 'system') receivedSystemMessage = data;
    });

    await new Promise((r) => ws.once('open', r));

    ws.send(JSON.stringify({
      event: 'join_conversation',
      conversation_id: convId,
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Klaim percakapan oleh Agent Budi
    const claimRes = await fetch(`http://127.0.0.1:${port}/v1/conversations/${convId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    assert.equal(claimRes.status, 200);

    await new Promise((r) => setTimeout(r, 600));

    // Verifikasi event status_change memuat nama agent manusia
    assert.ok(receivedStatusChange, 'Harus menerima event status_change');
    assert.equal(receivedStatusChange.new_status, 'agent_active');
    assert.equal(receivedStatusChange.agent_name, 'Agent Budi');

    // Verifikasi pesan sistem tersiar
    assert.ok(receivedSystemMessage, 'Harus menerima pesan sistem penyerahan sesi');
    assert.ok(receivedSystemMessage.text.includes('Agent Budi'), 'Pesan sistem harus memuat nama Agent Budi');

    // Verifikasi di database: pesan sistem tersimpan
    const msgs = await db.getMessages(convId);
    const sysDbMsg = msgs.find((m) => m.sender_type === 'system');
    assert.ok(sysDbMsg, 'Pesan sistem penyerahan wajib tercatat di database');
    assert.ok(sysDbMsg.text.includes('Agent Budi'));
  });
});
