import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { Database } from './db.js';
import { RedisPubSub } from './redis.js';
import { WebSocketHub } from './websocket-hub.js';
import { verifyGameSessionToken } from './auth.js';
import { InvalidStatusTransitionError } from './state-machine.js';
import { ConversationStatus, ResolutionReason } from './types.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  databaseUrl?: string;
  redisUrl?: string;
  db?: Database;
  pubsub?: RedisPubSub;
}

export async function buildGatewayServer(opts: ServerOptions = {}): Promise<{
  app: FastifyInstance;
  db: Database;
  pubsub: RedisPubSub;
  hub: WebSocketHub;
}> {
  const app = Fastify({ logger: false });
  const db = opts.db || new Database(opts.databaseUrl);
  const pubsub = opts.pubsub || new RedisPubSub(opts.redisUrl);
  await pubsub.init();
  const hub = new WebSocketHub(db, pubsub);

  await app.register(fastifyWebsocket);

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', service: 'chat-gateway' };
  });

  // WebSocket endpoint: /v1/socket
  app.get('/v1/socket', { websocket: true }, (socket, req) => {
    const query = (req.query as Record<string, string>) || {};
    const token = query.token || (req.headers['authorization'] as string);
    const isAgent = query.agent === 'true';

    // Verifikasi auth
    verifyGameSessionToken(token)
      .then((player) => {
        hub.registerClient(socket, player, isAgent);
        if (query.conversation_id) {
          hub.joinRoom(query.conversation_id, socket);
        }

        socket.on('message', async (data) => {
          try {
            await hub.handleInboundMessage(socket, data.toString());
          } catch (err: any) {
            socket.send(
              JSON.stringify({
                event: 'error',
                code: 'INTERNAL_ERROR',
                message: err?.message || 'Terjadi kesalahan saat memproses pesan',
              })
            );
          }
        });
      })
      .catch((err) => {
        socket.send(
          JSON.stringify({
            event: 'error',
            code: 'AUTH_FAILED',
            message: err.message || 'Autentikasi gagal',
          })
        );
        socket.close(1008, 'Authentication failed');
      });
  });

  // REST: Transisi status percakapan
  app.post<{
    Params: { id: string };
    Body: {
      to: ConversationStatus;
      resolution_reason?: ResolutionReason;
      ticket_id?: string;
      agent_id?: string;
    };
  }>('/v1/conversations/:id/transition', async (req, reply) => {
    const { id } = req.params;
    const { to, resolution_reason, ticket_id, agent_id } = req.body || {};

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    try {
      const updated = await db.updateConversationStatus(
        id,
        to,
        resolution_reason,
        ticket_id,
        agent_id
      );

      // Siarkan pergantian status
      await hub.broadcastStatusChange(id, conv.status, to, resolution_reason, ticket_id);

      return reply.send(updated);
    } catch (err: any) {
      if (err instanceof InvalidStatusTransitionError) {
        return reply.code(400).send({
          error: err.message,
          code: err.code,
          from: err.from,
          to: err.to,
        });
      }
      return reply.code(500).send({ error: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  // REST: Klaim percakapan oleh agent
  app.post<{
    Params: { id: string };
    Body: { agent_id: string };
  }>('/v1/conversations/:id/claim', async (req, reply) => {
    const { id } = req.params;
    const { agent_id } = req.body || {};

    if (!agent_id) {
      return reply.code(400).send({ error: 'agent_id wajib disertakan', code: 'MISSING_AGENT_ID' });
    }

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    if (conv.status === 'resolved') {
      return reply.code(400).send({
        error: 'Percakapan sudah ditutup dan tidak dapat diklaim',
        code: 'CONVERSATION_RESOLVED',
      });
    }

    try {
      const updated = await db.updateConversationStatus(id, 'agent_active', undefined, undefined, agent_id);
      await hub.broadcastStatusChange(id, conv.status, 'agent_active');
      return reply.send(updated);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message, code: 'TRANSITION_FAILED' });
    }
  });

  // REST: Agent kirim balasan pesan
  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      sender_id?: string;
      sender_type?: 'agent' | 'system';
      translated?: boolean;
    };
  }>('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params;
    const { text, sender_id, sender_type = 'agent', translated = false } = req.body || {};

    if (!text || text.trim() === '') {
      return reply.code(400).send({ error: 'Teks pesan tidak boleh kosong', code: 'EMPTY_TEXT' });
    }

    const conv = await db.getConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: `Percakapan '${id}' tidak ditemukan`, code: 'NOT_FOUND' });
    }

    if (conv.status === 'resolved') {
      return reply.code(400).send({
        error: 'Percakapan sudah ditutup, tidak dapat mengirim pesan baru',
        code: 'CONVERSATION_RESOLVED',
      });
    }

    const saved = await db.saveMessage({
      conversation_id: id,
      sender_type,
      sender_id,
      text,
      translated,
    });

    // Siarkan ke seluruh instance via Redis Pub/Sub
    await pubsub.publish(id, {
      event: 'message',
      conversation_id: id,
      message_id: saved.id,
      sender_type: saved.sender_type,
      sender_id: saved.sender_id || undefined,
      text: saved.text,
      created_at: saved.created_at.toISOString(),
      translated: saved.translated,
    });

    return reply.code(201).send(saved);
  });

  // REST: Ambil riwayat pesan
  app.get<{
    Params: { id: string };
  }>('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params;
    const messages = await db.getMessages(id);
    return reply.send({ conversation_id: id, messages });
  });

  return { app, db, pubsub, hub };
}
