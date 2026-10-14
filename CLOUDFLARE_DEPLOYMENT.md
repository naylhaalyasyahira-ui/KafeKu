# Panduan Deployment KafeKu di Cloudflare Pages

Aplikasi **KafeKu** telah dikonfigurasi secara lengkap agar dapat di-deploy tanpa kendala di **Cloudflare Pages** (baik via Git integration otomatis maupun Cloudflare Wrangler CLI).

---

## 🚀 Fitur Kesiapan Cloudflare yang Telah Dikonfigurasi

1. **SPA Routing (`public/_redirects`)**:
   - Mengalihkan semua rute URL frontend (`/kasir`, `/kitchen`, `/owner`, `/admin`, `/customer`) ke `/index.html` dengan kode HTTP 200, sehingga deep-link dan refresh halaman di Cloudflare Pages tidak akan mengalami error 404.
2. **Keamanan & Caching (`public/_headers`)**:
   - Menambahkan header keamanan (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) dan caching otomatis untuk file statis di `/assets/*`.
3. **Cloudflare Pages Functions (`functions/api/[[path]].ts`)**:
   - Menjalankan backend API serverless di jaringan edge Cloudflare Workers secara otomatis tanpa memerlukan server VPS atau Express terpisah.
4. **Dual-Engine Resiliency (Direct Supabase Fallback)**:
   - Jika aplikasi di-deploy sebagai website statis murni tanpa Functions, antarmuka browser secara otomatis beralih menggunakan koneksi langsung ke Supabase (`@supabase/supabase-js`) sehingga fitur transaksi, stok, dan kasir tetap berfungsi normal.
5. **Node.js LTS 20 Runtime (`.nvmrc` & `.node-version`)**:
   - Memastikan container build Cloudflare Pages otomatis menggunakan Node.js 20 LTS (menghindari kegagalan build akibat Node versi lama).
6. **Wrangler Configuration (`wrangler.toml`)**:
   - Konfigurasi siap pakai untuk deployment via Cloudflare CLI atau CI/CD.

---

## 🛠️ Pilihan Metode Deployment

### Metode 1: Cloudflare Pages via Git (Paling Direkomendasikan & Otomatis)

1. **Push repository** Anda ke GitHub atau GitLab.
2. Buka dashboard Cloudflare: [https://dash.cloudflare.com/](https://dash.cloudflare.com/)
3. Pilih menu **Workers & Pages** > Klik **Create application** > Tab **Pages** > **Connect to Git**.
4. Pilih repository KafeKu Anda.
5. Pada halaman **Build settings**, isi konfigurasi berikut:
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build:pages` *(atau `npm run build`)*
   - **Build output directory**: `dist`
   - **Root directory**: `/`
6. Buka bagian **Environment variables** (opsional tapi disarankan jika memakai Supabase sendiri):
   - `VITE_SUPABASE_URL` = `https://yuyrqhqngjfikkhfwern.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
   - `GEMINI_API_KEY` = `(API Key Gemini Anda, jika menggunakan fitur suara AI)`
7. Klik **Save and Deploy**. Selesai! Aplikasi Anda langsung online di domain `*.pages.dev` dengan SSL gratis.

---

### Metode 2: Deploy Cepat via Wrangler CLI (Tanpa Git)

Jika ingin deploy langsung dari terminal atau komputer lokal:

```bash
# 1. Pastikan dependensi terpasang dan build aplikasi
npm run build:pages

# 2. Login ke akun Cloudflare (hanya pertama kali)
npx wrangler login

# 3. Deploy langsung folder dist ke Cloudflare Pages
npx wrangler pages deploy dist --project-name=kafeku
```

---

## 📋 Ringkasan Pengaturan Build Cloudflare

| Pengaturan | Nilai | Keterangan |
| :--- | :--- | :--- |
| **Framework Preset** | `Vite` | Preset bawaan Cloudflare Pages |
| **Build Command** | `npm run build:pages` | Menjalankan Vite production bundle |
| **Build Output Directory** | `dist` | Folder output build |
| **Node.js Version** | `20` | Terkonfigurasi via `.nvmrc` |

---

## 🗄️ Database Supabase

KafeKu telah terintegrasi dengan Supabase. Pastikan tabel di database Supabase sudah dibuat jika Anda menggunakan project baru. Skrip SQL dapat dilihat dan disalin langsung dari halaman **Admin KafeKu** > tab **Database Supabase**.
