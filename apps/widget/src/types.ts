export type SupportedLocale =
  | 'th-TH'
  | 'fil-PH'
  | 'id-ID'
  | 'ms-MY'
  | 'vi-VN'
  | 'en';

export type MarketCode = 'TH' | 'PH' | 'ID' | 'MY' | 'VN' | 'SG';

export interface MarketOption {
  code: MarketCode;
  name: string;
  defaultLocale: SupportedLocale;
  supportedLocales: SupportedLocale[];
  label: string;
}

export const MARKETS_DATA: Record<MarketCode, MarketOption> = {
  TH: {
    code: 'TH',
    name: 'Thailand',
    defaultLocale: 'th-TH',
    supportedLocales: ['th-TH', 'en'],
    label: '🇹🇭 ไทย (Thai)',
  },
  PH: {
    code: 'PH',
    name: 'Philippines',
    defaultLocale: 'fil-PH',
    supportedLocales: ['fil-PH', 'en'],
    label: '🇵🇭 Filipino (Tagalog)',
  },
  ID: {
    code: 'ID',
    name: 'Indonesia',
    defaultLocale: 'id-ID',
    supportedLocales: ['id-ID', 'en'],
    label: '🇮🇩 Bahasa Indonesia',
  },
  MY: {
    code: 'MY',
    name: 'Malaysia',
    defaultLocale: 'ms-MY',
    supportedLocales: ['ms-MY', 'en'],
    label: '🇲🇾 Bahasa Melayu',
  },
  VN: {
    code: 'VN',
    name: 'Vietnam',
    defaultLocale: 'vi-VN',
    supportedLocales: ['vi-VN', 'en'],
    label: '🇻🇳 Tiếng Việt',
  },
  SG: {
    code: 'SG',
    name: 'Singapore',
    defaultLocale: 'en',
    supportedLocales: ['en'],
    label: '🇸🇬 English (SG)',
  },
};

export interface PlayerInfo {
  uid: string;
  nickname?: string;
  server?: string;
  level?: number;
  vip_tier?: number;
}

export interface ClientContext {
  page?: string;
  platform?: string;
  app_version?: string;
  locale?: string;
  market?: string;
  client_tz?: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_type: 'player' | 'bot' | 'agent' | 'system';
  sender_name?: string;
  avatar_url?: string;
  bot_persona?: string;
  text: string;
  created_at: string;
  translated?: boolean;
  meta?: any;
}

export interface InboundSessionStart {
  event: 'session_start';
  player: PlayerInfo;
  context: ClientContext;
}

export interface InboundMessage {
  event: 'message';
  conversation_id: string;
  text: string;
  category?: string;
}

export interface InboundSetLocale {
  event: 'set_locale';
  conversation_id: string;
  locale: string;
}

export interface InboundSetCategory {
  event: 'set_category';
  conversation_id: string;
  category: string;
  subcategory?: string;
  text?: string;
}

export interface OutboundSessionStarted {
  event: 'session_started';
  conversation_id: string;
  status: string;
  locale: string;
  market: string;
  bot_persona?: string;
  bot_name?: string;
  bot_avatar?: string;
}

export interface OutboundMessage {
  event: 'message';
  conversation_id: string;
  message_id: string;
  sender_type: 'player' | 'bot' | 'agent' | 'system';
  sender_name?: string;
  text: string;
  created_at: string;
  translated: boolean;
}

export interface OutboundStatusChange {
  event: 'status_change';
  conversation_id: string;
  previous_status: string;
  new_status: string;
  resolution_reason?: string;
  ticket_id?: string;
}

export interface OutboundError {
  event: 'error';
  code: string;
  message: string;
}

export interface InboundTyping {
  event: 'typing';
  conversation_id: string;
  is_typing?: boolean;
}

export interface OutboundTyping {
  event: 'typing';
  conversation_id: string;
  sender_type: 'bot' | 'agent' | 'player';
  is_typing: boolean;
  bot_persona?: string;
  sender_name?: string;
  avatar_url?: string;
}

export type OutboundEvent =
  | OutboundSessionStarted
  | OutboundMessage
  | OutboundStatusChange
  | OutboundError
  | OutboundTyping;
