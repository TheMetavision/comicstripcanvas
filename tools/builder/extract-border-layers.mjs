/**
 * Take the cover border apart into the layers it should have been all along.
 *
 *   node tools/builder/extract-border-layers.mjs [--src FILE] [--out DIR] [--check]
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * background-print.png is a flattened three-colour raster: black line work on
 * two flat regions. Recolouring it meant replacing pixels, and replacing
 * pixels cannot touch the blends along an antialiased edge without guessing
 * what they are blends OF. Whoever produced the current asset did exactly that
 * and left the evidence in it: 99,021 of its 24.4M pixels (0.41%) cannot be
 * explained by any mixture of its own three colours, and 7,152 of those are
 * frankly pink -- residue of a palette this artwork has not had for months. At
 * 400% it reads as a salmon rim around every black stroke.
 *
 * The fix is to stop shipping a flattened raster. Masks composite: black at
 * any opacity over a colour chosen at render time gives correct antialiasing
 * for free, in any colour, for ever.
 *
 * ── How the layers are recovered ───────────────────────────────────────────
 *
 * The geometry in the asset is sound; only the BLEND VALUES are corrupt. That
 * is the whole reason this can be automated. So:
 *
 *   1. Decide, per pixel, whether it is line work, and which region it sits on.
 *      A contaminated pixel is still obviously dark-or-not and obviously
 *      nearer one region than the other, so it classifies correctly even
 *      though its exact value is wrong.
 *
 *   2. Throw the blend values away and regenerate them. The binary decision
 *      has hard, stair-stepped edges; upsampling it with a smooth kernel and
 *      re-thresholding puts the boundary back at sub-pixel accuracy, and
 *      box-averaging that back down produces clean antialiasing that owes
 *      nothing to the old palette.
 *
 * Step 2 is done in horizontal strips. At 4x a full-frame intermediate is
 * 16800 x 23200 -- 390 MB for one channel -- and this machine has been killed
 * for less. Strips with an overlap cost 40 MB and produce identical output,
 * because resampling is local.
 *
 * ── What it writes ─────────────────────────────────────────────────────────
 *
 *   cover-border/line.png      8-bit alpha: how much black is at this pixel
 *   cover-border/region-a.png  8-bit alpha: the darker flat region
 *   cover-border/region-b.png  8-bit alpha: the lighter flat region
 *
 * The regions partition the frame, so region-a is the base fill and region-b
 * is laid over it; both are kept rather than deriving one from the other,
 * because a reader should be able to open either and see what it is.
 *
 * Read-only with respect to the source. Regenerable: this script is the asset.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { parseArgs } from './_cli.mjs';

const SPEC = { src: 'string', out: 'string', check: 'boolean', scale: 'number', help: 'boolean' };

export const DEFAULT_SRC = 'public/builder/templates/comic-cover/background-print.png';
export const DEFAULT_OUT = 'public/builder/templates/cover-border';

/** How far the supersample goes. 4 gives 17 alpha levels, which is plenty. */
export const SUPERSAMPLE = 4;
/** Rows per strip before padding. 4200 x 600 x 16 subpixels is about 40 MB. */
export const STRIP_ROWS = 600;
/** Overlap each side, so a strip's edge is never the edge of a resample. */
export const STRIP_PAD = 8;
/** Long side of the browser's copies, matching the existing background.png. */
export const SCREEN_LONG_SIDE = 1200;

export const HELP = `
  node tools/builder/extract-border-layers.mjs [options]

    --src FILE    flattened border artwork (default ${DEFAULT_SRC})
    --out DIR     where the layers go (default ${DEFAULT_OUT})
    --scale N     supersample factor (default ${SUPERSAMPLE})
    --check       also write 400% spot-checks of the starburst points
    --help

  Writes line.png, region-a.png and region-b.png: single-channel masks to be
  composited under chosen colours, instead of a flattened raster to be
  pixel-replaced.
`;

/* ------------------------------------------------------------ the palette */

/**
 * The three colours the artwork is actually made of.
 *
 * Taken from the image rather than hardcoded, so this still works if the
 * source is regenerated. Quantised coarsely to gather each flat region into
 * one bin despite its blends, then the bin's true mean is measured.
 */
export function findPalette(data, w, h, channels) {
  const bins = new Map();
  const n = w * h;
  for (let i = 0; i < n; i += 5) {
    const j = i * channels;
    const k = ((data[j] >> 5) << 10) | ((data[j + 1] >> 5) << 5) | (data[j + 2] >> 5);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  /* The bin centres are coarse; measure each bin's real mean so the colours
     written into the defaults are the artwork's, not the quantiser's. */
  const sum = top.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i += 5) {
    const j = i * channels;
    const k = ((data[j] >> 5) << 10) | ((data[j + 1] >> 5) << 5) | (data[j + 2] >> 5);
    const b = top.indexOf(k);
    if (b < 0) continue;
    sum[b][0] += data[j]; sum[b][1] += data[j + 1]; sum[b][2] += data[j + 2]; sum[b][3]++;
  }
  const cols = sum.map((s) => [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])]);
  cols.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  return cols;            // darkest first: [line, regionA, regionB]
}

export const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Per pixel: is this line work, and which region is it on?
 *
 * Deliberately a decision and not a measurement. The pixel's exact value may
 * be contaminated; whether it is dark, and which of two well-separated colours
 * it is nearer, survives that.
 *
 * Returns { line: Uint8Array (0|1), region: Uint8Array (0|1) } where region 1
 * means the lighter of the two flat colours.
 */
export function classify(data, w, h, channels, palette) {
  const [L, A, B] = palette;
  const n = w * h;
  const alpha = new Uint8Array(n);      // how much line work, 0-255
  const region = new Uint8Array(n);     // 1 = the lighter flat colour
  const known = new Uint8Array(n);      // 1 = the region label is trustworthy

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const lumL = lum(L[0], L[1], L[2]);

  /* Chromaticity, not colour. A pixel half-covered by a black stroke keeps its
     hue and loses its brightness, so comparing raw RGB puts darkened YELLOW
     nearer to green than to yellow -- (124,112,24) really is closer to
     #368975 than to #fce534 by plain distance. That mislabelling is what put a
     teal rim down the black/yellow boundaries on the first attempt. Dividing
     out the brightness removes it. */
  const chroma = (r, g, b) => { const s = r + g + b || 1; return [r / s, g / s]; };
  const cA = chroma(A[0], A[1], A[2]);
  const cB = chroma(B[0], B[1], B[2]);

  for (let i = 0; i < n; i++) {
    const j = i * channels;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const y = lum(r, g, b);

    /* Coverage, measured rather than decided. The pixel is a blend of the line
       colour and whatever flat colour it sits on, so its brightness relative
       to that flat colour IS the coverage. Feeding this graded value into the
       supersample -- instead of a 0/1 decision -- is what keeps the tapered
       points of the starburst: a binary input has already thrown away the
       sub-pixel position that the resample would otherwise recover, and the
       first attempt bit the tips off. */
    const [px, py] = chroma(r, g, b);
    const dA = (px - cA[0]) ** 2 + (py - cA[1]) ** 2;
    const dB = (px - cB[0]) ** 2 + (py - cB[1]) ** 2;
    const nearB = dB < dA;
    region[i] = nearB ? 1 : 0;

    const host = nearB ? B : A;
    const lumHost = lum(host[0], host[1], host[2]);
    const t = lumHost > lumL ? 1 - (y - lumL) / (lumHost - lumL) : 0;
    alpha[i] = Math.max(0, Math.min(255, Math.round(t * 255)));

    /* Only a pixel that is mostly flat colour can vouch for which region it is
       on. Anything substantially under a stroke is left unknown and gets its
       label grown in from its neighbours, which is both more reliable and the
       only correct answer for a pixel that is pure black. */
    known[i] = alpha[i] < 64 ? 1 : 0;
  }
  return { alpha, region, known };
}

/**
 * A region label is meaningless under the line work -- the pixel is black, and
 * which flat colour sits beneath it is not in the pixel. Grow the labels from
 * the pixels that do know, so the region masks meet cleanly under a stroke
 * instead of splitting along it.
 */
export function fillUnderLines(region, known, w, h, passes = 40) {
  const reg = Uint8Array.from(region);
  let cur = Uint8Array.from(known);
  for (let p = 0; p < passes; p++) {
    let changed = 0;
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        let votes = 0, tally = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            const k = yy * w + xx;
            if (!cur[k]) continue;
            votes++; tally += reg[k];
          }
        }
        if (votes) { reg[i] = tally * 2 >= votes ? 1 : 0; next[i] = 1; changed++; }
      }
    }
    cur = next;
    if (!changed) break;
  }
  return reg;
}

/**
 * Hard edges in, clean antialiasing out.
 *
 * Upsample with a smooth kernel so the boundary is interpolated, re-threshold
 * so it becomes a crisp sub-pixel curve rather than a ramp, then box-average
 * back down so each output pixel reports how much of it the shape covers.
 * That last step is the antialiasing, computed from geometry alone.
 */
export async function supersampleMask(bits, w, h, { scale = SUPERSAMPLE, rows = STRIP_ROWS, pad = STRIP_PAD, graded = false, onStrip = null } = {}) {
  const out = new Uint8Array(w * h);
  for (let y0 = 0; y0 < h; y0 += rows) {
    const y1 = Math.min(h, y0 + rows);
    const py0 = Math.max(0, y0 - pad), py1 = Math.min(h, y1 + pad);
    const ph = py1 - py0;

    /* A graded input carries sub-pixel position already; a label map does not
       and only has two states to offer. */
    const strip = Buffer.alloc(w * ph);
    for (let i = 0; i < w * ph; i++) {
      const v = bits[py0 * w + i];
      strip[i] = graded ? v : (v ? 255 : 0);
    }

    /* threshold() hands back THREE channels, not one -- it promotes to sRGB on
       the way. Reading the stride off the result rather than assuming it is
       the difference between clean antialiasing and fine horizontal banding,
       which is what assuming 1 produced: the box average below was walking
       across neighbouring pixels' red bytes instead of down the block. */
    const { data: big, info: bigInfo } = await sharp(strip, { raw: { width: w, height: ph, channels: 1 } })
      .resize(w * scale, ph * scale, { kernel: 'cubic' })
      .threshold(128)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bc = bigInfo.channels;

    /* Exact box average of each scale x scale block. sharp has no box kernel,
       and an approximate one here would put a bias into every edge. */
    const area = scale * scale;
    for (let y = y0; y < y1; y++) {
      const sy = (y - py0) * scale;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let by = 0; by < scale; by++) {
          const row = ((sy + by) * w * scale + x * scale) * bc;
          for (let bx = 0; bx < scale; bx++) acc += big[row + bx * bc] ? 1 : 0;
        }
        out[y * w + x] = Math.round((acc / area) * 255);
      }
    }
    if (onStrip) onStrip(y1, h);
  }
  return out;
}

const writeMask = (buf, w, h, file) =>
  sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 1 } }).png({ compressionLevel: 9 }).toFile(file);

export async function run(argv, deps = {}) {
  const { log = console.log, error = console.error } = deps;
  const { opts, errors } = parseArgs(argv, SPEC);
  if (opts.help) { log(HELP); return 0; }
  if (errors.length) { errors.forEach((e) => error(`  ${e}`)); log(HELP); return 1; }

  const src = opts.src || DEFAULT_SRC;
  const outDir = opts.out || DEFAULT_OUT;
  const scale = Math.max(2, Math.min(8, Math.round(opts.scale ?? SUPERSAMPLE)));
  if (!fs.existsSync(src)) { error(`  no such file: ${src}`); return 1; }
  fs.mkdirSync(outDir, { recursive: true });

  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  log(`  source ${w}x${h}, ${ch} channels`);

  const palette = findPalette(data, w, h, ch);
  log(`  palette  line ${hex(palette[0])}   region-a ${hex(palette[1])}   region-b ${hex(palette[2])}`);

  const { alpha, region, known } = classify(data, w, h, ch, palette);
  let inked = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 128) inked++;
  log(`  line work covers ${(100 * inked / (w * h)).toFixed(2)}% of the frame`);

  const filled = fillUnderLines(region, known, w, h);

  log(`  regenerating antialiasing at ${scale}x, in strips`);
  const lineMask = await supersampleMask(alpha, w, h, { scale, graded: true, onStrip: (d, t) => { if (d % 3000 === 0 || d === t) log(`    line   ${d}/${t}`); } });
  const bMask = await supersampleMask(filled, w, h, { scale, onStrip: (d, t) => { if (d % 3000 === 0 || d === t) log(`    region ${d}/${t}`); } });
  const aMask = new Uint8Array(w * h);
  for (let i = 0; i < aMask.length; i++) aMask[i] = 255 - bMask[i];

  await writeMask(lineMask, w, h, path.join(outDir, 'line-print.png'));
  await writeMask(aMask, w, h, path.join(outDir, 'region-a-print.png'));
  await writeMask(bMask, w, h, path.join(outDir, 'region-b-print.png'));

  /* A screen pair as well, the same way the flattened artwork has always had
     background.png beside background-print.png. The builder previews at canvas
     size and must not pull 24 megapixels of mask per layer to do it. Downscaled
     with a proper filter, so the alpha stays graded rather than re-aliased. */
  const screenW = Math.round(w * (SCREEN_LONG_SIDE / Math.max(w, h)));
  const screenH = Math.round(h * (SCREEN_LONG_SIDE / Math.max(w, h)));
  for (const [name, mask] of [['line', lineMask], ['region-a', aMask], ['region-b', bMask]]) {
    await sharp(Buffer.from(mask), { raw: { width: w, height: h, channels: 1 } })
      .resize(screenW, screenH, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(path.join(outDir, `${name}.png`));
  }
  log(`  screen masks at ${screenW}x${screenH}`);

  const meta = {
    source: src,
    generatedBy: 'tools/builder/extract-border-layers.mjs',
    size: [w, h],
    supersample: scale,
    palette: { line: hex(palette[0]), regionA: hex(palette[1]), regionB: hex(palette[2]) },
  };
  fs.writeFileSync(path.join(outDir, 'palette.json'), JSON.stringify(meta, null, 2) + '\n');

  log(`  wrote {line,region-a,region-b}{,-print}.png and palette.json to ${outDir}`);

  if (opts.check) {
    const file = path.join(outDir, 'spot-check-400pct.png');
    await spotCheck({ src, w, h, lineMask, bMask, palette, out: file });
    log(`  wrote ${file}`);
  }
  return 0;
}

/**
 * The starburst points, before and after, at 400%.
 *
 * The points are where this is most likely to have gone wrong: a ray tapers to
 * a stroke a pixel or two across, and a binarise-then-resample can bite a
 * taper off entirely. So the check looks at the thinnest line work it can
 * find rather than at a comfortable straight edge.
 */
export async function spotCheck({ src, w, h, lineMask, bMask, palette, out, crop = 90, cols = 3 }) {
  const [L, A, B] = palette;

  /* Composite the layers the way a renderer will. */
  const after = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const tb = bMask[i] / 255, tl = lineMask[i] / 255;
    for (let c = 0; c < 3; c++) {
      const region = A[c] * (1 - tb) + B[c] * tb;
      after[i * 3 + c] = Math.round(region * (1 - tl) + L[c] * tl);
    }
  }

  /* Thin line work: a line pixel with few line neighbours is a taper or a
     point. Score coarse windows by how many of those they hold. */
  const best = [];
  const step = crop;
  for (let y = 0; y + crop < h; y += step) {
    for (let x = 0; x + crop < w; x += step) {
      let thin = 0;
      for (let yy = y + 2; yy < y + crop - 2; yy += 2) {
        for (let xx = x + 2; xx < x + crop - 2; xx += 2) {
          const i = yy * w + xx;
          if (lineMask[i] < 128) continue;
          let nb = 0;
          for (let d = -2; d <= 2; d += 2) {
            if (lineMask[i + d] >= 128) nb++;
            if (lineMask[i + d * w] >= 128) nb++;
          }
          if (nb <= 5) thin++;
        }
      }
      if (thin > 0) best.push({ x, y, thin });
    }
  }
  best.sort((a, b) => b.thin - a.thin);

  /* Spread the picks out: the densest windows cluster on one ray otherwise. */
  const picks = [];
  for (const c of best) {
    if (picks.length >= cols * 2) break;
    if (picks.some((p) => Math.abs(p.x - c.x) < crop * 6 && Math.abs(p.y - c.y) < crop * 6)) continue;
    picks.push(c);
  }

  const Z = 4, tile = crop * Z, gap = 10, label = 22;
  const sheetW = cols * (tile * 2 + gap) + gap * (cols + 1);
  const rows = Math.ceil(picks.length / cols);
  const sheetH = rows * (tile + label + gap) + gap + label;
  const comp = [];
  const svg = [`<svg width="${sheetW}" height="${sheetH}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect width="100%" height="100%" fill="#15171a"/>`,
    `<text x="${gap}" y="18" fill="#eee" font-family="monospace" font-size="13">starburst points at 400% — left: current flattened asset, right: composited layers</text>`];

  const afterImg = sharp(after, { raw: { width: w, height: h, channels: 3 } });
  for (let i = 0; i < picks.length; i++) {
    const { x, y } = picks[i];
    const region = { left: x, top: y, width: crop, height: crop };
    const a = await sharp(src).extract(region).resize(tile, tile, { kernel: 'nearest' }).png().toBuffer();
    const b = await afterImg.clone().extract(region).resize(tile, tile, { kernel: 'nearest' }).png().toBuffer();
    const cx = gap + (i % cols) * (tile * 2 + gap + gap);
    const cy = label + gap + Math.floor(i / cols) * (tile + label + gap);
    comp.push({ input: a, left: cx, top: cy });
    comp.push({ input: b, left: cx + tile + gap, top: cy });
    svg.push(`<text x="${cx}" y="${cy + tile + 15}" fill="#8a8" font-family="monospace" font-size="11">at ${x},${y}</text>`);
  }
  svg.push('</svg>');
  await sharp(Buffer.from(svg.join(''))).composite(comp).png().toFile(out);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invoked) run(process.argv.slice(2)).then((c) => { process.exitCode = c; });
