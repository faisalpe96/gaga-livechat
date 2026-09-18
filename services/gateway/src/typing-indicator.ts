/**
 * Modul Typing Indicator Gaga LiveChat
 * Mengelola kalkulasi jeda pengetikan alami (natural delay),
 * deteksi pemicu keras (hard trigger) untuk mencegah indikator palsu,
 * dan pesan fallback saat terjadi error/timeout.
 */

export interface TypingDelayOptions {
  enabled?: boolean;
  msPerChar?: number;
  minMs?: number;
  maxMs?: number;
}

/**
 * Menghitung durasi jeda pengetikan alami (Typing Delay) berdasarkan panjang karakter teks balasan.
 * Skala: kira-kira 40 sampai 60 ms per karakter (default: 50 ms).
 * Batas: minimum 800 ms dan maksimum 3000 ms (3 detik).
 */
export function calculateTypingDelay(
  textLength: number,
  msPerChar: number = 50,
  minMs: number = 800,
  maxMs: number = 3000
): number {
  if (textLength <= 0) return minMs;
  const raw = textLength * msPerChar;
  return Math.min(maxMs, Math.max(minMs, raw));
}

/**
 * Memeriksa apakah pesan pemain merupakan pemicu keras (hard trigger) atau permintaan handoff,
 * di mana bot TIDAK AKAN membalas dengan jawaban biasa (langsung eskalasi ke agen manusia).
 * Dalam kasus ini, indikator pengetikan TIDAK BOLEH dimunculkan sama sekali.
 */
export function isHardTriggerMessage(
  text: string,
  locale = 'id-ID',
  guardrailEngine?: any
): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  // 1. Evaluasi melalui GuardrailEngine jika tersedia
  if (guardrailEngine?.checkHardTrigger) {
    const hardMatch = guardrailEngine.checkHardTrigger(lower, locale);
    if (hardMatch?.matched) return true;
  }
  if (guardrailEngine?.checkSoftTrigger) {
    const softMatch = guardrailEngine.checkSoftTrigger(lower, locale);
    if (softMatch?.matched && softMatch.ruleKey === 'minta_manusia') return true;
  }

  // 2. Daftar frasa pemicu keras (Hard Triggers & Human Escalation)
  const hardTriggerPatterns = [
    // Refund
    'refund', 'pengembalian dana', 'kembalikan uang', 'tarik uang', 'minta uang kembali',
    // Banned / Blokir
    'banned', 'unban', 'blokir', 'terblokir', 'diblokir', 'sanksi akun', 'banding banned',
    // Akun terkunci / Hack
    'terkunci', 'kena hack', 'dihack', 'di-hack', 'diretas', 'akun hilang', 'lupa kata sandi akun terkunci',
    // Bahaya diri
    'bunuh diri', 'ingin mati', 'akhiri hidup', 'suicide', 'kill myself',
    // Pembelian anak
    'anak saya beli', 'dibeli anak', 'pembelian tanpa izin anak', 'anak tidak sengaja beli',
    // Hukum / Media
    'somasi', 'polisi', 'lapor polisi', 'jalur hukum', 'pengacara', 'lapor media', 'viral',
    // Minta CS Manusia
    'cs manusia', 'hubungkan dengan cs', 'hubungkan ke cs', 'bicara dengan cs', 'panggil cs', 'live agent', 'human agent',
  ];

  return hardTriggerPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * Pesan fallback manusiawi jika pemrosesan AI mengalami kendala teknis atau timeout,
 * agar indikator tidak berputar selamanya dan pemain tetap terinformasi dengan sopan.
 */
export function getGracefulFallbackMessage(locale = 'id-ID', _botPersona = 'mira'): string {
  const fallbacks: Record<string, string> = {
    'id-ID': 'Maaf, sistem kami sedang mengalami sedikit kendala teknis. Mohon tunggu sebentar atau kirim ulang pesan Anda, ya.',
    'en': 'Sorry, our system is experiencing a brief technical issue. Please wait a moment or send your message again.',
    'th-TH': 'ขออภัย ระบบกำลังประสบปัญหาทางเทคนิคชั่วคราว โปรดรอสักครู่หรือลองใหม่อีกครั้ง',
    'vi-VN': 'Xin lỗi, hệ thống đang gặp sự cố kỹ thuật tạm thời. Vui lòng thử lại sau giây lát.',
    'fil-PH': 'Paumanhin, may kaunting aberya sa teknikal ang aming system. Mangyaring subukang muli mamaya.',
    'ms-MY': 'Maaf, sistem kami sedang mengalami masalah teknikal sementara. Sila tunggu sebentar atau cuba lagi.',
  };
  return fallbacks[locale] || fallbacks['id-ID'];
}
