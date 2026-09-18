# Petunjuk Format Data Knowledge Base & Canned Response

Folder ini berisi file data untuk FAQ Knowledge Base dan Bank Balasan Cepat (Canned Responses) livechat Gaga Games.

---

## 1. FAQ & Dokumen Kebijakan (`data/kb/faq.json`)

File `faq.json` adalah array JSON berisi dokumen FAQ, kebijakan resmi (*policy*), dan panduan permainan.

### Spesifikasi Format Tiap Entri:

| Field | Tipe | Wajib | Keterangan |
|---|---|:---:|---|
| `doc_key` | `string` | Ya | Kunci unik dokumen (misal `policy_refund`, `faq_topup_qris`). Dokumen sejenis di berbagai bahasa menggunakan `doc_key` yang sama. |
| `locale` | `string` | Ya | Kode locale (misal `th-TH`, `id-ID`, `vi-VN`, `fil-PH`, `ms-MY`, `en`). |
| `title` | `string` | Ya | Judul dokumen dalam bahasa tersebut. |
| `body` | `string` | Ya | Isi lengkap dokumen / artikel panduan. |
| `is_policy` | `boolean` | Ya | `true` jika dokumen kebijakan resmi (aturan refund, ban appeal, sengketa legal), `false` jika panduan umum (cara top up, tips bermain). |
| `version` | `integer` | Tidak | Versi dokumen (default: `1`). |
| `reviewed_by` | `string` | Tidak | Nama reviewer/tim yang menyetujui (misal `"Legal Team TH"`). |

### Aturan Penting `is_policy`:
- **`is_policy: true`**: Sistem pencarian RAG **DIKUNCI KETAT** hanya untuk locale yang sama persis (`locale = conversations.locale`). Dokumen kebijakan berbahasa lain TIDAK PERNAH dikembalikan, untuk mencegah salah tafsir hukum antar-negara.
- **`is_policy: false`**: Dokumen panduan umum diperbolehkan diambil lintas bahasa (*cross-lingual*) sebagai referensi tambahan bila tidak ada dokumen spesifik di bahasa tersebut.

### Contoh File `faq.json`:
```json
[
  {
    "doc_key": "policy_refund",
    "locale": "id-ID",
    "title": "Kebijakan Pengembalian Dana (Refund)",
    "body": "Pengembalian dana hanya berlaku dalam waktu 7 hari sejak transaksi...",
    "is_policy": true,
    "version": 1,
    "reviewed_by": "Legal Team ID"
  },
  {
    "doc_key": "faq_topup_guide",
    "locale": "id-ID",
    "title": "Panduan Top-Up Diamond",
    "body": "Buka Store dalam game, pilih metode pembayaran QRIS/GoPay/DANA...",
    "is_policy": false,
    "version": 1,
    "reviewed_by": "CS Team"
  }
]
```

---

## 2. Bank Balasan Cepat (`data/kb/canned-responses.json`)

File `canned-responses.json` adalah array JSON berisi template pesan siap pakai bagi agen customer service dan bot sistem.

### Spesifikasi Format Tiap Entri:

| Field | Tipe | Wajib | Keterangan |
|---|---|:---:|---|
| `template_id` | `string` | Ya | Kunci template pesan bersama (misal `greeting_general`, `wait_agent_connecting`). |
| `locale` | `string` | Ya | Kode locale (misal `th-TH`, `id-ID`, `vi-VN`, `fil-PH`, `ms-MY`, `en`). |
| `category` | `string` | Ya | Kategori balasan (misal `greeting`, `handoff`, `closing`, `billing`). |
| `body` | `string` | Ya | Teks balasan lengkap dalam bahasa target. |

### Contoh File `canned-responses.json`:
```json
[
  {
    "template_id": "greeting_general",
    "locale": "id-ID",
    "category": "greeting",
    "body": "Halo kak! Selamat datang di layanan live chat Gaga Games. Ada yang bisa kami bantu hari ini?"
  },
  {
    "template_id": "greeting_general",
    "locale": "th-TH",
    "category": "greeting",
    "body": "สวัสดีครับ/ค่ะ ยินดีต้อนรับสู่ฝ่ายบริการลูกค้า Gaga Games มีอะไรให้เราช่วยเหลือในวันนี้ไหมครับ/ค่ะ"
  }
]
```

---

## 3. Cara Mengimpor Data Baru ke Database

Setelah Anda mengisi data asli di `faq.json` dan `canned-responses.json`, jalankan perintah:

```powershell
npm run seed:kb
```

Skrip ini akan:
1. Membaca file `faq.json`.
2. Menghasilkan vektor embedding 1536-dimensi untuk setiap artikel.
3. Menyimpan/memperbarui dokumen ke tabel PostgreSQL `kb_documents`.
4. Membaca file `canned-responses.json` dan menyimpan ke tabel `canned_responses`.
