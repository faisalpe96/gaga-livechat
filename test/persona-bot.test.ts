import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildGatewayServer } from '../services/gateway/src/server.js';
import { Database } from '../services/gateway/src/db.js';
import { RedisPubSub } from '../services/gateway/src/redis.js';
import { WebSocketHub } from '../services/gateway/src/websocket-hub.js';
import { getToneGuide, buildSystemPrompt } from '../services/orchestrator/src/prompts/system-prompt.js';

describe('SPEC-08: Bot Persona Tests', { timeout: 30000 }, () => {
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

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    // Ensure initial setup
    await db.ensureBotPersonasTable();
    await db.pool.query("UPDATE markets SET is_bot_enabled = true WHERE code = 'ID'");

    const res = await buildGatewayServer({ db, pubsub });
    gatewayApp = res.app;
    hub = res.hub;

    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    port = (gatewayApp.server.address() as any).port;
  });

  after(async () => {
    for (const ws of clientSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    try { hub?.close(); } catch {}
    try { gatewayApp?.server?.closeAllConnections?.(); await gatewayApp?.close(); } catch {}
    try { await pubsub?.close(); } catch {}
    try { await db?.close(); } catch {}
  });

  test('1. Persona tersimpan di conversations.bot_persona saat sesi dibuka dan tidak berubah setelah 10 pesan berturut-turut', async () => {
    const ws = createClientSocket(`ws://127.0.0.1:${port}/v1/socket?token=token_77124490`);

    let convId = '';
    let assignedPersona = '';

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          event: 'session_start',
          player: { uid: 'player_persona_test_' + Date.now() },
          context: { locale: 'id-ID', market: 'ID' }
        }));
      });

      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.event === 'session_started') {
          convId = data.conversation_id;
          assignedPersona = data.bot_persona;
          resolve();
        }
      });

      ws.on('error', reject);
    });

    assert.ok(convId, 'conversation_id harus ada');
    assert.ok(assignedPersona === 'mira' || assignedPersona === 'reza', 'bot_persona harus mira atau reza');

    // Cek di database
    const initialDb = await db.getConversation(convId);
    assert.equal(initialDb?.bot_persona, assignedPersona, 'bot_persona di DB harus cocok dengan session_started');

    // Kirim 10 pesan berturut-turut
    for (let i = 1; i <= 10; i++) {
      await new Promise<void>((resolve) => {
        const handler = (raw: any) => {
          const data = JSON.parse(raw.toString());
          if (data.event === 'message' && data.text === `Pesan uji ke-${i}`) {
            ws.off('message', handler);
            resolve();
          }
        };
        ws.on('message', handler);

        ws.send(JSON.stringify({
          event: 'message',
          conversation_id: convId,
          text: `Pesan uji ke-${i}`
        }));
      });

      // Verifikasi di DB nilainya TIDAK PERNAH berubah
      const checkConv = await db.getConversation(convId);
      assert.equal(
        checkConv?.bot_persona,
        assignedPersona,
        `bot_persona tidak boleh berubah setelah pesan ke-${i} (harus tetap ${assignedPersona})`
      );
    }
  });

  test('2. Avatar tampil di widget dan panel agent tanpa 404', async () => {
    const avatarPaths = [
      '/assets/agent-mira.png',
      '/assets/agent-reza.png',
      '/agent-mira.png',
      '/agent-reza.png'
    ];

    for (const p of avatarPaths) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(
        res.status,
        200,
        `Endpoint avatar ${p} wajib mengembalikan status HTTP 200 tanpa 404`
      );
      assert.equal(
        res.headers.get('content-type'),
        'image/png',
        `Endpoint ${p} harus bertipe image/png`
      );
    }
  });

  test('3. tone_guide untuk th-TH menghasilkan partikel yang sesuai gender persona (ครับ untuk reza, ค่ะ untuk mira)', () => {
    // 3.1 Persona Reza (Pria)
    const toneReza = getToneGuide('th-TH', 'reza');
    assert.ok(toneReza.includes('ครับ'), 'tone_guide untuk persona Reza wajib memakai partikel pria ครับ');
    assert.ok(toneReza.includes('DILARANG KERAS menggunakan ค่ะ'), 'tone_guide untuk Reza harus melarang ค่ะ');

    // 3.2 Persona Mira (Wanita)
    const toneMira = getToneGuide('th-TH', 'mira');
    assert.ok(toneMira.includes('ค่ะ'), 'tone_guide untuk persona Mira wajib memakai partikel wanita ค่ะ');
    assert.ok(toneMira.includes('DILARANG KERAS menggunakan ครับ'), 'tone_guide untuk Mira harus melarang ครับ');
  });

  test('4. Locale yang belum punya baris di bot_personas jatuh ke nama default dan mencatat peringatan', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.join(' '));
      originalWarn(...args);
    };

    try {
      // Panggil getBotPersona untuk locale antah berantah 'xx-YY'
      const fallbackMira = await db.getBotPersona('mira', 'xx-YY');
      assert.equal(fallbackMira.display_name, 'Mira', 'Fallback persona mira harus bernama Mira');
      assert.equal(fallbackMira.avatar_url, '/assets/agent-mira.png');

      const fallbackReza = await db.getBotPersona('reza', 'xx-YY');
      assert.equal(fallbackReza.display_name, 'Reza', 'Fallback persona reza harus bernama Reza');
      assert.equal(fallbackReza.avatar_url, '/assets/agent-reza.png');

      assert.ok(warnings.length >= 2, 'Wajib mencatat peringatan console.warn untuk locale yang belum terdaftar');
      assert.ok(warnings.some(w => w.includes('xx-YY')), 'Peringatan harus menyebutkan locale yang hilang');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('5. Saat sesi beralih ke agent_active, identitas yang tampil berganti menjadi agent manusia', async () => {
    const agentRes = await db.pool.query(`SELECT id, name FROM agents LIMIT 1`);
    assert.ok(agentRes.rows.length > 0, 'Harus ada agent terdaftar');
    const agent = agentRes.rows[0];

    const player = { uid: 'player_handoff_persona_' + Date.now() };
    const conv = await db.getOrCreateActiveConversation(player, { locale: 'id-ID', market: 'ID' });

    const ws = createClientSocket(`ws://127.0.0.1:${port}/v1/socket?token=token_77124490&conversation_id=${conv.id}`);

    let systemTransitionReceived = false;

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        hub.joinRoom(conv.id, ws);
        resolve();
      });
    });

    const msgPromise = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.event === 'message' && data.sender_type === 'system' && data.text.includes(agent.name)) {
          systemTransitionReceived = true;
          resolve();
        }
      });
    });

    // Jalankan eskalasi / claim agen ke agent_active
    await db.updateConversationStatus(conv.id, 'handoff_queued');
    await db.claimConversationAtomic(conv.id, agent.id);
    await hub.broadcastStatusChange(conv.id, 'handoff_queued', 'agent_active');

    await msgPromise;
    assert.ok(systemTransitionReceived, `Pesan sistem peralihan ke agen ${agent.name} harus disiarkan ke pemain`);

    // Agent mengirim pesan
    const agentMsgPromise = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.event === 'message' && data.sender_type === 'agent') {
          assert.equal(data.sender_name, agent.name, 'Identitas pengirim wajib memakai nama agent manusia');
          resolve();
        }
      });
    });

    await hub.broadcastMessage(conv.id, {
      id: 'test-agent-msg-' + Date.now(),
      sender_type: 'agent',
      sender_id: agent.id,
      sender_name: agent.name,
      text: 'Halo, saya agen manusia yang mengambil alih bantuan ini.',
      created_at: new Date()
    });

    await agentMsgPromise;
  });

  test('6. Kejujuran Identitas (Aturan Terkunci): System prompt memuat kewajiban menjawab jujur jika ditanya apakah bot', () => {
    const prompt = buildSystemPrompt('id-ID', 'mira');
    assert.ok(prompt.includes('KEJUJURAN IDENTITAS (MUTLAK TERKUNCI'), 'System prompt wajib memiliki aturan kejujuran identitas terkunci');
    assert.ok(prompt.includes('WAJIB menjawab jujur bahwa kamu adalah asisten otomatis'), 'Bot wajib mengaku asisten otomatis jika ditanya');
    assert.ok(prompt.includes('DILARANG berbohong atau mengklaim diri sebagai manusia'), 'Bot dilarang berbohong menjadi manusia jika ditanya langsung');
  });
});
