import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';

describe('TASK-04: Agent Panel & Queue Management Tests', { timeout: 20000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let server: any;
  let baseUrl: string;

  // UUIDs of seeded test agents
  const AGENT_ID = '11111111-1111-1111-1111-111111111111'; // Indonesian specialist ['id-ID', 'en']
  const AGENT_TH = '22222222-2222-2222-2222-222222222222'; // Thai specialist ['th-TH', 'en']
  const AGENT_VN = '33333333-3333-3333-3333-333333333333'; // Vietnamese specialist ['vi-VN', 'en']
  const AGENT_EN = '44444444-4444-4444-4444-444444444444'; // English Only ['en']

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    // 1. Seed agents
    await db.seedInitialAgents();

    // 2. Build and start gateway server on dynamic port
    const res = await buildGatewayServer({ db, pubsub });
    server = res.app;
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    try {
      server?.server?.closeAllConnections?.();
      await server?.close();
    } catch {}
    try {
      await pubsub?.close();
    } catch {}
    try {
      await db?.close();
    } catch {}
  });

  test('1. Agent hanya melihat antrean sesuai agents.locales', async () => {
    // Bersihkan percakapan sebelumnya
    await db.pool.query('DELETE FROM messages');
    await db.pool.query('DELETE FROM handoffs');
    await db.pool.query('DELETE FROM conversations');

    // Buat 4 percakapan dalam antrean handoff_queued untuk 4 locale berbeda
    const convId = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('uid_id', 'ID', 'id-ID', 'handoff_queued', now()) RETURNING id
    `);
    const convTh = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('uid_th', 'TH', 'th-TH', 'handoff_queued', now()) RETURNING id
    `);
    const convVn = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('uid_vn', 'VN', 'vi-VN', 'handoff_queued', now()) RETURNING id
    `);
    const convEn = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('uid_en', 'SG', 'en', 'handoff_queued', now()) RETURNING id
    `);

    // 1.1 Agent TH (locales: ['th-TH', 'en']) hanya boleh melihat th-TH dan en
    const resTh = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_TH}`);
    assert.equal(resTh.status, 200);
    const dataTh = await resTh.json();
    assert.equal(dataTh.count, 2, 'Agent TH harus melihat tepat 2 antrean');
    const localesTh = dataTh.queue.map((q: any) => q.locale);
    assert.ok(localesTh.includes('th-TH'), 'Antrean harus mencakup th-TH');
    assert.ok(localesTh.includes('en'), 'Antrean harus mencakup en');
    assert.ok(!localesTh.includes('id-ID'), 'Agent TH tidak boleh melihat antrean id-ID');
    assert.ok(!localesTh.includes('vi-VN'), 'Agent TH tidak boleh melihat antrean vi-VN');

    // 1.2 Agent EN Only (locales: ['en']) hanya boleh melihat en
    const resEn = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_EN}`);
    assert.equal(resEn.status, 200);
    const dataEn = await resEn.json();
    assert.equal(dataEn.count, 1, 'Agent EN Only harus melihat tepat 1 antrean');
    assert.equal(dataEn.queue[0].locale, 'en');

    // 1.3 Agent ID (locales: ['id-ID', 'en']) hanya boleh melihat id-ID dan en
    const resId = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_ID}`);
    assert.equal(resId.status, 200);
    const dataId = await resId.json();
    assert.equal(dataId.count, 2, 'Agent ID harus melihat tepat 2 antrean');
    const localesId = dataId.queue.map((q: any) => q.locale);
    assert.ok(localesId.includes('id-ID'));
    assert.ok(localesId.includes('en'));

    // 1.4 Filter spesifik ?locale=th-TH pada Agent TH
    const resThFilter = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_TH}&locale=th-TH`);
    const dataThFilter = await resThFilter.json();
    assert.equal(dataThFilter.count, 1);
    assert.equal(dataThFilter.queue[0].locale, 'th-TH');

    // 1.5 Filter bahasa yang tidak dikuasai agent (misal Agent TH meminta locale=id-ID) menghasilkan antrean kosong
    const resUnauthorized = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_TH}&locale=id-ID`);
    const dataUnauthorized = await resUnauthorized.json();
    assert.equal(dataUnauthorized.count, 0, 'Harus kosong jika agent tidak punya hak untuk locale itu');
  });

  test('2. Urut berdasarkan sisa SLA, bukan waktu masuk', async () => {
    await db.pool.query('DELETE FROM messages');
    await db.pool.query('DELETE FROM handoffs');
    await db.pool.query('DELETE FROM conversations');

    // Buat 3 percakapan di pasar TH (locale: th-TH):
    // Conv A: Masuk 20 menit lalu (paling awal masuk!), SLA sisa 30 menit ke depan
    // Conv B: Masuk 10 menit lalu, SLA sisa 5 menit ke depan (paling mendesak!)
    // Conv C: Masuk 5 menit lalu, SLA sisa 15 menit ke depan
    const now = Date.now();
    const convA = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, sla_due_at, started_at)
      VALUES ('player_A', 'TH', 'th-TH', 'handoff_queued', $1, now() - interval '20 minutes')
      RETURNING id
    `, [new Date(now + 30 * 60 * 1000)]);

    const convB = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, sla_due_at, started_at)
      VALUES ('player_B', 'TH', 'th-TH', 'handoff_queued', $1, now() - interval '10 minutes')
      RETURNING id
    `, [new Date(now + 5 * 60 * 1000)]);

    const convC = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, sla_due_at, started_at)
      VALUES ('player_C', 'TH', 'th-TH', 'handoff_queued', $1, now() - interval '5 minutes')
      RETURNING id
    `, [new Date(now + 15 * 60 * 1000)]);

    const res = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_TH}&locale=th-TH`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 3);

    // Verifikasi urutan: harus B (5m) -> C (15m) -> A (30m)
    // Walaupun A masuk paling awal (20m lalu), ia harus berada di urutan terakhir karena sisa SLA-nya paling longgar
    assert.equal(data.queue[0].player_uid, 'player_B', 'Percakapan paling mendesak (SLA 5m) harus urutan pertama');
    assert.equal(data.queue[1].player_uid, 'player_C', 'Percakapan SLA 15m harus urutan kedua');
    assert.equal(data.queue[2].player_uid, 'player_A', 'Percakapan SLA 30m harus urutan ketiga meski masuk lebih dulu');
  });

  test('3. Klaim mengunci percakapan dari agent lain (Atomic locking / Race condition test)', async () => {
    await db.pool.query('DELETE FROM messages');
    await db.pool.query('DELETE FROM handoffs');
    await db.pool.query('DELETE FROM conversations');

    // Buat percakapan handoff
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('race_player', 'TH', 'th-TH', 'handoff_queued', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    // Catat juga di handoffs
    await db.pool.query(`
      INSERT INTO handoffs (conversation_id, reason, bot_summary, locale)
      VALUES ($1, 'human_request', 'Pemain minta bantuan CS', 'th-TH')
    `, [convId]);

    // Dua agent (AGENT_TH dan AGENT_EN) mencoba mengklaim percakapan yang sama secara BERSAMAAN
    const [claimA, claimB] = await Promise.all([
      fetch(`${baseUrl}/v1/conversations/${convId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: AGENT_TH }),
      }),
      fetch(`${baseUrl}/v1/conversations/${convId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: AGENT_EN }),
      }),
    ]);

    const statuses = [claimA.status, claimB.status].sort();
    assert.deepEqual(
      statuses,
      [200, 409],
      'Tepat satu agen harus berhasil (HTTP 200) dan satu agen harus ditolak (HTTP 409 Conflict)'
    );

    // Cek di database: status harus agent_active dan assigned_agent_id terisi
    const updatedConv = await db.getConversation(convId);
    assert.equal(updatedConv?.status, 'agent_active');
    assert.ok(
      updatedConv?.assigned_agent_id === AGENT_TH || updatedConv?.assigned_agent_id === AGENT_EN
    );

    // Cek tabel handoffs: picked_at dan agent_id harus tercatat
    const handoffRes = await db.pool.query(
      `SELECT * FROM handoffs WHERE conversation_id = $1`,
      [convId]
    );
    assert.equal(handoffRes.rows.length, 1);
    assert.ok(handoffRes.rows[0].picked_at !== null, 'picked_at harus terisi');
    assert.equal(handoffRes.rows[0].agent_id, updatedConv?.assigned_agent_id);

    // Percakapan yang sudah diklaim tidak boleh muncul lagi di antrean
    const queueAfter = await fetch(`${baseUrl}/v1/queue?agent_id=${AGENT_TH}`);
    const queueData = await queueAfter.json();
    assert.equal(queueData.count, 0, 'Percakapan yang sudah diklaim harus hilang dari antrean');
  });

  test('4. Klaim ditolak jika percakapan sudah resolved', async () => {
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, resolution_reason, started_at, closed_at)
      VALUES ('closed_player', 'ID', 'id-ID', 'resolved', 'player_abandoned', now(), now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: AGENT_ID }),
    });

    assert.equal(res.status, 400, 'Klaim pada percakapan resolved harus mengembalikan 400');
    const data = await res.json();
    assert.equal(data.code, 'CONVERSATION_RESOLVED');
  });

  test('5. Agent membalas pesan dan menyelesaikan (resolve) sesi percakapan', async () => {
    // Buat percakapan aktif milik AGENT_ID
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, assigned_agent_id, started_at)
      VALUES ('active_player', 'ID', 'id-ID', 'agent_active', $1, now())
      RETURNING id
    `, [AGENT_ID]);
    const convId = convRes.rows[0].id;

    // 5.1 Agent kirim pesan balasan
    const sendRes = await fetch(`${baseUrl}/v1/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Halo kak, ada yang bisa saya bantu terkait kendala top-up?',
        sender_id: AGENT_ID,
        sender_type: 'agent',
      }),
    });
    assert.equal(sendRes.status, 201);
    const sentData = await sendRes.json();
    assert.equal(sentData.text, 'Halo kak, ada yang bisa saya bantu terkait kendala top-up?');
    assert.equal(sentData.sender_type, 'agent');

    // Verifikasi pesan tersimpan di endpoint riwayat
    const msgRes = await fetch(`${baseUrl}/v1/conversations/${convId}/messages`);
    assert.equal(msgRes.status, 200);
    const msgData = await msgRes.json();
    assert.equal(msgData.messages.length, 1);
    assert.equal(msgData.messages[0].sender_id, AGENT_ID);

    // 5.2 Agent menyelesaikan percakapan
    const resolveRes = await fetch(`${baseUrl}/v1/conversations/${convId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution_reason: 'agent_resolved' }),
    });
    assert.equal(resolveRes.status, 200);
    const resolvedData = await resolveRes.json();
    assert.equal(resolvedData.status, 'resolved');
    assert.equal(resolvedData.resolution_reason, 'agent_resolved');

    // Verifikasi di DB
    const finalConv = await db.getConversation(convId);
    assert.equal(finalConv?.status, 'resolved');
    assert.equal(finalConv?.resolution_reason, 'agent_resolved');
    assert.ok(finalConv?.closed_at !== null);
  });
});
