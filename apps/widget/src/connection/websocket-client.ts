import {
  ChatMessage,
  ClientContext,
  InboundMessage,
  InboundSessionStart,
  InboundSetLocale,
  OutboundEvent,
  PlayerInfo,
  SupportedLocale,
} from '../types.js';

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
  private offlineQueue: Array<InboundMessage | InboundSetLocale> = [];
  private messages: ChatMessage[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private isExplicitlyClosed = false;

  // Event Listeners
  public onMessage?: (msg: ChatMessage) => void;
  public onSessionStarted?: (convId: string, locale: string, market: string) => void;
  public onStatusChange?: (status: string, reason?: string) => void;
  public onConnectionChange?: (state: ConnectionState) => void;
  public onError?: (err: any) => void;

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

  public getState(): ConnectionState {
    return this.state;
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

  public sendMessage(text: string): void {
    if (!text || text.trim() === '') return;

    if (this.state === 'connected' && this.ws && this.conversationId) {
      const payload: InboundMessage = {
        event: 'message',
        conversation_id: this.conversationId,
        text,
      };
      this.ws.send(JSON.stringify(payload));
    } else {
      // Masukkan ke antrean offline jika koneksi putus
      this.offlineQueue.push({
        event: 'message',
        conversation_id: this.conversationId || '',
        text,
      });
    }
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
        this.currentLocale = data.locale as SupportedLocale;
        this.saveHistory();
        this.fetchHistoryFromServer().then((msgs) => {
          if (this.onHistoryLoaded) {
            this.onHistoryLoaded(msgs);
          }
        });
        if (this.onSessionStarted) {
          this.onSessionStarted(data.conversation_id, data.locale, data.market);
        }
      } else if (data.event === 'message') {
        const chatMsg: ChatMessage = {
          id: data.message_id,
          conversation_id: data.conversation_id,
          sender_type: data.sender_type,
          sender_name: data.sender_name,
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
        if (this.onStatusChange) {
          this.onStatusChange(data.new_status, data.resolution_reason);
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
        if (Array.isArray(data.messages)) {
          this.messages = data.messages.map((m: any) => ({
            id: m.id,
            conversation_id: m.conversation_id,
            sender_type: m.sender_type,
            sender_name: m.sender_name || (m.sender_type === 'player' ? 'You' : 'Gaga Assist'),
            text: m.text,
            created_at: m.created_at,
            translated: !!m.translated,
          }));
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
