import {
  ChatMessage,
  ClientContext,
  InboundMessage,
  InboundSessionStart,
  InboundSetLocale,
  InboundSetCategory,
  OutboundEvent,
  PlayerInfo,
  SupportedLocale,
} from '../types.js';
import { getTranslations } from '../i18n/translations.js';

export type ConnectionState = 'connected' | 'connecting' | 'disconnected';

export interface WebSocketClientOptions {
  url: string;
  token: string;
  player: PlayerInfo;
  context: ClientContext;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  storageKey?: string;
  customWebSocket?: any; // Untuk kompatibilitas Node.js test
}

export class ChatWebSocketClient {
  private ws: any = null;
  private state: ConnectionState = 'disconnected';
  private conversationId: string | null = null;
  private currentLocale: SupportedLocale;
  private currentCategory: string | null = null;
  private offlineQueue: Array<InboundMessage | InboundSetLocale | InboundSetCategory> = [];
  private messages: ChatMessage[] = [];
  // Percakapan ditutup (resolved) oleh agen/bot: pesan berikutnya membuka sesi baru
  private conversationClosed = false;
  private lastSentMessage: InboundMessage | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private isExplicitlyClosed = false;

  // Event Listeners
  public onMessage?: (msg: ChatMessage) => void;
  public onTyping?: (data: { is_typing: boolean; sender_type?: string; sender_name?: string; avatar_url?: string }) => void;
  public onSessionStarted?: (convId: string, locale: string, market: string, sessionData?: any) => void;
  public onStatusChange?: (status: string, reason?: string, data?: any) => void;
  public onCategoryChange?: (category: string) => void;
  public onConnectionChange?: (state: ConnectionState) => void;
  public onError?: (err: any) => void;

  private botPersona: string = 'mira';
  private botName: string = 'Mira';
  private botAvatar: string = '/assets/agent-mira.png';

  constructor(private options: WebSocketClientOptions) {
    this.currentLocale = (options.context.locale || 'id-ID') as SupportedLocale;
    this.loadHistory();
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public getConversationId(): string | null {
    return this.conversationId;
  }

  public getLocale(): SupportedLocale {
    return this.currentLocale;
  }

  public getCategory(): string | null {
    return this.currentCategory;
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public getBotPersona(): string {
    return this.botPersona;
  }

  public getBotName(): string {
    return this.botName;
  }

  public getBotAvatar(): string {
    return this.botAvatar;
  }

  public connect(): void {
    this.isExplicitlyClosed = false;
    this.setState('connecting');

    const WSClass =
      this.options.customWebSocket ||
      (typeof WebSocket !== 'undefined' ? WebSocket : null);

    if (!WSClass) {
      this.setState('disconnected');
      if (this.onError) this.onError(new Error('WebSocket tidak didukung'));
      return;
    }

    const separator = this.options.url.includes('?') ? '&' : '?';
    const fullUrl = `${this.options.url}${separator}token=${encodeURIComponent(
      this.options.token
    )}`;

    try {
      this.ws = new WSClass(fullUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.sendSessionStart();
        this.flushOfflineQueue();
      };

      this.ws.onmessage = (event: any) => {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        this.handleInboundRaw(raw);
      };

      this.ws.onclose = () => {
        this.setState('disconnected');
        if (!this.isExplicitlyClosed && (this.options.autoReconnect ?? true)) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err: any) => {
        if (this.onError) this.onError(err);
      };
    } catch (err) {
      this.setState('disconnected');
      if (this.onError) this.onError(err);
      if (!this.isExplicitlyClosed && (this.options.autoReconnect ?? true)) {
        this.scheduleReconnect();
      }
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (typeof this.ws.terminate === 'function') {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }
    this.setState('disconnected');
  }

  public getConversationId(): string | null {
    return this.conversationId;
  }

  public sendMessage(text: string, meta?: any): void {
    if ((!text || text.trim() === '') && !meta?.attachment_url) return;

    const payload: any = {
      event: 'message',
      conversation_id: this.conversationId || '',
      text: text || (meta?.attachment_url ? `[Attachment: ${meta?.filename || 'image'}]` : ''),
      category: this.currentCategory || undefined,
      ...(meta || {}),
    };

    if (this.state === 'connected' && this.ws && this.conversationId && !this.conversationClosed) {
      this.lastSentMessage = payload;
      this.ws.send(JSON.stringify(payload));
    } else if (this.state === 'connected' && this.ws) {
      // Sesi sebelumnya sudah ditutup (atau belum ada): buka sesi baru,
      // pesan dikirim setelah session_started diterima.
      this.startNewSession(payload);
    } else {
      // Masukkan ke antrean offline jika koneksi putus
      this.offlineQueue.push(payload);
    }
  }

  /**
   * Buka sesi baru di socket yang sama. Server membuat percakapan baru bila yang
   * lama sudah resolved. Payload yang tertunda dikirim begitu session_started diterima.
   */
  private startNewSession(pending?: InboundMessage | null): void {
    this.conversationClosed = false;
    this.conversationId = null;
    this.saveHistory();
    if (pending) {
      pending.conversation_id = '';
      this.offlineQueue.push(pending);
    }
    this.sendSessionStart();
  }

  public setLocale(newLocale: SupportedLocale): void {
    this.currentLocale = newLocale;
    this.options.context.locale = newLocale;
    this.saveHistory();

    if (this.state === 'connected' && this.ws && this.conversationId) {
      const payload: InboundSetLocale = {
        event: 'set_locale',
        conversation_id: this.conversationId,
        locale: newLocale,
      };
      this.ws.send(JSON.stringify(payload));
    } else if (this.conversationId) {
      this.offlineQueue.push({
        event: 'set_locale',
        conversation_id: this.conversationId,
        locale: newLocale,
      });
    }
  }

  public setCategory(category: string, subcategory?: string, promptText?: string): void {
    this.currentCategory = category;
    const payload: InboundSetCategory = {
      event: 'set_category',
      conversation_id: this.conversationId || '',
      category,
      subcategory,
      text: promptText,
    };

    if (this.state === 'connected' && this.ws && this.conversationId) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.offlineQueue.push(payload);
    }
  }

  private sendSessionStart(): void {
    const payload: InboundSessionStart = {
      event: 'session_start',
      player: this.options.player,
      context: {
        ...this.options.context,
        locale: this.currentLocale,
      },
    };
    if (this.ws?.readyState === 1 || this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleInboundRaw(raw: string): void {
    try {
      const data = JSON.parse(raw) as OutboundEvent;

      if (data.event === 'session_started') {
        this.conversationId = data.conversation_id;
        this.conversationClosed = false;
        this.currentLocale = data.locale as SupportedLocale;
        if (data.bot_persona) this.botPersona = data.bot_persona;
        if (data.bot_name) this.botName = data.bot_name;
        if (data.bot_avatar) this.botAvatar = data.bot_avatar;
        if ((data as any).category) {
          this.currentCategory = (data as any).category;
          if (this.onCategoryChange) {
            this.onCategoryChange((data as any).category);
          }
        }
        this.saveHistory();
        this.fetchHistoryFromServer().then((msgs) => {
          if (this.onHistoryLoaded) {
            this.onHistoryLoaded(msgs);
          }
        });
        if (this.onSessionStarted) {
          this.onSessionStarted(data.conversation_id, data.locale, data.market, data);
        }
        // Kirim pesan yang tertunda (mis. pesan yang memicu sesi baru)
        this.flushOfflineQueue();
      } else if (data.event === 'message') {
        const chatMsg: ChatMessage = {
          id: data.message_id,
          conversation_id: data.conversation_id,
          sender_type: data.sender_type,
          sender_name: data.sender_name,
          avatar_url: (data as any).avatar_url,
          bot_persona: (data as any).bot_persona,
          text: data.text,
          created_at: data.created_at,
          translated: data.translated,
        };
        // Cek duplikasi pesan berdasarkan id
        if (!this.messages.some((m) => m.id === chatMsg.id)) {
          this.messages.push(chatMsg);
          this.saveHistory();
          if (this.onMessage) {
            this.onMessage(chatMsg);
          }
        }
      } else if (data.event === 'status_change') {
        if (data.new_status === 'resolved') {
          this.conversationClosed = true;
          const note: ChatMessage = {
            id: `local-resolved-${Date.now()}`,
            conversation_id: this.conversationId || '',
            sender_type: 'system',
            text: getTranslations(this.currentLocale).sessionClosed,
            created_at: new Date().toISOString(),
          };
          this.messages.push(note);
          if (this.onMessage) this.onMessage(note);
        }
        if (this.onStatusChange) {
          this.onStatusChange(data.new_status, data.resolution_reason, data);
        }
      } else if ((data as any).event === 'error') {
        const err = data as any;
        if (err.code === 'CONVERSATION_RESOLVED') {
          // Widget tidak sempat menerima status_change (mis. saat terputus):
          // buka sesi baru dan kirim ulang pesan terakhir agar tidak hilang.
          this.conversationClosed = true;
          this.startNewSession(this.lastSentMessage);
          this.lastSentMessage = null;
        } else if (this.onError) {
          this.onError(new Error(`${err.code || 'GATEWAY_ERROR'}: ${err.message || ''}`));
        }
      } else if (data.event === 'typing') {
        if (this.onTyping) {
          this.onTyping(data);
        }
      } else if ((data as any).event === 'category_set' || (data as any).event === 'category_changed') {
        const cat = (data as any).category;
        if (cat) {
          this.currentCategory = cat;
          if (this.onCategoryChange) {
            this.onCategoryChange(cat);
          }
        }
      }
    } catch (e) {
      if (this.onError) this.onError(e);
    }
  }

  private flushOfflineQueue(): void {
    if (!this.ws || this.ws.readyState !== 1 && this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.offlineQueue.length > 0) {
      const item = this.offlineQueue.shift()!;
      if (!item.conversation_id && this.conversationId) {
        item.conversation_id = this.conversationId;
      }
      this.ws.send(JSON.stringify(item));
    }
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.options.maxReconnectAttempts || 10;
    if (this.reconnectAttempts >= maxAttempts) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      (this.options.reconnectInterval || 1000) * Math.pow(1.5, this.reconnectAttempts - 1),
      5000
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private setState(newState: ConnectionState): void {
    this.state = newState;
    if (this.onConnectionChange) {
      this.onConnectionChange(newState);
    }
  }

  public onHistoryLoaded?: (messages: ChatMessage[]) => void;

  public async fetchHistoryFromServer(): Promise<ChatMessage[]> {
    if (!this.conversationId) return [];

    const baseUrl = this.options.url
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://')
      .replace(/\/v1\/socket.*$/, '');

    try {
      const fetchFn = typeof fetch !== 'undefined' ? fetch : (global as any).fetch;
      if (!fetchFn) return this.messages;

      const res = await fetchFn(
        `${baseUrl}/v1/conversations/${this.conversationId}/messages`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.bot_persona) this.botPersona = data.bot_persona;
        if (data.bot_name) this.botName = data.bot_name;
        if (data.bot_avatar) this.botAvatar = data.bot_avatar;

        if (Array.isArray(data.messages)) {
          this.messages = data.messages.map((m: any) => {
            let sName = m.sender_name;
            if (m.sender_type === 'bot') {
              if (!sName || sName.toLowerCase().includes('bot') || sName.toLowerCase().includes('gaga') || sName.toLowerCase().includes('assist')) {
                sName = this.botName || (this.botPersona === 'reza' ? 'Reza' : 'Mira');
              }
            } else if (m.sender_type === 'player') {
              sName = 'You';
            } else if (m.sender_type === 'agent') {
              sName = sName || 'Support Agent';
            }
            return {
              id: m.id,
              conversation_id: m.conversation_id,
              sender_type: m.sender_type,
              sender_name: sName,
              avatar_url: m.avatar_url || (m.sender_type === 'bot' ? this.botAvatar : undefined),
              bot_persona: m.bot_persona || this.botPersona,
              text: m.text,
              created_at: m.created_at,
              translated: !!m.translated,
            };
          });
          return [...this.messages];
        }
      }
    } catch (err) {
      if (this.onError) this.onError(err);
    }
    return this.messages;
  }

  private getStorageKey(): string {
    return this.options.storageKey || `gaga_livechat_${this.options.player.uid}`;
  }

  private saveHistory(): void {
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : null;
      if (storage) {
        const payload = {
          conversationId: this.conversationId,
          locale: this.currentLocale,
        };
        storage.setItem(this.getStorageKey(), JSON.stringify(payload));
      }
    } catch {}
  }

  private loadHistory(): void {
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : null;
      if (storage) {
        const raw = storage.getItem(this.getStorageKey());
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.conversationId) this.conversationId = parsed.conversationId;
          if (parsed.locale) this.currentLocale = parsed.locale;
        }
      }
    } catch {}
  }
}
