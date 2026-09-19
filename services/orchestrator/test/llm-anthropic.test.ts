import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicLlmClient, TOOL_SOURCE_KEY } from '../src/llm/anthropic-client.js';
import { buildMessages, buildContextBlock } from '../src/llm/prompt-builder.js';
import { createLlmClient } from '../src/llm/factory.js';
import { MockLlmClient, LlmGenerateRequest } from '../src/llm/client.js';

const silentLogger = { warn: () => {}, error: () => {} };

function baseRequest(overrides: Partial<LlmGenerateRequest> = {}): LlmGenerateRequest {
  return {
    systemPrompt: 'SYSTEM PROMPT STATIS',
    locale: 'id-ID',
    userMessage: 'caranya topup gimana',
    history: [
      { sender_type: 'bot', text: 'Halo kak! Ada yang bisa dibantu?' },
      { sender_type: 'player', text: 'caranya topup gimana' },
    ],
    documents: [
      {
        id: '1',
        doc_key: 'faq_topup_guide',
        locale: 'id-ID',
        title: 'Panduan Top-Up',
        body: 'Buka menu Store, pilih nominal, bayar via QRIS/DANA.',
        is_policy: false,
        version: 1,
        similarity: 0.9,
      },
    ],
    ...overrides,
  };
}

/** fetch palsu yang membalas seperti Messages API. Merekam body permintaan terakhir. */
function fakeFetch(reply: (body: any) => { status?: number; json: any }) {
  const calls: any[] = [];
  const fn = (async (_url: any, init?: any) => {
    const body = JSON.parse(init?.body || '{}');
    calls.push(body);
    const r = reply(body);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function apiMessage(text: string, stop_reason = 'end_turn') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe('Prompt builder', () => {
  test('memetakan riwayat ke user/assistant, melewati system, tidak menduplikasi pesan terakhir', () => {
    const msgs = buildMessages(
      baseRequest({
        history: [
          { sender_type: 'system', text: 'sesi dimulai' },
          { sender_type: 'bot', text: 'Halo!' },
          { sender_type: 'player', text: 'halo' },
          { sender_type: 'agent', text: 'Saya bantu ya' },
          { sender_type: 'player', text: 'caranya topup gimana' },
        ],
      })
    );
    // 'system' dilewati, 'bot' di awal dibuang karena giliran pertama wajib user
    assert.deepEqual(
      msgs.map((m) => [m.role, m.content]),
      [
        ['user', 'halo'],
        ['assistant', '[Agen manusia] Saya bantu ya'],
        ['user', 'caranya topup gimana'],
      ]
    );
  });

  test('menambahkan userMessage bila belum ada di riwayat', () => {
    const msgs = buildMessages(baseRequest({ history: [] }));
    assert.deepEqual(msgs, [{ role: 'user', content: 'caranya topup gimana' }]);
  });

  test('blok konteks memuat doc_key dokumen dan hasil tool', () => {
    const block = buildContextBlock(baseRequest({ toolsContext: [{ order_id: 'order_1', status: 'paid' }] }));
    assert.match(block, /doc_key: faq_topup_guide/);
    assert.match(block, /HASIL TOOL get_transaction/);
    assert.match(block, /"order_id": "order_1"/);
  });
});

describe('AnthropicLlmClient', () => {
  test('mengirim structured output dan memetakan balasan ke LlmGenerateResponse', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: apiMessage(
        JSON.stringify({
          action: 'reply',
          reply: 'Buka menu Store kak, pilih nominal, bayar pakai QRIS atau DANA.',
          intent: 'topup_howto',
          confidence: 0.93,
          used_doc_keys: ['faq_topup_guide', 'doc_yang_tidak_dikirim'],
          handoff_reason: '',
        })
      ),
    }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(baseRequest());

    assert.equal(client.callCount, 1);
    assert.equal(res.text, 'Buka menu Store kak, pilih nominal, bayar pakai QRIS atau DANA.');
    assert.equal(res.confidence, 0.93);
    assert.equal(res.intent, 'topup_howto');
    // doc_key yang tidak pernah dikirim harus dibuang
    assert.deepEqual(res.sources, ['faq_topup_guide']);
    assert.equal(res.toolCalls, undefined);

    const body = calls[0];
    assert.equal(body.model, 'claude-opus-5');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.effort, 'medium');
    assert.equal(body.system[0].text, 'SYSTEM PROMPT STATIS');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.match(body.system[1].text, /DOKUMEN PENDUKUNG/);
    assert.equal(body.messages[body.messages.length - 1].role, 'user');
  });

  test('action=handoff → toolCalls request_handoff dengan confidence 0', async () => {
    const { fetch } = fakeFetch(() => ({
      json: apiMessage(
        JSON.stringify({
          action: 'handoff',
          reply: '',
          intent: 'human_request',
          confidence: 0.2,
          used_doc_keys: [],
          handoff_reason: 'pemain minta agen manusia',
        })
      ),
    }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(baseRequest({ userMessage: 'mau ngomong sama orang' }));
    assert.equal(res.confidence, 0);
    assert.deepEqual(res.sources, []);
    assert.deepEqual(res.toolCalls, [{ name: 'request_handoff', args: { reason: 'pemain minta agen manusia' } }]);
  });

  test('hasil tool dipakai → sumber tool ditambahkan meski model lupa mencantumkannya', async () => {
    const { fetch } = fakeFetch(() => ({
      json: apiMessage(
        JSON.stringify({
          action: 'reply',
          reply: 'Order order_1 statusnya sudah paid kak.',
          intent: 'topup_status',
          confidence: 0.9,
          used_doc_keys: [],
          handoff_reason: '',
        })
      ),
    }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(
      baseRequest({ documents: [], toolsContext: [{ order_id: 'order_1', status: 'paid' }] })
    );
    assert.deepEqual(res.sources, [TOOL_SOURCE_KEY]);
  });

  test('API 500 → respons aman (sources kosong, confidence 0), tidak melempar', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 500,
      json: { type: 'error', error: { type: 'api_error', message: 'boom' } },
    }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(baseRequest());
    assert.equal(res.text, '');
    assert.deepEqual(res.sources, []);
    assert.equal(res.confidence, 0);
  });

  test('JSON tidak valid / tidak sesuai skema → respons aman', async () => {
    const { fetch } = fakeFetch(() => ({ json: apiMessage('{"action":"reply","confidence":5}') }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(baseRequest());
    assert.equal(res.confidence, 0);
    assert.deepEqual(res.sources, []);
  });

  test('stop_reason refusal → respons aman', async () => {
    const { fetch } = fakeFetch(() => ({ json: apiMessage('', 'refusal') }));
    const client = new AnthropicLlmClient({ apiKey: 'test-key', fetch, logger: silentLogger, maxRetries: 0 });
    const res = await client.generate(baseRequest());
    assert.equal(res.confidence, 0);
    assert.equal(res.intent, 'llm_refusal');
  });
});

describe('createLlmClient', () => {
  test('default → MockLlmClient', () => {
    assert.ok(createLlmClient({}) instanceof MockLlmClient);
  });

  test('anthropic tanpa API key → gagal terang-terangan', () => {
    assert.throws(() => createLlmClient({ LLM_PROVIDER: 'anthropic' }), /ANTHROPIC_API_KEY tidak di-set/);
  });

  test('anthropic dengan API key → AnthropicLlmClient dengan model dari LLM_MODEL', () => {
    const c = createLlmClient({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x', LLM_MODEL: 'claude-sonnet-5' });
    assert.ok(c instanceof AnthropicLlmClient);
    assert.equal(c.model, 'claude-sonnet-5');
  });

  test('provider tidak dikenal → error', () => {
    assert.throws(() => createLlmClient({ LLM_PROVIDER: 'gemini' }), /tidak dikenal/);
  });
});
