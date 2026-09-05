# 02 — Kontrak API

## Event WebSocket

Endpoint: `wss://chat.gagagames.example/v1/socket`
Autentikasi: token sesi game yang sudah ada. Jangan bikin login terpisah.

### Dari widget ke gateway

`session_start` — dikirim sekali saat widget dibuka.

```json
{
  "event": "session_start",
  "player": {
    "uid": "77124490",
    "nickname": "RyuHunter",
    "server": "SEA-3",
    "level": 48,
    "vip_tier": 4
  },
  "context": {
    "page": "/topup",
    "platform": "android",
    "app_version": "3.8.2",
    "locale": "th-TH",
    "market": "TH",
    "client_tz": "Asia/Bangkok"
  }
}
```

`locale` dan `market` wajib. Kalau client tidak mengirimnya, gateway
menjalankan resolusi bahasa di `05-lokalisasi.md` dan menyimpan hasilnya.

`message` — pesan pemain.

```json
{ "event": "message", "conversation_id": "cnv_8f21", "text": "..." }
```

`set_locale` — pemain mengganti bahasa dari dalam chat.

```json
{ "event": "set_locale", "conversation_id": "cnv_8f21", "locale": "en" }
```

### Dari gateway ke widget

`message` — pesan dari bot atau agent. Bentuknya sama untuk keduanya.

```json
{
  "event": "message",
  "conversation_id": "cnv_8f21",
  "message_id": "msg_00194",
  "sender_type": "bot",
  "sender_name": "Gaga Assist",
  "text": "...",
  "created_at": "2026-09-05T09:14:22+07:00",
  "translated": false
}
```

`translated: true` dipakai saat balasan agent diterjemahkan mesin. Widget wajib
menampilkan penanda visual untuk kasus ini — pemain lebih memaafkan terjemahan
kaku kalau tahu itu terjemahan.

`status_change`, `typing`, `session_closed` mengikuti pola yang sama dengan
`conversation_id` sebagai kunci.

## Bentuk pesan tersimpan

Satu bentuk untuk semua pengirim. Bot dan agent hanya beda di `sender_type`.

```json
{
  "conversation_id": "cnv_8f21",
  "message_id": "msg_00194",
  "sender_type": "player | bot | agent | system",
  "sender_id": "uid_77124490",
  "text": "...",
  "created_at": "2026-09-05T09:14:22+07:00",
  "meta": {
    "intent": "topup_belum_masuk",
    "confidence": 0.88,
    "sources": ["FAQ-118"],
    "tools_used": ["get_transaction"],
    "locale_out": "th-TH",
    "guardrail_flags": []
  }
}
```

`meta` hanya diisi bot, tidak pernah dikirim ke widget, dan tidak pernah
ditampilkan ke pemain. Gunanya untuk panel agent dan audit: saat bot salah
jawab, Anda perlu tahu dokumen mana yang dipakai dan seberapa yakin ia saat itu.

## REST: orchestrator

`POST /v1/orchestrate` — dipanggil gateway, bukan widget.

Request:

```json
{
  "conversation_id": "cnv_8f21",
  "locale": "th-TH",
  "market": "TH",
  "player": { "uid": "77124490", "server": "SEA-3", "level": 48, "vip_tier": 4 },
  "page_context": { "page": "/topup", "platform": "android" },
  "history": [
    { "sender_type": "player", "text": "..." },
    { "sender_type": "bot", "text": "..." }
  ]
}
```

Response — salah satu dari dua bentuk:

```json
{ "action": "reply", "text": "...", "meta": { "...": "..." } }
```

```json
{
  "action": "handoff",
  "reason": "akun_terkunci",
  "bot_summary": "Pemain melaporkan akun terkunci setelah ganti perangkat. UID sudah terverifikasi dari sesi. Belum ada tool yang dipanggil.",
  "meta": { "...": "..." }
}
```

Tidak ada bentuk ketiga. Orchestrator yang bingung wajib mengembalikan `handoff`,
bukan `reply` dengan teks minta maaf.

`bot_summary` ditulis dalam bahasa kerja agent (default `en`), bukan bahasa
pemain, karena yang membacanya agent.

## REST: panel agent

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/v1/queue?locale=th-TH` | Antrean per bahasa |
| `POST` | `/v1/conversations/{id}/claim` | Agent ambil alih, status jadi `agent_active` |
| `POST` | `/v1/conversations/{id}/messages` | Agent kirim balasan |
| `POST` | `/v1/conversations/{id}/resolve` | Tutup, kirim CSAT |
| `POST` | `/v1/messages/{id}/feedback` | Nilai draft bot, isi tabel `bot_feedback` |

Endpoint `feedback` yang paling sering dilupakan padahal paling bernilai.
Setiap kali agent mengedit atau menolak draft bot, catat versi sebelum dan
sesudahnya. Itu bahan perbaikan Anda, dan gratis.
