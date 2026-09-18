import pg from 'pg';

export interface GuardrailMatch {
  matched: boolean;
  ruleKey?: string;
  phrase?: string;
  isHardTrigger: boolean;
  botSummary?: string;
}

export interface OutputFilterResult {
  passed: boolean;
  reason?: string;
  botSummary?: string;
}

export class GuardrailEngine {
  private pool?: pg.Pool;

  // Cache in-memory: locale -> rule_key -> string[]
  private phrasesCache: Map<string, Map<string, string[]>> = new Map();

  // Daftar pemicu keras baku menurut spec/04-orchestrator.md
  public static readonly HARD_TRIGGER_KEYS = [
    'akun_terkunci',
    'refund',
    'banding_banned',
    'pembelian_anak',
    'hukum_media',
    'bahaya_diri',
  ];

  // Daftar pemicu lunak baku menurut spec/04-orchestrator.md
  public static readonly SOFT_TRIGGER_KEYS = [
    'gagal_paham',
    'frustrasi',
    'minta_manusia',
    'nilai_besar',
    'keyakinan_rendah',
  ];

  constructor(pool?: pg.Pool) {
    this.pool = pool;
    this.initializeDefaultPhrases();
  }

  /**
   * Muat seluruh frasa dari tabel database guardrail_phrases untuk semua locale.
   */
  async loadAllFromDatabase(): Promise<number> {
    if (!this.pool) return 0;

    const res = await this.pool.query(
      `SELECT rule_key, locale, phrase FROM guardrail_phrases`
    );

    this.phrasesCache.clear();
    for (const row of res.rows) {
      let localeMap = this.phrasesCache.get(row.locale);
      if (!localeMap) {
        localeMap = new Map();
        this.phrasesCache.set(row.locale, localeMap);
      }
      const list = localeMap.get(row.rule_key) || [];
      list.push(row.phrase.toLowerCase());
      localeMap.set(row.rule_key, list);
    }

    return res.rows.length;
  }

  /**
   * Startup Safety Gate:
   * Memeriksa kelengkapan guardrail per locale saat startup server.
   * Kalau ada pasar dengan is_bot_enabled = true tapi frasa bahaya_diri-nya kosong:
   * MENOLAK mengaktifkan bot untuk pasar itu, mematikan is_bot_enabled = false di database,
   * dan mencatat peringatan/alarm yang jelas.
   */
  async validateBotActivationGuardrails(): Promise<{
    valid: boolean;
    rejectedMarkets: Array<{ code: string; locale: string; reason: string }>;
  }> {
    if (!this.pool) return { valid: true, rejectedMarkets: [] };

    // Ambil seluruh pasar yang is_bot_enabled = true
    const marketsRes = await this.pool.query(
      `SELECT code, name, default_locale, is_bot_enabled FROM markets WHERE is_bot_enabled = true`
    );

    const rejectedMarkets: Array<{ code: string; locale: string; reason: string }> = [];

    for (const m of marketsRes.rows) {
      const checkRes = await this.pool.query(
        `SELECT count(*) FROM guardrail_phrases WHERE locale = $1 AND rule_key = 'bahaya_diri'`,
        [m.default_locale]
      );
      const count = parseInt(checkRes.rows[0].count, 10);

      if (count === 0) {
        const reason = `Pasar '${m.code}' (${m.name}) diatur is_bot_enabled = true tetapi frasa wajib 'bahaya_diri' untuk locale '${m.default_locale}' KOSONG di tabel guardrail_phrases.`;
        console.warn(`[KEAMANAN STARTUP] PERINGATAN KERAS: ${reason} MENOLAK mengaktifkan bot untuk pasar ini dan mematikan is_bot_enabled.`);

        // Tolak dan matikan is_bot_enabled
        await this.pool.query(
          `UPDATE markets SET is_bot_enabled = false WHERE code = $1`,
          [m.code]
        );

        rejectedMarkets.push({ code: m.code, locale: m.default_locale, reason });
      }
    }

    return {
      valid: rejectedMarkets.length === 0,
      rejectedMarkets,
    };
  }

  /**
   * Muat frasa dari database guardrail_phrases untuk locale tertentu.
   */
  async loadFromDatabase(locale: string): Promise<void> {
    if (!this.pool) return;

    const res = await this.pool.query(
      `SELECT rule_key, phrase FROM guardrail_phrases WHERE locale = $1`,
      [locale]
    );

    let localeMap = this.phrasesCache.get(locale);
    if (!localeMap) {
      localeMap = new Map();
      this.phrasesCache.set(locale, localeMap);
    }

    for (const row of res.rows) {
      const list = localeMap.get(row.rule_key) || [];
      list.push(row.phrase.toLowerCase());
      localeMap.set(row.rule_key, list);
    }
  }

  /**
   * Menambahkan frasa guardrail secara dinamis (untuk pengujian atau pemuatan runtime)
   */
  addPhrase(locale: string, ruleKey: string, phrase: string) {
    let localeMap = this.phrasesCache.get(locale);
    if (!localeMap) {
      localeMap = new Map();
      this.phrasesCache.set(locale, localeMap);
    }
    const list = localeMap.get(ruleKey) || [];
    list.push(phrase.toLowerCase());
    localeMap.set(ruleKey, list);
  }

  /**
   * Langkah 1: Cek pemicu keras pada pesan pemain
   */
  checkHardTrigger(text: string, locale: string): GuardrailMatch {
    const cleaned = text.toLowerCase();
    const localeMap = this.phrasesCache.get(locale);

    for (const ruleKey of GuardrailEngine.HARD_TRIGGER_KEYS) {
      const phrases = localeMap?.get(ruleKey) || [];
      for (const p of phrases) {
        if (cleaned.includes(p)) {
          return {
            matched: true,
            ruleKey,
            phrase: p,
            isHardTrigger: true,
            botSummary: this.getHardTriggerSummary(ruleKey),
          };
        }
      }
    }

    return { matched: false, isHardTrigger: false };
  }

  /**
   * Langkah 2: Cek pemicu lunak (seperti minta manusia)
   */
  checkSoftTrigger(text: string, locale: string): GuardrailMatch {
    const cleaned = text.toLowerCase();
    const localeMap = this.phrasesCache.get(locale);

    for (const ruleKey of GuardrailEngine.SOFT_TRIGGER_KEYS) {
      const phrases = localeMap?.get(ruleKey) || [];
      for (const p of phrases) {
        if (cleaned.includes(p)) {
          return {
            matched: true,
            ruleKey,
            phrase: p,
            isHardTrigger: false,
            botSummary: `Player soft trigger triggered: ${ruleKey} ("${p}")`,
          };
        }
      }
    }

    return { matched: false, isHardTrigger: false };
  }

  /**
   * Langkah 6: Filter Output (4 aturan terkunci)
   */
  filterOutput(
    replyText: string,
    sources: string[],
    confidence: number,
    locale: string
  ): OutputFilterResult {
    // Aturan 3: Wajib ada sumber internal. Jawaban tanpa meta.sources dibuang.
    if (!sources || sources.length === 0) {
      return {
        passed: false,
        reason: 'no_sources',
        botSummary: 'Output filter: Jawaban dibuang karena tidak memiliki dokumen sumber internal terverifikasi (meta.sources empty).',
      };
    }

    // Aturan 4: Ambang keyakinan 0.75. Di bawah itu, handoff.
    if (confidence < 0.75) {
      return {
        passed: false,
        reason: 'keyakinan_rendah',
        botSummary: `Output filter: Confidence score (${confidence}) di bawah ambang batas 0.75.`,
      };
    }

    // Aturan 1: Larang janji refund dan unban (no_promise)
    const cleaned = replyText.toLowerCase();
    const localeMap = this.phrasesCache.get(locale);
    const noPromisePhrases = localeMap?.get('no_promise') || [];

    for (const phrase of noPromisePhrases) {
      if (cleaned.includes(phrase)) {
        return {
          passed: false,
          reason: 'promised_forbidden_action',
          botSummary: `Output filter: Jawaban dibuang karena mengandung janji terlarang ("${phrase}").`,
        };
      }
    }

    return { passed: true };
  }

  private getHardTriggerSummary(ruleKey: string): string {
    switch (ruleKey) {
      case 'bahaya_diri':
        return 'CRITICAL: Self-harm keyword detected. Immediate high-priority handoff without AI intervention.';
      case 'akun_terkunci':
        return 'Player reported account locked, hacked, or inaccessible. Direct handoff required.';
      case 'refund':
        return 'Player requested refund. Direct handoff to customer support specialist.';
      case 'banding_banned':
        return 'Player appealed account suspension/ban. Direct handoff to security support.';
      case 'pembelian_anak':
        return 'Unauthorized in-game purchase by minor reported. Direct handoff required.';
      case 'hukum_media':
        return 'Legal or media escalation mentioned. Direct handoff required.';
      default:
        return `Hard trigger triggered: ${ruleKey}`;
    }
  }

  private initializeDefaultPhrases() {
    // Inisialisasi frasa bawaan dasar untuk 6 bahasa agar siap pakai
    const defaultData: Record<string, Record<string, string[]>> = {
      'th-TH': {
        akun_terkunci: ['บัญชีถูกล็อค', 'เข้าเกมไม่ได้', 'โดนแฮก', 'ลืมรหัสผ่าน', 'ถูกระงับ'],
        refund: ['ขอคืนเงิน', 'คืนเงิน', 'ขอเงินคืน', 'refund'],
        banding_banned: ['ปลดแบน', 'อุทธรณ์การแบน', 'โดนแบน'],
        pembelian_anak: ['ลูกกดซื้อ', 'เด็กกดซื้อ'],
        hukum_media: ['แจ้งความ', 'ทนาย', 'นักข่าว', 'สื่อ'],
        bahaya_diri: ['ฆ่าตัวตาย', 'ไม่อยากมีชีวิตอยู่', 'ทำร้ายตัวเอง'],
        minta_manusia: ['คุยกับคน', 'เจ้าหน้าที่', 'แอดมิน'],
        no_promise: ['จะคืนเงินให้', 'จะปลดแบนให้แน่นอน'],
      },
      'id-ID': {
        akun_terkunci: ['akun terkunci', 'kena hack', 'tidak bisa login', 'lupa password', 'di-hack'],
        refund: ['refund', 'kembalikan dana', 'minta duit kembali', 'tarik saldo'],
        banding_banned: ['banding ban', 'unban', 'buka blokir', 'akun diblokir'],
        pembelian_anak: ['anak saya beli', 'dibeli adik tanpa izin'],
        hukum_media: ['lapor polisi', 'somasi', 'pengacara', 'viralkan ke media', 'viral'],
        bahaya_diri: ['bunuh diri', 'akhiri hidup', 'menyakiti diri'],
        minta_manusia: [
          'bicara dengan orang',
          'mau bicara dengan manusia',
          'hubungkan ke agen',
          'panggil cs asli',
          'panggil cs',
          'hubungkan dengan cs manusia',
          'hubungkan ke cs manusia',
          'hubungkan dengan cs',
          'hubungkan ke cs',
          'bicara dengan cs',
          'cs manusia',
          'jangan bot saya mau orang',
          'live agent',
          'agen manusia',
        ],
        no_promise: ['kami jamin uang kembali', 'pasti kami unban'],
      },
      'en': {
        akun_terkunci: ['account locked', 'hacked', 'cannot login', 'cant login', 'forgot password'],
        refund: ['refund', 'money back', 'chargeback'],
        banding_banned: ['unban', 'ban appeal', 'account banned'],
        pembelian_anak: ['bought by my kid', 'child purchase', 'accidental purchase by child'],
        hukum_media: ['lawyer', 'police', 'sue you', 'media', 'lawsuit'],
        bahaya_diri: ['suicide', 'kill myself', 'end my life', 'self-harm'],
        minta_manusia: ['talk to human', 'human agent', 'live person', 'real person', 'speak to agent'],
        no_promise: ['i promise refund', 'guaranteed unban'],
      },
      'vi-VN': {
        akun_terkunci: ['tài khoản bị khóa', 'bị hack', 'không đăng nhập được'],
        refund: ['hoàn tiền', 'lấy lại tiền', 'refund'],
        banding_banned: ['mở khóa tài khoản', 'kháng cáo ban'],
        pembelian_anak: ['trẻ em mua nhầm', 'con tôi mua'],
        hukum_media: ['báo công an', 'luật sư', 'kiện'],
        bahaya_diri: ['tự tử', 'tự hại'],
        minta_manusia: ['gặp người thật', 'nói chuyện với nhân viên'],
        no_promise: ['chắc chắn sẽ hoàn tiền', 'cam kết mở khóa'],
      },
      'fil-PH': {
        akun_terkunci: ['naka-lock ang account', 'na-hack', 'hindi makapasok'],
        refund: ['ibalik ang pera', 'refund', 'bawiin ang bayad'],
        banding_banned: ['i-unban', 'apela sa ban'],
        pembelian_anak: ['nabili ng bata', 'anak ko ang bumili'],
        hukum_media: ['pulis', 'abogado', 'ipapa-tulfo'],
        bahaya_diri: ['magpakamatay', 'saktan ang sarili'],
        minta_manusia: ['gusto ko ng tao', 'kausapin ang agent'],
        no_promise: ['ipapangako ang refund'],
      },
      'ms-MY': {
        akun_terkunci: ['akaun dikunci', 'kena godam', 'tidak boleh log masuk'],
        refund: ['bayaran balik', 'pulangkan wang', 'refund'],
        banding_banned: ['batal sekatan', 'rayuan sekatan'],
        pembelian_anak: ['anak beli tanpa izin'],
        hukum_media: ['lapor polis', 'peguam'],
        bahaya_diri: ['bunuh diri', 'cederakan diri'],
        minta_manusia: ['bercakap dengan manusia', 'ejen manusia'],
        no_promise: ['kami jamin bayaran balik'],
      },
    };

    for (const [locale, ruleMap] of Object.entries(defaultData)) {
      const map = new Map<string, string[]>();
      for (const [ruleKey, phrases] of Object.entries(ruleMap)) {
        map.set(ruleKey, phrases.map((p) => p.toLowerCase()));
      }
      this.phrasesCache.set(locale, map);
    }
  }
}
