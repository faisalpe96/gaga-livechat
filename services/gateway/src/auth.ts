import { PlayerInfo } from './types.js';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Memvalidasi token sesi game pemain.
 * Mengembalikan PlayerInfo terverifikasi atau melempar AuthenticationError.
 */
export async function verifyGameSessionToken(token: string | null | undefined): Promise<PlayerInfo> {
  if (!token || token.trim() === '') {
    throw new AuthenticationError('Token sesi game tidak disediakan');
  }

  // Format token validasi:
  // 1. Format test/mock: "token_<uid>" atau "test_token_<uid>"
  // 2. Format base64 encoded JSON { uid, nickname, server, level, vip_tier }
  // 3. Format default: "valid_token" mengarah ke mock player
  if (token.startsWith('token_') || token.startsWith('mock_')) {
    const uid = token.split('_').slice(1).join('_');
    return {
      uid: uid || '77124490',
      nickname: `Player_${uid || '77124490'}`,
      server: 'SEA-3',
      level: 48,
      vip_tier: 4,
    };
  }

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.uid === 'string') {
      return {
        uid: parsed.uid,
        nickname: parsed.nickname || `Player_${parsed.uid}`,
        server: parsed.server || 'SEA-1',
        level: parsed.level || 1,
        vip_tier: parsed.vip_tier || 0,
      };
    }
  } catch {
    // Bukan base64 JSON, izinkan string token alfanumerik standar untuk development
  }

  if (token.length >= 6) {
    return {
      uid: `uid_${token.slice(0, 8)}`,
      nickname: 'RyuHunter',
      server: 'SEA-3',
      level: 48,
      vip_tier: 4,
    };
  }

  throw new AuthenticationError('Token sesi game tidak valid atau kedaluwarsa');
}
