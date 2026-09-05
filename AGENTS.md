# AGENTS.md

Instruksi kerja untuk agent di repo ini. Baca sampai habis sebelum melakukan apa pun.

## Konteks

Sistem AI bot untuk live chat Gaga Games. Spesifikasi lengkap ada di folder `spec/`.
Telusuri repo, baca `README.md` dan semua file di `spec/` sampai habis dulu.
Kalau folder `spec/` tidak ketemu, berhenti dan bilang. Jangan mengarang isinya.

## Cara kerja

Bertahap. Setiap tahap berhenti dan tunggu persetujuan sebelum lanjut.
Jangan pernah mengerjakan dua task sekaligus.

### Tahap 0 — Orientasi

Jangan tulis kode. Laporkan:

- Ringkasan arsitektur, maksimal 10 kalimat
- Prinsip yang tidak boleh dilanggar, beserta alasan tiap prinsip ada
- Daftar hal yang ambigu atau bertentangan di dalam spec

Kalau ringkasan tidak menyebut bahwa bot tidak pernah menulis langsung ke widget,
berarti salah baca — ulangi dari awal. Berhenti, tunggu jawaban.

### Tahap 1 — Tumpukan teknologi

Jangan tulis kode aplikasi. Usulkan stack untuk gateway, orchestrator, widget,
dan panel agent. Batasan: Postgres, WebSocket, orchestrator stateless dan bisa
di-scale terpisah dari gateway. Beri 2 opsi per komponen plus satu rekomendasi.

Setelah dipilih, tulis `spec/00-stack.md` berisi keputusan itu dan struktur
folder yang disarankan. Berhenti, tunggu jawaban.

### Tahap 2 — Task berurutan

Ambil daftar task dari `spec/06-tasks.md`, kerjakan sesuai urutan. Per task:

1. Sebutkan nomor task, cakupan, dan daftar file yang akan dibuat atau diubah.
   Berhenti, tunggu persetujuan.
2. Setelah disetujui, tulis kode dan tes. Setiap kriteria terima harus punya
   tes yang benar-benar mengujinya.
3. Laporkan dengan format di bawah. Berhenti, tunggu persetujuan sebelum
   pindah ke task berikutnya.

## Aturan sepanjang pekerjaan

**Berhenti dan tanya kalau ada keputusan yang tidak tertulis di spec.**
Jangan diasumsikan. Terutama tiga area ini: pengisian argumen tool, urutan
filter output di orchestrator, dan transisi status sesi. Kesalahan di sana
menghasilkan kode yang lolos tes tapi berbahaya di produksi.

**Jangan sentuh file di luar cakupan task yang sedang dikerjakan.**
Kalau merasa perlu, minta izin dulu dan jelaskan kenapa.

**Empat hal ini tidak boleh tergerus dalam implementasi apa pun:**

- Bot tidak pernah menulis langsung ke widget, semua lewat gateway
- Sekali sesi masuk `agent_active`, bot berhenti permanen untuk sesi itu
- Argumen tool diisi dari data sesi terverifikasi, bukan dari angka atau ID
  yang disebut pemain di dalam chat
- Pagar pengaman dan pemicu handoff wajib lengkap per bahasa sebelum bahasa
  itu boleh aktif

Kalau sebuah task memaksa melanggar salah satunya, berhenti dan bilang.

**Dua hal yang tidak boleh diisi sendiri, hanya boleh dibuatkan jalurnya:**

- Frasa pagar pengaman per bahasa. Harus datang dari penutur asli.
- Nomor bantuan krisis per negara. Jangan pernah menghasilkan nomor dari
  pengetahuan model. Ambil dari dokumen KB. Kalau dokumennya belum ada untuk
  suatu locale, sistem harus menolak mengaktifkan locale itu saat startup.

Untuk keduanya, buat perkakas impor dan validasi, lalu beri tahu data apa yang
harus disediakan.

**Tool `grant_compensation` jangan diimplementasikan** sampai ada perintah
eksplisit. Kalau spec menyebutnya, lewati dan catat di laporan.

**Berhenti total setelah TASK-08 selesai** dan sampaikan bahwa fase bayangan
perlu berjalan beberapa minggu sebelum lanjut. Jangan otomatis lanjut ke
auto-reply.

## Format laporan tiap task

- Task apa, selesai atau belum
- File yang dibuat atau diubah
- Kriteria terima satu per satu, lolos atau tidak, beserta nama tesnya
- Keputusan yang diambil sendiri karena tidak ada di spec, kalau ada
- Apa yang sengaja tidak dikerjakan dan kenapa

Kalau ada kriteria yang tidak lolos, katakan tidak lolos. Jangan dibungkus.

## Mulai

Kerjakan Tahap 0 sekarang.
