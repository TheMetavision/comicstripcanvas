/**
 * The deployed handlers, called.
 *
 *   node tools/builder/handler-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A temporal dead zone in personalise-save reached production behind 146 green
 * assertions and took every customer upload down with a 500. Nothing was wrong
 * with those assertions; they were about the wrong thing. They exercised the
 * spend-guard helpers in isolation -- checkVisitor, readVisitor, bumpVisitor,
 * familyForTemplate -- and the fault was in the CALLER, in the order two
 * statements appeared inside savePhoto. No test had ever invoked the function
 * that runs in production.
 *
 * Nothing else caught it either, and it is worth writing down why, because each
 * of these looks like it should have:
 *
 *   node --check   passes. `const x` used above its declaration is valid
 *                  SYNTAX; it fails at run time, on that line, only when
 *                  reached.
 *   npm run build  passes. Astro never bundles netlify/functions -- they are
 *                  deployed as they are -- so the build never loads the file.
 *   guard-tests    passes. It imports _shared/spend-guard.mjs and never
 *                  personalise-save.mjs.
 *
 * So the gap was not thin coverage of the guards. It was that the entry point
 * had no coverage at all. This calls it: a real multipart Request in, a real
 * Response out, and the stored document read back afterwards.
 *
 * Sanity, Netlify Blobs and Resend are redirected to in-memory stubs by a
 * module resolution hook (_stubs/hooks.mjs) so the handler's own source runs
 * unmodified, imported by its real path. Nothing reaches the network, Sanity or
 * Stripe.
 */
import { register } from 'node:module';

register('./_stubs/hooks.mjs', import.meta.url);

const sanityStub = await import('./_stubs/sanity-client.mjs');
const blobStub = await import('./_stubs/netlify-blobs.mjs');
const resendStub = await import('./_stubs/resend.mjs');

/* The handler is imported by the same specifier the deploy uses. If this line
   throws, the function is broken before a request has even been made -- which
   is itself worth knowing, and used not to be. */
const ROOT = new URL('../../', import.meta.url).href;
const personaliseSave = (await import(`${ROOT}netlify/functions/personalise-save.mjs`)).default;

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* A real JPEG, small but genuine: the handler reads file.type and hashes the
   bytes, and a string pretending to be an image would not exercise either. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const env = { ...process.env };
function resetAll() {
  sanityStub.reset();
  blobStub.reset();
  resendStub.reset();
  process.env = { ...env };
  process.env.SANITY_WRITE_TOKEN = 'stub-token';
  process.env.URL = 'https://test.local';
  process.env.RESEND_API_KEY = 'stub-resend-key';
  process.env.TEAM_EMAIL = 'team@test.local';
  delete process.env.STYLE_LIMIT_COVERS;
  delete process.env.STYLE_LIMIT_ICONS;
  delete process.env.STYLE_LIMIT_STRIPS;
}

/* The styling trigger is a fetch to the site's own /api/style-photo. Answered
   here so the handler's real trigger path runs and nothing leaves the process;
   the calls are recorded because "did it try to style this" is part of what a
   successful upload means. */
let triggers = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes('/api/style-photo')) {
    triggers.push(JSON.parse(init.body || '{}'));
    return new Response('Accepted', { status: 202 });
  }
  throw new Error(`handler-tests: unexpected fetch to ${href}`);
};

/** One photo upload, exactly as the builder sends it. */
function uploadRequest({ panelId = 'art', templateId = 'cover', id = null, ip = '203.0.113.7' } = {}) {
  const form = new FormData();
  form.set('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'holiday.jpg');
  form.set('panelId', panelId);
  if (templateId) form.set('templateId', templateId);
  if (id) form.set('id', id);
  form.set('consentAt', new Date().toISOString());
  return [
    new Request('https://test.local/api/personalise-save', { method: 'POST', body: form }),
    { ip },
  ];
}

const upload = async (opts) => {
  triggers = [];
  const [req, ctx] = uploadRequest(opts);
  const res = await personaliseSave(req, ctx);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, res };
};

/* ------------------------------------------ 1. the entry point, per template */

say('\n1. A REAL UPLOAD, FOR EVERY TEMPLATE\n');

const TEMPLATES = [
  ['cover', 'art', 'covers'],
  ['cover-fullbleed', 'art', 'covers'],
  ['icon-portrait', 'art', 'icons'],
  ['icon-landscape', 'art', 'icons'],
  ['strip', 'panel-01', 'strips'],
];

for (const [templateId, panelId, family] of TEMPLATES) {
  resetAll();
  const { status, body } = await upload({ templateId, panelId });

  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. A temporal dead zone throws a
     ReferenceError, the handler's own try/catch turns it into a 500, and the
     customer gets "Failed to save personalisation". Nothing subtler than this
     was needed. */
  ok(status === 200, `${templateId}: the upload succeeds`,
    `${status}${body.error ? ' — ' + body.error : ''}`);
  ok(!/before initialization/i.test(body.error || ''),
    `${templateId}: and not with a temporal dead zone`, body.error || 'no error');
  ok(typeof body.id === 'string' && /^pp-[0-9a-f]{32}$/.test(body.id),
    `${templateId}: it hands back a build id`, body.id);

  /* A 200 is not the same as having stored anything. */
  const doc = sanityStub.docs.get(body.id);
  ok(!!doc, `${templateId}: a document was actually written`, doc ? 'yes' : 'no');

  /* Everything below reads that document, so a missing one is reported once
     per assertion and the run carries on. A suite that throws here stops at
     the first template and hides the other four -- which is the opposite of
     what you want from the test that exists because something got through. */
  const field = (get, label, expected) => {
    if (!doc) { ok(false, `${templateId}: ${label}`, 'no document to read'); return; }
    const actual = get(doc);
    ok(actual === expected || (typeof expected === 'function' && expected(actual)),
      `${templateId}: ${label}`, JSON.stringify(actual));
  };
  field((d) => d.templateId, 'with the template on it', templateId);
  field((d) => d.photos?.[0]?.panel, 'and the panel', panelId);
  field((d) => d.photoKeys?.[0], 'keyed under the build',
    `personalisation/${body.id}/${panelId}.jpg`);
  field((d) => d.guardKey, 'the visitor is recorded as a hash',
    (v) => typeof v === 'string' && v.startsWith('v'));
  field((d) => d.origin, 'as a customer build', 'customer');

  /* The photograph itself. */
  const blobs = blobStub.dump('personalisation');
  ok(Object.keys(blobs).length === 1, `${templateId}: the photo is in the blob store`,
    Object.keys(blobs).join(', '));

  /* And the styling was asked for, which is the point of the upload. */
  ok(triggers.length === 1 && triggers[0].id === body.id && triggers[0].panel === panelId,
    `${templateId}: styling was triggered for it`, JSON.stringify(triggers[0] || null));

  /* The counter it will spend from, chosen from the template. The design was
     counted; the STYLE counter is not touched here, because the upload has not
     styled anything yet -- the background job bills that, and billing it twice
     is exactly the kind of thing worth being able to see. */
  const guard = blobStub.dump('spend-guard');
  ok(Object.keys(guard).some((k) => k.endsWith('/designs.json')),
    `${templateId}: the new design was counted`, Object.keys(guard).join(', '));
  ok(!Object.keys(guard).some((k) => k.includes('/style-')),
    `${templateId}: and no ${family} attempt was spent by the upload itself`,
    Object.keys(guard).join(', '));
}

/* --------------------------------------- 2. a second photo on the same build */

say('\n2. A SECOND PHOTO ON AN EXISTING BUILD\n');
{
  resetAll();
  const first = await upload({ templateId: 'strip', panelId: 'panel-01' });
  ok(first.status === 200, 'the first panel lands', String(first.status));

  const second = await upload({ templateId: 'strip', panelId: 'panel-02', id: first.body.id });
  ok(second.status === 200, 'and so does the second', String(second.status));
  ok(second.body.id === first.body.id, 'on the same build', second.body.id);

  const doc = sanityStub.docs.get(first.body.id) || {};
  ok(doc.photos?.length === 2, 'the document holds both panels',
    (doc.photos || []).map((p) => p.panel).join(', ') || 'no document');
  ok(doc.photoKeys?.length === 2, 'and both keys', String(doc.photoKeys?.length));
  ok(Object.keys(blobStub.dump('personalisation')).length === 2, 'and both photos are stored');
}

/* --------------------------------- 3. at the limit: stored, not refused */

say('\n3. A CUSTOMER AT THEIR LIMIT KEEPS THEIR PHOTO\n');
{
  resetAll();
  /* One attempt, so the second upload is over the line. Read per request, so
     setting it here is all it takes. */
  process.env.STYLE_LIMIT_COVERS = '1';

  const first = await upload({ templateId: 'cover' });
  ok(first.status === 200, 'the first cover is fine', String(first.status));

  /* Spend the allowance the way the styler does. */
  const { bumpVisitor, visitorKey } = await import(`${ROOT}netlify/functions/_shared/spend-guard.mjs`);
  const guardStore = blobStub.getStore('spend-guard');
  const key = visitorKey(null, { ip: '203.0.113.7' });
  await bumpVisitor(guardStore, key, 'covers', 1);

  const second = await upload({ templateId: 'cover' });
  ok(second.status === 200, 'the upload at the limit is NOT refused', String(second.status));
  ok(second.status !== 429, 'specifically not a 429 before storage');

  const doc = sanityStub.docs.get(second.body.id) || {};
  ok(!!doc._id, 'their build was still written', doc._id || 'no document');
  ok(Object.keys(blobStub.dump('personalisation')).length === 2,
    'and their photograph was still stored — both uploads are on disk',
    String(Object.keys(blobStub.dump('personalisation')).length));

  const row = doc.photos?.[0] || {};
  ok(row.styleStatus === 'limited', 'the panel says they are out of attempts',
    row.styleStatus || 'no row');
  ok(/maximum number of style attempts/i.test(row.styleError || ''),
    'with the message, not a failure', (row.styleError || 'no row').slice(0, 60));
  ok(!!row.limitedAt, 'and when it happened');
  ok(triggers.length === 0, 'nothing was sent to be styled', String(triggers.length));

  ok(second.body.style?.limited === true, 'the reply says so', JSON.stringify(second.body.style));
  ok(/contact\?/.test(second.body.style?.notice?.ctaHref || ''),
    'and carries the way to the artwork team', second.body.style?.notice?.ctaHref);

  /* And the team hears about it, once. */
  ok(resendStub.sent.length === 1, 'the team was emailed once', String(resendStub.sent.length));
  ok(/style attempts for today/i.test(resendStub.sent[0]?.subject || ''),
    'about the right thing', resendStub.sent[0]?.subject);

  const third = await upload({ templateId: 'cover' });
  ok(third.status === 200, 'a third upload still stores', String(third.status));
  ok(resendStub.sent.length === 1, 'and does not email again the same day',
    String(resendStub.sent.length));
}

/* ------------------------------ 4. the designs-per-hour guard still refuses */

say('\n4. THE DESIGNS-PER-HOUR GUARD STILL REFUSES OUTRIGHT\n');
{
  resetAll();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await upload({ templateId: 'cover' }));

  const okCount = results.filter((r) => r.status === 200).length;
  ok(okCount === 4, 'four new designs in an hour are allowed', String(okCount));

  const last = results[4];
  ok(last.status === 429, 'the fifth is refused', String(last.status));
  ok(last.body.reason === 'visitor-designs-per-hour', 'for the right reason', last.body.reason);
  ok(Object.keys(blobStub.dump('personalisation')).length === 4,
    'and nothing was stored for it — there is nothing to preserve at that point',
    String(Object.keys(blobStub.dump('personalisation')).length));
}

/* ------------------------------------------------- 5. the ordinary refusals */

say('\n5. THE REQUEST IS STILL VALIDATED\n');
{
  resetAll();
  const bad = new FormData();
  bad.set('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'x.jpg');
  bad.set('panelId', 'not a panel id!');
  const res = await personaliseSave(
    new Request('https://test.local/api/personalise-save', { method: 'POST', body: bad }),
    { ip: '203.0.113.9' }
  );
  ok(res.status === 400, 'a bad panel id is a 400', String(res.status));

  const wrongType = new FormData();
  wrongType.set('photo', new Blob([JPEG], { type: 'application/pdf' }), 'x.pdf');
  wrongType.set('panelId', 'art');
  const res2 = await personaliseSave(
    new Request('https://test.local/api/personalise-save', { method: 'POST', body: wrongType }),
    { ip: '203.0.113.9' }
  );
  ok(res2.status === 400, 'so is a file that is not an image', String(res2.status));

  const res3 = await personaliseSave(
    new Request('https://test.local/api/personalise-save', { method: 'GET' }), {}
  );
  ok(res3.status === 405, 'and a GET is a 405', String(res3.status));

  ok(sanityStub.docs.size === 0, 'none of which wrote a document', String(sanityStub.docs.size));
}

/* ----------------------------------- 6. no template is not a broken template */

say('\n6. AN UPLOAD WITH NO TEMPLATE\n');
{
  resetAll();
  const { status, body } = await upload({ templateId: null });
  ok(status === 200, 'an upload without a templateId still works', String(status));
  const doc = sanityStub.docs.get(body.id) || {};
  ok(!!doc._id, 'and still writes its document', doc._id || 'no document');
  ok(doc.templateId === undefined, 'with no template on it yet', String(doc.templateId));
  ok(doc.styleSize === '2K', 'defaulting to 2K until the recipe says otherwise',
    doc.styleSize || 'no document');
}

globalThis.fetch = realFetch;
say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
