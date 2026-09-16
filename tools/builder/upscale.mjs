/**
 * Bring a folder of finished artwork up to a print resolution.
 *
 *   node tools/builder/upscale.mjs --in <folder> [options]
 *
 * No cutout, no service call, no API key: this is Real-ESRGAN on the local GPU
 * and sharp, over files that are already the picture we want to sell.
 *
 * Two routes to the same target, because they are not the same problem:
 *
 *   a file well under the target      run the model at its native 4x, then come
 *                                     back down to the target with Lanczos
 *   a file just under the target      resize only -- no model at all
 *
 * The second route exists because most of the library sits at 3504x2336, which
 * is 96 pixels short of a 24x16" poster at 150 DPI. Asking a neural network to
 * invent 3504 -> 14016 -> 3600 for a 2.7% stretch costs seventeen seconds and
 * buys nothing a resampler would not do better: the model's output is going to
 * be thrown away in the downscale anyway. The margin is a fraction of the
 * target rather than a pixel count, so it scales with --target.
 *
 * Written in place, which is the point -- these files are the library, in the
 * folders the shop reads. The original is kept beside the result as
 * <name>-original<ext>, byte for byte, and that backup doubles as the resume
 * marker: a file that has one has already been through.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync as realSpawnSync } from 'node:child_process';
import sharp from 'sharp';
import {
  parseArgs, slugFor, filterOnly, pool, withRetry, classifyFailure, concurrencyFrom,
  IMAGE_EXTS, humanMs, writeRunLog, readRunTotals, printSummary, printTable,
  sleep as realSleep,
} from './_cli.mjs';

const SPEC = {
  in: 'string', target: 'number', only: 'string', model: 'string', ext: 'string',
  concurrency: 'number', 'dry-run': 'boolean', force: 'boolean', help: 'boolean',
};

/** A 24x16" poster at 150 DPI, plus the odd pixel. The default, not a rule. */
export const DEFAULT_TARGET = 3600;

/* realesrgan-x4plus is the general-purpose photographic model. The binary's
   own default is realesr-animevideov3 -- trained on anime video frames, and
   the wrong thing to point at painted artwork -- so -n is always passed. */
export const DEFAULT_MODEL = 'realesrgan-x4plus';

/** Every model in this build is a 4x network. -s 2 and -s 3 exist, but they
    are the same 4x pass with the binary's own downsample bolted on, and sharp
    does that part better. So: always 4x, then Lanczos. */
export const MODEL_SCALE = 4;

/** At or above this fraction of the target, resize instead of inventing. */
export const RESIZE_ONLY_FRACTION = 0.90;

/** Folders never walked into: the archive, and our own run logs. */
export const SKIP_DIRS = ['old design'];

export const ORIGINAL_SUFFIX = '-original';

/** A 4x pass on a big file is tens of seconds; this is the runaway guard. */
export const UPSCALER_TIMEOUT_MS = 10 * 60 * 1000;

export const UPSCALER_BINARIES = ['realesrgan-ncnn-vulkan', 'realesrgan'];

export const HELP = `
  node tools/builder/upscale.mjs --in <folder> [options]

    --in <folder>       walked recursively. "Old design" subfolders are left
                        alone, and so is anything already ending ${ORIGINAL_SUFFIX}
    --target <px>       longest side to reach, default ${DEFAULT_TARGET}
    --model <name>      default ${DEFAULT_MODEL}. Also installed:
                        realesrgan-x4plus-anime (faster, flatter),
                        realesr-animevideov3, realesrnet-x4plus
    --ext png[,jpg]     only these kinds. Default: every image. Worth setting
                        when a folder holds mockups and reference shots as well
                        as artwork
    --only <slug,slug>  just these, matched on the filename
    --concurrency <n>   default 1. This is one GPU; more at once is not faster
    --dry-run           say what would happen, touch nothing
    --force             do it again even where a ${ORIGINAL_SUFFIX} backup says it
                        has already been done. The backup is never overwritten,
                        and a redo always starts from it rather than from the
                        previous result
    --help

  Example — take the icon library to a 24x16" poster at 150 DPI:

    node tools/builder/upscale.mjs \`
      --in "C:\\Users\\chris\\Documents\\Comic Strip Canvas\\Comic Icons" --dry-run
`;

export const UPSCALER_MISSING = `
  upscale.mjs needs Real-ESRGAN on PATH and it is not there.

  Install the portable build (no Python, works on a plain Windows box):

    1. Download realesrgan-ncnn-vulkan-*-windows.zip from
       https://github.com/xinntao/Real-ESRGAN/releases
    2. Unzip it somewhere permanent, e.g. C:\\Tools\\realesrgan
    3. Add that folder to PATH:
         setx PATH "$env:PATH;C:\\Tools\\realesrgan"
       then open a new PowerShell window
    4. Check it: realesrgan-ncnn-vulkan -h

  Nothing was read or written, so nothing is lost.
`;

/* --------------------------------------------------------------- the binary */

/**
 * Where the upscaler is -- the executable AND the folder it lives in.
 *
 * The folder is the reason this does not just probe with -h the way cutout.mjs
 * used to. The binary's -m defaults to "models" RELATIVE TO THE WORKING
 * DIRECTORY, not to the executable, so running it from anywhere except its own
 * folder fails to find the very models shipped beside it. Resolving the full
 * path here means -m can be passed explicitly and the tool works from any CWD.
 *
 * @returns {{bin: string, dir: string, models: string} | null}
 */
export function locateUpscaler(spawnSync = realSpawnSync) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of UPSCALER_BINARIES) {
    try {
      const r = spawnSync(finder, [name], { encoding: 'utf8', windowsHide: true });
      if (!r || r.error || r.status !== 0) continue;
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (!first) continue;
      const dir = path.dirname(first);
      return { bin: first, dir, models: path.join(dir, 'models') };
    } catch (e) { /* not this one */ }
  }
  return null;
}

/**
 * Is this model actually installed?
 *
 * Checked against the files on disk rather than a hardcoded list, because the
 * answer is whatever is in that folder. animevideov3 is the odd one: it ships
 * as three separate networks, one per scale, so its param file carries the
 * scale in the name.
 */
export function modelInstalled(models, name, exists = fs.existsSync) {
  return exists(path.join(models, `${name}.param`))
    || exists(path.join(models, `${name}-x${MODEL_SCALE}.param`));
}

/** Models found beside the binary, for an error message worth reading. */
export function installedModels(models, readdir = fs.readdirSync) {
  let names = [];
  try { names = readdir(models); } catch (e) { return []; }
  const out = new Set();
  for (const f of names) {
    const m = /^(.+?)(-x\d)?\.param$/.exec(f);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------- the walking */

const isOriginal = (file) =>
  path.basename(file, path.extname(file)).toLowerCase().endsWith(ORIGINAL_SUFFIX);

export const STAGED_SUFFIX = '.upscale-new';
export const TMP_SUFFIX = '.upscale-tmp';

/* A working file, not artwork. Without this they are picked up as images in
   their own right -- `cat.upscale-new.png` has a .png extension and does not
   end in -original -- and the tool would cheerfully upscale its own scratch. */
const isWorkFile = (name) => {
  const stem = path.basename(name, path.extname(name)).toLowerCase();
  return stem.endsWith(STAGED_SUFFIX) || stem.endsWith(TMP_SUFFIX);
};

/** The primary file a staged result belongs to. */
export function primaryForStaged(stagedPath) {
  const ext = path.extname(stagedPath);
  const stem = path.basename(stagedPath, ext);
  if (!stem.toLowerCase().endsWith(STAGED_SUFFIX)) return null;
  return path.join(path.dirname(stagedPath), stem.slice(0, -STAGED_SUFFIX.length) + ext);
}

/**
 * Every image under `root`, recursively.
 *
 * Three things are stepped over, each for its own reason: "Old design" holds
 * the superseded artwork and upscaling it would be work spent on pictures the
 * shop does not show; a leading underscore is this repo's mark for tooling
 * folders, including the _runs log this tool writes; and a -original file is a
 * backup we made ourselves, so walking into it would upscale an upscale.
 */
export function listArtwork(root, deps = {}) {
  const { readdir = fs.readdirSync, exts = IMAGE_EXTS } = deps;
  const want = new Set(exts.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  const skip = new Set(SKIP_DIRS.map((s) => s.toLowerCase()));
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name.toLowerCase()) || e.name.startsWith('_')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!want.has(path.extname(e.name).toLowerCase())) continue;
      if (isOriginal(e.name) || isWorkFile(e.name)) continue;
      out.push({
        file: full,
        rel: path.relative(root, full),
        slug: slugFor(path.basename(e.name, path.extname(e.name))),
      });
    }
  };
  walk(root);
  return out;
}

/** Where this file's backup lives, and therefore whether it has been done. */
export const originalFor = (file) =>
  path.join(path.dirname(file), `${path.basename(file, path.extname(file))}${ORIGINAL_SUFFIX}${path.extname(file)}`);

/**
 * Every staged result left behind by a run that could not put it in place.
 *
 * Walks the same folders as listArtwork -- same exclusions, same reasons -- and
 * looks only at the working files it deliberately skips.
 */
export function listStaged(root, deps = {}) {
  const { readdir = fs.readdirSync } = deps;
  const skip = new Set(SKIP_DIRS.map((s) => s.toLowerCase()));
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name.toLowerCase()) || e.name.startsWith('_')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const stem = path.basename(e.name, path.extname(e.name)).toLowerCase();
      if (stem.endsWith(STAGED_SUFFIX)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Put back what a lock stopped last time.
 *
 * A staged file is promoted only when all of it holds:
 *
 *   - it has a -original beside it, so a run really did get as far as taking
 *     the backup and the primary name really is the one it belongs to;
 *   - the primary is missing, or older than the staged file, so promoting it
 *     cannot bury newer work;
 *   - sharp can read it and it is AT the target, so a partial write or a
 *     result from a run with a different --target is left alone rather than
 *     quietly installed.
 *
 * Anything that fails those is reported and left exactly where it is. This is
 * a recovery, and a recovery that guesses is worse than one that does nothing.
 */
export async function promoteStaged(root, {
  target, fsFn = fs, sharpFn = sharp, sleepFn = realSleep, log = () => {},
} = {}) {
  const promoted = [], skipped = [];
  for (const staged of listStaged(root)) {
    const primary = primaryForStaged(staged);
    if (!primary) continue;
    const backup = originalFor(primary);
    const rel = path.relative(root, staged);

    if (!fsFn.existsSync(backup)) { skipped.push({ staged: rel, why: 'no -original beside it' }); continue; }

    let meta;
    try { meta = await sharpFn(staged).metadata(); }
    catch (e) { skipped.push({ staged: rel, why: `unreadable: ${e.message}` }); continue; }
    const long = Math.max(meta.width || 0, meta.height || 0);
    if (long !== target) { skipped.push({ staged: rel, why: `${meta.width}x${meta.height} is not at ${target}` }); continue; }

    if (fsFn.existsSync(primary)) {
      let older = false;
      try { older = fsFn.statSync(primary).mtimeMs < fsFn.statSync(staged).mtimeMs; }
      catch (e) { skipped.push({ staged: rel, why: `could not compare times: ${e.message}` }); continue; }
      if (!older) { skipped.push({ staged: rel, why: 'the file in place is newer' }); continue; }
      try { fsFn.unlinkSync(primary); }
      catch (e) { skipped.push({ staged: rel, why: `could not clear the older file: ${e.message}` }); continue; }
    }

    try {
      await renameWithRetry(staged, primary, { fsFn, sleepFn });
      promoted.push({ file: path.relative(root, primary), px: [meta.width, meta.height] });
    } catch (e) {
      skipped.push({ staged: rel, why: `still locked: ${e.code || e.message}` });
    }
  }
  return { promoted, skipped };
}

/* --------------------------------------------------------------- the plan */

/** The same shape, scaled so the LONGEST side lands exactly on `longTarget`. */
export function fitLong(width, height, longTarget) {
  const long = Math.max(width, height);
  if (!long) return [0, 0];
  const k = longTarget / long;
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

/**
 * What to do with one file, given its size and the target.
 *
 *   skip     already at or past the target
 *   resize   close enough that the model has nothing to add
 *   model    a 4x pass, then down to the target
 *
 * `reachable` is false when 4x still does not get there. It is reported rather
 * than chained: a second pass over a first pass compounds the model's own
 * invention, and the result looks worse than the honest shortfall.
 */
export function planFor({ width, height }, target, fraction = RESIZE_ONLY_FRACTION) {
  const long = Math.max(width || 0, height || 0);
  if (!long) return { action: 'failed', reason: 'no dimensions' };
  if (long >= target) {
    return { action: 'skip', long, from: [width, height], to: [width, height], reason: 'already at or above target' };
  }
  const base = { long, from: [width, height], factor: target / long };
  if (long >= target * fraction) {
    return { ...base, action: 'resize', to: fitLong(width, height, target), reachable: true };
  }
  const reachable = long * MODEL_SCALE >= target;
  return {
    ...base,
    action: 'model',
    reachable,
    /* Unreachable in one pass: the 4x output is kept as it falls, which is
       still a large improvement, and the shortfall is reported. */
    to: reachable ? fitLong(width, height, target) : [width * MODEL_SCALE, height * MODEL_SCALE],
  };
}

/* -------------------------------------------------------------- the doing */

/* ---------------------------------------------------- the Windows lock */

/**
 * Windows hands a file to a virus scanner and to Explorer's thumbnailer the
 * moment it is closed, and for the fraction of a second they hold it open a
 * rename onto it fails. It is not a fault -- the file is fine and the next
 * attempt works -- but it arrives as an exception like any other.
 *
 * Observed in production: six of twenty-two files in one run failed on the
 * final rename with EBUSY, all of them large PNGs that sharp had just written.
 */
export const isLockError = (err) => err?.code === 'EBUSY' || err?.code === 'EPERM';

/** Attempts and the first backoff; 5 over 100+200+400+800 ms is about 1.5s. */
export const RENAME_ATTEMPTS = 5;
export const RENAME_BACKOFF_MS = 100;

/**
 * Rename, waiting out a lock.
 *
 * @returns {Promise<number>} which attempt succeeded, so a caller can say so
 */
export async function renameWithRetry(from, to, {
  fsFn = fs, sleepFn = realSleep, attempts = RENAME_ATTEMPTS, base = RENAME_BACKOFF_MS, onRetry = null,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      fsFn.renameSync(from, to);
      return attempt;
    } catch (err) {
      if (!isLockError(err) || attempt >= attempts) throw err;
      const wait = base * (2 ** (attempt - 1));
      if (onRetry) onRetry({ attempt, wait, code: err.code });
      await sleepFn(wait);
    }
  }
}

/** A GPU that has run out of room is worth asking again; a bad PNG is not. */
export function classifyUpscaleFailure(err) {
  const message = String(err?.message || err || '');
  /* A lock that outlasted the rename retries is still a lock, not a verdict on
     the file -- so the outer retry gets a turn at it too. */
  if (isLockError(err)) return { kind: 'transient', reason: `${err.code}: file locked by another process` };
  if (/vulkan|vkallocate|out of (device |host )?memory|device lost|allocation failed|VK_ERROR/i.test(message)) {
    return { kind: 'transient', reason: message.slice(0, 120) };
  }
  return classifyFailure(err);
}

/**
 * One file, in place.
 *
 * The order at the end is deliberate. The backup is taken BEFORE the result
 * replaces the file, so an interruption leaves the original somewhere findable
 * rather than half a picture where the artwork used to be. And the source of a
 * redo is the backup when there is one: --force must not upscale an upscale.
 */
export async function upscaleFile(item, plan, opts) {
  const {
    bin, models, model, target, spawnSync = realSpawnSync, sharpFn = sharp, fsFn = fs,
    sleepFn = realSleep, onLockRetry = null,
  } = opts;

  const file = item.file;
  const ext = path.extname(file);
  const backup = originalFor(file);
  const hadBackup = fsFn.existsSync(backup);
  const source = hadBackup ? backup : file;

  const stem = path.join(path.dirname(file), path.basename(file, ext));
  const tmp = `${stem}.upscale-tmp.png`;
  const staged = `${stem}.upscale-new${ext}`;
  const drop = (f) => { try { if (fsFn.existsSync(f)) fsFn.unlinkSync(f); } catch (e) { /* leave it */ } };

  /* Set the moment the staged file has been written AND read back at its full
     size. Before that it is a partial write and worth nothing; after it, it is
     the finished result and must outlive any failure. */
  let stagedReady = false;

  try {
    let interim = source;
    let modelMs = 0;

    if (plan.action === 'model') {
      const t0 = Date.now();
      const args = ['-i', source, '-o', tmp, '-n', model, '-s', String(MODEL_SCALE), '-m', models];
      const res = spawnSync(bin, args, {
        encoding: 'utf8', windowsHide: true, timeout: UPSCALER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
      modelMs = Date.now() - t0;
      if (res.error) throw new Error(`${path.basename(bin)}: ${res.error.message}`);
      if (res.status !== 0 || !fsFn.existsSync(tmp)) {
        throw new Error(`${path.basename(bin)} exited ${res.status}: ${String(res.stderr || '').trim().slice(0, 200)}`);
      }
      interim = tmp;
    }

    /* fit:'fill' with both sides given, not fit:'inside': the two dimensions
       were worked out together from one ratio, so they already hold the shape.
       'inside' would re-derive them and can land a pixel short of the target,
       which is the whole thing we are here to clear. */
    const [w, h] = plan.to;
    const interimMeta = await sharpFn(interim).metadata();
    if (interimMeta.width === w && interimMeta.height === h) {
      fsFn.copyFileSync(interim, staged);
    } else {
      const pipe = sharpFn(interim).resize(w, h, { kernel: 'lanczos3', fit: 'fill' });
      await (/\.jpe?g$/i.test(ext) ? pipe.jpeg({ quality: 95 }) : /\.webp$/i.test(ext) ? pipe.webp({ quality: 95 }) : pipe.png())
        .toFile(staged);
    }

    const final = await sharpFn(staged).metadata();
    stagedReady = true;

    /* The backup FIRST, so an interruption leaves the original findable. From
       here the primary name is empty and `staged` is the only copy of the
       result -- which is why the catch below must not touch it. */
    if (!hadBackup) fsFn.renameSync(file, backup);
    await renameWithRetry(staged, file, {
      fsFn, sleepFn, onRetry: onLockRetry ? (info) => onLockRetry({ ...info, file }) : null,
    });
    drop(tmp);

    return {
      action: plan.action,
      from: plan.from,
      to: [final.width, final.height],
      bytes: fsFn.statSync(file).size,
      model: plan.action === 'model' ? model : null,
      modelMs,
      reachable: plan.reachable !== false,
      backup: path.basename(backup),
      redone: hadBackup,
    };
  } catch (err) {
    /* The model's intermediate always goes: it is huge and regenerable. */
    drop(tmp);

    if (!stagedReady) {
      /* A partial write is worse than nothing -- left on disk it would look
         like a finished result to the promotion pass on the next run. */
      drop(staged);
      throw err;
    }

    /* Finished, but not in place. This used to be deleted here, and the only
       reason a production run did not lose six upscales to that line is that
       the same lock which blocked the rename also blocked the delete. The
       result stays; the next run promotes it. */
    err.stagedAt = staged;
    err.recoverable = true;
    throw err;
  }
}

/* --------------------------------------------------------------- the run */

export async function run(argv, deps = {}) {
  const {
    log = console.log, error = console.error, now = Date.now,
    spawnSync = realSpawnSync, sharpFn = sharp, sleep = realSleep,
  } = deps;

  const { opts, errors } = parseArgs(argv, SPEC);
  if (opts.help || argv.length === 0) { log(HELP); return 0; }
  if (errors.length) { errors.forEach((e) => error(`  ${e}`)); log(HELP); return 1; }
  if (!opts.in) { error('  --in is required.'); log(HELP); return 1; }

  const target = Math.round(opts.target ?? DEFAULT_TARGET);
  if (!Number.isFinite(target) || target < 1) { error(`  --target must be a positive number of pixels.`); return 1; }

  const dryRun = !!opts['dry-run'];
  const force = !!opts.force;
  const model = opts.model || DEFAULT_MODEL;
  const concurrency = concurrencyFrom(opts.concurrency ?? 1);

  const root = path.resolve(opts.in);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    error(`  --in must be a folder that exists: ${root}`);
    return 1;
  }

  /* Worth having because a library folder is rarely only the library. This one
     holds 1214 images: the artwork, but also print-ready exports, product
     mockups and the reference photographs the artwork was drawn from. Most of
     those want leaving exactly as they are, and telling them apart by
     extension is cruder than a rule about names but a great deal more
     predictable. */
  const exts = opts.ext
    ? String(opts.ext).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`))
    : IMAGE_EXTS;
  const unknownExt = exts.filter((e) => !IMAGE_EXTS.includes(e));
  if (unknownExt.length) {
    error(`  --ext does not know ${unknownExt.join(', ')}. Known: ${IMAGE_EXTS.join(', ')}`);
    return 1;
  }

  /* Before anything is planned: put back whatever a lock stopped last time.
     Doing it here rather than at the end means the plan below sees the file in
     its finished state and skips it, instead of upscaling it a second time. */
  if (!dryRun) {
    const rescue = await promoteStaged(root, { target, sharpFn, sleepFn: sleep, log });
    if (rescue.promoted.length) {
      log(`\n  Recovered ${rescue.promoted.length} result(s) left staged by an earlier run:`);
      for (const p of rescue.promoted) log(`    ${p.file}  ${p.px[0]}x${p.px[1]}`);
    }
    for (const s of rescue.skipped) error(`  left alone: ${s.staged} — ${s.why}`);
  }

  const all = listArtwork(root, { exts });
  const { items, missing } = filterOnly(all, opts.only);
  if (missing.length) error(`  --only named nothing in --in: ${missing.join(', ')}`);
  if (!items.length) { error(`  No images to upscale in ${root}`); return 1; }

  /* Measured before anything is decided, because every decision here is a
     decision about pixels. A file sharp cannot open is a row, not a crash. */
  const planned = [];
  for (const it of items) {
    const backup = originalFor(it.file);
    const done = fs.existsSync(backup);
    /* Measure whatever a run would actually READ. On a redo that is the
       backup, not the file: the file is last run's result, already at the
       target, and planning from it would decide there was nothing to do --
       which is how --force silently became a no-op. */
    const source = done && force ? backup : it.file;
    let plan;
    try {
      const meta = await sharpFn(source).metadata();
      plan = planFor(meta, target);
    } catch (e) {
      plan = { action: 'failed', reason: e.message };
    }
    planned.push({ ...it, plan, done, source, skip: (done && !force) || plan.action === 'skip' });
  }

  const todo = planned.filter((p) => !p.skip && p.plan.action !== 'failed');
  const unreadable = planned.filter((p) => p.plan.action === 'failed');
  const unreachable = todo.filter((p) => p.plan.reachable === false);
  const needModel = todo.filter((p) => p.plan.action === 'model');
  const needResize = todo.filter((p) => p.plan.action === 'resize');

  const px = (a) => (Array.isArray(a) ? `${a[0]}x${a[1]}` : '—');

  if (dryRun) {
    log(`\n  DRY RUN — nothing is written and the model is not run.\n`);
    log(`  ${root}`);
    log(`  ${planned.length} image(s), target ${target}px on the longest side, model ${model}`);
    log(`  resize-only threshold: ${Math.ceil(target * RESIZE_ONLY_FRACTION)}px `
      + `(${Math.round(RESIZE_ONLY_FRACTION * 100)}% of target)\n`);

    printTable(planned, [
      ['file', (r) => r.rel],
      ['now', (r) => px(r.plan.from)],
      ['route', (r) => (r.skip && r.done && !force ? 'done' : r.plan.action)],
      ['by', (r) => (r.skip ? '—' : r.plan.action === 'model' ? `${MODEL_SCALE}x then down` : `x${r.plan.factor.toFixed(2)}`)],
      ['result', (r) => (r.skip ? '—' : px(r.plan.to))],
      ['note', (r) => (r.plan.action === 'failed' ? `UNREADABLE: ${r.plan.reason}`
        : r.done && !force ? 'already has a backup'
          : r.plan.action === 'skip' ? r.plan.reason
            : r.plan.reachable === false ? `SHORT of ${target} in one ${MODEL_SCALE}x pass` : '')],
    ], log);

    log('');
    log(`  ${needModel.length} would go through the model, ${needResize.length} resize only, `
      + `${planned.length - todo.length - unreadable.length} skipped, ${unreadable.length} unreadable`);

    /* By extension and by folder depth, because a table of a thousand rows
       scrolls past and a count does not. This is the block that shows a run is
       about to spend four hours on product mockups. */
    const byExt = {};
    for (const p of planned) {
      const e = path.extname(p.rel).toLowerCase() || '(none)';
      const b = byExt[e] || (byExt[e] = { ext: e, model: 0, resize: 0, skip: 0, failed: 0 });
      b[p.skip && p.plan.action !== 'skip' ? 'skip' : p.plan.action]++;
    }
    log('');
    printTable(Object.values(byExt).sort((a, b) => a.ext.localeCompare(b.ext)), [
      ['ext', (r) => r.ext],
      ['model', (r) => r.model],
      ['resize', (r) => r.resize],
      ['skip', (r) => r.skip],
      ['unreadable', (r) => r.failed],
    ], log);
    if (!opts.ext && Object.keys(byExt).length > 1) {
      log('');
      log(`  More than one kind of file is in here. --ext png (or similar) narrows it`);
      log(`  if some of these are mockups, exports or reference shots rather than artwork.`);
    }

    if (needModel.length) {
      /* Seventeen seconds a file on an RTX 3050, measured, not guessed. */
      const mins = Math.round((needModel.length * 17) / 60);
      log('');
      log(`  Rough cost: ${needModel.length} model pass(es) at roughly 17s each `
        + `= about ${mins < 60 ? `${mins} minutes` : `${(mins / 60).toFixed(1)} hours`}.`);
      log(`  The ${needResize.length} resize-only file(s) are near-instant.`);
    }
    if (unreachable.length) {
      log('');
      log(`  ${unreachable.length} cannot reach ${target}px in one ${MODEL_SCALE}x pass. Not chained —`);
      log(`  each would be left at its ${MODEL_SCALE}x size:`);
      for (const u of unreachable) log(`    ${u.rel}  ${px(u.plan.from)} -> ${px(u.plan.to)}`);
    }
    log('');
    return 0;
  }

  if (!todo.length) {
    log(`\n  Nothing to do: ${planned.length} image(s) are already at or above ${target}px, `
      + `or have been through already. --force does them again.\n`);
    return 0;
  }

  /* Located before any work, so a missing binary costs nothing. The resize-only
     files could proceed without it, but a run that silently did half the job
     because the GPU tool was absent is the kind of thing nobody notices until
     the poster comes back blurry. */
  let found = null;
  if (needModel.length) {
    found = locateUpscaler(spawnSync);
    if (!found) { error(UPSCALER_MISSING); return 1; }
    if (!fs.existsSync(found.models)) {
      error(`\n  Found ${found.bin} but no models folder beside it at:\n    ${found.models}\n`
        + `  The portable build ships models/ in the same folder as the .exe.\n`);
      return 1;
    }
    if (!modelInstalled(found.models, model)) {
      const have = installedModels(found.models);
      error(`\n  --model ${model} is not in ${found.models}\n`
        + `  Installed: ${have.length ? have.join(', ') : '(none found)'}\n`);
      return 1;
    }
  }

  log(`\n  ${root}`);
  log(`  ${todo.length} to do — ${needModel.length} through the model, ${needResize.length} resize only`);
  log(`  target ${target}px, ${concurrency} at a time`);
  if (found) log(`  ${found.bin}\n  model ${model}, -m ${found.models}`);
  if (unreachable.length) {
    log(`  ${unreachable.length} cannot reach ${target}px in one ${MODEL_SCALE}x pass — done anyway, not chained`);
  }
  log('');

  const started = now();
  let calls = 0;
  const rows = [];

  await pool(todo, concurrency, async (item) => {
    const row = { slug: item.rel, result: 'failed', ms: null, detail: '' };
    const t0 = now();
    try {
      const out = await withRetry(async () => {
        if (item.plan.action === 'model') calls++;
        return upscaleFile(item, item.plan, {
          bin: found?.bin, models: found?.models, model, target, spawnSync, sharpFn,
          sleepFn: sleep,
          onLockRetry: ({ attempt, wait, code }) =>
            log(`    ${item.rel}: ${code} on rename, attempt ${attempt}, waiting ${wait}ms`),
        });
      }, {
        attempts: 2,
        sleepFn: sleep,
        classify: classifyUpscaleFailure,
        onRetry: ({ attempt, wait, reason }) =>
          log(`    ${item.rel}: attempt ${attempt} failed (${reason}), retrying in ${humanMs(wait)}`),
      });

      row.result = out.action === 'model' ? 'upscaled' : 'resized';
      row.detail = `${px(out.from)} -> ${px(out.to)}`;
      if (!out.reachable) row.detail += `  SHORT of ${target}`;
      if (out.redone) row.detail += '  (redone)';
      row.out = out;
    } catch (err) {
      const { kind, reason } = classifyUpscaleFailure(err);
      row.result = kind === 'refused' ? 'refused' : 'failed';
      row.detail = reason;
      /* Say where the work went. Without this the operator sees a failure and
         assumes the upscale has to be done again, when in fact it is finished
         and one rename away from being in place. */
      if (err.stagedAt) {
        row.stagedAt = err.stagedAt;
        row.detail += ` — result is at ${path.basename(err.stagedAt)}, `
          + `the rename failed; run again to promote it (no reprocessing)`;
      }
    }
    row.ms = now() - t0;
    rows.push(row);
    log(`    ${row.result.padEnd(8)} ${item.rel}  ${row.detail}`);
    return row;
  });

  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const summary = {
    succeeded: rows.filter((r) => r.result === 'upscaled' || r.result === 'resized').length,
    upscaled: rows.filter((r) => r.result === 'upscaled').length,
    resized: rows.filter((r) => r.result === 'resized').length,
    skipped: planned.length - todo.length,
    refused: rows.filter((r) => r.result === 'refused').length,
    failed: rows.filter((r) => r.result === 'failed').length + unreadable.length,
    short: rows.filter((r) => r.out && !r.out.reachable).length,
    calls,
    wallMs: now() - started,
  };

  const runFile = writeRunLog(root, {
    tool: 'upscale', at: new Date().toISOString(),
    root, target, model, concurrency, force,
    resizeOnlyFraction: RESIZE_ONLY_FRACTION,
    rows: rows.map((r) => ({ file: r.slug, result: r.result, ms: r.ms, detail: r.detail, out: r.out || null })),
    unreadable: unreadable.map((u) => ({ file: u.rel, reason: u.plan.reason })),
    summary,
  });

  printSummary({
    label: 'upscale', rows, summary, runFile, outDir: root,
    totals: readRunTotals(root), log,
  });

  const stagedLeft = rows.filter((r) => r.stagedAt);
  if (stagedLeft.length) {
    log(`  ${stagedLeft.length} result(s) are finished but could not be renamed into place —`);
    log(`  nothing was reprocessed and nothing was lost. Run the same command again`);
    log(`  and they will be promoted before anything else happens:`);
    for (const r of stagedLeft) log(`    ${path.basename(r.stagedAt)}`);
  }
  if (summary.short) {
    log(`  ${summary.short} did not reach ${target}px in one ${MODEL_SCALE}x pass — see the table. `
      + `Not chained.`);
  }
  if (unreadable.length) {
    log(`  ${unreadable.length} could not be read at all:`);
    for (const u of unreadable) log(`    ${u.rel} — ${u.plan.reason}`);
  }
  if (summary.succeeded) {
    log(`  originals kept alongside as *${ORIGINAL_SUFFIX}<ext>.`);
  }
  log('');

  return summary.failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  /* process.exitCode rather than process.exit(), for the reason spelled out at
     the foot of cutout.mjs: sharp's worker threads are still closing when the
     summary prints, and killing the loop under them trips a libuv assertion. */
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('\n  upscale.mjs failed:', err.message, '\n'); process.exit(1); });
}
