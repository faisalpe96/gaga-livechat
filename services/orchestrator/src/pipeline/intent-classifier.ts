export interface IntentClassificationResult {
  intent: string;
  confidence: number;
}

export class IntentClassifier {
  private overrideConfidence?: number;

  setOverrideConfidence(conf?: number) {
    this.overrideConfidence = conf;
  }

  async classify(text: string, category?: string): Promise<IntentClassificationResult> {
    if (this.overrideConfidence !== undefined) {
      return {
        intent: 'custom_intent',
        confidence: this.overrideConfidence,
      };
    }

    const cleaned = text.toLowerCase().trim();
    const normCategory = category ? category.toLowerCase().trim() : undefined;

    // 0. Minta bantuan CS / manusia (Human Request)
    const humanRequestPatterns = [
      /cs\s*manusia/i,
      /hubungkan\s*(dengan|ke)?\s*cs/i,
      /bicara\s*(dengan|sama)?\s*(orang|manusia|cs|agen)/i,
      /panggil\s*cs/i,
      /agen\s*manusia/i,
      /live\s*agent/i,
      /talk\s*to\s*human/i,
      /speak\s*to\s*agent/i,
    ];
    if (humanRequestPatterns.some((rgx) => rgx.test(cleaned))) {
      return { intent: 'minta_manusia', confidence: 0.98 };
    }

    // 1. Sapaan murni (Pure Greeting)
    const pureGreetingRegex =
      /^(ha?l+o+|ha?i+|hey+|hi+|p+|permisi|selamat (pagi|siang|sore|malam)|assalamu['a-z]*|hello+|sawasdee|kumusta|xin ch[aà]o|good (morning|afternoon|evening))(\s+(min|kak|admin|cs|team))?[\s!?.]*$/i;
    if (pureGreetingRegex.test(cleaned)) {
      return { intent: 'greeting', confidence: 0.95 };
    }

    // 2. Sapaan / pertanyaan kabur tanpa topik jelas (Vague Inquiry)
    const vaguePatterns = [
      /^(ha?l+o+|hai+|hi+|min|p+)?\s*(ini\s+)?(gimana|bagaimana)(\s+ya|\s+ini|\s+sih)?\??$/i,
      /^(ha?l+o+|hai+|hi+|min|p+)?\s*(mau|bisa|tolong)?\s*(tanya|bantu|tolong)(\s+dong|\s+min|\s+kak)?\??$/i,
      /^(ha?l+o+|hai+|hi+)?\s*ada\s*(orang|cs|admin)(\s+ga|\s+gak|\s+ngga)?\??$/i,
      /^(min|admin|p)$/i,
    ];
    if (vaguePatterns.some((rgx) => rgx.test(cleaned))) {
      return { intent: 'vague_inquiry', confidence: 0.92 };
    }

    // 3. Pertanyaan kendala top-up yang masih kabur (Topup Clarification Needed)
    // Contoh: "bagaimana kendala topup", "ada kendala topup", "kendala top up", "topup bermasalah"
    const isTopupVague =
      (cleaned.includes('kendala') || cleaned.includes('masalah') || cleaned.includes('bermasalah')) &&
      (cleaned.includes('topup') || cleaned.includes('top-up') || cleaned.includes('isi saldo')) &&
      !cleaned.includes('belum masuk') &&
      !cleaned.includes('gagal') &&
      !cleaned.includes('cara') &&
      !cleaned.includes('metode');
    if (isTopupVague) {
      return { intent: 'topup_clarification', confidence: 0.90 };
    }

    // 4. Intent: Topup Belum Masuk / Uncredited Diamonds
    const isTopupUncredited =
      (cleaned.includes('belum masuk') ||
        cleaned.includes('tidak masuk') ||
        cleaned.includes('ga masuk') ||
        cleaned.includes('nggak masuk') ||
        cleaned.includes('belum sampai') ||
        cleaned.includes('not received') ||
        cleaned.includes('not credited')) &&
      (cleaned.includes('topup') ||
        cleaned.includes('top-up') ||
        cleaned.includes('diamond') ||
        cleaned.includes('saldo') ||
        cleaned.includes('order'));
    if (isTopupUncredited) {
      return { intent: 'topup_uncredited', confidence: 0.92 };
    }

    // 5. Intent: Topup Spesifik (cara topup, dsb.)
    if (
      cleaned.includes('topup') ||
      cleaned.includes('top-up') ||
      cleaned.includes('isi saldo') ||
      cleaned.includes('diamond') ||
      cleaned.includes('เติมเงิน') ||
      cleaned.includes('nạp tiền')
    ) {
      return { intent: 'topup_inquiry', confidence: 0.88 };
    }

    // 5. Intent: VIP
    if (cleaned.includes('vip') || cleaned.includes('privilege') || cleaned.includes('tier')) {
      return { intent: 'vip_benefits', confidence: 0.85 };
    }

    // 6. Intent: Account Link
    if (cleaned.includes('link') || cleaned.includes('bind') || cleaned.includes('tautkan')) {
      return { intent: 'account_link', confidence: 0.86 };
    }

    // 7. Penyempitan Klasifikasi Berdasarkan Kategori Taksonomi (Taxonomy Category Narrowing)
    if (normCategory) {
      if (normCategory.includes('account') || normCategory.includes('login') || normCategory.includes('akun')) {
        if (cleaned.includes('link') || cleaned.includes('bind') || cleaned.includes('tautkan') || cleaned.includes('kaitkan')) {
          return { intent: 'account_link', confidence: 0.96 };
        }
        if (cleaned.includes('ban') || cleaned.includes('blokir') || cleaned.includes('suspend') || cleaned.includes('appeal')) {
          return { intent: 'account_ban_appeal', confidence: 0.96 };
        }
        if (cleaned.includes('login') || cleaned.includes('masuk') || cleaned.includes('password') || cleaned.includes('sandi') || cleaned.includes('lupa')) {
          return { intent: 'account_login_issue', confidence: 0.95 };
        }
        if (cleaned.includes('vip') || cleaned.includes('tier') || cleaned.includes('level')) {
          return { intent: 'vip_benefits', confidence: 0.92 };
        }
        return { intent: 'account_inquiry', confidence: 0.92 };
      }

      if (normCategory.includes('payment') || normCategory.includes('topup') || normCategory.includes('pembayaran') || normCategory.includes('bayar')) {
        if (isTopupUncredited) {
          return { intent: 'topup_uncredited', confidence: 0.96 };
        }
        if (cleaned.includes('refund') || cleaned.includes('kembali dana') || cleaned.includes('uang kembali')) {
          return { intent: 'refund', confidence: 0.96 };
        }
        if (isTopupVague) {
          return { intent: 'topup_clarification', confidence: 0.93 };
        }
        return { intent: 'topup_inquiry', confidence: 0.92 };
      }

      if (normCategory.includes('tech') || normCategory.includes('teknis')) {
        if (cleaned.includes('crash') || cleaned.includes('keluar sendiri') || cleaned.includes('force close') || cleaned.includes('layar hitam') || cleaned.includes('black screen')) {
          return { intent: 'app_crash', confidence: 0.95 };
        }
        if (cleaned.includes('lag') || cleaned.includes('ping') || cleaned.includes('lemot') || cleaned.includes('sinyal') || cleaned.includes('patah')) {
          return { intent: 'network_lag', confidence: 0.95 };
        }
        return { intent: 'technical_issue', confidence: 0.92 };
      }

      if (normCategory.includes('gameplay') || normCategory.includes('item')) {
        if (cleaned.includes('item') || cleaned.includes('barang') || cleaned.includes('senjata') || cleaned.includes('skin') || cleaned.includes('hero')) {
          return { intent: 'item_inquiry', confidence: 0.95 };
        }
        return { intent: 'gameplay_guide', confidence: 0.92 };
      }

      if (normCategory.includes('feedback') || normCategory.includes('lainnya') || normCategory.includes('other')) {
        return { intent: 'feedback_suggestion', confidence: 0.92 };
      }
    }

    // 8. Teks sangat pendek atau tidak jelas -> keyakinan rendah
    if (cleaned.length < 5 || /^[?.!]+$/.test(cleaned) || cleaned === 'test' || cleaned === 'asdf') {
      return { intent: 'unknown', confidence: 0.40 };
    }

    // 9. FAQ umum (faq_inquiry)
    return { intent: 'faq_inquiry', confidence: 0.86 };
  }
}
