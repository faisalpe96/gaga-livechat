import { ConversationStage } from '../types.js';

export interface SlotDefinition {
  key: string;
  name: string;
  prompts: Record<string, string>;
  extract: (text: string, isTargetSlot?: boolean) => string | null;
}

export interface SlotCollectionState {
  currentStage: ConversationStage;
  collectedSlots: Record<string, string>;
  missingSlots: string[];
  nextSlotToAsk?: string;
  questionText?: string;
  isComplete: boolean;
}

// 1. Skema Pengumpulan Data untuk Keluhan Top-Up Belum Masuk (topup_uncredited)
// Aturan: Ditanyakan SATU PER SATU secara berurutan, bukan sekaligus!
export const TOPUP_UNCREDITED_SLOTS: SlotDefinition[] = [
  {
    key: 'order_id',
    name: 'Nomor Order ID / Transaksi',
    prompts: {
      'id-ID': 'Boleh minta nomor Order ID atau bukti transaksinya kak? (Contoh: order_123 atau nomor pesanan di Google Play / Store)',
      'th-TH': 'ขอทราบหมายเลขคำสั่งซื้อ (Order ID) หรือรหัสธุรกรรมด้วยค่ะ (เช่น order_123 หรือรหัสจากสโตร์)',
      'vi-VN': 'Anh/chị vui lòng cung cấp Mã đơn hàng (Order ID) hoặc mã giao dịch giúp tôi nhé (ví dụ: order_123)?',
      'fil-PH': 'Maaari po bang makuha ang inyong Order ID o transaction number? (Halimbawa: order_123)',
      'ms-MY': 'Boleh kongsikan nombor Order ID atau rujukan transaksi anda? (Contoh: order_123)',
      'en': 'Could you please provide your Order ID or transaction reference? (e.g. order_123 or Store order number)',
    },
    extract: (text: string, isTargetSlot = false): string | null => {
      // 1. Pola dengan prefix order_ atau order- atau ord_ (misal: order_998877, order-12345)
      const prefixedMatch = text.match(/\b(order[_-][a-zA-Z0-9_-]+|ord[_-][a-zA-Z0-9_-]+)\b/i);
      if (prefixedMatch) return prefixedMatch[1].trim();

      // 2. Pola GPA Google Play
      const gpaMatch = text.match(/\b(GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5})\b/i);
      if (gpaMatch) return gpaMatch[1].trim();

      // 3. Pola Invoice / TRX eksplisit
      const invMatch = text.match(/\b((?:INV|TRX)[a-zA-Z0-9/-]{4,})\b/i);
      if (invMatch) return invMatch[1].trim();

      // 4. Pola order diikuti angka/kode (misal: order #123456, nomor order 987654)
      const orderNumMatch = text.match(/\border\s*(?:id|nomor|no)?\s*[:=]?\s*#?([a-zA-Z0-9_-]{5,})\b/i);
      if (orderNumMatch && !/^(saya|kamu|kak|min|ini|nya|adalah)$/i.test(orderNumMatch[1])) {
        return orderNumMatch[1].trim();
      }

      // 5. Jika pemain sedang ditanyai khusus slot order_id
      if (isTargetSlot) {
        const cleaned = text.trim();
        // Bersihkan awalan umum seperti "Order ID saya ", "ini kak ", dsb.
        const candidate = cleaned
          .replace(/^(order\s*id\s*saya|id\s*order\s*saya|nomor\s*order\s*saya|ini\s*kak|id\s*order\s*nya|nomor\s*order\s*nya|order\s*id\s*nya|order\s*id|no\s*pesanan)\s*[:=]?\s*/i, '')
          .replace(/\s*(kak|min|ya|gan|dong)$/i, '')
          .trim();
        const words = candidate.split(/\s+/);
        if (words.length <= 3 && candidate.length >= 4 && !/^(tidak|belum|lupa|gatau|nggak|bukan|order\s+id)$/i.test(candidate)) {
          return candidate;
        }
      }
      return null;
    },
  },
  {
    key: 'amount',
    name: 'Nominal Top-Up / Jumlah Diamond',
    prompts: {
      'id-ID': 'Boleh tahu nominal top-up atau jumlah diamond yang dibeli kak?',
      'th-TH': 'ขอทราบยอดเงินที่เติม หรือจำนวนเพชรที่สั่งซื้อด้วยค่ะ',
      'vi-VN': 'Anh/chị cho tôi biết số tiền nạp hoặc số lượng kim cương đã mua được không ạ?',
      'fil-PH': 'Magkano po ang halaga ng top-up o ilang diamonds po ang binili ninyo?',
      'ms-MY': 'Boleh tahu berapa jumlah bayaran atau bilangan diamond yang dibeli?',
      'en': 'Could you let us know the top-up amount or number of diamonds purchased?',
    },
    extract: (text: string, isTargetSlot = false): string | null => {
      // 50rb, 100k, 50 ribu, 100 diamond, Rp 50.000, 50000
      const pattern = /\b([0-9]+(?:[.,][0-9]{3})*\s*(?:rb|ribu|k|diamond|dm|idr|rp|baht|vnd|php)?)\b/i;
      const match = text.match(pattern);
      if (match && (text.toLowerCase().includes('diamond') || text.toLowerCase().includes('rb') || text.toLowerCase().includes('ribu') || text.toLowerCase().includes('k') || text.toLowerCase().includes('rp') || isTargetSlot)) {
        const candidate = match[1].trim();
        if (candidate.length >= 2) return candidate;
      }
      if (isTargetSlot) {
        const cleaned = text.replace(/^(nominalnya|nominal|jumlahnya|sebesar)\s*[:=]?\s*/i, '').trim();
        if (cleaned.length >= 2 && cleaned.length <= 40) return cleaned;
      }
      return null;
    },
  },
  {
    key: 'payment_method',
    name: 'Metode Pembayaran',
    prompts: {
      'id-ID': 'Boleh dibantu metode pembayaran apa yang digunakan kak? (Contoh: QRIS, DANA, GoPay, OVO, atau transfer bank)',
      'th-TH': 'ชำระเงินผ่านช่องทางใดคะ (เช่น PromptPay, TrueMoney, โอนธนาคาร หรือบัตรเครดิต)',
      'vi-VN': 'Anh/chị đã thanh toán qua phương thức nào ạ? (Ví dụ: MoMo, ZaloPay, chuyển khoản ngân hàng hoặc thẻ)',
      'fil-PH': 'Anong paraan po ng pagbabayad ang ginamit ninyo? (Halimbawa: GCash, Maya, bank transfer, o load)',
      'ms-MY': 'Kaedah pembayaran apa yang digunakan ya? (Contoh: Touch \'n Go, perbankan atas talian, kad kredit)',
      'en': 'Which payment method did you use? (e.g. QRIS, e-wallet, bank transfer, or Google Play)',
    },
    extract: (text: string, isTargetSlot = false): string | null => {
      const methods = [
        'qris', 'dana', 'gopay', 'ovo', 'shopeepay', 'shopee pay', 'bca', 'mandiri',
        'bri', 'bni', 'transfer bank', 'bank transfer', 'pulsa', 'telkomsel', 'indosat',
        'xl', 'google play', 'apple pay', 'promptpay', 'truemoney', 'momo', 'zalopay',
        'gcash', 'maya', 'credit card', 'kartu kredit', 'codashop', 'unipin', 'seabank'
      ];
      const cleaned = text.toLowerCase();
      for (const m of methods) {
        if (cleaned.includes(m)) {
          // Kembalikan nama metode dengan huruf rapi
          return m.toUpperCase();
        }
      }
      if (isTargetSlot) {
        const cleanedMethod = text.replace(/^(pakai|pake|via|lewat|menggunakan|melalui)\s*/i, '').trim();
        if (cleanedMethod.length >= 2 && cleanedMethod.length <= 30) {
          return cleanedMethod;
        }
      }
      return null;
    },
  },
  {
    key: 'transaction_time',
    name: 'Waktu / Jam Transaksi',
    prompts: {
      'id-ID': 'Kira-kira sekitar jam berapa transaksinya dilakukan ya kak?',
      'th-TH': 'ทำรายการชำระเงินไปประมาณช่วงเวลากี่โมงคะ',
      'vi-VN': 'Giao dịch được thực hiện vào khoảng mấy giờ vậy anh/chị?',
      'fil-PH': 'Mga anong oras po ginawa ang transaksyon?',
      'ms-MY': 'Kira-kira pukul berapa transaksi tersebut dibuat?',
      'en': 'Around what time was the transaction completed?',
    },
    extract: (text: string, isTargetSlot = false): string | null => {
      const timePatterns = [
        /(?:jam|pukul)\s*[0-9]{1,2}(?:[:.][0-9]{2})?\s*(?:pagi|siang|sore|malam|wib|wita|wit)?/i,
        /\b[0-9]{1,2}[:.][0-9]{2}\s*(?:am|pm|wib)?\b/i,
        /(?:tadi|kemarin)\s*(?:pagi|siang|sore|malam|[0-9]+\s*(?:menit|jam)\s*lalu)?/i,
        /\baround\s*[0-9]{1,2}(?:[:.][0-9]{2})?\s*(?:am|pm)?/i,
      ];
      for (const p of timePatterns) {
        const match = text.match(p);
        if (match) return match[0].trim();
      }
      if (isTargetSlot) {
        const candidate = text.replace(/^(sekitar|jam|pukul|pada|waktu)\s*/i, '').trim();
        if (candidate.length >= 2 && candidate.length <= 40) {
          return candidate;
        }
      }
      return null;
    },
  },
];

export class ConversationFlowManager {
  /**
   * Ekstrak slot yang tersedia dari pesan pemain dan gabungkan dengan yang sudah ada.
   */
  extractSlots(
    message: string,
    existingSlots: Record<string, string> = {},
    targetSlotKey?: string
  ): Record<string, string> {
    const updated = { ...existingSlots };

    for (const slot of TOPUP_UNCREDITED_SLOTS) {
      // Jika slot belum terisi, coba ekstrak
      if (!updated[slot.key]) {
        const isTarget = slot.key === targetSlotKey;
        const val = slot.extract(message, isTarget);
        if (val) {
          updated[slot.key] = val;
        }
      }
    }

    return updated;
  }

  /**
   * Evaluasi status pengumpulan slot bertahap (Sequential Slot Filling).
   */
  evaluateSlotProgress(
    collectedSlots: Record<string, string>,
    locale = 'id-ID'
  ): SlotCollectionState {
    const missingSlots: string[] = [];

    for (const slot of TOPUP_UNCREDITED_SLOTS) {
      if (!collectedSlots[slot.key]) {
        missingSlots.push(slot.key);
      }
    }

    if (missingSlots.length === 0) {
      return {
        currentStage: 'resolution',
        collectedSlots,
        missingSlots: [],
        isComplete: true,
      };
    }

    // Ambil slot PERTAMA yang belum lengkap (ditanyakan satu per satu)
    const nextSlotKey = missingSlots[0];
    const slotDef = TOPUP_UNCREDITED_SLOTS.find((s) => s.key === nextSlotKey)!;
    const questionText =
      slotDef.prompts[locale] || slotDef.prompts['id-ID'] || slotDef.prompts['en'];

    return {
      currentStage: 'data_collection',
      collectedSlots,
      missingSlots,
      nextSlotToAsk: nextSlotKey,
      questionText,
      isComplete: false,
    };
  }

  /**
   * Susun pesan rangkuman data setelah semua slot berhasil dikumpulkan.
   */
  buildCompletionSummary(collectedSlots: Record<string, string>, locale = 'id-ID'): string {
    const orderId = collectedSlots.order_id || '-';
    const amount = collectedSlots.amount || '-';
    const payment = collectedSlots.payment_method || '-';
    const time = collectedSlots.transaction_time || '-';

    switch (locale) {
      case 'th-TH':
        return `ขอบคุณสำหรับข้อมูลค่ะ ทางเราได้รับรายละเอียดธุรกรรมเรียบร้อยแล้ว:
- หมายเลขคำสั่งซื้อ: ${orderId}
- ยอดเงิน / จำนวนเพชร: ${amount}
- ช่องทางชำระเงิน: ${payment}
- เวลาทำรายการ: ${time}

ทางเรากำลังส่งเรื่องตรวจสอบกับระบบการชำระเงิน กรุณารอสักครู่นะคะ`;
      case 'vi-VN':
        return `Cảm ơn anh/chị đã cung cấp thông tin! Chúng tôi đã ghi nhận:
- Mã đơn hàng: ${orderId}
- Số tiền / Kim cương: ${amount}
- Phương thức thanh toán: ${payment}
- Thời gian giao dịch: ${time}

Hệ thống đang tiến hành kiểm tra giao dịch này. Vui lòng chờ trong giây lát ạ.`;
      case 'fil-PH':
        return `Maraming salamat po sa impormasyon! Natanggap na po namin ang inyong detalye:
- Order ID: ${orderId}
- Halaga / Diamond: ${amount}
- Paraan ng Pagbabayad: ${payment}
- Oras ng Transaksyon: ${time}

Kasalukuyan po naming bineberipika ang transaksyon sa aming system. Sandali lamang po.`;
      case 'ms-MY':
        return `Terima kasih atas maklumat yang diberikan! Butiran transaksi anda telah direkodkan:
- Order ID: ${orderId}
- Jumlah / Diamond: ${amount}
- Kaedah Pembayaran: ${payment}
- Waktu Transaksi: ${time}

Pihak kami sedang menyemak status transaksi ini dalam sistem. Sila tunggu sebentar ya.`;
      case 'en':
        return `Thank you for the details! We have recorded your transaction information:
- Order ID: ${orderId}
- Amount / Diamonds: ${amount}
- Payment Method: ${payment}
- Transaction Time: ${time}

We are currently verifying this with our payment processing system. Please hold on for a moment.`;
      case 'id-ID':
      default:
        return `Terima kasih atas datanya kak! Data transaksi kakak sudah kami catat:
- Order ID: ${orderId}
- Nominal: ${amount}
- Metode Pembayaran: ${payment}
- Jam Transaksi: ${time}

Kami sedang melakukan pengecekan ke sistem pembayaran. Mohon ditunggu sebentar ya kak.`;
    }
  }

  /**
   * Cek apakah pesan pemain menunjukkan keluhan top-up belum masuk
   * yang membutuhkan pengumpulan data.
   */
  isTopupUncreditedComplaint(text: string): boolean {
    const cleaned = text.toLowerCase();
    const hasTopupWord =
      cleaned.includes('topup') ||
      cleaned.includes('top-up') ||
      cleaned.includes('diamond') ||
      cleaned.includes('dm') ||
      cleaned.includes('isi saldo') ||
      cleaned.includes('saldo') ||
      cleaned.includes('order');

    const hasUncreditedWord =
      cleaned.includes('belum masuk') ||
      cleaned.includes('tidak masuk') ||
      cleaned.includes('nggak masuk') ||
      cleaned.includes('ga masuk') ||
      cleaned.includes('belum nambah') ||
      cleaned.includes('not received') ||
      cleaned.includes('not credited') ||
      cleaned.includes('belum sampai') ||
      cleaned.includes('tidak bertambah');

    return hasTopupWord && hasUncreditedWord;
  }
}
