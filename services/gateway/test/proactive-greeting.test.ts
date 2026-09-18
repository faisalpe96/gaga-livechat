import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';
import { WebSocketHub } from '../src/websocket-hub.js';
import { generateProactiveGreeting } from '../src/proactive-greeting.js';
import { calculateServiceMode } from '../src/service-mode.js';

describe('TASK-07 / TASK-08: Proactive Opening Greeting Tests', { timeout: 25000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let hub: WebSocketHub;
  let gateway: any;
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

    await db.ensureBotPersonasTable();
    await db.ensureInvestigationAndScheduleTables();

    // Truncate tables untuk lingkungan pengujian bersih
    await db.pool.query('TRUNCATE messages, handoffs, conversations, agents CASCADE');

    const res = await buildGatewayServer({ db, pubsub });
    gateway = res.app;
    hub = res.hub;
    // Set delay ke 0 agar pengujian cepat dan deterministik
    hub.proactiveGreetingDelayMs = 0;

    await gateway.listen({ port: 0, host: '127.0.0.1' });
    const addr = gateway.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 3001;
  });

  after(async () => {
    for (const ws of clientSockets) {
      try {
        ws.terminate();
      } catch {}
    }
    await gateway.close();
    await pubsub.close();
    await db.close();
  });

  test('1. Proactive greeting dikirim segera saat session_start sebelum pemain mengetik pesan', async () => {
    const playerUid = 'player_proactive_01';
    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_${playerUid}`;
    const ws = createClientSocket(wsUrl);

    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const receivedMessages: any[] = [];
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      receivedMessages.push(parsed);
    });

    // Kirim session_start
    ws.send(JSON.stringify({
      event: 'session_start',
      player: {
        uid: playerUid,
        nickname: 'SuperPlayer',
      },
      context: {
        market: 'ID',
        locale: 'id-ID',
        page: '/home',
      }
    }));

    // Tunggu pesan opening greeting tiba di websocket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout menunggu proactive greeting')), 4000);
      const check = setInterval(() => {
        const msg = receivedMessages.find((m) => m.event === 'message' && m.sender_type === 'bot');
        if (msg) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const greetingMsg = receivedMessages.find((m) => m.event === 'message' && m.sender_type === 'bot');
    assert.ok(greetingMsg, 'Pesan proaktif dari bot wajib diterima');
    assert.strictEqual(greetingMsg.sender_type, 'bot');
    assert.ok(greetingMsg.sender_name, 'Nama pengirim persona bot harus ada');
    assert.ok(greetingMsg.text.includes('SuperPlayer'), 'Pesan harus menyapa nickname pemain');
    assert.ok(greetingMsg.text.endsWith('?'), 'Pesan harus diakhiri dengan pertanyaan terbuka');

    // Pastikan tersimpan di database dengan sender_type: 'bot' (Syarat 7)
    const dbMsgRes = await db.pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [greetingMsg.conversation_id]
    );
    assert.strictEqual(dbMsgRes.rows.length, 1, 'Pesan harus tersimpan di database');
    assert.strictEqual(dbMsgRes.rows[0].sender_type, 'bot');
    assert.strictEqual(dbMsgRes.rows[0].meta.is_proactive_greeting, true);
  });

  test('2. Greeting dikirim HANYA SEKALI per sesi, TIDAK dikirim ulang saat reconnect / page refresh', async () => {
    const playerUid = 'player_proactive_reconnect';
    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_${playerUid}`;

    // Sesi pertama dibuka
    const ws1 = createClientSocket(wsUrl);
    await new Promise<void>((resolve) => ws1.once('open', () => resolve()));

    let convId = '';
    const ws1Messages: any[] = [];
    ws1.on('message', (data) => {
      const p = JSON.parse(data.toString());
      ws1Messages.push(p);
      if (p.event === 'session_started') convId = p.conversation_id;
    });

    ws1.send(JSON.stringify({
      event: 'session_start',
      player: { uid: playerUid, nickname: 'GamerOne' },
      context: { market: 'ID', locale: 'id-ID', page: '/home' }
    }));

    // Tunggu greeting pertama tiba
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout sesi 1')), 4000);
      const check = setInterval(() => {
        if (ws1Messages.some((m) => m.event === 'message' && m.sender_type === 'bot')) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    ws1.close();

    // Reconnect / Page refresh: Pemain menyambung kembali ke sesi yang sama
    const ws2 = createClientSocket(wsUrl);
    await new Promise<void>((resolve) => ws2.once('open', () => resolve()));

    const ws2Messages: any[] = [];
    ws2.on('message', (data) => {
      ws2Messages.push(JSON.parse(data.toString()));
    });

    ws2.send(JSON.stringify({
      event: 'session_start',
      player: { uid: playerUid, nickname: 'GamerOne' },
      context: { market: 'ID', locale: 'id-ID', page: '/home' }
    }));

    // Tunggu session_started diterima
    await new Promise((r) => setTimeout(r, 600));

    // Pada reconnect, TIDAK boleh ada broadcast pesan proaktif baru
    const newGreetingOnReconnect = ws2Messages.filter((m) => m.event === 'message' && m.sender_type === 'bot');
    assert.strictEqual(newGreetingOnReconnect.length, 0, 'Tidak boleh mengirim ulang proactive greeting saat reconnect');

    // Periksa di DB: jumlah pesan tetap 1
    const dbCount = await db.getConversationMessageCount(convId);
    assert.strictEqual(dbCount, 1, 'Jumlah pesan di DB harus tetap tepat 1');
  });

  test('3. Greeting TIDAK PERNAH dikirim jika sesi sudah diambil alih agen manusia (agent_active)', async () => {
    const playerUid = 'player_proactive_agent_active';
    // Buat percakapan langsung dengan status agent_active
    const conv = await db.getOrCreateActiveConversation(
      { uid: playerUid },
      { market: 'ID', locale: 'id-ID', page: '/home' }
    );
    await db.updateConversationStatus(conv.id, 'agent_active');

    const wsUrl = `ws://127.0.0.1:${port}/v1/socket?token=token_${playerUid}`;
    const ws = createClientSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const msgs: any[] = [];
    ws.on('message', (data) => msgs.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({
      event: 'session_start',
      player: { uid: playerUid },
      context: { market: 'ID', locale: 'id-ID' }
    }));

    await new Promise((r) => setTimeout(r, 600));

    const greetings = msgs.filter((m) => m.event === 'message');
    assert.strictEqual(greetings.length, 0, 'Sesi agent_active tidak boleh memicu greeting bot proaktif');
  });

  test('4. Dilokalisasi untuk seluruh 6 locale dan menggunakan partikel gender persona yang benar di th-TH', () => {
    // a. th-TH dengan persona Mira (wanita -> ค่ะ)
    const thMira = generateProactiveGreeting({
      locale: 'th-TH',
      persona: 'mira',
      player: { nickname: 'Somchai' },
      pageContext: '/topup',
    });
    assert.ok(thMira.includes('Somchai'), 'Harus menyapa Somchai');
    assert.ok(thMira.includes('ค่ะ') || thMira.includes('คะ'), 'Mira harus menggunakan partikel kesopanan wanita (ค่ะ/คะ)');
    assert.ok(!thMira.includes('Halo'), 'Tidak boleh hardcode bahasa Indonesia di th-TH');

    // b. th-TH dengan persona Reza (pria -> ครับ)
    const thReza = generateProactiveGreeting({
      locale: 'th-TH',
      persona: 'reza',
      player: { nickname: 'Somchai' },
      pageContext: '/topup',
    });
    assert.ok(thReza.includes('ครับ'), 'Reza harus menggunakan partikel kesopanan pria (ครับ)');

    // c. en (English)
    const enGreeting = generateProactiveGreeting({
      locale: 'en',
      persona: 'mira',
      player: { nickname: 'Alex' },
      pageContext: '/home',
    });
    assert.ok(enGreeting.includes('Alex'), 'Menyapa Alex');
    assert.ok(enGreeting.includes('Welcome to Gaga Live Support'), 'Teks bahasa Inggris');

    // d. vi-VN (Vietnamese)
    const viGreeting = generateProactiveGreeting({
      locale: 'vi-VN',
      persona: 'mira',
      player: { nickname: 'Nguyen' },
      pageContext: '/topup',
    });
    assert.ok(viGreeting.includes('Nguyen'));
    assert.ok(viGreeting.includes('nạp') || viGreeting.includes('tiền'), 'Mengakui konteks nạp tiền');

    // e. fil-PH (Filipino)
    const filGreeting = generateProactiveGreeting({
      locale: 'fil-PH',
      persona: 'reza',
      player: { nickname: 'Juan' },
      pageContext: '/topup',
    });
    assert.ok(filGreeting.includes('Juan'));
    assert.ok(filGreeting.includes('top-up'));

    // f. ms-MY (Malay)
    const msGreeting = generateProactiveGreeting({
      locale: 'ms-MY',
      persona: 'mira',
      player: { nickname: 'Ahmad' },
      pageContext: '/topup',
    });
    assert.ok(msGreeting.includes('Ahmad'));
    assert.ok(msGreeting.includes('tambah nilai') || msGreeting.includes('top-up'));
  });

  test('5. Konteks halaman digunakan: Top-up page mengakui top-up, generic page netral', () => {
    const topupGreeting = generateProactiveGreeting({
      locale: 'id-ID',
      persona: 'mira',
      player: { nickname: 'Budi' },
      pageContext: { page: '/topup/diamonds' },
    });
    assert.ok(topupGreeting.includes('top-up') || topupGreeting.includes('diamond'), 'Harus menyinggung transaksi topup');

    const genericGreeting = generateProactiveGreeting({
      locale: 'id-ID',
      persona: 'mira',
      player: { nickname: 'Budi' },
      pageContext: { page: '/settings' },
    });
    assert.ok(genericGreeting.includes('Selamat datang'), 'Halaman umum harus memakai sapaan netral/ramah');
    assert.ok(!genericGreeting.includes('transaksi top-up'), 'Halaman umum tidak boleh berasumsi topup');
  });

  test('6. Varian mode luar jam (after_hours) mengambil alih prioritas (spec/07-mode-luar-jam.md)', () => {
    // Bahkan jika pemain membuka dari halaman topup, mode luar jam wajib mengambil alih
    const afterHoursGreeting = generateProactiveGreeting({
      locale: 'id-ID',
      persona: 'mira',
      player: { nickname: 'RyuHunter' },
      pageContext: { page: '/topup' },
      serviceMode: 'after_hours',
      afterHoursInfo: { next_open_time: '09.00', city: 'Jakarta' },
    });

    assert.ok(afterHoursGreeting.includes('sedang tidak bertugas'), 'Harus menyatakan tim support offline secara jujur');
    assert.ok(afterHoursGreeting.includes('09.00'), 'Harus menginformasikan jam buka');
    assert.ok(afterHoursGreeting.includes('Jakarta'), 'Harus menginformasikan kota pasar');
    assert.ok(afterHoursGreeting.includes('tiket'), 'Harus menawarkan pembuatan tiket');
  });
});
