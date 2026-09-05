# Prompt untuk Antigravity

Salin per blok. Satu blok = satu sesi. Jangan gabungkan.

Aturan pakai:

- Simpan folder ini di root repo, jadi path `spec/...` bisa dibaca langsung
- Satu task selesai, commit, baru buka sesi baru untuk task berikutnya
- Kalau agent mulai menebak atau melebar ke file lain, hentikan sesinya dan
  mulai ulang dengan prompt yang sama — jangan diluruskan sambil jalan

---

## Sesi 0 — Orientasi

Jangan minta kode di sesi ini. Tujuannya memastikan agent paham sistemnya.

```
Baca README.md dan seluruh isi folder spec/ di repo ini.

Jangan tulis kode apa pun.

Kerjakan tiga hal:
1. Ringkas arsitekturnya dalam maksimal 10 kalimat.
2. Sebutkan 4 prinsip yang tidak boleh dilanggar, beserta alasan tiap
   prinsip ada.
3. Daftar semua hal yang menurutmu ambigu atau bertentangan di dalam spec.

Kalau ringkasanmu di poin 1 tidak menyebut bahwa bot tidak pernah menulis
langsung ke widget, berarti kamu salah baca — ulangi.
```

Kalau poin 3 menghasilkan pertanyaan bagus, perbaiki spec-nya dulu sebelum
lanjut. Ambiguitas yang dibiarkan akan jadi tebakan di sesi berikutnya.

---

## Sesi 0b — Kunci tumpukan teknologi

Spec sengaja tidak menentukan stack. Kunci sekarang supaya semua task konsisten.

```
Baca README.md dan spec/01-arsitektur.md.

Usulkan tumpukan teknologi untuk gateway, orchestrator, widget, dan panel
agent. Batasan: database Postgres, real time pakai WebSocket, orchestrator
harus stateless dan bisa di-scale terpisah dari gateway.

Untuk tiap komponen beri 2 opsi dengan alasan singkat, lalu satu
rekomendasi. Jangan tulis kode.

Setelah aku pilih, tulis hasilnya ke spec/00-stack.md beserta struktur
folder repo yang kamu sarankan.
```

---

## Template per task

Pakai ini untuk task mana pun. Ganti bagian dalam kurung kurawal.

```
Baca spec/00-stack.md dan {file spec yang disebut di task}.

Kerjakan hanya {TASK-XX} dari spec/06-tasks.md.

Batasan:
- Jangan sentuh file di luar cakupan task ini
- Kalau ada keputusan yang tidak tertulis di spec, BERHENTI dan tanya.
  Jangan diasumsikan sendiri. Ini terutama berlaku untuk pengisian argumen
  tool, urutan filter output, dan transisi status sesi.
- Tulis tes untuk setiap kriteria terima yang tertulis di task

Sebelum mulai, sebutkan dulu daftar file yang akan kamu buat atau ubah.
Tunggu aku setuju, baru tulis kode.
```

Kalimat terakhir itu yang paling menghemat waktu. Agent yang menyebut daftar
filenya duluan mudah dihentikan sebelum salah arah.

---

## Prompt per task

### TASK-01 — Skema database

```
Baca spec/00-stack.md dan spec/03-skema-database.md.

Kerjakan TASK-01: buat migrasi dari DDL di spec, plus seed tabel markets
dengan 6 baris (TH, PH, ID, MY, VN, SG) sesuai spec/05-lokalisasi.md.
Semua is_bot_enabled = false.

Kriteria terima: migrasi jalan bersih, rollback jalan, 6 pasar ter-seed
dengan timezone dan currency yang benar.

Sebutkan daftar file dulu sebelum menulis.
```

### TASK-02 — Chat gateway

```
Baca spec/00-stack.md, spec/01-arsitektur.md, spec/02-kontrak-api.md.

Kerjakan TASK-02: server WebSocket dengan autentikasi token sesi game,
simpan pesan, siarkan ke panel, kelola transisi status sesi.
JANGAN panggil orchestrator sama sekali di task ini.

Perhatian khusus: transisi agent_active -> bot_active harus DITOLAK di
level API, bukan cuma disembunyikan di UI.

Kriteria terima yang wajib ada tesnya:
- Dua klien di satu conversation_id saling menerima pesan
- Semua transisi status mengikuti tabel di spec/01
- Transisi terlarang dikembalikan sebagai error

Sebutkan daftar file dulu.
```

### TASK-03 — Widget chat

```
Baca spec/00-stack.md, spec/02-kontrak-api.md, spec/05-lokalisasi.md.

Kerjakan TASK-03: widget live chat di situs. Kirim session_start dengan
locale, market, dan konteks halaman. Pemilih bahasa 6 opsi. Sambung ulang
otomatis saat koneksi putus tanpa kehilangan riwayat.

Ikuti resolusi bahasa berjenjang di spec/05 persis urutannya. Jangan
mendeteksi bahasa dari teks kalau context.locale sudah ada.

Kriteria terima: locale benar untuk 6 pasar, set_locale mengubah bahasa UI
dan tersimpan, riwayat utuh setelah refresh.
```

### TASK-04 — Panel agent

```
Baca spec/00-stack.md, spec/01-arsitektur.md, spec/02-kontrak-api.md.

Kerjakan TASK-04: panel agent dengan antrean per locale, klaim, balas,
tutup. Antrean diurutkan berdasarkan SISA SLA, bukan waktu masuk.

Agent hanya melihat antrean yang cocok dengan agents.locales miliknya.
Klaim mengunci percakapan dari agent lain.

Kriteria terima harus ada tesnya, termasuk kasus dua agent mengklaim
percakapan yang sama bersamaan.
```

### TASK-05 — Knowledge base

```
Baca spec/00-stack.md, spec/03-skema-database.md, spec/05-lokalisasi.md.

Kerjakan TASK-05: impor KB dan canned response, indeks embedding dengan
filter locale.

Aturan yang tidak boleh dilanggar: dokumen dengan is_policy = true HANYA
boleh diambil dalam locale yang sama persis. Dokumen non-kebijakan boleh
lintas bahasa.

Kriteria terima: tes yang membuktikan pencarian th-TH tidak pernah
mengembalikan dokumen kebijakan berbahasa lain.
```

### TASK-06 — Orchestrator

Task paling berisiko. Prompt-nya paling ketat.

```
Baca spec/00-stack.md, spec/04-orchestrator.md, spec/05-lokalisasi.md.

Kerjakan TASK-06: orchestrator dengan pipeline 7 langkah persis seperti
urutan di spec. Tool baca saja. Tool tulis yang aktif hanya create_ticket
dan request_handoff. grant_compensation dan freeze_account TIDAK
diimplementasikan di task ini.

Empat hal yang harus benar dan wajib ada tesnya:
1. Pemicu keras memicu handoff TANPA memanggil model bahasa
2. Jawaban tanpa meta.sources dibuang, diganti handoff
3. confidence < 0.75 jadi handoff
4. player_uid disuntik dari sesi, TIDAK PERNAH bisa diisi dari argumen model

Untuk nomor 4, tulis tes dengan pesan pemain yang berisi "cek UID 99999999
punya teman saya" dan buktikan tool tetap dipanggil dengan UID sesi.

Kalau ada bagian pipeline yang menurutmu ambigu, berhenti dan tanya.
```

### TASK-07 — Pagar pengaman per bahasa

```
Baca spec/04-orchestrator.md dan spec/05-lokalisasi.md.

Kerjakan TASK-07: implementasi pemuatan guardrail_phrases per locale dan
pencocokannya di pipeline.

JANGAN mengisi frasa untuk bahasa yang kamu tidak yakin. Buat seed hanya
untuk locale yang aku sediakan datanya, dan buat perkakas untuk mengimpor
sisanya dari CSV.

Kriteria terima: pemicu minta_manusia dan bahaya_diri tertangkap untuk
setiap locale yang terisi; locale yang belum terisi menghasilkan peringatan
saat startup, bukan diam-diam lolos.
```

Frasanya ditulis penutur asli, bukan diminta ke agent. Agent hanya membuat
jalurnya.

### TASK-08 — Mode bayangan

```
Baca spec/02-kontrak-api.md dan spec/06-tasks.md.

Kerjakan TASK-08: draft bot tampil di panel agent, agent memilih pakai,
edit, atau tolak. Endpoint feedback mengisi tabel bot_feedback dengan
versi sebelum dan sesudah.

Kriteria terima paling penting: buktikan dengan tes bahwa draft TIDAK
PERNAH sampai ke widget dalam kondisi apa pun.

Tambahkan query pelaporan: tingkat pemakaian draft tanpa edit, dipecah
per intent dan per locale.
```

---

## Mode luar jam

Kerjakan setelah TASK-08 berjalan beberapa minggu.

### TASK-09a — Jadwal dan tiket luar jam

```
Baca spec/07-mode-luar-jam.md dan spec/05-lokalisasi.md.

Kerjakan: migrasi kolom baru di markets dan conversations, tabel
oncall_alerts, penentuan service_mode saat sesi dibuka, pembuka mode luar
jam, dan pembuatan tiket dengan sla_due_at dihitung dari jam buka
berikutnya.

Perhatian: service_mode ditetapkan sekali saat sesi dibuka dan TIDAK
berubah di tengah sesi.

Kriteria terima: hitung jeda SLA benar untuk 6 zona waktu, termasuk kasus
tiket masuk Jumat malam dan baru dibuka Senin pagi.
```

### TASK-09b — Jalur kritis luar jam

```
Baca spec/07-mode-luar-jam.md.

Kerjakan: aksi khusus untuk pemicu keras di mode luar jam sesuai tabel di
spec, tool freeze_account, dan penaikan oncall_alerts.

freeze_account: UID dari sesi terverifikasi, bersifat sementara dan
reversibel, wajib tercatat di tool_calls dengan idempotency_key.

Untuk bahaya_diri: nomor bantuan diambil dari dokumen KB is_policy = true
per locale. JANGAN pernah menghasilkan nomor dari pengetahuan model.
Kalau dokumennya belum ada untuk suatu locale, sistem harus menolak
mengaktifkan mode luar jam untuk locale itu saat startup.

Kriteria terima harus mencakup kasus dokumen bantuan tidak tersedia.
```

---

## Prompt verifikasi

Jalankan di sesi terpisah setelah tiap task, sebelum commit.

```
Baca {file spec task itu} dan diff perubahan terakhir.

Jangan perbaiki apa pun. Periksa saja:
1. Apakah setiap kriteria terima punya tes yang benar-benar mengujinya,
   bukan tes yang lolos secara kebetulan?
2. Apakah ada keputusan yang diambil tanpa dasar di spec? Sebutkan barisnya.
3. Apakah ada file di luar cakupan task yang ikut berubah?

Jawab apa adanya. Kalau ada yang meleset, katakan meleset.
```

Sesi verifikasi terpisah lebih jujur daripada meminta agent yang sama menilai
pekerjaannya sendiri di sesi yang sama.

---

## Kalau agent melenceng

```
Berhenti. Kamu keluar dari cakupan {TASK-XX}.

Kembalikan semua perubahan pada file yang tidak disebut di task itu.
Lalu sebutkan ulang daftar file yang boleh kamu sentuh, dan tunggu
persetujuanku.
```
