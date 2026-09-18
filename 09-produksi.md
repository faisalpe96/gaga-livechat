# 09 — Produksi: autentikasi, integrasi game, dan penerbitan

Semua yang dibangun sampai sini berjalan di lokal tanpa autentikasi nyata.
Dokumen ini menutup tiga lubang sebelum sistem boleh menyentuh pemain sungguhan:
siapa yang boleh masuk panel, bagaimana game dan chat saling percaya, dan di mana
semuanya dijalankan.

## Bagian 1 — Autentikasi panel agent dan AI Studio

Saat ini panel bisa dibuka siapa saja yang tahu URL-nya, dan agent dipilih lewat
dropdown. Itu tidak boleh sampai produksi.

### Cara masuk

Pakai SSO lewat penyedia identitas yang sudah dipakai perusahaan — Google
Workspace, Microsoft Entra, atau sejenisnya — dengan OIDC. Alasannya: tidak ada
kata sandi baru yang perlu dikelola, dan saat seorang agent keluar dari
perusahaan, akses dicabut di satu tempat.

Kalau SSO belum tersedia, pakai email dan kata sandi dengan syarat: hash Argon2id,
wajib TOTP untuk peran supervisor dan admin, dan pembatasan percobaan masuk.

### Peran

| Peran | Boleh |
|---|---|
| `agent` | Melihat antrean sesuai bahasanya, klaim, balas, tutup, tandai draft |
| `supervisor` | Semua milik agent, plus semua bahasa, laporan, dan tinjauan draft |
| `admin` | Semua di atas, plus AI Studio, daftar izin auto-reply, dan pengaturan pasar |

Aturan terkunci di `04-orchestrator.md` tetap tidak bisa diubah siapa pun lewat
UI, termasuk admin. Perubahannya lewat deploy.

### Yang harus dibangun

```sql
ALTER TABLE agents
  ADD COLUMN email          text UNIQUE,
  ADD COLUMN role           text NOT NULL DEFAULT 'agent',
  ADD COLUMN external_id    text,
  ADD COLUMN is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN last_login_at  timestamptz;

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES agents(id),
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Catat di `audit_log` setiap tindakan yang berdampak: klaim percakapan,
pengiriman pesan, penutupan, perubahan daftar izin auto-reply, pengaktifan
pasar, dan pembukaan lampiran. Saat ada sengketa dengan pemain, ini satu-satunya
sumber kebenaran.

Hapus dropdown pemilih agent dari panel. Identitas agent berasal dari sesi login,
bukan dari pilihan di layar.

## Bagian 2 — Kepercayaan antara game dan chat

### Token pemain

Widget sekarang memakai token tiruan seperti `token_77124490`. Di produksi, token
harus diterbitkan backend game dan diverifikasi gateway.

Bentuk yang disarankan: JWT bertanda tangan, berumur pendek (5–15 menit),
diterbitkan endpoint di backend game setelah pemain login.

```json
{
  "sub": "77124490",
  "nickname": "RyuHunter",
  "server": "SEA-3",
  "market": "ID",
  "locale": "id-ID",
  "level": 48,
  "vip_tier": 4,
  "aud": "gaga-livechat",
  "iss": "gaga-game-backend",
  "exp": 1789700000
}
```

Gateway wajib memverifikasi tanda tangan, masa berlaku, `aud`, dan `iss` pada
setiap koneksi. Kunci publik diambil dari endpoint JWKS backend game supaya
rotasi kunci tidak butuh deploy ulang.

Yang tidak boleh: mempercayai UID yang dikirim widget tanpa token, atau
menerbitkan token di sisi frontend.

### Memasang widget di game

Untuk klien web, sematkan lewat satu potong skrip:

```html
<script src="https://chat.gagagames.example/widget.js" defer></script>
<script>
  GagaChat.init({
    token: "<JWT dari backend game>",
    page: window.location.pathname
  });
</script>
```

Untuk klien mobile, buka WebView ke `https://chat.gagagames.example/embed`
dengan token dikirim lewat header atau POST, bukan lewat parameter URL —
token di URL akan tercatat di log server dan riwayat.

Atur CORS dan CSP agar hanya domain resmi Gaga Games yang boleh memuat widget.

### API game yang dipanggil orchestrator

Tool di `04-orchestrator.md` butuh endpoint dari sisi game:

| Tool | Endpoint yang dibutuhkan | Sifat |
|---|---|---|
| `get_transaction` | Cari transaksi berdasarkan order ID, dibatasi UID sesi | Baca |
| `get_account_status` | Status akun aktif, terkunci, atau dibatasi | Baca |
| `get_event_claim` | Riwayat klaim reward per event | Baca |
| `get_server_status` | Status server dan jadwal maintenance | Baca |
| `freeze_account` | Pembekuan sementara, reversibel | Tulis |
| `grant_compensation` | Pemberian item | Tulis, terakhir diaktifkan |

Pengamanan jalur ini: autentikasi antar layanan lewat mTLS atau token layanan
yang dirotasi, daftar izin IP, batas laju, dan timeout 3 detik seperti tertulis
di `01-arsitektur.md`.

Endpoint tulis wajib menerima `idempotency_key` dan mengembalikan hasil yang sama
untuk kunci yang sama.

## Bagian 3 — Basis data

Tetap PostgreSQL 15 atau lebih baru dengan ekstensi `pgvector`, sama seperti di
lokal. Jangan ganti mesin database menjelang produksi.

### Pilihan layanan terkelola

| Layanan | Catatan |
|---|---|
| Supabase | `pgvector` siap pakai, ada region Singapura, termurah untuk memulai |
| Neon | `pgvector` siap pakai, penskalaan otomatis, bagus untuk beban tidak merata |
| AWS RDS / Aurora | `pgvector` tersedia, paling matang untuk beban besar, biaya lebih tinggi |
| Google Cloud SQL | `pgvector` tersedia, cocok kalau infrastruktur lain sudah di GCP |
| DigitalOcean Managed | Sederhana, murah, region Singapura tersedia |

Pilih region **Singapura** apa pun penyedianya. Dari sana latensi ke keenam
pasar paling seimbang; server di Amerika atau Eropa akan terasa lambat di chat
yang sifatnya real time.

### Yang wajib ada di produksi

Pencadangan otomatis harian dengan retensi minimal tujuh hari, dan
point-in-time recovery kalau tersedia. Koneksi wajib TLS. Kata sandi database
tidak pernah masuk repo. Migrasi dijalankan lewat CI, bukan manual dari laptop.

Redis juga perlu versi terkelola untuk fan-out WebSocket — Upstash, Redis Cloud,
atau layanan setara di region yang sama.

Lampiran file jangan disimpan di disk server. Pakai object storage seperti S3,
Cloudflare R2, atau Supabase Storage, dengan akses hanya lewat signed URL
berumur pendek seperti sudah ditetapkan.

## Bagian 4 — Susunan penerbitan

| Komponen | Sifat | Cara dijalankan |
|---|---|---|
| Chat gateway | Stateful, WebSocket | Container, minimal 2 instance di belakang load balancer dengan sticky session |
| AI orchestrator | Stateless | Container, jumlah instance menyesuaikan beban |
| Panel agent | Berkas statis | CDN atau hosting statis |
| Widget | Berkas statis | CDN, dengan versi di nama berkas untuk cache busting |
| Postgres | Terkelola | Region Singapura |
| Redis | Terkelola | Region sama dengan Postgres |
| Object storage | Terkelola | Region sama |

Load balancer harus mendukung WebSocket dan sticky session. Tanpa sticky
session, koneksi bisa berpindah instance di tengah sesi.

### Variabel lingkungan

Semua rahasia lewat pengelola rahasia penyedia, bukan berkas `.env` di server.

```
DATABASE_URL
REDIS_URL
GAME_API_BASE_URL
GAME_API_SERVICE_TOKEN
GAME_JWKS_URL
LLM_API_KEY
EMBEDDING_API_KEY
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
OIDC_ISSUER
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
ALLOWED_WIDGET_ORIGINS
```

### Pemantauan

Yang perlu dipantau sejak hari pertama: jumlah koneksi WebSocket aktif, latensi
orchestrator, tingkat kegagalan panggilan API game, panjang antrean per bahasa,
dan `oncall_alerts` yang belum diakui.

Pasang alarm untuk: orchestrator gagal di atas ambang, antrean melebihi SLA,
dan lonjakan `grant_compensation` kalau tool itu sudah aktif.

## Bagian 5 — Daftar periksa sebelum terbit

Jangan terbitkan sebelum semua ini terpenuhi.

**Data**
- [ ] FAQ dan canned response asli Gaga Games sudah menggantikan data contoh
- [ ] Frasa pagar pengaman terisi untuk setiap locale yang akan diaktifkan,
      ditulis penutur asli
- [ ] Nomor bantuan krisis per negara sudah diverifikasi dan masuk KB
- [ ] Nama persona per pasar sudah diperiksa penutur asli

**Keamanan**
- [ ] Panel dan AI Studio tidak bisa diakses tanpa login
- [ ] Token pemain diverifikasi tanda tangannya, bukan dipercaya begitu saja
- [ ] `ALLOWED_WIDGET_ORIGINS` dibatasi domain resmi
- [ ] Lampiran divalidasi lewat MIME sniffing dan EXIF dibersihkan
- [ ] `grant_compensation` masih mati, kecuali seluruh syarat di
      `04-orchestrator.md` sudah dipenuhi

**Operasional**
- [ ] Jam kerja dan zona waktu terisi benar untuk keenam pasar
- [ ] Jadwal agent menutup setiap antrean bahasa yang diaktifkan
- [ ] Jalur siaga malam sudah ditentukan orangnya dan kanalnya
- [ ] Pencadangan database berjalan dan sudah diuji pemulihannya

**Kesiapan bot**
- [ ] `markets.is_bot_enabled` menyala hanya untuk pasar yang siap
- [ ] Auto-reply menyala hanya untuk intent yang memenuhi ambang 90%
- [ ] Mode bayangan sudah berjalan cukup lama untuk menghasilkan data itu

## Urutan peluncuran yang disarankan

Terbitkan dulu tanpa auto-reply sama sekali: live chat manusia penuh, bot
berjalan di mode bayangan menyusun draft. Risikonya paling kecil dan Anda
langsung mendapat data nyata dari pemain sungguhan, bukan dari uji coba sendiri.

Setelah dua sampai empat minggu, nyalakan mode luar jam untuk satu pasar —
seperti dijelaskan di `07-mode-luar-jam.md`, di luar jam kerja pembanding bot
adalah tidak ada jawaban sama sekali, jadi ambangnya lebih rendah.

Lalu perluas ke pasar lain di mode luar jam, dan terakhir baru auto-reply di
jam kerja untuk intent yang sudah terbukti.
