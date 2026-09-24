/**
 * The render sweep's rules, tested.
 *
 *   node tools/builder/render-sweep-tests.mjs
 *
 * No blobs and no Sanity: classify() and parseKey() are the whole judgement,
 * and both are pure. The point of the file is that the two failure modes are
 * told apart correctly, because they need different fixes -- an INCOMPLETE has
 * to be rendered again, a RACE only has to be published again.
 */
import { classify, parseKey, run, readScene, resolveCredentials } from './render-sweep.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* ---------------------------------------------------- 1. the two modes */

say('\n1. TELLING THE TWO FAILURES APART\n');
{
  /* 007: saved, invoked, never finished. */
  const incomplete = classify({
    savedAt: '2026-09-17T15:46:44.409Z', renderedAt: undefined,
    publishedAt: '2026-09-17T15:46:52Z', hasProduct: true, hasDraft: false, draftsKnown: true,
  });
  ok(incomplete.mode === 'INCOMPLETE', 'a scene with savedAt and no renderedAt is INCOMPLETE', incomplete.mode);
  ok(/never finished/.test(incomplete.why), 'and says so plainly', incomplete.why);

  /* Adam & The Ants: rendered six seconds after the publish. */
  const race = classify({
    savedAt: '2026-09-15T18:55:25.938Z', renderedAt: '2026-09-15T18:55:45.000Z',
    publishedAt: '2026-09-15T18:55:39Z', hasProduct: true, hasDraft: true, draftsKnown: true,
  });
  ok(race.mode === 'RACE', 'a render that finished AFTER the publish is a RACE', race.mode);
  ok(/on the draft, not live/.test(race.why), 'and says where the artwork actually is', race.why);
  ok(/6\.0 s|6 s|6\.0s/.test(race.why) || /AFTER the publish/.test(race.why),
    'reporting how far the wrong side of it', race.why);

  /* The ordinary case: rendered, then published. */
  const good = classify({
    savedAt: '2026-09-15T18:47:20Z', renderedAt: '2026-09-15T18:47:39Z',
    publishedAt: '2026-09-15T18:47:50Z', hasProduct: true,
  });
  ok(good.mode === 'ok', 'rendered before the publish is fine', good.mode);

  /* One second either side is the whole difference, and there is no useful
     tolerance to add -- the publish either caught the artwork or it did not. */
  const justBefore = classify({ savedAt: 'x', renderedAt: '2026-09-15T12:00:00Z', publishedAt: '2026-09-15T12:00:01Z', hasProduct: true, hasDraft: true, draftsKnown: true });
  const justAfter = classify({ savedAt: 'x', renderedAt: '2026-09-15T12:00:01Z', publishedAt: '2026-09-15T12:00:00Z', hasProduct: true, hasDraft: true, draftsKnown: true });
  ok(justBefore.mode === 'ok', 'a second before the publish is ok');
  ok(justAfter.mode === 'RACE', 'a second after it is not');
}

/* --------------------------------- 1b. the race that was not a race */

say('\n1b. THE TIMESTAMPS ACCUSE, THE DRAFT CONVICTS\n');
{
  /* The first real sweep reported two RACEs on live products, 336ms and 401ms
     the wrong side of the publish. Neither had a draft. Sanity returns
     _updatedAt at second precision while renderedAt carries milliseconds, so a
     render that landed INSIDE the publish second is indistinguishable from one
     that landed just after it -- and a race only matters if artwork is left
     stranded on a draft. No draft, nothing stranded. */
  const rollingStones = classify({
    savedAt: '2026-09-16T16:18:53.403Z', renderedAt: '2026-09-16T16:19:08.336Z',
    publishedAt: '2026-09-16T16:19:08Z', hasProduct: true,
    hasDraft: false, draftsKnown: true,
  });
  ok(rollingStones.mode === 'ok', 'a late-looking render with no draft left is not a race', rollingStones.mode);
  ok(/no draft remains/.test(rollingStones.why), 'and the reason says what was actually checked', rollingStones.why);

  /* The identical timestamps with a draft still sitting there ARE a race. The
     draft is doing the work, not a tolerance on the gap. */
  const stranded = classify({
    savedAt: '2026-09-16T16:18:53.403Z', renderedAt: '2026-09-16T16:19:08.336Z',
    publishedAt: '2026-09-16T16:19:08Z', hasProduct: true,
    hasDraft: true, draftsKnown: true,
  });
  ok(stranded.mode === 'RACE', 'the same gap with a draft left behind is', stranded.mode);

  /* No token: the drafts are unknown, so the timestamps are all there is. It
     still reports, and says the verdict is weaker than usual. */
  const noToken = classify({
    savedAt: 'x', renderedAt: '2026-09-15T18:55:45.000Z',
    publishedAt: '2026-09-15T18:55:39Z', hasProduct: true,
    hasDraft: false, draftsKnown: false,
  });
  ok(noToken.mode === 'RACE', 'without drafts it still reports on the timestamps', noToken.mode);
  ok(/timestamps alone/.test(noToken.why), 'but admits that is all it has', noToken.why);

  /* And the draft check does not excuse the other mode -- an unfinished render
     is unfinished whether or not a draft is lying about. */
  const unfinished = classify({
    savedAt: '2026-09-17T15:46:44Z', renderedAt: undefined,
    publishedAt: '2026-09-17T15:46:52Z', hasProduct: true,
    hasDraft: false, draftsKnown: true,
  });
  ok(unfinished.mode === 'INCOMPLETE', 'an INCOMPLETE is still INCOMPLETE', unfinished.mode);
}

/* -------------------------------------------------- 2. the odd states */

say('\n2. THE STATES THAT ARE NEITHER\n');
{
  ok(classify({ savedAt: null, renderedAt: null, hasProduct: true }).mode === 'unknown',
    'a scene with no timestamps at all is unknown, not a failure');
  ok(classify({ savedAt: 'x', renderedAt: '2026-01-01T00:00:00Z', hasProduct: false }).mode === 'ORPHAN',
    'a rendered scene with no published product is an ORPHAN');
  ok(classify({ savedAt: 'x', renderedAt: '2026-01-01T00:00:00Z', publishedAt: null, hasProduct: true }).mode === 'ok',
    'a product that has never been published is not a race — there is nothing to have raced');
}

/* ------------------------------- 2b. a scene whose product is gone */

say('\n2b. NO PRODUCT BEATS NOT FINISHED\n');
{
  /* The two have opposite remedies, so the order they are tested in is not a
     detail. The 007 scene was reported INCOMPLETE for days; by the time it was
     acted on the document had been deleted and split into two new products,
     and "run the render again" would have recreated what was deliberately
     removed. No product is checked first for that reason. */
  const gone = classify({
    savedAt: '2026-09-17T15:46:44.409Z', renderedAt: undefined,
    publishedAt: undefined, hasProduct: false, hasDraft: false, draftsKnown: true,
  });
  ok(gone.mode === 'ORPHAN', 'unfinished AND no product is an ORPHAN, not an INCOMPLETE', gone.mode);
  ok(/nothing to render/.test(gone.why), 'and it says not to render it', gone.why);

  /* The same scene while its product still existed IS an INCOMPLETE -- the
     product is what decides, not the missing renderedAt. */
  const stillThere = classify({
    savedAt: '2026-09-17T15:46:44.409Z', renderedAt: undefined,
    publishedAt: '2026-09-17T15:46:52Z', hasProduct: true, hasDraft: false, draftsKnown: true,
  });
  ok(stillThere.mode === 'INCOMPLETE', 'with the product present it is an INCOMPLETE again', stillThere.mode);

  /* A rendered orphan is still an orphan, and says a different thing. */
  const rendered = classify({
    savedAt: 'x', renderedAt: '2026-09-22T15:02:48Z',
    publishedAt: undefined, hasProduct: false, hasDraft: false, draftsKnown: true,
  });
  ok(rendered.mode === 'ORPHAN', 'a rendered scene with no product is an ORPHAN too', rendered.mode);
  ok(/deleted or never published/.test(rendered.why), 'with the reason that fits that case', rendered.why);
}

/* ------------------------------------------------------- 3. the keys */

say('\n3. READING A SCENE KEY\n');
{
  const a = parseKey('studio/abc123/classic/scene.json');
  ok(a && a.id === 'abc123' && a.style === 'classic', 'the normal shape', JSON.stringify(a));
  const b = parseKey('studio/abc123/fullBleed/scene.json');
  ok(b && b.style === 'fullBleed', 'and the other style', JSON.stringify(b));
  const c = parseKey('studio/abc123/scene.json');
  ok(c && c.id === 'abc123' && /legacy/.test(c.style), 'the pre-styles path is still read', JSON.stringify(c));
  ok(parseKey('studio/abc123/classic/print.png') === null, 'a print is not a scene');
  ok(parseKey('nonsense') === null, 'and nonsense is not a key');
}

/* --------------------------------------- 4. credentials, and a stuck read */

say('\n4. WHERE THE CREDENTIALS COME FROM\n');
{
  const env = { NETLIFY_SITE_ID: 'from-env', NETLIFY_AUTH_TOKEN: 'tok-env' };
  const a = resolveCredentials({ env, exists: () => false });
  ok(a.siteID === 'from-env' && a.token === 'tok-env', 'the environment wins', JSON.stringify(a.tokenSource));
  ok(a.tokenSource === 'environment', 'and says so');

  /* No env: fall back to the linked project and the CLI login. */
  const files = {
    '.netlify/state.json': JSON.stringify({ siteId: 'from-state' }),
    'CFG/netlify/Config/config.json': JSON.stringify({ users: { u1: { auth: { token: 'tok-cli' } } } }),
  };
  const b = resolveCredentials({
    env: {}, appData: 'CFG', home: 'HOME',
    exists: (p) => p.replace(/\\/g, '/') in files,
    readFile: (p) => files[p.replace(/\\/g, '/')],
  });
  ok(b.siteID === 'from-state', 'the site id comes from the linked project', b.siteID);
  ok(b.token === 'tok-cli', 'and the token from the CLI login', b.token);
  ok(/Netlify CLI login/.test(b.tokenSource), "which is named, because it is someone else's config file", b.tokenSource);

  const c = resolveCredentials({ env: {}, exists: () => false });
  ok(!c.siteID && !c.token, 'and nothing at all is nothing, not a crash');
}

say('\n4b. A STUCK READ IS ABANDONED\n');
{
  const fine = { get: async () => ({ savedAt: 'x' }) };
  const r1 = await readScene(fine, 'k', { timeoutMs: 1000 });
  ok(r1.scene && !r1.error, 'a normal read comes back');

  /* The failure that hung the first version for 35 minutes. */
  const hangs = { get: () => new Promise(() => {}) };
  const t0 = Date.now();
  const r2 = await readScene(hangs, 'k', { timeoutMs: 120 });
  const took = Date.now() - t0;
  ok(!r2.scene && /timed out/.test(r2.error), 'a read that never returns is given up on', r2.error);
  ok(took < 1000, 'promptly', took + 'ms');

  const throws = { get: async () => { throw new Error('network gone'); } };
  const r3 = await readScene(throws, 'k', { timeoutMs: 1000 });
  ok(!r3.scene && /network gone/.test(r3.error), 'and a thrown error is returned, not raised');
}

/* --------------------------------------- 5. the run, with everything faked */

say('\n5. END TO END, WITHOUT TOUCHING ANYTHING REAL\n');
{
  const scenes = {
    'studio/p1/classic/scene.json': { title: 'Finished', docId: 'drafts.p1', savedAt: '2026-09-01T10:00:00Z', renderedAt: '2026-09-01T10:01:00Z' },
    'studio/p2/classic/scene.json': { title: 'Never finished', docId: 'drafts.p2', savedAt: '2026-09-01T10:00:00Z' },
    'studio/p3/classic/scene.json': { title: 'Raced', docId: 'drafts.p3', savedAt: '2026-09-01T10:00:00Z', renderedAt: '2026-09-01T10:05:00Z' },
    /* Same shape as p3 -- rendered after _updatedAt -- but the scene names the
       published document, so run() must not call it a race. */
    'studio/p4/classic/scene.json': { title: 'Published anyway', docId: 'drafts.p4', savedAt: '2026-09-01T10:00:00Z', renderedAt: '2026-09-01T10:05:00Z' },
  };
  const fakeStore = {
    list: async () => ({ blobs: Object.keys(scenes).map((key) => ({ key })) }),
    get: async (key) => scenes[key],
  };
  const products = new Map([
    ['p1', { _id: 'p1', title: 'Finished', slug: 'finished', category: 'comic-book-icons', _updatedAt: '2026-09-01T10:02:00Z' }],
    ['p2', { _id: 'p2', title: 'Never finished', slug: 'never-finished', category: 'comic-book-icons', _updatedAt: '2026-09-01T10:00:05Z' }],
    ['p3', { _id: 'p3', title: 'Raced', slug: 'raced', category: 'comic-book-icons', _updatedAt: '2026-09-01T10:03:00Z' }],
    ['p4', { _id: 'p4', title: 'Published anyway', slug: 'published-anyway', category: 'comic-book-icons', _updatedAt: '2026-09-01T10:03:00Z' }],
  ]);

  const out = [];
  const code = await run(['--json'], { log: (s) => out.push(String(s)), error: (s) => out.push(String(s)), store: fakeStore, products, draftIds: new Set(['p3']), progress: () => {} });
  const parsed = JSON.parse(out.join('\n'));
  ok(parsed.scanned === 4, 'all four scenes scanned', String(parsed.scanned));
  ok(parsed.problems === 2, 'two of them are problems', String(parsed.problems));
  ok(!('Published anyway' in Object.fromEntries(parsed.rows.map((r) => [r.title, r.mode]))),
    'the late-looking one whose draft is gone is not among them — run() passes draft existence through');
  const modes = Object.fromEntries(parsed.rows.map((r) => [r.title, r.mode]));
  ok(modes['Never finished'] === 'INCOMPLETE', 'the unfinished one is INCOMPLETE');
  ok(modes.Raced === 'RACE', 'the raced one is a RACE');
  ok(!('Finished' in modes), 'and the good one is not listed at all by default');
  ok(code === 1, 'a run with problems exits non-zero, so CI can gate on it', String(code));

  /* --all shows everything, which is what you want after a batch. */
  const out2 = [];
  await run(['--json', '--all'], { log: (s) => out2.push(String(s)), error: () => {}, store: fakeStore, products, draftIds: new Set(['p3']), progress: () => {} });
  ok(JSON.parse(out2.join('\n')).rows.length === 4, '--all lists the healthy ones too');

  /* A clean catalogue exits zero. */
  const clean = { 'studio/p1/classic/scene.json': scenes['studio/p1/classic/scene.json'] };
  const cleanStore = {
    list: async () => ({ blobs: Object.keys(clean).map((key) => ({ key })) }),
    get: async (key) => clean[key],
  };
  const out3 = [];
  const code3 = await run([], { log: (s) => out3.push(String(s)), error: () => {}, store: cleanStore, products, draftIds: new Set(), progress: () => {} });
  ok(code3 === 0, 'a clean sweep exits zero', String(code3));
  ok(/nothing incomplete, nothing stale and nothing raced/.test(out3.join('\n')), 'and says so');

  /* An unreadable blob is a row, not a crash. */
  const brokenStore = {
    list: async () => ({ blobs: [{ key: 'studio/x/classic/scene.json' }] }),
    get: async () => { throw new Error('blob is not JSON'); },
  };
  const out4 = [];
  await run(['--json'], { log: (s) => out4.push(String(s)), error: () => {}, store: brokenStore, products, draftIds: new Set(), progress: () => {} });
  const p4 = JSON.parse(out4.join('\n'));
  ok(p4.skipped === 1 && p4.skippedDetail.length === 1, 'an unreadable scene is reported rather than throwing', String(p4.skipped));
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
