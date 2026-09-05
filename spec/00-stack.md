# 00 — Tumpukan Teknologi (Technology Stack)

Dokumen ini mengunci seluruh keputusan arsitektur teknologi, dependensi inti, dan struktur folder repositori untuk implementasi AI live chat bot Gaga Games.

---

## 1. Keputusan Tumpukan Teknologi

| Komponen | Teknologi Terpilih | Runtime / Framework |
|---|---|---|
| **Basis Data** | PostgreSQL 15+ dengan ekstensi `pgvector` | PostgreSQL 15, `pgvector` |
| **Migrasi Database** | `node-pg-migrate` | SQL murni (.sql) |
| **Real-time Bus (Fan-out)** | Redis Pub/Sub | Redis 7+ / `ioredis` |
| **Chat Gateway** | Node.js (TypeScript) | Fastify + `@fastify/websocket` (library `ws`) |
| **AI Orchestrator** | Node.js (TypeScript) — Layanan Terpisah | Fastify / REST API (*Stateless*) |
| **Widget Chat** | TypeScript + Preact (Web Component / Shadow DOM) | Vite (Single bundle terisolasi) |
| **Panel Agent** | React (TypeScript) + Tailwind CSS | Vite + shadcn/ui + Zustand + TanStack Query |

---

## 2. Rincian dan Alasan Pilihan

### 2.1. Basis Data: PostgreSQL 15+ dengan `pgvector`
- **Pilihan:** PostgreSQL 15+ yang diperkaya ekstensi `pgvector`.
- **Alasan:**
  - Menghilangkan kebutuhan akan *vector database* terpisah (seperti Pinecone, Milvus, Qdrant), sehingga mengurangi kompleksitas operasional, biaya infrastruktur, dan latensi jaringan.
  - Memungkinkan pencarian kemiripan kosinus (*cosine similarity*) atau jarak L2 untuk dokumen knowledge base (FAQ, kebijakan) langsung dengan query SQL yang terindeks dan difilter menurut kolom `locale` secara atomik.
  - Menyediakan transaksi ACID penuh untuk status sesi, penguncian klaim percakapan, dan pencatatan audit *tool calls* ber-idempotency key.

### 2.2. Migrasi Database: `node-pg-migrate` (SQL Murni)
- **Pilihan:** `node-pg-migrate` dengan file migrasi berformat SQL murni (`.sql` up & down).
- **Alasan:**
  - DDL pada spesifikasi (`03-skema-database.md` & `07-mode-luar-jam.md`) dirancang menggunakan fitur PostgreSQL asli (`CREATE TYPE ... AS ENUM`, `timestamptz`, array types `text[]`, `jsonb`, dan ekstensi `pgvector`).
  - Menghindari abstraksi ORM yang kaku atau menghasilkan query suboptimal.
  - Memastikan proses migrasi dan *rollback* dapat dieksekusi secara terprediksi, bersih, dan mudah diverifikasi pada tahap TASK-01.

### 2.3. Distribusi Real-time: Redis Pub/Sub untuk Fan-out WebSocket
- **Pilihan:** Redis Pub/Sub via `ioredis`.
- **Alasan:**
  - Instance Gateway dirancang *horizontally scalable* (bisa berjalan di balik load balancer).
  - Ketika pemain terhubung ke Gateway Instance A dan Agent terhubung ke Gateway Instance B, pesan baru, pergantian status sesi, maupun indikator mengetik disiarkan secara instan antar-gateway melalui kanal Redis tanpa kehilangan sinkronisasi.

### 2.4. Chat Gateway: Node.js (TypeScript) + Fastify & `ws`
- **Pilihan:** Node.js 20+ LTS dengan Fastify dan library `ws`.
- **Alasan:**
  - Fastify memiliki *overhead* terendah di ekosistem Node.js dan penanganan I/O asinkron yang sangat efisien untuk ribuan koneksi WebSocket konkuren.
  - Berbagi definisi tipe data acara (`session_start`, `message`, `status_change`) dan skema validasi runtime (misal menggunakan Zod) dengan frontend tanpa duplikasi definisi.
  - Memiliki kontrol penuh atas siklus hidup status percakapan (`bot_active`, `handoff_queued`, `agent_active`, `resolved`) dan penegakan timeout secara ketat.

### 2.5. AI Orchestrator: Node.js (TypeScript) — Layanan Terpisah (*Stateless*)
- **Pilihan:** Node.js (TypeScript) dengan REST API berbasis Fastify, berjalan sebagai microservice independen.
- **Alasan:**
  - **Kemandirian Skalabilitas:** Orchestrator menangani operasi CPU/jaringan yang lebih berat (embedding, pemanggilan LLM, guardrail matching, RAG filtering) sehingga dapat di-*scale-out* secara dinamis tanpa memengaruhi koneksi WebSocket persisten di Gateway.
  - **Stateless Penuh:** Setiap pemanggilan `POST /v1/orchestrate` membawa seluruh konteks yang diperlukan (riwayat maks 20 pesan/4000 token, profil pemain, page context) sesuai batasan teknis arsitektur.
  - **Keseragaman Ekosistem:** Menggunakan TypeScript memungkinkan standarisasi kontrak payload request/response dengan Gateway (`action: reply | handoff`, `meta`, `bot_summary`).

### 2.6. Widget Chat: Preact + TypeScript (Web Component / Shadow DOM)
- **Pilihan:** Preact dalam Custom Element / Shadow DOM dibundel menggunakan Vite.
- **Alasan:**
  - **Ukuran Sangat Ringan:** Preact hanya berukuran ~4 KB (vs React ~45 KB), menghasilkan bundle akhir yang sangat kecil (< 20 KB gzipped) sehingga tidak membebani performa loading game di browser seluler maupun webview aplikasi.
  - **Isolasi Gaya Total (Shadow DOM):** Menjamin styling widget tidak merusak CSS situs Gaga Games tempat widget disematkan, dan sebaliknya tidak terpengaruh oleh CSS global situs game.
  - **Portabilitas:** Cukup disematkan melalui satu tag `<script>` mandiri tanpa memerlukan bundler di sisi situs host.

### 2.7. Panel Agent: React (TypeScript) + Vite + Tailwind CSS + Zustand
- **Pilihan:** React 18/19, Tailwind CSS, shadcn/ui, Zustand, dan TanStack Query.
- **Alasan:**
  - Panel agent adalah aplikasi internal berbasis desktop yang kompleks: memerlukan pengurutan antrean dinamis berdasarkan sisa SLA pasar, antarmuka split dua lapis (pesan asli pemain di atas dan terjemahan di bawah), panel perbandingan draft bot, dan form evaluasi feedback.
  - Ekosistem React dan Zustand menyediakan pengelolaan state reaktif yang fleksibel untuk data live stream dari Gateway.

---

## 3. Struktur Folder Repositori yang Disarankan

Repositori disusun menggunakan struktur monorepo terarah (pnpm workspace) agar manajemen tipe bersama (*shared types*) dan skrip terintegrasi dengan rapi:

```
.
├── AGENTS.md                   # Instruksi kerja agent
├── README.md                   # Dokumentasi umum proyek
├── package.json                # Root workspace configuration
├── pnpm-workspace.yaml         # Definisi workspace monorepo
├── tsconfig.base.json          # Konfigurasi dasar TypeScript
│
├── spec/                       # Dokumen spesifikasi sistem
│   ├── 00-stack.md             # Keputusan tumpukan teknologi & struktur folder
│   ├── 01-arsitektur.md        # Komponen, alur pesan, timeout & status sesi
│   ├── 02-kontrak-api.md       # WebSocket events, REST orchestrator & panel
│   ├── 03-skema-database.md    # DDL & skema database Postgres
│   ├── 04-orchestrator.md      # Pipeline 7-langkah, guardrails & tools
│   ├── 05-lokalisasi.md        # Konfigurasi 6 pasar SEA, bahasa & SLA
│   ├── 06-tasks.md             # Urutan task teknis
│   ├── 07-mode-luar-jam.md     # Perilaku, skema & jalur siaga di luar jam kerja
│   └── prompts.md              # Template & prompt per sesi
│
├── migrations/                 # Migrasi database (node-pg-migrate)
│   ├── 001_initial_schema.sql  # DDL enum, tables, indexes, extensions
│   ├── 002_seed_markets.sql    # Seed 6 pasar SEA (is_bot_enabled = false)
│   └── ...
│
├── packages/                   # Paket modul bersama (Shared Modules)
│   ├── types/                  # Definisi tipe DTO, enum status, event kontrak WebSocket
│   │   ├── src/
│   │   │   ├── events.ts       # Kontrak WebSocket (session_start, message, dll.)
│   │   │   ├── conversation.ts # Status sesi, sender_type, resolution_reason
│   │   │   ├── orchestrator.ts # Request/Response POST /v1/orchestrate
│   │   │   └── index.ts
│   │   └── package.json
│   └── logger/                 # Utilitas logger terstruktur terpadu
│
├── services/                   # Backend Microservices
│   ├── gateway/                # Chat Gateway Service
│   │   ├── src/
│   │   │   ├── websocket/      # Koneksi ws, auth handshake, message dispatcher
│   │   │   ├── pubsub/         # Redis subscriber & publisher untuk fan-out
│   │   │   ├── state/          # Session state machine, SLA tracker, timeout watcher
│   │   │   ├── clients/        # HTTP client ke Orchestrator, DB repository
│   │   │   ├── server.ts       # Entry point Fastify Gateway
│   │   │   └── config.ts
│   │   ├── test/               # Unit & integration tests (koneksi ganda, transisi status)
│   │   └── package.json
│   │
│   └── orchestrator/           # AI Orchestrator Service (Stateless)
│       ├── src/
│       │   ├── pipeline/       # 7-step pipeline (hard triggers -> classify -> RAG -> tools -> draft -> filter)
│       │   ├── guardrails/     # Evaluasi guardrail phrases per locale
│       │   ├── kb/             # RAG retriever (vector similarity via pgvector)
│       │   ├── tools/          # Tool registry (read-only tools, create_ticket, handoff)
│       │   ├── llm/            # Client LLM provider & tokenizer/token limiter
│       │   ├── server.ts       # Entry point REST Fastify POST /v1/orchestrate
│       │   └── config.ts
│       ├── test/               # Pipeline tests, injection protection tests, filter tests
│       └── package.json
│
└── apps/                       # Frontend Applications
    ├── widget/                 # Live Chat Website Widget (Disematkan di situs game)
    │   ├── src/
    │   │   ├── components/     # UI Preact (ChatBox, MessageList, Input, LanguageSelector)
    │   │   ├── connection/     # WebSocket client dengan auto-reconnect & queue
    │   │   ├── web-component/  # Custom Element wrapper dengan Shadow DOM
    │   │   └── main.ts         # Entry point pembungkus widget
    │   ├── test/               # UI & event tests
    │   ├── vite.config.ts      # Konfigurasi bundler (output single js bundle)
    │   └── package.json
    │
    └── agent-panel/            # Panel Antarmuka Agent CS & Supervisor
        ├── src/
        │   ├── components/     # UI antrean, chat stream, split-view terjemahan, draft bot
        │   ├── hooks/          # TanStack query, WebSocket live updates
        │   ├── store/          # Zustand store (active conversation, agent state)
        │   └── App.tsx
        ├── test/               # UI logic & claim concurrency tests
        └── package.json
```

---

## 4. Konfirmasi Batasan Keamanan & Arsitektur
1. **Bot Tidak Pernah Menulis ke Widget:** `services/orchestrator` tidak memiliki koneksi socket ke client; semua respons dialirkan via HTTP ke `services/gateway`.
2. **Stateless Orchestrator:** Seluruh state berada di PostgreSQL dan dikirim oleh Gateway di setiap request.
3. **Argumen Tool Terverifikasi:** `player_uid` disuntikkan langsung oleh sistem dari sesi token terverifikasi, bukan dari parameter model.
4. **Isolasi Penuh Widget:** Berjalan di dalam Shadow DOM untuk menjamin zero-conflict styling dengan web host.
