import { KbSearchResult } from '../types.js';

export interface LlmGenerateRequest {
  systemPrompt: string;
  locale: string;
  userMessage: string;
  history: Array<{ sender_type: string; text: string }>;
  documents: KbSearchResult[];
  toolsContext?: any[];
}

export interface LlmGenerateResponse {
  text: string;
  sources: string[];
  confidence: number;
  intent?: string;
  toolCalls?: Array<{ name: string; args: Record<string, any> }>;
}

export interface LlmClient {
  callCount: number;
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResponse>;
  resetSpy(): void;
}

const LOCALE_TEMPLATES: Record<string, { prefix: string; notFound: string; defaultReply: string }> = {
  'id-ID': {
    prefix: 'Halo kak!',
    notFound: 'Maaf kak, saat ini kami belum menemukan informasi terkait topik tersebut.',
    defaultReply: 'Halo kak! Ada yang bisa kami bantu terkait akun atau game Gaga Games?',
  },
  'th-TH': {
    prefix: 'สวัสดีค่ะ',
    notFound: 'ขออภัยค่ะ ไม่พบข้อมูลที่เกี่ยวข้องกับหัวข้อนี้',
    defaultReply: 'สวัสดีค่ะ มีอะไรให้ทางเราดูแลเพิ่มเติมไหมคะ?',
  },
  'vi-VN': {
    prefix: 'Xin chào anh/chị!',
    notFound: 'Xin lỗi anh/chị, tôi không tìm thấy thông tin liên quan.',
    defaultReply: 'Xin chào anh/chị! Tôi có thể hỗ trợ gì cho anh/chị về trò chơi Gaga Games?',
  },
  'fil-PH': {
    prefix: 'Kumusta po!',
    notFound: 'Paumanhin po, hindi ko mahanap ang impormasyon tungkol dito.',
    defaultReply: 'Kumusta po! May maipaglilingkod po ba kami sa inyo sa Gaga Games?',
  },
  'ms-MY': {
    prefix: 'Hai!',
    notFound: 'Maaf, saya tidak menjumpai maklumat berkaitan topik tersebut.',
    defaultReply: 'Hai! Ada apa-apa yang boleh kami bantu tentang permainan Gaga Games?',
  },
  'en': {
    prefix: 'Hello!',
    notFound: 'Sorry, I could not find information regarding that topic.',
    defaultReply: 'Hello! How can we assist you today with Gaga Games?',
  },
};

const DOC_TRANSLATIONS: Record<string, Record<string, { title: string; body: string }>> = {
  faq_vip_benefits: {
    'id-ID': {
      title: 'Sistem Keuntungan VIP & Hadiah Harian',
      body: 'Tier VIP yang lebih tinggi membuka peningkatan kecepatan pemulihan stamina, bingkai avatar eksklusif, bonus poin kontribusi guild, dan prioritas layanan bantuan pelanggan.',
    },
    'th-TH': {
      title: 'ระบบสิทธิพิเศษ VIP และรางวัลรายวัน',
      body: 'ระดับ VIP ที่สูงขึ้นจะช่วยเพิ่มความเร็วในการฟื้นฟู Stamina, กรอบอวาตาร์พิเศษ, คะแนนกิลด์โบนัส, และการสนับสนุนระดับพิเศษจากฝ่ายบริการลูกค้า',
    },
  },
  faq_account_link: {
    'id-ID': {
      title: 'Penautan Akun dan Pencadangan Data',
      body: 'Buka Pengaturan -> Manajemen Akun -> Tautkan Akun. Kami menyarankan untuk menautkan akun ke Google Play, Apple ID, atau Gaga Passport agar progres permainan tetap aman.',
    },
    'th-TH': {
      title: 'การเชื่อมโยงบัญชีและการสำรองข้อมูล',
      body: 'ไปที่การตั้งค่า -> การจัดการบัญชี -> เชื่อมโยงบัญชี เราแนะนำให้เชื่อมโยงบัญชีกับ Google Play, Apple ID หรือ Gaga Passport เพื่อความปลอดภัยของข้อมูลเกม',
    },
  },
};

export class MockLlmClient implements LlmClient {
  public callCount = 0;
  private overrideResponse?: Partial<LlmGenerateResponse>;

  setOverrideResponse(override?: Partial<LlmGenerateResponse>) {
    this.overrideResponse = override;
  }

  resetSpy() {
    this.callCount = 0;
    this.overrideResponse = undefined;
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResponse> {
    this.callCount++;
    const locale = request.locale || 'en';
    const template = LOCALE_TEMPLATES[locale] || LOCALE_TEMPLATES.en;

    if (this.overrideResponse) {
      return {
        text: this.overrideResponse.text ?? template.defaultReply,
        sources: this.overrideResponse.sources ?? request.documents.map((d) => d.doc_key),
        confidence: this.overrideResponse.confidence ?? 0.90,
        intent: this.overrideResponse.intent ?? 'general_inquiry',
        toolCalls: this.overrideResponse.toolCalls,
      };
    }

    // Default synthesis
    const sources = request.documents.map((d) => d.doc_key);
    if (sources.length === 0 && request.toolsContext && request.toolsContext.length > 0) {
      sources.push('tool:get_transaction');
    }
    let replyText = '';

    if (request.toolsContext && request.toolsContext.length > 0) {
      const tx = request.toolsContext[0];
      replyText = `Status transaksi untuk order ${tx.order_id || ''} berhasil diverifikasi dengan status ${tx.status || 'selesai'}.`;
    } else if (request.documents.length > 0) {
      // Prioritaskan dokumen yang cocok dengan request.locale
      const matchingDoc = request.documents.find((d) => d.locale === locale);
      const topDoc = matchingDoc || request.documents[0];

      let docBody = topDoc.body;

      // Jika dokumen berbahasa lain (misal dokumen Inggris lintas bahasa), terjemahkan ke locale tujuan
      if (topDoc.locale !== locale && DOC_TRANSLATIONS[topDoc.doc_key]?.[locale]) {
        docBody = DOC_TRANSLATIONS[topDoc.doc_key][locale].body;
      }

      // Bersihkan awalan judul/label dokumen kaku di dalam body (misal "Panduan Top-Up: ")
      const cleanBody = docBody.replace(/^[^:]{2,35}:\s*/, '').trim();

      // Deteksi konteks riwayat percakapan (follow-up question context)
      const hasPriorConversation = request.history && request.history.length > 1;
      const uMsg = (request.userMessage || '').toLowerCase();

      if (locale === 'id-ID' && topDoc.doc_key === 'faq_topup_guide') {
        if (uMsg.includes('belum masuk') || uMsg.includes('menunggu') || uMsg.includes('tunggu')) {
          replyText = 'Iya kak, biasanya masuk 1-3 menit. Kalau lewat itu belum masuk juga, kabari saya ya.';
        } else if (uMsg.includes('setelah itu') || uMsg.includes('terus gimana') || uMsg.includes('lalu gimana')) {
          replyText = 'Tinggal ditunggu aja kak, diamond-nya masuk otomatis. Kalau sudah lewat 5 menit belum masuk, kirim order ID-nya ke saya ya.';
        } else if (uMsg.includes('cara') || uMsg.includes('bagaimana') || uMsg.includes('gimana')) {
          replyText = 'Halo kak! Buka menu Store di dalam game, pilih nominal diamond-nya, terus bayar pakai QRIS, DANA, GoPay, OVO, atau transfer bank. Biasanya masuk 1-3 menit kak.';
        } else if (hasPriorConversation) {
          replyText = cleanBody;
        } else {
          replyText = `${template.prefix} ${cleanBody}`;
        }
      } else if (hasPriorConversation) {
        // Balasan lanjutan langsung ke solusi tanpa pengantar/pengulangan
        replyText = cleanBody;
      } else {
        // Balasan pertama: sapaan ramah + solusi ringkas (1-3 kalimat)
        replyText = `${template.prefix} ${cleanBody}`;
      }
    } else {
      replyText = template.notFound;
    }

    return {
      text: replyText,
      sources,
      confidence: 0.88,
      intent: 'faq_inquiry',
    };
  }
}

