import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { KnowledgeBaseRetriever } from '../services/orchestrator/src/kb/retriever.js';
import { CannedResponseService } from '../services/orchestrator/src/kb/canned-responses.js';
import { getEmbeddingProvider } from '../services/orchestrator/src/kb/embeddings.js';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

async function main() {
  console.log('=== Mulai Impor Data Knowledge Base & Canned Responses ===');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const embeddingProvider = getEmbeddingProvider();
  console.log(`Menggunakan Embedding Provider: ${embeddingProvider.name} (${embeddingProvider.dimension} dimensi)`);

  const retriever = new KnowledgeBaseRetriever(pool, embeddingProvider);
  const cannedService = new CannedResponseService(pool);

  try {
    // 1. Impor FAQ
    const faqPath = path.resolve(process.cwd(), 'data/kb/faq.json');
    if (fs.existsSync(faqPath)) {
      const faqData = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
      console.log(`\nMemproses ${faqData.length} dokumen FAQ...`);

      for (const doc of faqData) {
        await retriever.upsertDocument(doc);
        const policyTag = doc.is_policy ? '[KEBIJAKAN]' : '[PANDUAN]';
        console.log(`  ✓ ${policyTag} (${doc.locale}) ${doc.doc_key} - "${doc.title}"`);
      }
      console.log(`Selesai mengimpor ${faqData.length} dokumen FAQ ke tabel kb_documents.`);
    } else {
      console.warn(`Peringatan: File ${faqPath} tidak ditemukan.`);
    }

    // 2. Impor Canned Responses
    const cannedPath = path.resolve(process.cwd(), 'data/kb/canned-responses.json');
    if (fs.existsSync(cannedPath)) {
      const cannedData = JSON.parse(fs.readFileSync(cannedPath, 'utf-8'));
      console.log(`\nMemproses ${cannedData.length} canned responses...`);

      for (const item of cannedData) {
        await cannedService.upsertCannedResponse(item);
        console.log(`  ✓ [${item.category}] (${item.locale}) ${item.template_id}`);
      }
      console.log(`Selesai mengimpor ${cannedData.length} balasan ke tabel canned_responses.`);
    } else {
      console.warn(`Peringatan: File ${cannedPath} tidak ditemukan.`);
    }

    console.log('\n=== Seluruh Data Knowledge Base Berhasil Diimpor & Diindeks ===');
  } catch (err) {
    console.error('Terjadi kesalahan saat mengimpor KB:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
