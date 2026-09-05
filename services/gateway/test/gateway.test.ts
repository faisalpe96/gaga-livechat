import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';

describe('TASK-02: Chat Gateway Tests', () => {
  let db: Database;
  let pubsubA: RedisPubSub;
  let pubsubB: RedisPubSub;
  let gatewayA: any;
  let gatewayB: any;
  let portA: number;
  let portB: number;

  // Mock server untuk menguji kriteria tambahan: gateway TIDAK memanggil /v1/orchestrate
  let mockOrchestratorServer: http.Server;
  let mockOrchestratorCalls = 0;
  const mockOrchestratorPort = 3199;

  before(async () => {
    // Jalankan mock orchestrator
    await new Promise<void>((resolve) => {
      mockOrchestratorServer = http.createServer((req, res) => {
        if (req.url?.includes('/v1/orchestrate')) {
          mockOrchestratorCalls++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ action: 'reply', text: 'mock reply' }));
      });
      mockOrchestratorServer.listen(mockOrchestratorPort, () => resolve());
    });

    db = new Database();
    pubsubA = new RedisPubSub();
    pubsubB = new RedisPubSub();

    // Instance Gateway A
    const resA = await buildGatewayServer({ db, pubsub: pubsubA });
    gatewayA = resA.app;
    await gatewayA.listen({ port: 0, host: '127.0.0.1' });
    portA = (gatewayA.server.address() as any).port;

    // Instance Gateway B (Instance terpisah)
    const resB = await buildGatewayServer({ db, pubsub: pubsubB });
    gatewayB = resB.app;
    await gatewayB.listen({ port: 0, host: '127.0.0.1' });
    portB = (gatewayB.server.address() as any).port;

    // Beri jeda agar koneksi redis pubsub aktif
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    await gatewayA.close();
    await gatewayB.close();
    await pubsubA.close();
    await pubsubB.close();
    await db.close();
    await new Promise<void>((resolve) => mockOrchestratorServer.close(() => resolve()));
  });

  test('1. Dua klien di DUA instance gateway berbeda saling menerima pesan via Redis Pub/Sub', async () => {
    const playerToken = 'token_77124490';
    const agentToken = 'token_agent_99';

    const wsPlayer = new WebSocket(`ws://127.0.0.1:${portA}/v1/socket?token=${playerToken}`);
    const wsAgent = new WebSocket(`ws://127.0.0.1:${portB}/v1/socket?token=${agentToken}&agent=true`);

    await Promise.all([
      new Promise<void>((resolve) => wsPlayer.on('open', resolve)),
      new Promise<void>((resolve) => wsAgent.on('open', resolve)),
    ]);

    // 1.1 Klien Player mengirim session_start ke Gateway A
    let conversationId = '';
    const sessionStartPromise = new Promise<string>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'session_started') {
          resolve(msg.conversation_id);
        }
      });
    });

    wsPlayer.send(
      JSON.stringify({
        event: 'session_start',
        player: { uid: '77124490', nickname: 'RyuHunter', level: 48 },
        context: { market: 'TH', locale: 'th-TH', page: '/topup' },
      })
    );

    conversationId = await sessionStartPromise;
    assert.ok(conversationId, 'Conversation ID harus diterima');

    // 1.2 Agent di Gateway B bergabung ke ruang conversationId
    wsAgent.send(
      JSON.stringify({
        event: 'join_conversation',
        conversation_id: conversationId,
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // Siapkan listener pesan di Agent (Gateway B)
    const agentReceivedPromise = new Promise<any>((resolve) => {
      wsAgent.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'message' && msg.sender_type === 'player') {
          resolve(msg);
        }
      });
    });

    // 1.3 Player (di Gateway A) kirim pesan
    wsPlayer.send(
      JSON.stringify({
        event: 'message',
        conversation_id: conversationId,
        text: 'Halo, saya mau tanya soal topup',
      })
    );

    // Verifikasi pesan diterima oleh Agent di Gateway B (lintas instance via Redis pub/sub)
    const agentReceived = await agentReceivedPromise;
    assert.equal(agentReceived.conversation_id, conversationId);
    assert.equal(agentReceived.text, 'Halo, saya mau tanya soal topup');
    assert.equal(agentReceived.sender_type, 'player');

    // 1.4 Agent kirim balasan lewat REST API Gateway B
    const restReplyPromise = new Promise<any>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'message' && msg.sender_type === 'agent') {
          resolve(msg);
        }
      });
    });

    const restRes = await gatewayB.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      payload: {
        sender_type: 'agent',
        sender_id: 'agent_99',
        text: 'Halo kak Ryu, ada yang bisa kami bantu terkait transaksi?',
      },
    });
    assert.equal(restRes.statusCode, 201);

    // Verifikasi Player di Gateway A menerima pesan dari Agent via Redis Pub/Sub
    const playerReceived = await restReplyPromise;
    assert.equal(playerReceived.text, 'Halo kak Ryu, ada yang bisa kami bantu terkait transaksi?');
    assert.equal(playerReceived.sender_type, 'agent');

    // 1.5 Verifikasi pesan tersimpan di tabel messages Postgres
    const messagesRes = await db.getMessages(conversationId);
    assert.ok(messagesRes.length >= 2, 'Pesan harus tersimpan di basis data Postgres');
    assert.equal(messagesRes[0].text, 'Halo, saya mau tanya soal topup');
    assert.equal(messagesRes[1].text, 'Halo kak Ryu, ada yang bisa kami bantu terkait transaksi?');

    wsPlayer.close();
    wsAgent.close();
  });

  test('2. Gateway TIDAK memanggil /v1/orchestrate sama sekali di TASK-02', async () => {
    // Pada pengujian nomor 1, pesan dikirim dan diterima oleh gateway
    // Verifikasi counter panggilan ke mock orchestrator tetap tepat 0
    assert.equal(
      mockOrchestratorCalls,
      0,
      'Gateway tidak boleh memanggil /v1/orchestrate sama sekali di task ini'
    );
  });

  test('3. Semua transisi status yang sah mengikuti tabel di spec/01-arsitektur.md', async () => {
    // Buat percakapan baru (status awal bot_active)
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player' },
      { market: 'ID', locale: 'id-ID' }
    );
    assert.equal(conv.status, 'bot_active');

    // Transisi 1: bot_active -> handoff_queued (eskalasi)
    const res1 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'handoff_queued' },
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(JSON.parse(res1.payload).status, 'handoff_queued');

    // Transisi 2: handoff_queued -> agent_active (agent claim)
    const res2 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/claim`,
      payload: { agent_id: '11111111-1111-1111-1111-111111111111' },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.parse(res2.payload).status, 'agent_active');

    // Transisi 3: agent_active -> resolved
    const res3 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'agent_resolved' },
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(JSON.parse(res3.payload).status, 'resolved');
    assert.equal(JSON.parse(res3.payload).resolution_reason, 'agent_resolved');

    // Uji alur kedua: bot_active -> resolved (bot selesai sendiri)
    const conv2 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_2' },
      { market: 'ID', locale: 'id-ID' }
    );
    assert.equal(conv2.status, 'bot_active');

    const resBotResolved = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv2.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'bot_resolved' },
    });
    assert.equal(resBotResolved.statusCode, 200);
    assert.equal(JSON.parse(resBotResolved.payload).status, 'resolved');
  });

  test('4. Transisi terlarang (terutama agent_active -> bot_active dan resolved -> *) DITOLAK di level API', async () => {
    // 4.1 Buat sesi dan bawa ke agent_active
    const conv = await db.getOrCreateActiveConversation(
      { uid: 'forbidden_test_player' },
      { market: 'ID', locale: 'id-ID' }
    );
    await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'handoff_queued' },
    });
    await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/claim`,
      payload: { agent_id: '22222222-2222-2222-2222-222222222222' },
    });

    // Coba transisi terlarang: agent_active -> bot_active (HARUS DITOLAK)
    const resIllegal1 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'bot_active' },
    });
    assert.equal(resIllegal1.statusCode, 400, 'agent_active -> bot_active harus mengembalikan status HTTP 400');
    const errBody1 = JSON.parse(resIllegal1.payload);
    assert.equal(errBody1.code, 'INVALID_STATUS_TRANSITION');
    assert.match(errBody1.error, /dilarang keras/);

    // 4.2 Selesaikan sesi ke resolved
    await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'agent_resolved' },
    });

    // Coba transisi terlarang: resolved -> bot_active (HARUS DITOLAK)
    const resIllegal2 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'bot_active' },
    });
    assert.equal(resIllegal2.statusCode, 400, 'resolved -> bot_active harus ditolak');
    assert.equal(JSON.parse(resIllegal2.payload).code, 'INVALID_STATUS_TRANSITION');

    // Coba transisi terlarang: resolved -> agent_active (HARUS DITOLAK)
    const resIllegal3 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/claim`,
      payload: { agent_id: '33333333-3333-3333-3333-333333333333' },
    });
    assert.equal(resIllegal3.statusCode, 400, 'resolved -> agent_active harus ditolak');
  });
});
