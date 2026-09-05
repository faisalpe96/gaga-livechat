# Gaga Games — AI bot untuk live chat

Spesifikasi teknis untuk memasang AI agent ke fitur live chat di situs Gaga Games.
Kanal: **hanya live chat website**. Bukan WhatsApp, bukan aplikasi pihak ketiga.

Pasar yang didukung: Thailand, Philippines, Indonesia, Malaysia, Vietnam, Singapore.

## Cara pakai file ini di Antigravity

Jangan suapkan semua file sekaligus. Urutannya:

1. Buka sesi baru, lampirkan `spec/01-arsitektur.md` sebagai konteks.
   Minta agent membaca dan meringkas dulu sebelum menulis kode. Kalau ringkasannya
   meleset, perbaiki spec-nya — jangan lanjut.
2. Kerjakan task satu per satu dari `spec/06-tasks.md`. Satu task = satu sesi.
   Lampirkan hanya file spec yang disebut di task itu.
3. Setiap task selesai, jalankan kriteria terima yang tertulis di task tersebut
   sebelum lanjut ke berikutnya.

Perintah pembuka yang disarankan untuk tiap sesi:

```
Baca spec/01-arsitektur.md dan spec/0X-....md.
Kerjakan hanya TASK-XX. Jangan sentuh file di luar daftar berkas task itu.
Kalau ada keputusan yang tidak tertulis di spec, berhenti dan tanya —
jangan diasumsikan sendiri.
```

Kalimat terakhir itu penting. Bagian paling berisiko dari sistem ini adalah
pagar pengaman dan tool yang bisa menulis data; agent yang menebak sendiri di
area itu bisa menghasilkan kode yang lolos tes tapi berbahaya di produksi.

## Isi folder spec

| File | Isi |
|---|---|
| `01-arsitektur.md` | Komponen, alur pesan, status sesi |
| `02-kontrak-api.md` | Event WebSocket, endpoint REST, bentuk pesan |
| `03-skema-database.md` | DDL Postgres |
| `04-orchestrator.md` | Pipeline bot, pagar pengaman, definisi tool |
| `05-lokalisasi.md` | Konfigurasi 6 pasar, resolusi bahasa, jam kerja |
| `06-tasks.md` | Pecahan task berurutan |

## Prinsip yang tidak boleh dilanggar

Empat hal ini menentukan sistemnya aman atau tidak. Kalau salah satu tergerus
saat implementasi, hentikan dan perbaiki sebelum lanjut.

1. **Bot tidak pernah menulis langsung ke widget.** Semua balasan lewat gateway,
   sehingga riwayat percakapan tunggal dan panel agent selalu sinkron.
2. **Sekali sesi masuk `agent_active`, bot berhenti permanen** untuk sesi itu.
   Mengembalikan ke bot harus tindakan eksplisit dari panel.
3. **Parameter tool diisi dari data sesi terverifikasi, bukan dari angka yang
   disebut pemain di dalam chat.** Ini pertahanan utama terhadap prompt injection.
4. **Pagar pengaman dan pemicu handoff wajib lengkap per bahasa** sebelum bahasa
   itu boleh diaktifkan di produksi.

## Yang belum ditentukan

Isi berikut masih perlu data dari sisi Anda dan sengaja dibiarkan kosong di spec:

- Volume chat per negara dan lima kategori keluhan teratas per negara
- Distribusi jam sibuk per negara dalam waktu setempat
- Kapasitas agent saat ini dipecah per bahasa
- Daftar endpoint API game yang tersedia sekarang

Selama data ini belum ada, jalankan sampai TASK-08 saja (mode bayangan).
Auto-reply jangan dinyalakan.
