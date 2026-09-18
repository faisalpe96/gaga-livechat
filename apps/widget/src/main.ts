import { registerGagaChatElement } from './web-component/gaga-chat-element.js';

registerGagaChatElement();

export * from './types.js';
export * from './connection/websocket-client.js';
export * from './i18n/translations.js';
export * from './components/ChatWidget.js';
export * from './components/LanguageSelector.js';
export * from './web-component/gaga-chat-element.js';

export interface GagaChatInitOptions {
  token?: string;
  url?: string;
  page?: string;
  locale?: string;
  market?: string;
  container?: HTMLElement | string;
}

export function init(options: GagaChatInitOptions = {}): HTMLElement {
  registerGagaChatElement();
  let container: HTMLElement | null = null;
  if (typeof options.container === 'string') {
    container = document.querySelector(options.container);
  } else if (options.container) {
    container = options.container;
  }
  if (!container) {
    container = document.body;
  }

  const existing = document.querySelector('gaga-chat');
  if (existing) {
    if (options.token) existing.setAttribute('token', options.token);
    if (options.page) existing.setAttribute('page', options.page);
    return existing as HTMLElement;
  }

  const el = document.createElement('gaga-chat');
  if (options.token) el.setAttribute('token', options.token);
  if (options.url) el.setAttribute('url', options.url);
  if (options.page) el.setAttribute('page', options.page);
  if (options.locale) el.setAttribute('locale', options.locale);
  if (options.market) el.setAttribute('market', options.market);
  container.appendChild(el);
  return el;
}

// Global browser window attachment (spec/09-produksi.md Bagian 2)
if (typeof window !== 'undefined') {
  (window as any).GagaChat = {
    init,
    register: registerGagaChatElement,
  };
}
