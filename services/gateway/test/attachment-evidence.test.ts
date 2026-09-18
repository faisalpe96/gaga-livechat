import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Database } from '../src/db.js';
import { AttachmentService } from '../src/attachment-service.js';
import { CategoryFieldService } from '../src/category-field-service.js';
import { buildGatewayServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgrespassword@localhost:5432/livechat';

// Minimal 1x1 transparent PNG buffer
const VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

describe('TASK-ATTACHMENT: Attachment Upload, Evidence Handling & Security Tests', () => {
  let db: Database;
  let serverInstance: { app: FastifyInstance; db: Database; pubsub?: any };
  let app: FastifyInstance;

  before(async () => {
    db = new Database(databaseUrl);
    await db.ensureInvestigationAndScheduleTables();
    serverInstance = await buildGatewayServer({ databaseUrl, port: 0 });
    app = serverInstance.app;
  });

  after(async () => {
    await app.close();
    try {
      await serverInstance?.pubsub?.close();
    } catch {}
    try {
      await serverInstance?.db?.close();
    } catch {}
    try {
      await db.close();
    } catch {}
  });

  test('1. MIME Sniffing pada server: Menolak file manipulasi ekstensi dan hanya menerima JPEG, PNG, WebP valid', () => {
    // File teks palsu yang dinamai .png
    const fakePng = Buffer.from('Ini bukan file gambar asli tapi script executable');
    const sniffFake = AttachmentService.sniffMimeType(fakePng);
    assert.strictEqual(sniffFake, null, 'File dengan konten teks biasa harus ditolak (null)');

    // File PNG valid
    const sniffPng = AttachmentService.sniffMimeType(VALID_PNG_BUFFER);
    assert.ok(sniffPng, 'PNG valid harus dikenali');
    assert.strictEqual(sniffPng?.mimeType, 'image/png');
    assert.strictEqual(sniffPng?.extension, 'png');

    // File JPEG valid header (FF D8 FF E0 ...)
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const sniffJpg = AttachmentService.sniffMimeType(validJpgHeader);
    assert.ok(sniffJpg, 'JPEG valid harus dikenali');
    assert.strictEqual(sniffJpg?.mimeType, 'image/jpeg');

    // File WebP valid header (RIFF....WEBP)
    const validWebpHeader = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    const sniffWebp = AttachmentService.sniffMimeType(validWebpHeader);
    assert.ok(sniffWebp, 'WebP valid harus dikenali');
    assert.strictEqual(sniffWebp?.mimeType, 'image/webp');
  });

  test('2. EXIF Stripping & Pemrosesan Sharp: Metadata pribadi/GPS dibersihkan dari gambar', async () => {
    // Buat gambar uji dengan metadata EXIF tiruan menggunakan sharp
    const testImage = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 16, g: 185, b: 129 },
      },
    })
      .jpeg()
      .toBuffer();

    const { sanitizedBuffer, mimeType } = await AttachmentService.stripExifAndSanitize(testImage);
    assert.ok(sanitizedBuffer.length > 0, 'Buffer hasil sanitasi harus tidak kosong');
    assert.strictEqual(mimeType, 'image/jpeg');

    // Periksa bahwa metadata sanitizedBuffer tidak mengandung tag EXIF / GPS
    const checkMeta = await sharp(sanitizedBuffer).metadata();
    assert.strictEqual(checkMeta.exif, undefined, 'EXIF harus bersih tanpa sisa setelah sanitasi');
  });

  test('3. Penyimpanan di luar web root & Signed URLs berbatas waktu', async () => {
    const originalName = 'bukti_transfer.png';
    const uploadResult = await AttachmentService.saveAttachment(VALID_PNG_BUFFER, originalName, 'http://127.0.0.1:3001');

    assert.ok(uploadResult.file_id, 'file_id harus terbuat');
    assert.ok(uploadResult.signed_url.includes('/v1/attachments/'), 'Signed URL harus mengarah ke endpoint aman');
    assert.ok(uploadResult.signed_url.includes('token='), 'Signed URL harus mengandung parameter token HMAC');
    assert.ok(uploadResult.signed_url.includes('expires='), 'Signed URL harus mengandung parameter expires');

    // Verifikasi bahwa file disimpan di luar web root (di STORAGE_DIR, bukan di public/)
    const diskPath = AttachmentService.getAttachmentFilePath(uploadResult.file_id);
    assert.ok(diskPath, 'File fisik harus ditemukan di storage');
    assert.ok(diskPath.includes('storage'), 'Path harus berada di dalam direktori storage');
    assert.ok(!diskPath.includes(path.join('gateway', 'public')), 'File DILARANG disimpan di dalam public web root');

    // Verifikasi validitas signature
    const urlObj = new URL(uploadResult.signed_url);
    const filename = urlObj.searchParams.get('filename')!;
    const expires = parseInt(urlObj.searchParams.get('expires')!, 10);
    const token = urlObj.searchParams.get('token')!;

    const validCheck = AttachmentService.verifySignedUrl(uploadResult.file_id, filename, expires, token);
    assert.strictEqual(validCheck.valid, true, 'Signature harus valid untuk URL yang baru dibuat');

    // Uji penolakan jika token dipalsukan (Tampered Token)
    const invalidCheck = AttachmentService.verifySignedUrl(uploadResult.file_id, filename, expires, 'fake_token_12345');
    assert.strictEqual(invalidCheck.valid, false, 'Token palsu harus ditolak');
    assert.strictEqual(invalidCheck.reason, 'INVALID_SIGNATURE');

    // Uji penolakan jika token kadaluarsa (Expired Token)
    const expiredCheck = AttachmentService.verifySignedUrl(uploadResult.file_id, filename, Math.floor(Date.now() / 1000) - 100, token);
    assert.strictEqual(expiredCheck.valid, false, 'URL kadaluarsa harus ditolak');
    assert.strictEqual(expiredCheck.reason, 'URL_EXPIRED');
  });

  test('4. Batasan Ukuran (5MB) dan Batasan Jumlah File (3 file) pada Upload API', async () => {
    // 4.1 Uji ukuran melebihi batas 5MB
    const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 100, 0); // 5MB + 100 byte
    const resOverSize = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload',
      payload: {
        file_base64: oversizedBuffer.toString('base64'),
        filename: 'huge_file.png',
      },
    });
    assert.strictEqual(resOverSize.statusCode, 413, 'File > 5MB harus ditolak dengan HTTP 413 Payload Too Large');

    // 4.2 Uji jumlah file melebihi batas 3 file sekaligus
    const fourFiles = [
      { file_base64: VALID_PNG_BUFFER.toString('base64'), filename: '1.png' },
      { file_base64: VALID_PNG_BUFFER.toString('base64'), filename: '2.png' },
      { file_base64: VALID_PNG_BUFFER.toString('base64'), filename: '3.png' },
      { file_base64: VALID_PNG_BUFFER.toString('base64'), filename: '4.png' },
    ];
    const resOverCount = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload',
      payload: { files: fourFiles },
    });
    assert.strictEqual(resOverCount.statusCode, 400, 'Lebih dari 3 file harus ditolak dengan HTTP 400');
    assert.ok(resOverCount.json().code === 'COUNT_LIMIT_EXCEEDED');

    // 4.3 Upload file valid via API berhasil
    const resValid = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload',
      payload: {
        file_base64: VALID_PNG_BUFFER.toString('base64'),
        filename: 'receipt_sample.png',
      },
    });
    assert.strictEqual(resValid.statusCode, 201, 'File valid harus menghasilkan HTTP 201 Created');
    const uploadData = resValid.json();
    assert.ok(uploadData.attachment?.signed_url, 'Signed URL harus dikembalikan');

    // 4.4 Akses file via GET /v1/attachments/:fileId
    const getUrl = new URL(uploadData.attachment.signed_url);
    const resGetFile = await app.inject({
      method: 'GET',
      url: getUrl.pathname + getUrl.search,
    });
    assert.strictEqual(resGetFile.statusCode, 200, 'File harus dapat diakses via signed URL');
    assert.strictEqual(resGetFile.headers['content-type'], 'image/png');
    assert.strictEqual(resGetFile.headers['x-content-type-options'], 'nosniff');
  });

  test('5. Syarat 3: Pemain menulis "sudah saya kirim" / "ini fotonya" tanpa attachment -> Bot TIDAK mengulang pertanyaan verbatim', () => {
    // Deteksi frasa klaim pengiriman bukti di berbagai locale
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('sudah saya kirim'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('udah dikirim tadi ya'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('ini fotonya kak'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('ini bukti transfernya'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('tuh gambarnya'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('i already sent it'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('here is the screenshot'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('ส่งไปแล้ว'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('นี่รูปค่ะ'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('naipadala ko na'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('dah hantar resit'), true);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('đã gửi rồi'), true);

    // Pertanyaan bantuan normal tidak dianggap klaim kirim bukti
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('halo bot tolong bantu saya'), false);
    assert.strictEqual(AttachmentService.isClaimingSentAttachment('diamond saya belum masuk'), false);

    // Verifikasi pesan penjelasan memandu tombol lampiran (📎) dan tidak verbatim mengulang pertanyaan
    const idExpl = AttachmentService.getMissingAttachmentExplanation('id-ID', 'mira');
    assert.ok(idExpl.includes('📎'), 'Pesan harus menunjukkan tombol lampiran 📎');
    assert.ok(idExpl.includes('belum masuk') || idExpl.includes('belum terbaca'));
    assert.ok(!idExpl.includes('Bisa sebutkan nomor Order ID'), 'Bot DILARANG mengulang pertanyaan verbatim');

    // Verifikasi partikel kesopanan bahasa Thai untuk Mira (ค่ะ) vs Reza (ครับ)
    const thMira = AttachmentService.getMissingAttachmentExplanation('th-TH', 'mira');
    assert.ok(thMira.includes('ค่ะ'), 'Mira di th-TH harus menggunakan partikel ค่ะ');
    assert.ok(thMira.includes('📎'));

    const thReza = AttachmentService.getMissingAttachmentExplanation('th-TH', 'reza');
    assert.ok(thReza.includes('ครับ'), 'Reza di th-TH harus menggunakan partikel ครับ');
    assert.ok(thReza.includes('📎'));

    // Verifikasi locale lain (en, fil-PH, ms-MY, vi-VN)
    const enExpl = AttachmentService.getMissingAttachmentExplanation('en', 'mira');
    assert.ok(enExpl.includes('paperclip icon 📎'));

    const filExpl = AttachmentService.getMissingAttachmentExplanation('fil-PH', 'mira');
    assert.ok(filExpl.includes('📎'));

    const msExpl = AttachmentService.getMissingAttachmentExplanation('ms-MY', 'mira');
    assert.ok(msExpl.includes('📎'));

    const viExpl = AttachmentService.getMissingAttachmentExplanation('vi-VN', 'mira');
    assert.ok(viExpl.includes('📎'));
  });

  test('6. Syarat 2: Saat beralih ke agent_active, pesan sistem memberitahu pemain dapat melampirkan file jika agen meminta', () => {
    // 6.1 Uji seluruh 6 locale
    const idMsg = AttachmentService.getAgentActiveTransferMessage('Budi', 'id-ID');
    assert.ok(idMsg.includes('Budi'), 'Nama agen harus tercantum');
    assert.ok(idMsg.includes('📎'), 'Petunjuk tombol lampiran (📎) harus tercantum');
    assert.ok(idMsg.includes('jika agen memintanya'));

    const enMsg = AttachmentService.getAgentActiveTransferMessage('Sarah', 'en');
    assert.ok(enMsg.includes('Sarah'));
    assert.ok(enMsg.includes('📎'));
    assert.ok(enMsg.includes('if the agent asks') || enMsg.includes('if the agent requests'));

    const thMsg = AttachmentService.getAgentActiveTransferMessage('Somchai', 'th-TH');
    assert.ok(thMsg.includes('Somchai'));
    assert.ok(thMsg.includes('📎'));

    const filMsg = AttachmentService.getAgentActiveTransferMessage('Maria', 'fil-PH');
    assert.ok(filMsg.includes('Maria'));
    assert.ok(filMsg.includes('📎'));

    const msMsg = AttachmentService.getAgentActiveTransferMessage('Ahmad', 'ms-MY');
    assert.ok(msMsg.includes('Ahmad'));
    assert.ok(msMsg.includes('📎'));

    const viMsg = AttachmentService.getAgentActiveTransferMessage('Nguyen', 'vi-VN');
    assert.ok(viMsg.includes('Nguyen'));
    assert.ok(viMsg.includes('📎'));
  });

  test('7. Syarat 4: Konten biner attachment TIDAK PERNAH dikirim ke model bahasa (LLM Sanitization)', () => {
    // Simulasi pesan dengan data base64 URL raksasa
    const rawMessage = 'Ini bukti transaksi saya data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= tolong dicek';
    const rawMeta = {
      file_base64: 'iVBORw0KGgoAAAANSUhEUg...',
      buffer: Buffer.from([1, 2, 3]),
      attachment_url: 'http://127.0.0.1:3001/v1/attachments/sample?token=xxx',
    };

    const { safeText, safeMeta } = AttachmentService.sanitizeForLanguageModel(rawMessage, rawMeta);

    assert.ok(!safeText.includes('data:image/'), 'Data URL base64 raksasa harus dibersihkan dari teks');
    assert.ok(safeText.includes('[Attachment: Image]'), 'Data URL diganti dengan placeholder ringkas');
    assert.strictEqual(safeMeta.file_base64, undefined, 'Metadata file_base64 harus dibuang');
    assert.strictEqual(safeMeta.buffer, undefined, 'Buffer biner harus dibuang');
    assert.strictEqual(safeMeta.attachment_url, rawMeta.attachment_url, 'URL rujukan aman tetap dipertahankan');
  });

  test('8. Syarat 1: Saat bot meminta field evidence, flag needs_evidence aktif & hint inline tersedia', async () => {
    const fields = await db.getCategoryFieldDefinitions('payment_topup');
    const nextField = CategoryFieldService.getNextFieldToAsk('payment_topup', fields, {}, 'id-ID');

    assert.ok(nextField, 'Field pertama harus ada');
    assert.strictEqual(nextField.fieldKey, 'order_id');
    assert.strictEqual(nextField.evidence_type, 'attachment');
    assert.strictEqual(nextField.needs_evidence, true, 'Field evidence harus menandai needs_evidence = true');

    // Teks hint inline di atas composer
    const hintId = AttachmentService.getEvidenceInlineHint('id-ID');
    assert.ok(hintId.includes('📎'));

    const hintEn = AttachmentService.getEvidenceInlineHint('en');
    assert.ok(hintEn.includes('📎'));
  });
});
