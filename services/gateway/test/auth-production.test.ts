import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayServer } from '../src/server.js';
import { Database } from '../src/db.js';
import { RedisPubSub } from '../src/redis.js';
import { AuthService, LocalPasswordAuthProvider, OidcAuthProvider } from '../src/auth-service.js';

describe('TASK-PRODUCTION-09: Bagian 1 — Autentikasi Panel Agent, AI Studio, RBAC & Audit Log', { timeout: 30000 }, () => {
  let db: Database;
  let pubsub: RedisPubSub;
  let serverApp: any;
  let baseUrl: string;

  // Test credentials
  const ADMIN_EMAIL = 'admin_test@gagagames.com';
  const SUPERVISOR_EMAIL = 'supervisor_test@gagagames.com';
  const AGENT_EMAIL = 'agent_test@gagagames.com';
  const TEST_PASSWORD = 'SecretPassword123!';

  let adminAgentId: string;
  let supervisorAgentId: string;
  let agentAgentId: string;

  let adminCookie: string;
  let supervisorCookie: string;
  let agentCookie: string;

  before(async () => {
    db = new Database();
    pubsub = new RedisPubSub();

    // Pastikan skema migrasi 004 siap
    await db.pool.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS email          text UNIQUE,
        ADD COLUMN IF NOT EXISTS password_hash  text,
        ADD COLUMN IF NOT EXISTS role           text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'supervisor', 'admin')),
        ADD COLUMN IF NOT EXISTS external_id    text,
        ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS last_login_at  timestamptz;

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id   uuid REFERENCES agents(id),
        action     text NOT NULL,
        target     text,
        detail     jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Bersihkan data uji sebelumnya
    await db.pool.query('DELETE FROM agent_sessions');
    await db.pool.query('DELETE FROM audit_log');
    await db.pool.query(`
      UPDATE conversations SET assigned_agent_id = NULL 
      WHERE assigned_agent_id IN (SELECT id FROM agents WHERE email IN ($1, $2, $3, 'sso_agent@gagagames.com'))
    `, [ADMIN_EMAIL, SUPERVISOR_EMAIL, AGENT_EMAIL]);
    await db.pool.query('DELETE FROM agents WHERE email IN ($1, $2, $3, $4)', [
      ADMIN_EMAIL,
      SUPERVISOR_EMAIL,
      AGENT_EMAIL,
      'sso_agent@gagagames.com',
    ]);

    // Enkripsi kata sandi dengan Argon2id
    const passwordHash = await AuthService.hashPassword(TEST_PASSWORD);

    // Buat 3 akun dengan 3 peran berbeda
    const adminAgent = await db.createAgent({
      name: 'Super Admin Test',
      email: ADMIN_EMAIL,
      password_hash: passwordHash,
      role: 'admin',
      locales: ['id-ID', 'en', 'ms-MY', 'th-TH', 'fil-PH', 'vi-VN'],
    });
    adminAgentId = adminAgent.id;

    const supervisorAgent = await db.createAgent({
      name: 'Supervisor Sarah Test',
      email: SUPERVISOR_EMAIL,
      password_hash: passwordHash,
      role: 'supervisor',
      locales: ['id-ID', 'en', 'ms-MY'],
    });
    supervisorAgentId = supervisorAgent.id;

    const agentAgent = await db.createAgent({
      name: 'CS Agent Reza Test',
      email: AGENT_EMAIL,
      password_hash: passwordHash,
      role: 'agent',
      locales: ['id-ID', 'en'],
    });
    agentAgentId = agentAgent.id;

    // Build gateway server dengan autentikasi AKTIF secara default (enforceAuth = true)
    const res = await buildGatewayServer({ db, pubsub, enforceAuth: true });
    serverApp = res.app;
    await serverApp.listen({ port: 0, host: '127.0.0.1' });
    const port = (serverApp.server.address() as any).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    try {
      serverApp?.server?.closeAllConnections?.();
      await serverApp?.close();
    } catch {}
    try {
      await pubsub?.close();
    } catch {}
    try {
      await db?.close();
    } catch {}
  });

  // =========================================================================
  // 1. UJI HASHING ARGON2ID & VERIFIKASI KATA SANDI
  // =========================================================================
  test('1. Hash Argon2id: Hash menggunakan format resmi argon2id, kata sandi salah ditolak, sandi pendek ditolak', async () => {
    const rawPassword = 'SecureSecretPassword2026!';
    const hash = await AuthService.hashPassword(rawPassword);

    // Verifikasi format Argon2id
    assert.ok(hash.startsWith('$argon2id$'), 'Hash wajib menggunakan varian Argon2id');
    assert.ok(hash.includes('m=65536'), 'Memori cost harus 64MB (65536 KB)');

    // Verifikasi kecocokan
    const match = await AuthService.verifyPassword(hash, rawPassword);
    assert.equal(match, true, 'Kata sandi yang benar wajib cocok');

    const wrongMatch = await AuthService.verifyPassword(hash, 'WrongPassword123!');
    assert.equal(wrongMatch, false, 'Kata sandi yang salah wajib ditolak');

    // Kata sandi pendek (< 8 karakter) wajib error
    await assert.rejects(
      async () => AuthService.hashPassword('short'),
      /minimal harus 8 karakter/,
      'Kata sandi kurang dari 8 karakter wajib ditolak'
    );
  });

  // =========================================================================
  // 2. UJI LOGIN BERBASIS COOKIE HTTPONLY & SECURE
  // =========================================================================
  test('2. Sesi berbasis cookie httpOnly & secure: Login menghasilkan cookie yang sah dan data agen tanpa password_hash', async () => {
    // 2.1 Login Admin
    const adminRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: TEST_PASSWORD }),
    });

    assert.equal(adminRes.status, 200, 'Login admin harus sukses (200)');
    const adminCookieHeader = adminRes.headers.get('set-cookie');
    assert.ok(adminCookieHeader, 'Set-Cookie header wajib ada');
    assert.ok(adminCookieHeader.includes('gaga_agent_session='), 'Cookie nama gaga_agent_session wajib disertakan');
    assert.ok(adminCookieHeader.toLowerCase().includes('httponly'), 'Cookie wajib httpOnly');
    assert.ok(adminCookieHeader.toLowerCase().includes('samesite=lax'), 'Cookie wajib sameSite lax');
    adminCookie = adminCookieHeader.split(';')[0];

    const adminData = await adminRes.json();
    assert.equal(adminData.agent.email, ADMIN_EMAIL);
    assert.equal(adminData.agent.role, 'admin');
    assert.equal(adminData.agent.password_hash, undefined, 'password_hash tidak boleh bocor ke response');

    // 2.2 Login Supervisor
    const supRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERVISOR_EMAIL, password: TEST_PASSWORD }),
    });
    assert.equal(supRes.status, 200);
    supervisorCookie = (supRes.headers.get('set-cookie') || '').split(';')[0];

    // 2.3 Login Agent
    const agRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AGENT_EMAIL, password: TEST_PASSWORD }),
    });
    assert.equal(agRes.status, 200);
    agentCookie = (agRes.headers.get('set-cookie') || '').split(';')[0];

    // 2.4 Login Gagal (Kata Sandi Salah) -> HTTP 401
    const failRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AGENT_EMAIL, password: 'WrongPassword!' }),
    });
    assert.equal(failRes.status, 401, 'Kata sandi salah harus ditolak dengan HTTP 401');
    const failData = await failRes.json();
    assert.equal(failData.code, 'AUTH_FAILED');
  });

  // =========================================================================
  // 3. UJI PENOLAKAN RUTE PANEL DI LEVEL API JIKA TANPA SESI SAH (HTTP 401)
  // =========================================================================
  test('3. Penolakan di level API: Seluruh rute panel wajib ditolak dengan HTTP 401 jika tidak ada sesi sah', async () => {
    // 3.1 GET /v1/queue tanpa sesi
    const queueNoAuth = await fetch(`${baseUrl}/v1/queue`);
    assert.equal(queueNoAuth.status, 401, 'GET /v1/queue tanpa sesi wajib ditolak HTTP 401');
    const queueErr = await queueNoAuth.json();
    assert.equal(queueErr.code, 'UNAUTHORIZED');

    // 3.2 POST /v1/conversations/:id/claim tanpa sesi
    const dummyId = '99999999-9999-9999-9999-999999999999';
    const claimNoAuth = await fetch(`${baseUrl}/v1/conversations/${dummyId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(claimNoAuth.status, 401, 'POST /v1/conversations/:id/claim tanpa sesi wajib ditolak HTTP 401');

    // 3.3 GET /v1/auth/me tanpa sesi
    const meNoAuth = await fetch(`${baseUrl}/v1/auth/me`);
    assert.equal(meNoAuth.status, 401, 'GET /v1/auth/me tanpa sesi wajib ditolak HTTP 401');

    // 3.4 Sesi token palsu / acak -> wajib ditolak HTTP 401
    const fakeAuth = await fetch(`${baseUrl}/v1/queue`, {
      headers: { Cookie: 'gaga_agent_session=fake_invalid_token_1234567890' },
    });
    assert.equal(fakeAuth.status, 401, 'Sesi token palsu wajib ditolak HTTP 401');

    // 3.5 GET /v1/auth/me DENGAN sesi yang sah -> Berhasil HTTP 200
    const meValid = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Cookie: agentCookie },
    });
    assert.equal(meValid.status, 200, 'GET /v1/auth/me dengan sesi sah harus 200 OK');
    const meData = await meValid.json();
    assert.equal(meData.agent.email, AGENT_EMAIL);
    assert.equal(meData.agent.role, 'agent');
  });

  // =========================================================================
  // 4. UJI TIGA PERAN (RBAC) & AKSES AI STUDIO
  // =========================================================================
  test('4. Kontrol Akses Berbasis Peran (RBAC): Agent biasa & Supervisor DITOLAK membuka AI Studio (HTTP 403), hanya Admin yang diizinkan', async () => {
    // 4.1 Agent mencoba mengakses AI Studio endpoint -> DITOLAK HTTP 403
    const agentStudioRes = await fetch(`${baseUrl}/v1/studio/rules`, {
      headers: { Cookie: agentCookie },
    });
    assert.equal(agentStudioRes.status, 403, 'Peran agent DILARANG mengakses /v1/studio/rules (HTTP 403)');
    const agentErr = await agentStudioRes.json();
    assert.equal(agentErr.code, 'FORBIDDEN');

    // 4.2 Supervisor mencoba mengakses AI Studio endpoint -> DITOLAK HTTP 403
    const supStudioRes = await fetch(`${baseUrl}/v1/studio/rules`, {
      headers: { Cookie: supervisorCookie },
    });
    assert.equal(supStudioRes.status, 403, 'Peran supervisor DILARANG mengakses /v1/studio/rules (HTTP 403)');

    // 4.3 Admin mengakses AI Studio endpoint -> DIIZINKAN HTTP 200
    const adminStudioRes = await fetch(`${baseUrl}/v1/studio/rules`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminStudioRes.status, 200, 'Peran admin DIIZINKAN mengakses /v1/studio/rules (HTTP 200)');

    // 4.4 Laporan draf: Supervisor dan Admin diizinkan (200), Agent biasa ditolak (403)
    const agentReportRes = await fetch(`${baseUrl}/v1/reports/draft-usage`, {
      headers: { Cookie: agentCookie },
    });
    assert.equal(agentReportRes.status, 403, 'Agent biasa ditolak melihat laporan (HTTP 403)');

    const supReportRes = await fetch(`${baseUrl}/v1/reports/draft-usage`, {
      headers: { Cookie: supervisorCookie },
    });
    assert.equal(supReportRes.status, 200, 'Supervisor diizinkan melihat laporan (HTTP 200)');

    const adminReportRes = await fetch(`${baseUrl}/v1/reports/draft-usage`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminReportRes.status, 200, 'Admin diizinkan melihat laporan (HTTP 200)');
  });

  // =========================================================================
  // 5. UJI HAPUS DROPDOWN PEMILIH AGENT; IDENTITAS BERASAL DARI SESI LOGIN
  // =========================================================================
  test('5. Identitas berasal dari sesi login: Klaim percakapan otomatis menggunakan ID agen dari sesi, bukan pilihan di layar', async () => {
    // Buat percakapan handoff_queued untuk locale id-ID
    const convRes = await db.pool.query(`
      INSERT INTO conversations (player_uid, market, locale, status, started_at)
      VALUES ('player_test_identity', 'ID', 'id-ID', 'handoff_queued', now())
      RETURNING id
    `);
    const convId = convRes.rows[0].id;

    // Agent mengklaim percakapan TANPA menyertakan agent_id di body (atau menyertakan ID palsu)
    const claimRes = await fetch(`${baseUrl}/v1/conversations/${convId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: agentCookie,
      },
      body: JSON.stringify({ agent_id: 'fake_other_agent_id' }), // ID palsu di body harus diabaikan!
    });

    assert.equal(claimRes.status, 200, 'Klaim berhasil');
    const claimData = await claimRes.json();

    // Verifikasi identitas assigned_agent_id adalah milik agent yang login
    assert.equal(
      claimData.assigned_agent_id,
      agentAgentId,
      'Identitas assigned_agent_id wajib berasal dari sesi login (agentCookie), bukan dari body!'
    );

    // Verifikasi di database
    const convInDb = await db.getConversation(convId);
    assert.equal(convInDb?.assigned_agent_id, agentAgentId);
    assert.equal(convInDb?.status, 'agent_active');
  });

  // =========================================================================
  // 6. UJI PENCATATAN AUDIT LOG UNTUK SETIAP TINDAKAN KRITIS
  // =========================================================================
  test('6. Tabel audit_log: Mencatat klaim percakapan, pesan agen, penutupan, dan perubahan setting studio', async () => {
    // 6.1 Klaim percakapan sudah tercatat di tes 5
    const claimAudit = await db.pool.query(
      `SELECT * FROM audit_log WHERE action = 'conversation.claim' ORDER BY created_at DESC LIMIT 1`
    );
    assert.ok(claimAudit.rows.length > 0, 'Audit log conversation.claim wajib tercatat');
    assert.equal(claimAudit.rows[0].actor_id, agentAgentId);

    // Ambil percakapan aktif dari tes 5
    const convRes = await db.pool.query(
      `SELECT id FROM conversations WHERE assigned_agent_id = $1 AND status = 'agent_active' LIMIT 1`,
      [agentAgentId]
    );
    const convId = convRes.rows[0].id;

    // 6.2 Agent kirim pesan -> Wajib tercatat di audit_log sebagai message.send
    const msgRes = await fetch(`${baseUrl}/v1/conversations/${convId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: agentCookie,
      },
      body: JSON.stringify({
        text: 'Halo! Saya agen resmi Gaga Games siap membantu Anda.',
        sender_type: 'agent',
      }),
    });
    assert.equal(msgRes.status, 201);

    const msgAudit = await db.pool.query(
      `SELECT * FROM audit_log WHERE action = 'message.send' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentAgentId]
    );
    assert.ok(msgAudit.rows.length > 0, 'Audit log message.send wajib tercatat');
    assert.equal(msgAudit.rows[0].detail.conversation_id, convId);

    // 6.3 Agent selesaikan percakapan -> Wajib tercatat di audit_log sebagai conversation.resolve
    const resolveRes = await fetch(`${baseUrl}/v1/conversations/${convId}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: agentCookie,
      },
      body: JSON.stringify({ resolution_reason: 'agent_resolved', ticket_id: 'TCK-8821' }),
    });
    assert.equal(resolveRes.status, 200);

    const resolveAudit = await db.pool.query(
      `SELECT * FROM audit_log WHERE action = 'conversation.resolve' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentAgentId]
    );
    assert.ok(resolveAudit.rows.length > 0, 'Audit log conversation.resolve wajib tercatat');
    assert.equal(resolveAudit.rows[0].detail.resolution_reason, 'agent_resolved');
    assert.equal(resolveAudit.rows[0].detail.ticket_id, 'TCK-8821');

    // 6.4 Admin ubah status bot pasar -> Wajib tercatat di audit_log sebagai settings.market_bot
    const botStatusRes = await fetch(`${baseUrl}/v1/studio/markets/ID/bot-status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify({ is_bot_enabled: false }),
    });
    assert.equal(botStatusRes.status, 200);

    const marketAudit = await db.pool.query(
      `SELECT * FROM audit_log WHERE action = 'settings.market_bot' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminAgentId]
    );
    assert.ok(marketAudit.rows.length > 0, 'Audit log settings.market_bot wajib tercatat');
    assert.equal(marketAudit.rows[0].target, 'ID');
    assert.equal(marketAudit.rows[0].detail.is_bot_enabled, false);

    // Kembalikan status bot pasar ID ke true
    await db.setMarketBotStatus('ID', true);
  });

  // =========================================================================
  // 7. UJI SKRIP CLI ADMIN & LARANGAN HALAMAN PENDAFTARAN PUBLIK
  // =========================================================================
  test('7. Keamanan pendaftaran: TIDAK ADA endpoint registrasi publik terbuka, akun baru hanya lewat CLI / admin', async () => {
    // Mencoba mengakses endpoint pendaftaran umum (seperti /v1/auth/register atau /register)
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hacker@example.com', password: 'Password123' }),
    });
    assert.equal(regRes.status, 404, 'Endpoint pendaftaran publik TIDAK BOLEH ADA (harus HTTP 404)');

    const regPageRes = await fetch(`${baseUrl}/register`);
    assert.equal(regPageRes.status, 404, 'Halaman pendaftaran publik TIDAK BOLEH ADA (harus HTTP 404)');
  });

  // =========================================================================
  // 8. UJI KESIAPAN STRUKTUR OIDC TANPA MEROMBAK ULANG
  // =========================================================================
  test('8. Kesiapan OIDC: Struktur data mendukung external_id dan OidcAuthProvider siap pakai', async () => {
    // Verifikasi kolom external_id di database
    const colRes = await db.pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'agents' AND column_name = 'external_id'
    `);
    assert.equal(colRes.rows.length, 1, 'Kolom external_id wajib ada di tabel agents');

    // Buat agen dengan external_id simulasi Google Workspace SSO
    const oidcEmail = 'sso_agent@gagagames.com';
    const externalGoogleSub = 'google-oauth2|10928374650192837465';

    await db.pool.query('DELETE FROM agents WHERE email = $1', [oidcEmail]);
    const oidcAgent = await db.createAgent({
      name: 'SSO Agent Google',
      email: oidcEmail,
      role: 'agent',
      locales: ['id-ID'],
      external_id: externalGoogleSub,
    });

    assert.equal(oidcAgent.external_id, externalGoogleSub);

    // Uji OidcAuthProvider
    const oidcProvider = new OidcAuthProvider(async (extId, em) => {
      const byExt = await db.getAgentByExternalId(extId);
      if (byExt) return byExt;
      return db.getAgentByEmail(em);
    });

    const authenticatedOidcAgent = await oidcProvider.authenticate({
      idToken: 'mock_jwt_token_from_google',
      externalId: externalGoogleSub,
      email: oidcEmail,
    });

    assert.equal(authenticatedOidcAgent.id, oidcAgent.id);
    assert.equal(authenticatedOidcAgent.email, oidcEmail);
    assert.equal(authenticatedOidcAgent.external_id, externalGoogleSub);
  });
});
