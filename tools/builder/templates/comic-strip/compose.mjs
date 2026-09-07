/**
 * Comic Strip Canvas — panel compositor
 *
 * Two ways in:
 *
 *   1. Recipe (what the builder exports — studio proofs and customer orders)
 *        node compose.mjs --recipe recipe.json --images ./images --out strip.png
 *
 *   2. Bare folder (batch runs where you just want a sensible auto-crop)
 *        node compose.mjs --images ./images --bg "#E2A7D6" --out strip.png
 *
 * In recipe mode the zoom and offsets are reproduced exactly as they were
 * dragged in the browser, so the 300dpi master matches the on-screen proof.
 * Both modes read panels.json, the single source of truth for panel geometry.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const IMAGES = path.resolve(arg('--images', './images'));
const OUT = path.resolve(arg('--out', './strip.png'));
const RECIPE = arg('--recipe', null);
const EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];
const MIN_DPI = Number(arg('--min-dpi', 150));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'panels.json'), 'utf8'));
const recipe = RECIPE ? JSON.parse(fs.readFileSync(path.resolve(RECIPE), 'utf8')) : null;
const { width: W, height: H, dpi } = manifest.canvas;
const BG = arg('--bg', recipe?.background ?? '#FFFFFF');
const byId = new Map((recipe?.panels ?? []).map((p) => [p.id, p]));

const resolve = (name) => {
  if (!name) return null;
  const direct = path.join(IMAGES, name);
  if (fs.existsSync(direct)) return direct;
  const stem = name.replace(/\.[^.]+$/, '');
  for (const ext of EXTS) {
    const p = path.join(IMAGES, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const anchor = (name) =>
  name === 'entropy' ? sharp.strategy.entropy
  : name && name !== 'attention' ? name
  : sharp.strategy.attention;

const layers = [];
const warnings = [];
let filled = 0;

for (const panel of manifest.panels) {
  const order = byId.get(panel.id);
  const src = recipe ? resolve(order?.image) : resolve(panel.id);
  if (!src) {
    if (!recipe || order?.image) console.warn(`  skip  ${panel.id}  (no image found)`);
    continue;
  }

  let framed;
  if (order?.transform) {
    // Replay the browser's geometry: cover-fit, then zoom, then offset.
    const meta = await sharp(src).metadata();
    const { zoom = 1, offsetX = 0, offsetY = 0 } = order.transform;
    const base = Math.max(panel.width / meta.width, panel.height / meta.height);
    const dw = Math.max(panel.width, Math.round(meta.width * base * zoom));
    const dh = Math.max(panel.height, Math.round(meta.height * base * zoom));
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    const left = clamp(Math.round((dw - panel.width) / 2 - offsetX), dw - panel.width);
    const top = clamp(Math.round((dh - panel.height) / 2 - offsetY), dh - panel.height);

    const effectiveDpi = Math.round((dpi * meta.width) / dw);
    if (effectiveDpi < MIN_DPI) warnings.push(`${panel.id}: ${effectiveDpi} dpi`);

    framed = await sharp(src)
      .resize(dw, dh, { fit: 'fill' })
      .extract({ left, top, width: panel.width, height: panel.height })
      .ensureAlpha()
      .toBuffer();
  } else {
    framed = await sharp(src)
      .resize(panel.width, panel.height, { fit: 'cover', position: anchor(panel.position) })
      .ensureAlpha()
      .toBuffer();
  }

  const shaped = await sharp(framed)
    .composite([{ input: path.join(ROOT, panel.mask), blend: 'dest-in' }])
    .png()
    .toBuffer();

  layers.push({ input: shaped, left: panel.x, top: panel.y });
  filled++;
  console.log(`  ok    ${panel.id}  ${panel.width}x${panel.height}  <- ${path.basename(src)}`);
}

await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
  .composite([...layers, { input: path.join(ROOT, 'overlay.png'), left: 0, top: 0 }])
  .withMetadata({ density: dpi })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`\n${filled}/${manifest.panels.length} panels placed -> ${OUT} (${W}x${H} @ ${dpi}dpi)`);
if (warnings.length) console.warn('Low resolution:\n  ' + warnings.join('\n  '));
