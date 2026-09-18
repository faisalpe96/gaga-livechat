import { GuardrailEngine } from './guardrails.js';
import { ConversationFlowManager } from './conversation-flow.js';
import { KnowledgeBaseRetriever } from '../kb/retriever.js';
import { IntentClassifier } from './intent-classifier.js';
import { AttachmentService } from '../../../gateway/src/attachment-service.js';

export interface WaitingProcessParams {
  text: string;
  locale: string;
  existingSlots?: Record<string, string>;
  lastTargetSlot?: string;
  botPersona?: 'mira' | 'reza' | string;
  handoffReason?: string;
  attachmentUrl?: string;
}

export interface WaitingProcessResult {
  text: string;
  updatedSlots: Record<string, string>;
  nextSlotToAsk?: string;
  isHardTriggerTopic: boolean;
  botSummary: string;
  action: 'reply';
  needsEvidence?: boolean;
  evidenceType?: string;
}

export class WaitingCompanion {
  private guardrails: GuardrailEngine;
  private flowManager: ConversationFlowManager;
  private kbRetriever?: KnowledgeBaseRetriever;
  private intentClassifier?: IntentClassifier;

  constructor(options: {
    guardrails?: GuardrailEngine;
    flowManager?: ConversationFlowManager;
    kbRetriever?: KnowledgeBaseRetriever;
    intentClassifier?: IntentClassifier;
  } = {}) {
    this.guardrails = options.guardrails || new GuardrailEngine();
    this.flowManager = options.flowManager || new ConversationFlowManager();
    this.kbRetriever = options.kbRetriever;
    this.intentClassifier = options.intentClassifier || new IntentClassifier();
  }

  /**
   * (1) Segera akui keluhan pemain saat masuk ke antrean (handoff_queued),
   * menginformasikan estimasi waktu tunggu berdasarkan SLA pasar.
   */
  getImmediateHandoffAcknowledgement(
    reason: string,
    locale = 'id-ID',
    estimatedWaitMinutes = 10,
    botPersona: 'mira' | 'reza' | string = 'mira'
  ): string {
    const isReza = (botPersona || '').toLowerCase() === 'reza';

    switch (locale) {
      case 'id-ID':
        return (
          `Baik kak, keluhan Kakak sudah kami terima dan saat ini sedang kami sambungkan ke tim Customer Support kami. ` +
          `Estimasi waktu tunggu antrean sekitar ${estimatedWaitMinutes} menit. ` +
          `Sembari menunggu CS kami terhubung, boleh kami bantu catat beberapa detail kendalanya terlebih dahulu agar penanganannya lebih cepat? ` +
          `Boleh minta nomor Order ID atau bukti transaksinya kak?`
        );

      case 'th-TH':
        const particle = isReza ? 'ครับ' : 'ค่ะ';
        return (
          `ทางเราได้รับเรื่องของท่านเรียบร้อยแล้ว${particle} และกำลังประสานงานส่งต่อให้ทีมงาน Customer Support นะคะ ` +
          `โดยมีเวลาประมาณการรอคิว ${estimatedWaitMinutes} นาที ` +
          `ระหว่างรอเจ้าหน้าที่ ขอทราบหมายเลขคำสั่งซื้อ (Order ID) หรือรหัสธุรกรรมไว้ล่วงหน้าได้ไหมคะ?`
        );

      case 'vi-VN':
        return (
          `Chúng tôi đã tiếp nhận thông tin của bạn và đang kết nối bạn với chuyên viên hỗ trợ. ` +
          `Thời gian chờ ước tính khoảng ${estimatedWaitMinutes} phút. ` +
          `Trong lúc chờ đợi, bạn vui lòng cung cấp Mã đơn hàng (Order ID) để chúng tôi hỗ trợ nhanh nhất nhé?`
        );

      case 'fil-PH':
        return (
          `Natanggap na po namin ang inyong alalahanin at kasalukuyan po kayong ikinokonekta sa aming Customer Support. ` +
          `Ang tinatayang oras ng paghihintay ay humigit-kumulang ${estimatedWaitMinutes} minuto. ` +
          `Habang naghihintay, maaari po ba ninyong ibahagi ang inyong Order ID o detalye ng transaksyon?`
        );

      case 'ms-MY':
        return (
          `Aduan anda telah kami terima dan kami sedang menyambungkan anda kepada pasukan Customer Support. ` +
          `Anggaran masa menunggu adalah sekitar ${estimatedWaitMinutes} minit. ` +
          `Sementara menunggu, boleh kongsikan nombor Order ID atau rujukan transaksi anda?`
        );

      case 'en':
      default:
        return (
          `We have received your request and are connecting you to our Customer Support team. ` +
          `The estimated wait time is approximately ${estimatedWaitMinutes} minutes. ` +
          `While waiting, could you please provide your Order ID or transaction reference so our team can assist you right away?`
        );
    }
  }

  /**
   * (3) Deteksi apakah topik adalah pemicu keras (Hard-Trigger Topics):
   * Refund, unban/banding banned, akun terkunci/diretas, pembelian anak, hukum/media, bahaya diri.
   */
  checkHardTriggerTopic(text: string, locale = 'id-ID'): { isHardTrigger: boolean; topic?: string } {
    const cleaned = text.toLowerCase();

    // 1. Cek dari guardrails engine
    const guardrailRes = this.guardrails.checkHardTrigger(text, locale);
    if (guardrailRes.matched && guardrailRes.ruleKey) {
      return { isHardTrigger: true, topic: guardrailRes.ruleKey };
    }

    // 2. Keyword fallback eksplisit
    if (cleaned.includes('refund') || cleaned.includes('kembalikan dana') || cleaned.includes('kembalikan uang') || cleaned.includes('tarik dana') || cleaned.includes('minta uang')) {
      return { isHardTrigger: true, topic: 'refund' };
    }
    if (cleaned.includes('unban') || cleaned.includes('buka ban') || cleaned.includes('buka blokir') || cleaned.includes('banding ban') || cleaned.includes('akun diblokir')) {
      return { isHardTrigger: true, topic: 'banding_banned' };
    }
    if (cleaned.includes('akun terkunci') || cleaned.includes('kena hack') || cleaned.includes('di-hack') || cleaned.includes('lupa password') || cleaned.includes('tidak bisa login')) {
      return { isHardTrigger: true, topic: 'akun_terkunci' };
    }
    if (cleaned.includes('anak') && (cleaned.includes('beli') || cleaned.includes('topup'))) {
      return { isHardTrigger: true, topic: 'pembelian_anak' };
    }
    if (cleaned.includes('polisi') || cleaned.includes('somasi') || cleaned.includes('hukum') || cleaned.includes('pengacara') || cleaned.includes('media')) {
      return { isHardTrigger: true, topic: 'hukum_media' };
    }
    if (cleaned.includes('bunuh diri') || cleaned.includes('mati') || cleaned.includes('akhiri hidup')) {
      return { isHardTrigger: true, topic: 'bahaya_diri' };
    }

    return { isHardTrigger: false };
  }

  /**
   * (3) Pengakuan untuk Topik Pemicu Keras (Hard-Trigger Acknowledgement):
   * HANYA mengakui dan mengonfirmasi bahwa tim CS manusia yang akan menanganinya.
   * DILARANG KERAS memberikan janji, keputusan, atau solusi mandiri!
   */
  getHardTriggerAcknowledgement(
    topic: string,
    locale = 'id-ID',
    botPersona: 'mira' | 'reza' | string = 'mira'
  ): string {
    const isReza = (botPersona || '').toLowerCase() === 'reza';

    switch (topic) {
      case 'refund':
        if (locale === 'id-ID') {
          return (
            `Terkait permohonan pengembalian dana (refund), hal ini memerlukan verifikasi khusus dan persetujuan dari tim Customer Support serta divisi keuangan kami. ` +
            `Tim CS kami yang sedang menuju ke sesi ini akan langsung memeriksa detail transaksi Kakak begitu tersambung.`
          );
        } else if (locale === 'th-TH') {
          const p = isReza ? 'ครับ' : 'ค่ะ';
          return `สำหรับเรื่องการขอคืนเงิน (Refund) จำเป็นต้องได้รับการตรวจสอบโดยตรงจากเจ้าหน้าที่ฝ่ายสนับสนุน${p} เจ้าหน้าที่จะเข้ามาดูแลและตรวจสอบรายการให้ทันทีที่ถึงคิวนะคะ`;
        } else {
          return `Regarding refund requests, our policy requires direct verification by our specialized Customer Support team. Our team will review your transaction directly as soon as they connect.`;
        }

      case 'banding_banned':
        if (locale === 'id-ID') {
          return (
            `Mengenai peninjauan sanksi atau pemblokiran akun (unban), hal ini memerlukan investigasi keamanan langsung oleh tim akun kami. ` +
            `Tim CS kami akan memeriksa riwayat dan log akun Kakak begitu bergabung ke obrolan ini.`
          );
        } else if (locale === 'th-TH') {
          const p = isReza ? 'ครับ' : 'ค่ะ';
          return `สำหรับการอุทธรณ์การระงับหรือแบนบัญชี จำเป็นต้องได้รับการตรวจสอบจากทีมงานความปลอดภัยโดยตรง${p} เจ้าหน้าที่จะช่วยตรวจสอบประวัติบัญชีให้ทันทีค่ะ`;
        } else {
          return `Regarding account suspension or ban appeals, our security specialists must review your case directly. Our team will check your account logs once connected.`;
        }

      case 'akun_terkunci':
        if (locale === 'id-ID') {
          return (
            `Untuk masalah akun terkunci atau akses login, tim Customer Support kami akan membantu proses verifikasi data kepemilikan akun Kakak secara langsung. ` +
            `Mohon ditunggu sebentar ya kak.`
          );
        } else if (locale === 'th-TH') {
          const p = isReza ? 'ครับ' : 'ค่ะ';
          return `สำหรับปัญหาบัญชีถูกล็อคหรือเข้าสู่ระบบไม่ได้ เจ้าหน้าที่จะช่วยยืนยันตัวตนและกู้คืนบัญชีให้ทันทีที่เชื่อมต่อ${p}`;
        } else {
          return `For locked or inaccessible accounts, our support team will assist with identity and ownership verification as soon as they connect.`;
        }

      case 'pembelian_anak':
        if (locale === 'id-ID') {
          return (
            `Untuk transaksi pembelian oleh anak tanpa izin, tim kami akan meninjau rincian transaksi tersebut bersama Kakak. ` +
            `Tim Customer Support kami akan segera bergabung untuk memprosesnya.`
          );
        } else {
          return `Regarding unauthorized purchases by a minor, our team will review the transaction details with you directly once connected.`;
        }

      case 'hukum_media':
        if (locale === 'id-ID') {
          return (
            `Kami mencatat eskalasi penting ini. Tim penanganan khusus kami akan segera bergabung untuk menindaklanjuti keluhan Kakak secara prioritas.`
          );
        } else {
          return `We have noted this escalation. Our specialized team will join to address your concern with high priority.`;
        }

      case 'bahaya_diri':
        if (locale === 'id-ID') {
          return `Kami sangat peduli dengan keselamatan Kakak. Tim Support kami memprioritaskan bantuan langsung untuk Kakak saat ini.`;
        } else {
          return `We care deeply about your safety. Our team is prioritizing direct support for you right now.`;
        }

      default:
        if (locale === 'id-ID') {
          return (
            `Permintaan Kakak memerlukan penanganan langsung dari tim Customer Support kami. ` +
            `Tim kami akan segera menangani hal ini begitu terhubung.`
          );
        } else {
          return `Your request requires direct handling by our Customer Support specialists. Our team will handle it as soon as they connect.`;
        }
    }
  }

  /**
   * (4) Pengecekan jeda 3 menit untuk status update otomatis saat pemain diam.
   * "if the player goes quiet, send a status update at most once every 3 minutes, never more often"
   */
  canSendQueueStatusUpdate(lastActivityTime: Date | number | null | undefined): boolean {
    if (!lastActivityTime) return true;
    const lastTime = new Date(lastActivityTime).getTime();
    const elapsedMs = Date.now() - lastTime;
    // 3 menit = 180.000 ms
    return elapsedMs >= 3 * 60 * 1000;
  }

  /**
   * (4) Pesan status update antrean berkala (maksimal tiap 3 menit).
   */
  getQueueStatusUpdateMessage(
    locale = 'id-ID',
    botPersona: 'mira' | 'reza' | string = 'mira'
  ): string {
    const isReza = (botPersona || '').toLowerCase() === 'reza';

    switch (locale) {
      case 'id-ID':
        return `Terima kasih masih bersedia menunggu ya kak. Kakak saat ini masih berada dalam antrean dan tim Customer Support kami akan segera menyapa Kakak begitu giliran tiba.`;
      case 'th-TH':
        const p = isReza ? 'ครับ' : 'ค่ะ';
        return `ขอบคุณที่ยังรออยู่นะคะ คุณยังคงอยู่ในคิว และเจ้าหน้าที่ Customer Support กำลังจะเข้ามาดูแลในไม่ช้านี้${p}`;
      case 'vi-VN':
        return `Cảm ơn bạn vẫn kiên nhẫn chờ đợi. Bạn vẫn đang ở trong hàng đợi và chuyên viên hỗ trợ sẽ tham gia ngay khi đến lượt.`;
      case 'fil-PH':
        return `Salamat po sa paghihintay. Nasa pila pa rin po kayo at sasamahan po kayo ng aming Customer Support sa lalong madaling panahon.`;
      case 'ms-MY':
        return `Terima kasih kerana masih sudi menunggu. Anda masih berada dalam giliran dan wakil Customer Support kami akan menyertai perbualan sebentar lagi.`;
      case 'en':
      default:
        return `Thank you for your patience while waiting. You remain in the queue and our Customer Support team will join this conversation shortly.`;
    }
  }

  /**
   * (5) Format ringkasan data terkumpul untuk ditulis ke handoffs.bot_summary.
   */
  buildHandoffSummary(params: {
    reason?: string;
    slots: Record<string, string>;
    hardTriggerTopic?: string;
    notes?: string;
  }): string {
    const lines: string[] = [];
    lines.push(`[Handoff Summary]`);
    if (params.reason) {
      lines.push(`Alasan Eskalasi: ${params.reason}`);
    }
    if (params.hardTriggerTopic) {
      lines.push(`Topik Khusus: ${params.hardTriggerTopic} (Wajib penanganan langsung CS)`);
    }

    lines.push(`Data Transaksi Terkumpul:`);
    lines.push(`- Order ID: ${params.slots.order_id || 'Belum ada'}`);
    lines.push(`- Nominal: ${params.slots.amount || 'Belum ada'}`);
    lines.push(`- Metode Pembayaran: ${params.slots.payment_method || 'Belum ada'}`);
    lines.push(`- Waktu Transaksi: ${params.slots.transaction_time || 'Belum ada'}`);

    if (params.notes) {
      lines.push(`Catatan: ${params.notes}`);
    }

    return lines.join('\n');
  }

  /**
   * (2, 3, 5) Memproses pesan pemain saat status berada di 'handoff_queued'.
   */
  async processWaitingMessage(params: WaitingProcessParams): Promise<WaitingProcessResult> {
    const { text, locale, existingSlots = {}, lastTargetSlot, botPersona = 'mira', handoffReason } = params;

    // =========================================================================
    // SYARAT 3: Cek topik pemicu keras (Hard-Trigger Topics)
    // DILARANG KERAS memberi solusi / janji / keputusan! Hanya akui dan konfirmasi CS yang tangani.
    // =========================================================================
    const hardTrigger = this.checkHardTriggerTopic(text, locale);
    if (hardTrigger.isHardTrigger && hardTrigger.topic) {
      const ackText = this.getHardTriggerAcknowledgement(hardTrigger.topic, locale, botPersona);
      const summary = this.buildHandoffSummary({
        reason: handoffReason || 'hard_trigger',
        slots: existingSlots,
        hardTriggerTopic: hardTrigger.topic,
        notes: `Pemain menanyakan perihal ${hardTrigger.topic} saat dalam antrean: "${text}"`,
      });

      return {
        action: 'reply',
        text: ackText,
        updatedSlots: existingSlots,
        nextSlotToAsk: lastTargetSlot,
        isHardTriggerTopic: true,
        botSummary: summary,
      };
    }

    // =========================================================================
    // SYARAT 2 & 5: Pengumpulan Data yang Dibutuhkan Agen (Sequential Slot Filling)
    // Ekstrak slot yang mungkin ada pada pesan pemain
    // =========================================================================
    const updatedSlots = this.flowManager.extractSlots(text, existingSlots, lastTargetSlot);

    // Cek slot mana saja yang sudah ada & mana yang masih kurang
    const requiredSlotKeys = ['order_id', 'amount', 'payment_method', 'transaction_time'];
    const missingSlotKeys = requiredSlotKeys.filter((k) => !updatedSlots[k]);

    // Format ringkasan terbaru untuk handoffs.bot_summary (Syarat 5)
    const summary = this.buildHandoffSummary({
      reason: handoffReason || 'handoff_queued',
      slots: updatedSlots,
      notes: missingSlotKeys.length === 0 ? 'Semua 4 data transaksi telah terkumpul lengkap.' : `Menunggu data: ${missingSlotKeys.join(', ')}`,
    });

    // Syarat 3: Jika pemain menyatakan "sudah saya kirim" / "ini fotonya" tapi tidak ada file,
    // bot TIDAK BOLEH mengulang pertanyaan verbatim! Jelaskan cara melampirkannya menggunakan tombol lampiran (📎).
    const hasAttachment = Boolean(
      params.attachmentUrl ||
      /https?:\/\/.*?\.(png|jpg|jpeg|webp)|\[Attachment/i.test(text)
    );
    if (!hasAttachment && AttachmentService.isClaimingSentAttachment(text)) {
      const explanation = AttachmentService.getMissingAttachmentExplanation(locale, botPersona);
      return {
        action: 'reply',
        text: explanation,
        updatedSlots: existingSlots,
        nextSlotToAsk: lastTargetSlot || 'order_id',
        isHardTriggerTopic: false,
        botSummary: summary,
        needsEvidence: true,
        evidenceType: 'attachment',
      };
    }

    // Jika masih ada slot yang belum diisi, tanyakan SATU PER SATU secara berurutan
    if (missingSlotKeys.length > 0) {
      const nextKey = missingSlotKeys[0];

      // Acknowledge apa yang baru saja diberikan oleh pemain jika ada slot baru yang terisi
      const newlyFilledKey = requiredSlotKeys.find((k) => !existingSlots[k] && updatedSlots[k]);
      let prefix = '';

      if (newlyFilledKey && locale === 'id-ID') {
        const labels: Record<string, string> = {
          order_id: `Order ID (${updatedSlots.order_id})`,
          amount: `nominal (${updatedSlots.amount})`,
          payment_method: `metode pembayaran (${updatedSlots.payment_method})`,
          transaction_time: `waktu transaksi (${updatedSlots.transaction_time})`,
        };
        prefix = `Terima kasih kak, ${labels[newlyFilledKey] || 'datanya'} sudah kami catat. `;
      } else if (newlyFilledKey) {
        prefix = `Thank you, we have recorded that detail. `;
      }

      const questionPrompt = this.getSlotPrompt(nextKey, locale);
      const fullText = prefix ? `${prefix}${questionPrompt}` : questionPrompt;

      return {
        action: 'reply',
        text: fullText,
        updatedSlots,
        nextSlotToAsk: nextKey,
        isHardTriggerTopic: false,
        botSummary: summary,
        needsEvidence: nextKey === 'order_id',
        evidenceType: nextKey === 'order_id' ? 'attachment' : undefined,
      };
    }

    // Jika SEMUA slot sudah terkumpul lengkap:
    // Reassure pemain bahwa data sudah lengkap dan siap untuk agen manusia
    let completionText = '';
    if (locale === 'id-ID') {
      completionText = (
        `Terima kasih banyak kak, seluruh data transaksi (Order ID, nominal, metode pembayaran, dan perkiraan waktu) ` +
        `sudah kami catat lengkap di sistem untuk tim Customer Support kami. ` +
        `Begitu CS kami terhubung, Kakak tidak perlu mengulangi penjelasan ini lagi. Mohon tetap berada di halaman ini ya kak.`
      );
    } else if (locale === 'th-TH') {
      const p = (botPersona || '').toLowerCase() === 'reza' ? 'ครับ' : 'ค่ะ';
      completionText = `ขอบคุณมากค่ะ ข้อมูลธุรกรรมทั้งหมด (Order ID, ยอดเงิน, ช่องทาง และเวลา) ได้รับการบันทึกไว้ให้เจ้าหน้าที่เรียบร้อยแล้ว${p} เจ้าหน้าที่จะเข้ามารับช่วงต่อในทันทีค่ะ`;
    } else {
      completionText = (
        `Thank you! All transaction details (Order ID, amount, payment method, and time) have been recorded for our Customer Support team. ` +
        `You will not need to repeat these details once connected. Please remain on this page.`
      );
    }

    return {
      action: 'reply',
      text: completionText,
      updatedSlots,
      nextSlotToAsk: undefined,
      isHardTriggerTopic: false,
      botSummary: summary,
    };
  }

  private getSlotPrompt(slotKey: string, locale = 'id-ID'): string {
    const prompts: Record<string, Record<string, string>> = {
      order_id: {
        'id-ID': 'Boleh minta nomor Order ID atau bukti transaksinya kak? (Contoh: order_123 atau nomor pesanan di store)',
        'en': 'Could you please provide your Order ID or transaction reference number?',
        'th-TH': 'ขอทราบหมายเลขคำสั่งซื้อ (Order ID) หรือรหัสธุรกรรมด้วยค่ะ',
      },
      amount: {
        'id-ID': 'Boleh tahu berapa nominal top-up atau jumlah diamond yang dibeli kak?',
        'en': 'Could you let us know the top-up amount or number of diamonds purchased?',
        'th-TH': 'ขอทราบยอดเงินที่เติม หรือจำนวนเพชรที่สั่งซื้อด้วยค่ะ',
      },
      payment_method: {
        'id-ID': 'Boleh dibantu metode pembayaran apa yang digunakan kemarin kak? (Contoh: QRIS, DANA, GoPay, OVO, atau transfer bank)',
        'en': 'Which payment method was used? (e.g. Credit Card, E-Wallet, QRIS, Bank Transfer)',
        'th-TH': 'ชำระเงินผ่านช่องทางใดคะ (เช่น PromptPay, TrueMoney, โอนธนาคาร)',
      },
      transaction_time: {
        'id-ID': 'Kira-kira sekitar jam berapa transaksinya dilakukan kak?',
        'en': 'Approximately what time was the transaction made?',
        'th-TH': 'ทำรายการประมาณช่วงเวลาใดคะ',
      },
    };

    const slotMap = prompts[slotKey];
    if (slotMap) {
      return slotMap[locale] || slotMap['id-ID'] || slotMap['en'];
    }
    return 'Boleh dibantu informasikan detail tambahannya kak?';
  }
}
