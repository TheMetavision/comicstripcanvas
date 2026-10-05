/**
 * Downloading a personalised build's print file, end to end under netlify dev.
 *
 *   # The edge route reads the build with SANITY_READ_TOKEN, and netlify dev
 *   # passes the edge runtime only variables from a .env file: one set in the
 *   # shell, or in the site's settings, does not reach it. So .env needs
 *   #   SANITY_READ_TOKEN=<the Viewer token>
 *   # Astro must also see .env in its process for the admin page:
 *   node --env-file=.env node_modules/astro/astro.js dev --port 4321
 *   npx netlify dev --offline --port 8899 --framework "#custom" --target-port 4321 --command "<anything that stays up>"
 *
 *   node --env-file=.env tools/builder/personalised-print-loop.mjs
 *
 * Without the token the route's checks are reported SKIPPED and the run exits 2
 * (incomplete), never as passed.
 *
 * The print is made by the REAL renderer from a stubbed build -- so the bytes,
 * the metadata the staleness check reads and the printFile summary on the
 * document all come from the code under test, not from this file. Then every
 * answer the route can give is asked for over HTTP.
 *
 * WHAT IT WRITES, AND TAKES BACK: a stub build in the production dataset (no
 * order, no customer, an id no customer could have), deleted at the end, and
 * its blobs in the LOCAL store netlify dev serves from .netlify/blobs-serve,
 * removed at the end. Nothing reaches the real blob stores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@sanity/client';
import sharp from 'sharp';

const BASE = process.env.LOOP_BASE || 'http://localhost:8899';
const ID = `pp-${'c4'.repeat(16)}`;
const DOC_ID = `pendingPersonalisation.${ID}`;
const ORDER_NUMBER = 'CSC-TEST-PRINT';
const EXPECTED_NAME = `${ORDER_NUMBER}-cover-large-standard.png`;

const sanity = createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
});

if (!process.env.ADMIN_BASIC_USER || !process.env.ADMIN_BASIC_PASS) {
  console.log('\nADMIN_BASIC_USER and ADMIN_BASIC_PASS must be set — run with --env-file=.env\n');
  process.exit(2);
}
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${process.env.ADMIN_BASIC_USER}:${process.env.ADMIN_BASIC_PASS}`).toString('base64')}`,
};

let pass = 0, fail = 0, skipped = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* netlify dev hands the edge runtime only variables from a .env file (and some
   site settings, inconsistently): a SANITY_READ_TOKEN in the shell does not
   reach it. Without one the route answers 503 "not configured" -- a fact about
   this machine, not the code -- so its checks are SKIPPED, loudly, and the run
   ends "incomplete" rather than passing. Everything else still runs. */
let EDGE_READS = true;
const okEdge = (c, l, e = '') => {
  if (EDGE_READS) return ok(c, l, e);
  skipped++;
  console.log(`  SKIP  ${l} — the edge route cannot read the build here (SANITY_READ_TOKEN)`);
  return undefined;
};

/* ---------- the local blob store ---------- */
const ENTRIES = '.netlify/blobs-serve/entries';
const siteDir = () => {
  const sites = fs.existsSync(ENTRIES) ? fs.readdirSync(ENTRIES) : [];
  const hit = sites.find((s) => fs.existsSync(path.join(ENTRIES, s, 'site%3Apersonalisation')));
  if (hit) return hit;
  if (sites.length === 1) return sites[0];
  throw new Error(`cannot tell which site under ${ENTRIES} netlify dev is serving`);
};
const blobFile = (store, key) => path.join(ENTRIES, siteDir(), `site%3A${store}`, ...key.split('/'));
const putBlob = (store, key, buf) => {
  const f = blobFile(store, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
};
const readBlob = (store, key) => { try { return fs.readFileSync(blobFile(store, key)); } catch { return null; } };
function removeBlobs() {
  for (const tree of ['entries', 'metadata']) {
    const root = path.join('.netlify/blobs-serve', tree, siteDir());
    for (const [store, prefix] of [['personalisation', 'personalisation'], ['renders', 'renders']]) {
      fs.rmSync(path.join(root, `site%3A${store}`, prefix, ID), { recursive: true, force: true });
    }
  }
}

/* ---------- the stub build ---------- */
const sceneFor = (green) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150" width="100" height="150">`
  + `<image data-role="panel" data-panel="art" x="0" y="0" width="100" height="150" `
  + `preserveAspectRatio="xMidYMid slice" href="{{IMAGE:art}}"/>`
  + (green ? `<rect x="0" y="0" width="100" height="150" fill="#00C000"/>` : '')
  + `<text x="10" y="20" font-family="Chewy" font-size="10" fill="#FFFFFF">PRINT TEST</text></svg>`;
/* sizeKey says "large" for the filename; faceInches keeps the stub print small
   (8 x 12 in, 2400 x 3600 px) so the loop does not spend a minute rasterising. */
const recipe = JSON.stringify({
  template: 'cover',
  output: { format: 'standard', faceInches: [8, 12], sizeKey: 'large' },
  panels: [{
    id: 'art', placeholder: false, transform: { zoom: 1, offsetX: 0, offsetY: 0 }, imageVariant: 'styled',
    rawKey: `personalisation/${ID}/art.jpg`, styledKey: `personalisation/${ID}/styled-art.jpg`,
  }],
});

async function seed() {
  const art = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg({ quality: 90 }).toBuffer();
  putBlob('personalisation', `personalisation/${ID}/styled-art.jpg`, art);
  await sanity.createOrReplace({
    _id: DOC_ID, _type: 'pendingPersonalisation',
    status: 'paid', templateId: 'cover', printSize: '8 × 12 in', outputFormat: 'standard',
    orderNumber: ORDER_NUMBER,
    customerNotes: 'STUB BUILD for tools/builder/personalised-print-loop.mjs — safe to delete.',
    recipe, sceneSvg: sceneFor(false),
    photoKeys: [`personalisation/${ID}/art.jpg`],
    photos: [{
      _key: 'p-art', _type: 'styledPhoto', panel: 'art', styleStatus: 'done',
      rawKey: `personalisation/${ID}/art.jpg`, styledKey: `personalisation/${ID}/styled-art.jpg`,
    }],
    styleCalls: 0, createdAt: new Date().toISOString(),
  });
}

const waitFor = async (pred, what, ms = 120_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const doc = await sanity.getDocument(DOC_ID);
    if (pred(doc)) return doc;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const download = async (headers = AUTH, method = 'GET') => {
  const res = await fetch(`${BASE}/admin/personalisation/${ID}/print`, { headers, method, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, text: buf.toString('utf8') };
};
const adminPage = async () => (await fetch(`${BASE}/admin/personalisation/${ID}`, { headers: AUTH })).text();
const action = async (name) => {
  const res = await fetch(`${BASE}/admin/api/personalisation-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify({ action: name, id: ID }),
  });
  return { res, body: await res.json().catch(() => ({})) };
};

async function main() {
  say(`\nnetlify dev at ${BASE}\n`);
  try {
    const probe = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok(probe.status < 500, 'the dev server answers', String(probe.status));
  } catch (e) {
    say(`\nCould not reach ${BASE}: ${e.message} — see the header of this file.\n`);
    process.exit(2);
  }

  await seed();
  say(`stub build ${ID} created; rendering it with the real renderer…`);
  const kick = await fetch(`${BASE}/api/render-personalisation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID }),
  });
  ok(kick.status === 202, 'the render job accepted it', String(kick.status));
  const rendered = await waitFor((d) => d.status !== 'paid' && d.status !== 'preparing', 'the render');
  ok(rendered.status === 'rendered', 'the render finished', `${rendered.status}${rendered.renderError ? ` — ${rendered.renderError}` : ''}`);
  ok(rendered.printFile?.fingerprint && rendered.printFile?.width === 2400 && rendered.printFile?.height === 3600,
    '  and recorded the print on the build', JSON.stringify(rendered.printFile));
  const stored1 = readBlob('renders', `renders/${ID}/print.png`);
  ok(stored1 && stored1.length === rendered.printFile.bytes, '  the stored print is the size it recorded', `${stored1?.length} B`);

  say('\n1. NOBODY WITHOUT THE ADMIN PASSWORD\n');
  const anon = await download({});
  ok(anon.res.status === 401, 'no credentials: 401', String(anon.res.status));
  ok(/Basic/.test(anon.res.headers.get('www-authenticate') || ''), '  with a Basic challenge');
  const wrong = await download({ Authorization: `Basic ${Buffer.from('nobody:wrong').toString('base64')}` });
  ok(wrong.res.status === 401, 'wrong credentials: 401', String(wrong.res.status));

  say('\n2. NOT BEFORE THE CUSTOMER APPROVES\n');
  const early = await download();
  if (early.res.status === 503 && /SANITY_READ_TOKEN/.test(early.text)) {
    EDGE_READS = false;
    say('  NOTE  the edge route says SANITY_READ_TOKEN is not set in netlify dev. Add the Viewer');
    say('        token as SANITY_READ_TOKEN=... to .env and restart netlify dev to run these.');
  }
  okEdge(early.res.status === 409, 'a rendered, unapproved build: refused', String(early.res.status));
  okEdge(early.text.includes('Available once the customer approves'), '  saying "Available once the customer approves"');
  ok(!early.res.headers.get('content-disposition'), '  and no file in the answer');
  ok((await adminPage()).includes('Available once the customer approves'), 'the admin page says the same');
  const earlyRerender = await action('rerender-print');
  ok(earlyRerender.res.status === 409, 'a print-only re-render is refused before approval too', earlyRerender.body.error);

  say('\n3. ONCE APPROVED, THE STORED PRINT, BYTE FOR BYTE\n');
  await sanity.patch(DOC_ID).set({ status: 'in_production', customerApprovedAt: new Date().toISOString() }).commit();
  const got = await download();
  okEdge(got.res.status === 200, 'in_production: 200', String(got.res.status));
  okEdge(got.res.headers.get('content-type') === 'image/png', '  a PNG');
  const cd = got.res.headers.get('content-disposition') || '';
  okEdge(cd === `attachment; filename="${EXPECTED_NAME}"`, `  named ${EXPECTED_NAME}`, cd);
  okEdge(got.buf.equals(stored1), '  and the bytes are exactly the stored print', `${got.buf.length} B`);
  /* "If present, agrees" -- the route's own rule. It sets Content-Length from
     the recorded size, but netlify dev's local edge runtime drops it from a
     streamed body (the response arrives chunked, with none), so presence
     cannot be asserted here. A WRONG length can: it truncates or hangs the
     download. Whether production keeps the header is checked against the live
     site, not here. */
  const cl = got.res.headers.get('content-length');
  okEdge(cl === null || cl === String(stored1.length), '  with no Content-Length that disagrees',
    cl === null ? `none sent (${got.res.headers.get('transfer-encoding') || 'no transfer-encoding'})` : cl);
  if (EDGE_READS) {
    const meta = await sharp(got.buf).metadata().catch(() => ({}));
    ok(meta.width === 2400 && meta.height === 3600, '  2400 × 3600 px, as recorded', `${meta.width} × ${meta.height}`);
  } else okEdge(false, '  2400 × 3600 px, as recorded');
  const head = await download(AUTH, 'HEAD');
  okEdge(head.res.status === 200 && head.buf.length === 0, 'HEAD answers without a body');
  const page = await adminPage();
  ok(page.includes('DOWNLOAD PRINT FILE') && page.includes(`/admin/personalisation/${ID}/print`),
    'the admin page offers the download');
  ok(page.includes('2400 × 3600 px · 8 × 12 in at 300 dpi'), '  beside its pixel size and print size');

  say('\n4. NEVER A PRINT OF AN EARLIER DESIGN\n');
  const proofBefore = readBlob('renders', `renders/${ID}/proof.png`);
  const proofUrlBefore = (await sanity.getDocument(DOC_ID)).proofUrl;
  /* What an edit would do to the document. (An admin edit of an approved build
     is refused; this stands in for any change at all to what the print is made
     from, which is what the check is for.) */
  await sanity.patch(DOC_ID).set({ sceneSvg: sceneFor(true), editedAt: new Date().toISOString(), editCount: 1 }).commit();
  const stale = await download();
  okEdge(stale.res.status === 409, 'the design changed after the render: refused', String(stale.res.status));
  okEdge(/out of date/i.test(stale.text) && /would print the old design/.test(stale.text), '  saying why', 'out of date');
  okEdge(stale.text.includes(`/admin/personalisation/${ID}?action=rerender-print`), '  with a Re-render button');
  ok(!stale.res.headers.get('content-disposition'), '  and no file');
  ok((await adminPage()).includes('RE-RENDER PRINT FILE'), 'the admin page offers the re-render instead of the download');

  say('\n5. RE-RENDER THE PRINT, AND ONLY THE PRINT\n');
  const kicked = await action('rerender-print');
  ok(kicked.res.status === 200 && kicked.body.printOnly === true, 'the print-only re-render is accepted', JSON.stringify(kicked.body));
  const editedAt = (await sanity.getDocument(DOC_ID)).editedAt;
  const after = await waitFor((d) => d.printFile?.renderedAt && d.printFile.renderedAt > editedAt, 'the print re-render');
  ok(after.status === 'in_production', 'the build is still in production — the approval stands', after.status);
  ok(after.proofUrl === proofUrlBefore, '  the proof link is unchanged');
  ok(readBlob('renders', `renders/${ID}/proof.png`)?.equals(proofBefore), '  and so is the proof the customer approved');
  const again = await download();
  const stored2 = readBlob('renders', `renders/${ID}/print.png`);
  okEdge(again.res.status === 200 && again.buf.equals(stored2), 'the new print downloads, byte for byte', `${again.buf.length} B`);
  ok(stored2 && !stored2.equals(stored1), 'the stored print is a different picture from the old one');
  /* Judged on the stored file, so it is checked whether or not the edge can read. */
  const { channels } = await sharp(stored2).stats();
  ok(channels[1].mean > 150 && channels[0].mean < 60, '  the edited design, not the old one',
    `mean ${channels.slice(0, 3).map((c) => Math.round(c.mean)).join(',')}`);
  ok(after.printFile?.fingerprint && after.printFile.fingerprint !== rendered.printFile.fingerprint,
    '  and the build records the new fingerprint');
  /* Retried for a few seconds: the wait above reads the document endpoint,
     the page reads through the query API, and the query API can lag a moment
     behind a write. Failed once on exactly that, then passed. */
  let offered = false;
  for (let i = 0; i < 8 && !offered; i++) {
    offered = (await adminPage()).includes('DOWNLOAD PRINT FILE');
    if (!offered) await new Promise((r) => setTimeout(r, 1000));
  }
  ok(offered, 'the admin page offers the download again');

  say('\n6. NOTHING ELSE ANSWERS\n');
  const other = await fetch(`${BASE}/admin/personalisation/pp-${'0'.repeat(32)}/print`, { headers: AUTH });
  okEdge(other.status === 404, 'an unknown build: 404', String(other.status));
  const bad = await fetch(`${BASE}/admin/personalisation/not-an-id/print`, { headers: AUTH });
  ok(bad.status === 404, 'a malformed id: 404', String(bad.status));
}

try {
  await main();
} catch (err) {
  fail++;
  say(`\nTHREW: ${err.stack || err.message}`);
} finally {
  try {
    await sanity.delete(DOC_ID);
    const gone = await sanity.getDocument(DOC_ID);
    say(`\nstub build ${ID} ${gone ? 'STILL THERE — remove it in the Studio' : 'deleted, confirmed gone'}`);
    if (gone) fail++;
  } catch (e) {
    say(`\nCOULD NOT DELETE ${ID}: ${e.message}`);
    fail++;
  }
  try { removeBlobs(); say('local blobs removed'); } catch (e) { say(`could not remove local blobs: ${e.message}`); }
}

say(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} SKIPPED — incomplete, see the NOTE above` : ''}.`);
process.exit(fail ? 1 : skipped ? 2 : 0);
