export interface KbDocument {
  id: string;
  doc_key: string;
  locale: string;
  title: string;
  body: string;
  is_policy: boolean;
  version: number;
  reviewed_by?: string | null;
  reviewed_at?: Date | null;
  embedding?: number[] | null;
}

export interface KbDocumentInput {
  doc_key: string;
  locale: string;
  title: string;
  body: string;
  is_policy?: boolean;
  version?: number;
  reviewed_by?: string | null;
  reviewed_at?: Date | string | null;
  embedding?: number[];
}

export interface KbSearchResult {
  id: string;
  doc_key: string;
  locale: string;
  title: string;
  body: string;
  is_policy: boolean;
  version: number;
  similarity: number;
}

export interface CannedResponse {
  template_id: string;
  locale: string;
  category: string;
  body: string;
}

export interface CannedResponseInput {
  template_id: string;
  locale: string;
  category: string;
  body: string;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
}

export type ConversationStage =
  | 'greeting'
  | 'discovery'
  | 'data_collection'
  | 'resolution'
  | 'escalation';

export type PlayerEmotion = 'neutral' | 'frustrated';
