# Panduan Frasa Pagar Pengaman (Guardrail Phrases)

Sistem live chat AI Gaga Games mewajibkan frasa pagar pengaman dikurasi dan ditinjau oleh **penutur asli (native speakers)** per pasar/locale. 

---

## 1. Daftar `rule_key` Wajib

Setiap file CSV per locale (`data/guardrails/templates/<locale>.csv`) wajib mencakup kategori-kategori berikut:

| Kategori | `rule_key` | Sifat | Penjelasan |
|---|---|:---:|---|
| **Keselamatan Kritis** | `bahaya_diri` | **MUTLAK WAJIB** | Isyarat menyakiti diri sendiri / bunuh diri. **Syarat mutlak sebelum bot boleh diaktifkan.** |
| **Pemicu Keras** | `akun_terkunci` | Wajib | Akun terkunci, diretas, lupa password, tidak bisa login. |
| **Pemicu Keras** | `refund` | Wajib | Permintaan pengembalian dana, pembatalan pembayaran, chargeback. |
| **Pemicu Keras** | `banding_banned` | Wajib | Permohonan banding atas pemblokiran/suspensi akun. |
| **Pemicu Keras** | `pembelian_anak` | Wajib | Pembelian tidak sengaja oleh anak/di bawah umur. |
| **Pemicu Keras** | `hukum_media` | Wajib | Ancaman somasi, lapor polisi, sewa pengacara, atau sebar ke media viral. |
| **Pemicu Lunak** | `minta_manusia` | Wajib | Pemain meminta berbicara dengan agen manusia / customer service asli. |
| **Pemicu Lunak** | `frustrasi` | Wajib | Frasa kemarahan ekstrem, kata kasar, atau tuduhan penipuan. |
| **Filter Output** | `no_promise` | Wajib | Frasa janji terlarang yang tidak boleh keluar dari bot (misal menjanjikan refund pasti cair). |

> [!CAUTION]
> **Aturan Gerbang Startup (Startup Gate Rule):**
> Jika ada pasar dengan `is_bot_enabled = true` di database, namun frasa `bahaya_diri` untuk locale tersebut kosong, **server akan MENOLAK menyalakan bot untuk pasar tersebut dan mencatat alarm peringatan keras**.

---

## 2. Format File Template CSV

File template terletak di:
`data/guardrails/templates/<locale>.csv`

Contoh:
- `data/guardrails/templates/id-ID.csv`
- `data/guardrails/templates/th-TH.csv`
- `data/guardrails/templates/vi-VN.csv`
- `data/guardrails/templates/fil-PH.csv`
- `data/guardrails/templates/ms-MY.csv`
- `data/guardrails/templates/en.csv`

### Format Kolom:
```csv
rule_key,phrase,author
bahaya_diri,bunuh diri,Budi (ID Native)
akun_terkunci,akun terkunci,Budi (ID Native)
refund,kembalikan uang saya,Budi (ID Native)
```

- Kolom `author` wajib diisi nama penutur asli untuk audit kepatuhan, bukan hasil terjemahan mesin otomatis.

---

## 3. Cara Mengimpor ke Database

Setelah tim penutur asli memperbarui atau menambahkan frasa ke file CSV, jalankan perintah:

```powershell
npm run seed:guardrails
```

Skrip ini akan memvalidasi kelengkapan aturan untuk setiap locale dan menyimpannya ke tabel `guardrail_phrases`.
