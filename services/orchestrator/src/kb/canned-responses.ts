import pg from 'pg';
import { CannedResponse, CannedResponseInput } from '../types.js';

export class CannedResponseService {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async getCannedResponse(templateId: string, locale: string): Promise<CannedResponse | null> {
    const res = await this.pool.query(
      `SELECT template_id, locale, category, body
       FROM canned_responses
       WHERE template_id = $1 AND locale = $2`,
      [templateId, locale]
    );

    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async listCannedResponses(options: { locale?: string; category?: string } = {}): Promise<CannedResponse[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.locale) {
      params.push(options.locale);
      conditions.push(`locale = $${params.length}`);
    }

    if (options.category) {
      params.push(options.category);
      conditions.push(`category = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT template_id, locale, category, body FROM canned_responses ${where} ORDER BY template_id ASC, locale ASC`,
      params
    );

    return res.rows;
  }

  async upsertCannedResponse(input: CannedResponseInput): Promise<CannedResponse> {
    const res = await this.pool.query(
      `INSERT INTO canned_responses (template_id, locale, category, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (template_id, locale) DO UPDATE SET
         category = EXCLUDED.category,
         body = EXCLUDED.body
       RETURNING *`,
      [input.template_id, input.locale, input.category, input.body]
    );

    return res.rows[0];
  }

  async upsertBatch(inputs: CannedResponseInput[]): Promise<number> {
    for (const item of inputs) {
      await this.upsertCannedResponse(item);
    }
    return inputs.length;
  }
}
