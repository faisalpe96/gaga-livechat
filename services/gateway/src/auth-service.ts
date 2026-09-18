import argon2 from 'argon2';
import crypto from 'node:crypto';

export type AgentRole = 'agent' | 'supervisor' | 'admin';

export interface AuthenticatedAgent {
  id: string;
  email: string;
  name: string;
  role: AgentRole;
  locales: string[];
  external_id?: string | null;
  is_active: boolean;
  last_login_at?: Date | null;
}

export interface AgentSession {
  id: string;
  agent_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

/**
 * Interface penyedia autentikasi agar OIDC (Google Workspace, Microsoft Entra)
 * dapat dihubungkan di kemudian hari tanpa merombak arsitektur controller/session.
 */
export interface AuthProvider {
  readonly type: 'local' | 'oidc';
  authenticate(credentials: unknown): Promise<AuthenticatedAgent>;
}

export class LocalPasswordAuthProvider implements AuthProvider {
  readonly type = 'local' as const;

  constructor(
    private getAgentByEmail: (email: string) => Promise<(AuthenticatedAgent & { password_hash?: string }) | null>
  ) {}

  async authenticate(credentials: { email: string; password: string }): Promise<AuthenticatedAgent> {
    const { email, password } = credentials;
    if (!email || !password) {
      throw new Error('Email dan kata sandi wajib diisi');
    }

    const agent = await this.getAgentByEmail(email.toLowerCase().trim());
    if (!agent) {
      throw new Error('Email atau kata sandi tidak sesuai');
    }

    if (!agent.is_active) {
      throw new Error('Akun dinonaktifkan. Hubungi administrator sistem');
    }

    if (!agent.password_hash) {
      throw new Error('Akun ini tidak dikonfigurasi untuk login kata sandi lokal');
    }

    const isValid = await AuthService.verifyPassword(agent.password_hash, password);
    if (!isValid) {
      throw new Error('Email atau kata sandi tidak sesuai');
    }

    return {
      id: agent.id,
      email: agent.email,
      name: agent.name,
      role: agent.role,
      locales: agent.locales,
      external_id: agent.external_id,
      is_active: agent.is_active,
      last_login_at: agent.last_login_at,
    };
  }
}

/**
 * Persiapan penyedia autentikasi OIDC untuk masa depan (spec/09-produksi.md)
 */
export class OidcAuthProvider implements AuthProvider {
  readonly type = 'oidc' as const;

  constructor(
    private getAgentByExternalIdOrEmail: (externalId: string, email: string) => Promise<AuthenticatedAgent | null>
  ) {}

  async authenticate(credentials: { idToken: string; externalId: string; email: string }): Promise<AuthenticatedAgent> {
    const agent = await this.getAgentByExternalIdOrEmail(credentials.externalId, credentials.email);
    if (!agent) {
      throw new Error('Akun OIDC tidak ditemukan di daftar agen internal');
    }
    if (!agent.is_active) {
      throw new Error('Akun agen dinonaktifkan');
    }
    return agent;
  }
}

export class AuthService {
  static readonly SESSION_COOKIE_NAME = 'gaga_agent_session';
  static readonly SESSION_DURATION_SECONDS = 7 * 24 * 3600; // 7 hari

  static readonly ROLE_HIERARCHY: Record<AgentRole, number> = {
    agent: 1,
    supervisor: 2,
    admin: 3,
  };

  /**
   * Enkripsi kata sandi dengan Argon2id spesifikasi OWASP
   */
  static async hashPassword(password: string): Promise<string> {
    if (!password || password.length < 8) {
      throw new Error('Kata sandi minimal harus 8 karakter');
    }
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,       // 3 iterasi
      parallelism: 4,
    });
  }

  /**
   * Verifikasi kata sandi terhadap hash Argon2id
   */
  static async verifyPassword(hash: string, plain: string): Promise<boolean> {
    if (!hash || !plain) return false;
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Menghasilkan token sesi acak aman berukuran 256-bit (64 hex characters)
   */
  static generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hash token sesi dengan SHA-256 sebelum disimpan ke database
   * (agar token yang tersimpan di database tidak dapat disalahgunakan jika DB bocor)
   */
  static hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Konfigurasi cookie aman (httpOnly, secure di production/https, sameSite)
   */
  static getCookieOptions(isProduction = process.env.NODE_ENV === 'production') {
    return {
      path: '/',
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const,
      maxAge: AuthService.SESSION_DURATION_SECONDS,
    };
  }

  /**
   * Validasi hierarki peran RBAC (Role-Based Access Control)
   */
  static hasMinimumRole(agentRole: AgentRole, requiredRole: AgentRole): boolean {
    const agentLevel = AuthService.ROLE_HIERARCHY[agentRole] || 0;
    const requiredLevel = AuthService.ROLE_HIERARCHY[requiredRole] || 0;
    return agentLevel >= requiredLevel;
  }

  /**
   * Cek apakah peran diizinkan untuk salah satu peran dalam daftar
   */
  static isAllowedRole(agentRole: AgentRole, allowedRoles: AgentRole[]): boolean {
    return allowedRoles.includes(agentRole);
  }
}
