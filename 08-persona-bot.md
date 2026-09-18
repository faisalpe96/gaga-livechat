# 08 — Persona bot

Memberi bot dua persona berwajah dan bernama, supaya percakapan terasa
ditangani orang, bukan sistem.

## Aset

| Berkas | Persona | Keterangan |
|---|---|---|
| `assets/agent-mira.png` | Wanita | Avatar persona perempuan |
| `assets/agent-reza.png` | Pria | Avatar persona laki-laki |

Keduanya karakter ilustrasi, bukan foto orang sungguhan. Salin ke folder
`public` masing-masing aplikasi saat build, dan pastikan URL-nya tidak 404.

Siapkan versi kecil berbentuk lingkaran ukuran 64x64 dan 128x128 untuk avatar
di dalam chat, supaya tidak memuat gambar besar berulang kali.

## Aturan pemilihan persona

**Persona dipilih sekali saat percakapan dibuka dan tidak berubah sampai sesi
selesai.** Ini aturan keras. Bot yang berganti nama dan wajah di tengah obrolan
akan langsung terasa palsu, dan pemain kehilangan rasa sedang bicara dengan
seseorang.

Pemilihan boleh acak seimbang antara dua persona, atau ditetapkan per pasar.
Simpan hasilnya, jangan dihitung ulang tiap pesan.

```sql
ALTER TABLE conversations
  ADD COLUMN bot_persona text;
```

Nilai yang sah: `mira`, `reza`. Diisi saat `session_start`, tidak pernah diubah
setelahnya kecuali lewat tindakan manual yang tercatat.

## Nama per pasar

Nama Indonesia terasa asing bagi pemain Thailand atau Vietnam. Sediakan tabel
nama per locale supaya persona terasa lokal, sementara avatarnya tetap sama.

```sql
CREATE TABLE bot_personas (
  persona    text NOT NULL,
  locale     text NOT NULL,
  display_name text NOT NULL,
  avatar_url text NOT NULL,
  PRIMARY KEY (persona, locale)
);
```

Nama harus ditentukan penutur asli tiap pasar, bukan diterjemahkan atau
ditebak. Yang perlu dipastikan: nama terdengar wajar sebagai nama CS, mudah
diucapkan, dan tidak bermakna lain yang mengganggu di bahasa setempat.

### Seed awal

Pakai ini sebagai nilai awal supaya sistem langsung jalan. **Semua nama di luar
`id-ID` masih perlu diperiksa penutur asli sebelum dipakai di produksi.**

| Persona | Locale | Nama tampil |
|---|---|---|
| `mira` | `id-ID` | Mira |
| `mira` | `ms-MY` | Mira |
| `mira` | `en` | Mira |
| `mira` | `fil-PH` | Mira |
| `mira` | `th-TH` | Ploy |
| `mira` | `vi-VN` | Linh |
| `reza` | `id-ID` | Reza |
| `reza` | `ms-MY` | Reza |
| `reza` | `en` | Ray |
| `reza` | `fil-PH` | Ray |
| `reza` | `th-TH` | Ton |
| `reza` | `vi-VN` | Minh |

Nama yang tampil di chat adalah `display_name` saja, tanpa embel-embel "Bot"
atau "Assistant". Jadi pemain melihat "Mira" atau "Reza" sebagai pengirim,
persis seperti nama agent manusia.

Sediakan juga importir CSV supaya tim lokalisasi bisa mengganti nama-nama ini
tanpa menyentuh kode, mengikuti pola pada `guardrail_phrases`.

## Kaitan dengan nada bicara

Ini bagian yang paling mudah terlewat.

Untuk `th-TH`, partikel kesopanan bergantung gender pembicara: persona pria
memakai `ครับ`, persona wanita memakai `ค่ะ`. Kalau persona diacak tapi
partikelnya tetap satu untuk semua, pemain Thailand akan langsung merasa janggal.

Karena itu `tone_guide` yang disuntik ke system prompt harus menerima persona
sebagai parameter, bukan hanya locale. Terapkan pola yang sama untuk bahasa lain
yang gendernya memengaruhi sapaan atau kata ganti.

## Tempat tampil

| Lokasi | Yang ditampilkan |
|---|---|
| Header widget | Avatar bulat kecil, nama persona, status aktif |
| Setiap balasan bot di widget | Avatar kecil di samping gelembung pesan, menggantikan label "Gaga Bot" |
| Draft bot di panel agent | Avatar dan nama, supaya agent tahu persona yang sedang dipakai |
| Konsol AI Studio | Kolom persona pada laporan draft, untuk melihat perbedaan performa antar persona |

Saat percakapan dioper ke agent manusia, ganti avatar dan nama menjadi milik
agent yang mengambil alih, dan tampilkan pesan sistem singkat yang menandai
peralihan. Jangan biarkan pemain mengira masih bicara dengan persona yang sama.

## Kriteria terima

1. Persona tersimpan di `conversations.bot_persona` saat sesi dibuka, dan tidak
   berubah meski percakapan berlangsung panjang. Buktikan dengan tes yang
   mengirim sepuluh pesan berturut-turut dan memeriksa nilainya tetap sama.
2. Avatar tampil di widget dan panel agent tanpa 404. Buktikan dengan memanggil
   URL gambar langsung.
3. `tone_guide` untuk `th-TH` menghasilkan partikel yang sesuai gender persona.
   Buktikan dengan dua tes, satu per persona.
4. Locale yang belum punya baris di `bot_personas` jatuh ke nama default dan
   mencatat peringatan, bukan gagal diam-diam.
5. Saat sesi beralih ke `agent_active`, identitas yang tampil berganti menjadi
   agent manusia.

## Yang tidak boleh dilakukan

Persona tidak boleh dipakai untuk mengaburkan bahwa pemain sedang bicara dengan
bot. Kalau pemain bertanya apakah dia sedang bicara dengan manusia, bot wajib
menjawab jujur bahwa ia asisten otomatis dan menawarkan dihubungkan ke tim.

Aturan ini terkunci, setara dengan pagar pengaman di `04-orchestrator.md`.
Persona ada untuk membuat percakapan terasa hangat, bukan untuk menipu.
