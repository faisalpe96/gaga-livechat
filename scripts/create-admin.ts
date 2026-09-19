import dotenv from 'dotenv';
import { Database } from '../services/gateway/src/db.js';
import { AuthService, AgentRole } from '../services/gateway/src/auth-service.js';

dotenv.config();

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs();

  // Tidak ada nilai default untuk email/password: akun admin dengan kredensial
  // yang tertulis di repositori adalah lubang keamanan.
  if (!args.email || !args.password || args.email === 'true' || args.password === 'true') {
    console.error('[Error] --email dan --password wajib diisi.');
    console.error('Contoh: npm run admin:create -- --email admin@contoh.com --password "KataSandiKuat123" --name "Nama Admin"');
    process.exit(1);
  }
  const email = args.email;
  const name = args.name || 'Gaga System Administrator';
  const password = args.password;
  const role: AgentRole = (args.role as AgentRole) || 'admin';
  const locales = args.locales ? args.locales.split(',').map((l) => l.trim()) : ['id-ID', 'en', 'ms-MY', 'th-TH', 'fil-PH', 'vi-VN'];

  if (!['agent', 'supervisor', 'admin'].includes(role)) {
    console.error(`[Error] Peran '${role}' tidak sah. Pilih: agent, supervisor, atau admin.`);
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('[Error] Kata sandi minimal harus 8 karakter.');
    process.exit(1);
  }

  console.log('===========================================================');
  console.log('  GAGA LIVECHAT — CLI INITIAL ADMIN / AGENT CREATOR        ');
  console.log('  (spec/09-produksi.md: Tanpa Halaman Registrasi Publik)   ');
  console.log('===========================================================');

  const db = new Database();
  try {
    console.log(`Mengenkripsi kata sandi dengan algoritma Argon2id...`);
    const passwordHash = await AuthService.hashPassword(password);

    const existing = await db.getAgentByEmail(email);
    if (existing) {
      console.log(`Akun dengan email '${email}' sudah ada. Memperbarui kredensial & peran...`);
      await db.pool.query(
        `UPDATE agents
         SET name = $1,
             password_hash = $2,
             role = $3,
             locales = $4,
             is_active = true
         WHERE id = $5`,
        [name, passwordHash, role, locales, existing.id]
      );
      console.log(`Akun ID: ${existing.id} berhasil diperbarui.`);
    } else {
      console.log(`Membuat akun baru...`);
      const created = await db.createAgent({
        name,
        email,
        password_hash: passwordHash,
        role,
        locales,
        max_concurrent: 10,
      });
      console.log(`Akun ID: ${created.id} berhasil dibuat.`);
    }

    console.log('-----------------------------------------------------------');
    console.log(`Email    : ${email}`);
    console.log(`Nama     : ${name}`);
    console.log(`Peran    : ${role.toUpperCase()}`);
    console.log(`Bahasa   : ${locales.join(', ')}`);
    console.log('-----------------------------------------------------------');
    console.log('PERINGATAN KEAMANAN:');
    console.log('Sesuai spec/09-produksi.md, TIDAK ADA halaman registrasi');
    console.log('publik. Seluruh akun hanya dapat dibuat melalui skrip ini');
    console.log('atau ditambahkan oleh administrator di konsol.');
    console.log('===========================================================');
  } catch (err: any) {
    console.error('[Gagal]', err.message || err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
