export type ConversationStatus = 'bot_active' | 'handoff_queued' | 'agent_active' | 'resolved';

export type SenderType = 'player' | 'bot' | 'agent' | 'system';

export type ResolutionReason =
  | 'bot_resolved'
  | 'agent_resolved'
  | 'ticket_created'
  | 'ticket_auto_created'
  | 'player_abandoned';

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

export interface Conversation {
  id: string;
  player_uid: string;
  market: string;
  locale: string;
  status: ConversationStatus;
  assigned_agent_id?: string | null;
  category?: string | null;
  subcategory?: string | null;
  priority?: string | null;
  sla_due_at?: Date | null;
  resolution_reason?: string | null;
  ticket_id?: string | null;
  page_context: Record<string, any>;
  started_at: Date;
  closed_at?: Date | null;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  sender_id?: string | null;
  sender_name?: string | null;
  text: string;
  translated: boolean;
  original_text?: string | null;
  meta: Record<string, any>;
  created_at: Date;
}

// WebSocket Event Payloads
export interface InboundSessionStart {
  event: 'session_start';
  player: PlayerInfo;
  context: ClientContext;
}

export interface InboundMessage {
  event: 'message';
  conversation_id: string;
  text: string;
}

export interface InboundSetLocale {
  event: 'set_locale';
  conversation_id: string;
  locale: string;
}

export type InboundEvent = InboundSessionStart | InboundMessage | InboundSetLocale;

export interface OutboundSessionStarted {
  event: 'session_started';
  conversation_id: string;
  status: ConversationStatus;
  locale: string;
  market: string;
}

export interface OutboundMessage {
  event: 'message';
  conversation_id: string;
  message_id: string;
  sender_type: SenderType;
  sender_id?: string;
  sender_name?: string;
  text: string;
  created_at: string;
  translated: boolean;
}

export interface OutboundStatusChange {
  event: 'status_change';
  conversation_id: string;
  previous_status: ConversationStatus;
  new_status: ConversationStatus;
  resolution_reason?: string;
  ticket_id?: string;
}

export interface OutboundError {
  event: 'error';
  code: string;
  message: string;
}

export type OutboundEvent =
  | OutboundSessionStarted
  | OutboundMessage
  | OutboundStatusChange
  | OutboundError;
