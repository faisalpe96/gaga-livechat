# 06 — Task

Satu task = satu sesi Antigravity. Lampirkan hanya spec yang disebut.
Jangan lompat; tiap task bergantung pada yang sebelumnya.

---

## Fase 1 — Live chat manusia dulu

Bot belum ada sama sekali. Live chat manusia harus jalan stabil lebih dulu,
karena semua jalur handoff bergantung padanya.

### TASK-01 — Skema database

Spec: `03-skema-database.md`
Buat migrasi dari DDL. Seed tabel `markets` dengan enam baris dari
`05-lokalisasi.md`, semua `is_bot_enabled = false`.

Terima: migrasi jalan bersih, rollback jalan, enam pasar ter-seed.

### TASK-02 — Chat gateway

Spec: `01-arsitektur.md`, `02-kontrak-api.md`
Server WebSocket, autentikasi pakai token sesi game yang sudah ada.
Simpan pesan, siarkan, kelola transisi status. Belum panggil orchestrator.

Terima: dua klien di satu `conversation_id` saling menerima pesan; transisi
status mengikuti tabel di spec; `agent_active -> bot_active` ditolak.

### TASK-03 — Widget chat

Spec: `02-kontrak-api.md`, `05-lokalisasi.md`
Widget di situs, kirim `session_start` dengan locale dan konteks halaman.
Pemilih bahasa dengan enam opsi. Sambung ulang otomatis kalau koneksi putus.

Terima: locale tampil benar untuk keenam pasar; `set_locale` mengubah bahasa UI
dan tersimpan; riwayat tetap utuh setelah refresh.

### TASK-04 — Panel agent

Spec: `01-arsitektur.md`, `02-kontrak-api.md`
Antrean per locale, ambil alih, balas, tutup. Urut berdasarkan sisa SLA,
bukan waktu masuk.

Terima: agent hanya melihat antrean sesuai `agents.locales`; klaim mengunci
percakapan dari agent lain.

---

## Fase 2 — Bot dalam mode bayangan

Orchestrator dipanggil, jawabannya disimpan sebagai draft, tidak pernah
keluar ke pemain.

### TASK-05 — Knowledge base dan indeks

Spec: `03-skema-database.md`, `05-lokalisasi.md`
Impor FAQ dan Bank Canned Response, indeks embedding difilter per locale.
Dokumen kebijakan (`is_policy = true`) hanya boleh diambil dalam locale
yang sama persis — tidak boleh lintas bahasa.

Terima: pencarian `th-TH` tidak pernah mengembalikan dokumen kebijakan
berbahasa lain; dokumen non-kebijakan boleh lintas bahasa.

### TASK-06 — Orchestrator

Spec: `04-orchestrator.md`, `05-lokalisasi.md`
Pipeline tujuh langkah. Tool baca saja; semua tool tulis dimatikan
kecuali `create_ticket` dan `request_handoff`.

Terima: pemicu keras memicu handoff tanpa memanggil model; jawaban tanpa
`meta.sources` dibuang; `confidence < 0.75` jadi handoff; `player_uid` tidak
pernah bisa diisi dari argumen model.

### TASK-07 — Pagar pengaman per bahasa

Spec: `04-orchestrator.md`, `05-lokalisasi.md`
Isi `guardrail_phrases` untuk keenam locale. Ditulis penutur asli.
Uji dengan kalimat pancingan di tiap bahasa.

Terima: pemicu `minta_manusia` tertangkap di keenam bahasa; pemicu
`bahaya_diri` tertangkap di keenam bahasa dan tidak pernah memanggil model.

### TASK-08 — Mode bayangan

Spec: `02-kontrak-api.md`
Draft bot tampil di panel agent, agent memilih pakai atau tidak.
Endpoint feedback mengisi `bot_feedback`.

Terima: draft tidak pernah sampai ke widget; setiap draft yang diedit
tersimpan versi sebelum dan sesudah.

**Berhenti di sini selama dua sampai empat minggu.** Kumpulkan angka akurasi
per intent per locale. Jangan lanjut sebelum ada datanya.

---

## Fase 3 — Auto-reply bertahap

### TASK-09 — Aktifkan auto-reply terbatas

Prasyarat: data dari TASK-08 tersedia.
Nyalakan auto-reply hanya untuk intent yang pemakaian draft tanpa editnya
di atas 90%. Biasanya FAQ, status maintenance, cara top-up. Sisanya tetap draft.
Nyalakan per locale lewat `markets.is_bot_enabled`, mulai dari satu pasar.

Terima: intent di luar daftar izin tetap jadi draft; mematikan satu locale
tidak memengaruhi locale lain.

### TASK-10 — Jalur cadangan terjemahan

Spec: `05-lokalisasi.md`
Panel dua lapis, terjemahan balasan agent, penanda di widget.
Catat `fallback_mode` di `handoffs`.

Terima: `original_text` tersimpan; widget menampilkan penanda terjemahan.

### TASK-11 — Konsol AI Studio

Metrik per locale, sumber pengetahuan, pagar pengaman, pemicu handoff,
ruang uji coba. Aturan terkunci ditampilkan tapi tidak bisa dimatikan dari UI.

Terima: mengubah aturan terkunci lewat API ditolak, bukan hanya disembunyikan
di antarmuka.

### TASK-12 — Tool tulis

Prasyarat: TASK-11 selesai dan sudah berjalan stabil.
Aktifkan `grant_compensation` hanya setelah semua syarat di `04-orchestrator.md`
terpenuhi. Kalau ragu, lewati task ini.

Terima: idempotency terbukti — panggilan sama dua kali hanya tereksekusi sekali;
batas harian berfungsi; alarm lonjakan menyala.

---

## Catatan untuk agent

Kalau ada keputusan yang tidak tertulis di spec, berhenti dan tanya.
Area yang paling sering ditebak-tebak dan paling berbahaya kalau salah:
pengisian argumen tool, urutan filter output, dan transisi status sesi.
