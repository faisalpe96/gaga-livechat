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

export type ConversationStage =
  | 'greeting'
  | 'discovery'
  | 'data_collection'
  | 'resolution'
  | 'escalation';

export interface Conversation {
  id: string;
  player_uid: string;
  market: string;
  locale: string;
  status: ConversationStatus;
  stage: ConversationStage;
  assigned_agent_id?: string | null;
  category?: string | null;
  subcategory?: string | null;
  priority?: string | null;
  sla_due_at?: Date | null;
  resolution_reason?: string | null;
  ticket_id?: string | null;
  page_context: Record<string, any>;
  bot_persona?: string | null;
  service_mode?: 'business_hours' | 'after_hours';
  proactive_greeted?: boolean;
  collected_fields?: Record<string, string>;
  started_at: Date;
  closed_at?: Date | null;
}

export interface BotPersona {
  persona: string;
  locale: string;
  display_name: string;
  avatar_url: string;
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

export interface InboundTyping {
  event: 'typing';
  conversation_id: string;
  is_typing?: boolean;
}

export type InboundEvent = InboundSessionStart | InboundMessage | InboundSetLocale | InboundTyping;

export interface OutboundSessionStarted {
  event: 'session_started';
  conversation_id: string;
  status: ConversationStatus;
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
  sender_type: SenderType;
  sender_id?: string;
  sender_name?: string;
  avatar_url?: string;
  bot_persona?: string;
  text: string;
  created_at: string;
  translated: boolean;
  meta?: Record<string, any>;
}

export interface OutboundStatusChange {
  event: 'status_change';
  conversation_id: string;
  previous_status: ConversationStatus;
  new_status: ConversationStatus;
  resolution_reason?: string;
  ticket_id?: string;
  agent_id?: string;
  agent_name?: string;
}

export interface OutboundError {
  event: 'error';
  code: string;
  message: string;
}

export type AgentRole = 'agent' | 'supervisor' | 'admin';

export interface Agent {
  id: string;
  name: string;
  locales: string[];
  max_concurrent: number;
  status: string;
  email?: string | null;
  role?: AgentRole;
  external_id?: string | null;
  is_active?: boolean;
  last_login_at?: Date | null;
}

export interface QueueItem extends Conversation {
  handoff_reason?: string | null;
  bot_summary?: string | null;
  queued_at?: Date | null;
}

export interface OutboundBotDraft {
  event: 'bot_draft';
  conversation_id: string;
  message_id: string;
  text: string;
  meta: Record<string, any>;
  created_at: string;
  is_draft: true;
}

export interface BotFeedback {
  id: string;
  message_id: string;
  verdict: 'accepted' | 'edited' | 'rejected' | 'auto_replied';
  corrected_text?: string | null;
  reviewer_id?: string | null;
  created_at: Date;
}

export interface DraftUsageReportItem {
  intent: string;
  locale: string;
  bot_persona?: string;
  total_reviewed: number;
  used_unedited_count: number;
  edited_count: number;
  rejected_count: number;
  unedited_rate_percentage: number;
}

export interface AutoReplyRule {
  id?: string;
  intent: string;
  locale: string;
  is_enabled: boolean;
  min_confidence: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface AutoReplyRuleWithMetrics extends AutoReplyRule {
  market: string;
  is_market_bot_enabled: boolean;
  total_reviewed: number;
  used_unedited_count: number;
  unedited_rate_percentage: number;
  is_eligible_90: boolean;
  warning?: string | null;
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
  | OutboundBotDraft
  | OutboundTyping;

