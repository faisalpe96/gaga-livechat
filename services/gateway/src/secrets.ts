import crypto from 'node:crypto';

/**
 * Pengambilan secret dari environment dengan kebijakan fail-fast.
 *
 * Latar belakang: dua secret pernah punya nilai fallback hardcoded di source
 * (repo Public), sehingga server yang lupa di-set variabelnya diam-diam berjalan
 * dengan secret yang bisa dibaca siapa saja. Helper ini memastikan:
 *
 *   - Produksi (NODE_ENV=production): variabel WAJIB ada dan >= MIN_SECRET_LENGTH,
 *     kalau tidak proses berhenti saat startup dengan pesan yang jelas.
 *   - Dev/test: variabel boleh kosong; dipakai nilai acak per proses + peringatan.
 *   - Nilai default lama yang pernah bocor DITOLAK di semua mode.
 */

export const MIN_SECRET_LENGTH = 32;

/** Nilai fallback lama yang pernah ada di source. Jangan pernah diterima lagi. */
const KNOWN_LEAKED_DEFAULTS = new Set([
  'gaga-livechat-production-cookie-secret-2026',
  'gaga-livechat-secure-signing-secret-2026',
]);

export interface RequireSecretOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'warn'>;
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function generateSecret(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function howToFix(name: string): string {
  return (
    `Set variabel ${name} (minimal ${MIN_SECRET_LENGTH} karakter acak) di environment / dashboard Railway. ` +
    `Contoh pembuatan nilai: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
  );
}

export function requireSecret(name: string, options: RequireSecretOptions = {}): string {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const value = (env[name] || '').trim();

  if (value && KNOWN_LEAKED_DEFAULTS.has(value)) {
    throw new Error(
      `[Secrets] ${name} memakai nilai default lama yang pernah dipublikasikan di repositori. ` +
        `Nilai ini ditolak di semua mode. ${howToFix(name)}`
    );
  }

  if (isProductionEnv(env)) {
    if (!value) {
      throw new Error(`[Secrets] ${name} tidak di-set. Server produksi menolak berjalan tanpa secret ini. ${howToFix(name)}`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `[Secrets] ${name} terlalu pendek (${value.length} karakter, minimal ${MIN_SECRET_LENGTH}). ${howToFix(name)}`
      );
    }
    return value;
  }

  // Mode dev/test
  if (!value) {
    logger.warn(
      `[Secrets] ${name} tidak di-set; memakai nilai acak sementara untuk proses ini (mode ${env.NODE_ENV || 'development'}). ` +
        `Sesi/tanda tangan tidak akan bertahan setelah restart.`
    );
    return generateSecret();
  }
  if (value.length < MIN_SECRET_LENGTH) {
    logger.warn(
      `[Secrets] ${name} hanya ${value.length} karakter; di produksi minimal ${MIN_SECRET_LENGTH} akan diwajibkan.`
    );
  }
  return value;
}
