/**
 * Comic style test harness.
 *
 *   node tools/builder/style-test.mjs <photo> [<photo>...] [--model id] [--size 1K|2K|4K] [--ratio W:H]
 *
 * Calls the real model through netlify/functions/_shared/style.mjs and writes
 * the results to tools/builder/style-out/ so likeness, timing and resolution
 * can be judged on actual photographs. Nothing here is imported by the site.
 *
 * Every call costs money, so: one request per photo, failures are recorded
 * rather than retried by the harness (style.mjs does its own single retry on
 * 429/5xx), and the run keeps going if one photo fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import sharp from 'sharp';
import { styleImage, imageSize, SUPPORTED_RATIOS, StyleError } from '../../netlify/functions/_shared/style.mjs';

const OUT_DIR = fileURLToPath(new URL('./style-out/', import.meta.url));
const LOG = path.join(OUT_DIR, 'log.jsonl');
const SIZES = ['1K', '2K', '4K'];

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};

function usage(msg) {
  if (msg) console.error(`\n  ${msg}`);
  console.error(`
  node tools/builder/style-test.mjs <photo> [<photo>...] [options]

    --model <id>      override the model (default: STYLE_MODEL env, else the
                      module default)
    --size  1K|2K|4K  output size (default 2K)
    --ratio W:H       aspect ratio; default is the supported ratio nearest to
                      each photo's own shape, chosen per photo

  Supported ratios: ${SUPPORTED_RATIOS.join(', ')}
`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const photos = [];
  const opts = { size: '2K' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage();
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--size') opts.size = argv[++i];
    else if (a === '--ratio') opts.ratio = argv[++i];
    else if (a.startsWith('--')) usage(`Unknown option ${a}`);
    else photos.push(a);
  }
  if (!photos.length) usage('Give at least one photo.');
  if (!SIZES.includes(opts.size)) usage(`--size must be one of ${SIZES.join(', ')}`);
  if (opts.ratio && !SUPPORTED_RATIOS.includes(opts.ratio)) {
    usage(`--ratio must be one of ${SUPPORTED_RATIOS.join(', ')}`);
  }
  return { photos, opts };
}

/* Nearest by log ratio, so 2:3 and 3:2 are judged as equally far from square
   and a wide photo is never handed a tall canvas. */
function nearestRatio(width, height) {
  if (!width || !height) return '1:1';
  const target = Math.log(width / height);
  let best = SUPPORTED_RATIOS[0], bestDelta = Infinity;
  for (const r of SUPPORTED_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const delta = Math.abs(Math.log(w / h) - target);
    if (delta < bestDelta) { bestDelta = delta; best = r; }
  }
  return best;
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-');

/** Raw left, styled right, matched heights, on a neutral ground. */
async function writeCompare(rawPath, styledBuffer, outPath) {
  const H = 1200, GAP = 16, BG = { r: 24, g: 24, b: 28 };
  const fit = async (input) => {
    const img = sharp(input).resize({ height: H, fit: 'inside', withoutEnlargement: false });
    const buf = await img.toBuffer({ resolveWithObject: true });
    return { buffer: buf.data, width: buf.info.width, height: buf.info.height };
  };
  const [a, b] = await Promise.all([fit(rawPath), fit(styledBuffer)]);
  const width = a.width + GAP + b.width;
  await sharp({ create: { width, height: H, channels: 3, background: BG } })
    .composite([
      { input: a.buffer, left: 0, top: Math.round((H - a.height) / 2) },
      { input: b.buffer, left: a.width + GAP, top: Math.round((H - b.height) / 2) },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

async function main() {
  const { photos, opts } = parseArgs(process.argv.slice(2));

  if (!process.env.GOOGLE_AI_API_KEY) {
    console.error('\n  GOOGLE_AI_API_KEY is not set. Put it in .env at the repo root.\n');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = [];
  for (const photo of photos) {
    const name = path.basename(photo, path.extname(photo));
    const ext = path.extname(photo).toLowerCase();
    const row = { file: photo, model: null, size: opts.size, ratio: null, ms: null, width: null, height: null, ok: false, error: null };

    try {
      if (!fs.existsSync(photo)) throw new Error('No such file');
      const mimeType = MIME[ext];
      if (!mimeType) throw new Error(`Unsupported extension "${ext}" (try ${Object.keys(MIME).join(', ')})`);

      const buffer = fs.readFileSync(photo);
      const src = imageSize(buffer);
      const ratio = opts.ratio || nearestRatio(src.width, src.height);
      row.ratio = ratio;

      process.stdout.write(
        `→ ${name}  ${src.width ?? '?'}x${src.height ?? '?'}  ratio ${ratio}  size ${opts.size} … `
      );

      const res = await styleImage({ buffer, mimeType, aspectRatio: ratio, imageSize: opts.size, ...(opts.model ? { model: opts.model } : {}) });
      row.model = res.model;
      row.ms = res.ms;
      row.width = res.width;
      row.height = res.height;
      row.ok = true;

      const stem = `${safe(name)}-${safe(res.model)}-${safe(opts.size)}`;
      const outPng = path.join(OUT_DIR, `${stem}.png`);
      fs.writeFileSync(outPng, res.buffer);

      const comparePath = path.join(OUT_DIR, `${safe(name)}-compare.jpg`);
      try {
        await writeCompare(photo, res.buffer, comparePath);
      } catch (e) {
        // The styled image is the deliverable; a failed contact sheet must not
        // lose it or fail the row.
        row.error = `styled ok, compare failed: ${e.message}`;
        console.log(`\n    (compare sheet failed: ${e.message})`);
      }

      console.log(`${res.ms} ms  ${res.width ?? '?'}x${res.height ?? '?'}  → ${path.basename(outPng)}`);
    } catch (err) {
      row.ok = false;
      row.error = err instanceof StyleError
        ? [err.message, err.finishReason && `finishReason=${err.finishReason}`,
           err.blockReason && `blockReason=${err.blockReason}`,
           err.status && `status=${err.status}`,
           err.modelText && `model said: ${err.modelText}`].filter(Boolean).join(' | ')
        : err.message;
      console.log(`FAILED — ${row.error}`);
    }

    fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
    rows.push(row);
  }

  // ---- summary ----
  const cols = [
    ['file', (r) => path.basename(r.file)],
    ['model', (r) => r.model || '—'],
    ['size', (r) => r.size],
    ['ratio', (r) => r.ratio || '—'],
    ['ms', (r) => (r.ms == null ? '—' : String(r.ms))],
    ['out', (r) => (r.width ? `${r.width}x${r.height}` : '—')],
    ['ok', (r) => (r.ok ? 'yes' : 'NO')],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('\n' + line(cols.map(([h]) => h)));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(([, get]) => get(r))));

  const failed = rows.filter((r) => !r.ok);
  const okRows = rows.filter((r) => r.ok);
  if (okRows.length) {
    const times = okRows.map((r) => r.ms).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`\n  ${okRows.length}/${rows.length} styled. Median ${median} ms, slowest ${times[times.length - 1]} ms.`);
  } else {
    console.log(`\n  0/${rows.length} styled.`);
  }
  for (const r of failed) console.log(`  ! ${path.basename(r.file)}: ${r.error}`);
  console.log(`\n  Output: ${OUT_DIR}\n  Log:    ${LOG}\n`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n  Harness failed:', err.message, '\n');
  process.exit(1);
});
