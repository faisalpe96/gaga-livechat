# 01 — Arsitektur

## Komponen

| Komponen | Tanggung jawab | Tidak boleh |
|---|---|---|
| Widget chat | UI di situs, kirim pesan lewat WebSocket, bawa konteks sesi | Memanggil model bahasa langsung |
| Chat gateway | Terima pesan, simpan ke DB, siarkan ke panel agent, atur status sesi | Menyusun jawaban |
| AI orchestrator | Klasifikasi intent, ambil dokumen, panggil tool, susun jawaban, filter output | Menulis ke widget langsung |
| Knowledge base | Dokumen FAQ, kebijakan, template balasan, terindeks per locale | — |
| API game | Data transaksi, akun, klaim event | Diakses bot di luar daftar tool |
| Panel agent | Antrean, percakapan, field tiket, ambil alih | — |

Orchestrator adalah satu-satunya komponen yang bicara ke model bahasa.
Gateway tidak tahu apa-apa soal LLM; dari sudut pandangnya, bot hanyalah
peserta percakapan dengan `sender_type: "bot"`.

## Alur satu pesan

```
pemain ketik
  -> widget: kirim event message lewat WebSocket
  -> gateway: simpan ke tabel messages
  -> gateway: siarkan ke panel agent (supervisor bisa memantau meski bot yang jawab)
  -> gateway: cek conversations.status
       status = agent_active   -> berhenti di sini, bot tidak dipanggil
       status = handoff_queued -> berhenti di sini
       status = bot_active     -> lanjut
  -> gateway: POST /orchestrate ke orchestrator
  -> orchestrator: pipeline (lihat 04-orchestrator.md)
       hasil = jawaban  -> balikkan ke gateway sebagai pesan sender_type=bot
       hasil = handoff  -> ubah status jadi handoff_queued, tulis ke tabel handoffs
  -> gateway: simpan dan siarkan ke widget + panel agent
```

Gateway memutuskan bot dipanggil atau tidak berdasarkan kolom `status`, bukan
berdasarkan isi percakapan. Ini disengaja: satu sumber kebenaran, mudah diaudit,
dan tidak mungkin bot "menyelinap masuk" saat agent sedang memegang chat.

## Status sesi

```
bot_active -> handoff_queued -> agent_active -> resolved
bot_active -> resolved                          (bot selesai sendiri)
handoff_queued -> resolved                      (pemain pergi / timeout)
```

Transisi `agent_active -> bot_active` **tidak ada** dalam alur otomatis.
Kalau perlu, sediakan aksi manual di panel yang mencatat `actor_id` di audit log.

| Status | Siapa yang boleh membalas |
|---|---|
| `bot_active` | Bot, dan agent kalau menyela manual |
| `handoff_queued` | Tidak ada. Kirim pesan sistem "sedang menghubungkan" |
| `agent_active` | Agent saja |
| `resolved` | Tidak ada. Pesan baru membuka sesi baru |

## Timeout

| Kondisi | Aksi |
|---|---|
| Pemain diam 10 menit saat `bot_active` | Kirim penutup, ubah ke `resolved`, kirim CSAT |
| Pemain diam 15 menit saat `agent_active` | Beri tahu agent, jangan tutup otomatis |
| `handoff_queued` lewat SLA antre pasar itu | Tawarkan tiket asinkron. Urutan lengkap di bagian "Penutupan sesi dan tiket asinkron" di bawah |

## Penutupan sesi dan tiket asinkron

Bagian ini menutup pertanyaan: setelah tiket asinkron ditawarkan pada sesi
`handoff_queued` yang melewati SLA antre, statusnya jadi apa.

Jawabannya: sesi selalu berakhir di `resolved`, tidak pernah menggantung.
Tapi `resolved` di sini berarti **sesi chat ditutup**, bukan masalah pemain
selesai. Tiketnya tetap terbuka dan punya SLA sendiri.

Karena itu tambahkan dua kolom:

```sql
ALTER TABLE conversations
  ADD COLUMN resolution_reason text,
  ADD COLUMN ticket_id         text;
```

`resolution_reason` wajib diisi setiap kali status berubah ke `resolved`.
Nilai yang sah: `bot_resolved`, `agent_resolved`, `ticket_created`,
`ticket_auto_created`, `player_abandoned`.

### Urutan saat SLA antre terlampaui

1. Bot mengirim tawaran tiket. Status **tetap** `handoff_queued`.
   Agent yang tiba-tiba tersedia masih boleh mengambil sesi ini.
2. Mulai jendela tunggu 3 menit sejak tawaran dikirim.
3. Salah satu dari empat ini terjadi:

| Kejadian | Aksi | Status akhir | `resolution_reason` |
|---|---|---|---|
| Pemain menerima tawaran | `create_ticket`, kirim nomor tiket | `resolved` | `ticket_created` |
| Pemain diam sampai jendela habis | Buat tiket otomatis, kirim nomornya | `resolved` | `ticket_auto_created` |
| Pemain minta tetap menunggu | Perpanjang antre sekali, maksimal satu kali | `handoff_queued` | — |
| Agent mengklaim duluan | Batalkan jendela tunggu | `agent_active` | — |

Perpanjangan hanya boleh sekali. Setelah itu tiket dibuat otomatis meski
pemain masih ingin menunggu. Menunggu tanpa ujung lebih merusak daripada
dijawab besok.

### Aturan balapan

Selama status masih `handoff_queued`, klaim agent selalu menang. Kalau tiket
sudah terlanjur dibuat, tautkan `ticket_id` ke percakapan dan lanjutkan di
`agent_active` — jangan buat percakapan baru.

Setelah status `resolved`, klaim agent ditolak. Tindak lanjutnya lewat tiket,
bukan lewat sesi chat lama.

### CSAT

Jangan kirim survei CSAT untuk sesi yang ditutup dengan `ticket_created` atau
`ticket_auto_created`. Pemain belum mendapat jawaban; menanyakan kepuasan di
titik itu hanya memancing skor buruk yang tidak informatif.

CSAT untuk kasus ini dikirim setelah tiketnya dibalas dan ditutup.

## Batasan teknis

- Orchestrator harus stateless. Seluruh konteks dikirim gateway di tiap panggilan.
- Riwayat yang dikirim ke model dibatasi 20 pesan terakhir atau 4000 token,
  mana yang lebih dulu tercapai.
- Timeout panggilan orchestrator 12 detik. Lewat itu, gateway mengirim pesan
  sistem dan mengubah status ke `handoff_queued`. Jangan biarkan pemain
  menatap indikator mengetik tanpa akhir.
- Semua panggilan tool ke API game punya timeout 3 detik dan tidak diulang
  lebih dari sekali.
