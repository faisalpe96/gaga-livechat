import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';

describe('TASK-11: AI Studio Console & Governance Tests', { timeout: 20000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let gatewayApp: any;

  const mockOrchestrator = {
    process: async (req: any) => {
      const msg = req.history?.[req.history.length - 1]?.text || '';

      // Simulasi pemicu keras
      if (msg.toLowerCase().includes('refund')) {
        return {
          action: 'handoff',
          reason: 'refund',
          bot_summary: 'Pemain menuntut pengembalian dana transaksi.',
          meta: {
            intent: 'refund',
            confidence: 1.0,
            sources: [],
            tools_used: [],
            locale_out: req.locale || 'en',
            guardrail_flags: ['refund'],
          },
        };
      }

      if (msg.toLowerCase().includes('bunuh diri')) {
        return {
          action: 'handoff',
          reason: 'bahaya_diri',
          bot_summary: 'Pemain mengindikasikan bahaya diri sendiri.',
          meta: {
            intent: 'bahaya_diri',
            confidence: 1.0,
            sources: [],
            tools_used: [],
            locale_out: req.locale || 'id-ID',
            guardrail_flags: ['bahaya_diri'],
          },
        };
      }

      return {
        action: 'reply',
        text: `Jawaban simulasi bot untuk: ${msg}`,
        meta: {
          intent: 'faq_gacha',
          confidence: 0.94,
          sources: ['faq_topup_guide'],
          tools_used: ['check_server_status'],
          locale_out: req.locale || 'en',
          guardrail_flags: [],
        },
      };
    },
  };

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    const res = await buildGatewayServer({
      db,
      pubsub,
      orchestrator: mockOrchestrator,
    });
    gatewayApp = res.app;
  });

  after(async () => {
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

  test('1. Kriteria Terima Mutlak: Seluruh aturan terkunci DITOLAK di level API (HTTP 403)', async () => {
    // 1. Ambil daftar aturan
    const rulesRes = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/rules',
    });
    assert.equal(rulesRes.statusCode, 200);
    const rulesData = JSON.parse(rulesRes.payload);

    const lockedKeys = [
      'no_promise',
      'auth_verification',
      'internal_sources_only',
      'confidence_threshold',
    ];

    // Pastikan 4 aturan terkunci ada dan berstatus locked: true
    for (const key of lockedKeys) {
      const found = rulesData.rules.find((r: any) => r.key === key);
      assert.ok(found, `Aturan terkunci '${key}' harus terdaftar`);
      assert.equal(found.locked, true, `Aturan '${key}' wajib berstatus locked: true`);
      assert.equal(found.enabled, true, `Aturan '${key}' wajib berstatus enabled: true`);
    }

    // 2. PEMBUKTIAN PENOLAKAN DI LEVEL API:
    // Mencoba mematikan setiap aturan terkunci via PATCH /v1/studio/rules/:key
    for (const key of lockedKeys) {
      const patchRes = await gatewayApp.inject({
        method: 'PATCH',
        url: `/v1/studio/rules/${key}`,
        payload: { enabled: false },
      });

      assert.equal(
        patchRes.statusCode,
        403,
        `Pelanggaran: Mengubah aturan terkunci '${key}' via API harus ditolak dengan status HTTP 403 Forbidden!`
      );

      const errData = JSON.parse(patchRes.payload);
      assert.equal(errData.code, 'LOCKED_RULE_IMMUTABLE');
      assert.equal(errData.rule_key, key);
      assert.ok(
        errData.error.includes('TERKUNCI'),
        'Pesan kesalahan wajib menyatakan bahwa aturan berstatus TERKUNCI'
      );
    }
  });

  test('2. Aturan operasional dinamis dapat diubah via API (HTTP 200)', async () => {
    // Ubah aturan yang tidak terkunci
    const patchRes = await gatewayApp.inject({
      method: 'PATCH',
      url: '/v1/studio/rules/suggest_faq_followup',
      payload: { enabled: false },
    });

    assert.equal(patchRes.statusCode, 200);
    const updated = JSON.parse(patchRes.payload);
    assert.equal(updated.key, 'suggest_faq_followup');
    assert.equal(updated.enabled, false);

    // Kembalikan ke enabled: true
    const restoreRes = await gatewayApp.inject({
      method: 'PATCH',
      url: '/v1/studio/rules/suggest_faq_followup',
      payload: { enabled: true },
    });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal(JSON.parse(restoreRes.payload).enabled, true);
  });

  test('3. Metrik per Locale: Menghitung volume, containment, CSAT, dan tingkat pemakaian draf tanpa edit', async () => {
    const res = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/metrics',
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.payload);

    assert.ok(data.generated_at);
    assert.ok(Array.isArray(data.metrics));
    assert.equal(data.metrics.length, 6, 'Harus mencakup seluruh 6 pasar regional SEA');

    // Cek struktur metrik item
    const first = data.metrics[0];
    assert.ok(first.locale);
    assert.ok(first.market);
    assert.ok(typeof first.total_conversations === 'number');
    assert.ok(typeof first.contained_conversations === 'number');
    assert.ok(typeof first.containment_rate_percentage === 'number');
    assert.ok(typeof first.csat_score === 'number');
    assert.ok(typeof first.unedited_rate_percentage === 'number');
    assert.ok(typeof first.auto_reply_eligible === 'boolean');

    // Cek ringkasan global
    assert.ok(data.summary);
    assert.ok(typeof data.summary.total_volume === 'number');
    assert.ok(typeof data.summary.avg_containment_rate === 'number');
    assert.ok(typeof data.summary.avg_csat === 'number');
    assert.ok(typeof data.summary.avg_unedited_rate === 'number');
  });

  test('4. Sumber Pengetahuan (Knowledge Base): Menampilkan dokumen, status review, dan indeks embedding', async () => {
    const res = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/knowledge-base',
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.payload);

    assert.ok(data.count > 0);
    assert.ok(Array.isArray(data.documents));
    assert.ok(Array.isArray(data.canned_responses));

    // Verifikasi dokumen KB
    const doc = data.documents[0];
    assert.ok(doc.doc_key);
    assert.ok(doc.locale);
    assert.ok(doc.title);
    assert.ok(typeof doc.is_policy === 'boolean');
    assert.ok(typeof doc.has_embedding === 'boolean');

    // Uji filter query per locale
    const filteredRes = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/knowledge-base?locale=th-TH&is_policy=true',
    });
    const filteredData = JSON.parse(filteredRes.payload);
    for (const d of filteredData.documents) {
      assert.equal(d.locale, 'th-TH');
      assert.equal(d.is_policy, true);
    }
  });

  test('5. Status Kelengkapan Pagar Pengaman: Memverifikasi 6 bahasa dan deteksi frasa wajib', async () => {
    const res = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/guardrails/status',
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.payload);

    assert.ok(data.checked_at);
    assert.equal(data.locales.length, 6);

    for (const loc of data.locales) {
      assert.ok(['id-ID', 'th-TH', 'vi-VN', 'fil-PH', 'ms-MY', 'en'].includes(loc.locale));
      assert.ok(typeof loc.phrase_count === 'number');
      assert.ok(typeof loc.has_self_harm === 'boolean');
      assert.ok(typeof loc.has_ask_human === 'boolean');
      assert.ok(Array.isArray(loc.missing_hard_triggers));
      assert.ok(['healthy', 'warning', 'critical'].includes(loc.status));
    }
  });

  test('6. Katalog Pemicu Handoff: Mengembalikan daftar pemicu keras & lunak beserta statistik', async () => {
    const res = await gatewayApp.inject({
      method: 'GET',
      url: '/v1/studio/handoff-triggers',
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.payload);

    // Verifikasi Pemicu Keras
    assert.ok(data.hard_triggers.length >= 6);
    const hardKeys = data.hard_triggers.map((h: any) => h.key);
    assert.ok(hardKeys.includes('akun_terkunci'));
    assert.ok(hardKeys.includes('refund'));
    assert.ok(hardKeys.includes('bahaya_diri'));

    // Verifikasi Pemicu Lunak
    assert.ok(data.soft_triggers.length >= 5);
    const softKeys = data.soft_triggers.map((s: any) => s.key);
    assert.ok(softKeys.includes('minta_manusia'));
    assert.ok(softKeys.includes('keyakinan_rendah'));

    assert.ok(Array.isArray(data.statistics));
  });

  test('7. Ruang Uji Coba (Playground Simulator): Menjalankan dry-run pipeline dan mendeteksi pemicu', async () => {
    // 7.1 Pertanyaan normal -> Menghasilkan REPLY
    const normalSim = await gatewayApp.inject({
      method: 'POST',
      url: '/v1/studio/playground/simulate',
      payload: {
        message: 'Berapa peluang mendapatkan karakter SSR?',
        locale: 'id-ID',
      },
    });
    assert.equal(normalSim.statusCode, 200);
    const normalData = JSON.parse(normalSim.payload);
    assert.equal(normalData.result.action, 'reply');
    assert.equal(normalData.diagnostics.is_hard_trigger, false);
    assert.ok(normalData.result.text.includes('Jawaban simulasi bot'));

    // 7.2 Pesan pemicu refund -> Langsung HANDOFF instan
    const refundSim = await gatewayApp.inject({
      method: 'POST',
      url: '/v1/studio/playground/simulate',
      payload: {
        message: 'Saya minta refund atas transaksi kemarin!',
        locale: 'id-ID',
      },
    });
    assert.equal(refundSim.statusCode, 200);
    const refundData = JSON.parse(refundSim.payload);
    assert.equal(refundData.result.action, 'handoff');
    assert.equal(refundData.diagnostics.is_hard_trigger, true);
    assert.equal(refundData.diagnostics.triggered_rule, 'refund');

    // 7.3 Validasi pesan kosong
    const emptySim = await gatewayApp.inject({
      method: 'POST',
      url: '/v1/studio/playground/simulate',
      payload: { message: '   ', locale: 'en' },
    });
    assert.equal(emptySim.statusCode, 400);
    assert.equal(JSON.parse(emptySim.payload).code, 'EMPTY_SIMULATION_MESSAGE');
  });

  test('8. Web Console UI: Halaman /studio dan aset logo dapat diakses', async () => {
    const studioRes = await gatewayApp.inject({
      method: 'GET',
      url: '/studio',
    });
    assert.equal(studioRes.statusCode, 200);
    assert.ok(studioRes.payload.includes('AI Studio Console'));
    assert.ok(studioRes.headers['content-type'].includes('text/html'));

    const logoRes = await gatewayApp.inject({
      method: 'GET',
      url: '/logo-gaga-icon.png',
    });
    assert.equal(logoRes.statusCode, 200);
    assert.ok(logoRes.headers['content-type'].includes('image/png'));

    const markRes = await gatewayApp.inject({
      method: 'GET',
      url: '/logo-mark.png',
    });
    assert.equal(markRes.statusCode, 200);
    assert.ok(markRes.headers['content-type'].includes('image/png'));

    const fullLightRes = await gatewayApp.inject({
      method: 'GET',
      url: '/logo-full-light.png',
    });
    assert.equal(fullLightRes.statusCode, 200);
    assert.ok(fullLightRes.headers['content-type'].includes('image/png'));
  });
});
