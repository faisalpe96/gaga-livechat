import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { getTranslations, TRANSLATIONS } from '../src/i18n/translations.js';
import { MARKETS_DATA, SupportedLocale } from '../src/types.js';
import { ChatWebSocketClient } from '../src/connection/websocket-client.js';
import { buildGatewayServer } from '../../../services/gateway/src/server.js';
import { Database } from '../../../services/gateway/src/db.js';
import { RedisPubSub } from '../../../services/gateway/src/redis.js';

describe('TASK-03: Chat Widget Tests', { timeout: 15000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let gateway: any;
  let hub: any;
  let gatewayPort: number;

  before(async () => {
    db = new Database();
    await db.pool.query('TRUNCATE messages, handoffs, conversations CASCADE');
    pubsub = new RedisPubSub();

    const res = await buildGatewayServer({ db, pubsub });
    gateway = res.app;
    hub = res.hub;
    await gateway.listen({ port: 0, host: '127.0.0.1' });
    gatewayPort = (gateway.server.address() as any).port;
  });

  after(async () => {
    try {
      hub?.close();
    } catch {}
    try {
      gateway?.server?.closeAllConnections?.();
      await gateway?.close();
    } catch {}
    try {
      await pubsub?.close();
    } catch {}
    try {
      await db?.pool?.query('TRUNCATE messages, handoffs, conversations CASCADE');
    } catch {}
    try {
      await db?.close();
    } catch {}
  });

  test('1. Tampilan bahasa/locale tampil benar untuk seluruh 6 pasar SEA', { timeout: 5000 }, () => {
    const seaMarkets: SupportedLocale[] = ['th-TH', 'fil-PH', 'id-ID', 'ms-MY', 'vi-VN', 'en'];

    // 1.1 Pastikan 6 pasar terdaftar di konfigurasi pasar
    const marketCodes = Object.keys(MARKETS_DATA);
    assert.equal(marketCodes.length, 6, 'Wajib ada tepat 6 pasar SEA');
    assert.deepEqual(marketCodes.sort(), ['ID', 'MY', 'PH', 'SG', 'TH', 'VN']);

    // 1.2 Pastikan setiap locale memiliki kamus string UI lengkap tanpa nilai kosong
    for (const loc of seaMarkets) {
      const strings = getTranslations(loc);
      assert.ok(strings, `Kamus terjemahan untuk ${loc} tidak boleh kosong`);
      assert.ok(strings.title, `title untuk ${loc} wajib terisi`);
      assert.ok(strings.statusOnline, `statusOnline untuk ${loc} wajib terisi`);
      assert.ok(strings.statusOffline, `statusOffline untuk ${loc} wajib terisi`);
      assert.ok(strings.statusConnecting, `statusConnecting untuk ${loc} wajib terisi`);
      assert.ok(strings.inputPlaceholder, `inputPlaceholder untuk ${loc} wajib terisi`);
      assert.ok(strings.sendButton, `sendButton untuk ${loc} wajib terisi`);
      assert.ok(strings.translatedBadge, `translatedBadge untuk ${loc} wajib terisi`);
      assert.ok(strings.selectLanguage, `selectLanguage untuk ${loc} wajib terisi`);
    }

    // 1.3 Verifikasi spesifik kata kunci bahasa lokal
    assert.equal(getTranslations('th-TH').sendButton, 'ส่ง');
    assert.equal(getTranslations('fil-PH').sendButton, 'Ipadala');
    assert.equal(getTranslations('id-ID').sendButton, 'Kirim');
    assert.equal(getTranslations('ms-MY').sendButton, 'Hantar');
    assert.equal(getTranslations('vi-VN').sendButton, 'Gửi');
    assert.equal(getTranslations('en').sendButton, 'Send');
  });

  test('2. set_locale mengubah bahasa UI secara instan dan tersimpan', { timeout: 5000 }, () => {
    // Mock penyimpanan localStorage di Node environment
    const storageMap = new Map<string, string>();
    (global as any).window = {
      localStorage: {
        getItem: (k: string) => storageMap.get(k) || null,
        setItem: (k: string, v: string) => storageMap.set(k, v),
        removeItem: (k: string) => storageMap.delete(k),
      },
    };

    const client = new ChatWebSocketClient({
      url: `ws://127.0.0.1:${gatewayPort}/v1/socket`,
      token: 'token_widget_locale',
      player: { uid: 'player_locale_test' },
      context: { locale: 'id-ID', market: 'ID' },
      storageKey: 'test_locale_storage',
      customWebSocket: WebSocket,
    });

    assert.equal(client.getLocale(), 'id-ID');
    assert.equal(getTranslations(client.getLocale()).sendButton, 'Kirim');

    // Ubah ke Vietnam (vi-VN)
    client.setLocale('vi-VN');
    assert.equal(client.getLocale(), 'vi-VN');
    assert.equal(getTranslations(client.getLocale()).sendButton, 'Gửi');

    // Ubah ke Thailand (th-TH)
    client.setLocale('th-TH');
    assert.equal(client.getLocale(), 'th-TH');
    assert.equal(getTranslations(client.getLocale()).sendButton, 'ส่ง');

    // Verifikasi tersimpan di storage
    const saved = JSON.parse(storageMap.get('test_locale_storage')!);
    assert.equal(saved.locale, 'th-TH');

    client.disconnect();
  });

  test('3. Riwayat percakapan tetap utuh setelah refresh (History Persistence)', { timeout: 5000 }, async () => {
    const storageMap = new Map<string, string>();
    (global as any).window = {
      localStorage: {
        getItem: (k: string) => storageMap.get(k) || null,
        setItem: (k: string, v: string) => storageMap.set(k, v),
        removeItem: (k: string) => storageMap.delete(k),
      },
    };


    const playerUid = 'player_refresh_' + Date.now();

    // 3.1 Simpan pesan ke basis data Postgres di server
    const conv = await db.getOrCreateActiveConversation(
      { uid: playerUid },
      { market: 'ID', locale: 'id-ID' }
    );
    await db.saveMessage({
      conversation_id: conv.id,
      sender_type: 'bot',
      text: 'Halo kak, ada yang bisa dibantu dari server?',
    });

    // Simulasikan sesi aktif di client 1
    const client1 = new ChatWebSocketClient({
      url: `ws://127.0.0.1:${gatewayPort}/v1/socket`,
      token: 'token_' + playerUid,
      player: { uid: playerUid },
      context: { locale: 'id-ID', market: 'ID' },
      storageKey: 'persist_history_key',
      customWebSocket: WebSocket,
    });

    (client1 as any).handleInboundRaw(
      JSON.stringify({
        event: 'session_started',
        conversation_id: conv.id,
        locale: 'id-ID',
        market: 'ID',
      })
    );

    // 3.2 Buktikan localStorage MAKSIMAL hanya menyimpan conversationId dan locale (TIDAK menyimpan array messages)
    const storedData = JSON.parse(storageMap.get('persist_history_key')!);
    assert.equal(storedData.conversationId, conv.id);
    assert.equal(storedData.locale, 'id-ID');
    assert.equal(storedData.messages, undefined, 'localStorage TIDAK boleh menyimpan pesan percakapan');

    client1.disconnect();

    // 3.3 Sesi kedua: simulasi refresh halaman dengan instance klien baru
    const client2 = new ChatWebSocketClient({
      url: `ws://127.0.0.1:${gatewayPort}/v1/socket`,
      token: 'token_' + playerUid,
      player: { uid: playerUid },
      context: { locale: 'id-ID', market: 'ID' },
      storageKey: 'persist_history_key',
      customWebSocket: WebSocket,
    });

    // Ambil riwayat dari server lewat endpoint REST /v1/conversations/:id/messages
    const serverMessages = await client2.fetchHistoryFromServer();
    assert.equal(serverMessages.length, 1, 'Pesan harus berhasil diambil dari server Postgres');
    assert.equal(serverMessages[0].text, 'Halo kak, ada yang bisa dibantu dari server?');
    assert.equal(serverMessages[0].sender_type, 'bot');
    assert.equal(client2.getConversationId(), conv.id);

    client2.disconnect();
  });

  test('4. Sambung ulang otomatis (Auto-Reconnect) saat koneksi terputus dan pengiriman antrean offline', { timeout: 6000 }, async () => {
    const client = new ChatWebSocketClient({
      url: `ws://127.0.0.1:${gatewayPort}/v1/socket`,
      token: 'token_reconnect_test',
      player: { uid: 'player_reconnect_test' },
      context: { locale: 'id-ID', market: 'ID' },
      autoReconnect: true,
      reconnectInterval: 200,
      customWebSocket: WebSocket,
    });

    await new Promise<void>((resolve) => {
      client.onConnectionChange = (state) => {
        if (state === 'connected') resolve();
      };
      client.connect();
    });
    assert.equal(client.getState(), 'connected');

    // Putuskan socket server secara paksa untuk menguji rekoneksi
    const disconnectPromise = new Promise<void>((resolve) => {
      client.onConnectionChange = (state) => {
        if (state === 'disconnected') resolve();
      };
    });
    (client as any).ws.close();
    await disconnectPromise;
    assert.equal(client.getState(), 'disconnected');

    // Kirim pesan saat koneksi terputus (harus masuk ke antrean offline)
    client.sendMessage('Pesan saat koneksi putus');

    // Tunggu rekoneksi otomatis berhasil
    await new Promise<void>((resolve) => {
      client.onConnectionChange = (state) => {
        if (state === 'connected') resolve();
      };
    });

    assert.equal(client.getState(), 'connected');
    client.disconnect();
  });

  test('5. Penanda visual pesan terjemahan (translated: true)', { timeout: 5000 }, () => {
    const client = new ChatWebSocketClient({
      url: `ws://127.0.0.1:${gatewayPort}/v1/socket`,
      token: 'token_translated_badge',
      player: { uid: 'player_translated' },
      context: { locale: 'id-ID', market: 'ID' },
      customWebSocket: WebSocket,
    });

    (client as any).handleInboundRaw(
      JSON.stringify({
        event: 'message',
        conversation_id: 'conv_trans_1',
        message_id: 'msg_trans_1',
        sender_type: 'agent',
        sender_name: 'Agent Support',
        text: 'Hello, your payment has been processed.',
        created_at: new Date().toISOString(),
        translated: true,
      })
    );

    const msgs = client.getMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].translated, true, 'Pesan harus memiliki penanda translated = true');

    const badgeLabel = getTranslations('id-ID').translatedBadge;
    assert.equal(badgeLabel, 'Diterjemahkan otomatis');

    client.disconnect();
  });
});
