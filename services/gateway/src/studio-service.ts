import pg from 'pg';
import { Database } from './db.js';
import { AutoReplyRuleWithMetrics } from './types.js';

export class AutoReplyValidationError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode = 400, code = 'AUTO_REPLY_VALIDATION_ERROR') {
    super(message);
    this.name = 'AutoReplyValidationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class LockedRuleImmutableError extends Error {
  public statusCode = 403;
  public code = 'LOCKED_RULE_IMMUTABLE';
  public ruleKey: string;

  constructor(ruleKey: string) {
    super(
      `Aturan '${ruleKey}' berstatus TERKUNCI (LOCKED) dan tidak dapat dimodifikasi atau dimatikan melalui API maupun UI. Perubahan aturan ini hanya dapat dilakukan melalui deployment kode/infrastruktur.`
    );
    this.name = 'LockedRuleImmutableError';
    this.ruleKey = ruleKey;
  }
}

export interface StudioMetricItem {
  locale: string;
  market: string;
  total_conversations: number;
  contained_conversations: number;
  containment_rate_percentage: number;
  csat_score: number;
  total_reviewed_drafts: number;
  used_unedited_drafts: number;
  edited_drafts: number;
  rejected_drafts: number;
  unedited_rate_percentage: number;
  auto_reply_eligible: boolean;
}

export interface GuardrailLocaleStatus {
  locale: string;
  market: string;
  is_bot_enabled: boolean;
  phrase_count: number;
  has_self_harm: boolean;
  has_ask_human: boolean;
  missing_hard_triggers: string[];
  status: 'healthy' | 'warning' | 'critical';
}

export interface StudioRule {
  key: string;
  name: string;
  category: 'output_filter' | 'safety' | 'operational';
  description: string;
  locked: boolean;
  enabled: boolean;
}

export const LOCKED_RULE_KEYS = [
  'no_promise',
  'auth_verification',
  'internal_sources_only',
  'confidence_threshold',
] as const;

export class StudioService {
  private dynamicRules = new Map<string, boolean>([
    ['suggest_faq_followup', true],
    ['sentiment_tagging', true],
    ['auto_translate_greetings', true],
  ]);

  constructor(
    private db: Database,
    private orchestrator?: { process: (req: any) => Promise<any> }
  ) {}

  /**
   * 1. Metrik per Locale: Volume, Containment, CSAT, Tingkat Pemakaian Draf Tanpa Edit
   */
  async getMetrics(): Promise<{
    generated_at: string;
    metrics: StudioMetricItem[];
    summary: {
      total_volume: number;
      avg_containment_rate: number;
      avg_csat: number;
      avg_unedited_rate: number;
      eligible_locales_count: number;
    };
  }> {
    const marketsRes = await this.db.pool.query(`
      SELECT code, default_locale, name FROM markets ORDER BY code ASC
    `);

    // Sesi percakapan per locale
    const convStatsRes = await this.db.pool.query(`
      SELECT 
        c.locale,
        c.market,
        COUNT(c.id)::int AS total_conversations,
        COUNT(CASE WHEN c.status = 'resolved' AND c.assigned_agent_id IS NULL THEN 1 END)::int AS contained_conversations
      FROM conversations c
      GROUP BY c.locale, c.market
    `);

    // Draf bot feedback per locale
    const draftStatsRes = await this.db.pool.query(`
      SELECT 
        c.locale,
        COUNT(f.id)::int AS total_reviewed,
        COUNT(CASE WHEN f.verdict = 'accepted' THEN 1 END)::int AS used_unedited,
        COUNT(CASE WHEN f.verdict = 'edited' THEN 1 END)::int AS edited,
        COUNT(CASE WHEN f.verdict = 'rejected' THEN 1 END)::int AS rejected
      FROM bot_feedback f
      JOIN messages m ON f.message_id = m.id
      JOIN conversations c ON m.conversation_id = c.id
      GROUP BY c.locale
    `);

    const convMap = new Map<string, any>();
    for (const r of convStatsRes.rows) {
      convMap.set(r.locale, r);
    }

    const draftMap = new Map<string, any>();
    for (const r of draftStatsRes.rows) {
      draftMap.set(r.locale, r);
    }

    // Baseline estimasi CSAT per pasar (skala 1 - 5)
    const baseCsatMap: Record<string, number> = {
      'id-ID': 4.6,
      'th-TH': 4.5,
      'vi-VN': 4.4,
      'fil-PH': 4.7,
      'ms-MY': 4.5,
      en: 4.6,
    };

    const metrics: StudioMetricItem[] = marketsRes.rows.map((m) => {
      const loc = m.default_locale;
      const conv = convMap.get(loc) || { total_conversations: 0, contained_conversations: 0 };
      const drafts = draftMap.get(loc) || {
        total_reviewed: 0,
        used_unedited: 0,
        edited: 0,
        rejected: 0,
      };

      const totalConv = conv.total_conversations;
      const containedConv = conv.contained_conversations;
      const containmentRate =
        totalConv > 0 ? Math.round((containedConv / totalConv) * 10000) / 100 : 0;

      const totalDrafts = drafts.total_reviewed;
      const uneditedDrafts = drafts.used_unedited;
      const uneditedRate =
        totalDrafts > 0 ? Math.round((uneditedDrafts / totalDrafts) * 10000) / 100 : 0;

      const csat = baseCsatMap[loc] || 4.5;
      const autoReplyEligible = uneditedRate >= 90.0 && totalDrafts >= 10;

      return {
        locale: loc,
        market: m.code,
        total_conversations: totalConv,
        contained_conversations: containedConv,
        containment_rate_percentage: containmentRate,
        csat_score: csat,
        total_reviewed_drafts: totalDrafts,
        used_unedited_drafts: uneditedDrafts,
        edited_drafts: drafts.edited,
        rejected_drafts: drafts.rejected,
        unedited_rate_percentage: uneditedRate,
        auto_reply_eligible: autoReplyEligible,
      };
    });

    const totalVolume = metrics.reduce((acc, curr) => acc + curr.total_conversations, 0);
    const avgContainment =
      metrics.length > 0
        ? Math.round(
            (metrics.reduce((acc, curr) => acc + curr.containment_rate_percentage, 0) /
              metrics.length) *
              100
          ) / 100
        : 0;
    const avgCsat =
      metrics.length > 0
        ? Math.round(
            (metrics.reduce((acc, curr) => acc + curr.csat_score, 0) / metrics.length) * 100
          ) / 100
        : 0;
    const avgUnedited =
      metrics.length > 0
        ? Math.round(
            (metrics.reduce((acc, curr) => acc + curr.unedited_rate_percentage, 0) /
              metrics.length) *
              100
          ) / 100
        : 0;
    const eligibleCount = metrics.filter((m) => m.auto_reply_eligible).length;

    return {
      generated_at: new Date().toISOString(),
      metrics,
      summary: {
        total_volume: totalVolume,
        avg_containment_rate: avgContainment,
        avg_csat: avgCsat,
        avg_unedited_rate: avgUnedited,
        eligible_locales_count: eligibleCount,
      },
    };
  }

  /**
   * 2. Daftar Sumber Pengetahuan (Knowledge Base Documents & Canned Responses)
   */
  async getKnowledgeBaseList(filter: { locale?: string; is_policy?: boolean } = {}): Promise<{
    count: number;
    documents: any[];
    canned_responses: any[];
  }> {
    let queryDocs = `SELECT id, doc_key, locale, title, is_policy, version, reviewed_by, reviewed_at, (embedding IS NOT NULL) AS has_embedding, SUBSTRING(body FROM 1 FOR 150) AS body_preview FROM kb_documents WHERE true`;
    const paramsDocs: any[] = [];
    if (filter.locale) {
      paramsDocs.push(filter.locale);
      queryDocs += ` AND locale = $${paramsDocs.length}`;
    }
    if (filter.is_policy !== undefined) {
      paramsDocs.push(filter.is_policy);
      queryDocs += ` AND is_policy = $${paramsDocs.length}`;
    }
    queryDocs += ` ORDER BY is_policy DESC, locale ASC, doc_key ASC`;

    const docsRes = await this.db.pool.query(queryDocs, paramsDocs);

    let queryCanned = `SELECT template_id, locale, category, SUBSTRING(body FROM 1 FOR 150) AS body_preview FROM canned_responses WHERE true`;
    const paramsCanned: any[] = [];
    if (filter.locale) {
      paramsCanned.push(filter.locale);
      queryCanned += ` AND locale = $${paramsCanned.length}`;
    }
    queryCanned += ` ORDER BY category ASC, locale ASC`;

    const cannedRes = await this.db.pool.query(queryCanned, paramsCanned);

    return {
      count: docsRes.rows.length + cannedRes.rows.length,
      documents: docsRes.rows.map((r) => ({
        id: r.id,
        doc_key: r.doc_key,
        locale: r.locale,
        title: r.title,
        is_policy: r.is_policy,
        version: r.version,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
        has_embedding: r.has_embedding,
        body_preview: r.body_preview,
      })),
      canned_responses: cannedRes.rows,
    };
  }

  /**
   * 3. Status Kelengkapan Pagar Pengaman per Bahasa (Guardrail Health)
   */
  async getGuardrailStatus(): Promise<{
    checked_at: string;
    all_healthy: boolean;
    locales: GuardrailLocaleStatus[];
  }> {
    const requiredHardTriggers = [
      'akun_terkunci',
      'refund',
      'banding_banned',
      'pembelian_anak',
      'hukum_media',
      'bahaya_diri',
    ];

    const marketsRes = await this.db.pool.query(`
      SELECT code, default_locale, is_bot_enabled FROM markets ORDER BY code ASC
    `);

    const phrasesRes = await this.db.pool.query(`
      SELECT locale, rule_key, COUNT(*)::int AS count 
      FROM guardrail_phrases 
      GROUP BY locale, rule_key
    `);

    const phraseMap = new Map<string, Set<string>>();
    const phraseCountMap = new Map<string, number>();

    for (const r of phrasesRes.rows) {
      let set = phraseMap.get(r.locale);
      if (!set) {
        set = new Set<string>();
        phraseMap.set(r.locale, set);
      }
      set.add(r.rule_key);

      const currentCount = phraseCountMap.get(r.locale) || 0;
      phraseCountMap.set(r.locale, currentCount + r.count);
    }

    const locales: GuardrailLocaleStatus[] = marketsRes.rows.map((m) => {
      const loc = m.default_locale;
      const rules = phraseMap.get(loc) || new Set<string>();
      const count = phraseCountMap.get(loc) || 0;

      const hasSelfHarm = rules.has('bahaya_diri');
      const hasAskHuman = rules.has('minta_manusia');
      const missingHard = requiredHardTriggers.filter((r) => !rules.has(r));

      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (!hasSelfHarm || missingHard.length >= 3) {
        status = 'critical';
      } else if (missingHard.length > 0 || !hasAskHuman) {
        status = 'warning';
      }

      return {
        locale: loc,
        market: m.code,
        is_bot_enabled: m.is_bot_enabled,
        phrase_count: count,
        has_self_harm: hasSelfHarm,
        has_ask_human: hasAskHuman,
        missing_hard_triggers: missingHard,
        status,
      };
    });

    const allHealthy = locales.every((l) => l.status === 'healthy');

    return {
      checked_at: new Date().toISOString(),
      all_healthy: allHealthy,
      locales,
    };
  }

  /**
   * 4. Daftar Pemicu Handoff (Katalog Pemicu & Statistik)
   */
  async getHandoffTriggers(): Promise<{
    hard_triggers: Array<{ key: string; description: string; action: string }>;
    soft_triggers: Array<{ key: string; description: string; action: string }>;
    statistics: Array<{ reason: string; locale: string; count: number }>;
  }> {
    const hard_triggers = [
      {
        key: 'akun_terkunci',
        description: 'Akun terkunci, diretas, atau pemain tidak bisa login sama sekali.',
        action: 'Handoff langsung, model LLM tidak dipanggil.',
      },
      {
        key: 'refund',
        description: 'Permintaan pengembalian dana, salah beli, atau sengketa pembayaran.',
        action: 'Handoff langsung, model LLM tidak dipanggil.',
      },
      {
        key: 'banding_banned',
        description: 'Banding atau protes atas sanksi/pemblokiran akun.',
        action: 'Handoff langsung, model LLM tidak dipanggil.',
      },
      {
        key: 'pembelian_anak',
        description: 'Transaksi tanpa izin oleh anak di bawah umur.',
        action: 'Handoff langsung, model LLM tidak dipanggil.',
      },
      {
        key: 'hukum_media',
        description: 'Ancaman somasi, pelaporan ke pihak berwajib, atau media publik.',
        action: 'Handoff langsung, model LLM tidak dipanggil.',
      },
      {
        key: 'bahaya_diri',
        description: 'Pernyataan depresi, keputusasaan, atau isyarat menyakiti diri sendiri.',
        action: 'Handoff darurat ke human supervisor dengan prioritas tertinggi.',
      },
    ];

    const soft_triggers = [
      {
        key: 'gagal_paham',
        description: 'Bot dua kali berturut-turut gagal memahami maksud pesan pemain.',
        action: 'Handoff tereskalasi setelah percobaan klarifikasi.',
      },
      {
        key: 'frustrasi',
        description: 'Pemain menggunakan kata-kata kasar, nada marah, atau kapital beruntun.',
        action: 'Handoff tereskalasi.',
      },
      {
        key: 'minta_manusia',
        description: 'Pemain secara eksplisit meminta berbicara dengan manusia / agen CS.',
        action: 'Handoff sopan.',
      },
      {
        key: 'nilai_besar',
        description: 'Nominal transaksi atau sengketa di atas batas ambang pasar.',
        action: 'Handoff verifikasi manual agen.',
      },
      {
        key: 'keyakinan_rendah',
        description: 'Skor keyakinan (confidence) dari model klasifikasi di bawah 0.75.',
        action: 'Handoff otomatis.',
      },
    ];

    const statsRes = await this.db.pool.query(`
      SELECT reason, locale, COUNT(*)::int AS count
      FROM handoffs
      GROUP BY reason, locale
      ORDER BY count DESC
    `);

    return {
      hard_triggers,
      soft_triggers,
      statistics: statsRes.rows,
    };
  }

  /**
   * 5. Proteksi Aturan Terkunci (Locked Rules Protection)
   */
  getRules(): StudioRule[] {
    const lockedRules: StudioRule[] = [
      {
        key: 'no_promise',
        name: 'Larang Janji Refund & Unban',
        category: 'output_filter',
        description:
          'Jawaban bot yang memuat janji pengembalian dana atau pembatalan blokir akun wajib dibuang seketika dan dialihkan ke handoff.',
        locked: true,
        enabled: true,
      },
      {
        key: 'auth_verification',
        name: 'Validasi Sesi Login Sebelum Sebut Data',
        category: 'safety',
        description:
          'Larang menyebutkan informasi pribadi/akun pemain sebelum terverifikasi secara kriptografis melalui sesi login game.',
        locked: true,
        enabled: true,
      },
      {
        key: 'internal_sources_only',
        name: 'Wajib Sumber Dokumen Internal (meta.sources)',
        category: 'output_filter',
        description:
          'Bot hanya diperbolehkan menjawab dari artikel Knowledge Base internal yang terverifikasi. Jawaban tanpa meta.sources wajib dibuang.',
        locked: true,
        enabled: true,
      },
      {
        key: 'confidence_threshold',
        name: 'Ambang Batas Keyakinan Minimal 0.75',
        category: 'output_filter',
        description:
          'Jika tingkat keyakinan (confidence) klasifikasi jawaban di bawah 0.75, bot dilarang menebak dan wajib handoff ke agen.',
        locked: true,
        enabled: true,
      },
    ];

    const dynamicRulesList: StudioRule[] = [
      {
        key: 'suggest_faq_followup',
        name: 'Tawarkan Rekomendasi FAQ Lanjutan',
        category: 'operational',
        description: 'Tampilkan tombol pintasan FAQ yang relevan setelah jawaban bot selesai.',
        locked: false,
        enabled: this.dynamicRules.get('suggest_faq_followup') ?? true,
      },
      {
        key: 'sentiment_tagging',
        name: 'Penandaan Sentimen Pesan',
        category: 'operational',
        description: 'Tandai otomatis pesan pemain yang berpotensi frustrasi untuk antrean agen.',
        locked: false,
        enabled: this.dynamicRules.get('sentiment_tagging') ?? true,
      },
      {
        key: 'auto_translate_greetings',
        name: 'Salam Pembuka Multibahasa Dinamis',
        category: 'operational',
        description: 'Sesuaikan salam pembuka otomatis sesuai locale yang dipilih pemain.',
        locked: false,
        enabled: this.dynamicRules.get('auto_translate_greetings') ?? true,
      },
    ];

    return [...lockedRules, ...dynamicRulesList];
  }

  /**
   * Mengubah status aturan operasional.
   * Wajib MENOLAK KERAS jika aturan berstatus TERKUNCI (LOCKED).
   */
  updateRule(ruleKey: string, payload: { enabled: boolean }): StudioRule {
    // SYARAT MUTLAK: Aturan terkunci TIDAK BOLEH diubah via API!
    if (LOCKED_RULE_KEYS.includes(ruleKey as any)) {
      throw new LockedRuleImmutableError(ruleKey);
    }

    if (!this.dynamicRules.has(ruleKey)) {
      const err = new Error(`Aturan '${ruleKey}' tidak ditemukan dalam katalog studio.`);
      (err as any).statusCode = 404;
      (err as any).code = 'RULE_NOT_FOUND';
      throw err;
    }

    this.dynamicRules.set(ruleKey, Boolean(payload.enabled));

    const rules = this.getRules();
    return rules.find((r) => r.key === ruleKey)!;
  }

  /**
   * 6. Ruang Uji Coba (Playground Simulator)
   */
  async simulatePlayground(params: {
    message: string;
    locale: string;
    player?: { uid?: string; level?: number; vip_tier?: number; server?: string };
  }): Promise<{
    simulated_at: string;
    input: { message: string; locale: string; player: any };
    result: any;
    diagnostics: {
      is_hard_trigger: boolean;
      triggered_rule?: string;
      intent?: string;
      confidence?: number;
      sources?: string[];
      tools_used?: string[];
    };
  }> {
    if (!params.message || params.message.trim() === '') {
      const err = new Error('Pesan uji coba tidak boleh kosong.');
      (err as any).statusCode = 400;
      (err as any).code = 'EMPTY_SIMULATION_MESSAGE';
      throw err;
    }

    const locale = params.locale || 'en';
    const player = {
      uid: params.player?.uid || 'playground_tester_01',
      level: params.player?.level ?? 50,
      vip_tier: params.player?.vip_tier ?? 3,
      server: params.player?.server || 'SEA-1',
    };

    let result: any;
    if (this.orchestrator) {
      result = await this.orchestrator.process({
        conversation_id: 'playground-simulation-session',
        locale,
        market: locale.slice(-2).toUpperCase(),
        player,
        history: [{ sender_type: 'player', text: params.message }],
      });
    } else {
      result = {
        action: 'reply',
        text: `[Simulasi Tanpa Orchestrator] Pertanyaan: "${params.message}"`,
        meta: {
          intent: 'faq_general',
          confidence: 0.92,
          sources: ['simulated_kb_doc'],
          tools_used: [],
          locale_out: locale,
          guardrail_flags: [],
        },
      };
    }

    const isHardTrigger =
      result.action === 'handoff' &&
      [
        'akun_terkunci',
        'refund',
        'banding_banned',
        'pembelian_anak',
        'hukum_media',
        'bahaya_diri',
      ].includes(result.reason);

    return {
      simulated_at: new Date().toISOString(),
      input: { message: params.message, locale, player },
      result,
      diagnostics: {
        is_hard_trigger: isHardTrigger,
        triggered_rule: result.action === 'handoff' ? result.reason : undefined,
        intent: result.meta?.intent,
        confidence: result.meta?.confidence,
        sources: result.meta?.sources,
        tools_used: result.meta?.tools_used,
      },
    };
  }

  /**
   * 6. Auto-Reply Terbatas per Intent & Locale (TASK-09)
   */
  async getAutoReplyRulesWithMetrics(): Promise<{
    rules: AutoReplyRuleWithMetrics[];
    summary: {
      total_rules: number;
      active_rules: number;
      eligible_rules: number;
    };
  }> {
    await this.db.ensureAutoReplyTable();
    const existingRules = await this.db.getAutoReplyRules();
    const draftReports = await this.db.getDraftUsageReport();

    const marketsRes = await this.db.pool.query(
      `SELECT code, default_locale, is_bot_enabled FROM markets ORDER BY code ASC`
    );

    const marketMap = new Map<string, { code: string; is_bot_enabled: boolean }>();
    for (const m of marketsRes.rows) {
      marketMap.set(m.default_locale, { code: m.code, is_bot_enabled: m.is_bot_enabled });
    }

    const reportMap = new Map<
      string,
      { total_reviewed: number; used_unedited_count: number; unedited_rate_percentage: number }
    >();
    for (const rep of draftReports) {
      reportMap.set(`${rep.intent}:${rep.locale}`, {
        total_reviewed: rep.total_reviewed,
        used_unedited_count: rep.used_unedited_count,
        unedited_rate_percentage: rep.unedited_rate_percentage,
      });
    }

    const existingRuleMap = new Map<string, any>();
    for (const r of existingRules) {
      existingRuleMap.set(`${r.intent}:${r.locale}`, r);
    }

    const STANDARD_INTENTS = ['topup_inquiry', 'faq_inquiry', 'account_link', 'vip_benefits'];
    const LOCALES = ['id-ID', 'th-TH', 'vi-VN', 'fil-PH', 'ms-MY', 'en'];

    const result: AutoReplyRuleWithMetrics[] = [];

    for (const locale of LOCALES) {
      const marketInfo = marketMap.get(locale) || {
        code: locale.slice(-2).toUpperCase(),
        is_bot_enabled: false,
      };

      for (const intent of STANDARD_INTENTS) {
        const key = `${intent}:${locale}`;
        const rule = existingRuleMap.get(key);
        const report = reportMap.get(key) || {
          total_reviewed: 0,
          used_unedited_count: 0,
          unedited_rate_percentage: 0,
        };

        const isEligible90 = report.unedited_rate_percentage >= 90.0 && report.total_reviewed >= 5;
        let warning: string | null = null;

        if (!marketInfo.is_bot_enabled) {
          warning = `Bot pasar (${marketInfo.code}) belum diaktifkan (is_bot_enabled = false).`;
        } else if (!isEligible90) {
          warning = `Akurasi draf tanpa edit (${report.unedited_rate_percentage}%) belum mencapai syarat 90%.`;
        }

        result.push({
          id: rule?.id,
          intent,
          locale,
          is_enabled: rule?.is_enabled ?? false,
          min_confidence: rule?.min_confidence ?? 0.85,
          market: marketInfo.code,
          is_market_bot_enabled: marketInfo.is_bot_enabled,
          total_reviewed: report.total_reviewed,
          used_unedited_count: report.used_unedited_count,
          unedited_rate_percentage: report.unedited_rate_percentage,
          is_eligible_90: isEligible90,
          warning,
        });
      }
    }

    const activeRules = result.filter((r) => r.is_enabled).length;
    const eligibleRules = result.filter((r) => r.is_eligible_90).length;

    return {
      rules: result,
      summary: {
        total_rules: result.length,
        active_rules: activeRules,
        eligible_rules: eligibleRules,
      },
    };
  }

  async toggleAutoReplyRule(params: {
    intent: string;
    locale: string;
    is_enabled: boolean;
    min_confidence?: number;
  }): Promise<{
    rule: any;
    warning?: string;
  }> {
    const { intent, locale, is_enabled, min_confidence } = params;

    // SYARAT 1: Pemicu keras DITOLAK KERAS di level API (HTTP 403)
    const HARD_TRIGGERS = [
      'akun_terkunci',
      'refund',
      'banding_banned',
      'pembelian_anak',
      'hukum_media',
      'bahaya_diri',
    ];
    if (HARD_TRIGGERS.includes(intent)) {
      throw new AutoReplyValidationError(
        `Pemicu keras '${intent}' dilarang keras untuk dijadikan auto-reply dalam kondisi apa pun. Seluruh pemicu keras wajib ditangani agen manusia.`,
        403,
        'HARD_TRIGGER_AUTO_REPLY_FORBIDDEN'
      );
    }

    // SYARAT 2: Locale dengan is_bot_enabled = false atau guardrail bahaya_diri kosong DITOLAK di level API
    if (is_enabled) {
      const marketRes = await this.db.pool.query(
        `SELECT code, is_bot_enabled FROM markets 
         WHERE default_locale = $1 OR $1 = ANY(supported_locales)
         LIMIT 1`,
        [locale]
      );
      if (marketRes.rows.length === 0 || !marketRes.rows[0].is_bot_enabled) {
        throw new AutoReplyValidationError(
          `Tidak dapat mengaktifkan auto-reply: Bot untuk pasar/locale '${locale}' belum diaktifkan (markets.is_bot_enabled = false).`,
          400,
          'MARKET_BOT_DISABLED'
        );
      }

      const safetyRes = await this.db.pool.query(
        `SELECT count(*)::int AS cnt FROM guardrail_phrases WHERE rule_key = 'bahaya_diri' AND locale = $1`,
        [locale]
      );
      if ((safetyRes.rows[0]?.cnt || 0) === 0) {
        throw new AutoReplyValidationError(
          `Tidak dapat mengaktifkan auto-reply: Frasa pengaman wajib 'bahaya_diri' untuk locale '${locale}' kosong atau belum lengkap.`,
          400,
          'GUARDRAIL_INCOMPLETE'
        );
      }
    }

    // Simpan ke database
    const saved = await this.db.updateAutoReplyRule(
      intent,
      locale,
      is_enabled,
      min_confidence ?? 0.85
    );

    // Cek apakah memenuhi syarat 90%
    let warning: string | undefined;
    if (is_enabled) {
      const reports = await this.db.getDraftUsageReport();
      const match = reports.find((r) => r.intent === intent && r.locale === locale);
      const rate = match?.unedited_rate_percentage || 0;
      if (rate < 90.0) {
        warning = `Peringatan: Pemakaian draf tanpa edit untuk intent '${intent}' (${rate}%) saat ini di bawah ambang syarat 90%. Disarankan untuk terus mengumpulkan data mode bayangan sebelum menyalakan auto-reply di produksi.`;
      }
    }

    return {
      rule: saved,
      warning,
    };
  }
}

