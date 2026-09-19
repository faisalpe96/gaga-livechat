import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { LlmClient, LlmGenerateRequest, LlmGenerateResponse } from './client.js';
import { buildPrompt } from './prompt-builder.js';

/**
 * AnthropicLlmClient — implementasi LlmClient sungguhan di atas Claude Messages API.
 *
 * Prinsip:
 * - Keluaran dipaksa berbentuk JSON lewat structured outputs (output_config.format),
 *   bukan parsing teks bebas, sehingga confidence/intent/sources selalu terisi.
 * - "sources" divalidasi terhadap doc_key yang memang dikirim — model tidak bisa
 *   mengarang sumber. Sumber kosong → guardrail (aturan 3) mengeskalasi ke manusia.
 * - Kegagalan API apa pun (timeout, 5xx setelah retry, JSON tak valid, refusal)
 *   TIDAK melempar error ke pipeline; dikembalikan respons kosong ber-confidence 0
 *   agar guardrail meng-handoff ke agen manusia. Bot tidak pernah mengarang saat API bermasalah.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export interface AnthropicLlmClientOptions {
  apiKey: string;
  model?: string;
  /** Batas waktu satu permintaan HTTP dalam milidetik (SDK: ms). Default 20 detik. */
  timeoutMs?: number;
  /** Jumlah retry SDK untuk 429/5xx/koneksi. Default 1. */
  maxRetries?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** Untuk pengujian: fetch pengganti yang disuntikkan ke SDK. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'warn' | 'error'>;
}

// Skema JSON yang dikirim ke API (harus additionalProperties:false + required lengkap)
const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'handoff'] },
    reply: { type: 'string', description: 'Balasan untuk pemain. Kosong jika action=handoff.' },
    intent: { type: 'string', description: 'Label intent snake_case.' },
    confidence: { type: 'number', description: 'Keyakinan 0-1 bahwa jawaban didukung dokumen/tool.' },
    used_doc_keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'doc_key dari dokumen pendukung yang dipakai, atau "tool:get_transaction".',
    },
    handoff_reason: { type: 'string', description: 'Alasan singkat jika action=handoff, selain itu kosong.' },
  },
  required: ['action', 'reply', 'intent', 'confidence', 'used_doc_keys', 'handoff_reason'],
  additionalProperties: false,
} as const;

// Validasi sisi klien (batas numerik tidak didukung skema API, jadi dicek di sini)
const StructuredReplySchema = z.object({
  action: z.enum(['reply', 'handoff']),
  reply: z.string(),
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  used_doc_keys: z.array(z.string()),
  handoff_reason: z.string(),
});
export type StructuredReply = z.infer<typeof StructuredReplySchema>;

export const TOOL_SOURCE_KEY = 'tool:get_transaction';

/** Respons aman saat model/API gagal: sources kosong + confidence 0 → guardrail handoff. */
function failSafeResponse(intent = 'llm_error'): LlmGenerateResponse {
  return { text: '', sources: [], confidence: 0, intent };
}

export class AnthropicLlmClient implements LlmClient {
  public callCount = 0;
  public readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicLlmClientOptions['effort']>;
  private readonly maxTokens: number;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  constructor(options: AnthropicLlmClientOptions) {
    if (!options.apiKey) {
      throw new Error('AnthropicLlmClient: apiKey wajib diisi (ANTHROPIC_API_KEY).');
    }
    this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
    this.effort = options.effort || 'medium';
    this.maxTokens = options.maxTokens ?? 8192;
    this.logger = options.logger || console;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 20_000,
      maxRetries: options.maxRetries ?? 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  resetSpy() {
    this.callCount = 0;
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResponse> {
    this.callCount++;
    const prompt = buildPrompt(request);

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: [
          // Blok statis per locale/persona: kandidat cache prefix
          { type: 'text', text: prompt.stableSystem, cache_control: { type: 'ephemeral' } },
          // Blok dinamis: dokumen KB, hasil tool, instruksi format
          { type: 'text', text: prompt.contextBlock },
        ],
        messages: prompt.messages,
        output_config: {
          effort: this.effort,
          format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
        },
      });
    } catch (error) {
      this.logApiError(error);
      return failSafeResponse();
    }

    if (message.stop_reason === 'refusal') {
      this.logger.warn('[AnthropicLlmClient] Model menolak permintaan (refusal); eskalasi ke agen manusia.');
      return failSafeResponse('llm_refusal');
    }
    if (message.stop_reason === 'max_tokens') {
      this.logger.warn('[AnthropicLlmClient] Keluaran terpotong (max_tokens); eskalasi ke agen manusia.');
      return failSafeResponse();
    }

    const rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = this.parseStructuredReply(rawText);
    if (!parsed) {
      return failSafeResponse();
    }

    return this.toGenerateResponse(parsed, request);
  }

  /** Dipisah agar bisa diuji tanpa jaringan. */
  parseStructuredReply(rawText: string): StructuredReply | null {
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      this.logger.error('[AnthropicLlmClient] Keluaran model bukan JSON valid:', rawText.slice(0, 200));
      return null;
    }
    const result = StructuredReplySchema.safeParse(json);
    if (!result.success) {
      this.logger.error('[AnthropicLlmClient] Keluaran model tidak sesuai skema:', result.error.issues);
      return null;
    }
    return result.data;
  }

  /** Dipisah agar bisa diuji tanpa jaringan. */
  toGenerateResponse(parsed: StructuredReply, request: LlmGenerateRequest): LlmGenerateResponse {
    if (parsed.action === 'handoff') {
      return {
        text: '',
        sources: [],
        confidence: 0,
        intent: parsed.intent || 'handoff_request',
        toolCalls: [{ name: 'request_handoff', args: { reason: parsed.handoff_reason || 'llm_requested' } }],
      };
    }

    // Validasi sumber: hanya doc_key yang memang dikirim (atau kunci tool bila ada hasil tool)
    const allowed = new Set(request.documents.map((d) => d.doc_key));
    const hasToolContext = !!(request.toolsContext && request.toolsContext.length > 0);
    if (hasToolContext) allowed.add(TOOL_SOURCE_KEY);

    const sources = Array.from(new Set(parsed.used_doc_keys.filter((k) => allowed.has(k))));
    if (sources.length === 0 && hasToolContext) {
      // Model memakai data tool tapi lupa mencantumkannya — hasil tool adalah data terverifikasi sistem
      sources.push(TOOL_SOURCE_KEY);
    }

    return {
      text: parsed.reply.trim(),
      sources,
      confidence: Number(parsed.confidence.toFixed(2)),
      intent: parsed.intent || 'general_inquiry',
    };
  }

  private logApiError(error: unknown) {
    if (error instanceof Anthropic.AuthenticationError) {
      this.logger.error('[AnthropicLlmClient] ANTHROPIC_API_KEY ditolak (401). Periksa variabel di Railway.');
    } else if (error instanceof Anthropic.RateLimitError) {
      this.logger.warn('[AnthropicLlmClient] Rate limit (429) setelah retry; eskalasi ke agen manusia.');
    } else if (error instanceof Anthropic.APIConnectionError) {
      this.logger.warn('[AnthropicLlmClient] Gagal terhubung / timeout ke API:', error.message);
    } else if (error instanceof Anthropic.APIError) {
      this.logger.error(`[AnthropicLlmClient] API error ${error.status}:`, error.message);
    } else {
      this.logger.error('[AnthropicLlmClient] Error tak terduga:', error);
    }
  }
}
