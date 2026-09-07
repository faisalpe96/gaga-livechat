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
} from './types.js';
import { validateTransition, InvalidResolutionReasonError } from './state-machine.js';

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

    if (activeRes.rows.length > 0) {
      const row = activeRes.rows[0];
      return this.mapConversation(row);
    }

    // 2. Buat percakapan baru dengan status default 'bot_active'
    const market = context.market || 'ID';
    const locale = context.locale || 'id-ID';
    const pageContext = JSON.stringify(context || {});

    const insertRes = await this.pool.query(
      `INSERT INTO conversations (player_uid, market, locale, status, page_context, started_at)
       VALUES ($1, $2, $3, 'bot_active', $4, now())
       RETURNING *`,
      [player.uid, market, locale, pageContext]
    );

    return this.mapConversation(insertRes.rows[0]);
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

  async getMessages(conversationId: string, limit = 50): Promise<StoredMessage[]> {
    const res = await this.pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`,
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

  async getAgent(id: string): Promise<Agent | null> {
    const res = await this.pool.query(`SELECT * FROM agents WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      locales: row.locales,
      max_concurrent: row.max_concurrent,
      status: row.status,
    };
  }

  async listAgents(): Promise<Agent[]> {
    const res = await this.pool.query(`SELECT * FROM agents ORDER BY name ASC`);
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      locales: row.locales,
      max_concurrent: row.max_concurrent,
      status: row.status,
    }));
  }

  async getQueue(options: { agentId?: string; locale?: string } = {}): Promise<QueueItem[]> {
    let allowedLocales: string[] | null = null;

    if (options.agentId) {
      const agent = await this.getAgent(options.agentId);
      if (!agent) {
        throw new Error(`Agent '${options.agentId}' tidak ditemukan.`);
      }
      allowedLocales = agent.locales;
    }

    const conditions: string[] = [
      "c.status = 'handoff_queued'",
      "c.assigned_agent_id IS NULL",
    ];
    const params: any[] = [];

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
        h.bot_summary AS bot_summary,
        h.queued_at AS queued_at
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT reason, bot_summary, queued_at
        FROM handoffs
        WHERE conversation_id = c.id
        ORDER BY queued_at DESC
        LIMIT 1
      ) h ON true
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

  private mapConversation(row: any): Conversation {
    return {
      id: row.id,
      player_uid: row.player_uid,
      market: row.market,
      locale: row.locale,
      status: row.status,
      assigned_agent_id: row.assigned_agent_id,
      category: row.category,
      subcategory: row.subcategory,
      priority: row.priority,
      sla_due_at: row.sla_due_at ? new Date(row.sla_due_at) : null,
      resolution_reason: row.resolution_reason,
      ticket_id: row.ticket_id,
      page_context: row.page_context || {},
      started_at: new Date(row.started_at),
      closed_at: row.closed_at ? new Date(row.closed_at) : null,
    };
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
