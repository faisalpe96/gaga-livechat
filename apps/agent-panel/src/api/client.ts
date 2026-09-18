import { Agent, QueueItem, Message } from '../types.js';

export const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GATEWAY_URL)
    ? (import.meta.env.VITE_GATEWAY_URL as string).replace(/\/$/, '')
    : window.location.origin.includes(':3002')
    ? 'http://127.0.0.1:3001'
    : window.location.origin;

export async function fetchCurrentUser(): Promise<Agent | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/auth/me`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.agent || null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {}
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${API_BASE}/v1/agents`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to fetch agents');
  const data = await res.json();
  return data.agents || [];
}

export async function fetchQueue(options: { agentId?: string; locale?: string }): Promise<QueueItem[]> {
  const url = new URL(`${API_BASE}/v1/queue`);
  if (options.agentId) url.searchParams.set('agent_id', options.agentId);
  if (options.locale) url.searchParams.set('locale', options.locale);

  const res = await fetch(url.toString(), {
    credentials: 'include',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to fetch queue');
  }
  const data = await res.json();
  return data.queue || [];
}

export async function claimConversation(conversationId: string, agentId?: string): Promise<QueueItem> {
  const res = await fetch(`${API_BASE}/v1/conversations/${conversationId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ agent_id: agentId }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to claim conversation');
  }
  return data;
}

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/v1/conversations/${conversationId}/messages`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to fetch messages');
  const data = await res.json();
  return data.messages || [];
}

export async function sendAgentMessage(
  conversationId: string,
  agentId: string,
  text: string
): Promise<Message> {
  const res = await fetch(`${API_BASE}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      text,
      sender_id: agentId,
      sender_type: 'agent',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send message');
  return data;
}

export async function resolveConversation(
  conversationId: string,
  resolutionReason = 'agent_resolved',
  ticketId?: string
): Promise<QueueItem> {
  const res = await fetch(`${API_BASE}/v1/conversations/${conversationId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      resolution_reason: resolutionReason,
      ticket_id: ticketId,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to resolve conversation');
  return data;
}
