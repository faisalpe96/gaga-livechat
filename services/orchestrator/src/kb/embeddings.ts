import crypto from 'node:crypto';

export interface EmbeddingProvider {
  name: string;
  dimension: number;
  generateEmbedding(text: string): Promise<number[]>;
  generateBatchEmbeddings(texts: string[]): Promise<number[][]>;
}

/**
 * MockEmbeddingProvider
 * Menghasilkan vektor 1536-dimensi deterministik ternormalisasi secara lokal.
 * Tidak membutuhkan API key eksternal, jaringan, ataupun biaya.
 * Sangat cocok untuk pengujian lokal, CI/CD, dan lingkungan pengembangan.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'mock-local-1536';
  public readonly dimension = 1536;

  async generateEmbedding(text: string): Promise<number[]> {
    return this.createDeterministicVector(text);
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.createDeterministicVector(t));
  }

  private createDeterministicVector(text: string): number[] {
    const vector = new Float64Array(this.dimension);
    const normalized = text
      .toLowerCase()
      .replace(/top-up/g, 'topup')
      .replace(/e-wallet/g, 'ewallet')
      .replace(/in-game/g, 'ingame')
      .trim();

    // 1. Ekstraksi token kata dan n-gram (termasuk memecah tanda hubung)
    const words = normalized.split(/[\s,.:;!?"'()\[\]{}\-_/]+/).filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      // Hash kata ke indeks 0..1535
      const h1 = this.hashString(word);
      const idx1 = Math.abs(h1) % this.dimension;
      const weight = 1.0 + (word.length / 10.0);
      vector[idx1] += weight;

      // Hash bigram bila ada
      if (i > 0) {
        const bigram = `${words[i - 1]}_${word}`;
        const h2 = this.hashString(bigram);
        const idx2 = Math.abs(h2) % this.dimension;
        vector[idx2] += weight * 1.5;
      }
    }

    // Hash karakter tri-gram untuk menangkap kemiripan subkata / bahasa non-spasi (Thai, dll.)
    for (let i = 0; i < normalized.length - 2; i++) {
      const trigram = normalized.slice(i, i + 3);
      const h3 = this.hashString(trigram);
      const idx3 = Math.abs(h3) % this.dimension;
      vector[idx3] += 0.5;
    }

    // 2. Normalisasi vektor ke L2 unit length: sqrt(sum(v_i^2)) = 1.0
    let sumSq = 0;
    for (let i = 0; i < this.dimension; i++) {
      sumSq += vector[i] * vector[i];
    }

    const norm = Math.sqrt(sumSq);
    const result: number[] = new Array(this.dimension);

    if (norm > 0) {
      for (let i = 0; i < this.dimension; i++) {
        result[i] = Number((vector[i] / norm).toFixed(6));
      }
    } else {
      // Fallback bila teks kosong
      result.fill(0);
      result[0] = 1.0;
    }

    return result;
  }

  private hashString(str: string): number {
    const hash = crypto.createHash('md5').update(str).digest();
    return hash.readInt32BE(0);
  }
}

/**
 * OpenAIEmbeddingProvider (Opsional untuk produksi)
 * Menggunakan model text-embedding-3-small (1536 dimensi) saat API key tersedia.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'openai-text-embedding-3-small';
  public readonly dimension = 1536;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const batch = await this.generateBatchEmbeddings([text]);
    return batch[0];
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimension,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI Embedding API error: ${JSON.stringify(err)}`);
    }

    const data = await res.json();
    return data.data.map((item: any) => item.embedding);
  }
}

/**
 * Factory untuk memilih provider embedding.
 * Default: MockEmbeddingProvider (offline, tanpa biaya/API key).
 */
export function getEmbeddingProvider(apiKey = process.env.OPENAI_API_KEY): EmbeddingProvider {
  if (apiKey && process.env.USE_REAL_EMBEDDINGS === 'true') {
    return new OpenAIEmbeddingProvider(apiKey);
  }
  return new MockEmbeddingProvider();
}
