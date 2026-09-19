import type Anthropic from '@anthropic-ai/sdk';
import { LlmGenerateRequest } from './client.js';

/**
 * Membangun blok konteks (dokumen KB + hasil tool) dan riwayat percakapan
 * dari LlmGenerateRequest menjadi bentuk yang siap dikirim ke Messages API.
 *
 * Fungsi murni tanpa jaringan — mudah di-unit-test.
 */

export interface BuiltPrompt {
  /** System prompt statis dari buildSystemPrompt() — cocok untuk prompt caching. */
  stableSystem: string;
  /** Blok konteks dinamis: dokumen pendukung, hasil tool, dan instruksi format keluaran. */
  contextBlock: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Batas panjang isi dokumen yang disisipkan ke prompt (per dokumen).
 * Dokumen KB Gaga Games pendek, tapi jaga-jaga terhadap dokumen kebijakan panjang.
 */
const MAX_DOC_BODY_CHARS = 4000;

export function buildContextBlock(request: LlmGenerateRequest): string {
  const parts: string[] = [];

  if (request.documents.length > 0) {
    const docs = request.documents
      .map((d, i) => {
        const body = d.body.length > MAX_DOC_BODY_CHARS ? `${d.body.slice(0, MAX_DOC_BODY_CHARS)}…` : d.body;
        return [
          `[Dokumen ${i + 1}] doc_key: ${d.doc_key} | locale: ${d.locale}${d.is_policy ? ' | KEBIJAKAN' : ''}`,
          `Judul: ${d.title}`,
          `Isi: ${body}`,
        ].join('\n');
      })
      .join('\n\n');
    parts.push(`DOKUMEN PENDUKUNG (satu-satunya sumber fakta yang boleh dipakai):\n${docs}`);
  } else {
    parts.push('DOKUMEN PENDUKUNG: (tidak ada dokumen yang cocok)');
  }

  if (request.toolsContext && request.toolsContext.length > 0) {
    parts.push(
      `HASIL TOOL get_transaction (data terverifikasi dari sistem, boleh disampaikan ke pemain):\n${JSON.stringify(
        request.toolsContext,
        null,
        2
      )}`
    );
  }

  parts.push(
    [
      'FORMAT KELUARAN:',
      'Keluarkan JSON sesuai skema yang diberikan.',
      '- action "reply": isi "reply" dengan balasan untuk pemain dalam bahasa ' + request.locale + '.',
      '  "used_doc_keys" WAJIB berisi doc_key dari DOKUMEN PENDUKUNG yang benar-benar kamu pakai.',
      '  Jika kamu memakai HASIL TOOL, sertakan "tool:get_transaction" di used_doc_keys.',
      '  "confidence" adalah angka 0–1: seberapa yakin jawaban ini didukung dokumen/tool di atas.',
      '  Beri nilai di bawah 0.5 jika kamu terpaksa menebak atau dokumen tidak menjawab pertanyaan.',
      '- action "handoff": gunakan jika pemain minta agen manusia, pertanyaan tidak terjawab oleh dokumen,',
      '  atau kamu dua kali berturut-turut gagal memahami maksud pemain. Isi "handoff_reason" singkat.',
      '- "intent": label singkat snake_case (misal faq_inquiry, topup_issue, account_issue, bug_report, general_inquiry).',
    ].join('\n')
  );

  return parts.join('\n\n');
}

export function buildMessages(request: LlmGenerateRequest): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const item of request.history) {
    const text = (item.text || '').trim();
    if (!text) continue;
    switch (item.sender_type) {
      case 'player':
        messages.push({ role: 'user', content: text });
        break;
      case 'bot':
        messages.push({ role: 'assistant', content: text });
        break;
      case 'agent':
        // Balasan agen manusia sebelumnya — tetap di sisi assistant agar alur percakapan konsisten
        messages.push({ role: 'assistant', content: `[Agen manusia] ${text}` });
        break;
      default:
        // sender_type 'system' dan lainnya tidak dikirim ke model
        break;
    }
  }

  // Pastikan pesan pemain terbaru menjadi giliran user terakhir.
  // recentHistory dari orchestrator biasanya sudah memuat pesan ini; hindari duplikasi.
  const last = messages[messages.length - 1];
  const latest = (request.userMessage || '').trim();
  const alreadyLast =
    last && last.role === 'user' && typeof last.content === 'string' && last.content === latest;
  if (latest && !alreadyLast) {
    messages.push({ role: 'user', content: latest });
  }

  // Messages API mewajibkan giliran pertama adalah user
  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: latest || '(pesan kosong)' });
  }

  return messages;
}

export function buildPrompt(request: LlmGenerateRequest): BuiltPrompt {
  return {
    stableSystem: request.systemPrompt,
    contextBlock: buildContextBlock(request),
    messages: buildMessages(request),
  };
}
