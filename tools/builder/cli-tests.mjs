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
} from './_cli.mjs';
import { run as styleRun, contactSheet, HELP as STYLE_HELP } from './style.mjs';
import {
  run as cutoutRun, findUpscaler, transparencyOf, postCutout, HELP as CUTOUT_HELP,
  UPSCALER_MISSING,
} from './cutout.mjs';

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
  ];
  for (const [err, want, what] of cases) {
    ok(classifyFailure(err).kind === want, `${what} -> ${want}`, classifyFailure(err).kind);
  }
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
  ok(findUpscaler(() => ({ status: 0 })) === 'realesrgan-ncnn-vulkan', 'and finds one that is there');

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

fs.rmSync(TMP, { recursive: true, force: true });
say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
