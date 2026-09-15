/**
 * Tests for the two batch tools.
 *
 *   node tools/builder/cli-tests.mjs
 *
 * Nothing here calls the model or the cutout service: both are injected, and
 * the stub for a dry run THROWS if it is called at all, which is the only way
 * to prove --dry-run really is free. Fixtures are written to a temp folder and
 * removed afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  parseArgs, slugFor, listImages, filterOnly, alreadyDone, concurrencyFrom,
  classifyFailure, withRetry, pool, MAX_CONCURRENCY, DEFAULT_CONCURRENCY,
  slugForArtwork, styledName, STYLED_NAMES,
} from './_cli.mjs';
import { run as styleRun, contactSheet, refusalDetail, HELP as STYLE_HELP } from './style.mjs';
import {
  normaliseWithSharp, fitWithin, plannedSize, stepQuality, ladderFor, targetBytesFor,
  ENCODE_LADDER, UPLOAD_TARGET_BYTES, QUALITY_FLOOR,
} from '../../netlify/functions/_shared/photo-input.mjs';
import {
  run as cutoutRun, findUpscaler, transparencyOf, postCutout, HELP as CUTOUT_HELP,
  UPSCALER_MISSING,
} from './cutout.mjs';
import {
  run as upscaleRun, planFor, fitLong, listArtwork, originalFor, locateUpscaler,
  modelInstalled, installedModels, classifyUpscaleFailure,
  DEFAULT_TARGET, DEFAULT_MODEL, MODEL_SCALE, RESIZE_ONLY_FRACTION, ORIGINAL_SUFFIX,
} from './upscale.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-cli-'));
const quiet = () => {};

/* ------------------------------------------------------------ 1. arguments */

say('\n1. ARGUMENTS\n');
{
  const spec = { in: 'string', out: 'string', '4k': 'boolean', concurrency: 'number', help: 'boolean' };
  const a = parseArgs(['--in', 'photos', '--out', 'art', '--4k'], spec);
  ok(a.opts.in === 'photos' && a.opts.out === 'art' && a.opts['4k'] === true,
    'values and flags', JSON.stringify(a.opts));
  ok(a.errors.length === 0, 'no complaints about a good line');

  const eq = parseArgs(['--in=photos', '--concurrency=3'], spec);
  ok(eq.opts.in === 'photos' && eq.opts.concurrency === 3, '--name=value works too',
    JSON.stringify(eq.opts));

  const bad = parseArgs(['--nope', 'x'], spec);
  ok(bad.errors.some((e) => /Unknown option --nope/.test(e)), 'an unknown option is reported',
    bad.errors.join('; '));

  const missing = parseArgs(['--in'], spec);
  ok(missing.errors.some((e) => /--in needs a value/.test(e)), 'a value-less option is reported',
    missing.errors.join('; '));

  const swallowed = parseArgs(['--in', '--out', 'art'], spec);
  ok(swallowed.errors.some((e) => /--in needs a value/.test(e)),
    'and one option cannot eat the next', swallowed.errors.join('; '));

  const nan = parseArgs(['--concurrency', 'lots'], spec);
  ok(nan.errors.some((e) => /must be a number/.test(e)), 'a non-number is reported');

  ok(concurrencyFrom(undefined) === DEFAULT_CONCURRENCY, `default concurrency is ${DEFAULT_CONCURRENCY}`);
  ok(concurrencyFrom(9) === MAX_CONCURRENCY, `and it is capped at ${MAX_CONCURRENCY}`, String(concurrencyFrom(9)));
  ok(concurrencyFrom(0) === DEFAULT_CONCURRENCY, 'zero falls back to the default');
  ok(concurrencyFrom(3) === 3, 'a sensible number is honoured');
  ok(/hard cap 4/.test(STYLE_HELP) && /hard cap 4/.test(CUTOUT_HELP),
    'and both --help texts say what the cap is and why');
}

/* ----------------------------------------------------------------- 2. slugs */

say('\n2. SLUGS\n');
{
  const cases = [
    ['bruce-lee.jpg', 'bruce-lee'],
    ['Bruce Lee.JPG', 'bruce-lee'],
    ['tupac_shakur.png', 'tupac-shakur'],
    ['C:/photos/Back to the Future.webp', 'back-to-the-future'],
    ['gizmo (final).jpeg', 'gizmo-final'],
    ['café.png', 'cafe'],
    ['---.png', 'untitled'],
    ['a.b.c.jpg', 'a-b-c'],
  ];
  for (const [input, want] of cases) {
    ok(slugFor(input) === want, `${JSON.stringify(input)} -> ${want}`, slugFor(input));
  }
}

/* ------------------------------------------------------- 3. listing and only */

say('\n3. LISTING AND --only\n');
const FIXTURES = path.join(TMP, 'photos');
fs.mkdirSync(FIXTURES, { recursive: true });
const NAMES = ['bruce-lee.jpg', 'tupac.jpg', 'gizmo.png', 'Back to the Future.webp', 'west-ham.jpeg'];
for (const [i, name] of NAMES.entries()) {
  const buf = await sharp({
    create: { width: 40 + i, height: 60, channels: 3, background: { r: 20 * i, g: 90, b: 140 } },
  })[path.extname(name).slice(1).replace('jpg', 'jpeg').replace('jpeg', 'jpeg') === 'png' ? 'png' : 'jpeg']().toBuffer();
  fs.writeFileSync(path.join(FIXTURES, name), buf);
}
fs.writeFileSync(path.join(FIXTURES, 'notes.txt'), 'not an image');
{
  const items = listImages(FIXTURES);
  ok(items.length === 5, 'five images found, the text file ignored', String(items.length));
  ok(items.map((i) => i.slug).includes('back-to-the-future'), 'with tidied slugs',
    items.map((i) => i.slug).join(', '));

  const only = filterOnly(items, 'bruce-lee, gizmo');
  ok(only.items.length === 2, '--only narrows to two', String(only.items.length));
  ok(only.missing.length === 0, 'and reports nothing missing');

  const wrong = filterOnly(items, 'bruce_lee,nobody');
  ok(wrong.items.length === 1, 'a name written with an underscore still matches',
    wrong.items.map((i) => i.slug).join(','));
  ok(wrong.missing.includes('nobody'), 'and a name that matches nothing is reported',
    wrong.missing.join(','));

  let threw = null;
  try { listImages(path.join(TMP, 'nope')); } catch (e) { threw = e.message; }
  ok(/No such folder/.test(threw || ''), 'a missing folder says so', threw);
}

/* -------------------------------------------------------------- 4. resuming */

say('\n4. RESUME AND --force\n');
{
  const f = path.join(TMP, 'done.png');
  ok(alreadyDone(f, false) === false, 'nothing there yet');
  fs.writeFileSync(f, Buffer.from([1, 2, 3]));
  ok(alreadyDone(f, false) === true, 'a file that exists is done');
  ok(alreadyDone(f, true) === false, 'and --force ignores it');
  fs.writeFileSync(f, Buffer.alloc(0));
  ok(alreadyDone(f, false) === false, 'an empty file is not done');
}

/* ------------------------------------------- 5. refusal vs transient, retries */

say('\n5. WHAT IS WORTH RETRYING\n');
{
  const styleErr = (detail) => Object.assign(new Error('no image'), detail);
  const cases = [
    [styleErr({ blockReason: 'SAFETY' }), 'refused', 'a safety block'],
    [styleErr({ finishReason: 'PROHIBITED_CONTENT' }), 'refused', 'prohibited content'],
    [styleErr({ status: 400 }), 'refused', 'a 400'],
    [styleErr({ status: 403 }), 'refused', 'a 403'],
    [styleErr({ status: 429 }), 'transient', 'a 429'],
    [styleErr({ status: 500 }), 'transient', 'a 500'],
    [styleErr({ status: 503 }), 'transient', 'a 503'],
    [new Error('The operation was aborted due to timeout'), 'transient', 'a timeout'],
    [new Error('read ECONNRESET'), 'transient', 'a dropped socket'],
    [new Error('fetch failed'), 'transient', 'a failed fetch'],
    [new Error('No such file'), 'failed', 'a missing file'],
    /* What Google actually answered for a photograph of a public figure. It is
       a refusal with an unhelpful name, and matching on a word list used to
       drop it through to "failed". */
    [styleErr({ blockReason: 'OTHER' }), 'refused', 'a block that will not say why'],
    [styleErr({ finishReason: 'STOP' }), 'failed', 'a plain STOP, which refuses nothing'],
  ];
  for (const [err, want, what] of cases) {
    ok(classifyFailure(err).kind === want, `${what} -> ${want}`, classifyFailure(err).kind);
  }
  ok(classifyFailure(styleErr({ blockReason: 'OTHER' })).reason === 'blocked: other',
    'and it is called a block rather than a safety refusal it is not',
    classifyFailure(styleErr({ blockReason: 'OTHER' })).reason);
  ok(classifyFailure(styleErr({ blockReason: 'SAFETY' })).reason === 'safety: safety',
    'while a real safety block still says safety');
}

say('\n6. BACKOFF\n');
{
  const waits = [];
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
    return 'done';
  }, { sleepFn: async (ms) => waits.push(ms), random: () => 0.5 });
  ok(value === 'done' && calls === 3, 'a transient failure is retried until it works',
    `${calls} attempt(s)`);
  ok(waits.length === 2, 'with a wait between each', JSON.stringify(waits));
  ok(waits[0] === 1000 && waits[1] === 2000, 'and the wait doubles', JSON.stringify(waits));

  const jitter = [];
  await withRetry(async (n) => {
    if (n < 2) throw Object.assign(new Error('boom'), { status: 503 });
    return 1;
  }, { sleepFn: async (ms) => jitter.push(ms), random: () => 1 });
  ok(jitter[0] === 1250, 'jitter moves it within a quarter either way', String(jitter[0]));

  let refusedCalls = 0;
  const refusedWaits = [];
  let caught = null;
  try {
    await withRetry(async () => {
      refusedCalls++;
      throw Object.assign(new Error('no image'), { blockReason: 'SAFETY' });
    }, { sleepFn: async (ms) => refusedWaits.push(ms) });
  } catch (e) { caught = e; }
  ok(refusedCalls === 1, 'a refusal is asked ONCE — it is an answer, not a wobble',
    `${refusedCalls} call(s)`);
  ok(refusedWaits.length === 0, 'and nothing is waited for');
  ok(caught && caught.failureKind === 'refused', 'the failure carries its kind',
    caught && caught.failureKind);

  let hardCalls = 0;
  try {
    await withRetry(async () => { hardCalls++; throw Object.assign(new Error('boom'), { status: 500 }); },
      { sleepFn: async () => {}, attempts: 3 });
  } catch (e) { /* expected */ }
  ok(hardCalls === 3, 'a transient failure gives up after three', String(hardCalls));
}

/* ------------------------------------------------------------- 7. the pool */

say('\n7. CONCURRENCY\n');
{
  let inFlight = 0, peak = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  const seen = await pool(items, 2, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  ok(peak === 2, 'never more than the limit in flight at once', String(peak));
  ok(seen.join(',') === items.map((n) => n * 2).join(','), 'and results come back in order');
}

/* ---------------------------------------------------------- 8. style --dry-run */

say('\n8. style.mjs --dry-run MAKES NO CALLS\n');
{
  const out = path.join(TMP, 'dry-out');
  const lines = [];
  const exploding = () => { throw new Error('THE MODEL WAS CALLED DURING A DRY RUN'); };
  /* Belt and braces: the injected styleImage throws, and so does global fetch,
     so anything reaching the network by any route fails the test loudly. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('THE NETWORK WAS USED DURING A DRY RUN'); };
  let code;
  try {
    code = await styleRun(['--in', FIXTURES, '--out', out, '--dry-run'],
      { styleImage: exploding, log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) });
  } finally {
    globalThis.fetch = realFetch;
  }
  const text = lines.join('\n');
  ok(code === 0, 'it exits clean', String(code));
  ok(/DRY RUN/.test(text), 'and says it is a dry run');
/* Counted on the plan lines themselves: the header says "nothing is
     generated", which a bare /generate/ would count as a sixth. */
  const planned = (text.match(/^ {4}generate /gm) || []).length;
  ok(planned === 5, 'five to generate', String(planned));
  ok(/5 call\(s\) would be made/.test(text), 'and the call count is stated',
    (text.match(/\d+ call\(s\) would be made.*/) || [''])[0]);
  ok(!fs.existsSync(out), 'nothing was written', out);

  /* With one already done, the plan changes and says so. */
  fs.mkdirSync(path.join(out, 'gizmo'), { recursive: true });
  fs.writeFileSync(path.join(out, 'gizmo', 'styled-2k.png'), Buffer.from([1, 2, 3]));
  const more = [];
  await styleRun(['--in', FIXTURES, '--out', out, '--dry-run'],
    { styleImage: exploding, log: (s) => more.push(String(s)), error: (s) => more.push(String(s)) });
  const t2 = more.join('\n');
  ok(/4 call\(s\) would be made, 1 skipped/.test(t2), 'a finished one is planned as a skip',
    (t2.match(/\d+ call\(s\) would be made.*/) || [''])[0]);
  ok(/skip .*gizmo/.test(t2), 'and named', (t2.match(/skip.*gizmo.*/) || [''])[0].trim());

  /* --force puts it back. */
  const forced = [];
  await styleRun(['--in', FIXTURES, '--out', out, '--dry-run', '--force'],
    { styleImage: exploding, log: (s) => forced.push(String(s)), error: (s) => forced.push(String(s)) });
  ok(/5 call\(s\) would be made, 0 skipped/.test(forced.join('\n')), '--force plans all five again');
}

/* --------------------------------------------------- 9. style.mjs, stubbed model */

say('\n9. style.mjs END TO END, WITH THE MODEL STUBBED\n');
{
  const out = path.join(TMP, 'styled');
  const png = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png().toBuffer();
  let called = 0;
  const stub = async ({ imageSize: size }) => {
    called++;
    /* One slug is refused, one fails transiently once, the rest succeed. */
    if (called === 2) throw Object.assign(new Error('no image'), { blockReason: 'SAFETY' });
    return { buffer: png, mimeType: 'image/png', width: 100, height: 150, model: 'stub-model', ms: 42 };
  };
  const lines = [];
  const code = await styleRun(['--in', FIXTURES, '--out', out, '--concurrency', '1'],
    { styleImage: stub, sleep: async () => {}, log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) });
  const text = lines.join('\n');

  ok(code === 0, 'a refusal is not a failed run', String(code));
  ok(/4 succeeded, 0 skipped, 1 refused, 0 failed/.test(text), 'four styled, one refused',
    (text.match(/Styling: .*/) || [''])[0]);

  const slugs = fs.readdirSync(out).filter((d) => !d.startsWith('_'));
  ok(slugs.length === 4, 'four output folders', slugs.join(', '));
/* bruce-lee is the one the stub refuses (it is second in listing order), so
     the meta to read is a slug that succeeded. */
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'tupac', 'meta.json'), 'utf8'));
  say(`  meta: ${JSON.stringify({ ...meta, source: '…', refsDir: '…' })}`);
  ok(meta.resolution === '2K', 'meta records the resolution', meta.resolution);
  ok(/^[0-9a-f]{64}$/.test(meta.promptSha256), 'and the prompt hash');
  ok(meta.refs.join(',') === 'ref-1.jpg,ref-2.jpg,ref-3.jpg', 'and the three references', meta.refs.join(','));
  ok(meta.model === 'stub-model' && meta.durationMs === 42, 'and what the model said');
  ok(fs.existsSync(path.join(out, 'tupac', 'styled-2k.png')), 'the picture is named for its size');
  ok(!fs.existsSync(path.join(out, 'bruce-lee')), 'and a refused slug leaves no folder behind');

  const sheet = fs.readFileSync(path.join(out, '_contact-sheet.html'), 'utf8');
  ok(/<img src="tupac\/styled-2k.png"/.test(sheet), 'the contact sheet links each picture');
  ok(/<figcaption>tupac/.test(sheet), 'with its slug underneath');
  ok((sheet.match(/<figure>/g) || []).length === 4, 'one cell per picture',
    String((sheet.match(/<figure>/g) || []).length));

  const runs = fs.readdirSync(path.join(out, '_runs'));
  ok(runs.length === 1, 'a run log was written', runs.join(','));
  const runLog = JSON.parse(fs.readFileSync(path.join(out, '_runs', runs[0]), 'utf8'));
  ok(runLog.summary.calls === 5, 'the log counts the calls made', String(runLog.summary.calls));

  /* Run it again: everything that worked is skipped, and the refusal is retried
     because nothing was written for it. */
  const second = [];
  let secondCalls = 0;
  await styleRun(['--in', FIXTURES, '--out', out, '--concurrency', '1'], {
    styleImage: async () => {
      secondCalls++;
      return { buffer: png, mimeType: 'image/png', width: 100, height: 150, model: 'stub-model', ms: 7 };
    },
    sleep: async () => {}, log: (s) => second.push(String(s)), error: (s) => second.push(String(s)),
  });
  ok(secondCalls === 1, 'only the one that had no output is called again', String(secondCalls));
  ok(/1 succeeded, 4 skipped/.test(second.join('\n')), 'and the rest are skipped',
    (second.join('\n').match(/Styling: .*/) || [''])[0]);
  ok(/running total across 2 run\(s\)/.test(second.join('\n')), 'the running total counts both runs');
}

/* ------------------------------------------------- 10. cutout.mjs, stubbed Fly */

say('\n10. cutout.mjs, WITH THE SERVICE STUBBED\n');
{
  process.env.CUTOUT_SERVICE_URL = 'https://csc-cutout.test/';
  process.env.CUTOUT_TOKEN = 'test-token-not-a-real-one';

  /* A real RGBA PNG with a transparent half, so the transparency check has
     something true to measure. */
  /* Built from raw pixels rather than by compositing: the top half really is
     alpha 0, which is what "something was cut out" looks like. */
  const raw = Buffer.alloc(10 * 10 * 4);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4;
      raw[i] = 200; raw[i + 1] = 30; raw[i + 2] = 40;
      raw[i + 3] = y < 5 ? 0 : 255;
    }
  }
  const rgba = await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer();
  const opaque = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png().toBuffer();

  let seen = null, callCount = 0;
  const fetchFn = async (url, init) => {
    callCount++;
    seen = { url, init };
    const body = callCount === 3 ? opaque : rgba;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'X-Cutout-Px': '10x10',
        'X-Alpha-Coverage': callCount === 3 ? '0.99' : '0.5',
        'X-BBox': '0,5,10,10',
      },
    });
  };

  const out = path.join(TMP, 'cut');
  const lines = [];
  const code = await cutoutRun(['--in', FIXTURES, '--out', out, '--concurrency', '1'],
    { fetchFn, sleep: async () => {}, log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) });
  const text = lines.join('\n');

  ok(code === 0, 'the run is clean', String(code));
  ok(seen.url === 'https://csc-cutout.test/cutout', 'posted to <service>/cutout, trailing slash trimmed', seen.url);
  ok(seen.init.method === 'POST', 'as a POST');
  ok(seen.init.headers.Authorization === 'Bearer test-token-not-a-real-one',
    'with a bearer token');
  ok(seen.init.headers['Content-Type'] === 'image/jpeg',
    'and JPEG bytes, exactly as the serverless path sends', seen.init.headers['Content-Type']);
  ok(Buffer.isBuffer(seen.init.body) && seen.init.body.slice(0, 2).toString('hex') === 'ffd8',
    'the body really is a JPEG', seen.init.body.slice(0, 2).toString('hex'));
  ok(!text.includes('test-token-not-a-real-one'), 'the token is never printed');

  ok(fs.existsSync(path.join(out, 'bruce-lee', 'cutout.png')), 'a cutout per slug');
  const cmeta = JSON.parse(fs.readFileSync(path.join(out, 'bruce-lee', 'cutout-meta.json'), 'utf8'));
  ok(cmeta.coverage === 0.5 && cmeta.bbox.join(',') === '0,5,10,10',
    'the headers are recorded', JSON.stringify({ c: cmeta.coverage, b: cmeta.bbox }));
  ok(cmeta.transparency.hasAlpha === true && cmeta.transparency.clearFraction > 0.4,
    'and the transparency measured', JSON.stringify(cmeta.transparency));

  ok(/NO TRANSPARENCY/.test(text), 'an all-opaque result is warned about',
    (text.match(/.*NO TRANSPARENCY.*/) || [''])[0].trim());
  ok(/removed only/.test(text), 'and so is one that removed almost nothing');
  ok(/1 warned/.test(text), 'the summary counts it', (text.match(/.*warned.*/) || [''])[0].trim());

  /* Resume */
  let again = 0;
  await cutoutRun(['--in', FIXTURES, '--out', out], {
    fetchFn: async (...a) => { again++; return fetchFn(...a); },
    sleep: async () => {}, log: quiet, error: quiet,
  });
  ok(again === 0, 'a second run calls nothing — all five are already cut out', String(again));

  /* Retry and refusal, through the real classify/retry path */
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts < 3) return new Response('upstream wobble', { status: 503 });
    return fetchFn('x', { headers: {} });
  };
  const one = path.join(FIXTURES, 'bruce-lee.jpg');
  const outRetry = path.join(TMP, 'cut-retry');
  await cutoutRun(['--in', one, '--out', outRetry],
    { fetchFn: flaky, sleep: async () => {}, log: quiet, error: quiet });
  ok(attempts === 3, 'a 503 is retried until it works', String(attempts));

  let refusedAttempts = 0;
  const outRefused = path.join(TMP, 'cut-refused');
  const r = await cutoutRun(['--in', one, '--out', outRefused], {
    fetchFn: async () => { refusedAttempts++; return new Response('no', { status: 400 }); },
    sleep: async () => {}, log: quiet, error: quiet,
  });
  ok(refusedAttempts === 1, 'a 400 is asked once', String(refusedAttempts));
  ok(r === 0, 'and lands as a refusal rather than a crash', String(r));

  /* A styled batch, whose pictures are one level down */
  {
    const batch = path.join(TMP, 'styled');   // written by section 9
    const outBatch = path.join(TMP, 'cut-batch');
    let batchCalls = 0;
    const lines2 = [];
    await cutoutRun(['--in', batch, '--out', outBatch], {
      fetchFn: async (...a) => { batchCalls++; return fetchFn(...a); },
      sleep: async () => {}, log: (s) => lines2.push(String(s)), error: (s) => lines2.push(String(s)),
    });
/* Five by now: section 9's second run styled the one that was refused. */
    ok(batchCalls === 5, 'pointing --in at a styled batch finds all of its pictures',
      String(batchCalls));
    ok(/reading the styled picture out of each slug folder/.test(lines2.join(' ')),
      'and says that is what it did');
    ok(fs.existsSync(path.join(outBatch, 'tupac', 'cutout.png')),
      'keeping the slug from the folder, not from "styled-2k"');
    ok(!fs.existsSync(path.join(outBatch, 'styled-2k')), 'so there is no styled-2k slug');
  }

  /* --dry-run */
  const dry = [];
  const outDry = path.join(TMP, 'cut-dry');
  await cutoutRun(['--in', FIXTURES, '--out', outDry, '--dry-run'], {
    fetchFn: () => { throw new Error('THE SERVICE WAS CALLED DURING A DRY RUN'); },
    log: (s) => dry.push(String(s)), error: (s) => dry.push(String(s)),
  });
  ok(/5 call\(s\) would be made/.test(dry.join('\n')), 'the cutout dry run plans five',
    (dry.join('\n').match(/\d+ call\(s\) would be made.*/) || [''])[0]);
  ok(!fs.existsSync(outDry), 'and writes nothing');

  /* --upscale with nothing installed */
  const up = [];
  const outUp = path.join(TMP, 'cut-up');
  const upCode = await cutoutRun(['--in', one, '--out', outUp, '--upscale'], {
    fetchFn: () => { throw new Error('should never be called'); },
    spawnSync: () => ({ error: new Error('ENOENT') }),
    log: (s) => up.push(String(s)), error: (s) => up.push(String(s)),
  });
  ok(upCode === 1, '--upscale with no Real-ESRGAN stops the run', String(upCode));
  ok(/realesrgan-ncnn-vulkan/.test(up.join('\n')), 'and says what to install');
  ok(/github.com\/xinntao\/Real-ESRGAN/.test(up.join('\n')), 'with where to get it');
  ok(!fs.existsSync(outUp), 'before anything was cut out, so nothing is lost');
  ok(findUpscaler(() => ({ error: new Error('ENOENT') })) === null, 'findUpscaler says so too');

  /* It now answers with the PATH, not the name. A bare name was never enough:
     the binary resolves its models against the working directory, so the tool
     has to know which folder the exe came out of in order to pass -m. */
  const located = findUpscaler(() => ({ status: 0, stdout: 'C:\\Tools\\realesrgan\\realesrgan-ncnn-vulkan.exe\r\n' }));
  ok(located && /realesrgan-ncnn-vulkan\.exe$/.test(located.bin), 'and finds one that is there', located?.bin);
  ok(located && located.models === path.join('C:\\Tools\\realesrgan', 'models'),
    'with the models folder beside it', located?.models);
  ok(findUpscaler(() => ({ status: 0, stdout: '' })) === null,
    'a finder that exits clean but names nothing is still nothing');

  delete process.env.CUTOUT_SERVICE_URL;
  delete process.env.CUTOUT_TOKEN;
}

/* ------------------------------------------------------------ 11. missing env */

say('\n11. MISSING CREDENTIALS\n');
{
  const keep = process.env.GOOGLE_AI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  const lines = [];
  const code = await styleRun(['--in', FIXTURES, '--out', path.join(TMP, 'nokey')], {
    styleImage: () => { throw new Error('should never be called'); },
    log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)),
  });
  ok(code === 1, 'style.mjs stops without a key', String(code));
  ok(/GOOGLE_AI_API_KEY is not set/.test(lines.join('\n')), 'and names the variable');
  ok(/\.env at the repo root/.test(lines.join('\n')), 'and where to put it');
  if (keep) process.env.GOOGLE_AI_API_KEY = keep;

  const clines = [];
  const ckeep = [process.env.CUTOUT_SERVICE_URL, process.env.CUTOUT_TOKEN];
  delete process.env.CUTOUT_SERVICE_URL; delete process.env.CUTOUT_TOKEN;
  const ccode = await cutoutRun(['--in', FIXTURES, '--out', path.join(TMP, 'nocut')], {
    fetchFn: () => { throw new Error('should never be called'); },
    log: (s) => clines.push(String(s)), error: (s) => clines.push(String(s)),
  });
  ok(ccode === 1, 'cutout.mjs stops without a service url', String(ccode));
  ok(/CUTOUT_SERVICE_URL is not set/.test(clines.join('\n')), 'and names that one');
  if (ckeep[0]) process.env.CUTOUT_SERVICE_URL = ckeep[0];
  if (ckeep[1]) process.env.CUTOUT_TOKEN = ckeep[1];
}

/* --------------------------------------------------------------- 12. --help */

say('\n12. --help\n');
{
  for (const [name, fn] of [['style', styleRun], ['cutout', cutoutRun]]) {
    const lines = [];
    const code = await fn(['--help'], { log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) });
    const text = lines.join('\n');
    ok(code === 0, `${name} --help exits clean`, String(code));
    ok(/Example/.test(text), `${name} --help has a worked example`);
    ok(/--dry-run/.test(text) && /--force/.test(text), `${name} --help documents the flags`);
  }
  const empty = [];
  await styleRun([], { log: (s) => empty.push(String(s)) });
  ok(/node tools\/builder\/style.mjs/.test(empty.join('\n')), 'and no arguments prints it too');
}

/* ------------------------------------------- 13. a slug is not always a name */

say('\n13. SLUGS INSIDE A STYLED BATCH\n');
{
  /* Every picture style.mjs writes is called styled-2k.png or styled-4k.png:
     the name is the size, and the folder is the subject. Taking the slug from
     the filename put every cutout in a batch into one folder called
     "styled-2k", each overwriting the last. These are that regression. */
  process.env.CUTOUT_SERVICE_URL = 'https://csc-cutout.test/';
  process.env.CUTOUT_TOKEN = 'test-token-not-a-real-one';

  const BATCH = path.join(TMP, 'slug-batch');
  const A = 'hf-20260709-093748-2d0bcd76';   // the real-world shape: a long hash
  const B = 'tupac-shakur';
  const C = 'renamed-on-disk';

  /** One slug folder holding one styled picture, and optionally a meta.json. */
  const makeSlugFolder = async (name, file, meta) => {
    const dir = path.join(BATCH, name);
    fs.mkdirSync(dir, { recursive: true });
    const png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).png().toBuffer();
    fs.writeFileSync(path.join(dir, file), png);
    if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return path.join(dir, file);
  };

  const aFile = await makeSlugFolder(A, 'styled-2k.png');
  const bFile = await makeSlugFolder(B, 'styled-4k.png');
  const cFile = await makeSlugFolder(C, 'styled-2k.png', { slug: 'the-recorded-slug', size: '2K' });

  /* The same transparent-topped PNG the stubbed service hands back in 10. */
  const raw = Buffer.alloc(10 * 10 * 4);
  for (let i = 0; i < 10 * 10; i++) {
    raw[i * 4] = 200; raw[i * 4 + 1] = 30; raw[i * 4 + 2] = 40;
    raw[i * 4 + 3] = i < 50 ? 0 : 255;
  }
  const cut = await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer();
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return new Response(cut, {
      status: 200,
      headers: {
        'Content-Type': 'image/png', 'X-Cutout-Px': '10x10',
        'X-Alpha-Coverage': '0.5', 'X-BBox': '0,5,10,10',
      },
    });
  };
  const svc = { fetchFn, sleep: async () => {}, log: quiet, error: quiet };

  /* (a) one 2K picture, named by hand, out of a batch */
  const outA = path.join(TMP, 'slug-out-a');
  ok(slugForArtwork(aFile) === A, 'a styled-2k.png takes its slug from its folder',
    slugForArtwork(aFile));
  ok(await cutoutRun(['--in', aFile, '--out', outA], svc) === 0, 'and the run is clean');
  ok(fs.existsSync(path.join(outA, A, 'cutout.png')), `written to ${A}/cutout.png`);
  ok(!fs.existsSync(path.join(outA, 'styled-2k')), 'not to a folder called styled-2k');
  ok(fs.existsSync(path.join(outA, A, 'cutout-meta.json')), 'its meta goes with it');
  ok(JSON.parse(fs.readFileSync(path.join(outA, A, 'cutout-meta.json'), 'utf8')).slug === A,
    'and records the same slug');

  /* (b) the 4K name is known too */
  const outB = path.join(TMP, 'slug-out-b');
  ok(slugForArtwork(bFile) === B, 'a styled-4k.png does the same', slugForArtwork(bFile));
  await cutoutRun(['--in', bFile, '--out', outB], svc);
  ok(fs.existsSync(path.join(outB, B, 'cutout.png')), `written to ${B}/cutout.png`);
  ok(!fs.existsSync(path.join(outB, 'styled-4k')), 'not to a folder called styled-4k');
  ok(STYLED_NAMES.includes(styledName('2k')) && STYLED_NAMES.includes(styledName('4k')),
    'both names come from the one definition style.mjs writes by', STYLED_NAMES.join(', '));

  /* (c) meta.json beats the folder it sits in */
  const outC = path.join(TMP, 'slug-out-c');
  ok(slugForArtwork(cFile) === 'the-recorded-slug',
    'a meta.json slug wins over the folder name', slugForArtwork(cFile));
  ok(slugForArtwork(cFile) !== C, 'explicitly: the folder name is NOT used when meta.json disagrees',
    `${C} -> ${slugForArtwork(cFile)}`);
  await cutoutRun(['--in', cFile, '--out', outC], svc);
  ok(fs.existsSync(path.join(outC, 'the-recorded-slug', 'cutout.png')),
    'so the cutout lands under the recorded slug');
  ok(!fs.existsSync(path.join(outC, C)), 'and not under the folder name');

  /* (d) the whole batch at once — the regression that matters */
  const outAll = path.join(TMP, 'slug-out-all');
  calls = 0;
  await cutoutRun(['--in', BATCH, '--out', outAll, '--concurrency', '1'], svc);
  /* _runs is the run log, not a slug -- the same underscore rule listStyledBatch
     reads a batch by. */
  const made = fs.readdirSync(outAll)
    .filter((d) => !d.startsWith('_') && fs.statSync(path.join(outAll, d)).isDirectory()).sort();
  ok(calls === 3, 'three pictures in the batch, three calls', String(calls));
  ok(made.length === 3, 'three output folders, not one', made.join(', '));
  ok(made.join(',') === [A, B, 'the-recorded-slug'].sort().join(','),
    'each named for its own artwork', made.join(', '));
  ok(!made.some((d) => /^styled-/.test(d)), 'none of them called styled-2k or styled-4k');
  ok(made.every((d) => fs.existsSync(path.join(outAll, d, 'cutout.png'))),
    'and every one of the three kept its cutout — nothing overwrote anything');

  /* (e) a loose photograph is still its own name */
  const loose = path.join(TMP, 'loose');
  fs.mkdirSync(loose, { recursive: true });
  const jpg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg().toBuffer();
  fs.writeFileSync(path.join(loose, 'holiday-photo.jpg'), jpg);
  const looseFile = path.join(loose, 'holiday-photo.jpg');
  ok(slugForArtwork(looseFile) === 'holiday-photo', 'a loose image keeps its stem',
    slugForArtwork(looseFile));
  ok(listImages(looseFile)[0].slug === 'holiday-photo', 'and so does listImages');
  const outLoose = path.join(TMP, 'slug-out-loose');
  await cutoutRun(['--in', looseFile, '--out', outLoose], svc);
  ok(fs.existsSync(path.join(outLoose, 'holiday-photo', 'cutout.png')),
    'written under holiday-photo, exactly as before');

  /* (f) resume and --force, under the new rule */
  calls = 0;
  await cutoutRun(['--in', aFile, '--out', outA], svc);
  ok(calls === 0, 'a slug that already has a cutout.png is skipped', String(calls));
  await cutoutRun(['--in', BATCH, '--out', outAll], svc);
  ok(calls === 0, 'and so is the whole batch, all three of them', String(calls));
  await cutoutRun(['--in', aFile, '--out', outA, '--force'], svc);
  ok(calls === 1, '--force does it again — and finds the same slug to skip by', String(calls));

  delete process.env.CUTOUT_SERVICE_URL;
  delete process.env.CUTOUT_TOKEN;
}

/* ------------------------------ 14. the input a photograph arrives at the model as */

say('\n14. INPUT NORMALISATION\n');
{
  /* The shop never sends a customer's photograph at its original size: the
     browser re-encodes it to 4000px on the longest side, under 4 MiB, first.
     The CLI sent the original bytes, and a 5302 x 2758 JPEG that styles fine
     through the builder came back from it with no image at all. Both paths
     read the rules out of _shared/photo-input.mjs now, so these are the rules
     rather than one implementation of them. */

  const jpegOf = (w, h) => sharp({
    create: { width: w, height: h, channels: 3, background: { r: 90, g: 40, b: 120 } },
  }).jpeg().toBuffer();

  /* (1) the exact photograph that failed, and one far too small to touch */
  const big = await normaliseWithSharp(await jpegOf(5302, 2758), { sharp });
  ok(big.width === 4000 && big.height === 2081,
    '5302x2758 goes to 4000x2081 — 4000 on the longest side',
    `${big.width}x${big.height}`);
  ok(big.originalWidth === 5302 && big.originalHeight === 2758,
    'and remembers what it was', `${big.originalWidth}x${big.originalHeight}`);
  ok(big.mimeType === 'image/jpeg' && big.quality === 0.9,
    'as a JPEG at the ladder\u2019s first quality', `${big.mimeType} q${big.quality}`);
  ok(big.buffer.length <= UPLOAD_TARGET_BYTES, 'inside the 4 MiB the upload aims at',
    `${Math.round(big.buffer.length / 1024)} KB`);

  const small = await normaliseWithSharp(await jpegOf(280, 362), { sharp });
  ok(small.width === 280 && small.height === 362,
    '280x362 is left at 280x362 — nothing is ever upscaled',
    `${small.width}x${small.height}`);
  ok(small.resized === false, 'and says it was not resized');

  /* (2) every shape through the same rule */
  const shapes = [
    ['portrait', 2758, 5302, 2081, 4000],
    ['landscape', 5302, 2758, 4000, 2081],
    ['square, too big', 6000, 6000, 4000, 4000],
    ['square, already inside', 3000, 3000, 3000, 3000],
    ['very wide', 9000, 1000, 4000, 444],
    ['exactly at the ceiling', 4000, 2500, 4000, 2500],
  ];
  for (const [what, w, h, ew, eh] of shapes) {
    const r = await normaliseWithSharp(await jpegOf(w, h), { sharp });
    ok(r.width === ew && r.height === eh, `${what}: ${w}x${h} -> ${ew}x${eh}`,
      `${r.width}x${r.height}`);
    /* And the pure maths agrees with what sharp actually produced, so the
       browser -- which has only the maths -- cannot land somewhere else. */
    const planned = plannedSize(w, h);
    ok(planned.width === r.width && planned.height === r.height,
      `  and plannedSize said so before anything was encoded`,
      `${planned.width}x${planned.height}`);
  }

  ok(fitWithin(5302, 2758, 4000).width === 4000 && fitWithin(100, 50, 4000).width === 100,
    'fitWithin never enlarges');
  ok(stepQuality(0.64) === QUALITY_FLOOR, 'the quality step lands ON the floor, not below it',
    String(stepQuality(0.64)));
  ok(ladderFor('customer', 9, 9).length === ENCODE_LADDER.length
    && ladderFor('studio', 9000, 9000)[0][0] === 9000,
    'studio starts at the source\u2019s own size, customer at the ceiling');
  ok(targetBytesFor('studio') > targetBytesFor('customer'), 'and has its own ceiling');

  /* (3) style.mjs sends the prepared bytes, not the file */
  const NORM = path.join(TMP, 'norm-src');
  fs.mkdirSync(NORM, { recursive: true });
  fs.writeFileSync(path.join(NORM, 'george-michael.jpg'), await jpegOf(5302, 2758));
  const styledPng = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png().toBuffer();

  let sent = null;
  await styleRun(['--in', NORM, '--out', path.join(TMP, 'norm-out')], {
    styleImage: async (args) => {
      sent = { ...args, px: await sharp(args.buffer).metadata() };
      return { buffer: styledPng, mimeType: 'image/png', width: 100, height: 150, model: 'stub', ms: 5 };
    },
    sleep: async () => {}, log: quiet, error: quiet,
  });
  ok(sent && sent.px.width === 4000 && sent.px.height === 2081,
    'the model is shown 4000x2081, not 5302x2758',
    sent ? `${sent.px.width}x${sent.px.height}` : 'nothing was sent');
  ok(sent.mimeType === 'image/jpeg', 'as a JPEG', sent && sent.mimeType);
  ok(sent.aspectRatio === '16:9', 'at the ratio read off what is being sent', sent && sent.aspectRatio);
  const nMeta = JSON.parse(fs.readFileSync(path.join(TMP, 'norm-out', 'george-michael', 'meta.json'), 'utf8'));
  ok(nMeta.sourcePx.join('x') === '5302x2758', 'meta.json records the original size',
    nMeta.sourcePx.join('x'));
  ok(nMeta.sentPx.join('x') === '4000x2081', 'and the size actually sent', nMeta.sentPx.join('x'));
  ok(nMeta.sentMimeType === 'image/jpeg' && nMeta.sentQuality === 0.9 && nMeta.sentBytes > 0,
    'and how it was encoded', `${nMeta.sentMimeType} q${nMeta.sentQuality} ${nMeta.sentBytes}B`);

  /* (4) a batch where everything fails still reports */
  const THREE = path.join(TMP, 'three-src');
  fs.mkdirSync(THREE, { recursive: true });
  for (const n of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(THREE, `${n}.jpg`), await jpegOf(600, 400));
  }
  const allFailOut = path.join(TMP, 'all-fail');
  const failLines = [];
  let thrown = null;
  let code = null;
  try {
    code = await styleRun(['--in', THREE, '--out', allFailOut, '--concurrency', '1'], {
      styleImage: async () => { throw new Error('the wheels came off'); },
      sleep: async () => {},
      log: (l) => failLines.push(String(l)), error: (l) => failLines.push(String(l)),
    });
  } catch (e) { thrown = e; }
  const failText = failLines.join('\n');
  ok(thrown === null, 'three failures out of three does not throw',
    thrown ? `${thrown.code || ''} ${thrown.message}` : '');
  ok(!/ENOENT/.test(failText + String(thrown && thrown.message)),
    'nothing goes looking for a folder that was never created');
  ok(code === 1, 'and the run exits non-zero', String(code));
  ok(/0 succeeded, 0 skipped, 0 refused, 3 failed/.test(failText), 'the summary is still printed',
    (failText.match(/Styling: .*/) || [''])[0]);
  ok(fs.existsSync(allFailOut), 'the output folder exists even though nothing was written to it');
  const failRuns = fs.readdirSync(path.join(allFailOut, '_runs'));
  ok(failRuns.length === 1, 'and the run log was written', failRuns.join(','));
  const failLog = JSON.parse(fs.readFileSync(path.join(allFailOut, '_runs', failRuns[0]), 'utf8'));
  ok(failLog.rows.length === 3 && failLog.rows.every((r) => r.result === 'failed'),
    'with all three failures in it', failLog.rows.map((r) => r.result).join(','));
  ok(/Nothing styled yet/.test(fs.readFileSync(path.join(allFailOut, '_contact-sheet.html'), 'utf8')),
    'the contact sheet says so rather than dying on the empty folder');

  /* (5) one of three fails; the other two are written and counted */
  const mixedOut = path.join(TMP, 'one-fail');
  const mixedLines = [];
  let n = 0;
  const mixedCode = await styleRun(['--in', THREE, '--out', mixedOut, '--concurrency', '1'], {
    styleImage: async () => {
      n++;
      if (n === 2) throw new Error('just this one');
      return { buffer: styledPng, mimeType: 'image/png', width: 100, height: 150, model: 'stub', ms: 5 };
    },
    sleep: async () => {},
    log: (l) => mixedLines.push(String(l)), error: (l) => mixedLines.push(String(l)),
  });
  const mixedText = mixedLines.join('\n');
  ok(mixedCode === 1, 'one failure still makes the run non-zero', String(mixedCode));
  ok(/2 succeeded, 0 skipped, 0 refused, 1 failed/.test(mixedText), 'and the counts are right',
    (mixedText.match(/Styling: .*/) || [''])[0]);
  const written = fs.readdirSync(mixedOut).filter((d) => !d.startsWith('_'));
  ok(written.length === 2, 'the two that worked are on disk', written.join(', '));
  ok(written.every((d) => fs.existsSync(path.join(mixedOut, d, 'styled-2k.png'))),
    'each with its picture');

  /* (6) a refusal says what the model actually said */
  const refusedOut = path.join(TMP, 'refused-detail');
  const refLines = [];
  let refCalls = 0;
  const refCode = await styleRun(['--in', NORM, '--out', refusedOut], {
    styleImage: async () => {
      refCalls++;
      throw Object.assign(new Error('The model returned no image'), {
        finishReason: 'IMAGE_SAFETY',
        finishMessage: 'Generation stopped by the image safety filter',
        blockReason: 'PROHIBITED_CONTENT',
        safetyRatings: [
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true },
          { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' },
        ],
        modelText: "I can't create images that depict a real person.",
      });
    },
    sleep: async () => {}, log: (l) => refLines.push(String(l)), error: (l) => refLines.push(String(l)),
  });
  const refText = refLines.join('\n');
  ok(refCalls === 1, 'a refusal is asked exactly once — it is an answer, not a wobble',
    String(refCalls));
  ok(refCode === 0, 'and a refused batch is not a failed run', String(refCode));
  const refRuns = fs.readdirSync(path.join(refusedOut, '_runs'));
  const refLog = JSON.parse(fs.readFileSync(path.join(refusedOut, '_runs', refRuns[0]), 'utf8'));
  const err = refLog.rows[0].error;
  ok(refLog.rows[0].result === 'refused', 'recorded as a refusal', refLog.rows[0].result);
  ok(err.finishReason === 'IMAGE_SAFETY', 'the run log keeps the finishReason', err.finishReason);
  ok(err.blockReason === 'PROHIBITED_CONTENT', 'and the block reason', err.blockReason);
  ok(err.finishMessage === 'Generation stopped by the image safety filter', 'and the finish message');
  ok(err.safety.join(' | ') === 'HARM_CATEGORY_DANGEROUS_CONTENT: HIGH (blocked)',
    'and the rating that tripped, without the four that did not', err.safety.join(' | '));
  ok(/real person/.test(err.modelText || ''), 'and what the model said instead of drawing',
    err.modelText);
  ok(/IMAGE_SAFETY/.test(refText) && /PROHIBITED_CONTENT/.test(refText),
    'the short form is on screen too',
    (refText.match(/.*finish=.*/) || [''])[0].trim());

  /* An empty response is a different thing from a refusal, and must not read
     like one. */
  const empty = refusalDetail(new Error('The model returned no image'));
  ok(/empty response/.test(empty.short), 'nothing at all says so in as many words', empty.short);

  /* (7) a genuine wobble is still retried */
  const flakyOut = path.join(TMP, 'flaky-norm');
  let tries = 0;
  const flakyCode = await styleRun(['--in', NORM, '--out', flakyOut], {
    styleImage: async () => {
      tries++;
      if (tries < 3) throw Object.assign(new Error('upstream wobble'), { status: 503 });
      return { buffer: styledPng, mimeType: 'image/png', width: 100, height: 150, model: 'stub', ms: 5 };
    },
    sleep: async () => {}, log: quiet, error: quiet,
  });
  ok(tries === 3, 'a 503 is tried again until it works', String(tries));
  ok(flakyCode === 0, 'and the run comes out clean', String(flakyCode));
}

/* ----------------------------------------------------- 15. upscale.mjs, planning */

say('\n15. UPSCALE — WHICH ROUTE, AND HOW FAR\n');
{
  /* The shape is kept whatever the route. */
  ok(String(fitLong(3504, 2336, 3600)) === '3600,2400', 'the long edge lands exactly on the target',
    String(fitLong(3504, 2336, 3600)));
  ok(String(fitLong(1024, 1536, 3600)) === '2400,3600', 'and it is the LONG edge, whichever way up',
    String(fitLong(1024, 1536, 3600)));

  /* Already big enough: not touched, not resized down. */
  const big = planFor({ width: 4096, height: 4096 }, 3600);
  ok(big.action === 'skip', 'a file at or above the target is left alone', big.action);

  /* The 165 files this margin exists for. 3504 is 97% of 3600: the model has
     nothing to add across a 2.7% stretch, and would cost 17 seconds saying so. */
  const near = planFor({ width: 3504, height: 2336 }, 3600);
  ok(near.action === 'resize', '3504 -> 3600 skips the model entirely', near.action);
  ok(String(near.to) === '3600,2400', 'and lands on the target', String(near.to));
  ok(3504 >= 3600 * RESIZE_ONLY_FRACTION, 'because it is inside the margin');

  /* Just outside the margin is a model job. */
  const edge = planFor({ width: 3239, height: 2159 }, 3600);
  ok(edge.action === 'model', 'one pixel outside the margin goes through the model', edge.action);

  const far = planFor({ width: 1024, height: 1536 }, 3600);
  ok(far.action === 'model', 'a 1024x1536 icon goes through the model', far.action);
  ok(far.reachable === true, 'and 4x is more than enough to reach 3600');
  ok(String(far.to) === '2400,3600', 'so it comes back down to exactly the target', String(far.to));

  /* Cannot get there in one pass: reported, and NOT chained. */
  const short = planFor({ width: 500, height: 400 }, 3600);
  ok(short.action === 'model' && short.reachable === false, 'a file 4x still cannot lift is flagged');
  ok(String(short.to) === '2000,1600', 'and is left at its 4x size rather than passed twice',
    String(short.to));

  /* Every file in the actual library clears 3600 in one pass; the smallest
     long edge in it is 908. This is the boundary that decides that. */
  ok(planFor({ width: 908, height: 1732 }, 3600).reachable === true,
    'the smallest file in the library reaches 3600 in one pass');
  ok(planFor({ width: 899, height: 600 }, 3600).reachable === false,
    'below 900 on the long edge it would not');

  ok(planFor({ width: 0, height: 0 }, 3600).action === 'failed', 'no dimensions is a row, not a crash');
}

/* ------------------------------------------------- 16. upscale.mjs, what it walks */

say('\n16. UPSCALE — WHAT IT WALKS\n');
{
  const root = path.join(TMP, 'lib');
  const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
  mk(path.join(root, 'Walter White', 'walter-white.png'));
  mk(path.join(root, 'Walter White', `walter-white${ORIGINAL_SUFFIX}.png`));
  mk(path.join(root, 'Walter White', 'Old design', 'walter-white.png'));
  mk(path.join(root, 'Ayrton Senna', 'ayrton-senna-icon.png'));
  mk(path.join(root, 'Ayrton Senna', 'notes.txt'));
  mk(path.join(root, '_runs', '2026-01-01.json'));
  mk(path.join(root, 'Deep', 'Nested', 'folder', 'thing.jpg'));

  const found = listArtwork(root).map((f) => f.rel.replace(/\\/g, '/'));
  ok(found.length === 3, 'three images found', found.join(', '));
  ok(found.includes('Walter White/walter-white.png'), 'the artwork itself');
  ok(found.includes('Deep/Nested/folder/thing.jpg'), 'however deep it sits');
  ok(!found.some((f) => /Old design/.test(f)), '"Old design" is never walked into');
  ok(!found.some((f) => f.includes(ORIGINAL_SUFFIX)), `a ${ORIGINAL_SUFFIX} backup is not upscaled again`);
  ok(!found.some((f) => f.includes('_runs')), 'and neither is our own run log folder');
  ok(!found.some((f) => /notes\.txt/.test(f)), 'non-images are left out');

  ok(originalFor(path.join('a', 'b.png')) === path.join('a', `b${ORIGINAL_SUFFIX}.png`),
    'the backup sits beside the file, keeping its extension');
  ok(originalFor(path.join('a', 'b.jpg')) === path.join('a', `b${ORIGINAL_SUFFIX}.jpg`),
    'including for a jpeg');

  /* The slug is the filename, so --only speaks the language the folders do. */
  ok(listArtwork(root).some((f) => f.slug === 'ayrton-senna-icon'), '--only matches on the filename');

  /* A real library folder holds more than the library: the icon set this was
     built for has 1214 images in it, of which only 205 are the artwork. The
     rest are print exports, product mockups and reference photographs, and
     upscaling those would be hours of work nobody wanted. */
  const pngOnly = listArtwork(root, { exts: ['.png'] }).map((f) => f.rel);
  ok(pngOnly.length === 2, '--ext png leaves the jpegs alone', String(pngOnly.length));
  ok(!pngOnly.some((f) => /\.jpg$/.test(f)), 'none of them a jpeg');
  ok(listArtwork(root, { exts: ['jpg'] }).length === 1, 'and a bare extension works too');
}

/* ------------------------------------------------ 17. upscale.mjs, finding the exe */

say('\n17. UPSCALE — FINDING THE BINARY AND ITS MODELS\n');
{
  const exe = 'C:\\Tools\\realesrgan\\realesrgan-ncnn-vulkan.exe';
  const asked = [];
  const where = (cmd, args) => { asked.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: `${exe}\r\n` }; };
  const got = locateUpscaler(where);
  ok(got.bin === exe, 'the full path, not the bare name', got.bin);
  ok(got.models === path.join('C:\\Tools\\realesrgan', 'models'), 'models resolved from the exe, not the CWD', got.models);
  ok(/^(where|which) realesrgan/.test(asked[0]), 'asked the platform where it is', asked[0]);

  ok(locateUpscaler(() => ({ status: 1, stdout: '' })) === null, 'a non-zero finder means not installed');
  ok(locateUpscaler(() => { throw new Error('no such command'); }) === null, 'and a thrown finder is not a crash');

  /* Model presence is judged against the folder, not a hardcoded list. */
  const have = new Set([
    path.join('m', 'realesrgan-x4plus.param'),
    path.join('m', `realesr-animevideov3-x${MODEL_SCALE}.param`),
  ]);
  const exists = (p) => have.has(p);
  ok(modelInstalled('m', 'realesrgan-x4plus', exists), 'a plain model is found by its param file');
  ok(modelInstalled('m', 'realesr-animevideov3', exists),
    'animevideov3 is found despite shipping one network per scale');
  ok(!modelInstalled('m', 'realesrgan-x4plus-anime', exists), 'and one that is absent is absent');

  const listed = installedModels('m', () => ['realesrgan-x4plus.param', 'realesrgan-x4plus.bin',
    'realesr-animevideov3-x2.param', 'realesr-animevideov3-x4.param']);
  ok(String(listed) === 'realesr-animevideov3,realesrgan-x4plus',
    'the installed list is de-duplicated across scales', String(listed));
  ok(String(installedModels('nope', () => { throw new Error('ENOENT'); })) === '',
    'and an unreadable models folder is an empty list');
}

/* --------------------------------------------- 18. upscale.mjs, retrying the GPU */

say('\n18. UPSCALE — WHICH FAILURES ARE WORTH ASKING AGAIN\n');
{
  ok(classifyUpscaleFailure(new Error('vkAllocateMemory failed')).kind === 'transient',
    'a Vulkan allocation failure is a wobble, not a verdict');
  ok(classifyUpscaleFailure(new Error('out of device memory')).kind === 'transient',
    'so is running the GPU out of room');
  ok(classifyUpscaleFailure(new Error('decode: unsupported PNG')).kind === 'failed',
    'a file the decoder cannot read is not');
  ok(classifyUpscaleFailure(Object.assign(new Error('nope'), { status: 404 })).kind === 'refused',
    'and the shared rules still apply underneath');
}

/* ------------------------------------------ 19. upscale.mjs, end to end on disk */

say('\n19. UPSCALE — END TO END, IN PLACE\n');
{
  const root = path.join(TMP, 'run');
  const dir = path.join(root, 'Near Enough');
  fs.mkdirSync(dir, { recursive: true });
  const near = path.join(dir, 'near-enough.png');
  /* 3300 is inside the 90% margin of 3600, so this one never sees the GPU. */
  await sharp({ create: { width: 3300, height: 2200, channels: 3, background: '#3a6ea5' } })
    .png().toFile(near);

  const modelDir = path.join(root, 'Needs Model');
  fs.mkdirSync(modelDir, { recursive: true });
  const small = path.join(modelDir, 'needs-model.png');
  await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#a53a6e' } })
    .png().toFile(small);

  /* --dry-run must not spawn anything at all. The stub proves it by throwing. */
  const dryOut = [];
  const dryCode = await upscaleRun(['--in', root, '--target', '3600', '--dry-run'], {
    spawnSync: () => { throw new Error('the dry run spawned a process'); },
    log: (s) => dryOut.push(String(s)), error: (s) => dryOut.push(String(s)),
  });
  const dryText = dryOut.join('\n');
  ok(dryCode === 0, 'the dry run comes out clean', String(dryCode));
  ok(/resize/.test(dryText) && /model/.test(dryText), 'and names both routes');
  ok(/1 would go through the model, 1 resize only/.test(dryText),
    'counting each correctly', (dryText.match(/\d+ would go through the model.*/) || [''])[0]);
  ok(!fs.existsSync(originalFor(near)), 'nothing was backed up');
  ok((await sharp(near).metadata()).width === 3300, 'and nothing was written');

  /* The real thing. spawnSync stands in for the GPU and writes a 4x file, so
     the arguments it is handed are checked exactly as the binary would see
     them -- which is where the -n and -m defects lived. */
  const fourX = await sharp({ create: { width: 4000, height: 2400, channels: 3, background: '#a53a6e' } })
    .png().toBuffer();
  const spawned = [];
  const fakeGpu = (bin, args) => {
    spawned.push({ bin, args });
    const out = args[args.indexOf('-o') + 1];
    fs.writeFileSync(out, fourX);
    return { status: 0, stdout: '', stderr: '' };
  };
  const where = () => ({ status: 0, stdout: `C:\\Tools\\realesrgan\\realesrgan-ncnn-vulkan.exe\r\n` });
  const spawnSync = (cmd, args) =>
    (/^(where|which)$/.test(cmd) ? where() : fakeGpu(cmd, args));

  const out = [];
  const code = await upscaleRun(['--in', root, '--target', '3600'], {
    spawnSync, log: (s) => out.push(String(s)), error: (s) => out.push(String(s)),
  });
  ok(code === 0, 'the run succeeds', String(code));

  const nearMeta = await sharp(near).metadata();
  ok(nearMeta.width === 3600 && nearMeta.height === 2400,
    'the near-enough file is resized to the target', `${nearMeta.width}x${nearMeta.height}`);
  ok(spawned.length === 1, 'and the GPU was asked exactly once, for the other one', String(spawned.length));

  const smallMeta = await sharp(small).metadata();
  ok(smallMeta.width === 3600 && smallMeta.height === 2160,
    'the model file overshoots to 4x then comes down to the target',
    `${smallMeta.width}x${smallMeta.height}`);

  const args = spawned[0].args.join(' ');
  ok(/-n realesrgan-x4plus/.test(args), 'the model is named explicitly, not left to default to anime video', args);
  ok(new RegExp(`-s ${MODEL_SCALE}(\\s|$)`).test(args), 'always the native 4x');
  ok(/-m .*realesrgan.models/.test(args.replace(/\\/g, '/')), 'and -m points at the models beside the exe');

  /* The originals are kept, and they are the originals. */
  ok(fs.existsSync(originalFor(near)), 'the original is kept beside the result');
  const keptMeta = await sharp(originalFor(near)).metadata();
  ok(keptMeta.width === 3300, 'untouched, at its original size', `${keptMeta.width}x${keptMeta.height}`);
  ok(fs.existsSync(path.join(root, '_runs')), 'a run log is written, as the other tools do');

  /* Resume: the backup is the marker. */
  const again = [];
  const againCode = await upscaleRun(['--in', root, '--target', '3600'], {
    spawnSync: () => { throw new Error('should not run again'); },
    log: (s) => again.push(String(s)), error: (s) => again.push(String(s)),
  });
  ok(againCode === 0 && /Nothing to do/.test(again.join('\n')),
    'a second run does nothing, because the backups say it is done');

  /* --force redoes it -- FROM THE BACKUP. Upscaling an upscale is the one
     thing a redo must never do. */
  spawned.length = 0;
  const forced = [];
  await upscaleRun(['--in', root, '--target', '3600', '--force'], {
    spawnSync, log: (s) => forced.push(String(s)), error: (s) => forced.push(String(s)),
  });
  ok(spawned.length === 1, '--force runs the model again', String(spawned.length));
  const inArg = spawned[0].args[spawned[0].args.indexOf('-i') + 1];
  ok(inArg === originalFor(small), 'and reads the ORIGINAL, not the result of the last run', inArg);
  const forcedKept = await sharp(originalFor(small)).metadata();
  ok(forcedKept.width === 1000, 'so the kept original is never overwritten by an upscale',
    `${forcedKept.width}x${forcedKept.height}`);
}

/* --------------------------------------- 20. upscale.mjs, refusing to guess */

say('\n20. UPSCALE — WHEN IT WILL NOT PROCEED\n');
{
  const root = path.join(TMP, 'noexe');
  fs.mkdirSync(root, { recursive: true });
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#111' } })
    .png().toFile(path.join(root, 'small.png'));

  const out = [];
  const code = await upscaleRun(['--in', root], {
    spawnSync: () => ({ status: 1, stdout: '' }),
    log: (s) => out.push(String(s)), error: (s) => out.push(String(s)),
  });
  ok(code === 1, 'no Real-ESRGAN stops the run before any file is touched', String(code));
  ok(/github.com\/xinntao\/Real-ESRGAN/.test(out.join('\n')), 'and says where to get it');
  ok(!fs.existsSync(originalFor(path.join(root, 'small.png'))), 'nothing was backed up or replaced');

  const bad = [];
  const badCode = await upscaleRun(['--in', path.join(TMP, 'does-not-exist')], {
    log: (s) => bad.push(String(s)), error: (s) => bad.push(String(s)),
  });
  ok(badCode === 1 && /must be a folder that exists/.test(bad.join('\n')),
    'a folder that is not there is said plainly');

  ok(DEFAULT_TARGET === 3600 && DEFAULT_MODEL === 'realesrgan-x4plus',
    'the defaults are the ones the report named', `${DEFAULT_TARGET}, ${DEFAULT_MODEL}`);

  const ext = [];
  const extCode = await upscaleRun(['--in', root, '--ext', 'tiff'], {
    log: (s) => ext.push(String(s)), error: (s) => ext.push(String(s)),
  });
  ok(extCode === 1 && /--ext does not know \.tiff/.test(ext.join('\n')),
    'an extension it cannot read is refused rather than silently matching nothing',
    (ext.join('\n').match(/--ext does not know.*/) || [''])[0]);
}

fs.rmSync(TMP, { recursive: true, force: true });
say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
