'use strict';

const fs = require('node:fs');
const path = require('node:path');
// pngjs is already installed by the locked qrcode dependency; no new packages.
const { PNG } = require('pngjs');

const background = [0x11, 0x1b, 0x1e];
const accent = [0x83, 0xcf, 0xb6];
const output = path.join(__dirname, '../public/pwa-icons');

function insideMark(x, y) {
  if (x < 0) return false;
  // The same three diagonal-ended bars as the existing Erraza E mark.
  if (y >= 0 && y < 6) return x < 26 - y * 4 / 6;
  if (y >= 9 && y < 15) return x < 21 - (y - 9) * 4 / 6;
  if (y >= 18 && y < 24) return x < 26 - (y - 18) * 4 / 6;
  return false;
}

function icon(size, markWidth) {
  const png = new PNG({ width: size, height: size });
  const scale = size * markWidth / 26;
  const left = (size - 26 * scale) / 2;
  const top = (size - 24 * scale) / 2;
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          if (insideMark((x + (sx + .5) / samples - left) / scale, (y + (sy + .5) / samples - top) / scale)) coverage += 1;
        }
      }
      const blend = coverage / (samples * samples);
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        png.data[offset + channel] = Math.round(background[channel] + (accent[channel] - background[channel]) * blend);
      }
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

fs.mkdirSync(output, { recursive: true });
for (const [name, size, width] of [
  ['icon-192.png', 192, .62],
  ['icon-512.png', 512, .62],
  // All mark pixels fit inside the central 80%-diameter maskable safe circle.
  ['maskable-512.png', 512, .52],
  ['apple-touch-icon.png', 180, .62],
]) {
  fs.writeFileSync(path.join(output, name), icon(size, width));
  console.log(`Generated ${name} (${size} × ${size}).`);
}
