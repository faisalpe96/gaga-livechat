import { ConversationStatus } from './types.js';

export class InvalidStatusTransitionError extends Error {
  public readonly code = 'INVALID_STATUS_TRANSITION';
  constructor(public readonly from: ConversationStatus, public readonly to: ConversationStatus, message?: string) {
    super(message || `Transisi status dari '${from}' ke '${to}' ditolak.`);
    this.name = 'InvalidStatusTransitionError';
  }
}

/**
 * Aturan transisi status sesi chat Gaga Games sesuai spec/01-arsitektur.md:
 * - bot_active -> handoff_queued (eskalasi bot)
 * - bot_active -> resolved (bot selesai mandiri / timeout)
 * - bot_active -> agent_active (agent menyela manual)
 * - handoff_queued -> agent_active (agent klaim percakapan)
 * - handoff_queued -> resolved (timeout SLA / tiket asinkron / pemain pergi)
 * - agent_active -> resolved (agent selesai menangani)
 *
 * Transisi TERLARANG KERAS:
 * - agent_active -> bot_active (WAJIB DITOLAK di level API)
 * - resolved -> apa pun (Sesi yang sudah ditutup tidak boleh diubah statusnya)
 */
const ALLOWED_TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  bot_active: ['handoff_queued', 'resolved', 'agent_active'],
  handoff_queued: ['agent_active', 'resolved'],
  agent_active: ['resolved'],
  resolved: [], // Terminal state, tidak ada transisi keluar
};

export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  if (from === to) {
    return true; // No-op
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function validateTransition(from: ConversationStatus, to: ConversationStatus): void {
  if (from === to) {
    return;
  }

  if (from === 'agent_active' && to === 'bot_active') {
    throw new InvalidStatusTransitionError(
      from,
      to,
      "Transisi dari 'agent_active' ke 'bot_active' dilarang keras. Sekali sesi masuk agent_active, bot berhenti permanen."
    );
  }

  if (from === 'resolved') {
    throw new InvalidStatusTransitionError(
      from,
      to,
      "Sesi berstatus 'resolved' tidak dapat diubah statusnya. Pesan baru harus membuka sesi baru."
    );
  }

  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(
      from,
      to,
      `Transisi status tidak sah: '${from}' -> '${to}'.`
    );
  }
}
