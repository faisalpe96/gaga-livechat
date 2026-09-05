# 05 — Lokalisasi: enam pasar SEA

## Konfigurasi pasar

| Kode | Negara | Locale utama | Locale didukung | Zona waktu | Mata uang |
|---|---|---|---|---|---|
| `TH` | Thailand | `th-TH` | `th-TH`, `en` | Asia/Bangkok (+7) | THB |
| `PH` | Philippines | `fil-PH` | `fil-PH`, `en` | Asia/Manila (+8) | PHP |
| `ID` | Indonesia | `id-ID` | `id-ID`, `en` | Asia/Jakarta (+7) | IDR |
| `MY` | Malaysia | `ms-MY` | `ms-MY`, `en`, `zh-Hans` | Asia/Kuala_Lumpur (+8) | MYR |
| `VN` | Vietnam | `vi-VN` | `vi-VN`, `en` | Asia/Ho_Chi_Minh (+7) | VND |
| `SG` | Singapore | `en` | `en`, `zh-Hans` | Asia/Singapore (+8) | SGD |

Indonesia punya tiga zona waktu (WIB, WITA, WIT). Pakai `Asia/Jakarta` sebagai
default pasar, tapi hitung SLA dari `client_tz` yang dikirim widget kalau ada.

## Tingkat dukungan

| Tingkat | Locale | Yang didapat |
|---|---|---|
| Penuh | `id-ID`, `th-TH`, `vi-VN`, `en` | KB terlokalisasi, auto-reply, agent native |
| Terbatas | `ms-MY`, `fil-PH` | Auto-reply untuk FAQ, handoff ke agent `en` dengan terjemahan |
| Terbatas | `zh-Hans` | Sama, prioritas terakhir |

Alasannya: `en` sudah menutup Singapore sepenuhnya dan menutup sebagian besar
Philippines dan Malaysia, jadi tiga bahasa penuh lainnya memberi jangkauan
terbesar dengan biaya perawatan terkecil. Menambah bahasa itu mudah;
mencabutnya setelah pemain terbiasa itu sulit.

## Resolusi bahasa

Berjenjang, berhenti di yang pertama terisi:

1. `context.locale` dari game client — paling akurat, mencerminkan pilihan pemain
2. Setting bahasa di profil akun
3. Deteksi dari teks pesan pertama
4. `markets.default_locale` menurut region server

Jangan pernah berhenti di langkah 3 saja. Pemain Filipina yang menulis
"Hi po, my top up hasn't come in" akan terdeteksi sebagai penutur Inggris
padahal ia menulis Taglish, dan bot akan membalas dengan register yang salah.

Sediakan pemilih bahasa di dalam widget. Pilihan pemain lewat `set_locale`
mengalahkan semua langkah di atas dan disimpan ke profil.

## Campur bahasa

Wajib didukung, bukan ditangani sebagai kasus tepi. Empat dari enam pasar ini
rutin mencampur bahasa:

- Philippines: Taglish, dengan partikel hormat `po` / `opo`
- Singapore: Singlish, partikel `lah` / `leh` / `meh`
- Malaysia: Melayu bercampur Inggris, kadang Mandarin
- Indonesia: Indonesia bercampur istilah game Inggris

Bot mengikuti bahasa dominan pemain dan tidak pernah membetulkan cara menulis
mereka. Bot juga tidak perlu meniru slang — cukup jangan menolaknya.

## Panduan nada per locale

Disuntik ke system prompt sebagai `tone_guide`.

| Locale | Panduan |
|---|---|
| `th-TH` | Wajib partikel kesopanan yang konsisten. Tentukan persona bot satu gender dan pakai `ครับ` atau `ค่ะ` seragam — berganti-ganti terbaca aneh |
| `fil-PH` | Hangat, pakai `po` saat berbicara ke pemain. Taglish diterima |
| `id-ID` | Sapaan `kak`, bukan `Anda` yang terlalu formal. Hindari bahasa birokratis |
| `ms-MY` | Sedikit lebih formal dari Indonesia. Jangan pakai slang Indonesia |
| `vi-VN` | Kata ganti bergantung usia. Default `anh/chị` untuk aman, jangan `em` ke pemain |
| `en` | Netral, ringkas. Hindari idiom Amerika |
| `zh-Hans` | Aksara sederhana, nada sopan standar |

Bahasa Melayu dan Indonesia mirip tapi tidak sama. Menggunakan template
Indonesia untuk pasar Malaysia terbaca sebagai kelalaian, bukan penghematan.

## Jam kerja dan SLA

Simpan `hours_start` dan `hours_end` per pasar di tabel `markets`, dihitung
menurut `timezone` pasar itu — bukan zona waktu kantor. Enam pasar ini
membentang dari UTC+7 sampai UTC+8, jadi "jam kerja" tidak pernah sama.

Bot berjalan 24 jam. Handoff hanya bisa dilayani di jam kerja pasar tersebut.

Di luar jam kerja: bot membuat tiket, memberi nomor dan perkiraan waktu balasan
**dalam bahasa pemain**, lalu menutup sesi dengan jujur. Menunggu tanpa
kepastian lebih merusak daripada dijawab besok.

## Jalur cadangan saat tidak ada agent sebahasa

Di dalam jam kerja: chat masuk ke agent `en`. Panel menampilkan dua lapis —
pesan asli pemain di atas, terjemahan di bawah. Agent mengetik dalam Inggris,
sistem menerjemahkan sebelum kirim, `translated: true` di-set, dan widget
menampilkan penanda.

Di luar jam kerja: tiket asinkron.

Catat `fallback_mode` di tabel `handoffs` supaya Anda tahu seberapa sering
jalur ini terpakai per bahasa. Kalau angkanya tinggi terus untuk satu pasar,
itu sinyal perlu menambah agent, bukan memperbaiki terjemahan.

## Metode pembayaran per pasar

Ini penting untuk knowledge base dan klasifikasi intent, karena keluhan top-up
adalah kategori terbesar di hampir semua game SEA, dan alurnya berbeda tiap negara.

| Pasar | Metode umum |
|---|---|
| `TH` | TrueMoney Wallet, PromptPay, kartu |
| `PH` | GCash, Maya, kartu, gerai |
| `ID` | QRIS, DANA, OVO, GoPay, transfer bank, gerai Alfamart / Indomaret |
| `MY` | Touch 'n Go eWallet, FPX, kartu |
| `VN` | MoMo, ZaloPay, ATM lokal |
| `SG` | PayNow, kartu |

Setiap metode butuh artikel KB sendiri, karena waktu penyelesaian dan cara
melacak buktinya berbeda. Bot yang menjawab pertanyaan TrueMoney dengan
panduan QRIS akan terdengar tidak paham.

## Metrik

Semua metrik dipecah per locale. Jangan pernah membaca agregat.

Volume Indonesia yang besar akan menutupi kegagalan bot di pasar kecil —
containment terlihat 68% secara keseluruhan padahal di Thailand hanya 30%,
dan pemain di sana diam-diam berhenti membuka live chat.

Per locale, lacak: volume, containment, CSAT, akurasi draft, dan frekuensi
`fallback_mode`.

Sebulan sekali, ambil sampel 50 percakapan per locale dan minta penutur asli
menilainya. Metrik otomatis tidak bisa menangkap balasan yang benar secara
fakta tapi terasa kasar.

## Gerbang sebelum sebuah locale boleh menyala

`markets.is_bot_enabled` hanya boleh di-set `true` kalau semua terpenuhi:

- Dokumen kebijakan sudah diterjemahkan dan ditinjau manusia
- `guardrail_phrases` lengkap untuk locale itu, ditulis penutur asli
- Pemicu `bahaya_diri` lengkap — ini tidak bisa ditawar, berlaku juga untuk
  locale tingkat terbatas
- `tone_guide` sudah ditinjau penutur asli
- Ada rencana jalur cadangan yang jelas untuk jam di luar kerja
