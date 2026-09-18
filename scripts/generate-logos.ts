import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Script untuk menghasilkan varian logo transparan dari assets/LOGO_gaga.webp:
 * 1. logo-mark.png: Ikon "GAGA" saja dengan latar transparan dan ditrim rapi.
 * 2. logo-full-light.png: Logo lengkap (GAGA hijau + tulisan GAMES putih) untuk latar gelap.
 */
async function generateLogos() {
  const rootDir = process.cwd();
  const sourcePath = path.join(rootDir, 'assets', 'LOGO_gaga.webp');

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source logo not found at: ${sourcePath}`);
  }

  console.log(`[Logo Generator] Membaca file master: ${sourcePath}`);
  const { data, info } = await sharp(sourcePath)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: srcWidth, height: srcHeight, channels } = info;
  if (channels < 3) {
    throw new Error(`Expected at least 3 channels, got ${channels}`);
  }

  // 1. GENERATE logo-mark.png (Ikon GAGA saja)
  // Koordinat GAGA di master: left=567, top=1639, width=3364, height=838
  const gagaLeft = 567;
  const gagaTop = 1639;
  const gagaWidth = 3364;
  const gagaHeight = 838;

  const markBuffer = Buffer.alloc(gagaWidth * gagaHeight * 4);

  for (let y = 0; y < gagaHeight; y++) {
    for (let x = 0; x < gagaWidth; x++) {
      const srcY = y + gagaTop;
      const srcX = x + gagaLeft;
      const srcIdx = (srcY * srcWidth + srcX) * channels;
      const dstIdx = (y * gagaWidth + x) * 4;

      let r = data[srcIdx];
      let g = data[srcIdx + 1];
      let b = data[srcIdx + 2];
      let a = channels === 4 ? data[srcIdx + 3] : 255;

      // Hapus latar putih solid jika ada (toleransi RGB > 240)
      if (r > 240 && g > 240 && b > 240) {
        a = 0;
      }

      markBuffer[dstIdx] = r;
      markBuffer[dstIdx + 1] = g;
      markBuffer[dstIdx + 2] = b;
      markBuffer[dstIdx + 3] = a;
    }
  }

  const markPng = await sharp(markBuffer, {
    raw: { width: gagaWidth, height: gagaHeight, channels: 4 },
  })
    .trim()
    .png({ compressionLevel: 9 })
    .toBuffer();

  const markMeta = await sharp(markPng).metadata();
  console.log(`[Logo Generator] logo-mark.png berhasil dibuat: ${markMeta.width}x${markMeta.height} px, hasAlpha: ${markMeta.hasAlpha}`);

  // 2. GENERATE logo-full-light.png (GAGA hijau + tulisan GAMES putih)
  // Koordinat gabungan: left=567, top=1639, width=3364, height=1227 (sampai bottom GAMES y=2865)
  const fullLeft = 567;
  const fullTop = 1639;
  const fullWidth = 3364;
  const fullHeight = 2865 - 1639 + 1;

  const fullBuffer = Buffer.alloc(fullWidth * fullHeight * 4);

  for (let y = 0; y < fullHeight; y++) {
    for (let x = 0; x < fullWidth; x++) {
      const srcY = y + fullTop;
      const srcX = x + fullLeft;
      const srcIdx = (srcY * srcWidth + srcX) * channels;
      const dstIdx = (y * fullWidth + x) * 4;

      let r = data[srcIdx];
      let g = data[srcIdx + 1];
      let b = data[srcIdx + 2];
      let a = channels === 4 ? data[srcIdx + 3] : 255;

      // Hapus latar putih solid jika ada
      if (r > 240 && g > 240 && b > 240) {
        a = 0;
      }

      // Tulisan "GAMES" berada di area y >= 2600
      // Ubah piksel gelap teks GAMES menjadi putih murni (#FFFFFF) dengan mempertahankan alpha
      if (srcY >= 2600 && a > 0) {
        if (r < 150 && g < 150 && b < 150) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      fullBuffer[dstIdx] = r;
      fullBuffer[dstIdx + 1] = g;
      fullBuffer[dstIdx + 2] = b;
      fullBuffer[dstIdx + 3] = a;
    }
  }

  const fullPng = await sharp(fullBuffer, {
    raw: { width: fullWidth, height: fullHeight, channels: 4 },
  })
    .trim()
    .png({ compressionLevel: 9 })
    .toBuffer();

  const fullMeta = await sharp(fullPng).metadata();
  console.log(`[Logo Generator] logo-full-light.png berhasil dibuat: ${fullMeta.width}x${fullMeta.height} px, hasAlpha: ${fullMeta.hasAlpha}`);

  // Target direktori tujuan distribusi
  const targetDirs = [
    path.join(rootDir, 'assets'),
    path.join(rootDir, 'services', 'gateway', 'public'),
    path.join(rootDir, 'apps', 'agent-panel', 'public'),
    path.join(rootDir, 'apps', 'widget', 'public'),
  ];

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const markDest = path.join(dir, 'logo-mark.png');
    const iconDest = path.join(dir, 'logo-gaga-icon.png');
    const fullDest = path.join(dir, 'logo-full-light.png');

    fs.writeFileSync(markDest, markPng);
    fs.writeFileSync(iconDest, markPng);
    fs.writeFileSync(fullDest, fullPng);
    console.log(`  ✓ Tersimpan ke: ${path.relative(rootDir, markDest)}, ${path.relative(rootDir, iconDest)} & ${path.relative(rootDir, fullDest)}`);
  }

  console.log('\n[Logo Generator] Berhasil membuat dan mendistribusikan seluruh varian logo transparan!');
}

generateLogos().catch((err) => {
  console.error('[Logo Generator] Error:', err);
  process.exit(1);
});
