import { render, h } from 'preact';
import { ChatWidget } from '../components/ChatWidget.js';
import { ChatWebSocketClient } from '../connection/websocket-client.js';
import { SupportedLocale } from '../types.js';

export class GagaChatElement extends HTMLElement {
  private client: ChatWebSocketClient | null = null;
  private shadow: ShadowRoot;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    const url = this.getAttribute('url') || 'ws://127.0.0.1:3001/v1/socket';
    const token = this.getAttribute('token') || 'token_77124490';
    const uid = this.getAttribute('uid') || '77124490';
    const nickname = this.getAttribute('nickname') || 'RyuHunter';
    const locale = (this.getAttribute('locale') || 'id-ID') as SupportedLocale;
    const market = this.getAttribute('market') || 'ID';
    const page = this.getAttribute('page') || window.location.pathname || '/';

    this.client = new ChatWebSocketClient({
      url,
      token,
      player: {
        uid,
        nickname,
        server: 'SEA-3',
        level: 48,
        vip_tier: 4,
      },
      context: {
        page,
        platform: 'web',
        app_version: '1.0.0',
        locale,
        market,
        client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta',
      },
      autoReconnect: true,
      reconnectInterval: 1000,
    });

    render(h(ChatWidget, { client: this.client }), this.shadow);
  }

  disconnectedCallback() {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    render(null, this.shadow);
  }
}

export function registerGagaChatElement(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('gaga-chat')) {
    customElements.define('gaga-chat', GagaChatElement);
  }
}
