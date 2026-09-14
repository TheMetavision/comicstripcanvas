/**
 * The parts both batch tools share.
 *
 * style.mjs and cutout.mjs do very different work and have almost identical
 * shells: read a folder, skip what is already done, run N at a time, retry the
 * failures worth retrying, write a run log, print a table. That shell lives
 * here so the two cannot drift into behaving differently about resume, about
 * what counts as a transient failure, or about what --dry-run means.
 *
 * Nothing here is imported by the site. These are local tools, run from a
 * PowerShell prompt with no netlify dev and no Sanity in the picture.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ files */

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

export const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * The slug for an input file: its stem, tidied.
 *
 * Tidied rather than taken literally because the slug becomes a directory
 * name, a key in a run log and a line under a picture on the contact sheet.
 * Spaces and punctuation collapse to a single hyphen, the case is dropped, and
 * anything that would need escaping somewhere is gone before it can.
 */
export function slugFor(file) {
  const stem = path.basename(String(file), path.extname(String(file)));
  const slug = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip accents rather than mangle them
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/* ------------------------------------------------------- styled artwork */

/**
 * What style.mjs calls the pictures it writes.
 *
 * Here rather than in style.mjs so the tool that READS a batch and the tool
 * that WRITES one cannot disagree about the name -- and because cutout.mjs
 * must not import style.mjs to find out, which would pull the Gemini SDK into
 * a tool that never generates anything.
 */
export const STYLED_SIZES = ['4k', '2k'];   // 4K first: it is the better source
export const styledName = (size) => `styled-${String(size).toLowerCase()}.png`;
export const STYLED_NAMES = STYLED_SIZES.map(styledName);

/** Is this file one of style.mjs's own outputs rather than somebody's photo? */
export const isStyledArtwork = (file) =>
  STYLED_NAMES.includes(path.basename(String(file)).toLowerCase());

/**
 * The slug for a file, which is not always its name.
 *
 * Every picture in a batch is called styled-2k.png or styled-4k.png -- the
 * name says the SIZE, and the folder says which artwork it is. Taking the slug
 * from the filename therefore gave every cutout in a batch the same slug,
 * "styled-2k", so each one overwrote the last and twenty cutouts came out as
 * one file. Silent, and only noticeable by counting.
 *
 * So, in order:
 *
 *   1. the sibling meta.json, which style.mjs wrote and which records the slug
 *      it used -- the authoritative answer, and the only one that survives a
 *      folder being renamed
 *   2. the parent folder's name, which is what style.mjs named it after
 *   3. the filename's stem, for a loose photograph anywhere else on disk
 *
 * Only a styled-artwork filename goes down the first two routes. A file called
 * holiday-photo.jpg is a photograph whatever folder it is sitting in, and its
 * stem is the right slug.
 */
export function slugForArtwork(file) {
  const full = path.resolve(String(file));
  if (!isStyledArtwork(full)) return slugFor(full);

  const dir = path.dirname(full);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    /* Run through slugFor even so: this becomes a directory name, and a value
       that has been hand-edited into something with a space in it should not
       become a folder with a space in it. */
    if (meta && typeof meta.slug === 'string' && meta.slug.trim()) return slugFor(meta.slug);
  } catch (e) { /* no meta, or unreadable: the folder name is the next best */ }

  return slugFor(path.basename(dir));
}

/** Every image in a folder, sorted, with its slug. Throws if it is not there. */
export function listImages(dir) {
  const stat = fs.existsSync(dir) ? fs.statSync(dir) : null;
  if (!stat) throw new Error(`No such folder: ${dir}`);
  /* slugForArtwork, not slugFor, in both branches: pointed at one picture
     inside a batch, or at a single slug's folder, the filename is the size and
     the folder is the identity. */
  if (stat.isFile()) return [{ file: path.resolve(dir), slug: slugForArtwork(dir) }];
  return fs.readdirSync(dir)
    .filter((f) => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ file: path.resolve(dir, f), slug: slugForArtwork(path.resolve(dir, f)) }));
}

/**
 * The images inside a styled batch.
 *
 * style.mjs writes <out>/<slug>/styled-2k.png, so a batch folder has no images
 * in it at all -- they are each one level down, under a folder named for the
 * slug. Pointing the cutout tool at a batch and having it find nothing is the
 * obvious first thing anybody would try, so this is what it tries next: every
 * subfolder holding a styled picture, the 4K one when there is a choice,
 * keeping the folder's name as the slug rather than deriving "styled-2k" from
 * the filename.
 *
 * @returns {Array<{file, slug}>} possibly empty, which means "not a batch"
 */
export function listStyledBatch(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    for (const name of STYLED_NAMES) {
      const file = path.join(dir, e.name, name);
      /* slugForArtwork rather than the folder name directly, so a meta.json
         that disagrees with its folder still wins here too -- one rule for
         where a slug comes from, wherever the picture was found. */
      if (fs.existsSync(file)) { out.push({ file: path.resolve(file), slug: slugForArtwork(file) }); break; }
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Keep only the slugs named in --only.
 *
 * Names that match nothing are reported rather than ignored: "--only bruce-lee"
 * silently doing nothing because the file is bruce_lee.jpg is a wasted
 * afternoon.
 */
export function filterOnly(items, only) {
  if (!only) return { items, missing: [] };
  const want = String(only).split(',').map((s) => slugFor(s.trim())).filter(Boolean);
  const have = new Set(items.map((i) => i.slug));
  return {
    items: items.filter((i) => want.includes(i.slug)),
    missing: want.filter((w) => !have.has(w)),
  };
}

/* ---------------------------------------------------------------- arguments */

/**
 * A small argument parser, because the alternative is a dependency.
 *
 * @param {string[]} argv
 * @param {object} spec  { flagName: 'boolean' | 'string' | 'number' }
 * @returns {{ opts: object, rest: string[], errors: string[] }}
 */
export function parseArgs(argv, spec) {
  const opts = {};
  const rest = [];
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [name, inline] = a.slice(2).split('=');
    const kind = spec[name];
    if (!kind) { errors.push(`Unknown option --${name}`); continue; }
    if (kind === 'boolean') { opts[name] = true; continue; }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || String(value).startsWith('--')) {
      errors.push(`--${name} needs a value`);
      continue;
    }
    if (kind === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) { errors.push(`--${name} must be a number, got "${value}"`); continue; }
      opts[name] = n;
    } else {
      opts[name] = value;
    }
  }
  return { opts, rest, errors };
}

/**
 * How many to run at once.
 *
 * Capped, and the cap is not arbitrary: both services behind these tools are
 * rate limited, and past four in flight the extra requests come back as 429s
 * and retries, which costs wall time rather than saving it. Four 4K
 * generations also hold four decoded images in memory at once.
 */
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 2;

export function concurrencyFrom(value) {
  const n = Math.floor(Number(value ?? DEFAULT_CONCURRENCY));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

/* -------------------------------------------------------------- the runner */

/** Run `worker` over `items`, at most `limit` at a time, in order. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What kind of failure this is.
 *
 *   transient  the platform having a moment -- worth asking again
 *   refused    the model or the service declining -- asking again buys the
 *              same answer and, for a generation, pays for it twice
 *   failed     everything else: a bad file, a missing folder, a bug
 *
 * The distinction is the whole reason this function exists. A safety refusal
 * retried three times is three charges for one "no".
 */
export function classifyFailure(err) {
  const message = String(err?.message || err || '');
  const status = typeof err?.status === 'number' ? err.status : null;

  const blocked = err?.blockReason || err?.finishReason || null;
  if (blocked && /SAFETY|PROHIBITED|BLOCK|RECITATION|SPII/i.test(String(blocked))) {
    return { kind: 'refused', reason: `safety: ${String(blocked).toLowerCase()}` };
  }
  // A 4xx other than 429 is a decision about this request, not a wobble.
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return { kind: 'refused', reason: `http ${status}` };
  }
  if (status === 429 || (status !== null && status >= 500)) {
    return { kind: 'transient', reason: `http ${status}` };
  }
  if (/timeout|timed out|abort|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network/i.test(message)) {
    return { kind: 'transient', reason: message.slice(0, 120) };
  }
  return { kind: 'failed', reason: message.slice(0, 200) };
}

/**
 * Try `fn`, again on a transient failure, with a growing gap between goes.
 *
 * Jittered so a batch that all fails at once does not all retry at once and
 * fail again together.
 *
 * @returns {Promise<any>} the value, or throws the last error with .attempts
 */
export async function withRetry(fn, {
  attempts = 3, base = 1000, sleepFn = sleep, onRetry = null, random = Math.random,
} = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      const { kind, reason } = classifyFailure(err);
      if (kind !== 'transient' || attempt === attempts) {
        err.attempts = attempt;
        err.failureKind = kind;
        err.failureReason = reason;
        throw err;
      }
      const wait = Math.round(base * (2 ** (attempt - 1)) * (0.75 + random() * 0.5));
      if (onRetry) onRetry({ attempt, wait, reason });
      await sleepFn(wait);
    }
  }
  throw last;
}

/* ---------------------------------------------------------------- resuming */

/**
 * Is this one already done?
 *
 * Resume is the default because these batches are long and interrupted often,
 * and the expensive half is the call rather than the bookkeeping. --force is
 * how you say "do it again anyway".
 */
export function alreadyDone(outFile, force) {
  if (force) return false;
  try { return fs.statSync(outFile).size > 0; } catch (e) { return false; }
}

/* --------------------------------------------------------------- reporting */

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function humanMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** A fixed-width table, the same shape in both tools. */
export function printTable(rows, cols, log = console.log) {
  if (!rows.length) return;
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => String(get(r)).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  log(line(cols.map(([h]) => h)));
  log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) log(line(cols.map(([, get]) => get(r))));
}

/**
 * The run log.
 *
 * One file per run under <out>/_runs/, so a batch that was interrupted and
 * resumed leaves a record of both halves rather than one overwriting the
 * other, and a running total can be had by reading the folder.
 */
export function writeRunLog(outDir, payload) {
  const dir = path.join(outDir, '_runs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  return file;
}

/** Every run ever recorded in this out folder, for the running total. */
export function readRunTotals(outDir) {
  const dir = path.join(outDir, '_runs');
  const totals = { runs: 0, succeeded: 0, skipped: 0, refused: 0, failed: 0, calls: 0, ms: 0 };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return totals; }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      totals.runs++;
      for (const k of ['succeeded', 'skipped', 'refused', 'failed', 'calls']) {
        totals[k] += Number(r?.summary?.[k]) || 0;
      }
      totals.ms += Number(r?.summary?.wallMs) || 0;
    } catch (e) { /* a half-written log is not worth failing a summary over */ }
  }
  return totals;
}

/** The end-of-run block both tools print, word for word the same. */
export function printSummary({ label, rows, summary, runFile, outDir, totals, log = console.log }) {
  log('');
  printTable(rows, [
    ['slug', (r) => r.slug],
    ['result', (r) => r.result],
    ['time', (r) => humanMs(r.ms)],
    ['detail', (r) => r.detail || ''],
  ], log);
  log('');
  log(`  ${label}: ${summary.succeeded} succeeded, ${summary.skipped} skipped, `
    + `${summary.refused} refused, ${summary.failed} failed`);
  log(`  ${summary.calls} call(s), ${humanMs(summary.wallMs)} wall time`);
  if (totals && totals.runs) {
    log(`  running total across ${totals.runs} run(s) in this folder: `
      + `${totals.succeeded} succeeded, ${totals.calls} call(s), ${humanMs(totals.ms)}`);
  }
  if (runFile) log(`  run log: ${runFile}`);
  if (outDir) log(`  output:  ${outDir}`);
  log('');
}

/* ------------------------------------------------------------ environment */

/**
 * A required environment variable, or a message that says what to do.
 *
 * The VALUE is never printed, logged or put in an error -- only its name and
 * where to put it.
 */
export function requireEnv(name, hint) {
  const value = (process.env[name] || '').trim();
  if (value) return value;
  throw new Error(`${name} is not set. ${hint}`);
}
