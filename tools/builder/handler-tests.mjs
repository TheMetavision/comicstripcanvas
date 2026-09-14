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
const stripeStub = await import('./_stubs/stripe.mjs');

/* The handler is imported by the same specifier the deploy uses. If this line
   throws, the function is broken before a request has even been made -- which
   is itself worth knowing, and used not to be. */
const ROOT = new URL('../../', import.meta.url).href;
const personaliseSave = (await import(`${ROOT}netlify/functions/personalise-save.mjs`)).default;
const checkout = (await import(`${ROOT}netlify/functions/checkout.mjs`)).default;
const webhook = (await import(`${ROOT}netlify/functions/webhook.mjs`)).default;
const stylePhoto = (await import(`${ROOT}netlify/functions/style-photo-background.mjs`)).default;
const genaiStub = await import('./_stubs/google-genai.mjs');
const sharp = (await import('sharp')).default;
const guard = await import(`${ROOT}netlify/functions/_shared/spend-guard.mjs`);

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
  stripeStub.reset();
  genaiStub.reset();
  process.env = { ...env };
  process.env.SANITY_WRITE_TOKEN = 'stub-token';
  process.env.URL = 'https://test.local';
  process.env.RESEND_API_KEY = 'stub-resend-key';
  process.env.TEAM_EMAIL = 'team@test.local';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
  process.env.GOOGLE_AI_API_KEY = 'stub-gemini-key';
  delete process.env.STYLE_DAILY_MAX;
  delete process.env.STUDIO_STYLE_DAILY_MAX;
  delete process.env.CUTOUT_SERVICE_URL;
  delete process.env.CUTOUT_TOKEN;
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
let renders = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes('/api/style-photo')) {
    triggers.push(JSON.parse(init.body || '{}'));
    return new Response('Accepted', { status: 202 });
  }
  /* The webhook's render trigger. Recorded rather than performed, because
     "was the print job started for this order" is the thing worth asserting
     and the job itself is another function's business. */
  if (href.includes('/api/render-personalisation')) {
    renders.push({ url: href, body: JSON.parse(init.body || '{}') });
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

/* ============================================================ checkout.mjs */

say('\n7. CHECKOUT: WHAT THE CUSTOMER IS ACTUALLY CHARGED\n');

/* The price table the handler prices from. Copied here deliberately: a test
   that imported PRICES would agree with the handler by construction and prove
   nothing about the number. */
const PRICE = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};
const SHIPPING_PENCE = 495;
const FREE_OVER_PENCE = 5000;

const product = (slug, extra = {}) => ({
  _id: `product-${slug}`, _type: 'product', slug: { current: slug },
  title: slug, ...extra,
});
const build = (id, extra = {}) => ({
  _id: id, _type: 'pendingPersonalisation', ...extra,
});
const seed = (...docs) => { for (const d of docs) sanityStub.docs.set(d._id, d); };

const line = (extra = {}) => ({
  productId: 'product-gizmo', slug: 'gizmo', title: 'Gizmo',
  format: 'poster', size: 'small', quantity: 1, unitPrice: 0.01, ...extra,
});

const postCheckout = async (items) => {
  const res = await checkout(
    new Request('https://test.local/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
    {}
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ---- every product type, at its own price ---- */
for (const [format, sizes] of Object.entries(PRICE)) {
  for (const [size, pounds] of Object.entries(sizes)) {
    resetAll();
    seed(product('gizmo'));
    const { status } = await postCheckout([line({ format, size, quantity: 2 })]);
    const charged = stripeStub.linesOf(stripeStub.lastSession())[0];
    ok(status === 200 && charged?.unitPence === Math.round(pounds * 100),
      `${format}/${size} is charged £${pounds.toFixed(2)}`,
      charged ? `${charged.unitPence}p` : `status ${status}`);
  }
}

{
  /* ---- the client's price is ignored ---- */
  resetAll();
  seed(product('gizmo'));
  await postCheckout([line({ unitPrice: 0.01, format: 'poster', size: 'large' })]);
  ok(stripeStub.linesOf(stripeStub.lastSession())[0].unitPence === 1699,
    'a line claiming to cost 1p is charged the table price',
    `${stripeStub.linesOf(stripeStub.lastSession())[0].unitPence}p`);

  /* ---- shipping, and the free threshold ---- */
  resetAll();
  seed(product('gizmo'));
  await postCheckout([line({ format: 'poster', size: 'small' })]);
  let ship = stripeStub.lastSession().shipping_options[0].shipping_rate_data;
  ok(ship.fixed_amount.amount === SHIPPING_PENCE, 'a small order pays postage',
    `${ship.fixed_amount.amount}p`);

  resetAll();
  seed(product('gizmo'));
  /* Two, because one gallery canvas at £46.99 is UNDER the threshold -- which
     this fixture got wrong first time round and the assertion caught. */
  await postCheckout([line({ format: 'canvas-gallery', size: 'large', quantity: 2 })]);
  ship = stripeStub.lastSession().shipping_options[0].shipping_rate_data;
  ok(ship.fixed_amount.amount === 0, `over £${FREE_OVER_PENCE / 100} postage is free`,
    `${ship.fixed_amount.amount}p`);
  ok(/FREE UK delivery/.test(ship.display_name), 'and says so', ship.display_name);
}

say('\n8. CHECKOUT: PERSONALISED AND CUSTOMISED LINES\n');
{
  const BUILD = `pp-${'a'.repeat(32)}`;

  /* ---- the £10 personalisation fee, off the product ---- */
  resetAll();
  seed(
    product('gizmo', { personalisationFee: 10 }),
    build(BUILD, { kind: null, productId: 'product-gizmo' })
  );
  let r = await postCheckout([line({ personalisationId: BUILD })]);
  let charged = stripeStub.linesOf(stripeStub.lastSession())[0];
  ok(r.status === 200, 'a personalised line is accepted', String(r.status));
  ok(charged.unitPence === Math.round((9.99 + 10) * 100),
    'charged the print price plus the £10 artwork fee', `${charged.unitPence}p`);
  ok(charged.metadata.buildKind === 'personalised', 'stamped as a personalised build',
    charged.metadata.buildKind);
  ok(charged.metadata.personalisationId === BUILD, 'with the build id for the webhook',
    charged.metadata.personalisationId);
  ok(charged.metadata.personalisationFee === '10', 'and the fee that was charged',
    charged.metadata.personalisationFee);
  ok(/includes £10.00 personalisation/.test(charged.description),
    'and the customer is told on the Stripe page', charged.description);

  /* ---- the thumbnail Stripe fetches, derived not supplied ---- */
  ok(charged.images.length === 1
    && charged.images[0] === `https://test.local/api/personalisation-thumb/${BUILD}`,
    'the line image is derived from the build id', charged.images[0]);

  resetAll();
  seed(product('gizmo'));
  await postCheckout([line({ images: ['https://evil.test/x.png'] })]);
  ok((stripeStub.linesOf(stripeStub.lastSession())[0].images || []).length === 0,
    'an ordinary line gets no image, and none can be supplied by the client');

  /* ---- a personalised product with no fee is REFUSED, never undercharged ---- */
  resetAll();
  seed(product('gizmo'), build(BUILD, { productId: 'product-gizmo' }));
  r = await postCheckout([line({ personalisationId: BUILD })]);
  ok(r.status === 400, 'a personalised line with no fee on the product is refused',
    String(r.status));
  ok(/not priced yet/.test(r.body.error || ''), 'and says so rather than selling it cheap',
    r.body.error);
  ok(stripeStub.sessions.length === 0, 'no session was created');

  /* ---- customise: the fee resolution, all three ways ---- */
  const CUSTOMISE = `pp-${'b'.repeat(32)}`;
  const customiseCase = async (customiseFee) => {
    resetAll();
    seed(
      product('gizmo', { personalisationFee: 10, ...(customiseFee === undefined ? {} : { customiseFee }) }),
      build(CUSTOMISE, { kind: 'customise', productId: 'product-gizmo', artworkStyle: 'fullBleed' })
    );
    const out = await postCheckout([line({ personalisationId: CUSTOMISE })]);
    return { ...out, charged: stripeStub.linesOf(stripeStub.lastSession())[0] || null };
  };

  let c = await customiseCase(undefined);
  ok(c.status === 200 && c.charged.unitPence === Math.round((9.99 + 5) * 100),
    'a customise line with NO fee on the product uses the £5 default',
    c.charged ? `${c.charged.unitPence}p` : `status ${c.status}`);
  ok(c.charged.metadata.buildKind === 'customise', 'and is stamped as a customise build',
    c.charged.metadata.buildKind);
  ok(/includes £5.00 customising/.test(c.charged.description), 'described as customising, not personalisation',
    c.charged.description);
  ok(c.charged.metadata.artworkStyle === 'fullBleed',
    'and takes its style from the BUILD, not the browser', c.charged.metadata.artworkStyle);

  c = await customiseCase(700);
  ok(c.status === 200 && c.charged.unitPence === Math.round((9.99 + 7) * 100),
    'a customise fee SET on the product is used', `${c.charged.unitPence}p`);

  for (const bad of [0, -5, 1.5, '700', null]) {
    c = await customiseCase(bad);
    if (bad === null) {
      ok(c.status === 200 && c.charged.unitPence === Math.round((9.99 + 5) * 100),
        'an explicit null is the ordinary case and takes the default', `${c.charged.unitPence}p`);
    } else {
      ok(c.status === 400, `a customise fee of ${JSON.stringify(bad)} is refused`, String(c.status));
      ok(/not priced yet/.test(c.body.error || ''), '  with a message, not a guess', c.body.error);
    }
  }

  /* ---- a customise line is NOT charged the personalisation fee ---- */
  c = await customiseCase(500);
  ok(c.charged.unitPence !== Math.round((9.99 + 10) * 100),
    'a customise line never picks up the £10 personalisation fee', `${c.charged.unitPence}p`);
}

say('\n9. CHECKOUT: THE REFUSALS\n');
{
  resetAll(); seed(product('gizmo'));
  ok((await postCheckout([])).status === 400, 'an empty basket is a 400');
  ok((await postCheckout([line({ format: 'nonsense' })])).status === 400,
    'an unknown format is a 400');
  ok((await postCheckout([line({ size: 'enormous' })])).status === 400,
    'an unknown size is a 400');
  for (const quantity of [0, -1, 1.5, 100, 'two', null]) {
    ok((await postCheckout([line({ quantity })])).status === 400,
      `a quantity of ${JSON.stringify(quantity)} is a 400`);
  }
  ok((await postCheckout([line({ personalisationId: 'not-a-build' })])).status === 400,
    'a malformed build reference is a 400');

  /* full bleed is refused unless the product actually has that print file */
  resetAll(); seed(product('gizmo'));
  let r = await postCheckout([line({ artworkStyle: 'fullBleed' })]);
  ok(r.status === 400 && /not available/.test(r.body.error || ''),
    'a full-bleed line on a product without one is refused', r.body.error);

  resetAll();
  seed(product('gizmo', { fullBleed: { printFile: { asset: { _ref: 'image-x' } } } }));
  r = await postCheckout([line({ artworkStyle: 'fullBleed' })]);
  ok(r.status === 200, 'and accepted on a product that has one', String(r.status));
  let charged = stripeStub.linesOf(stripeStub.lastSession())[0];
  ok(charged.metadata.artworkStyle === 'fullBleed', 'with the style in the metadata',
    charged.metadata.artworkStyle);
  ok(/Full bleed/.test(charged.description), 'and named on the Stripe page', charged.description);

  resetAll(); seed(product('gizmo'));
  await postCheckout([line({})]);
  charged = stripeStub.linesOf(stripeStub.lastSession())[0];
  ok(charged.metadata.artworkStyle === 'classic', 'a line that says nothing is Classic',
    charged.metadata.artworkStyle);
  ok(!/Classic/.test(charged.description),
    'and is not labelled, because there was no choice to get wrong', charged.description);

  /* the failure paths */
  resetAll(); seed(product('gizmo'));
  const res405 = await checkout(new Request('https://test.local/api/checkout', { method: 'GET' }), {});
  ok(res405.status === 405, 'a GET is a 405', String(res405.status));

  resetAll(); seed(product('gizmo'));
  stripeStub.failures.create = true;
  r = await postCheckout([line({})]);
  ok(r.status === 500, 'Stripe refusing the session is a 500', String(r.status));
  ok(/Failed to create checkout session/.test(r.body.error || ''),
    'with a message the browser can show', r.body.error);
  stripeStub.failures.create = false;

  resetAll(); seed(product('gizmo'));
  const badJson = await checkout(new Request('https://test.local/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  }), {});
  ok(badJson.status === 500, 'a body that is not JSON is caught, not thrown',
    String(badJson.status));
}

/* ============================================================= webhook.mjs */

say('\n10. WEBHOOK: A PAID SESSION BECOMES AN ORDER\n');

const stripeEvent = (type, object) => JSON.stringify({
  id: `evt_${Math.random().toString(16).slice(2, 10)}`,
  type,
  data: { object },
});

const paidSession = (extra = {}) => ({
  id: 'cs_test_paid_1',
  payment_status: 'paid',
  payment_intent: 'pi_test_1',
  amount_total: 1999,
  currency: 'gbp',
  customer_details: { email: 'buyer@test.local', name: 'A Buyer', address: {} },
  collected_information: {
    shipping_details: {
      name: 'A Buyer',
      address: {
        line1: '1 Test Street', line2: '', city: 'London',
        state: '', postal_code: 'E1 1AA', country: 'GB',
      },
    },
  },
  metadata: {},
  ...extra,
});

const postWebhook = async (body, sig = 'good-signature') => {
  renders = [];
  const res = await webhook(
    new Request('https://test.local/api/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sig, 'Content-Type': 'application/json' },
      body,
    }),
    {}
  );
  return { status: res.status, text: await res.text() };
};

/** A paid session whose line item carries a build, as checkout stamps it. */
function seedPaidSessionWithBuild(buildId, id = 'cs_test_paid_1') {
  const session = paidSession({ id });
  stripeStub.sessions.push({
    ...session,
    line_items: [{
      price_data: {
        currency: 'gbp',
        unit_amount: 1999,
        product_data: {
          name: 'Gizmo',
          metadata: {
            productId: 'product-gizmo', slug: 'gizmo', format: 'poster', size: 'small',
            artworkStyle: 'classic',
            ...(buildId ? { personalisationId: buildId, personalisationFee: '10', buildKind: 'personalised' } : {}),
          },
        },
      },
      quantity: 1,
    }],
  });
  return session;
}

{
  resetAll();
  const session = seedPaidSessionWithBuild(null);
  const r = await postWebhook(stripeEvent('checkout.session.completed', session));
  ok(r.status === 200, 'a paid session is accepted', `${r.status} ${r.text}`);

  const order = sanityStub.docs.get(`order-${session.id}`);
  ok(!!order, 'an order document was created', order ? 'yes' : 'no');
  ok(order?._type === 'order', 'of type order', order?._type);
  ok(/^CSC-\d+$/.test(order?.orderNumber || ''), 'with a sequential order number',
    order?.orderNumber);
  ok(order?.status === 'received', 'marked received', order?.status);
  ok(order?.stripeSessionId === session.id, 'tied to the session', order?.stripeSessionId);
  ok(order?.customerEmail === 'buyer@test.local', 'with the customer on it', order?.customerEmail);
  ok(order?.shippingAddress?.postcode === 'E1 1AA', 'and the shipping address',
    order?.shippingAddress?.postcode);
  ok(!!order?.paidAt, 'and when it was paid');

  /* The counter, which is the part that must never hand out the same number
     twice. */
  const counter = sanityStub.docs.get('orderCounter');
  ok(counter?.lastOrderNumber === 1001, 'the order counter was incremented once',
    String(counter?.lastOrderNumber));
}

say('\n11. WEBHOOK: A PERSONALISED ORDER STARTS ITS RENDER\n');
{
  resetAll();
  const BUILD = `pp-${'c'.repeat(32)}`;
  sanityStub.docs.set(BUILD, {
    _id: BUILD, _type: 'pendingPersonalisation', status: 'draft',
    photos: [{ panel: 'art', styleStatus: 'done', styledKey: 'k' }],
    templateId: 'cover',
  });
  const session = seedPaidSessionWithBuild(BUILD);
  const r = await postWebhook(stripeEvent('checkout.session.completed', session));
  ok(r.status === 200, 'the paid personalised session is accepted', `${r.status} ${r.text}`);

  const order = sanityStub.docs.get(`order-${session.id}`);
  ok(!!order, 'the order exists');
  ok(order?.isPersonalised === true, 'and is marked personalised',
    String(order?.isPersonalised));

  /* The render is the whole reason a personalised order is different. */
  ok(renders.length === 1, 'the render job was triggered exactly once',
    String(renders.length));
  ok(renders[0]?.body?.id === BUILD || JSON.stringify(renders[0]?.body).includes(BUILD),
    'for the build that was bought', JSON.stringify(renders[0]?.body));

  const buildDoc = sanityStub.docs.get(BUILD);
  ok(buildDoc?.status !== 'draft', 'and the build is no longer a draft',
    buildDoc?.status);
}

say('\n12. WEBHOOK: DUPLICATES, AND WHAT IS NOT A PAID ORDER\n');
{
  /* ---- the same event twice ---- */
  resetAll();
  const session = seedPaidSessionWithBuild(null);
  const body = stripeEvent('checkout.session.completed', session);
  const first = await postWebhook(body);
  const counterAfterFirst = sanityStub.docs.get('orderCounter')?.lastOrderNumber;
  const second = await postWebhook(body);

  ok(first.status === 200 && second.status === 200, 'both deliveries are accepted',
    `${first.status} / ${second.status}`);
  ok(/already processed/i.test(second.text), 'the second says it was already done',
    second.text);
  ok(sanityStub.docs.get('orderCounter')?.lastOrderNumber === counterAfterFirst,
    'and does NOT take another order number',
    `${counterAfterFirst} -> ${sanityStub.docs.get('orderCounter')?.lastOrderNumber}`);
  ok([...sanityStub.docs.values()].filter((d) => d._type === 'order').length === 1,
    'there is exactly one order', String([...sanityStub.docs.values()].filter((d) => d._type === 'order').length));
  ok(renders.length === 0, 'and nothing was rendered a second time', String(renders.length));

  /* ---- completed but NOT paid: Klarna and friends ---- */
  resetAll();
  const unpaid = paidSession({ id: 'cs_test_unpaid', payment_status: 'unpaid' });
  const r = await postWebhook(stripeEvent('checkout.session.completed', unpaid));
  ok(r.status === 200, 'an unpaid completed session is accepted', String(r.status));
  ok(/awaiting payment/i.test(r.text), 'but only to say it is waiting', r.text);
  ok(!sanityStub.docs.get(`order-${unpaid.id}`), 'no order was created');

  /* ...and then the payment clears. The session has to be the SAME one, line
     items and all -- the first attempt at this seeded a different id and the
     stub refused to invent line items for a session it had never seen, which
     is exactly what a stub that throws on the unrecognised is for. */
  seedPaidSessionWithBuild(null, 'cs_test_unpaid');
  const cleared = await postWebhook(
    stripeEvent('checkout.session.async_payment_succeeded', paidSession({ id: 'cs_test_unpaid' }))
  );
  ok(cleared.status === 200, 'async_payment_succeeded fulfils it', String(cleared.status));
  ok(!!sanityStub.docs.get('order-cs_test_unpaid'), 'and the order appears then');

  /* ---- a failed async payment creates nothing ---- */
  resetAll();
  const failed = await postWebhook(
    stripeEvent('checkout.session.async_payment_failed', paidSession({ id: 'cs_test_failed' }))
  );
  ok(failed.status === 200, 'a failed async payment is acknowledged', String(failed.status));
  ok(!sanityStub.docs.get('order-cs_test_failed'), 'and creates no order');

  /* ---- an expired session bins the pending build and its photos ---- */
  resetAll();
  const BUILD = `pp-${'d'.repeat(32)}`;
  sanityStub.docs.set(BUILD, { _id: BUILD, _type: 'pendingPersonalisation' });
  const expired = await postWebhook(stripeEvent('checkout.session.expired',
    paidSession({ id: 'cs_test_expired', metadata: { personalisationRef: BUILD } })));
  ok(expired.status === 200, 'an expired session is acknowledged', String(expired.status));
  ok(!sanityStub.docs.has(BUILD), 'and the abandoned build is deleted with its photos');
}

say('\n13. WEBHOOK: MALFORMED AND UNAUTHORISED\n');
{
  resetAll();
  const bad = await postWebhook(stripeEvent('checkout.session.completed', paidSession()), 'forged');
  ok(bad.status === 400, 'a bad signature is a 400', String(bad.status));
  ok(/Webhook Error/.test(bad.text), 'and says why', bad.text.slice(0, 60));
  ok(sanityStub.docs.size === 0, 'nothing was written', String(sanityStub.docs.size));

  resetAll();
  const notJson = await postWebhook('this is not json at all');
  ok(notJson.status === 400, 'a body that is not JSON is a 400, not a crash',
    String(notJson.status));

  resetAll();
  const res405 = await webhook(new Request('https://test.local/api/webhook', { method: 'GET' }), {});
  ok(res405.status === 405, 'a GET is a 405', String(res405.status));

  /* NOT COVERED HERE, deliberately: the 503 when STRIPE_SECRET_KEY is absent.
     getStripe() memoises its client at module scope, so by the time this file
     has run one checkout the variable can no longer change the outcome within
     this process. Reaching it honestly needs a second module registry, which is
     a bigger harness than the branch is worth -- and the branch itself is three
     lines with no logic in it. Written down rather than faked with an assertion
     that would pass for the wrong reason. */

  resetAll();
  const unknown = await postWebhook(stripeEvent('customer.subscription.created', { id: 'sub_1' }));
  ok(unknown.status === 200, 'an event type we do not handle is acknowledged',
    String(unknown.status));
  ok([...sanityStub.docs.values()].every((d) => d._type !== 'order'),
    'and changes nothing');
}

/* ============================================== style-photo-background.mjs */

say('\n14. STYLING: THE HAPPY PATH\n');

/* A real PNG for the model to "return", because the handler re-encodes it with
   sharp and measures the result. */
const STYLED_PNG = await sharp({
  create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 40, b: 90 } },
}).png().toBuffer();

/** Seed a build with one uploaded photo, ready to style. */
async function seedBuild({
  id = `pp-${'e'.repeat(32)}`, panel = 'art', templateId = 'cover',
  origin = 'customer', guardKey = 'vtesthash00000001', styleCalls = 0,
} = {}) {
  const rawKey = `personalisation/${id}/${panel}.jpg`;
  sanityStub.docs.set(id, {
    _id: id, _type: 'pendingPersonalisation', templateId, origin, guardKey, styleCalls,
    styleSize: '2K',
    photos: [{ panel, rawKey, styleStatus: 'pending' }],
  });
  const jpeg = await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();
  await blobStub.getStore('personalisation').set(rawKey, jpeg.buffer.slice(
    jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength,
  ));
  return { id, panel, rawKey };
}

const runStyle = async (id, panel) => {
  const res = await stylePhoto(new Request('https://test.local/api/style-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, panel }),
  }));
  return { status: res.status, text: await res.text() };
};

const panelOf = (id, panel) =>
  (sanityStub.docs.get(id)?.photos || []).find((p) => p.panel === panel) || {};

{
  resetAll();
  genaiStub.setImage(STYLED_PNG);
  genaiStub.willReturnImage();
  const { id, panel } = await seedBuild();

  const r = await runStyle(id, panel);
  ok(r.status === 200, 'the styling run succeeds', `${r.status} ${r.text}`);

  const row = panelOf(id, panel);
  ok(row.styleStatus === 'done', 'the panel is marked done', row.styleStatus);
  ok(!!row.styledKey, 'with a styled image key', row.styledKey);
  ok(row.styledWidth === 40 && row.styledHeight === 60, 'and the size it came back',
    `${row.styledWidth}x${row.styledHeight}`);

  const stored = blobStub.dump('personalisation');
  ok(Object.keys(stored).some((k) => k.includes('styled-')),
    'the styled image is in the blob store', Object.keys(stored).join(', '));

  /* One call, and the real _shared/style.mjs built it. */
  ok(genaiStub.calls.length === 1, 'the model was called once', String(genaiStub.calls.length));
  const call = genaiStub.calls[0];
  ok(call.config.imageConfig.imageSize === '2K', 'at the size the build asked for',
    call.config.imageConfig.imageSize);
  ok(call.config.responseModalities?.[0] === 'IMAGE', 'asking for an image only');
  const parts = call.contents[0].parts;
  ok(parts.length === 7, 'three references, the photo and three lines of text',
    String(parts.length));
  ok(!!parts[5].inlineData, 'the photograph goes last, after the references',
    Object.keys(parts[5]).join(','));

  /* The money. */
  const counters = blobStub.dump('spend-guard');
  ok(Object.keys(counters).some((k) => k.includes('/style-covers.json')),
    'a cover call is billed to the covers allowance', Object.keys(counters).join(', '));
  ok(Object.keys(counters).some((k) => k === `global/${new Date().toISOString().slice(0, 10)}.json`),
    'and to the customer day counter');
  ok(sanityStub.docs.get(id).styleCalls === 1, 'the per-design cap was charged',
    String(sanityStub.docs.get(id).styleCalls));
}

say('\n15. STYLING: WHICH BUDGET IT SPENDS\n');
{
  /* A strip bills the strips allowance, not covers. */
  resetAll();
  genaiStub.setImage(STYLED_PNG); genaiStub.willReturnImage();
  let seeded = await seedBuild({ id: `pp-${'1'.repeat(32)}`, panel: 'panel-01', templateId: 'strip' });
  await runStyle(seeded.id, seeded.panel);
  let counters = Object.keys(blobStub.dump('spend-guard'));
  ok(counters.some((k) => k.includes('/style-strips.json')), 'a strip bills strips',
    counters.join(', '));
  ok(!counters.some((k) => k.includes('/style-covers.json')), 'and not covers');

  /* A studio build bills the studio day counter, never the customer's. */
  resetAll();
  genaiStub.setImage(STYLED_PNG); genaiStub.willReturnImage();
  seeded = await seedBuild({ id: `pp-${'2'.repeat(32)}`, origin: 'studio' });
  await runStyle(seeded.id, seeded.panel);
  counters = Object.keys(blobStub.dump('spend-guard'));
  const today = new Date().toISOString().slice(0, 10);
  ok(counters.includes(`global-studio/${today}.json`), 'a studio build bills the studio budget',
    counters.join(', '));
  ok(!counters.includes(`global/${today}.json`), 'and leaves the customer budget alone');

  /* The site-wide breaker pauses rather than refuses, and nothing is billed. */
  resetAll();
  genaiStub.setImage(STYLED_PNG); genaiStub.willReturnImage();
  process.env.STYLE_DAILY_MAX = '1';
  const store = blobStub.getStore('spend-guard');
  await guard.bumpGlobal(store, 1);
  seeded = await seedBuild({ id: `pp-${'3'.repeat(32)}` });
  let r = await runStyle(seeded.id, seeded.panel);
  ok(r.status === 200, 'a tripped breaker is not an error', `${r.status} ${r.text}`);
  ok(/paused/i.test(r.text), 'it pauses', r.text);
  ok(panelOf(seeded.id, seeded.panel).styleStatus === 'paused', 'and says so on the panel',
    panelOf(seeded.id, seeded.panel).styleStatus);
  ok(genaiStub.calls.length === 0, 'the model was never called', String(genaiStub.calls.length));
  ok(sanityStub.docs.get(seeded.id).styleCalls === 0, 'and nothing was charged',
    String(sanityStub.docs.get(seeded.id).styleCalls));
  delete process.env.STYLE_DAILY_MAX;

  /* The customer's own allowance stops it differently: limited, not paused. */
  resetAll();
  genaiStub.setImage(STYLED_PNG); genaiStub.willReturnImage();
  process.env.STYLE_LIMIT_COVERS = '1';
  const gkey = 'vtesthash00000001';
  await guard.bumpVisitor(blobStub.getStore('spend-guard'), gkey, 'covers', 1);
  seeded = await seedBuild({ id: `pp-${'4'.repeat(32)}`, guardKey: gkey });
  r = await runStyle(seeded.id, seeded.panel);
  ok(r.status === 200, 'an exhausted allowance is not an error either', String(r.status));
  ok(panelOf(seeded.id, seeded.panel).styleStatus === 'limited',
    'the panel is limited, NOT paused — nothing will resume it',
    panelOf(seeded.id, seeded.panel).styleStatus);
  ok(/maximum number of style attempts/i.test(panelOf(seeded.id, seeded.panel).styleError || ''),
    'with the message that offers the artwork team',
    (panelOf(seeded.id, seeded.panel).styleError || '').slice(0, 50));
  ok(genaiStub.calls.length === 0, 'and the model was not called');
  ok(resendStub.sent.length === 1, 'the team was told once', String(resendStub.sent.length));
  delete process.env.STYLE_LIMIT_COVERS;

  /* The per-design cap, which is underneath all of them. */
  resetAll();
  genaiStub.setImage(STYLED_PNG); genaiStub.willReturnImage();
  seeded = await seedBuild({ id: `pp-${'5'.repeat(32)}`, styleCalls: 16 });
  r = await runStyle(seeded.id, seeded.panel);
  ok(r.status === 200 && /cap/i.test(r.text), 'a design at its cap stops', `${r.status} ${r.text}`);
  ok(panelOf(seeded.id, seeded.panel).styleError === 'cap', 'and the panel says why',
    panelOf(seeded.id, seeded.panel).styleError);
  ok(genaiStub.calls.length === 0, 'without calling the model');
}

say('\n16. STYLING: WHEN THE MODEL SAYS NO\n');
{
  /* A safety refusal has to arrive INTACT. This is the whole reason the
     StyleError carries fields at all -- "the model returned no image" on its
     own is indistinguishable from a bug. */
  resetAll();
  genaiStub.willRefuse({
    finishReason: 'IMAGE_SAFETY',
    blockReason: 'PROHIBITED_CONTENT',
    safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }],
    modelText: "I can't create images that depict a real person.",
  });
  let seeded = await seedBuild({ id: `pp-${'6'.repeat(32)}` });
  let r = await runStyle(seeded.id, seeded.panel);
  /* 500, and that is correct: this is a background function, so nobody is
     waiting on the status -- the caller had its 202 long ago -- and the code
     the platform records for a run that produced nothing should say so. What
     the CUSTOMER sees is the panel, which is the assertion below. (This test
     first asserted 200, on my assumption rather than on the handler. The
     handler was right.) */
  ok(r.status === 500, 'a refusal is recorded as a failed run', `${r.status} ${r.text}`);
  let row = panelOf(seeded.id, seeded.panel);
  ok(row.styleStatus === 'failed', 'the panel is marked failed', row.styleStatus);
  ok(/safety/i.test(row.styleError || ''), 'with a reason the builder can read',
    row.styleError);

  /* Asked once. A refusal repeated is a refusal paid for twice. */
  ok(genaiStub.calls.length === 1, 'and the model was asked exactly once',
    String(genaiStub.calls.length));

  /* The billing: NOT refunded, and the handler is explicit about why -- "the
     model looked at the photograph and gave its answer". A refusal costs money
     because the generation ran. Only a status that means the request never
     reached the model (401, 403, 429) or a 5xx is handed back. */
  ok(sanityStub.docs.get(seeded.id).styleCalls === 1,
    'the call is NOT refunded — the model was reached and answered',
    String(sanityStub.docs.get(seeded.id).styleCalls));

  /* An empty response is a different thing and must not read as a refusal. */
  resetAll();
  genaiStub.willReturnNothing();
  seeded = await seedBuild({ id: `pp-${'7'.repeat(32)}` });
  r = await runStyle(seeded.id, seeded.panel);
  ok(r.status === 500, 'an empty response is a failed run too', String(r.status));
  row = panelOf(seeded.id, seeded.panel);
  ok(row.styleStatus === 'failed', 'as a failure', row.styleStatus);
  ok(!/safety/i.test(row.styleError || ''), 'but NOT as a safety refusal', row.styleError);

  /* A transient upstream fault is retried by the real _shared/style.mjs. */
  resetAll();
  genaiStub.willThrow(503, 'upstream wobble');
  seeded = await seedBuild({ id: `pp-${'8'.repeat(32)}` });
  r = await runStyle(seeded.id, seeded.panel);
  ok(genaiStub.calls.length === 2, 'a 503 is tried twice before giving up',
    String(genaiStub.calls.length));
  ok(panelOf(seeded.id, seeded.panel).styleStatus === 'failed', 'then fails',
    panelOf(seeded.id, seeded.panel).styleStatus);

  /* A 5xx never got an answer, so it IS handed back -- the other half of the
     rule, and the one that stops an outage eating a build's sixteen calls. */
  ok(sanityStub.docs.get(seeded.id).styleCalls === 0,
    'a 503 hands the call back — nothing was generated',
    String(sanityStub.docs.get(seeded.id).styleCalls));
  const afterOutage = Object.keys(blobStub.dump('spend-guard'))
    .filter((k) => k.includes('/style-'));
  ok(afterOutage.length === 0 || JSON.parse(blobStub.dump('spend-guard')[afterOutage[0]]).hours
    && Object.keys(JSON.parse(blobStub.dump('spend-guard')[afterOutage[0]]).hours).length === 0,
    'and the visitor keeps their attempt', afterOutage.join(', '));

  /* A 400 is a decision and must not be retried. */
  resetAll();
  genaiStub.willThrow(400, 'bad request');
  seeded = await seedBuild({ id: `pp-${'9'.repeat(32)}` });
  await runStyle(seeded.id, seeded.panel);
  ok(genaiStub.calls.length === 1, 'a 400 is asked once and not retried',
    String(genaiStub.calls.length));
}

say('\n17. STYLING: THE REQUESTS THAT GO NOWHERE\n');
{
  resetAll();
  let res = await stylePhoto(new Request('https://test.local/api/style-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));
  ok(res.status === 400, 'no id and no panel is a 400', String(res.status));

  res = await stylePhoto(new Request('https://test.local/api/style-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `pp-${'0'.repeat(32)}`, panel: 'art' }),
  }));
  ok(res.status === 404, 'a build that does not exist is a 404', String(res.status));
  ok(genaiStub.calls.length === 0, 'and the model is never called for one');

  resetAll();
  sanityStub.docs.set(`pp-${'f'.repeat(32)}`, {
    _id: `pp-${'f'.repeat(32)}`, _type: 'pendingPersonalisation',
    templateId: 'cover', photos: [],
  });
  res = await stylePhoto(new Request('https://test.local/api/style-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `pp-${'f'.repeat(32)}`, panel: 'art' }),
  }));
  ok(res.status === 404, 'a panel that does not exist on it is a 404', String(res.status));
}

globalThis.fetch = realFetch;
say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
