# 07 — Mode luar jam kerja

Berlaku untuk jam malam dan akhir pekan, saat agent manusia tidak tersedia
dan AI menjadi satu-satunya yang menjawab.

## Prinsip

Mode luar jam bukan bot yang sama tanpa agent. Tiga hal berubah:

1. Bot mengatakan sejak awal bahwa tim sedang tidak bertugas, dan memberi
   perkiraan waktu balasan yang nyata — bukan menggantung pemain.
2. Handoff tidak menghilang, tapi berubah bentuk menjadi tiket berprioritas
   dengan SLA dihitung dari jam buka berikutnya.
3. Beberapa kategori tetap butuh manusia meski jam tiga pagi. Untuk itu ada
   jalur siaga, bukan tiket biasa.

Ingat bahwa malam dan akhir pekan adalah puncak trafik game, bukan jam sepi.
Mode ini menangani volume terbesar, jadi containment dan CSAT di sini justru
lebih menentukan daripada di jam kerja.

## Perubahan skema

```sql
ALTER TABLE markets
  ADD COLUMN weekend_days      int[] NOT NULL DEFAULT '{6,7}',
  ADD COLUMN oncall_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN oncall_channel    text;

ALTER TABLE conversations
  ADD COLUMN service_mode      text NOT NULL DEFAULT 'business_hours',
  ADD COLUMN sla_paused_at     timestamptz;

CREATE TABLE oncall_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  reason          text NOT NULL,
  market          text NOT NULL,
  raised_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES agents(id)
);
```

`service_mode` berisi `business_hours` atau `after_hours`, ditetapkan saat sesi
dibuka dan tidak berubah di tengah sesi. Kalau pemain mulai chat pukul 21.55 dan
jam kerja berakhir 22.00, sesi itu tetap `business_hours` sampai selesai.

`weekend_days` memakai ISO (1 = Senin, 7 = Minggu). Default Sabtu-Minggu.
Untuk Malaysia, beberapa negara bagian memakai Jumat-Sabtu — kalau Anda
membedakan per negara bagian, ini kolomnya. Kalau tidak, biarkan default.

## Jadwal per pasar

Semua dihitung menurut `markets.timezone`, bukan zona waktu kantor.
Isi kolom `hours_start` dan `hours_end` sesuai kapasitas agent Anda; angka di
bawah hanya titik awal yang wajar.

| Pasar | Zona | Usulan jam kerja | Mode AI |
|---|---|---|---|
| `ID` | +7 | 09.00–22.00 | 22.00–09.00 dan akhir pekan |
| `TH` | +7 | 09.00–22.00 | sama |
| `VN` | +7 | 09.00–22.00 | sama |
| `PH` | +8 | 09.00–22.00 | sama |
| `MY` | +8 | 09.00–22.00 | sama |
| `SG` | +8 | 09.00–22.00 | sama |

Karena keenam pasar hanya terpaut satu jam, satu shift agent yang panjang bisa
menutup semuanya. Ini keuntungan besar dibanding operasi global — manfaatkan.

## Perilaku bot mode luar jam

Pembuka wajib, dikirim sebelum pertanyaan pertama dijawab, dalam bahasa pemain:

> Tim support kami sedang tidak bertugas dan akan kembali {jam_buka} waktu
> {kota}. Saya bisa bantu sekarang untuk banyak hal — kalau butuh tim, saya
> buatkan tiket dan mereka balas begitu buka.

Jangan sembunyikan status ini di akhir percakapan. Pemain yang tahu sejak awal
akan menyesuaikan harapan; yang baru tahu setelah lima menit merasa dibohongi.

Saat bot tidak bisa menyelesaikan:

- Panggil `create_ticket`, bukan `request_handoff`
- Berikan nomor tiket dan perkiraan jam balasan dalam bahasa pemain
- Set `sla_due_at` dari jam buka berikutnya pasar itu, bukan dari waktu sekarang
- Tutup sesi dengan jujur, jangan biarkan pemain menunggu indikator mengetik

## Kategori keras di luar jam

Pemicu keras di `04-orchestrator.md` tetap berlaku, tapi aksinya berbeda karena
tidak ada agent yang bisa menerima.

| Kunci | Aksi luar jam |
|---|---|
| `bahaya_diri` | Tampilkan sumber bantuan sesuai negara pemain **segera**, bot berhenti menjawab, naikkan `oncall_alerts` |
| `akun_terkunci` | Tawarkan pembekuan akun mandiri, lalu tiket prioritas tertinggi |
| `refund` | Tiket prioritas tinggi, jangan bahas kelayakan sama sekali |
| `banding_banned` | Tiket biasa, tidak mendesak |
| `pembelian_anak` | Tiket prioritas tinggi |
| `hukum_media` | Tiket prioritas tertinggi, naikkan `oncall_alerts` |

Dua yang wajib menembus jam tidur: `bahaya_diri` dan `hukum_media`.
Sisanya boleh menunggu pagi.

### Isyarat bahaya diri

Ini satu-satunya kasus di mana tiket tidak cukup. Bot menampilkan nomor bantuan
sesuai negara pemain, berhenti membalas apa pun setelah itu, dan menaikkan
alert. Daftar nomor per negara harus disiapkan dan diverifikasi sebelum mode
luar jam dinyalakan — bukan diambil model dari pengetahuannya sendiri, karena
nomor bantuan berubah dan salah nomor lebih buruk daripada tidak ada.

Simpan sebagai dokumen KB `is_policy = true` per locale, dan tinjau ulang
setiap enam bulan.

### Akun terkunci

Ini kategori paling merugikan kalau menunggu semalam, karena akun yang diambil
alih orang lain bisa dikuras dalam hitungan jam.

Solusinya bukan membangunkan agent, melainkan memberi pemain aksi mandiri:
tombol bekukan akun yang bisa dijalankan bot lewat tool `freeze_account(uid)`
dengan UID dari sesi terverifikasi. Pembekuan bersifat sementara, reversibel,
dan tidak menghapus apa pun — jadi risikonya rendah meski dipicu keliru.

Tambahkan ke daftar tool di `04-orchestrator.md` dengan aturan yang sama:
UID dari sesi, tidak pernah dari argumen model.

## Jalur siaga

Satu orang per malam, bergilir, bukan tim penuh. Yang dia terima hanya
`oncall_alerts` — dua kategori saja, jadi realistis untuk dijaga lewat notifikasi
telepon tanpa harus terjaga sepanjang malam.

Isi `markets.oncall_channel` dengan tujuan notifikasi. Catat
`acknowledged_at` supaya Anda tahu berapa lama alert menggantung, dan tinjau
angka itu bulanan.

Kalau jalur siaga belum ada, `bahaya_diri` tetap harus menampilkan sumber
bantuan. Bagian itu tidak boleh ditunda menunggu proses siaga siap.

## SLA

Jam SLA berhenti di luar jam kerja dan berjalan lagi saat buka. Tanpa ini,
tiket yang masuk Jumat malam akan terlihat melanggar SLA sebelum ada yang
sempat membukanya Senin pagi, dan dasbor Anda jadi tidak berarti.

Simpan `sla_paused_at` saat sesi masuk mode luar jam, hitung ulang saat buka.

## Metrik

Pecah semua metrik menjadi dua mode, di samping pemecahan per locale.
Jadi setiap angka punya dua sumbu: locale dan `service_mode`.

Yang perlu diawasi khusus di mode luar jam:

- Rasio tiket dibanding percakapan. Kalau tinggi, artinya bot lebih banyak
  menampung daripada menyelesaikan
- Waktu tiket luar jam sampai dibalas di pagi harinya
- CSAT luar jam dibandingkan CSAT jam kerja. Selisih kecil itu wajar; selisih
  besar berarti pembukaan jujurnya belum bekerja
- Frekuensi `oncall_alerts` dan waktu akuinya

## Urutan peluncuran

Nyalakan mode luar jam **lebih dulu** daripada auto-reply di jam kerja.

Alasannya sederhana: di jam kerja, pembanding bot adalah agent manusia, dan bot
harus lebih baik daripada tidak ada gunanya. Di luar jam, pembandingnya adalah
tidak ada jawaban sama sekali. Ambang "cukup baik" jauh lebih rendah, risikonya
lebih kecil, dan Anda tetap mendapat data nyata.

Urutan yang disarankan, menggantikan TASK-09 di `06-tasks.md`:

1. Mode bayangan di jam kerja (TASK-08) — kumpulkan akurasi
2. Auto-reply mode luar jam untuk satu pasar, intent aman saja
3. Perluas ke enam pasar di mode luar jam
4. Baru auto-reply di jam kerja

## Prasyarat sebelum mode luar jam dinyalakan

- Daftar nomor bantuan per negara sudah diverifikasi dan masuk KB
- `guardrail_phrases` untuk `bahaya_diri` lengkap di keenam locale
- Tool `freeze_account` sudah diuji dan reversibel
- Jalur siaga sudah ditentukan orangnya dan kanalnya
- Pembuka mode luar jam sudah diterjemahkan dan ditinjau penutur asli
- Perhitungan jeda SLA sudah benar untuk keenam zona waktu
