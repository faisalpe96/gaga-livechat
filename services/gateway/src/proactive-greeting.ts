/**
 * Proactive Opening Greeting Generator
 * Mendukung 6 Locale SEA, Personalisasi Nickname & Page Context,
 * Serta Mode Luar Jam Kerja (spec/07-mode-luar-jam.md & spec/08-persona-bot.md).
 */

export interface ProactiveGreetingParams {
  locale: string;
  persona: 'mira' | 'reza' | string;
  player?: {
    uid?: string;
    nickname?: string;
    [key: string]: any;
  } | null;
  pageContext?: {
    page?: string;
    path?: string;
    [key: string]: any;
  } | string | null;
  serviceMode?: 'business_hours' | 'after_hours';
  afterHoursInfo?: {
    next_open_time?: string;
    city?: string;
  } | null;
}

const DEFAULT_NICKNAMES: Record<string, string> = {
  'id-ID': 'Pemain',
  'th-TH': 'คุณผู้เล่น',
  'fil-PH': 'Player',
  'ms-MY': 'Pemain',
  'vi-VN': 'bạn',
  'en': 'Player',
};

const DEFAULT_CITIES: Record<string, string> = {
  'id-ID': 'Jakarta',
  'th-TH': 'Bangkok',
  'fil-PH': 'Manila',
  'ms-MY': 'Kuala Lumpur',
  'vi-VN': 'Ho Chi Minh',
  'en': 'Jakarta',
};

/**
 * Mendeteksi apakah page context berhubungan dengan transaksi top-up / pembayaran diamond.
 */
export function isTopUpPageContext(pageContext?: any): boolean {
  if (!pageContext) return false;
  const pageStr = typeof pageContext === 'string'
    ? pageContext
    : (pageContext.page || pageContext.path || pageContext.url || '');
  return /topup|top-up|diamond|payment|pembayaran|store|beli|recharge|tambah-nilai|nap-tien/i.test(pageStr);
}

/**
 * Menghasilkan pesan pembuka proaktif (Proactive Opening Greeting).
 */
export function generateProactiveGreeting(params: ProactiveGreetingParams): string {
  const normLocale = params.locale || 'id-ID';
  const isReza = (params.persona || '').toLowerCase() === 'reza';
  const rawNickname = params.player?.nickname?.trim();
  const nickname = rawNickname || DEFAULT_NICKNAMES[normLocale] || DEFAULT_NICKNAMES.en;

  const isAfterHours = params.serviceMode === 'after_hours';
  const openTime = params.afterHoursInfo?.next_open_time || '09.00';
  const city = params.afterHoursInfo?.city || DEFAULT_CITIES[normLocale] || 'Jakarta';

  // =========================================================================
  // KONDISI 1: Mode Luar Jam (spec/07-mode-luar-jam.md) - Prioritas Utama
  // =========================================================================
  if (isAfterHours) {
    switch (normLocale) {
      case 'id-ID':
        return `Halo ${nickname}! Tim support kami sedang tidak bertugas dan akan kembali pukul ${openTime} waktu ${city}. Saya bisa bantu sekarang untuk banyak hal — jika butuh tim manusia, saya buatkan tiket dan mereka akan membalas begitu buka. Ada yang bisa saya bantu?`;

      case 'th-TH':
        return isReza
          ? `สวัสดีครับคุณ ${nickname}! ขณะนี้ทีมงานซัพพอร์ตอยู่นอกเวลาทำการและจะกลับมาให้บริการเวลา ${openTime} (เวลา${city}) ผมสามารถช่วยเหลือในเรื่องต่างๆ ได้ในตอนนี้ หรือสร้างตั๋วประสานงานไว้ให้ทีมงานติดต่อกลับได้ครับ มีอะไรให้ผมช่วยดูแลไหมครับ?`
          : `สวัสดีค่ะคุณ ${nickname}! ขณะนี้ทีมงานซัพพอร์ตอยู่นอกเวลาทำการและจะกลับมาให้บริการเวลา ${openTime} (เวลา${city}) ฉันสามารถช่วยเหลือในเรื่องต่างๆ ได้ในตอนนี้ หรือสร้างตั๋วประสานงานไว้ให้ทีมงานติดต่อกลับได้ค่ะ มีอะไรให้ฉันช่วยดูแลไหมคะ?`;

      case 'fil-PH':
        return `Kumusta ${nickname}! Ang aming support team ay kasalukuyang offline at magbabalik ng ${openTime} oras sa ${city}. Matutulungan kita ngayon sa maraming bagay — kung kailangan mo ng tao, gagawa ako ng ticket para sagutin nila sa pagbukas. May maitutulong ba ako sa iyo?`;

      case 'ms-MY':
        return `Hai ${nickname}! Pasukan sokongan kami sedang di luar waktu operasi dan akan kembali pada jam ${openTime} waktu ${city}. Saya boleh bantu anda sekarang untuk pelbagai perkara — jika perlukan bantuan manusia, saya buatkan tiket untuk dibalas sebaik sahaja operasi bermula. Ada apa-apa yang boleh saya bantu?`;

      case 'vi-VN':
        return `Xin chào ${nickname}! Đội ngũ hỗ trợ của chúng tôi hiện đang ngoài giờ làm việc và sẽ quay lại lúc ${openTime} theo giờ ${city}. Tôi có thể hỗ trợ bạn nhiều vấn đề ngay lúc này — nếu cần nhân viên, tôi sẽ tạo phiếu hỗ trợ để họ phản hồi ngay khi mở lại. Tôi có thể giúp gì cho bạn?`;

      case 'en':
      default:
        return `Hello ${nickname}! Our support team is currently offline and will return at ${openTime} ${city} time. I can assist you right now with most issues, or create a ticket for the team as soon as they open. How may I help you today?`;
    }
  }

  // =========================================================================
  // KONDISI 2: Jam Kerja Normal (Business Hours)
  // =========================================================================
  const isTopUp = isTopUpPageContext(params.pageContext);

  if (isTopUp) {
    // Varian Konteks Halaman Top-up
    switch (normLocale) {
      case 'id-ID':
        return `Halo ${nickname}! Ada kendala seputar transaksi top-up atau pembelian item yang sedang kamu alami hari ini?`;

      case 'th-TH':
        return isReza
          ? `สวัสดีครับคุณ ${nickname}! มีปัญหาเกี่ยวกับการทำรายการเติมเงินหรือซื้อไอเทมที่ต้องการให้ผมช่วยดูแลไหมครับ?`
          : `สวัสดีค่ะคุณ ${nickname}! มีปัญหาเกี่ยวกับการทำรายการเติมเงินหรือซื้อไอเทมที่ต้องการให้ฉันช่วยดูแลไหมคะ?`;

      case 'fil-PH':
        return `Kumusta ${nickname}! May nararanasan ka bang problema sa iyong top-up o pagbili ng item na maitutulong ko ngayon?`;

      case 'ms-MY':
        return `Hai ${nickname}! Ada sebarang masalah transaksi tambah nilai (top-up) atau pembelian yang boleh saya bantu hari ini?`;

      case 'vi-VN':
        return `Xin chào ${nickname}! Bạn có gặp vấn đề gì về giao dịch nạp tiền hoặc vật phẩm cần tôi hỗ trợ hôm nay không?`;

      case 'en':
      default:
        return `Hello ${nickname}! Are you experiencing any issues with your top-up or purchase that I can assist with today?`;
    }
  }

  // Varian Konteks Halaman Umum (Generic)
  switch (normLocale) {
    case 'id-ID':
      return `Halo ${nickname}! Selamat datang di Gaga Live Support, ada yang bisa saya bantu terkait game atau akunmu hari ini?`;

    case 'th-TH':
      return isReza
        ? `สวัสดีครับคุณ ${nickname}! ยินดีต้อนรับสู่ Gaga Live Support มีอะไรเกี่ยวกับการเล่นเกมหรือบัญชีให้ผมช่วยดูแลไหมครับ?`
        : `สวัสดีค่ะคุณ ${nickname}! ยินดีต้อนรับสู่ Gaga Live Support มีอะไรเกี่ยวกับการเล่นเกมหรือบัญชีให้ฉันช่วยดูแลไหมคะ?`;

    case 'fil-PH':
      return `Kumusta ${nickname}! Maligayang pagdating sa Gaga Live Support, may maitutulong ba ako sa iyong laro o account ngayon?`;

    case 'ms-MY':
      return `Hai ${nickname}! Selamat datang ke Gaga Live Support, ada apa-apa yang boleh saya bantu mengenai akaun atau permainan anda hari ini?`;

    case 'vi-VN':
      return `Xin chào ${nickname}! Chào mừng bạn đến với Gaga Live Support, tôi có thể giúp gì cho tài khoản hoặc trải nghiệm game của bạn hôm nay?`;

    case 'en':
    default:
      return `Hello ${nickname}! Welcome to Gaga Live Support, how can I help you with your account or gameplay today?`;
  }
}
