# 04 — Orchestrator

## Pipeline

Urutannya tidak boleh diubah. Filter output berjalan **setelah** model menjawab
dan **sebelum** apa pun keluar ke gateway.

```
1. Cek pemicu keras         -> ketemu? langsung handoff, model tidak dipanggil
2. Klasifikasi intent       -> intent + confidence
3. Ambil dokumen (RAG)      -> dokumen terfilter locale, maks 5 potongan
4. Panggil tool bila perlu  -> hasil masuk konteks
5. Susun jawaban            -> model bahasa, bahasa output = conversations.locale
6. Filter output            -> gagal? handoff, jawaban dibuang
7. Kembalikan reply | handoff
```

Langkah 1 dijalankan sebelum model karena beberapa pemicu tidak boleh
menyentuh LLM sama sekali. Untuk isyarat bahaya diri, jangan ada balasan
otomatis apa pun — langsung handoff prioritas tertinggi, dan bot berhenti.

## Pemicu handoff

Keras — langsung oper, model tidak dipanggil:

| Kunci | Pemicu |
|---|---|
| `akun_terkunci` | Akun terkunci, diretas, tidak bisa login |
| `refund` | Permintaan pengembalian dana |
| `banding_banned` | Banding atas pemblokiran |
| `pembelian_anak` | Pembelian oleh anak di bawah umur |
| `hukum_media` | Ancaman hukum atau menyebut media |
| `bahaya_diri` | Isyarat menyakiti diri sendiri |

Lunak — model boleh mencoba dulu, oper kalau terpenuhi:

| Kunci | Pemicu |
|---|---|
| `gagal_paham` | Dua kali gagal memahami maksud pemain |
| `frustrasi` | Nada marah, kata kasar, huruf kapital beruntun |
| `minta_manusia` | Pemain minta bicara dengan orang |
| `nilai_besar` | Nominal di atas ambang pasar |
| `keyakinan_rendah` | `confidence < 0.75` |

Semua frasa pemicu diambil dari tabel `guardrail_phrases` per locale.
Jangan hardcode di kode. Daftar bahasa Indonesia tidak akan menangkap
pemain Vietnam yang menulis "gặp người thật".

## Filter output

Empat aturan, semuanya terkunci — tidak bisa dimatikan lewat UI, hanya lewat deploy.

1. **Larang janji refund dan unban.** Jawaban yang mengandung frasa dari
   `rule_key = 'no_promise'` untuk locale itu dibuang, ganti handoff.
2. **Larang sebut data akun** sebelum pemain terverifikasi lewat sesi login.
   Verifikasi berasal dari token sesi, bukan dari klaim di dalam chat.
3. **Wajib ada sumber internal.** Jawaban tanpa `meta.sources` dibuang.
   Bot menjawab hanya dari knowledge base yang di-approve, bukan dari
   pengetahuan umum model.
4. **Ambang keyakinan 0.75.** Di bawah itu, handoff.

## Tool

Bot tidak diberi akses database. Hanya fungsi terdaftar berikut.

```json
[
  { "name": "get_transaction",
    "params": { "order_id": "string" },
    "access": "read",
    "note": "uid diambil dari sesi, TIDAK dari argumen model" },

  { "name": "get_account_status",
    "params": {},
    "access": "read",
    "note": "hanya status aktif; jangan kembalikan email atau data pribadi" },

  { "name": "get_event_claim",
    "params": { "event_id": "string" },
    "access": "read" },

  { "name": "get_server_status",
    "params": { "server": "string" },
    "access": "read" },

  { "name": "create_ticket",
    "params": { "category": "string", "subcategory": "string", "summary": "string" },
    "access": "write" },

  { "name": "request_handoff",
    "params": { "reason": "string", "bot_summary": "string" },
    "access": "write" },

  { "name": "grant_compensation",
    "params": { "item_code": "string", "qty": "integer" },
    "access": "write",
    "note": "MATIKAN di fase awal. Lihat syarat di bawah." }
]
```

### Aturan pengisian argumen

`player_uid` tidak pernah menjadi parameter model. Orchestrator menyuntikkannya
dari sesi terverifikasi saat memanggil API game. Ini pertahanan utama terhadap
prompt injection: pemain yang menulis "cek UID 99999999 punya teman saya"
tidak akan pernah bisa membuat bot membaca akun orang lain.

Prinsip yang sama berlaku untuk nominal. Angka yang disebut pemain di chat
tidak pernah masuk langsung ke argumen tool.

### Syarat sebelum `grant_compensation` boleh menyala

Semua harus terpenuhi, tidak sebagian:

- Whitelist `item_code`, tidak boleh sembarang item
- Batas nilai per pemain per hari
- `idempotency_key` wajib, unik di tabel `tool_calls`
- Log setiap panggilan dengan `conversation_id` dan argumen penuh
- Alarm otomatis kalau frekuensi melonjak di atas baseline

Kalau ragu, biarkan mati dan pakai `create_ticket`. Bot yang bisa memberi item
adalah target menarik untuk dieksploitasi.

## System prompt (kerangka)

```
Kamu Gaga Assist, asisten support untuk Gaga Games.

BAHASA
Balas dalam {locale}. Kalau pemain mencampur bahasa, ikuti bahasa dominannya
dan jangan pernah mengomentari atau membetulkan cara mereka menulis.
Campur bahasa adalah hal normal, bukan kesalahan.

SUMBER
Jawab hanya dari dokumen yang diberikan. Kalau tidak ada dokumen pendukung,
panggil request_handoff. Jangan menebak, jangan memakai pengetahuan umum.

LARANGAN
Jangan pernah menjanjikan refund, unban, atau kompensasi.
Jangan menyebut data akun apa pun yang tidak ada di konteks sesi.
Jangan menyebut UID atau data pemain lain.

BATAS
Dua kali gagal memahami maksud pemain, panggil request_handoff.
Kalau pemain minta bicara dengan manusia, panggil request_handoff segera
tanpa menawar.

NADA
{tone_guide untuk locale ini, lihat 05-lokalisasi.md}
```

`tone_guide` disuntik per locale, bukan satu paragraf untuk semua bahasa.
Register yang salah membuat jawaban yang benar terasa dingin, dan itu
penyebab CSAT turun yang tidak akan tertangkap metrik otomatis.
