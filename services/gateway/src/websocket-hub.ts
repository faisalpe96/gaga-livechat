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
  OutboundTyping,
  PlayerInfo,
} from './types.js';
import { generateProactiveGreeting } from './proactive-greeting.js';
import { calculateServiceMode } from './service-mode.js';
import { CategoryFieldService, CollectedFieldStatus } from './category-field-service.js';
import { AttachmentService } from './attachment-service.js';

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
  public onPlayerMessage?: (
    conversationId: string,
    text: string,
    category?: string,
    hasAttachment?: boolean
  ) => Promise<void> | void;
  public proactiveGreetingDelayMs = 500;

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

        const personaInfo = await this.db.getBotPersona(conv.bot_persona || 'mira', conv.locale);

        const reply: OutboundSessionStarted = {
          event: 'session_started',
          conversation_id: conv.id,
          status: conv.status,
          locale: conv.locale,
          market: conv.market,
          bot_persona: conv.bot_persona || 'mira',
          bot_name: personaInfo.display_name,
          bot_avatar: personaInfo.avatar_url,
          category: conv.category || undefined,
          service_mode: conv.service_mode,
        };
        this.sendToSocket(socket, reply);

        // SYARAT 1-7: Proactive Opening Greeting
        // Dikirim segera saat sesi baru dibuka sebelum pemain mengetik apapun.
        // - Hanya dikirim SEKALI per sesi (Syarat 5)
        // - Sesi yang resume/refresh TIDAK mengirim ulang (Syarat 5)
        // - Sesi yang sudah agent_active TIDAK PERNAH dikirim (Syarat 5)
        // - Tampilkan typing indicator sebentar sebelum pesan muncul (Syarat 4)
        // - Mode luar jam (after_hours) mengambil alih dengan pembuka jujur spec 07 (Syarat 6)
        // - Disimpan sebagai pesan normal dengan sender_type: bot (Syarat 7)
        const msgCount = await this.db.getConversationMessageCount(conv.id);
        const shouldGreet = !conv.proactive_greeted && msgCount === 0 && conv.status === 'bot_active';

        if (shouldGreet) {
          // Tandai segera di database agar idempoten
          await this.db.setConversationProactiveGreeted(conv.id);

          // Tampilkan typing indicator sebentar
          await this.broadcastTyping(conv.id, 'bot', true, conv.bot_persona || 'mira');
          const delayMs = this.proactiveGreetingDelayMs ?? 500;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          await this.broadcastTyping(conv.id, 'bot', false, conv.bot_persona || 'mira');

          const afterHoursInfo = calculateServiceMode({ code: conv.market });

          const greetingText = generateProactiveGreeting({
            locale: conv.locale,
            persona: conv.bot_persona || 'mira',
            player: meta.player,
            pageContext: conv.page_context,
            serviceMode: conv.service_mode,
            afterHoursInfo,
          });

          const savedGreeting = await this.db.saveMessage({
            conversation_id: conv.id,
            sender_type: 'bot',
            sender_id: conv.bot_persona || 'mira',
            text: greetingText,
            meta: {
              is_proactive_greeting: true,
              bot_persona: conv.bot_persona || 'mira',
              avatar_url: personaInfo.avatar_url,
              stage: 'greeting',
              service_mode: conv.service_mode,
            },
          });

          await this.pubsub.publish(conv.id, {
            event: 'message',
            conversation_id: conv.id,
            message_id: savedGreeting.id,
            sender_type: savedGreeting.sender_type,
            sender_id: savedGreeting.sender_id || undefined,
            sender_name: personaInfo.display_name,
            avatar_url: personaInfo.avatar_url,
            bot_persona: conv.bot_persona || 'mira',
            text: savedGreeting.text,
            created_at: savedGreeting.created_at.toISOString(),
            translated: false,
            meta: savedGreeting.meta,
          });
        }
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

        // Pastikan socket terdaftar di room percakapan ini
        this.joinRoom(conversationId, socket);

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

        if (payload.category) {
          await this.db.updateConversationCategory(conversationId, payload.category);
        }

        // Syarat 5: Attachments satisfy relevant evidence field automatically
        const hasAttachment = Boolean(
          (payload as any).attachment_url ||
          (payload as any).meta?.attachment ||
          (payload as any).meta?.attachment_url ||
          /https?:\/\/.*?\.(png|jpg|jpeg|webp)|\[Attachment/i.test(payload.text)
        );

        if (!meta.isAgent && conv.category) {
          const fields = await this.db.getCategoryFieldDefinitions(conv.category);

          if (hasAttachment) {
            const attUrl =
              (payload as any).attachment_url ||
              (payload as any).meta?.attachment ||
              (payload as any).meta?.attachment_url ||
              payload.text;
            const { updated, satisfiedKey } = CategoryFieldService.satisfyAttachmentEvidence(
              fields,
              conv.collected_fields || {},
              attUrl
            );
            if (satisfiedKey) {
              await this.db.updateConversationCollectedFields(conversationId, updated);
            }
          }
        }

        // Panggil hook pesan pemain (untuk pemrosesan mode bayangan bot)
        if (!meta.isAgent && this.onPlayerMessage) {
          Promise.resolve(
            this.onPlayerMessage(conversationId, payload.text, payload.category, hasAttachment)
          ).catch(console.error);
        }
        break;
      }

      case 'set_category': {
        const conversationId = payload.conversation_id || meta.conversationId;
        if (!conversationId) return;

        const category = payload.category;
        const subcategory = payload.subcategory || null;
        await this.db.updateConversationCategory(conversationId, category, subcategory);

        const conv = await this.db.getConversation(conversationId);
        const fields = await this.db.getCategoryFieldDefinitions(category);

        // Syarat 4: Otomatis isi field yang sudah diketahui dari sesi (UID, server, platform, dsb)
        const sessionFields = CategoryFieldService.populateSessionKnownFields(
          fields,
          conv?.page_context || {},
          meta.player
        );

        // Syarat 3: Pertahankan field yang sudah terkumpul saat ganti kategori (tidak restart dari nol)
        const existingCollected = conv?.collected_fields || {};
        const mergedCollected = { ...existingCollected, ...sessionFields };

        await this.db.updateConversationCollectedFields(conversationId, mergedCollected);

        const progressItems: CollectedFieldStatus[] = fields.map((f) => ({
          key: f.field_key,
          label: f.labels[conv?.locale || 'id-ID'] || f.labels['en'] || f.field_key,
          is_required: f.is_required,
          status: mergedCollected[f.field_key] ? 'collected' : 'pending',
          value: mergedCollected[f.field_key] || undefined,
          evidence_type: f.evidence_type,
        }));

        await this.pubsub.publish(conversationId, {
          event: 'category_changed',
          conversation_id: conversationId,
          category,
          subcategory,
          fields: progressItems,
          collected_fields: mergedCollected,
        });

        this.sendToSocket(socket, {
          event: 'category_set',
          conversation_id: conversationId,
          category,
          subcategory,
          fields: progressItems,
          collected_fields: mergedCollected,
        });

        if (payload.text && !meta.isAgent && this.onPlayerMessage) {
          Promise.resolve(this.onPlayerMessage(conversationId, payload.text, category)).catch(console.error);
        }
        break;
      }

      case 'set_locale': {
        const conversationId = payload.conversation_id || meta.conversationId;
        if (!conversationId) return;

        await this.db.updateConversationLocale(conversationId, payload.locale);
        break;
      }

      case 'typing': {
        const conversationId = payload.conversation_id || meta.conversationId;
        if (!conversationId) return;

        this.joinRoom(conversationId, socket);
        const isTyping = (payload as any).is_typing !== false;
        if (meta.isAgent) {
          const agentName = meta.player?.nickname || 'Support Agent';
          await this.broadcastTyping(conversationId, 'agent', isTyping, undefined, agentName, '/assets/agent-avatar.png');
        } else {
          await this.broadcastTyping(conversationId, 'player', isTyping);
        }
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
    ticketId?: string,
    agentName?: string,
    agentId?: string
  ): Promise<void> {
    let resolvedAgentName = agentName;
    let resolvedAgentId = agentId;

    if (newStatus === 'agent_active' && (!resolvedAgentName || !resolvedAgentId)) {
      const conv = await this.db.getConversation(conversationId);
      resolvedAgentId = resolvedAgentId || conv?.assigned_agent_id || undefined;
      if (resolvedAgentId && !resolvedAgentName) {
        const agRes = await this.db.pool.query('SELECT name FROM agents WHERE id = $1', [resolvedAgentId]);
        if (agRes.rows.length > 0) resolvedAgentName = agRes.rows[0].name;
      }
    }
    resolvedAgentName = resolvedAgentName || (newStatus === 'agent_active' ? 'Support Agent' : undefined);

    const event: OutboundStatusChange = {
      event: 'status_change',
      conversation_id: conversationId,
      previous_status: previousStatus,
      new_status: newStatus,
      resolution_reason: resolutionReason,
      ticket_id: ticketId,
      agent_id: resolvedAgentId,
      agent_name: resolvedAgentName,
    };
    await this.pubsub.publish(conversationId, event);

    // Kriteria Terima 5 & Syarat 6 & Requirement (2):
    // Saat sesi beralih ke agent_active, identitas yang tampil berganti menjadi agent manusia
    // dan kirim pesan sistem yang memberitahu bahwa pemain bisa melampirkan file jika agen memintanya.
    if (newStatus === 'agent_active' && previousStatus !== 'agent_active') {
      const conv = await this.db.getConversation(conversationId);
      const transferMsg = AttachmentService.getAgentActiveTransferMessage(
        resolvedAgentName,
        conv?.locale || 'id-ID'
      );
      await this.broadcastSystemMessage(conversationId, transferMsg);
    }
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

  async broadcastBotDraft(conversationId: string, draftMsg: any): Promise<void> {
    const conv = await this.db.getConversation(conversationId);
    const persona = conv?.bot_persona || draftMsg.meta?.bot_persona || 'mira';
    const locale = conv?.locale || 'id-ID';
    const personaInfo = await this.db.getBotPersona(persona, locale);

    const event: any = {
      event: 'bot_draft',
      conversation_id: conversationId,
      message_id: draftMsg.id,
      text: draftMsg.text,
      bot_persona: persona,
      bot_name: personaInfo.display_name,
      avatar_url: personaInfo.avatar_url,
      meta: {
        ...(draftMsg.meta || {}),
        bot_persona: persona,
        bot_name: personaInfo.display_name,
        avatar_url: personaInfo.avatar_url,
      },
      created_at: draftMsg.created_at
        ? new Date(draftMsg.created_at).toISOString()
        : new Date().toISOString(),
      is_draft: true,
    };
    await this.pubsub.publish(conversationId, event);
  }

  async broadcastMessage(conversationId: string, msg: any): Promise<void> {
    let senderName = msg.sender_name;
    let avatarUrl = msg.avatar_url;
    let botPersona = msg.meta?.bot_persona;

    if (msg.sender_type === 'bot') {
      const conv = await this.db.getConversation(conversationId);
      const persona = conv?.bot_persona || msg.meta?.bot_persona || 'mira';
      const locale = conv?.locale || 'id-ID';
      const personaInfo = await this.db.getBotPersona(persona, locale);
      senderName = personaInfo.display_name;
      avatarUrl = personaInfo.avatar_url;
      botPersona = persona;
    } else if (msg.sender_type === 'agent') {
      senderName = msg.sender_name || 'Support Agent';
      avatarUrl = '/assets/agent-avatar.png';
    }

    const event: any = {
      event: 'message',
      conversation_id: conversationId,
      message_id: msg.id,
      sender_type: msg.sender_type || 'bot',
      sender_id: msg.sender_id || 'bot',
      sender_name: senderName,
      avatar_url: avatarUrl,
      bot_persona: botPersona,
      text: msg.text,
      created_at: msg.created_at
        ? new Date(msg.created_at).toISOString()
        : new Date().toISOString(),
      meta: {
        ...(msg.meta || {}),
        bot_persona: botPersona,
        sender_name: senderName,
        avatar_url: avatarUrl,
      },
      translated: Boolean(msg.translated),
    };
    await this.pubsub.publish(conversationId, event);
  }

  async broadcastTyping(
    conversationId: string,
    senderType: 'bot' | 'agent' | 'player',
    isTyping: boolean,
    botPersona?: string,
    senderName?: string,
    avatarUrl?: string
  ): Promise<void> {
    let resolvedName = senderName;
    let resolvedAvatar = avatarUrl;
    let resolvedPersona = botPersona;

    if (senderType === 'bot') {
      const conv = await this.db.getConversation(conversationId);
      resolvedPersona = resolvedPersona || conv?.bot_persona || 'mira';
      const locale = conv?.locale || 'id-ID';
      const personaInfo = await this.db.getBotPersona(resolvedPersona, locale);
      resolvedName = resolvedName || personaInfo.display_name;
      resolvedAvatar = resolvedAvatar || personaInfo.avatar_url;
    } else if (senderType === 'agent') {
      resolvedName = resolvedName || 'Support Agent';
      resolvedAvatar = resolvedAvatar || '/assets/agent-avatar.png';
    }

    const event: OutboundTyping = {
      event: 'typing',
      conversation_id: conversationId,
      sender_type: senderType,
      is_typing: isTyping,
      bot_persona: resolvedPersona,
      sender_name: resolvedName,
      avatar_url: resolvedAvatar,
    };

    await this.pubsub.publish(conversationId, event);
  }

  private broadcastLocal(conversationId: string, event: OutboundEvent): void {
    const room = this.rooms.get(conversationId);
    if (!room) return;

    const isDraft = (event as any).event === 'bot_draft' || (event as any).is_draft === true;

    for (const socket of room) {
      const meta = this.clientMeta.get(socket);
      // PERATURAN MODE BAYANGAN (TASK-08):
      // Draf bot TIDAK PERNAH sampai ke koneksi widget pemain (isAgent !== true)!
      if (isDraft && !meta?.isAgent) {
        continue;
      }
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
