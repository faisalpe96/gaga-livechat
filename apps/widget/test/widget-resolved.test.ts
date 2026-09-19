import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocketClient } from '../src/connection/websocket-client.js';

/**
 * Alur "percakapan ditutup (resolved)":
 * pesan berikutnya dari pemain harus membuka sesi baru, bukan ditelan.
 * Tanpa server — socket palsu merekam apa yang dikirim widget.
 */

function makeClient() {
  const sent: any[] = [];
  const fakeWs = {
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: () => {},
  };
  const client = new ChatWebSocketClient({
    url: 'ws://127.0.0.1:1/v1/socket',
    token: 'token_test',
    player: { uid: 'p1' },
    context: { locale: 'id-ID', market: 'ID' },
    storageKey: 'resolved_test_key',
    customWebSocket: function () {} as any,
  });
  (client as any).ws = fakeWs;
  (client as any).state = 'connected';
  // Tanpa server: riwayat kosong. Pesan tertunda dikirim setelah promise ini selesai.
  (client as any).fetchHistoryFromServer = async () => [];
  const inbound = async (obj: any) => {
    (client as any).handleInboundRaw(JSON.stringify(obj));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { client, sent, inbound };
}

describe('Widget: percakapan resolved membuka sesi baru', () => {
  test('status_change resolved → pesan berikutnya memicu session_start, lalu terkirim ke percakapan baru', async () => {
    const { client, sent, inbound } = makeClient();
    await inbound({ event: 'session_started', conversation_id: 'conv-lama', locale: 'id-ID', market: 'ID' });

    client.sendMessage('pesan pertama');
    assert.equal(sent.at(-1).event, 'message');
    assert.equal(sent.at(-1).conversation_id, 'conv-lama');

    const received: any[] = [];
    client.onMessage = (m) => received.push(m);
    await inbound({ event: 'status_change', conversation_id: 'conv-lama', new_status: 'resolved' });

    // Pemain diberi tahu lewat pesan sistem berbahasa sesuai locale
    assert.equal(received.length, 1);
    assert.equal(received[0].sender_type, 'system');
    assert.equal(received[0].text, 'Sesi percakapan telah ditutup.');

    sent.length = 0;
    client.sendMessage('pesan setelah ditutup');
    // Tidak dikirim ke percakapan lama; yang dikirim adalah session_start
    assert.deepEqual(sent.map((s) => s.event), ['session_start']);
    assert.equal(client.getConversationId(), null);

    await inbound({ event: 'session_started', conversation_id: 'conv-baru', locale: 'id-ID', market: 'ID' });
    const msg = sent.find((s) => s.event === 'message');
    assert.ok(msg, 'pesan tertunda harus dikirim setelah session_started');
    assert.equal(msg.conversation_id, 'conv-baru');
    assert.equal(msg.text, 'pesan setelah ditutup');
    assert.equal(client.getConversationId(), 'conv-baru');
  });

  test('error CONVERSATION_RESOLVED dari server → sesi baru dan pesan terakhir dikirim ulang', async () => {
    const { client, sent, inbound } = makeClient();
    await inbound({ event: 'session_started', conversation_id: 'conv-lama', locale: 'id-ID', market: 'ID' });

    client.sendMessage('halo, ada yang bisa dibantu?');
    sent.length = 0;
    // Widget tidak sempat menerima status_change; server menolak pesan
    await inbound({ event: 'error', code: 'CONVERSATION_RESOLVED', message: 'Percakapan sudah ditutup.' });
    assert.deepEqual(sent.map((s) => s.event), ['session_start']);

    await inbound({ event: 'session_started', conversation_id: 'conv-baru', locale: 'id-ID', market: 'ID' });
    const msg = sent.find((s) => s.event === 'message');
    assert.ok(msg, 'pesan yang ditolak harus dikirim ulang ke percakapan baru');
    assert.equal(msg.conversation_id, 'conv-baru');
    assert.equal(msg.text, 'halo, ada yang bisa dibantu?');
  });

  test('error lain tidak memicu sesi baru', async () => {
    const { client, sent, inbound } = makeClient();
    await inbound({ event: 'session_started', conversation_id: 'conv-1', locale: 'id-ID', market: 'ID' });
    sent.length = 0;
    let reported: Error | null = null;
    client.onError = (e: any) => (reported = e);
    await inbound({ event: 'error', code: 'MISSING_CONVERSATION_ID', message: 'x' });
    assert.equal(sent.length, 0);
    assert.ok(reported);
    assert.equal(client.getConversationId(), 'conv-1');
  });
});
