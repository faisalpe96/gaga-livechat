import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

export interface AttachmentUploadResult {
  file_id: string;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  file_size: number;
  signed_url: string;
  created_at: string;
}

export class AttachmentService {
  public static readonly MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
  public static readonly MAX_FILES_PER_BATCH = 3;
  public static readonly STORAGE_DIR = path.resolve(process.cwd(), 'storage', 'attachments');
  private static readonly SIGNING_SECRET =
    process.env.ATTACHMENT_SIGNING_SECRET || 'gaga-livechat-secure-signing-secret-2026';

  /**
   * Pastikan folder storage penyimpanan file di luar web root telah tersedia.
   */
  static ensureStorageDirectory(): void {
    if (!fs.existsSync(this.STORAGE_DIR)) {
      fs.mkdirSync(this.STORAGE_DIR, { recursive: true });
    }
  }

  /**
   * MIME Sniffing pada server:
   * Membaca magic bytes dari buffer, BUKAN hanya mempercayai ekstensi atau header Content-Type dari client.
   * Hanya mengizinkan: JPEG, PNG, WebP.
   */
  static sniffMimeType(buffer: Buffer): { mimeType: string; extension: string } | null {
    if (!buffer || buffer.length < 8) {
      return null;
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mimeType: 'image/jpeg', extension: 'jpg' };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { mimeType: 'image/png', extension: 'png' };
    }

    // WebP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
    if (buffer.length >= 12) {
      const riff = buffer.subarray(0, 4).toString('ascii');
      const webp = buffer.subarray(8, 12).toString('ascii');
      if (riff === 'RIFF' && webp === 'WEBP') {
        return { mimeType: 'image/webp', extension: 'webp' };
      }
    }

    return null;
  }

  /**
   * Membersihkan EXIF dan metadata pribadi menggunakan Sharp (EXIF Stripping).
   * Melakukan re-encoding buffer tanpa metadata sensor/GPS/kamera.
   */
  static async stripExifAndSanitize(buffer: Buffer): Promise<{
    sanitizedBuffer: Buffer;
    mimeType: string;
    extension: string;
    width?: number;
    height?: number;
  }> {
    const sniffResult = this.sniffMimeType(buffer);
    if (!sniffResult) {
      throw new Error('INVALID_MIME_TYPE: File harus berformat gambar valid (JPEG, PNG, atau WebP)');
    }

    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      if (!metadata.format) {
        throw new Error('CORRUPT_IMAGE: Metadata gambar tidak dapat dibaca');
      }

      // sharp().rotate() memutar orientasi sesuai EXIF sebelum menghapus semua metadata EXIF
      // Default sharp output TIDAK menyertakan EXIF kecuali .withMetadata() dipanggil
      const sanitizedBuffer = await image.rotate().toBuffer();

      return {
        sanitizedBuffer,
        mimeType: sniffResult.mimeType,
        extension: sniffResult.extension,
        width: metadata.width,
        height: metadata.height,
      };
    } catch (err: any) {
      throw new Error(`IMAGE_PROCESSING_FAILED: ${err.message}`);
    }
  }

  /**
   * Buat Signed URL berbatas waktu (HMAC-SHA256) untuk akses file aman di luar web root.
   */
  static generateSignedUrl(
    fileId: string,
    filename: string,
    expiresInSec = 3600,
    baseUrl = ''
  ): string {
    const expires = Math.floor(Date.now() / 1000) + expiresInSec;
    const dataToSign = `${fileId}:${filename}:${expires}`;
    const token = crypto
      .createHmac('sha256', this.SIGNING_SECRET)
      .update(dataToSign)
      .digest('hex');

    const cleanBase = baseUrl.replace(/\/+$/, '');
    const encodedFilename = encodeURIComponent(filename);
    return `${cleanBase}/v1/attachments/${fileId}?filename=${encodedFilename}&expires=${expires}&token=${token}`;
  }

  /**
   * Verifikasi Signed URL (cek token HMAC dan masa kadaluarsa).
   */
  static verifySignedUrl(
    fileId: string,
    filename: string,
    expires: number,
    token: string
  ): { valid: boolean; reason?: string } {
    const now = Math.floor(Date.now() / 1000);
    if (now > expires) {
      return { valid: false, reason: 'URL_EXPIRED' };
    }

    const dataToSign = `${fileId}:${filename}:${expires}`;
    const expectedToken = crypto
      .createHmac('sha256', this.SIGNING_SECRET)
      .update(dataToSign)
      .digest('hex');

    try {
      const tokenBuf = Buffer.from(token, 'utf8');
      const expectedBuf = Buffer.from(expectedToken, 'utf8');
      if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        return { valid: false, reason: 'INVALID_SIGNATURE' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }
  }

  /**
   * Simpan attachment dengan semua aturan keamanan:
   * 1. Validasi ukuran (max 5MB)
   * 2. MIME sniffing
   * 3. EXIF stripping via Sharp
   * 4. Simpan di luar web root (`storage/attachments`)
   * 5. Buat Signed URL
   */
  static async saveAttachment(
    rawBuffer: Buffer,
    originalFilename: string,
    baseUrl = ''
  ): Promise<AttachmentUploadResult> {
    if (rawBuffer.length > this.MAX_FILE_SIZE_BYTES) {
      throw new Error(`FILE_TOO_LARGE: Ukuran file (${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB) melebihi batas 5 MB`);
    }

    const { sanitizedBuffer, mimeType, extension } = await this.stripExifAndSanitize(rawBuffer);

    this.ensureStorageDirectory();

    const fileId = crypto.randomUUID();
    const safeBaseName = path.basename(originalFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskFilename = `${fileId}.${extension}`;
    const filePath = path.join(this.STORAGE_DIR, diskFilename);

    await fs.promises.writeFile(filePath, sanitizedBuffer);

    const signedUrl = this.generateSignedUrl(fileId, safeBaseName || `attachment.${extension}`, 3600, baseUrl);

    return {
      file_id: fileId,
      original_filename: originalFilename,
      safe_filename: safeBaseName,
      mime_type: mimeType,
      file_size: sanitizedBuffer.length,
      signed_url: signedUrl,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Ambil path file fisik di storage dari fileId jika valid.
   */
  static getAttachmentFilePath(fileId: string): string | null {
    this.ensureStorageDirectory();
    // Cari file yang dimulai dengan fileId
    const files = fs.readdirSync(this.STORAGE_DIR);
    const matched = files.find((f) => f.startsWith(fileId));
    if (!matched) return null;
    return path.join(this.STORAGE_DIR, matched);
  }

  /**
   * Memeriksa apakah pesan pemain menyatakan sudah mengirim foto/bukti
   * seperti "sudah saya kirim", "ini fotonya", dsb.
   */
  static isClaimingSentAttachment(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();

    const CLAIM_PATTERNS: RegExp[] = [
      /sudah (saya |aku |ku |di)?(kirim|hantar)/i,
      /(udah|udh) (di|ku)?(kirim|hantar)/i,
      /ini foto(nya)?/i,
      /ini (bukti|screenshot|struk|gambar|lampiran)(nya)?/i,
      /tuh (foto|gambar|struk|bukti)/i,
      /cek (foto|bukti|struk|screenshot|gambar)/i,
      /sudah diupload/i,
      /udah diupload/i,
      /already sent/i,
      /i (already )?sent it/i,
      /sent (the |it )?(photo|screenshot|picture|image|receipt|proof)/i,
      /here('s| is) the (photo|screenshot|picture|image|receipt|proof)/i,
      /attached/i,
      /ส่ง(ไป)?แล้ว/,
      /นี่(รูป|สลิป|หลักฐาน)/,
      /แนบ(รูป|ไฟล์)แล้ว/,
      /naipadala ko na/i,
      /napadala ko na/i,
      /na-?send ko na/i,
      /ito (yung|ang) (picture|screenshot|resibo|larawan|patunay)/i,
      /nandito ang (picture|screenshot)/i,
      /dah hantar/i,
      /sudah hantar/i,
      /đã gửi( rồi)?/i,
      /đây là (ảnh|hình|biên lai|bằng chứng)/i,
    ];

    return CLAIM_PATTERNS.some((p) => p.test(trimmed));
  }

  /**
   * Penjelasan ramah saat pemain bilang sudah kirim tapi tidak ada attachment yang terdeteksi (Syarat 3).
   * Bot TIDAK MENGULANG pertanyaannya secara verbatim, melainkan memberitahu bahwa file belum masuk
   * dan memandu cara menggunakan tombol lampiran (📎).
   */
  static getMissingAttachmentExplanation(locale = 'id-ID', botPersona = 'mira'): string {
    const isReza = (botPersona || '').toLowerCase() === 'reza';

    switch (locale) {
      case 'th-TH':
        return isReza
          ? 'ดูเหมือนว่าระบบยังไม่ได้รับไฟล์หรือภาพหน้าจอของคุณครับ รบกวนส่งหลักฐานอีกครั้งโดยกดที่ปุ่มแนบไฟล์ (ไอคอนคลิปหนีบกระดาษ 📎 ข้างช่องพิมพ์ข้อความ) นะครับ'
          : 'ดูเหมือนว่าระบบยังไม่ได้รับไฟล์หรือภาพหน้าจอของคุณค่ะ รบกวนส่งหลักฐานอีกครั้งโดยกดที่ปุ่มแนบไฟล์ (ไอคอนคลิปหนีบกระดาษ 📎 ข้างช่องพิมพ์ข้อความ) นะคะ';
      case 'fil-PH':
        return 'Mukhang hindi po nakapasok ang file o screenshot sa aming system. Mangyaring ipadala muli ang inyong patunay gamit ang pindutan ng attachment (icon ng paperclip 📎 sa tabi ng mensahe).';
      case 'ms-MY':
        return 'Fail atau tangkapan skrin yang anda maksudkan belum diterima oleh sistem kami. Sila muat naik bukti anda menggunakan butang lampiran (ikon klip kertas 📎 di sebelah kotak teks ya).';
      case 'vi-VN':
        return 'Có vẻ như hệ thống chưa nhận được tệp hoặc ảnh chụp màn hình của bạn. Vui lòng gửi lại bằng chứng bằng cách nhấn vào nút đính kèm (biểu tượng kẹp giấy 📎 bên cạnh khung soạn tin nhắn nhé).';
      case 'en':
        return 'It looks like no file or screenshot came through with your message. Please upload your proof using the attachment button (the paperclip icon 📎 next to the message field).';
      case 'id-ID':
      default:
        return 'File atau gambar bukti transaksi kakak belum masuk ke sistem kami. Silakan kirimkan kembali bukti tersebut menggunakan tombol lampiran (ikon klip kertas 📎 di sebelah kolom ketik pesan ya kak).';
    }
  }

  /**
   * Pesan sistem saat percakapan beralih ke agent_active (Syarat 2).
   * Memberitahu pemain bahwa mereka dapat melampirkan file jika agen memintanya.
   */
  static getAgentActiveTransferMessage(agentName = 'Support Agent', locale = 'id-ID'): string {
    switch (locale) {
      case 'th-TH':
        return `การสนทนาถูกโอนไปยังเจ้าหน้าที่ ${agentName} เรียบร้อยแล้ว คุณสามารถแนบไฟล์หรือภาพหน้าจอโดยใช้ปุ่มแนบไฟล์ (📎) หากเจ้าหน้าที่ร้องขอ`;
      case 'fil-PH':
        return `Nailipat na ang pag-uusap kay ahente ${agentName}. Maaari kang maglakip ng mga file o screenshot gamit ang pindutan ng attachment (📎) kung hihilingin ng ahente.`;
      case 'ms-MY':
        return `Perbualan kini dipindahkan kepada ejen ${agentName}. Anda boleh melampirkan fail atau tangkapan skrin menggunakan butang lampiran (📎) jika ejen meminta.`;
      case 'vi-VN':
        return `Cuộc trò chuyện đã được chuyển đến nhân viên ${agentName}. Bạn có thể đính kèm tệp hoặc ảnh chụp màn hình bằng nút đính kèm (📎) nếu nhân viên yêu cầu.`;
      case 'en':
        return `Conversation transferred to agent ${agentName}. You can attach files or screenshots using the attachment button (📎) if the agent asks for them.`;
      case 'id-ID':
      default:
        return `Percakapan kini dialihkan ke agen ${agentName}. Anda dapat melampirkan file atau tangkapan layar menggunakan tombol lampiran (📎) jika agen memintanya.`;
    }
  }

  /**
   * Teks hint inline di atas composer saat bot meminta bukti (Syarat 1).
   */
  static getEvidenceInlineHint(locale = 'id-ID'): string {
    switch (locale) {
      case 'th-TH':
        return 'คำแนะนำ: กดปุ่มคลิปหนีบกระดาษ (📎) เพื่อแนบภาพหน้าจอหรือสลิปหลักฐาน';
      case 'fil-PH':
        return 'Tip: Pindutin ang paperclip button (📎) para maglakip ng screenshot o resibo';
      case 'ms-MY':
        return 'Tip: Tekan butang klip kertas (📎) untuk melampirkan gambar resit atau tangkapan skrin';
      case 'vi-VN':
        return 'Mẹo: Nhấn vào biểu tượng kẹp giấy (📎) để đính kèm ảnh chụp màn hình hoặc biên lai';
      case 'en':
        return 'Tip: Tap the paperclip button (📎) to attach your screenshot or receipt';
      case 'id-ID':
      default:
        return 'Tips: Klik tombol klip kertas (📎) untuk melampirkan foto/screenshot bukti';
    }
  }

  /**
   * Memastikan konten biner attachment TIDAK PERNAH dikirim ke model bahasa (Syarat 4).
   * Hanya metadata atau teks ringkas yang diteruskan.
   */
  static sanitizeForLanguageModel(text: string, meta?: any): { safeText: string; safeMeta: any } {
    let safeText = text || '';

    // Buang base64 data URLs raksasa jika ada yang menyusup ke text
    if (safeText.includes('data:image/')) {
      safeText = safeText.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[Attachment: Image]');
    }

    const safeMeta = { ...(meta || {}) };
    delete safeMeta.file_base64;
    delete safeMeta.buffer;
    delete safeMeta.raw_data;

    return { safeText, safeMeta };
  }
}
