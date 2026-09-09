/**
 * Cutout spike: green-screen via Gemini, then chroma key in sharp.
 *
 *   node tools/builder/cutout-test.mjs <styled.png> [more...] [options]
 *
 *     --single <raw.jpg>   one-call variant: style AND green-screen a RAW photo
 *                          in a single call, then key it. For comparing edge
 *                          quality and cost against the two-call route.
 *     --size 1K|2K|4K      override; default matches the input's pixel size
 *     --ratio W:H          override; default matches the input's shape
 *     --keep-green         also write the un-keyed green-screen frame
 *
 * The premise: @imgly's matting model cannot fit in a Netlify function
 * (onnxruntime-node alone is 49.5 MB zipped against a 50 MB budget), but the
 * model that made the artwork is already in the pipeline and can be asked for
 * a flat background instead. A hard-edged flat green is something sharp can key
 * locally in milliseconds, so the cutout costs one more image call and no new
 * dependency, no new data processor and no bundle weight.
 *
 * Nothing here touches the pipeline, Sanity, or any document. It reads styled
 * images off disk and writes to tools/builder/style-out/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import sharp from 'sharp';
import {
  STYLE_PROMPT, SUPPORTED_RATIOS, nearestRatio, StyleError,
} from '../../netlify/functions/_shared/style.mjs';
import { GoogleGenAI, Modality } from '@google/genai';

const OUT_DIR = fileURLToPath(new URL('./style-out/', import.meta.url));
const LOG = path.join(OUT_DIR, 'cutout-log.jsonl');
const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com';
const MODEL = process.env.STYLE_MODEL || 'gemini-3-pro-image-preview';
const TIMEOUT_MS = 120000;

/* ---------------------------------------------------------------- prompts */

/* Exported so it can be iterated on without reading the keying code.
   Every clause after the first exists to stop a specific failure: the model
   treating "replace the background" as licence to redraw the subject, to light
   it as if it were on a green stage, or to feather the edge into the fill --
   all of which key badly or lose the artwork. */
export const CUTOUT_PROMPT =
  'Keep this artwork exactly as it is — every line, colour and detail of every person, ' +
  'animal and object, same size, same position, same framing. Replace only the background ' +
  'with a single flat, uniform, pure green (#00FF00) fill. No green on the subjects, no ' +
  'shadows, no gradient, no glow, no outline, no vignette. Output the same aspect ratio.';

/** The one-call variant: style and green-screen in the same generation. */
export const STYLE_AND_CUTOUT_PROMPT =
  `${STYLE_PROMPT} Then replace the background — everything that is not a person, animal or ` +
  'object from the photograph — with a single flat, uniform, pure green (#00FF00) fill. No ' +
  'green on the subjects, no shadows, no gradient, no glow, no outline, no vignette.';

/* ------------------------------------------------------------ chroma key */

/* Distance from pure green, in RGB, below which a pixel is background and
   above which it is subject; between the two it is a soft edge.
   The gap is what buys an anti-aliased edge instead of a jagged one -- comic
   line art has hard black outlines, so the transition band can stay narrow.
   Both are tunable: widen OUTER if green fringes survive, raise INNER if
   green-ish parts of the artwork start dissolving. */
export const KEY_INNER = 90;    // <= this distance: fully transparent
export const KEY_OUTER = 165;   // >= this distance: fully opaque

/** The reference background colour the prompt asks for. */
export const KEY_COLOUR = { r: 0, g: 255, b: 0 };

/* A pixel is only despilled if it is part-transparent, i.e. on the edge.
   Clamping G to max(R,B) there removes the green rim the fill leaves behind
   without touching genuinely green artwork in the middle of the subject. */
export const DESPILL_BELOW_ALPHA = 250;

/**
 * Key a green-screen frame to RGBA.
 * @returns {{ png: Buffer, stats: object }}
 */
export async function chromaKey(inputBuffer) {
  const src = sharp(inputBuffer).ensureAlpha();
  const { width, height } = await src.metadata();
  const { data } = await src.raw().toBuffer({ resolveWithObject: true });

  const px = width * height;
  let fullyKeyed = 0, edge = 0, despilled = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const d = Math.sqrt(
      (r - KEY_COLOUR.r) ** 2 + (g - KEY_COLOUR.g) ** 2 + (b - KEY_COLOUR.b) ** 2
    );

    let a;
    if (d <= KEY_INNER) { a = 0; fullyKeyed++; }
    else if (d >= KEY_OUTER) { a = 255; }
    else { a = Math.round(((d - KEY_INNER) / (KEY_OUTER - KEY_INNER)) * 255); edge++; }

    if (a < DESPILL_BELOW_ALPHA && a > 0) {
      const cap = Math.max(r, b);
      if (g > cap) { data[i + 1] = cap; despilled++; }
    }
    data[i + 3] = a;
  }

  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return {
    png,
    stats: {
      width, height, pixels: px,
      keyedPct: +((fullyKeyed / px) * 100).toFixed(2),
      edgePct: +((edge / px) * 100).toFixed(3),
      despilledPx: despilled,
    },
  };
}

/* --------------------------------------------------------------- the call */

async function generate({ buffer, mimeType, prompt, aspectRatio, imageSize, refs }) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set');
  const ai = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: GOOGLE_API_BASE_URL } });

  const parts = [];
  if (refs && refs.length) {
    parts.push({ text: 'Style references:' });
    for (const r of refs) parts.push({ inlineData: { mimeType: r.mimeType, data: r.data.toString('base64') } });
    parts.push({ text: 'Photograph to redraw:' });
  }
  parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
  parts.push({ text: prompt });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: [Modality.IMAGE],
        imageConfig: { aspectRatio, imageSize },
        abortSignal: ac.signal,
      },
    });
    const ms = Date.now() - started;
    const cand = res?.candidates?.[0];
    const img = (cand?.content?.parts || []).find(
      (p) => p.inlineData?.data && (p.inlineData.mimeType || '').startsWith('image/')
    );
    if (!img) {
      throw new StyleError('The model returned no image', {
        finishReason: cand?.finishReason ?? null,
        blockReason: res?.promptFeedback?.blockReason ?? null,
        modelText: (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n') || null,
      });
    }
    return { buffer: Buffer.from(img.inlineData.data, 'base64'), mimeType: img.inlineData.mimeType, ms };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- reporting */

/** styled | green screen | cutout on a checkerboard, all one height. */
async function writeCompare(styledBuf, greenBuf, cutoutPng, outPath) {
  const H = 1000, GAP = 14, BG = { r: 22, g: 22, b: 26 };
  const fit = async (b) => {
    const o = await sharp(b).resize({ height: H, fit: 'inside' }).toBuffer({ resolveWithObject: true });
    return { buffer: o.data, w: o.info.width, h: o.info.height };
  };
  const [a, g] = await Promise.all([fit(styledBuf), fit(greenBuf)]);

  // the cutout needs something behind it or the alpha is invisible
  const cut = await sharp(cutoutPng).resize({ height: H, fit: 'inside' }).toBuffer({ resolveWithObject: true });
  const sq = 32, cols = Math.ceil(cut.info.width / sq), rows = Math.ceil(H / sq);
  let tiles = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if ((x + y) % 2 === 0) tiles += `<rect x="${x * sq}" y="${y * sq}" width="${sq}" height="${sq}" fill="#d6d6da"/>`;
    }
  }
  const board = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cut.info.width}" height="${cut.info.height}">` +
    `<rect width="100%" height="100%" fill="#f0f0f2"/>${tiles}</svg>`
  );
  const onBoard = await sharp(await sharp(board).png().toBuffer())
    .composite([{ input: cut.data }]).png().toBuffer();

  const W = a.w + GAP + g.w + GAP + cut.info.width;
  await sharp({ create: { width: W, height: H, channels: 3, background: BG } })
    .composite([
      { input: a.buffer, left: 0, top: 0 },
      { input: g.buffer, left: a.w + GAP, top: 0 },
      { input: onBoard, left: a.w + GAP + g.w + GAP, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** The imageSize band an existing image sits in, so the edit matches it. */
function sizeOf(width, height) {
  const longest = Math.max(width, height);
  if (longest >= 3600) return '4K';
  if (longest >= 1600) return '2K';
  return '1K';
}

async function loadRefs() {
  const dir = fileURLToPath(new URL('../../netlify/functions/_shared/style-refs/', import.meta.url));
  return ['ref-1.jpg', 'ref-2.jpg', 'ref-3.jpg'].map((name) => ({
    name, data: fs.readFileSync(path.join(dir, name)), mimeType: 'image/jpeg',
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const inputs = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--single') opts.single = argv[++i];
    else if (a === '--size') opts.size = argv[++i];
    else if (a === '--ratio') opts.ratio = argv[++i];
    else if (a === '--keep-green') opts.keepGreen = true;
    else if (a.startsWith('--')) { console.error(`Unknown option ${a}`); process.exit(1); }
    else inputs.push(a);
  }
  if (!inputs.length && !opts.single) {
    console.error('\n  node tools/builder/cutout-test.mjs <styled.png> [...] [--single <raw.jpg>]\n');
    process.exit(1);
  }
  if (!process.env.GOOGLE_AI_API_KEY) {
    console.error('\n  GOOGLE_AI_API_KEY is not set (put it in .env at the repo root)\n');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const jobs = inputs.map((f) => ({ file: f, mode: 'edit' }));
  if (opts.single) jobs.push({ file: opts.single, mode: 'single' });

  const rows = [];
  for (const job of jobs) {
    const name = path.basename(job.file, path.extname(job.file)).slice(0, 60);
    const row = { file: job.file, mode: job.mode, model: MODEL, ok: false };
    try {
      if (!fs.existsSync(job.file)) throw new Error('No such file');
      const mimeType = MIME[path.extname(job.file).toLowerCase()];
      if (!mimeType) throw new Error(`Unsupported extension ${path.extname(job.file)}`);
      const buffer = fs.readFileSync(job.file);
      const meta = await sharp(buffer).metadata();

      const aspectRatio = opts.ratio || nearestRatio(meta.width, meta.height);
      const imageSize = opts.size || sizeOf(meta.width, meta.height);
      row.ratio = aspectRatio; row.size = imageSize;
      row.inputPx = [meta.width, meta.height];

      process.stdout.write(
        `→ ${name}\n  ${job.mode === 'single' ? 'style+green (1 call)' : 'green-screen edit'} ` +
        `${meta.width}x${meta.height} ratio ${aspectRatio} size ${imageSize} … `
      );

      const gen = await generate({
        buffer, mimeType, aspectRatio, imageSize,
        prompt: job.mode === 'single' ? STYLE_AND_CUTOUT_PROMPT : CUTOUT_PROMPT,
        refs: job.mode === 'single' ? await loadRefs() : null,
      });
      row.genMs = gen.ms;
      row.greenPx = await sharp(gen.buffer).metadata().then((m) => [m.width, m.height]);

      const t0 = Date.now();
      const { png, stats } = await chromaKey(gen.buffer);
      row.keyMs = Date.now() - t0;
      Object.assign(row, stats);
      row.outBytes = png.length;

      const stem = `cutout-${name}${job.mode === 'single' ? '-1call' : ''}`;
      const pngPath = path.join(OUT_DIR, `${stem}.png`);
      fs.writeFileSync(pngPath, png);
      if (opts.keepGreen) fs.writeFileSync(path.join(OUT_DIR, `${stem}-green.png`), gen.buffer);
      const cmpPath = path.join(OUT_DIR, `${stem}-compare.jpg`);
      await writeCompare(buffer, gen.buffer, png, cmpPath);
      row.png = pngPath; row.compare = cmpPath;
      row.ok = true;

      console.log(
        `${gen.ms} ms gen, ${row.keyMs} ms key — ${stats.width}x${stats.height}, ` +
        `${stats.keyedPct}% keyed, ${stats.edgePct}% edge, ${(png.length / 1048576).toFixed(1)} MB`
      );
    } catch (err) {
      row.error = err instanceof StyleError
        ? [err.message, err.finishReason && `finishReason=${err.finishReason}`,
           err.blockReason && `blockReason=${err.blockReason}`, err.modelText].filter(Boolean).join(' | ')
        : err.message;
      console.log(`FAILED — ${row.error}`);
    }
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
    rows.push(row);
  }

  const cols = [
    ['image', (r) => path.basename(r.file).slice(0, 34)],
    ['mode', (r) => r.mode],
    ['ratio', (r) => r.ratio || '—'],
    ['gen ms', (r) => String(r.genMs ?? '—')],
    ['key ms', (r) => String(r.keyMs ?? '—')],
    ['out', (r) => (r.width ? `${r.width}x${r.height}` : '—')],
    ['keyed %', (r) => (r.keyedPct != null ? String(r.keyedPct) : '—')],
    ['edge %', (r) => (r.edgePct != null ? String(r.edgePct) : '—')],
    ['MB', (r) => (r.outBytes ? (r.outBytes / 1048576).toFixed(1) : '—')],
    ['ok', (r) => (r.ok ? 'yes' : 'NO')],
  ];
  const w = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log('\n' + line(cols.map(([h]) => h)));
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(([, get]) => get(r))));
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ! ${path.basename(r.file)}: ${r.error}`);
  console.log(`\n  Output: ${OUT_DIR}\n  Log:    ${LOG}\n`);
  process.exit(rows.some((r) => !r.ok) ? 1 : 0);
}

main().catch((e) => { console.error('\n  Harness failed:', e.message, '\n'); process.exit(1); });
