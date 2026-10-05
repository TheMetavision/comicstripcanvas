/**
 * An admin edit replaces the basket thumbnail, and keeps the customer's.
 *
 *   npx netlify dev --offline --port 8899
 *   node --env-file=.env tools/builder/admin-edit-thumb-loop.mjs
 *
 * The whole path for real, through netlify dev: edit-save, the internal call to
 * the render job, the render itself, and the two public addresses that show the
 * result -- /api/personalisation-thumb/<id> (basket, Stripe) and the proofUrl
 * the Studio's ProofPanel displays.
 *
 * WHAT IT WRITES, AND TAKES BACK
 * ------------------------------
 * As admin-edit-loop.mjs: a stub build in the production dataset with an id no
 * customer could have, deleted at the end, including on failure. Its blobs go
 * in the LOCAL store netlify dev serves from .netlify/blobs-serve -- seeded by
 * writing the files there, since that is all the local store is -- and are
 * removed afterwards too. Nothing reaches the real blob stores.
 *
 * The pictures are flat colours so the assertions can be about what is in them:
 * the customer's thumbnail is blue, and the edit lays a green panel over the
 * whole board, so a thumbnail made from the new render is green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@sanity/client';
import sharp from 'sharp';

const BASE = process.env.LOOP_BASE || 'http://localhost:8899';
const ID = `pp-${'e1'.repeat(16)}`;          // unmistakably not a real build
const DOC_ID = `pendingPersonalisation.${ID}`;

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const AUTH = process.env.ADMIN_BASIC_USER
  ? { Authorization: `Basic ${Buffer.from(`${process.env.ADMIN_BASIC_USER}:${process.env.ADMIN_BASIC_PASS || ''}`).toString('base64')}` }
  : {};

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* ---------- the local blob store ---------- */
const ENTRIES = '.netlify/blobs-serve/entries';
function siteDir() {
  const sites = fs.existsSync(ENTRIES) ? fs.readdirSync(ENTRIES) : [];
  const hit = sites.find((s) => fs.existsSync(path.join(ENTRIES, s, 'site%3Apersonalisation')));
  if (hit) return hit;
  if (sites.length === 1) return sites[0];
  throw new Error(`cannot tell which site under ${ENTRIES} netlify dev is serving`);
}
const blobFile = (store, key) => path.join(ENTRIES, siteDir(), `site%3A${store}`, ...key.split('/'));
const putBlob = (store, key, buf) => {
  const f = blobFile(store, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
};
const readBlob = (store, key) => {
  try { return fs.readFileSync(blobFile(store, key)); } catch { return null; }
};
function removeBlobs() {
  for (const tree of ['entries', 'metadata']) {
    const root = path.join('.netlify/blobs-serve', tree, siteDir());
    for (const [store, prefix] of [['personalisation', 'personalisation'], ['renders', 'renders']]) {
      fs.rmSync(path.join(root, `site%3A${store}`, prefix, ID), { recursive: true, force: true });
    }
  }
}

/* ---------- pictures ---------- */
const flat = (w, h, rgb, fmt) => {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: rgb } });
  return (fmt === 'png' ? img.png() : img.jpeg({ quality: 90 })).toBuffer();
};
/** The mean colour, and whether one channel clearly leads. */
async function dominant(buf) {
  const { channels } = await sharp(buf).stats();
  const [r, g, b] = channels.map((c) => Math.round(c.mean));
  const lead = g > r + 60 && g > b + 60 ? 'green' : b > r + 60 && b > g + 60 ? 'blue'
    : r > g + 60 && r > b + 60 ? 'red' : 'mixed';
  return { lead, rgb: `${r},${g},${b}` };
}

const recipeFor = (title, green) => ({
  template: 'cover',
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150" width="100" height="150">`
    + `<image data-role="panel" data-panel="art" x="0" y="0" width="100" height="150" `
    + `preserveAspectRatio="xMidYMid slice" href="{{IMAGE:art}}"/>`
    + (green ? `<rect x="0" y="0" width="100" height="150" fill="#00C000"/>` : '')
    + `<text x="10" y="20" font-family="Chewy" font-size="10" fill="#FFFFFF">${title}</text></svg>`,
  output: { format: 'standard', faceInches: [8, 12], sizeKey: 'small' },
  panels: [{
    id: 'art', image: 'stub.jpg', placeholder: false,
    transform: { zoom: 1, offsetX: 0, offsetY: 0 },
    sourcePx: [1000, 1500], effectiveDpi: 125, styledPx: [1000, 1500],
    imageVariant: 'styled',
    rawKey: `personalisation/${ID}/art.jpg`,
    styledKey: `personalisation/${ID}/styled-art.jpg`,
    cutoutKey: null, cutoutPx: null,
  }],
  text: [{ id: 'title', value: title, pos: { x: 10, y: 20 } }],
  boxes: [], logo: null,
});

async function seed(customerThumb) {
  putBlob('personalisation', `personalisation/${ID}/styled-art.jpg`, await flat(1000, 1500, { r: 200, g: 30, b: 30 }));
  putBlob('personalisation', `personalisation/${ID}/thumb.jpg`, customerThumb);
  putBlob('renders', `renders/${ID}/proof.png`, await flat(1200, 1800, { r: 30, g: 30, b: 200 }, 'png'));

  const { svg, ...rest } = recipeFor('THE CUSTOMER’S', false);
  await sanity.createOrReplace({
    _id: DOC_ID,
    _type: 'pendingPersonalisation',
    status: 'rendered',
    templateId: 'cover',
    printSize: '8 × 12 in',
    outputFormat: 'standard',
    customerNotes: 'STUB BUILD for tools/builder/admin-edit-thumb-loop.mjs — safe to delete.',
    recipe: JSON.stringify(rest),
    sceneSvg: svg,
    proofUrl: `${BASE}/api/personalisation-proof/${ID}`,
    photoKeys: [`personalisation/${ID}/art.jpg`],
    photos: [{
      _key: 'p-art', _type: 'styledPhoto', panel: 'art', styleStatus: 'done',
      rawKey: `personalisation/${ID}/art.jpg`,
      styledKey: `personalisation/${ID}/styled-art.jpg`,
    }],
    styleCalls: 0,
    createdAt: new Date().toISOString(),
  });
  return (await sanity.getDocument(DOC_ID))._rev;
}

async function getBytes(url) {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
}

async function editAndWait(rev, recipe) {
  const res = await fetch(`${BASE}/admin/api/personalisation-edit-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify({ id: ID, rev, recipe }),
  });
  const body = await res.json().catch(() => ({}));
  /* The render is a background function: wait for it to leave preparing. */
  let doc = null;
  for (let i = 0; i < 90; i++) {
    doc = await sanity.getDocument(DOC_ID);
    if (doc.status !== 'preparing') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { res, body, doc };
}

async function main() {
  say(`\nnetlify dev at ${BASE}\n`);
  try {
    const probe = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok(probe.status < 500, 'the dev server answers', String(probe.status));
  } catch (e) {
    say(`\nCould not reach ${BASE}: ${e.message}`);
    say('Start it with:  npx netlify dev --offline --port 8899\n');
    process.exit(2);
  }

  /* 300 x 450, not the 600 the builder makes, so "longest side 600" below can
     only pass on a thumbnail we regenerated. */
  const customerThumb = await flat(300, 450, { r: 20, g: 40, b: 220 });
  const rev = await seed(customerThumb);
  say(`stub build ${ID} created in Sanity at ${rev}, blobs seeded under ${ENTRIES}/${siteDir()}\n`);

  say('1. BEFORE THE EDIT\n');
  const before = await getBytes(`${BASE}/api/personalisation-thumb/${ID}`);
  ok(before.status === 200 && before.buf.equals(customerThumb),
    '/api/personalisation-thumb/<id> serves the customer’s snapshot', String(before.status));

  say('\n2. THE EDIT, AND ITS RENDER\n');
  const first = await editAndWait(rev, recipeFor('WHAT WE TIDIED', true));
  ok(first.res.status === 200 && first.body.ok, 'the save is accepted',
    `${first.res.status} ${JSON.stringify(first.body)}`);
  ok(first.body.originalThumbKept === true, '  and says it kept the customer’s thumbnail');
  ok(first.doc.status === 'rendered', 'the render finished',
    `${first.doc.status}${first.doc.renderError ? ` — ${first.doc.renderError}` : ''}`);

  const kept = readBlob('personalisation', `personalisation/${ID}/thumb-original.jpg`);
  ok(kept && kept.equals(customerThumb), 'thumb-original.jpg is the customer’s snapshot, byte for byte');

  const thumb = await getBytes(`${BASE}/api/personalisation-thumb/${ID}`);
  ok(thumb.status === 200 && thumb.type === 'image/jpeg', '/api/personalisation-thumb/<id> is a JPEG',
    `${thumb.status} ${thumb.type}`);
  ok(!thumb.buf.equals(customerThumb), '  and no longer the customer’s');
  const meta = await sharp(thumb.buf).metadata();
  ok(meta.format === 'jpeg' && Math.max(meta.width, meta.height) === 600,
    '  the builder’s size: longest side 600', `${meta.width} × ${meta.height}`);
  ok(Math.abs(meta.width / meta.height - 100 / 150) < 0.01, '  the whole board, in proportion');
  const tc = await dominant(thumb.buf);
  ok(tc.lead === 'green', '  and it shows the EDITED design', `mean ${tc.rgb}`);

  /* The Studio's ProofPanel shows <img src={proofUrl}>: fetch exactly that. */
  ok(typeof first.doc.proofUrl === 'string', 'the build has a proofUrl again', first.doc.proofUrl);
  const proof = await getBytes(first.doc.proofUrl);
  ok(proof.status === 200 && proof.type === 'image/png', '  which serves a PNG', `${proof.status} ${proof.type}`);
  const pc = await dominant(proof.buf);
  ok(pc.lead === 'green', '  of the edited design — what the Studio preview shows', `mean ${pc.rgb}`);

  say('\n3. A SECOND EDIT LEAVES THE ORIGINAL ALONE\n');
  const rev2 = first.doc._rev;
  const second = await editAndWait(rev2, recipeFor('BACK TO THE PHOTO', false));
  ok(second.res.status === 200 && second.body.ok, 'the second save is accepted',
    `${second.res.status} ${JSON.stringify(second.body)}`);
  ok(second.body.originalThumbKept === false, '  and copied no thumbnail this time');
  ok(second.doc.status === 'rendered', 'and rendered', second.doc.status);
  const kept2 = readBlob('personalisation', `personalisation/${ID}/thumb-original.jpg`);
  ok(kept2 && kept2.equals(customerThumb), 'thumb-original.jpg is still the customer’s, not our first edit');
  const thumb2 = await getBytes(`${BASE}/api/personalisation-thumb/${ID}`);
  const tc2 = await dominant(thumb2.buf);
  ok(tc2.lead === 'red', 'the thumbnail follows the second edit (the styled art shows through)', `mean ${tc2.rgb}`);
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
    say(`\nCOULD NOT DELETE ${ID}: ${e.message} — remove it in the Studio`);
    fail++;
  }
  try { removeBlobs(); say('local blobs removed'); } catch (e) { say(`could not remove local blobs: ${e.message}`); }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
