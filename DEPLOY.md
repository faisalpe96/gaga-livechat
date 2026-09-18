# Panduan Penerbitan Produksi (Deployment Guide)
## Gaga Games LiveChat AI System
Sesuai dengan spesifikasi arsitektur **`spec/09-produksi.md`** (Bagian 3 & 4).

Dokumen ini memuat instruksi langkah demi langkah, perintah persis, dan daftar variabel lingkungan lengkap untuk menerbitkan seluruh sistem LiveChat ke lingkungan produksi cloud:
- **Supabase**: PostgreSQL 15+ terkelola dengan `pgvector` & Object Storage lampiran (Region Singapura).
- **Upstash**: Serverless Redis terkelola dengan TLS untuk fan-out WebSocket (Region Singapura).
- **Railway**: Chat Gateway (stateful, WebSocket, sticky session) & AI Orchestrator (stateless pipeline).
- **Cloudflare Pages**: Hosting statis global berkecepatan tinggi dengan edge CDN untuk Agent Panel & Widget.

---

## 1. Ikhtisar Arsitektur Penerbitan

```
                        [ Pemain di Web / Mobile ]
                                    │
                         (CDN Cloudflare Pages)
                         ┌──────────┴──────────┐
                         │   apps/widget/dist  │
                         └─────────────────────┘
                                    │ (WebSocket wss://)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ RAILWAY PLATFORM (Region Singapura)                                   │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Chat Gateway (Stateful Container, Port 3001)                   │   │
│   │ - Load Balancer dengan Sticky Sessions                         │   │
│   │ - Migrasi otomatis database saat deploy (deploy-migrate.ts)    │   │
│   │ - Proteksi Sesi Cookie httpOnly & Argon2id                     │   │
│   └───────────────┬────────────────────────────────┬───────────────┘   │
│                   │                                │                   │
│        (Private Network HTTP)                      │                   │
│                   ▼                                │                   │
│   ┌────────────────────────────────┐               │                   │
│   │ AI Orchestrator Container      │               │                   │
│   │ (Stateless Pipeline, Port 3003)│               │                   │
│   └───────────────┬────────────────┘               │                   │
└───────────────────┼────────────────────────────────┼───────────────────┘
                    │                                │
                    ▼                                ▼
       ┌────────────────────────┐       ┌────────────────────────┐
       │   SUPABASE SINGAPORE   │       │    UPSTASH SINGAPORE   │
       │ - PostgreSQL 15+       │       │ - Redis TLS (rediss://)│
       │ - pgvector (1536 dim)  │       │ - WebSocket Fan-Out    │
       │ - S3 Storage Bucket    │       └────────────────────────┘
       └────────────────────────┘
```

---

## 2. Langkah 1: Setup Supabase (Database & Object Storage)

Pilih penyedia basis data terkelola di **Region Singapura (`ap-southeast-1`)** agar latensi ke keenam pasar SEA (ID, SG, MY, TH, PH, VN) seimbang dan cepat (< 50ms).

### 2.1 Buat Proyek Supabase
1. Buka [Supabase Dashboard](https://supabase.com/dashboard) dan klik **New Project**.
2. Masukkan nama: `gaga-livechat-production`.
3. Masukkan kata sandi database yang kuat dan catat dengan aman.
4. Pilih Region: **Singapore (`ap-southeast-1`)**.

### 2.2 Aktifkan Ekstensi yang Dibutuhkan
Buka menu **SQL Editor** di dashboard Supabase dan jalankan query berikut:
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
```

### 2.3 Ambil Connection String Database
1. Buka menu **Project Settings** -> **Database**.
2. Di bagian **Connection string**, pilih tab **URI**:
   - Gunakan **Direct Connection** untuk migrasi schema:
     ```
     postgres://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
     ```
   - Atau **Connection Pooling (Session Mode)** jika menggunakan Supabase pooler:
     ```
     postgres://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
     ```
3. Simpan URL ini untuk variabel `DATABASE_URL`.

### 2.4 Setup Bucket Penyimpanan Lampiran (Supabase Storage)
Sesuai `09-produksi.md`, lampiran bukti pembayaran/screenshot disimpan di object storage, bukan di disk container:
1. Buka menu **Storage** -> klik **New Bucket**.
2. Masukkan nama bucket: `livechat-attachments`.
3. Pengaturan: **Private Bucket** (JANGAN centang Public bucket).
4. Buat kredensial S3 API kompatibel:
   - Buka **Project Settings** -> **Storage** -> **S3 Access Keys**.
   - Klik **Generate New Key**.
   - Catat `Access Key ID`, `Secret Access Key`, dan `Endpoint URL` (`https://[PROJECT-REF].supabase.co/storage/v1/s3`).

---

## 3. Langkah 2: Setup Upstash (Redis Pub/Sub)

Redis digunakan untuk *fan-out* event WebSocket antar multi-instance Chat Gateway.

1. Buka [Upstash Console](https://console.upstash.com/) dan klik **Create Database**.
2. Masukkan nama: `gaga-livechat-redis`.
3. Pilih Type: **Regional**.
4. Pilih Region: **ap-southeast-1 (Singapore)** (wajib sama dengan region database).
5. Aktifkan **TLS** (Enkripsi in-transit).
6. Di halaman database, cari bagian **Node.js / ioredis** dan salin **`REDIS_URL`**:
   ```
   rediss://default:[YOUR-PASSWORD]@[YOUR-ENDPOINT].upstash.io:6379
   ```
   *(Pastikan diawali dengan protokol `rediss://` untuk koneksi terenkripsi).*

---

## 4. Langkah 3: Deploy Railway (Gateway & Orchestrator)

Deploy kedua layanan container menggunakan Railway dengan menghubungkan repositori Git.

### 4.1 Persiapan CLI Railway
```bash
# Install Railway CLI jika belum ada
npm install -g @railway/cli

# Login ke akun Railway
railway login

# Hubungkan direktori proyek lokal
railway init
```

### 4.2 Deploy Layanan 1: AI Orchestrator
AI Orchestrator bersifat stateless dan memproses pipeline 7 langkah (Guardrails, Intent Classifier, Knowledge Base Retriever, LLM).

1. Di Railway Project Dashboard, tambahkan **New Service** -> **GitHub Repo**.
2. Beri nama service: `ai-orchestrator`.
3. Masukkan konfigurasi build & deploy:
   - **Build**: Dockerfile
   - **Dockerfile Path**: `services/orchestrator/Dockerfile`
   - **Healthcheck Path**: `/health/live`
   - **Healthcheck Timeout**: `10`
4. Masukkan **Environment Variables** untuk `ai-orchestrator`:
   ```env
   NODE_ENV=production
   PORT=3003
   ORCHESTRATOR_PORT=3003
   DATABASE_URL=postgres://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   LLM_API_KEY=your-gemini-or-openai-api-key
   LLM_MODEL=gemini-1.5-flash
   EMBEDDING_API_KEY=your-embedding-api-key
   EMBEDDING_PROVIDER=mock-local-1536
   ```
5. Aktifkan **Private Networking** di settings service `ai-orchestrator`, catat private domain-nya (contoh: `http://ai-orchestrator.railway.internal:3003`).

### 4.3 Deploy Layanan 2: Chat Gateway
Chat Gateway bersifat stateful WebSocket yang melayani pemain, agen, dan AI Studio.

1. Di Railway Project Dashboard yang sama, klik **New Service** -> **GitHub Repo**.
2. Beri nama service: `chat-gateway`.
3. Masukkan konfigurasi build & deploy:
   - **Build**: Dockerfile
   - **Dockerfile Path**: `services/gateway/Dockerfile`
   - **Healthcheck Path**: `/health/live`
   - **Restart Policy**: `ON_FAILURE`, max retries 5
4. **PENTING: Konfigurasi Sticky Session & WebSocket**:
   - Di tab **Settings**, pastikan **App Sleep** dimatikan (*Never sleep*).
   - Buat domain publik (misal: `https://gateway-production.up.railway.app` atau kustom domain `https://chat.gagagames.com`).
5. Masukkan **Environment Variables** untuk `chat-gateway`:
   ```env
   NODE_ENV=production
   PORT=3001
   GATEWAY_PORT=3001
   ENFORCE_AUTH=true
   DATABASE_URL=postgres://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   REDIS_URL=rediss://default:[PASSWORD]@[ENDPOINT].upstash.io:6379
   ORCHESTRATOR_URL=http://ai-orchestrator.railway.internal:3003
   ATTACHMENT_SIGNING_SECRET=generate-a-strong-random-hmac-key-minimum-32-chars
   STORAGE_PROVIDER=supabase
   STORAGE_BUCKET=livechat-attachments
   STORAGE_ACCESS_KEY=your-supabase-storage-access-key
   STORAGE_SECRET_KEY=your-supabase-storage-secret-key
   STORAGE_ENDPOINT=https://[PROJECT-REF].supabase.co/storage/v1/s3
   STORAGE_REGION=ap-southeast-1
   ALLOWED_WIDGET_ORIGINS=https://game.gagagames.com,https://pay.gagagames.com,https://account.gagagames.com
   ```

*Catatan:* Container `services/gateway/Dockerfile` secara otomatis mengeksekusi `scripts/deploy-migrate.ts` sebelum server menyala, sehingga skema tabel, ekstensi `vector`, dan migrasi SQL UP akan terpasang otomatis pada database Supabase.

### 4.4 Inisialisasi Akun Admin Pertama & Seed Data Produksi
Setelah deploy Gateway dan Orchestrator selesai dan berstatus *Active*, jalankan perintah satu kali berikut via Railway CLI:

```bash
# 1. Buat akun Administrator utama (TIDAK ADA registrasi publik)
railway run npm run admin:create -- --email admin@gagagames.com --name "Gaga Principal Admin" --password "YourStrongProductionPassword2026!" --role admin

# 2. Impor Knowledge Base & Dokumen Kebijakan Resmi
railway run npm run seed:kb

# 3. Impor dataset frasa pagar pengaman (Guardrails) untuk 6 bahasa SEA
railway run npm run seed:guardrails
```

---

## 5. Langkah 4: Deploy Cloudflare Pages (Frontend Statis)

Sesuai `spec/09-produksi.md`, panel agent dan widget disajikan sebagai **berkas statis murni** melalui CDN global dengan *edge caching*.

### 5.1 Deploy Proyek 1: Agent Panel (`apps/agent-panel`)
1. Buka [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git**.
2. Pilih repositori `LIVECHAT`.
3. Pengaturan Build:
   - **Framework preset**: `Vite`
   - **Root directory**: `apps/agent-panel`
   - **Build command**: `npm run build` *(atau `npx vite build`)*
   - **Build output directory**: `dist`
4. **Environment Variables**:
   ```env
   VITE_GATEWAY_URL=https://chat.gagagames.com
   ```
   *(Arahkan ke domain Gateway Railway yang sudah dibuat).*
5. Klik **Save and Deploy**. Cloudflare akan memberikan URL seperti `https://gaga-agent-panel.pages.dev` (atau dapat di-bind ke domain kustom `https://panel.gagagames.com`).

### 5.2 Deploy Proyek 2: Widget Pemain (`apps/widget`)
Widget dipaketkan sebagai berkas JavaScript statis tunggal mandiri (`widget.js`) yang siap disematkan di game web maupun WebView mobile:

1. Di Cloudflare Pages, buat proyek baru: `gaga-chat-widget`.
2. Pengaturan Build:
   - **Framework preset**: `None`
   - **Root directory**: `/`
   - **Build command**: `npm run widget:build`
   - **Build output directory**: `apps/widget/dist`
3. Klik **Save and Deploy**. Berkas `widget.js` kini dapat diakses secara publik pada URL CDN:
   ```html
   <script src="https://gaga-chat-widget.pages.dev/widget.js" defer></script>
   ```

---

## 6. Integrasi Widget di Game (Klien Web & Mobile)

Sesuai spesifikasi `spec/09-produksi.md` Bagian 2:

### 6.1 Klien Web Game Gaga Games
Sematkan skrip pada header atau halaman web:
```html
<!-- Muat script widget dari Cloudflare Pages CDN -->
<script src="https://gaga-chat-widget.pages.dev/widget.js" defer></script>

<script>
  window.addEventListener('DOMContentLoaded', () => {
    GagaChat.init({
      url: 'wss://chat.gagagames.com/v1/socket',
      token: playerJwtTokenFromBackend,
      page: window.location.pathname
    });
  });
</script>
```

### 6.2 Klien Mobile (Android / iOS WebView)
Buka WebView mengarah ke endpoint embed aman gateway:
- **URL**: `https://chat.gagagames.com/embed`
- **Aturan Keamanan**: Token dikirimkan melalui **Header HTTP** (`Authorization: Bearer <JWT>`) atau via **POST**, **DILARANG** melalui parameter query URL agar token tidak tercatat di riwayat dan log server.

---

## 7. Checklist Verifikasi Pasca-Penerbitan (Post-Deploy Verification)

Jalankan pengujian ini segera setelah seluruh layanan aktif:

### 1. Uji Healthcheck Gateway & Database
```bash
curl -I https://chat.gagagames.com/health
# Harus mengembalikan HTTP 200 OK dengan payload:
# {"status":"ok","service":"chat-gateway","checks":{"database":"connected","redis":"connected"}}
```

### 2. Uji Healthcheck Orchestrator
```bash
curl -I https://orchestrator.gagagames.com/health
# Harus mengembalikan HTTP 200 OK dengan payload:
# {"status":"ok","service":"ai-orchestrator","checks":{"database":"connected","guardrails_ready":true}}
```

### 3. Uji Proteksi API Level (Tanpa Login)
```bash
curl -i https://chat.gagagames.com/v1/queue
# Wajib ditolak dengan HTTP 401 Unauthorized
```

### 4. Uji Login Akun Admin
1. Buka `https://chat.gagagames.com/login` di browser.
2. Masukkan email `admin@gagagames.com` dan kata sandi yang disetel pada langkah 4.4.
3. Pastikan cookie `gaga_agent_session` diterima dengan atribut `httpOnly` dan `Secure`.
4. Pastikan browser berhasil masuk ke konsol AI Studio (`/studio`) dan Panel Agen (`https://panel.gagagames.com`).

---

## 8. Pemantauan & Alarm Hari Pertama (Monitoring & Alerting)

Pasang pemantauan dan alarm metrik berikut pada dashboard Railway dan Supabase:

| Indikator | Ambang Normal | Tindakan Jika Melebihi Ambang |
|---|---|---|
| **Koneksi WebSocket Aktif** | Sesuai CCU Game | Naikkan replika container Gateway jika CPU > 75% |
| **Latensi AI Orchestrator** | < 1500 ms | Periksa latensi panggilan LLM / embedding provider |
| **Error Rate Gateway (/health)** | 0% | Periksa koneksi pool Postgres dan kuota Redis |
| **Panjang Antrean per Bahasa** | < 10 tiket | Peringatan darurat ke oncall supervisor |
| **Pelanggaran Guardrail `bahaya_diri`** | Tertangkap 100% | Eskalasi langsung ke tim darurat tanpa memanggil LLM |

---
*Dokumen ini dibuat dan diverifikasi untuk Gaga Games LiveChat AI v1.0.0 Production.*
