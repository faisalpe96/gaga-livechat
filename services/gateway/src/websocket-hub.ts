import { WebSocket } from 'ws';
import { Database } from './db.js';
import { RedisPubSub } from './redis.js';
import {
  InboundEvent,
  OutboundEvent,
  OutboundMessage,
  OutboundSessionStarted,
  OutboundStatusChange,
  OutboundError,
  PlayerInfo,
} from './types.js';

export interface ClientMetadata {
  socket: WebSocket;
  player?: PlayerInfo;
  conversationId?: string;
  isAgent?: boolean;
}

export class WebSocketHub {
  // Mapping conversation_id -> Set of WebSockets yang terhubung lokal ke instance ini
  private rooms = new Map<string, Set<WebSocket>>();
  private clientMeta = new Map<WebSocket, ClientMetadata>();

  constructor(
    private db: Database,
    private pubsub: RedisPubSub
  ) {
    // Tangani event yang diterima dari instance lain via Redis Pub/Sub
    this.pubsub.setEventHandler((conversationId, event) => {
      this.broadcastLocal(conversationId, event);
    });
  }

  registerClient(socket: WebSocket, player?: PlayerInfo, isAgent = false): void {
    this.clientMeta.set(socket, { socket, player, isAgent });

    socket.on('close', () => {
      this.unregisterClient(socket);
    });
  }

  unregisterClient(socket: WebSocket): void {
    const meta = this.clientMeta.get(socket);
    if (meta?.conversationId) {
      const room = this.rooms.get(meta.conversationId);
      if (room) {
        room.delete(socket);
        if (room.size === 0) {
          this.rooms.delete(meta.conversationId);
        }
      }
    }
    this.clientMeta.delete(socket);
  }

  joinRoom(conversationId: string, socket: WebSocket): void {
    const meta = this.clientMeta.get(socket);
    if (meta) {
      meta.conversationId = conversationId;
    }
    let room = this.rooms.get(conversationId);
    if (!room) {
      room = new Set<WebSocket>();
      this.rooms.set(conversationId, room);
    }
    room.add(socket);
  }

  async handleInboundMessage(socket: WebSocket, rawData: string): Promise<void> {
    let payload: InboundEvent;
    try {
      payload = JSON.parse(rawData);
    } catch {
      this.sendToSocket(socket, {
        event: 'error',
        code: 'INVALID_JSON',
        message: 'Payload bukan format JSON yang valid',
      });
      return;
    }

    const meta = this.clientMeta.get(socket);
    if (!meta) return;

    switch (payload.event) {
      case 'join':
      case 'join_conversation': {
        const conversationId = (payload as any).conversation_id;
        if (conversationId) {
          this.joinRoom(conversationId, socket);
        }
        break;
      }

      case 'session_start': {
        const player = payload.player || meta.player || { uid: 'anonymous' };
        meta.player = player;
        const context = payload.context || {};

        const conv = await this.db.getOrCreateActiveConversation(player, context);
        this.joinRoom(conv.id, socket);

        const reply: OutboundSessionStarted = {
          event: 'session_started',
          conversation_id: conv.id,
          status: conv.status,
          locale: conv.locale,
          market: conv.market,
        };
        this.sendToSocket(socket, reply);
        break;
      }

      case 'message': {
        const conversationId = payload.conversation_id || meta.conversationId;
        if (!conversationId) {
          this.sendToSocket(socket, {
            event: 'error',
            code: 'MISSING_CONVERSATION_ID',
            message: 'conversation_id wajib disertakan',
          });
          return;
        }

        const conv = await this.db.getConversation(conversationId);
        if (!conv) {
          this.sendToSocket(socket, {
            event: 'error',
            code: 'CONVERSATION_NOT_FOUND',
            message: `Percakapan '${conversationId}' tidak ditemukan`,
          });
          return;
        }

        if (conv.status === 'resolved') {
          this.sendToSocket(socket, {
            event: 'error',
            code: 'CONVERSATION_RESOLVED',
            message: 'Percakapan sudah ditutup. Pesan baru harus membuka sesi baru.',
          });
          return;
        }

        const senderType = meta.isAgent ? 'agent' : 'player';
        const senderId = meta.isAgent ? 'agent' : (meta.player?.uid || 'player');

        // Simpan pesan ke database
        const savedMsg = await this.db.saveMessage({
          conversation_id: conversationId,
          sender_type: senderType,
          sender_id: senderId,
          text: payload.text,
        });

        const senderName = meta.isAgent
          ? 'Support Agent'
          : (meta.player?.nickname || meta.player?.uid || 'Player');

        // Siarkan via Redis Pub/Sub ke seluruh instance gateway
        const broadcastEvent: OutboundMessage = {
          event: 'message',
          conversation_id: conversationId,
          message_id: savedMsg.id,
          sender_type: savedMsg.sender_type,
          sender_id: savedMsg.sender_id || undefined,
          sender_name: senderName,
          text: savedMsg.text,
          created_at: savedMsg.created_at.toISOString(),
          translated: savedMsg.translated,
        };

        await this.pubsub.publish(conversationId, broadcastEvent);
        break;
      }

      case 'set_locale': {
        const conversationId = payload.conversation_id || meta.conversationId;
        if (!conversationId) return;

        await this.db.updateConversationLocale(conversationId, payload.locale);
        break;
      }

      default:
        this.sendToSocket(socket, {
          event: 'error',
          code: 'UNKNOWN_EVENT',
          message: `Event tidak dikenal: ${(payload as any).event}`,
        });
    }
  }

  async broadcastStatusChange(
    conversationId: string,
    previousStatus: any,
    newStatus: any,
    resolutionReason?: string,
    ticketId?: string
  ): Promise<void> {
    const event: OutboundStatusChange = {
      event: 'status_change',
      conversation_id: conversationId,
      previous_status: previousStatus,
      new_status: newStatus,
      resolution_reason: resolutionReason,
      ticket_id: ticketId,
    };
    await this.pubsub.publish(conversationId, event);
  }

  async broadcastSystemMessage(conversationId: string, text: string): Promise<void> {
    const saved = await this.db.saveMessage({
      conversation_id: conversationId,
      sender_type: 'system',
      text,
    });
    const event: OutboundMessage = {
      event: 'message',
      conversation_id: conversationId,
      message_id: saved.id,
      sender_type: 'system',
      text: saved.text,
      created_at: saved.created_at.toISOString(),
      translated: false,
    };
    await this.pubsub.publish(conversationId, event);
  }

  private broadcastLocal(conversationId: string, event: OutboundEvent): void {
    const room = this.rooms.get(conversationId);
    if (!room) return;

    for (const socket of room) {
      this.sendToSocket(socket, event);
    }
  }

  private sendToSocket(socket: WebSocket, event: OutboundEvent): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  close(): void {
    for (const [socket] of this.clientMeta) {
      try {
        socket.terminate();
      } catch {}
    }
    this.rooms.clear();
    this.clientMeta.clear();
  }
}
