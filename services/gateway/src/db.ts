import pg from 'pg';
import { config } from './config.js';
import {
  Conversation,
  ConversationStatus,
  PlayerInfo,
  ClientContext,
  SenderType,
  StoredMessage,
  ResolutionReason,
  Agent,
  QueueItem,
  BotFeedback,
  DraftUsageReportItem,
  AutoReplyRule,
  BotPersona,
} from './types.js';
import { validateTransition, InvalidResolutionReasonError } from './state-machine.js';
import { calculateServiceMode, MarketSchedule, DEFAULT_MARKET_SCHEDULES } from './service-mode.js';
import { CategoryFieldService, CategoryFieldDefinition } from './category-field-service.js';

const { Pool } = pg;

export class Database {
  public pool: pg.Pool;

  constructor(connectionString = config.databaseUrl) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getOrCreateActiveConversation(
    player: PlayerInfo,
    context: ClientContext
  ): Promise<Conversation> {
    // 1. Cek sesi aktif yang belum resolved untuk player_uid ini
    const activeRes = await this.pool.query(
      `SELECT * FROM conversations 
       WHERE player_uid = $1 AND status != 'resolved' 
       ORDER BY started_at DESC LIMIT 1`,
      [player.uid]
    );

    const requestedPersona = context.bot_persona || context.persona;
    if (activeRes.rows.length > 0) {
      const row = activeRes.rows[0];
      if (requestedPersona && row.bot_persona !== requestedPersona) {
        await this.pool.query(`UPDATE conversations SET bot_persona = $1 WHERE id = $2`, [requestedPersona, row.id]);
        row.bot_persona = requestedPersona;
      } else if (!row.bot_persona) {
        const persona = requestedPersona || 'mira';
        await this.pool.query(`UPDATE conversations SET bot_persona = $1 WHERE id = $2`, [persona, row.id]);
        row.bot_persona = persona;
      }
      return this.mapConversation(row);
    }

    // 2. Buat percakapan baru dengan status default 'bot_active' dan stage default 'greeting'
    const market = context.market || 'ID';
    const locale = context.locale || 'id-ID';
    const pageContext = JSON.stringify(context || {});
    // Persona bot default Mira, atau sesuai yang diminta di context
    const persona = requestedPersona || 'mira';

    let serviceMode = 'business_hours';
    try {
      const mRes = await this.pool.query('SELECT * FROM markets WHERE code = $1', [market]);
      const mRow = mRes.rows[0];
      const modeInfo = calculateServiceMode(mRow);
      serviceMode = modeInfo.service_mode;
    } catch {
      serviceMode = calculateServiceMode({ code: market }).service_mode;
    }

    const insertRes = await this.pool.query(
      `INSERT INTO conversations (player_uid, market, locale, status, stage, page_context, bot_persona, service_mode, proactive_greeted, collected_fields, started_at)
       VALUES ($1, $2, $3, 'bot_active', 'greeting', $4, $5, $6, false, '{}', now())
       RETURNING *`,
      [player.uid, market, locale, pageContext, persona, serviceMode]
    );

    return this.mapConversation(insertRes.rows[0]);
  }

  async updateConversationPersona(id: string, persona: string): Promise<Conversation | null> {
    const validPersona = persona.toLowerCase() === 'reza' ? 'reza' : 'mira';
    const res = await this.pool.query(
      `UPDATE conversations SET bot_persona = $1 WHERE id = $2 RETURNING *`,
      [validPersona, id]
    );
    if (res.rows.length === 0) return null;
    return this.mapConversation(res.rows[0]);
  }

  async updateConversationCategory(
    id: string,
    category: string,
    subcategory?: string | null
  ): Promise<Conversation | null> {
    const res = await this.pool.query(
      `UPDATE conversations
       SET category = $1, subcategory = COALESCE($2, subcategory)
       WHERE id = $3 RETURNING *`,
      [category, subcategory || null, id]
    );
    if (res.rows.length === 0) return null;
    return this.mapConversation(res.rows[0]);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const res = await this.pool.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    return this.mapConversation(res.rows[0]);
  }

  async updateConversationStatus(
    id: string,
    newStatus: ConversationStatus,
    resolutionReason?: ResolutionReason | string,
    ticketId?: string,
    agentId?: string
  ): Promise<Conversation> {
    const conv = await this.getConversation(id);
    if (!conv) {
      throw new Error(`Percakapan '${id}' tidak ditemukan.`);
    }

    // Validasi aturan transisi ketat
    validateTransition(conv.status, newStatus);

    if (newStatus === 'resolved') {
      const reason = resolutionReason || conv.resolution_reason;
      const validReasons: ResolutionReason[] = [
        'bot_resolved',
        'agent_resolved',
        'ticket_created',
        'ticket_auto_created',
        'player_abandoned',
      ];
      if (!reason || !validReasons.includes(reason as ResolutionReason)) {
        throw new InvalidResolutionReasonError(
          `resolution_reason wajib diisi dengan nilai yang sah saat status 'resolved': ${validReasons.join(', ')}`
        );
      }
    }

    const isClosing = newStatus === 'resolved';

    const res = await this.pool.query(
      `UPDATE conversations
       SET status = $1,
           resolution_reason = COALESCE($2, resolution_reason),
           ticket_id = COALESCE($3, ticket_id),
           assigned_agent_id = COALESCE($4, assigned_agent_id),
           closed_at = (CASE WHEN $5 THEN now() ELSE closed_at END)
       WHERE id = $6
       RETURNING *`,
      [
        newStatus,
        resolutionReason || null,
        ticketId || null,
        agentId || null,
        isClosing,
        id,
      ]
    );

    return this.mapConversation(res.rows[0]);
  }

  async updateConversationLocale(id: string, locale: string): Promise<Conversation> {
    const res = await this.pool.query(
      `UPDATE conversations SET locale = $1 WHERE id = $2 RETURNING *`,
      [locale, id]
    );
    if (res.rows.length === 0) throw new Error(`Percakapan '${id}' tidak ditemukan.`);
    return this.mapConversation(res.rows[0]);
  }

  async saveMessage(params: {
    conversation_id: string;
    sender_type: SenderType;
    sender_id?: string;
    text: string;
    translated?: boolean;
    original_text?: string;
    meta?: Record<string, any>;
  }): Promise<StoredMessage> {
    const res = await this.pool.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_id, text, translated, original_text, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING *`,
      [
        params.conversation_id,
        params.sender_type,
        params.sender_id || null,
        params.text,
        params.translated ?? false,
        params.original_text || null,
        JSON.stringify(params.meta || {}),
      ]
    );

    return this.mapMessage(res.rows[0]);
  }

  async getMessages(conversationId: string, limit = 50, includeDrafts = false): Promise<StoredMessage[]> {
    const draftFilter = includeDrafts ? '' : "AND (meta->>'is_draft' IS NULL OR meta->>'is_draft' != 'true')";
    const res = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM messages 
         WHERE conversation_id = $1 ${draftFilter} 
         ORDER BY created_at DESC 
         LIMIT $2
       ) sub ORDER BY created_at ASC`,
      [conversationId, limit]
    );
    return res.rows.map((r) => this.mapMessage(r));
  }

  async seedInitialAgents(): Promise<void> {
    const agents = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Agent Budi (ID)',
        locales: ['id-ID', 'en'],
        status: 'online',
        max_concurrent: 5,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Agent Somchai (TH)',
        locales: ['th-TH', 'en'],
        status: 'online',
        max_concurrent: 5,
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Agent Nguyen (VN)',
        locales: ['vi-VN', 'en'],
        status: 'online',
        max_concurrent: 5,
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        name: 'Agent John (EN Only)',
        locales: ['en'],
        status: 'online',
        max_concurrent: 5,
      },
      {
        id: '55555555-5555-5555-5555-555555555555',
        name: 'Agent Maria (PH)',
        locales: ['fil-PH', 'en'],
        status: 'online',
        max_concurrent: 5,
      },
      {
        id: '66666666-6666-6666-6666-666666666666',
        name: 'Agent Siti (MY)',
        locales: ['ms-MY', 'en'],
        status: 'online',
        max_concurrent: 5,
      },
    ];

    for (const a of agents) {
      await this.pool.query(
        `INSERT INTO agents (id, name, locales, max_concurrent, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           locales = EXCLUDED.locales,
           max_concurrent = EXCLUDED.max_concurrent,
           status = EXCLUDED.status`,
        [a.id, a.name, a.locales, a.max_concurrent, a.status]
      );
    }
  }

  private mapAgent(row: any): Agent {
    return {
      id: row.id,
      name: row.name,
      locales: row.locales || [],
      max_concurrent: row.max_concurrent ?? 3,
      status: row.status || 'offline',
      email: row.email || null,
      role: row.role || 'agent',
      external_id: row.external_id || null,
      is_active: row.is_active ?? true,
      last_login_at: row.last_login_at ? new Date(row.last_login_at) : null,
    };
  }

  async getAgent(id: string): Promise<Agent | null> {
    const res = await this.pool.query(`SELECT * FROM agents WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    return this.mapAgent(res.rows[0]);
  }

  async getAgentByEmail(email: string): Promise<(Agent & { password_hash?: string }) | null> {
    const res = await this.pool.query(`SELECT * FROM agents WHERE LOWER(email) = LOWER($1)`, [email.trim()]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...this.mapAgent(row),
      password_hash: row.password_hash || undefined,
    };
  }

  async getAgentByExternalId(externalId: string): Promise<Agent | null> {
    const res = await this.pool.query(`SELECT * FROM agents WHERE external_id = $1`, [externalId]);
    if (res.rows.length === 0) return null;
    return this.mapAgent(res.rows[0]);
  }

  async createAgent(params: {
    name: string;
    email: string;
    password_hash?: string;
    role?: 'agent' | 'supervisor' | 'admin';
    locales?: string[];
    max_concurrent?: number;
    external_id?: string;
  }): Promise<Agent> {
    const {
      name,
      email,
      password_hash,
      role = 'agent',
      locales = ['id-ID', 'en'],
      max_concurrent = 3,
      external_id = null,
    } = params;

    const res = await this.pool.query(
      `INSERT INTO agents (name, email, password_hash, role, locales, max_concurrent, external_id, is_active)
       VALUES ($1, LOWER($2), $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [name, email.trim(), password_hash || null, role, locales, max_concurrent, external_id]
    );

    return this.mapAgent(res.rows[0]);
  }

  async updateAgentLastLogin(id: string): Promise<void> {
    await this.pool.query(`UPDATE agents SET last_login_at = NOW() WHERE id = $1`, [id]);
  }

  async createAgentSession(agentId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_sessions (agent_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [agentId, tokenHash, expiresAt.toISOString()]
    );
  }

  async getAgentSession(tokenHash: string): Promise<{ session: { id: string; expires_at: Date }; agent: Agent } | null> {
    const res = await this.pool.query(
      `SELECT s.id as session_id, s.expires_at, a.*
       FROM agent_sessions s
       JOIN agents a ON s.agent_id = a.id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND a.is_active = true`,
      [tokenHash]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      session: {
        id: row.session_id,
        expires_at: new Date(row.expires_at),
      },
      agent: this.mapAgent(row),
    };
  }

  async deleteAgentSession(tokenHash: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent_sessions WHERE token_hash = $1`, [tokenHash]);
  }

  async cleanExpiredSessions(): Promise<number> {
    const res = await this.pool.query(`DELETE FROM agent_sessions WHERE expires_at <= NOW()`);
    return res.rowCount || 0;
  }

  async listAgents(): Promise<Agent[]> {
    const res = await this.pool.query(`SELECT * FROM agents ORDER BY name ASC`);
    return res.rows.map((row) => this.mapAgent(row));
  }

  async getQueue(options: {
    agentId?: string;
    locale?: string;
    status?: ConversationStatus | ConversationStatus[];
  } = {}): Promise<QueueItem[]> {
    let allowedLocales: string[] | null = null;

    if (options.agentId) {
      const agent = await this.getAgent(options.agentId);
      if (!agent) {
        throw new Error(`Agent '${options.agentId}' tidak ditemukan.`);
      }
      allowedLocales = agent.locales;
    }

    const conditions: string[] = [
      "c.assigned_agent_id IS NULL",
    ];
    const params: any[] = [];

    if (options.status) {
      if (Array.isArray(options.status)) {
        params.push(options.status);
        conditions.push(`c.status = ANY($${params.length}::conversation_status[])`);
      } else {
        params.push(options.status);
        conditions.push(`c.status = $${params.length}`);
      }
    } else {
      // Default Mode Bayangan (TASK-08): Menampilkan percakapan yang sedang ditangani bot (bot_active)
      // maupun yang telah tereskalasi ke antrean (handoff_queued)
      conditions.push("c.status IN ('handoff_queued', 'bot_active')");
    }

    if (allowedLocales && allowedLocales.length > 0) {
      params.push(allowedLocales);
      conditions.push(`c.locale = ANY($${params.length}::text[])`);
    }

    if (options.locale) {
      if (allowedLocales && !allowedLocales.includes(options.locale)) {
        return [];
      }
      params.push(options.locale);
      conditions.push(`c.locale = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        c.*,
        h.reason AS handoff_reason,
        COALESCE(h.bot_summary, lm.text) AS bot_summary,
        h.queued_at AS queued_at
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT reason, bot_summary, queued_at
        FROM handoffs
        WHERE conversation_id = c.id
        ORDER BY queued_at DESC
        LIMIT 1
      ) h ON true
      LEFT JOIN LATERAL (
        SELECT text
        FROM messages
        WHERE conversation_id = c.id AND sender_type = 'player'
        ORDER BY created_at DESC
        LIMIT 1
      ) lm ON true
      ${whereClause}
      ORDER BY c.sla_due_at ASC NULLS LAST, c.started_at ASC
    `;

    const res = await this.pool.query(query, params);
    return res.rows.map((row) => ({
      ...this.mapConversation(row),
      handoff_reason: row.handoff_reason || null,
      bot_summary: row.bot_summary || null,
      queued_at: row.queued_at ? new Date(row.queued_at) : null,
    }));
  }

  async claimConversationAtomic(conversationId: string, agentId: string): Promise<Conversation> {
    const conv = await this.getConversation(conversationId);
    if (!conv) {
      const err = new Error(`Percakapan '${conversationId}' tidak ditemukan.`);
      (err as any).statusCode = 404;
      (err as any).code = 'NOT_FOUND';
      throw err;
    }

    if (conv.status === 'resolved') {
      const err = new Error('Percakapan sudah ditutup dan tidak dapat diklaim');
      (err as any).statusCode = 400;
      (err as any).code = 'CONVERSATION_RESOLVED';
      throw err;
    }

    if (conv.assigned_agent_id && conv.assigned_agent_id !== agentId) {
      const err = new Error('Percakapan sudah diklaim oleh agent lain');
      (err as any).statusCode = 409;
      (err as any).code = 'ALREADY_CLAIMED';
      throw err;
    }

    // Atomic update: only updates if assigned_agent_id IS NULL and status is claimable
    const res = await this.pool.query(
      `UPDATE conversations
       SET status = 'agent_active',
           assigned_agent_id = $1
       WHERE id = $2
         AND (status = 'handoff_queued' OR status = 'bot_active')
         AND assigned_agent_id IS NULL
       RETURNING *`,
      [agentId, conversationId]
    );

    if (res.rows.length === 0) {
      const current = await this.getConversation(conversationId);
      if (!current) {
        const err = new Error(`Percakapan '${conversationId}' tidak ditemukan.`);
        (err as any).statusCode = 404;
        (err as any).code = 'NOT_FOUND';
        throw err;
      }
      if (current.status === 'resolved') {
        const err = new Error('Percakapan sudah ditutup dan tidak dapat diklaim');
        (err as any).statusCode = 400;
        (err as any).code = 'CONVERSATION_RESOLVED';
        throw err;
      }
      const err = new Error('Percakapan sudah diklaim oleh agent lain');
      (err as any).statusCode = 409;
      (err as any).code = 'ALREADY_CLAIMED';
      throw err;
    }

    // Record picked_at in handoffs table
    await this.pool.query(
      `UPDATE handoffs
       SET picked_at = now(),
           agent_id = $1
       WHERE conversation_id = $2 AND picked_at IS NULL`,
      [agentId, conversationId]
    );

    return this.mapConversation(res.rows[0]);
  }

  async updateHandoffBotSummary(conversationId: string, summary: string): Promise<void> {
    await this.pool.query(
      `UPDATE handoffs
       SET bot_summary = $1
       WHERE conversation_id = $2 AND picked_at IS NULL`,
      [summary, conversationId]
    );
  }


  async saveBotFeedback(params: {
    message_id: string;
    verdict: 'accepted' | 'edited' | 'rejected' | 'auto_replied';
    corrected_text?: string | null;
    reviewer_id?: string | null;
  }): Promise<BotFeedback> {
    const existing = await this.pool.query(
      `SELECT id FROM bot_feedback WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [params.message_id]
    );

    let res;
    if (existing.rows.length > 0) {
      res = await this.pool.query(
        `UPDATE bot_feedback
         SET verdict = $1,
             corrected_text = $2,
             reviewer_id = $3,
             created_at = now()
         WHERE id = $4
         RETURNING *`,
        [
          params.verdict,
          params.corrected_text || null,
          params.reviewer_id || null,
          existing.rows[0].id,
        ]
      );
    } else {
      res = await this.pool.query(
        `INSERT INTO bot_feedback (message_id, verdict, corrected_text, reviewer_id, created_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING *`,
        [
          params.message_id,
          params.verdict,
          params.corrected_text || null,
          params.reviewer_id || null,
        ]
      );
    }
    const row = res.rows[0];
    return {
      id: row.id,
      message_id: row.message_id,
      verdict: row.verdict,
      corrected_text: row.corrected_text,
      reviewer_id: row.reviewer_id,
      created_at: new Date(row.created_at),
    };
  }

  async getBotFeedback(messageId: string): Promise<BotFeedback | null> {
    const res = await this.pool.query(
      `SELECT * FROM bot_feedback WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [messageId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      message_id: row.message_id,
      verdict: row.verdict,
      corrected_text: row.corrected_text,
      reviewer_id: row.reviewer_id,
      created_at: new Date(row.created_at),
    };
  }

  async getDraftMessages(conversationId: string): Promise<StoredMessage[]> {
    const res = await this.pool.query(
      `SELECT * FROM messages 
       WHERE conversation_id = $1 
         AND sender_type = 'bot' 
         AND (meta->>'is_draft')::boolean = true
       ORDER BY created_at DESC`,
      [conversationId]
    );
    return res.rows.map((r) => this.mapMessage(r));
  }

  async getDraftUsageReport(): Promise<DraftUsageReportItem[]> {
    const res = await this.pool.query(`
      SELECT 
        COALESCE(m.meta->>'intent', 'unknown') AS intent,
        c.locale AS locale,
        COALESCE(c.bot_persona, m.meta->>'bot_persona', 'mira') AS bot_persona,
        COUNT(f.id)::int AS total_reviewed,
        COUNT(CASE WHEN f.verdict IN ('accepted', 'auto_replied') THEN 1 END)::int AS used_unedited_count,
        COUNT(CASE WHEN f.verdict = 'edited' THEN 1 END)::int AS edited_count,
        COUNT(CASE WHEN f.verdict = 'rejected' THEN 1 END)::int AS rejected_count,
        ROUND(
          COUNT(CASE WHEN f.verdict IN ('accepted', 'auto_replied') THEN 1 END)::numeric / 
          NULLIF(COUNT(f.id), 0) * 100, 
          2
        )::float AS unedited_rate_percentage
      FROM bot_feedback f
      JOIN messages m ON f.message_id = m.id
      JOIN conversations c ON m.conversation_id = c.id
      GROUP BY COALESCE(m.meta->>'intent', 'unknown'), c.locale, COALESCE(c.bot_persona, m.meta->>'bot_persona', 'mira')
      ORDER BY unedited_rate_percentage DESC, total_reviewed DESC
    `);

    return res.rows.map((r) => ({
      intent: r.intent,
      locale: r.locale,
      bot_persona: r.bot_persona,
      total_reviewed: parseInt(r.total_reviewed, 10),
      used_unedited_count: parseInt(r.used_unedited_count, 10),
      edited_count: parseInt(r.edited_count, 10),
      rejected_count: parseInt(r.rejected_count, 10),
      unedited_rate_percentage: parseFloat(r.unedited_rate_percentage) || 0,
    }));
  }

  async ensureAutoReplyTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auto_reply_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        intent text NOT NULL,
        locale text NOT NULL,
        is_enabled boolean NOT NULL DEFAULT false,
        min_confidence numeric NOT NULL DEFAULT 0.85,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(intent, locale)
      );
    `);
  }

  async getAutoReplyRules(): Promise<AutoReplyRule[]> {
    await this.ensureAutoReplyTable();
    const res = await this.pool.query(`
      SELECT * FROM auto_reply_rules ORDER BY locale ASC, intent ASC
    `);
    return res.rows.map((r) => ({
      id: r.id,
      intent: r.intent,
      locale: r.locale,
      is_enabled: r.is_enabled,
      min_confidence: parseFloat(r.min_confidence),
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
    }));
  }

  async getAutoReplyRule(intent: string, locale: string): Promise<AutoReplyRule | null> {
    await this.ensureAutoReplyTable();
    const res = await this.pool.query(
      `SELECT * FROM auto_reply_rules WHERE intent = $1 AND locale = $2 LIMIT 1`,
      [intent, locale]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      intent: r.intent,
      locale: r.locale,
      is_enabled: r.is_enabled,
      min_confidence: parseFloat(r.min_confidence),
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
    };
  }

  async updateAutoReplyRule(
    intent: string,
    locale: string,
    is_enabled: boolean,
    min_confidence = 0.85
  ): Promise<AutoReplyRule> {
    await this.ensureAutoReplyTable();
    const res = await this.pool.query(
      `INSERT INTO auto_reply_rules (intent, locale, is_enabled, min_confidence, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (intent, locale) DO UPDATE SET
         is_enabled = EXCLUDED.is_enabled,
         min_confidence = EXCLUDED.min_confidence,
         updated_at = now()
       RETURNING *`,
      [intent, locale, is_enabled, min_confidence]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      intent: r.intent,
      locale: r.locale,
      is_enabled: r.is_enabled,
      min_confidence: parseFloat(r.min_confidence),
      created_at: new Date(r.created_at),
      updated_at: new Date(r.updated_at),
    };
  }

  async setMarketBotStatus(marketCode: string, is_bot_enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE markets SET is_bot_enabled = $1 WHERE code = $2`,
      [is_bot_enabled, marketCode]
    );
  }

  async seedDefaultAutoReplyRules(): Promise<void> {
    await this.ensureAutoReplyTable();
    await this.setMarketBotStatus('ID', true);

    const defaultRules = [
      { intent: 'topup_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
      { intent: 'topup_uncredited', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
      { intent: 'topup_clarification', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
      { intent: 'faq_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
      { intent: 'greeting', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
      { intent: 'vague_inquiry', locale: 'id-ID', is_enabled: true, min_confidence: 0.85 },
    ];

    for (const r of defaultRules) {
      await this.pool.query(
        `INSERT INTO auto_reply_rules (intent, locale, is_enabled, min_confidence)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (intent, locale) DO UPDATE SET is_enabled = true, min_confidence = EXCLUDED.min_confidence`,
        [r.intent, r.locale, r.is_enabled, r.min_confidence]
      );
    }
  }

  async isMarketBotEnabled(identifier: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT is_bot_enabled FROM markets 
       WHERE code = $1 OR default_locale = $1 OR $1 = ANY(supported_locales)`,
      [identifier]
    );
    if (res.rows.length === 0) return false;
    return Boolean(res.rows[0].is_bot_enabled);
  }

  async isAutoReplyAllowed(
    intent: string,
    locale: string,
    confidence: number
  ): Promise<{ allowed: boolean; reason?: string }> {
    // 1. Pemicu keras DILARANG KERAS auto-reply dalam kondisi apa pun
    const HARD_TRIGGERS = [
      'akun_terkunci',
      'refund',
      'banding_banned',
      'pembelian_anak',
      'hukum_media',
      'bahaya_diri',
    ];
    if (HARD_TRIGGERS.includes(intent)) {
      return {
        allowed: false,
        reason: `Intent '${intent}' adalah pemicu keras yang wajib ditangani agen manusia.`,
      };
    }

    // 2. Cek apakah pasar untuk locale ini mengaktifkan bot (markets.is_bot_enabled)
    const marketRes = await this.pool.query(
      `SELECT code, is_bot_enabled FROM markets 
       WHERE default_locale = $1 OR $1 = ANY(supported_locales)
       LIMIT 1`,
      [locale]
    );
    if (marketRes.rows.length === 0 || !marketRes.rows[0].is_bot_enabled) {
      return {
        allowed: false,
        reason: `Pasar untuk locale '${locale}' belum mengaktifkan bot (is_bot_enabled = false).`,
      };
    }

    // 3. Cek pagar pengaman bahaya_diri untuk locale ini
    const safetyRes = await this.pool.query(
      `SELECT count(*)::int AS cnt FROM guardrail_phrases WHERE rule_key = 'bahaya_diri' AND locale = $1`,
      [locale]
    );
    if ((safetyRes.rows[0]?.cnt || 0) === 0) {
      return {
        allowed: false,
        reason: `Frasa pengaman wajib 'bahaya_diri' belum lengkap untuk locale '${locale}'.`,
      };
    }

    // 4. Cek aturan daftar izin (auto_reply_rules)
    await this.ensureAutoReplyTable();
    let rule = await this.getAutoReplyRule(intent, locale);
    if (!rule && intent.startsWith('topup_')) {
      rule = await this.getAutoReplyRule('topup_inquiry', locale);
    }
    if (!rule && (intent === 'vague_inquiry' || intent === 'greeting')) {
      rule = await this.getAutoReplyRule('faq_inquiry', locale);
    }
    if (!rule || !rule.is_enabled) {
      return {
        allowed: false,
        reason: `Intent '${intent}' tidak terdaftar di daftar izin auto-reply untuk locale '${locale}'.`,
      };
    }

    // 5. Cek ambang keyakinan (confidence)
    if (confidence < rule.min_confidence) {
      return {
        allowed: false,
        reason: `Confidence (${confidence}) di bawah ambang minimum (${rule.min_confidence}).`,
      };
    }

    return { allowed: true };
  }

  async updateConversationStage(
    id: string,
    stage: string,
    collectedSlots?: Record<string, string>
  ): Promise<Conversation> {
    let query: string;
    let params: any[];

    if (collectedSlots && Object.keys(collectedSlots).length > 0) {
      query = `
        UPDATE conversations
        SET stage = $1,
            page_context = jsonb_set(
              COALESCE(page_context, '{}'::jsonb),
              '{collected_slots}',
              COALESCE(page_context->'collected_slots', '{}'::jsonb) || $2::jsonb,
              true
            )
        WHERE id = $3
        RETURNING *
      `;
      params = [stage, JSON.stringify(collectedSlots), id];
    } else {
      query = `
        UPDATE conversations
        SET stage = $1
        WHERE id = $2
        RETURNING *
      `;
      params = [stage, id];
    }

    const res = await this.pool.query(query, params);
    if (res.rows.length === 0) {
      throw new Error(`Percakapan '${id}' tidak ditemukan.`);
    }
    return this.mapConversation(res.rows[0]);
  }

  private mapConversation(row: any): Conversation {
    return {
      id: row.id,
      player_uid: row.player_uid,
      market: row.market,
      locale: row.locale,
      status: row.status,
      stage: (row.stage as any) || 'greeting',
      assigned_agent_id: row.assigned_agent_id,
      category: row.category,
      subcategory: row.subcategory,
      priority: row.priority,
      sla_due_at: row.sla_due_at ? new Date(row.sla_due_at) : null,
      resolution_reason: row.resolution_reason,
      ticket_id: row.ticket_id,
      page_context: typeof row.page_context === 'string' ? JSON.parse(row.page_context) : (row.page_context || {}),
      bot_persona: row.bot_persona || null,
      service_mode: (row.service_mode as any) || 'business_hours',
      proactive_greeted: row.proactive_greeted ?? false,
      collected_fields: typeof row.collected_fields === 'string' ? JSON.parse(row.collected_fields) : (row.collected_fields || {}),
      started_at: new Date(row.started_at),
      closed_at: row.closed_at ? new Date(row.closed_at) : null,
    };
  }

  async getBotPersona(persona: string, locale: string): Promise<BotPersona> {
    const validPersona = (persona || 'mira').toLowerCase();
    const res = await this.pool.query(
      `SELECT persona, locale, display_name, avatar_url FROM bot_personas WHERE persona = $1 AND locale = $2`,
      [validPersona, locale]
    );

    if (res.rows.length > 0) {
      return res.rows[0];
    }

    // Kriteria Terima 4 (spec/08-persona-bot.md):
    // Locale yang belum punya baris di bot_personas jatuh ke nama default dan mencatat peringatan, bukan gagal diam-diam.
    console.warn(`[BotPersona] Peringatan: Locale '${locale}' belum terdaftar di tabel bot_personas untuk persona '${validPersona}'. Menggunakan fallback nama default.`);
    const isReza = validPersona === 'reza';
    return {
      persona: validPersona,
      locale,
      display_name: isReza ? 'Reza' : 'Mira',
      avatar_url: isReza ? '/assets/agent-reza.png' : '/assets/agent-mira.png',
    };
  }

  async ensureBotPersonasTable(): Promise<void> {
    await this.pool.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS bot_persona text;

      CREATE TABLE IF NOT EXISTS bot_personas (
        persona      text NOT NULL,
        locale       text NOT NULL,
        display_name text NOT NULL,
        avatar_url   text NOT NULL,
        PRIMARY KEY (persona, locale)
      );
    `);

    const countRes = await this.pool.query('SELECT count(*)::int AS cnt FROM bot_personas');
    if (countRes.rows[0].cnt === 0) {
      const defaultPersonas = [
        ['mira', 'id-ID', 'Mira', '/assets/agent-mira.png'],
        ['mira', 'ms-MY', 'Mira', '/assets/agent-mira.png'],
        ['mira', 'en', 'Mira', '/assets/agent-mira.png'],
        ['mira', 'fil-PH', 'Mira', '/assets/agent-mira.png'],
        ['mira', 'th-TH', 'Ploy', '/assets/agent-mira.png'],
        ['mira', 'vi-VN', 'Linh', '/assets/agent-mira.png'],
        ['reza', 'id-ID', 'Reza', '/assets/agent-reza.png'],
        ['reza', 'ms-MY', 'Reza', '/assets/agent-reza.png'],
        ['reza', 'en', 'Ray', '/assets/agent-reza.png'],
        ['reza', 'fil-PH', 'Ray', '/assets/agent-reza.png'],
        ['reza', 'th-TH', 'Ton', '/assets/agent-reza.png'],
        ['reza', 'vi-VN', 'Minh', '/assets/agent-reza.png'],
      ];

      for (const [p, loc, name, av] of defaultPersonas) {
        await this.pool.query(
          `INSERT INTO bot_personas (persona, locale, display_name, avatar_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (persona, locale) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url`,
          [p, loc, name, av]
        );
      }
    }
  }

  async importBotPersonasFromCsv(csvText: string): Promise<number> {
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length <= 1) return 0;

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map(p => p.trim());
      if (parts.length >= 4) {
        await this.pool.query(
          `INSERT INTO bot_personas (persona, locale, display_name, avatar_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (persona, locale) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url`,
          [parts[0], parts[1], parts[2], parts[3]]
        );
        count++;
      }
    }
    return count;
  }

  async ensureInvestigationAndScheduleTables(): Promise<void> {
    await this.pool.query(`
      ALTER TABLE markets
        ADD COLUMN IF NOT EXISTS weekend_days   int[] NOT NULL DEFAULT '{6,7}',
        ADD COLUMN IF NOT EXISTS oncall_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS oncall_channel text;

      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS service_mode      text NOT NULL DEFAULT 'business_hours',
        ADD COLUMN IF NOT EXISTS sla_paused_at     timestamptz,
        ADD COLUMN IF NOT EXISTS proactive_greeted boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS collected_fields  jsonb NOT NULL DEFAULT '{}';
    `);

    // Inisialisasi tabel category_field_sets dan seed jika kosong
    await CategoryFieldService.ensureTableAndSeed(this.pool);
  }

  async setConversationProactiveGreeted(id: string): Promise<void> {
    await this.pool.query(`UPDATE conversations SET proactive_greeted = true WHERE id = $1`, [id]);
  }

  async updateConversationCollectedFields(id: string, collected: Record<string, string>): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET collected_fields = $1 WHERE id = $2`,
      [JSON.stringify(collected), id]
    );
  }

  async getConversationMessageCount(id: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT count(*)::int AS cnt FROM messages WHERE conversation_id = $1`,
      [id]
    );
    return res.rows[0]?.cnt || 0;
  }

  async getCategoryFieldDefinitions(category: string): Promise<CategoryFieldDefinition[]> {
    return CategoryFieldService.getFieldsForCategory(this.pool, category);
  }

  private mapMessage(row: any): StoredMessage {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      sender_type: row.sender_type,
      sender_id: row.sender_id,
      text: row.text,
      translated: row.translated,
      original_text: row.original_text,
      meta: row.meta || {},
      created_at: new Date(row.created_at),
    };
  }
}
