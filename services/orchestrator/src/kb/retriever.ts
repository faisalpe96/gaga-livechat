import pg from 'pg';
import { EmbeddingProvider, getEmbeddingProvider } from './embeddings.js';
import {
  KbDocument,
  KbDocumentInput,
  KbSearchResult,
  SearchOptions,
} from '../types.js';

export class KnowledgeBaseRetriever {
  private pool: pg.Pool;
  private embeddingProvider: EmbeddingProvider;

  constructor(pool: pg.Pool, embeddingProvider?: EmbeddingProvider) {
    this.pool = pool;
    this.embeddingProvider = embeddingProvider || getEmbeddingProvider();
  }

  /**
   * Cari dokumen knowledge base berdasarkan query teks atau query vector.
   * Penegakan Aturan Isolasi Kebijakan (TASK-05):
   * 1. Dokumen kebijakan (is_policy = true) HANYA boleh diambil dalam locale yang sama persis.
   * 2. Dokumen non-kebijakan (is_policy = false) boleh diambil lintas bahasa (cross-lingual).
   */
  async search(
    query: string | number[],
    targetLocale: string,
    options: SearchOptions = {}
  ): Promise<KbSearchResult[]> {
    const limit = options.limit || 5;
    const threshold = options.threshold ?? 0.035;
    let queryVector: number[];
    let queryString = '';

    if (typeof query === 'string') {
      queryString = query.toLowerCase();
      queryVector = await this.embeddingProvider.generateEmbedding(query);
    } else {
      queryVector = query;
    }

    const vectorStr = `[${queryVector.join(',')}]`;

    // Query pgvector dengan pemfilteran ketat is_policy dan ambang kemiripan (threshold)
    const sql = `
      SELECT 
        id,
        doc_key,
        locale,
        title,
        body,
        is_policy,
        version,
        (1 - (embedding <=> $1::vector)) AS similarity
      FROM kb_documents
      WHERE 
        embedding IS NOT NULL
        AND (
          -- Aturan 1: Dokumen kebijakan wajib cocok locale persis
          (is_policy = true AND locale = $2)
          OR
          -- Aturan 2: Dokumen non-kebijakan boleh lintas bahasa
          (is_policy = false)
        )
        AND (1 - (embedding <=> $1::vector)) >= $4
      ORDER BY 
        (1 - (embedding <=> $1::vector)) + (CASE WHEN locale = $2 THEN 0.15 ELSE 0 END) DESC
      LIMIT $3
    `;

    const res = await this.pool.query(sql, [vectorStr, targetLocale, limit * 2, threshold]);

    const mapped: KbSearchResult[] = res.rows.map((row) => ({
      id: row.id,
      doc_key: row.doc_key,
      locale: row.locale,
      title: row.title,
      body: row.body,
      is_policy: row.is_policy,
      version: row.version,
      similarity: parseFloat(row.similarity),
    }));

    // Filter dokumen tidak berkaitan:
    // 1. Jika dokumen kebijakan (is_policy = true), hanya sertakan bila query memang relevan dengan kata kunci kebijakan
    const policyKeywords = [
      'refund', 'kembalikan dana', 'kembalikan uang', 'pengembalian', 'batal',
      'banned', 'ban', 'blokir', 'suspensi', 'appeal', 'banding',
      'คืนเงิน', 'ระงับ', 'แบน', 'hoàn tiền', 'khóa'
    ];
    const isPolicyRelevant = queryString ? policyKeywords.some((kw) => queryString.includes(kw)) : true;

    // Filter topik spesifik agar tidak tertukar dokumen:
    const topupKeywords = [
      'topup', 'top-up', 'isi saldo', 'diamond', 'store', 'qris', 'dana',
      'gopay', 'ovo', 'transfer bank', 'pembayaran', 'belum masuk', 'masuk',
      'เติมเงิน', 'nạp tiền'
    ];
    const accountLinkKeywords = [
      'link', 'bind', 'tautkan', 'hubungkan', 'google play', 'apple id',
      'passport', 'ganti hp', 'pindah akun', 'hilang akun', 'hilang progres',
      'เชื่อมโยง', 'liên kết'
    ];
    const vipKeywords = [
      'vip', 'privilege', 'tier', 'stamina', 'avatar frame', 'guild', 'สิทธิพิเศษ'
    ];

    const isTopupQuery = queryString ? topupKeywords.some((kw) => queryString.includes(kw)) : false;
    const isAccountLinkQuery = queryString ? accountLinkKeywords.some((kw) => queryString.includes(kw)) : false;
    const isVipQuery = queryString ? vipKeywords.some((kw) => queryString.includes(kw)) : false;

    const relevantDocs = mapped.filter((doc) => {
      if (doc.is_policy && !isPolicyRelevant) return false;
      // Jangan pernah mencampuradukkan atau memaksakan topik non-kebijakan:
      if (doc.doc_key === 'faq_topup_guide' && !isTopupQuery) return false;
      if (doc.doc_key === 'faq_account_link' && !isAccountLinkQuery) return false;
      if (doc.doc_key === 'faq_vip_benefits' && !isVipQuery) return false;
      if (isTopupQuery && !doc.is_policy && doc.doc_key !== 'faq_topup_guide') return false;
      if (isAccountLinkQuery && !doc.is_policy && doc.doc_key !== 'faq_account_link') return false;
      if (isVipQuery && !doc.is_policy && doc.doc_key !== 'faq_vip_benefits') return false;
      return true;
    });

    if (relevantDocs.length === 0) return [];

    // 2. Relativitas kemiripan (harus >= 65% dari skor dokumen teratas yang relevan)
    const topSimilarity = relevantDocs[0].similarity;
    const filtered = relevantDocs.filter((doc) => {
      if (doc.similarity < topSimilarity * 0.65) return false;
      return true;
    });

    // 3. Deduplikasi per doc_key: utamakan dokumen yang cocok dengan targetLocale
    const seenKeys = new Map<string, KbSearchResult>();

    for (const doc of filtered) {
      if (!seenKeys.has(doc.doc_key)) {
        seenKeys.set(doc.doc_key, doc);
      } else {
        const existing = seenKeys.get(doc.doc_key)!;
        if (doc.locale === targetLocale && existing.locale !== targetLocale) {
          seenKeys.set(doc.doc_key, doc);
        }
      }
    }

    const finalResults = Array.from(seenKeys.values()).slice(0, limit);
    return finalResults;
  }

  /**
   * Menyimpan atau memperbarui dokumen FAQ / Knowledge Base beserta vektor embedding.
   */
  async upsertDocument(input: KbDocumentInput): Promise<KbDocument> {
    let embedding = input.embedding;
    if (!embedding || embedding.length === 0) {
      // Buat embedding dari gabungan judul dan isi dokumen
      const textToEmbed = `${input.title}\n\n${input.body}`;
      embedding = await this.embeddingProvider.generateEmbedding(textToEmbed);
    }

    const vectorStr = `[${embedding.join(',')}]`;
    const isPolicy = input.is_policy ?? false;
    const version = input.version ?? 1;
    const reviewedAt = input.reviewed_at ? new Date(input.reviewed_at) : new Date();

    const sql = `
      INSERT INTO kb_documents (
        doc_key, locale, title, body, is_policy, version, reviewed_by, reviewed_at, embedding
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::vector
      )
      ON CONFLICT (doc_key, locale) DO UPDATE SET
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        is_policy = EXCLUDED.is_policy,
        version = EXCLUDED.version,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        embedding = EXCLUDED.embedding
      RETURNING *
    `;

    const res = await this.pool.query(sql, [
      input.doc_key,
      input.locale,
      input.title,
      input.body,
      isPolicy,
      version,
      input.reviewed_by || 'system',
      reviewedAt,
      vectorStr,
    ]);

    const row = res.rows[0];
    return {
      id: row.id,
      doc_key: row.doc_key,
      locale: row.locale,
      title: row.title,
      body: row.body,
      is_policy: row.is_policy,
      version: row.version,
      reviewed_by: row.reviewed_by,
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at) : null,
    };
  }

  async getDocument(docKey: string, locale: string): Promise<KbDocument | null> {
    const res = await this.pool.query(
      `SELECT * FROM kb_documents WHERE doc_key = $1 AND locale = $2`,
      [docKey, locale]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      doc_key: row.doc_key,
      locale: row.locale,
      title: row.title,
      body: row.body,
      is_policy: row.is_policy,
      version: row.version,
      reviewed_by: row.reviewed_by,
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at) : null,
    };
  }
}
