/**
 * Which studio renders did not land?
 *
 *   node tools/builder/render-sweep.mjs [--all] [--json] [--out FILE]
 *
 * A studio render can fail in two ways and NEITHER of them tells anybody. The
 * document keeps its old picture, artworkHistory gains an entry suggesting work
 * happened, and the only sign is a customer looking at artwork that should have
 * changed. Both were found by hand, one at a time. This finds them in one pass.
 *
 *   INCOMPLETE  the scene was saved and the render never finished. studio-save
 *               writes the scene with savedAt; the renderer REWRITES it at the
 *               very end with renderedAt. savedAt and no renderedAt is a render
 *               that started and did not get to the end. 007 sat like this for
 *               five days: invoked 245ms after the save, no completion, and
 *               nothing in the logs -- this function's log messages come back
 *               empty, so there is nothing to read.
 *
 *   RACE        the render finished AFTER the document was published. The
 *               renderer attaches to the DRAFT and publishing is what promotes
 *               it, so publishing mid-render publishes the previous picture and
 *               strands the new one. Adam & The Ants was six seconds the wrong
 *               side of this.
 *
 * ── Why the SDK and not the CLI ────────────────────────────────────────────
 *
 * The first version shelled out to `netlify blobs:get` once per scene. 245
 * child processes, each a second or more, and one of them hung: 35 minutes in,
 * the sweep had used 0.75s of CPU and was sitting on a stuck CLI call with no
 * way to time it out and nothing printed, because the output was buffered to
 * the end that never came.
 *
 * @netlify/blobs reads in-process. list() returns all 1242 blobs in about a
 * second, a get is ~100ms, a slow one can actually be abandoned, and progress
 * can be printed as it goes. For something meant to run after every fifty
 * renders that is the difference between a habit and a chore.
 *
 * Read-only. Reads blobs and published documents. Changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStore } from '@netlify/blobs';
import { parseArgs, printTable, humanMs, pool } from './_cli.mjs';

const SPEC = {
  all: 'boolean', json: 'boolean', out: 'string',
  concurrency: 'number', timeout: 'number', every: 'number', help: 'boolean',
};
const PROJECT = 'lwbwahym';
const DATASET = 'production';
const STORE = 'studio';

/** A read that has taken this long is not slow, it is stuck. */
export const READ_TIMEOUT_MS = 30000;
export const DEFAULT_CONCURRENCY = 8;
export const PROGRESS_EVERY = 10;

export const HELP = `
  node tools/builder/render-sweep.mjs [options]

    --all              list every scene, not only the ones with a problem
    --json             machine-readable
    --out FILE         also write the full result there
    --concurrency N    scenes read at once (default ${DEFAULT_CONCURRENCY})
    --timeout MS       give up on one read after this (default ${READ_TIMEOUT_MS})
    --every N          progress line every N scenes (default ${PROGRESS_EVERY})
    --help

  Credentials, in order:
    NETLIFY_SITE_ID   / .netlify/state.json  -> siteId
    NETLIFY_AUTH_TOKEN                       -> else the Netlify CLI's own login

  Two failure modes, neither of which announces itself:
    INCOMPLETE  saved, never finished rendering — run the render again
    RACE        finished AFTER the publish — publish again to promote it
`;

/**
 * Where the site id and token come from.
 *
 * .env first because that is what a scheduled run would have, then the CLI's
 * own stored login so an interactive run needs no setup at all. The CLI path is
 * a convenience and says so: it is reading somebody else's config file, and if
 * Netlify moves it this breaks in a way that has nothing to do with this tool.
 */
export function resolveCredentials(deps = {}) {
  const {
    env = process.env,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    exists = (p) => fs.existsSync(p),
    appData = process.env.APPDATA,
    home = os.homedir(),
  } = deps;

  let siteID = env.NETLIFY_SITE_ID || env.SITE_ID || null;
  if (!siteID && exists('.netlify/state.json')) {
    try { siteID = JSON.parse(readFile('.netlify/state.json')).siteId || null; } catch (e) { /* none */ }
  }

  let token = env.NETLIFY_AUTH_TOKEN || env.NETLIFY_API_TOKEN || null;
  let tokenSource = token ? 'environment' : null;
  if (!token) {
    for (const p of [
      appData && path.join(appData, 'netlify', 'Config', 'config.json'),
      path.join(home, '.netlify', 'config.json'),
      path.join(home, '.config', 'netlify', 'config.json'),
    ].filter(Boolean)) {
      if (!exists(p)) continue;
      try {
        const cfg = JSON.parse(readFile(p));
        const found = Object.values(cfg.users || {}).map((u) => u?.auth?.token).find(Boolean);
        if (found) { token = found; tokenSource = `the Netlify CLI login (${p})`; break; }
      } catch (e) { /* next */ }
    }
  }
  return { siteID, token, tokenSource };
}

/** One read, abandoned if it hangs. */
export async function readScene(store, key, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  let timer;
  /* Promise.race rather than an abort signal: @netlify/blobs takes no signal,
     so the request may still be in flight after this resolves. That is fine --
     the process is about to move on and nothing depends on it — but it is the
     reason a stuck read costs a slot rather than nothing. */
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return { scene: await Promise.race([store.get(key, { type: 'json' }), timeout]) };
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** id and style out of studio/<id>/<style>/scene.json (or the legacy path). */
export function parseKey(key) {
  const m = /^studio\/([^/]+)\/([^/]+)\/scene\.json$/.exec(key);
  if (m) return { id: m[1], style: m[2] };
  const legacy = /^studio\/([^/]+)\/scene\.json$/.exec(key);
  return legacy ? { id: legacy[1], style: 'classic (legacy path)' } : null;
}

/**
 * Which of the two, or neither.
 *
 * The publish comparison is strict rather than tolerant: a render that landed a
 * second before the publish is fine and one that landed a second after is not,
 * and there is no useful middle to allow for.
 */
export function classify({ savedAt, renderedAt, publishedAt, hasProduct, hasDraft, draftsKnown }) {
  if (!savedAt && !renderedAt) return { mode: 'unknown', why: 'scene has neither savedAt nor renderedAt' };

  /* No product comes FIRST, ahead of the unfinished check, because the two
     have opposite remedies and getting the order wrong prints the dangerous
     one. An INCOMPLETE is fixed by running the render again; an ORPHAN's
     document is gone, and running the render again would recreate a product
     somebody deliberately deleted.
     This is not hypothetical. The 007 scene was reported INCOMPLETE for days,
     and by the time it was looked at the document had been deleted and split
     into two new products -- at which point "run it again" was the wrong
     instruction, confidently printed. */
  if (!hasProduct) {
    return {
      mode: 'ORPHAN',
      why: renderedAt
        ? 'rendered, but no published product has this id — the document was deleted or never published'
        : 'the render never finished AND no product has this id — the document is gone, so there is nothing to render',
    };
  }

  if (!renderedAt) return { mode: 'INCOMPLETE', why: 'saved, but the render never finished' };
  if (!publishedAt) return { mode: 'ok', why: 'rendered' };
  if (new Date(renderedAt) <= new Date(publishedAt)) return { mode: 'ok', why: 'rendered before the publish' };

  /* Past here the timestamps say the render finished after the publish, and
     that is not enough to convict. Two reasons, both found on the first real
     run against the catalogue:

       _updatedAt comes back at SECOND precision while renderedAt carries
       milliseconds. A render that landed at .336 within the publish second is
       indistinguishable from one that landed 336ms too late.

       And what makes a race matter is the artwork being STRANDED. The
       renderer attaches to the draft and publishing consumes the draft, so if
       no draft remains then nothing is stranded, whatever the clocks say.

     The draft is the verdict; the timestamps only bring a document to
     attention. Two live products were reported as races on the timestamps
     alone -- 336ms and 401ms -- and neither had a draft. Both were fine.

     Without a token the drafts cannot be read, so the tool falls back to the
     timestamps and says that it has done so rather than pretending. */
  const gap = new Date(renderedAt) - new Date(publishedAt);
  if (draftsKnown && !hasDraft) {
    return { mode: 'ok', why: `rendered ${humanMs(gap)} after the publish timestamp, but no draft remains — the artwork landed and went live` };
  }
  return {
    mode: 'RACE',
    why: `rendered ${humanMs(gap)} AFTER the publish — artwork is on the draft, not live`
      + (draftsKnown ? '' : ' (drafts could not be read, so this rests on the timestamps alone)'),
  };
}

/**
 * The Sanity read token, if there is one.
 *
 * Drafts are not publicly readable, and whether a draft exists is the whole
 * verdict on a RACE. Without it the tool still runs and still finds every
 * INCOMPLETE -- it just says that its race verdicts rest on timestamps.
 */
export function sanityToken(deps = {}) {
  const { env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8') } = deps;
  const fromEnv = env.SANITY_WRITE_TOKEN || env.SANITY_READ_TOKEN || env.SANITY_API_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const m = /^\s*SANITY_(?:WRITE|READ|API)_TOKEN\s*=\s*(.+)$/m.exec(readFile('.env'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}

async function sanityQuery(query, token) {
  const url = `https://${PROJECT}.api.sanity.io/v2021-10-21/data/query/${DATASET}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Sanity returned ${res.status}`);
  return (await res.json()).result || [];
}

async function fetchProducts() {
  const rows = await sanityQuery('*[_type == "product"]{_id, title, "slug": slug.current, category, _updatedAt}');
  return new Map(rows.map((p) => [p._id, p]));
}

/** The ids that currently have a draft. */
async function fetchDraftIds(token) {
  const rows = await sanityQuery('*[_type == "product" && _id in path("drafts.**")]{_id}', token);
  return new Set(rows.map((d) => d._id.replace(/^drafts\./, '')));
}

export async function run(argv, deps = {}) {
  const {
    log = console.log,
    error = console.error,
    /* progress goes to stderr so it still streams when stdout is piped or
       redirected -- the first version printed nothing for 35 minutes because
       everything was buffered behind a pipe that never closed */
    progress = (s) => process.stderr.write(s + '\n'),
    products: injectedProducts = null,
    draftIds: injectedDraftIds = null,
    store: injectedStore = null,
    now = Date.now,
  } = deps;

  const { opts, errors } = parseArgs(argv, SPEC);
  if (opts.help) { log(HELP); return 0; }
  if (errors.length) { errors.forEach((e) => error(`  ${e}`)); log(HELP); return 1; }

  const timeoutMs = Math.max(1000, Math.round(opts.timeout ?? READ_TIMEOUT_MS));
  const concurrency = Math.max(1, Math.min(32, Math.round(opts.concurrency ?? DEFAULT_CONCURRENCY)));
  const every = Math.max(1, Math.round(opts.every ?? PROGRESS_EVERY));

  let store = injectedStore;
  if (!store) {
    const { siteID, token, tokenSource } = resolveCredentials();
    if (!siteID) { error('  no site id — set NETLIFY_SITE_ID or run from a linked project'); return 1; }
    if (!token) { error('  no token — set NETLIFY_AUTH_TOKEN in .env, or log in with the Netlify CLI'); return 1; }
    progress(`  site ${siteID}, token from ${tokenSource}`);
    store = getStore({ name: STORE, siteID, token });
  }

  let products;
  try { products = injectedProducts || await fetchProducts(); }
  catch (e) { error(`  could not read products from Sanity: ${e.message}`); return 1; }
  progress(`  ${products.size} published product(s)`);

  /* Whether a draft exists is what decides a RACE, and drafts need a token.
     Not having one is a degraded run, not a failed one -- every INCOMPLETE is
     still found -- so it carries on and labels the race verdicts. */
  let draftIds = injectedDraftIds || new Set();
  let draftsKnown = !!injectedDraftIds;
  if (!injectedDraftIds) {
    const token = sanityToken();
    if (!token) {
      error("  no SANITY_WRITE_TOKEN — drafts cannot be read, so RACE verdicts rest on timestamps alone");
    } else {
      try {
        draftIds = await fetchDraftIds(token);
        draftsKnown = true;
        progress(`  ${draftIds.size} product(s) with a draft`);
      } catch (e) {
        error(`  could not read drafts (${e.message}) — RACE verdicts rest on timestamps alone`);
      }
    }
  }

  let keys;
  const tList = now();
  try {
    const { blobs } = await store.list();
    keys = blobs.map((b) => b.key).filter((k) => /\/scene\.json$/.test(k)).sort();
  } catch (e) { error(`  could not list blobs: ${e.message}`); return 1; }
  progress(`  ${keys.length} scene(s) found in ${humanMs(now() - tList)}, reading ${concurrency} at a time`);

  const rows = [], skipped = [];
  let done = 0;
  const started = now();

  await pool(keys, concurrency, async (key) => {
    const { scene, error: readErr } = await readScene(store, key, { timeoutMs });
    done++;
    if (done % every === 0 || done === keys.length) {
      const rate = (done / Math.max(1, (now() - started) / 1000)).toFixed(1);
      progress(`  ${String(done).padStart(4)}/${keys.length}  (${rate}/s, ${skipped.length} skipped)`);
    }
    if (readErr) { skipped.push({ key, why: readErr }); return; }
    if (!scene || typeof scene !== 'object') { skipped.push({ key, why: 'not a JSON object' }); return; }

    const parsed = parseKey(key);
    if (!parsed) { skipped.push({ key, why: 'key does not look like a scene path' }); return; }

    const rawDocId = String(scene.docId || '');
    const docId = rawDocId.replace(/^drafts\./, '') || parsed.id;
    const product = products.get(docId) || products.get(parsed.id);
    const verdict = classify({
      savedAt: scene.savedAt, renderedAt: scene.renderedAt,
      publishedAt: product?._updatedAt, hasProduct: !!product,
      hasDraft: draftIds.has(docId), draftsKnown,
    });

    rows.push({
      key, id: parsed.id, style: parsed.style, docId,
      title: product?.title || scene.title || '(unknown)',
      slug: product?.slug || '—',
      category: product?.category || '—',
      hasDraft: draftIds.has(docId),
      savedAt: scene.savedAt || null,
      renderedAt: scene.renderedAt || null,
      publishedAt: product?._updatedAt || null,
      mode: verdict.mode, why: verdict.why,
    });
  });

  const bad = rows.filter((r) => r.mode !== 'ok');
  const shown = opts.all ? rows : bad;
  const payload = {
    scanned: rows.length, problems: bad.length, skipped: skipped.length, draftsKnown,
    tookMs: now() - started, rows: opts.all ? rows : bad, skippedDetail: skipped,
  };
  /* The file is a convenience; the report is the point. This used to be
     written BEFORE the table was printed, so an unwritable --out path threw
     away a run that had already done all 246 reads. Warn and carry on. */
  const writeOut = () => {
    if (!opts.out) return;
    try {
      fs.writeFileSync(path.resolve(opts.out), JSON.stringify(payload, null, 1));
    } catch (err) {
      error(`  could not write ${opts.out}: ${err.message}`);
    }
  };

  if (opts.json) { writeOut(); log(JSON.stringify(payload, null, 1)); return bad.length ? 1 : 0; }

  const short = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '—');
  log('');
  log(`  ${rows.length} scene(s) read in ${humanMs(payload.tookMs)}, ${bad.length} with a problem, ${skipped.length} skipped`);
  /* Said in the report, not only on stderr. A race verdict turns on whether
     a draft was found, so how many were seen belongs in the record: a zero
     here means "checked and there were none", and the other line means the
     verdicts below are weaker than they look. */
  log(draftsKnown
    ? `  drafts read: ${draftIds.size} product(s) currently have one`
    : '  drafts NOT read — race verdicts below rest on timestamps alone');
  log('');
  if (shown.length) {
    printTable(shown.sort((a, b) => a.mode.localeCompare(b.mode) || String(a.title).localeCompare(String(b.title))), [
      ['mode', (r) => r.mode],
      ['title', (r) => String(r.title).slice(0, 28)],
      ['slug', (r) => String(r.slug).slice(0, 26)],
      ['style', (r) => r.style],
      ['savedAt', (r) => short(r.savedAt)],
      ['renderedAt', (r) => short(r.renderedAt)],
      ['published', (r) => short(r.publishedAt)],
    ], log);
    log('');
    for (const r of shown.filter((x) => x.mode !== 'ok')) log(`    ${r.title} — ${r.why}`);
  } else {
    log('  nothing incomplete and nothing raced.');
  }

  const counts = {};
  for (const r of rows) counts[r.mode] = (counts[r.mode] || 0) + 1;
  log('');
  for (const [k, v] of Object.entries(counts).sort()) log(`  ${String(v).padStart(4)}  ${k}`);

  /* Said out loud, always. A scene that could not be read was not checked, and
     an unchecked scene is not a passing one. */
  if (skipped.length) {
    log('');
    log(`  ${skipped.length} scene(s) NOT CHECKED:`);
    for (const s of skipped) log(`      ${s.key}\n          ${s.why}`);
  }

  log('');
  log('  INCOMPLETE — the render never finished. Run it again from the stored scene:');
  log('      POST /api/studio-render/<id>   X-CSC-Internal-Secret: <secret>');
  log('  RACE — the artwork is on the draft. Publish the product again to promote it.');
  log('  ORPHAN — no product has this id. Do NOT re-render: the document is gone,');
  log('      so the scene blob is stale and the render would recreate a deleted product.');
  log('');
  writeOut();
  if (opts.out) log(`  written to ${opts.out}`);
  return bad.length || skipped.length ? 1 : 0;
}

if (process.argv[1]?.endsWith('render-sweep.mjs')) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('\n  render-sweep failed:', err.message, '\n'); process.exit(1); });
}
