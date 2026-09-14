/**
 * Batch background removal, for catalogue production.
 *
 * Posts each picture to the same cutout service the site uses -- our own, on
 * Fly, not a third party -- with the same request shape
 * style-photo-background.mjs sends: POST <CUTOUT_SERVICE_URL>/cutout, a bearer
 * token, JPEG bytes, and the answer read back out of the X-Cutout-Px,
 * X-Alpha-Coverage and X-BBox headers. The contract is matched rather than
 * reinvented, so a cutout made here is the cutout the site would have made.
 *
 * The JPEG re-encode is part of that contract: the serverless path always
 * hands the service a JPEG at quality 90, whatever the styled image was, and
 * the service is documented to take JPEG or PNG. Sending what the site sends
 * keeps the input to the matting model the same.
 *
 * Nothing here touches Sanity, Netlify, Stripe or the live site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync as realSpawnSync } from 'node:child_process';
import 'dotenv/config';
import sharp from 'sharp';
import {
  parseArgs, listImages, listStyledBatch, filterOnly, pool, withRetry, classifyFailure, alreadyDone,
  concurrencyFrom, MAX_CONCURRENCY, DEFAULT_CONCURRENCY, humanMs, writeRunLog,
  readRunTotals, printSummary, requireEnv, sleep as realSleep,
} from './_cli.mjs';

const SPEC = {
  in: 'string', out: 'string', upscale: 'boolean', only: 'string',
  concurrency: 'number', 'dry-run': 'boolean', force: 'boolean', help: 'boolean',
};

/** What the serverless path uses, kept the same on purpose. */
export const CUTOUT_TIMEOUT_MS = 90000;
export const JPEG_QUALITY = 90;
/** The gates the site applies to a result before it will use it. */
export const CUTOUT_MIN_COVERAGE = 0.05;
export const CUTOUT_MAX_COVERAGE = 0.90;
/** What "4K" means here: the longest side, matching the print pipeline. */
export const UPSCALE_TARGET = 3840;

/* Real-ESRGAN ships under a couple of names depending on how it was installed;
   both are looked for before giving up, and giving up says what to install. */
export const UPSCALER_BINARIES = ['realesrgan-ncnn-vulkan', 'realesrgan'];

export const HELP = `
  node tools/builder/cutout.mjs --in <folder-or-file> [options]

  Cuts the background out of every picture given, through the shop's own cutout
  service, and writes one folder per picture.

    --in <folder|file>  a folder of images, a single image, or a batch folder
                        written by style.mjs -- in which case each slug's styled
                        picture is used (the 4K one when there is one). A slug
                        comes from the filename, except for a styled-2k.png or
                        styled-4k.png, whose name is only its size: that takes
                        its slug from the meta.json beside it, or failing that
                        from the folder it sits in. So pointing --in at one
                        picture inside a batch still writes it under its own
                        name
    --out <folder>      where to write <slug>/cutout.png. Defaults to --in when
                        that is a folder, so a styled batch can be cut out in
                        place beside its artwork
    --upscale           after the cutout, upscale to ${UPSCALE_TARGET}px on the longest side
                        with Real-ESRGAN. Needs one of ${UPSCALER_BINARIES.join(' or ')}
                        on PATH; if it is not there this stops and says so
                        rather than quietly writing an un-upscaled file
    --only <a,b,c>      just these slugs, comma separated
    --concurrency <n>   how many at once. Default ${DEFAULT_CONCURRENCY}, hard cap ${MAX_CONCURRENCY}: the service runs
                        one model on one small machine, and past four in flight
                        the queue simply moves inside it
    --dry-run           list what would be cut out. Makes no network call at all
    --force             redo slugs that already have a cutout.png
    --help              this

  Needs CUTOUT_SERVICE_URL and CUTOUT_TOKEN in the environment or in .env at the
  repo root -- the same variables the deployed function reads. The token is
  never printed.

  A result with no transparent pixels is a warning rather than a failure: it
  usually means the matting kept everything, which is worth looking at but is
  still a file you might want.

  Example — cut out three winners from a styled batch:

    node tools/builder/cutout.mjs --in .\\artwork\\batch-7 \`
      --only bruce-lee,tupac,gizmo --upscale
`;

/** Where the upscaler is, or null. */
export function findUpscaler(spawnSync = realSpawnSync) {
  for (const bin of UPSCALER_BINARIES) {
    try {
      const probe = spawnSync(bin, ['-h'], { encoding: 'utf8', windowsHide: true });
      /* -h exits non-zero on some builds, so presence is judged by the process
         having run at all rather than by its status. */
      if (probe && !probe.error) return bin;
    } catch (e) { /* not this one */ }
  }
  return null;
}

export const UPSCALER_MISSING = `
  --upscale needs Real-ESRGAN on PATH and it is not there.

  Install the portable build (no Python, works on a plain Windows box):

    1. Download realesrgan-ncnn-vulkan-*-windows.zip from
       https://github.com/xinntao/Real-ESRGAN/releases
    2. Unzip it somewhere permanent, e.g. C:\\Tools\\realesrgan
    3. Add that folder to PATH:
         setx PATH "$env:PATH;C:\\Tools\\realesrgan"
       then open a new PowerShell window
    4. Check it: realesrgan-ncnn-vulkan -h

  Then run the same command again. Nothing was written, so no cutout is lost.
`;

/** Send one image to the service, exactly as the serverless path does. */
export async function postCutout(bytes, { base, token, fetchFn = fetch, timeoutMs = CUTOUT_TIMEOUT_MS }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${base}/cutout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
      body: bytes,
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`service returned ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const png = Buffer.from(await res.arrayBuffer());
    const coverage = Number(res.headers.get('x-alpha-coverage'));
    const bbox = (res.headers.get('x-bbox') || '').split(',').map(Number);
    const [w, h] = (res.headers.get('x-cutout-px') || '').split('x').map(Number);
    return {
      png,
      coverage: Number.isFinite(coverage) ? coverage : null,
      bbox: bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : null,
      width: Number.isFinite(w) ? w : null,
      height: Number.isFinite(h) ? h : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Does this PNG actually have anything cut out of it? */
export async function transparencyOf(png, sharpFn = sharp) {
  try {
    const img = sharpFn(png);
    const meta = await img.metadata();
    if (!meta.hasAlpha) return { hasAlpha: false, clearFraction: 0 };
    const stats = await img.stats();
    const alpha = stats.channels[stats.channels.length - 1];
    /* A fully opaque alpha channel means nothing was removed. The mean is what
       says how much: 255 is "all kept". */
    return { hasAlpha: true, clearFraction: 1 - (alpha.mean / 255), alphaMin: alpha.min };
  } catch (e) {
    return { hasAlpha: null, clearFraction: null, error: e.message };
  }
}

/**
 * @param {string[]} argv
 * @param {object} deps  injectable for the tests
 */
export async function run(argv, deps = {}) {
  const {
    fetchFn = fetch, sleep = realSleep, log = console.log, error = console.error,
    now = Date.now, spawnSync = realSpawnSync, sharpFn = sharp,
  } = deps;

  const { opts, errors } = parseArgs(argv, SPEC);
  if (opts.help || argv.length === 0) { log(HELP); return 0; }
  if (errors.length) { errors.forEach((e) => error(`  ${e}`)); log(HELP); return 1; }
  if (!opts.in) { error('  --in is required.'); log(HELP); return 1; }

  const dryRun = !!opts['dry-run'];
  const concurrency = concurrencyFrom(opts.concurrency);

  let all;
  try { all = listImages(opts.in); } catch (e) { error(`  ${e.message}`); return 1; }
  /* A styled batch keeps its pictures one level down, under a folder per slug,
     so a folder with no images directly in it is very likely one of those
     rather than a mistake. Looked at before giving up, and said out loud when
     it is what gets used. */
  let fromBatch = false;
  if (!all.length) {
    const batch = listStyledBatch(opts.in);
    if (batch.length) { all = batch; fromBatch = true; }
  }
  const { items, missing } = filterOnly(all, opts.only);
  if (missing.length) error(`  --only named nothing in --in: ${missing.join(', ')}`);
  if (!items.length) { error(`  No images to cut out in ${opts.in}`); return 1; }

  /* Default the output beside the input when the input is a folder, so a
     styled batch gains its cutouts in place: <batch>/<slug>/cutout.png next to
     <batch>/<slug>/styled-2k.png. */
  const inStat = fs.statSync(opts.in);
  const outDir = path.resolve(opts.out || (inStat.isDirectory() ? opts.in : path.dirname(opts.in)));

  const planned = items.map((it) => ({
    ...it,
    outFile: path.join(outDir, it.slug, 'cutout.png'),
    skip: alreadyDone(path.join(outDir, it.slug, 'cutout.png'), opts.force),
  }));
  const todo = planned.filter((p) => !p.skip);

  if (dryRun) {
    log(`\n  DRY RUN — nothing is written and no call is made.\n`);
    log(`  ${items.length} image(s)${fromBatch ? ' from a styled batch' : ''}, `
      + `${concurrency} at a time, upscale ${opts.upscale ? 'on' : 'off'}`);
    for (const p of planned) {
      log(`    ${p.skip ? 'skip   ' : 'cut out'}  ${p.slug.padEnd(28)} ${path.basename(p.file)}`);
    }
    log(`\n  ${todo.length} call(s) would be made, ${planned.length - todo.length} skipped `
      + `(cutout.png already there).\n`);
    return 0;
  }

  let base, token;
  try {
    base = requireEnv('CUTOUT_SERVICE_URL', 'Put it in .env at the repo root, or set it for this session.')
      .replace(/\/+$/, '');
    token = requireEnv('CUTOUT_TOKEN', 'Put it in .env at the repo root, or set it for this session.');
  } catch (e) { error(`\n  ${e.message}\n`); return 1; }

  /* Checked BEFORE any call: finding out the upscaler is missing after twenty
     cutouts have been paid for is the wrong moment. */
  let upscaler = null;
  if (opts.upscale) {
    upscaler = findUpscaler(spawnSync);
    if (!upscaler) { error(UPSCALER_MISSING); return 1; }
  }

  log(`\n  ${todo.length} to cut out, ${planned.length - todo.length} already done, `
    + `${concurrency} at a time`);
  log(`  service ${base}${upscaler ? `  upscaler ${upscaler}` : ''}`);
  if (fromBatch) log('  (reading the styled picture out of each slug folder)');
  log('');

  const started = now();
  let calls = 0;
  const rows = [];

  await pool(todo, concurrency, async (item) => {
    const row = { slug: item.slug, result: 'failed', ms: null, detail: '' };
    const t0 = now();
    try {
      /* The same re-encode the site does before it calls the service. */
      const jpeg = await sharpFn(fs.readFileSync(item.file)).jpeg({ quality: JPEG_QUALITY }).toBuffer();

      const cut = await withRetry(async () => {
        calls++;
        return postCutout(jpeg, { base, token, fetchFn });
      }, {
        sleepFn: sleep,
        onRetry: ({ attempt, wait, reason }) =>
          log(`    ${item.slug}: attempt ${attempt} failed (${reason}), retrying in ${humanMs(wait)}`),
      });

      const dir = path.join(outDir, item.slug);
      fs.mkdirSync(dir, { recursive: true });
      const cutPath = path.join(dir, 'cutout.png');
      fs.writeFileSync(cutPath, cut.png);

      const alpha = await transparencyOf(cut.png, sharpFn);
      const notes = [];
      if (alpha.hasAlpha === false || alpha.clearFraction === 0) {
        notes.push('NO TRANSPARENCY — matting probably failed');
      }
      if (cut.coverage !== null && cut.coverage < CUTOUT_MIN_COVERAGE) notes.push(`kept only ${(cut.coverage * 100).toFixed(1)}%`);
      if (cut.coverage !== null && cut.coverage > CUTOUT_MAX_COVERAGE) notes.push(`removed only ${((1 - cut.coverage) * 100).toFixed(1)}%`);

      let upscaled = null;
      if (upscaler) {
        upscaled = await upscaleTo4K(cutPath, path.join(dir, 'cutout-4k.png'), {
          upscaler, spawnSync, sharpFn,
        });
        if (upscaled.error) notes.push(`upscale failed: ${upscaled.error}`);
      }

      fs.writeFileSync(path.join(dir, 'cutout-meta.json'), JSON.stringify({
        slug: item.slug,
        source: item.file,
        service: base,
        coverage: cut.coverage,
        bbox: cut.bbox,
        outputPx: [cut.width, cut.height],
        bytes: cut.png.length,
        transparency: alpha,
        upscale: upscaled,
        durationMs: now() - t0,
        at: new Date().toISOString(),
        tool: 'tools/builder/cutout.mjs',
      }, null, 1));

      row.result = notes.length ? 'warned' : 'cut';
      row.ms = now() - t0;
      row.detail = [
        `${cut.width ?? '?'}x${cut.height ?? '?'}`,
        cut.coverage !== null ? `coverage ${cut.coverage.toFixed(3)}` : null,
        upscaled && upscaled.px ? `4K ${upscaled.px[0]}x${upscaled.px[1]}` : null,
        ...notes,
      ].filter(Boolean).join(' · ');
      log(`    ${item.slug}: ${humanMs(row.ms)}  ${row.detail}`);
    } catch (err) {
      const { kind, reason } = classifyFailure(err);
      row.result = kind === 'refused' ? 'refused' : 'failed';
      row.ms = now() - t0;
      row.detail = reason;
      log(`    ${item.slug}: ${row.result.toUpperCase()} — ${reason}`);
    }
    rows.push(row);
    return row;
  });

  for (const p of planned.filter((x) => x.skip)) {
    rows.push({ slug: p.slug, result: 'skipped', ms: null, detail: 'cutout.png exists' });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const summary = {
    succeeded: rows.filter((r) => r.result === 'cut' || r.result === 'warned').length,
    warned: rows.filter((r) => r.result === 'warned').length,
    skipped: rows.filter((r) => r.result === 'skipped').length,
    refused: rows.filter((r) => r.result === 'refused').length,
    failed: rows.filter((r) => r.result === 'failed').length,
    calls,
    wallMs: now() - started,
  };

  const runFile = writeRunLog(outDir, {
    tool: 'cutout', at: new Date().toISOString(), concurrency, upscale: !!upscaler,
    in: path.resolve(opts.in), out: outDir, service: base, summary, rows,
  });

  printSummary({
    label: 'Cutout', rows, summary, runFile, outDir,
    totals: readRunTotals(outDir), log,
  });
  if (summary.warned) log(`  ${summary.warned} warned — look at those before using them.\n`);
  return summary.failed ? 1 : 0;
}

/**
 * Upscale a cutout to 4K on the longest side, keeping its alpha.
 *
 * Real-ESRGAN only knows whole-number scales, so the nearest one at or above
 * the target is used and the result is brought back to exactly the target with
 * sharp -- an overshoot then a clean downscale is sharper than asking for too
 * little and stretching.
 */
export async function upscaleTo4K(inPath, outPath, { upscaler, spawnSync, sharpFn = sharp }) {
  try {
    const meta = await sharpFn(inPath).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    if (!longest) return { error: 'could not read the cutout' };
    if (longest >= UPSCALE_TARGET) {
      await sharpFn(inPath).toFile(outPath);
      return { scale: 1, px: [meta.width, meta.height], note: 'already 4K or larger' };
    }
    const scale = Math.min(4, Math.max(2, Math.ceil(UPSCALE_TARGET / longest)));
    const tmp = `${outPath}.tmp.png`;
    const res = spawnSync(upscaler, ['-i', inPath, '-o', tmp, '-s', String(scale)], {
      encoding: 'utf8', windowsHide: true,
    });
    if (res.error) return { error: res.error.message };
    if (res.status !== 0) return { error: `${upscaler} exited ${res.status}: ${String(res.stderr || '').slice(0, 160)}` };
    const up = await sharpFn(tmp).metadata();
    const upLongest = Math.max(up.width || 0, up.height || 0);
    if (upLongest > UPSCALE_TARGET) {
      await sharpFn(tmp)
        .resize(UPSCALE_TARGET, UPSCALE_TARGET, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(outPath);
    } else {
      fs.copyFileSync(tmp, outPath);
    }
    try { fs.unlinkSync(tmp); } catch (e) { /* leave it */ }
    const final = await sharpFn(outPath).metadata();
    return { scale, px: [final.width, final.height], upscaler };
  } catch (e) {
    return { error: e.message };
  }
}

/* pathToFileURL rather than comparing paths: on Windows the two spellings of
   the same file differ by drive-letter case and slash direction, and the
   canonical comparison is the URL. */
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { console.error('\n  cutout.mjs failed:', err.message, '\n'); process.exit(1); });
}
