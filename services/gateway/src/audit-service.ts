import { Database } from './db.js';

export type AuditAction =
  | 'conversation.claim'
  | 'message.send'
  | 'conversation.resolve'
  | 'settings.auto_reply'
  | 'settings.market_bot'
  | 'settings.rule_toggle'
  | 'attachment.view'
  | 'auth.login'
  | 'auth.logout';

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  action: AuditAction | string;
  target?: string | null;
  detail: Record<string, any>;
  created_at: Date;
}

export class AuditService {
  constructor(private db: Database) {}

  /**
   * Catat aksi penting ke tabel audit_log (Bagian 1 spec/09-produksi.md)
   * Saat ada sengketa dengan pemain, ini satu-satunya sumber kebenaran.
   */
  async log(params: {
    actorId?: string | null;
    action: AuditAction | string;
    target?: string | null;
    detail?: Record<string, any>;
  }): Promise<AuditLogEntry | null> {
    try {
      const { actorId = null, action, target = null, detail = {} } = params;
      const isUuid = actorId && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(actorId);
      const validActorUuid = isUuid ? actorId : null;
      const enrichedDetail = isUuid ? detail : { ...detail, raw_actor_id: actorId };

      const res = await this.db.pool.query(
        `INSERT INTO audit_log (actor_id, action, target, detail, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, actor_id, action, target, detail, created_at`,
        [validActorUuid, action, target, JSON.stringify(enrichedDetail)]
      );

      return res.rows[0];
    } catch (err: any) {
      console.error('[AuditService] Gagal mencatat audit log:', err.message);
      return null;
    }
  }

  /**
   * Mengambil daftar log audit terbaru
   */
  async getRecentLogs(limit = 100, action?: string, actorId?: string): Promise<AuditLogEntry[]> {
    let query = `
      SELECT al.*, a.name as actor_name, a.email as actor_email, a.role as actor_role
      FROM audit_log al
      LEFT JOIN agents a ON al.actor_id = a.id
      WHERE 1=1
    `;
    const values: any[] = [];

    if (action) {
      values.push(action);
      query += ` AND al.action = $${values.length}`;
    }

    if (actorId) {
      values.push(actorId);
      query += ` AND al.actor_id = $${values.length}`;
    }

    values.push(limit);
    query += ` ORDER BY al.created_at DESC LIMIT $${values.length}`;

    const res = await this.db.pool.query(query, values);
    return res.rows;
  }
}
