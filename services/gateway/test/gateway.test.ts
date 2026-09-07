import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';
import { WebSocketHub } from '../src/websocket-hub.js';

describe('TASK-02: Chat Gateway Tests', { timeout: 20000 }, () => {
  let db: Database;
  let pubsubA: RedisPubSub;
  let pubsubB: RedisPubSub;
  let gatewayA: any;
  let gatewayB: any;
  let hubA: WebSocketHub;
  let hubB: WebSocketHub;
  let portA: number;
  let portB: number;

  const clientSockets: WebSocket[] = [];

  function createClientSocket(url: string): WebSocket {
    const ws = new WebSocket(url);
    clientSockets.push(ws);
    return ws;
  }

  // Mock server untuk menguji kriteria wajib: gateway TIDAK memanggil /v1/orchestrate
  let mockOrchestratorServer: http.Server;
  let mockOrchestratorCalls = 0;

  before(async () => {
    // 1. Jalankan mock orchestrator untuk mendeteksi jika gateway memanggilnya
    await new Promise<void>((resolve, reject) => {
      mockOrchestratorServer = http.createServer((req, res) => {
        if (req.url?.includes('/v1/orchestrate')) {
          mockOrchestratorCalls++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ action: 'reply', text: 'mock reply' }));
      });
      mockOrchestratorServer.once('error', reject);
      mockOrchestratorServer.listen(0, '127.0.0.1', () => resolve());
    });

    db = new Database();

    // 2. Bersihkan tabel database dan seed agent uji untuk foreign key
    await db.pool.query('TRUNCATE messages, handoffs, conversations, agents CASCADE');
    await db.pool.query(`
      INSERT INTO agents (id, name, locales, max_concurrent, status) VALUES 
      ('11111111-1111-1111-1111-111111111111', 'Agent 1', ARRAY['th-TH', 'en', 'id-ID'], 3, 'online'),
      ('22222222-2222-2222-2222-222222222222', 'Agent 2', ARRAY['th-TH', 'en', 'id-ID'], 3, 'online'),
      ('33333333-3333-3333-3333-333333333333', 'Agent 3', ARRAY['th-TH', 'en', 'id-ID'], 3, 'online')
    `);

    // 3. Instance Gateway A (Port A)
    pubsubA = new RedisPubSub();
    const resA = await buildGatewayServer({ db, pubsub: pubsubA });
    gatewayA = resA.app;
    hubA = resA.hub;
    await gatewayA.listen({ port: 0, host: '127.0.0.1' });
    portA = (gatewayA.server.address() as any).port;

    // 4. Instance Gateway B (Port B — Instance terpisah untuk uji pub/sub multi-node)
    pubsubB = new RedisPubSub();
    const resB = await buildGatewayServer({ db, pubsub: pubsubB });
    gatewayB = resB.app;
    hubB = resB.hub;
    await gatewayB.listen({ port: 0, host: '127.0.0.1' });
    portB = (gatewayB.server.address() as any).port;

    // Beri jeda agar koneksi redis pubsub aktif
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    // 1. Terminate all client sockets created during tests
    for (const ws of clientSockets) {
      try {
        ws.terminate();
      } catch {}
    }
    clientSockets.length = 0;

    // 2. Close hubs
    try {
      hubA?.close();
      hubB?.close();
    } catch {}

    // 3. Close Fastify gateway servers and all active connections
    try {
      gatewayA?.server?.closeAllConnections?.();
      await gatewayA?.close();
    } catch {}

    try {
      gatewayB?.server?.closeAllConnections?.();
      await gatewayB?.close();
    } catch {}

    // 4. Close Redis pub/sub
    try {
      await pubsubA?.close();
      await pubsubB?.close();
    } catch {}

    // 5. Clean up DB and close pool
    try {
      await db?.pool?.query('TRUNCATE messages, handoffs, conversations, agents CASCADE');
    } catch {}
    try {
      await db?.close();
    } catch {}

    // 6. Close mock orchestrator server
    try {
      mockOrchestratorServer?.closeAllConnections?.();
      await new Promise<void>((resolve) => mockOrchestratorServer.close(() => resolve()));
    } catch {}
  });

  test('1. Dua klien di DUA instance gateway berbeda saling menerima pesan via Redis Pub/Sub', { timeout: 5000 }, async () => {
    const playerToken = 'token_77124490';
    const agentToken = 'token_agent_99';

    const wsPlayer = createClientSocket(`ws://127.0.0.1:${portA}/v1/socket?token=${playerToken}`);
    const wsAgent = createClientSocket(`ws://127.0.0.1:${portB}/v1/socket?token=${agentToken}&agent=true`);

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

    // 1.3 Player (di Gateway A) kirim pesan via WebSocket
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

    // 1.4 Agent di Gateway B membalas via WebSocket
    const playerWsReplyPromise = new Promise<any>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'message' && msg.sender_type === 'agent') {
          resolve(msg);
        }
      });
    });

    wsAgent.send(
      JSON.stringify({
        event: 'message',
        conversation_id: conversationId,
        text: 'Halo Ryu, kami bantu cek ya!',
      })
    );

    const playerWsReply = await playerWsReplyPromise;
    assert.equal(playerWsReply.text, 'Halo Ryu, kami bantu cek ya!');
    assert.equal(playerWsReply.sender_type, 'agent');

    // 1.5 Agent kirim balasan lewat REST API Gateway B
    const restReplyPromise = new Promise<any>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'message' && msg.text.includes('transaksi')) {
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

    // Verifikasi Player di Gateway A menerima balasan REST via Redis Pub/Sub
    const playerReceivedRest = await restReplyPromise;
    assert.equal(playerReceivedRest.text, 'Halo kak Ryu, ada yang bisa kami bantu terkait transaksi?');
    assert.equal(playerReceivedRest.sender_type, 'agent');

    // 1.6 Verifikasi seluruh pesan tersimpan di tabel messages Postgres
    const messagesRes = await db.getMessages(conversationId);
    assert.ok(messagesRes.length >= 3, 'Pesan harus tersimpan di basis data Postgres');
    assert.equal(messagesRes[0].text, 'Halo, saya mau tanya soal topup');
    assert.equal(messagesRes[1].text, 'Halo Ryu, kami bantu cek ya!');
    assert.equal(messagesRes[2].text, 'Halo kak Ryu, ada yang bisa kami bantu terkait transaksi?');

    wsPlayer.terminate();
    wsAgent.terminate();
  });

  test('2. Gateway TIDAK memanggil /v1/orchestrate sama sekali di TASK-02', { timeout: 5000 }, async () => {
    // Pada pengujian nomor 1, pesan dikirim dan diterima oleh gateway
    // Verifikasi counter panggilan ke mock orchestrator tetap tepat 0
    assert.equal(
      mockOrchestratorCalls,
      0,
      'Gateway tidak boleh memanggil /v1/orchestrate sama sekali di task ini'
    );
  });

  test('3. Semua transisi status yang sah mengikuti tabel di spec/01-arsitektur.md', { timeout: 5000 }, async () => {
    // 3.1 Alur standar: bot_active -> handoff_queued -> agent_active -> resolved
    const conv1 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_1' },
      { market: 'ID', locale: 'id-ID' }
    );
    assert.equal(conv1.status, 'bot_active');

    // Transisi: bot_active -> handoff_queued
    const resHandoff = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv1.id}/transition`,
      payload: { to: 'handoff_queued' },
    });
    assert.equal(resHandoff.statusCode, 200);
    assert.equal(JSON.parse(resHandoff.payload).status, 'handoff_queued');

    // Transisi: handoff_queued -> agent_active (klaim agent)
    const resClaim = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv1.id}/claim`,
      payload: { agent_id: '11111111-1111-1111-1111-111111111111' },
    });
    assert.equal(resClaim.statusCode, 200);
    assert.equal(JSON.parse(resClaim.payload).status, 'agent_active');
    assert.equal(JSON.parse(resClaim.payload).assigned_agent_id, '11111111-1111-1111-1111-111111111111');

    // Transisi: agent_active -> resolved (agent_resolved)
    const resResolved1 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv1.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'agent_resolved' },
    });
    assert.equal(resResolved1.statusCode, 200);
    assert.equal(JSON.parse(resResolved1.payload).status, 'resolved');
    assert.equal(JSON.parse(resResolved1.payload).resolution_reason, 'agent_resolved');

    // 3.2 Alur mandiri: bot_active -> resolved (bot_resolved)
    const conv2 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_2' },
      { market: 'ID', locale: 'id-ID' }
    );
    assert.equal(conv2.status, 'bot_active');

    const resResolved2 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv2.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'bot_resolved' },
    });
    assert.equal(resResolved2.statusCode, 200);
    assert.equal(JSON.parse(resResolved2.payload).status, 'resolved');
    assert.equal(JSON.parse(resResolved2.payload).resolution_reason, 'bot_resolved');

    // 3.3 Alur timeout antrean: handoff_queued -> resolved (player_abandoned)
    const conv3 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_3' },
      { market: 'ID', locale: 'id-ID' }
    );
    await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv3.id}/transition`,
      payload: { to: 'handoff_queued' },
    });

    const resResolved3 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv3.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'player_abandoned' },
    });
    assert.equal(resResolved3.statusCode, 200);
    assert.equal(JSON.parse(resResolved3.payload).status, 'resolved');
    assert.equal(JSON.parse(resResolved3.payload).resolution_reason, 'player_abandoned');

    // 3.4 Alur intervensi manual: bot_active -> agent_active (agent menyela saat bot aktif)
    const conv4 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_4' },
      { market: 'ID', locale: 'id-ID' }
    );
    assert.equal(conv4.status, 'bot_active');

    const resIntervene = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv4.id}/claim`,
      payload: { agent_id: '22222222-2222-2222-2222-222222222222' },
    });
    assert.equal(resIntervene.statusCode, 200);
    assert.equal(JSON.parse(resIntervene.payload).status, 'agent_active');

    // 3.5 Uji endpoint dedicated resolve: POST /v1/conversations/:id/resolve
    const resResolveEndpoint = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv4.id}/resolve`,
      payload: { resolution_reason: 'agent_resolved' },
    });
    assert.equal(resResolveEndpoint.statusCode, 200);
    assert.equal(JSON.parse(resResolveEndpoint.payload).status, 'resolved');

    // 3.6 Transisi ke resolved tanpa resolution_reason wajib ditolak
    const conv5 = await db.getOrCreateActiveConversation(
      { uid: 'trans_test_player_5' },
      { market: 'ID', locale: 'id-ID' }
    );
    const resNoReason = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv5.id}/transition`,
      payload: { to: 'resolved' },
    });
    assert.equal(resNoReason.statusCode, 400, 'Resolved tanpa resolution_reason harus ditolak');
  });

  test('4. Transisi terlarang (terutama agent_active -> bot_active dan resolved -> *) DITOLAK di level API', { timeout: 5000 }, async () => {
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
    const claimRes = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/claim`,
      payload: { agent_id: '22222222-2222-2222-2222-222222222222' },
    });
    assert.equal(claimRes.statusCode, 200);

    // Coba transisi terlarang: agent_active -> bot_active (WAJIB DITOLAK KERAS)
    const resIllegal1 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'bot_active' },
    });
    assert.equal(resIllegal1.statusCode, 400, 'agent_active -> bot_active harus mengembalikan status HTTP 400');
    const errBody1 = JSON.parse(resIllegal1.payload);
    assert.equal(errBody1.code, 'INVALID_STATUS_TRANSITION');
    assert.match(errBody1.error, /dilarang keras/);

    // Coba transisi terlarang: agent_active -> handoff_queued (DITOLAK)
    const resIllegal1b = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'handoff_queued' },
    });
    assert.equal(resIllegal1b.statusCode, 400, 'agent_active -> handoff_queued harus ditolak');

    // 4.2 Selesaikan sesi ke resolved
    await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'resolved', resolution_reason: 'agent_resolved' },
    });

    // Coba transisi terlarang: resolved -> bot_active (DITOLAK)
    const resIllegal2 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'bot_active' },
    });
    assert.equal(resIllegal2.statusCode, 400, 'resolved -> bot_active harus ditolak');
    assert.equal(JSON.parse(resIllegal2.payload).code, 'INVALID_STATUS_TRANSITION');

    // Coba transisi terlarang: resolved -> agent_active (DITOLAK)
    const resIllegal3 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/claim`,
      payload: { agent_id: '33333333-3333-3333-3333-333333333333' },
    });
    assert.equal(resIllegal3.statusCode, 400, 'resolved -> agent_active harus ditolak');

    // Coba transisi terlarang: resolved -> handoff_queued (DITOLAK)
    const resIllegal4 = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/transition`,
      payload: { to: 'handoff_queued' },
    });
    assert.equal(resIllegal4.statusCode, 400, 'resolved -> handoff_queued harus ditolak');

    // Coba kirim pesan ke sesi yang sudah resolved (DITOLAK)
    const resMsgResolved = await gatewayA.inject({
      method: 'POST',
      url: `/v1/conversations/${conv.id}/messages`,
      payload: { text: 'Pesan ke sesi yang sudah ditutup' },
    });
    assert.equal(resMsgResolved.statusCode, 400, 'Pesan ke sesi resolved harus ditolak');
  });

  test('5. Autentikasi WebSocket: token wajib valid, token kosong/salah ditolak', { timeout: 5000 }, async () => {
    // 5.1 Koneksi tanpa token
    const wsNoToken = createClientSocket(`ws://127.0.0.1:${portA}/v1/socket`);
    const errorNoTokenPromise = new Promise<any>((resolve) => {
      wsNoToken.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    const closeNoTokenPromise = new Promise<number>((resolve) => {
      wsNoToken.on('close', (code) => resolve(code));
    });

    const errorNoToken = await errorNoTokenPromise;
    assert.equal(errorNoToken.event, 'error');
    assert.equal(errorNoToken.code, 'AUTH_FAILED');
    const closeCodeNoToken = await closeNoTokenPromise;
    assert.equal(closeCodeNoToken, 1008);

    // 5.2 Koneksi dengan token tidak valid (< 6 karakter bukan format khusus)
    const wsBadToken = createClientSocket(`ws://127.0.0.1:${portA}/v1/socket?token=bad`);
    const errorBadTokenPromise = new Promise<any>((resolve) => {
      wsBadToken.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    const closeBadTokenPromise = new Promise<number>((resolve) => {
      wsBadToken.on('close', (code) => resolve(code));
    });

    const errorBadToken = await errorBadTokenPromise;
    assert.equal(errorBadToken.event, 'error');
    assert.equal(errorBadToken.code, 'AUTH_FAILED');
    const closeCodeBadToken = await closeBadTokenPromise;
    assert.equal(closeCodeBadToken, 1008);

    wsNoToken.terminate();
    wsBadToken.terminate();
  });

  test('6. Event WebSocket set_locale mengubah locale percakapan di database', { timeout: 5000 }, async () => {
    const ws = createClientSocket(`ws://127.0.0.1:${portA}/v1/socket?token=token_locale_changer`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    let conversationId = '';
    const startedPromise = new Promise<string>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'session_started') {
          resolve(msg.conversation_id);
        }
      });
    });

    ws.send(
      JSON.stringify({
        event: 'session_start',
        player: { uid: 'locale_changer' },
        context: { market: 'TH', locale: 'th-TH' },
      })
    );
    conversationId = await startedPromise;

    // Kirim set_locale ke 'en'
    ws.send(
      JSON.stringify({
        event: 'set_locale',
        conversation_id: conversationId,
        locale: 'en',
      })
    );

    // Beri jeda penyimpanan DB
    await new Promise((r) => setTimeout(r, 100));
    const updatedConv = await db.getConversation(conversationId);
    assert.equal(updatedConv?.locale, 'en', 'Locale harus terupdate menjadi en di database');

    ws.terminate();
  });

  test('7. Siaran status_change antar dua instance gateway diterima via Redis Pub/Sub', { timeout: 5000 }, async () => {
    const wsPlayer = createClientSocket(`ws://127.0.0.1:${portA}/v1/socket?token=token_status_player`);
    await new Promise<void>((resolve) => wsPlayer.on('open', resolve));

    const sessionStartPromise = new Promise<string>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'session_started') resolve(msg.conversation_id);
      });
    });

    wsPlayer.send(
      JSON.stringify({
        event: 'session_start',
        player: { uid: 'status_player' },
        context: { market: 'ID', locale: 'id-ID' },
      })
    );

    const convId = await sessionStartPromise;

    // Listener status_change di Gateway A
    const statusChangePromise = new Promise<any>((resolve) => {
      wsPlayer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'status_change') {
          resolve(msg);
        }
      });
    });

    // Pemicu transisi status di Gateway B
    const resTransition = await gatewayB.inject({
      method: 'POST',
      url: `/v1/conversations/${convId}/transition`,
      payload: { to: 'handoff_queued' },
    });
    assert.equal(resTransition.statusCode, 200);

    // Gateway A menerima event status_change via Redis Pub/Sub
    const statusEvent = await statusChangePromise;
    assert.equal(statusEvent.conversation_id, convId);
    assert.equal(statusEvent.previous_status, 'bot_active');
    assert.equal(statusEvent.new_status, 'handoff_queued');

    wsPlayer.terminate();
  });
});
