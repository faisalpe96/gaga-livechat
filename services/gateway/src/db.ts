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
} from './types.js';
import { validateTransition } from './state-machine.js';

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
