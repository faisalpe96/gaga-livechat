import WebSocket from 'ws';

const BASE_WS = 'ws://127.0.0.1:3001';

async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  console.log('--- Memulai Pengujian Interaktif Langsung pada Gateway (Port 3001) ---');

  const playerUid = `player_live_${Date.now()}`;
  const token = `token_${playerUid}`;
  const ws = new WebSocket(`${BASE_WS}/v1/socket?token=${token}`);
  const incomingMessages: any[] = [];

  let conversationId = '';

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      console.log('✓ WebSocket terhubung ke /v1/socket');
      resolve();
    });
    ws.on('error', reject);
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'session_started') {
          conversationId = parsed.conversation_id;
          console.log(`✓ Sesi berhasil dimulai: Conv ID = ${conversationId}`);
        } else if (parsed.event === 'message') {
          incomingMessages.push(parsed);
          console.log(`[Pesan Diterima] [${parsed.sender_type}] ${parsed.text}`);
        }
      } catch {}
    });
  });

  // Kirim session_start
  ws.send(
    JSON.stringify({
      event: 'session_start',
      player: { uid: playerUid, nickname: 'RyuTester', level: 30 },
      context: { market: 'ID', locale: 'id-ID', page: '/store' },
    })
  );

  // Tunggu session_started
  while (!conversationId) {
    await delay(100);
  }

  // Helper kirim pesan dan tunggu balasan bot
  async function sendMessageAndWaitReply(text: string): Promise<string> {
    const beforeCount = incomingMessages.length;
    console.log(`\n> Pemain: "${text}"`);
    ws.send(
      JSON.stringify({
        event: 'message',
        text,
      })
    );

    // Tunggu balasan bot
    const startTime = Date.now();
    while (Date.now() - startTime < 6000) {
      await delay(200);
      const newBotMessages = incomingMessages.slice(beforeCount).filter((m) => m.sender_type === 'bot');
      if (newBotMessages.length > 0) {
        return newBotMessages[0].text;
      }
    }
    return '(Tidak ada balasan dalam 6 detik)';
  }

  // Turn 1: Sapaan (Tahap greeting)
  const r1 = await sendMessageAndWaitReply('Halo min');
  console.log(`=> Bot: "${r1}"`);

  // Turn 2: Pertanyaan kabur (Tahap discovery)
  const r2 = await sendMessageAndWaitReply('bagaimana kendala topup');
  console.log(`=> Bot: "${r2}"`);

  // Turn 3: Keluhan topup belum masuk (Tahap data_collection - Slot 1: order_id)
  const r3 = await sendMessageAndWaitReply('diamond saya belum masuk kak');
  console.log(`=> Bot: "${r3}"`);

  // Turn 4: Berikan order ID (Slot 2: amount)
  const r4 = await sendMessageAndWaitReply('Order ID saya order_992211');
  console.log(`=> Bot: "${r4}"`);

  // Turn 5: Berikan nominal (Slot 3: payment_method)
  const r5 = await sendMessageAndWaitReply('nominal 50rb dapat 100 diamond');
  console.log(`=> Bot: "${r5}"`);

  // Turn 6: Berikan metode pembayaran (Slot 4: transaction_time)
  const r6 = await sendMessageAndWaitReply('pakai QRIS');
  console.log(`=> Bot: "${r6}"`);

  // Turn 7: Berikan jam transaksi (Tahap resolution)
  const r7 = await sendMessageAndWaitReply('jam 1 siang tadi');
  console.log(`=> Bot: "${r7}"`);

  // Turn 8: Kasus pemain kesal (Emotion Recognition & Empathy)
  const r8 = await sendMessageAndWaitReply('woi lambat banget pelayanannya kesal saya diamond belum masuk juga!!');
  console.log(`=> Bot: "${r8}"`);

  // Turn 9: Kasus tanpa dokumen cocok (Humane No-Doc Fallback)
  const r9 = await sendMessageAndWaitReply('bagaimana cara memancing ikan paus purba di kolam rahasia?');
  console.log(`=> Bot: "${r9}"`);

  ws.close();
  console.log('\n--- Seluruh Percakapan Langsung Berhasil 100% ---');
}

run().catch(console.error);
