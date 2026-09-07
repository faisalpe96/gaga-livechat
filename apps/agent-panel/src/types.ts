export type ConversationStatus = 'bot_active' | 'handoff_queued' | 'agent_active' | 'resolved';

export interface Agent {
  id: string;
  name: string;
  locales: string[];
  max_concurrent: number;
  status: string;
}

export interface QueueItem {
  id: string;
  player_uid: string;
  market: string;
  locale: string;
  status: ConversationStatus;
  assigned_agent_id?: string | null;
  category?: string | null;
  subcategory?: string | null;
  priority?: string | null;
  sla_due_at?: string | null;
  resolution_reason?: string | null;
  ticket_id?: string | null;
  page_context?: Record<string, any>;
  started_at: string;
  closed_at?: string | null;
  handoff_reason?: string | null;
  bot_summary?: string | null;
  queued_at?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: 'player' | 'bot' | 'agent' | 'system';
  sender_id?: string | null;
  sender_name?: string | null;
  text: string;
  translated?: boolean;
  created_at: string;
}
