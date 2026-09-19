import { LlmClient, MockLlmClient } from './client.js';
import { AnthropicLlmClient, DEFAULT_ANTHROPIC_MODEL } from './anthropic-client.js';
import { config } from '../config.js';

export type LlmProvider = 'mock' | 'anthropic';

/**
 * Memilih implementasi LlmClient berdasarkan environment:
 *
 *   LLM_PROVIDER=mock       (default) → MockLlmClient, tanpa jaringan/biaya
 *   LLM_PROVIDER=anthropic  → AnthropicLlmClient; wajib ANTHROPIC_API_KEY
 *
 * Provider non-mock tanpa API key GAGAL saat startup dengan pesan jelas —
 * tidak diam-diam jatuh ke mock, supaya salah konfigurasi produksi langsung terlihat.
 */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = (env.LLM_PROVIDER || config.llmProvider || 'mock').toLowerCase() as LlmProvider;

  switch (provider) {
    case 'mock':
      return new MockLlmClient();

    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          'LLM_PROVIDER=anthropic tetapi ANTHROPIC_API_KEY tidak di-set. ' +
            'Isi variabel tersebut di Railway atau ubah LLM_PROVIDER=mock.'
        );
      }
      const client = new AnthropicLlmClient({
        apiKey,
        model: env.LLM_MODEL || DEFAULT_ANTHROPIC_MODEL,
        timeoutMs: parseIntOr(env.LLM_TIMEOUT_MS, 20_000),
        effort: parseEffort(env.LLM_EFFORT),
      });
      console.log(`[LLM] Provider: anthropic | model: ${client.model}`);
      return client;
    }

    default:
      throw new Error(`LLM_PROVIDER tidak dikenal: "${provider}". Pilih: mock, anthropic.`);
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseEffort(value: string | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const v = (value || '').toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max' ? v : undefined;
}
