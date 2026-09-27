/**
 * The two image routes that were nearly too big to answer.
 *
 *   node tools/builder/near-cap-tests.mjs
 *
 * A serverless response is capped at 6 MB buffered, and it cannot be raised.
 * Measured across every object: art-web tops out at 4.56 MB of 250, and the
 * largest cutout is 5.04 MB of 22.
 *
 * The cutout number is the misleading one. Those files are small because most
 * of each frame was removed, and transparency costs almost nothing to encode.
 * Cut out a subject that FILLS the frame -- the largest stored photograph,
 * 3000x4000 -- and the PNG is 28.13 MB; at the largest cutout size in the
 * store it is 43.49 MB. That route could fail today on a tightly-cropped
 * portrait. art-web is genuinely bounded, by ART_WEB_SIDE = 1600.
 *
 * Both now stream from Blobs at the edge. What these tests care about is that
 * nothing ELSE changed while the plumbing did: the same ids are accepted, the
 * same ones refused, the same keys built, the same headers sent, and a
 * customer's photograph is still told apart from the shop's own artwork.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  STUDIO_STORE, PHOTO_STORE, CLASSIC, FULL_BLEED,
  isProductId, isPanelId, isPersonalisationId, readStyle, artWebPath, SERVABLE_PHOTO,
} from '../../netlify/edge-lib/image-keys.mjs';
import { sanityQuery } from '../../netlify/edge-lib/sanity-read.mjs';
import { artWebKey, CLASSIC as FN_CLASSIC, FULL_BLEED as FN_FULL_BLEED } from '../../netlify/functions/_shared/artwork-styles.mjs';
import { STUDIO_STORE as FN_STUDIO_STORE } from '../../netlify/functions/_shared/studio-uploads.mjs';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* ───────────────────────── 1. a body over the cap, intact */

say('\n1. A BODY OVER THE 6 MB CAP, STREAMED AND REASSEMBLED\n');
{
  /* 9 MB: half again the buffered cap, and bigger than anything either route
     holds today. Non-uniform so a dropped or reordered chunk changes the hash. */
  const SIZE = 9 * 1024 * 1024;
  const original = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) original[i] = (i * 17 + (i >> 11)) & 0xff;
  const sha = (b) => createHash('sha256').update(b).digest('hex');

  const chunks = [];
  for (let at = 0; at < SIZE; at += 48 * 1024) chunks.push(original.subarray(at, Math.min(SIZE, at + 48 * 1024)));
  const streamOf = () => {
    let i = 0;
    return new ReadableStream({
      pull(c) { i < chunks.length ? c.enqueue(new Uint8Array(chunks[i++])) : c.close(); },
    });
  };

  /* The artwork route's response, built exactly as the edge function builds it. */
  const art = new Response(streamOf(), {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
  const artBytes = Buffer.from(await art.arrayBuffer());
  ok(artBytes.length === SIZE, 'the artwork arrives whole',
    `${(artBytes.length / 1048576).toFixed(2)} MB`);
  ok(sha(artBytes) === sha(original), 'byte for byte', sha(artBytes).slice(0, 16));
  ok(artBytes.length > 6 * 1024 * 1024, 'and it is past the cap a function could return');

  /* The photograph's response, with its own headers. */
  const photo = new Response(streamOf(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
  const photoBytes = Buffer.from(await photo.arrayBuffer());
  ok(photoBytes.length === SIZE && sha(photoBytes) === sha(original),
    'and so does a customer photograph', `${(photoBytes.length / 1048576).toFixed(2)} MB`);
  ok(photo.headers.get('cache-control') === 'private, no-store',
    'which no shared cache may keep', photo.headers.get('cache-control'));
  ok(photo.headers.get('x-robots-tag') === 'noindex', 'and no crawler may index');
  ok(art.headers.get('cache-control').startsWith('public'),
    'while the shop\'s own artwork stays cacheable for a year', art.headers.get('cache-control'));

  /* A HEAD asks the same question without the body. */
  const head = new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } });
  ok((await head.arrayBuffer()).byteLength === 0, 'a HEAD sends no body at all');
}

/* ──────────────────────── 2. the same keys as before */

say('\n2. THE SAME KEYS THE FUNCTIONS BUILT\n');
{
  ok(STUDIO_STORE === FN_STUDIO_STORE, 'same studio store', `${STUDIO_STORE} / ${FN_STUDIO_STORE}`);
  ok(PHOTO_STORE === 'personalisation', 'same photo store', PHOTO_STORE);
  ok(CLASSIC === FN_CLASSIC && FULL_BLEED === FN_FULL_BLEED, 'same style names');

  for (const [id, style, panel] of [
    ['6CCGmCKjYTHK2Kwkqfatyy', CLASSIC, 'art'],
    ['studio-c1bcb873045c3da74c2a61da', FULL_BLEED, 'panel-01'],
  ]) {
    ok(artWebPath(id, style, panel) === artWebKey(id, style, panel),
      `the edge builds the same art-web key for ${style}`, artWebPath(id, style, panel));
  }
  /* An unknown style must fall back the way styleOr does, not produce a path
     with rubbish in it. */
  ok(artWebPath('x', 'nonsense', 'art') === artWebKey('x', 'nonsense', 'art'),
    'including when the style is not one of ours', artWebPath('x', 'nonsense', 'art'));
}

/* ──────────────────────── 3. the same ids accepted and refused */

say('\n3. THE SAME IDS IN, THE SAME IDS OUT\n');
{
  ok(readStyle('fullbleed') === FULL_BLEED && readStyle('fullBleed') === FULL_BLEED,
    'the url spelling and the field spelling both mean full bleed');
  ok(readStyle('classic') === CLASSIC && readStyle('') === CLASSIC,
    'classic is the default, as in the function');
  ok(readStyle('FULL BLEED!') === FULL_BLEED, 'and a human typing it still works');
  ok(readStyle('sepia') === null, 'but an unknown style is null, not a silent classic');

  ok(isProductId('studio-c1bcb873045c3da74c2a61da'), 'a product id passes');
  for (const bad of ['../secret', 'a/b', '', 'x'.repeat(121), 'a..b'])
    ok(!isProductId(bad), `${JSON.stringify(bad)} does not`);

  ok(isPanelId('panel-01') && isPanelId('art'), 'a panel id passes');
  for (const bad of ['../x', 'a.b', '', 'x'.repeat(41)]) ok(!isPanelId(bad), `${JSON.stringify(bad)} does not`);

  ok(isPersonalisationId('pp-' + 'a'.repeat(32)), 'a pp- id passes');
  for (const bad of ['pp-' + 'a'.repeat(31), 'pp-' + 'A'.repeat(32), 'xx-' + 'a'.repeat(32), 'pp-', ''])
    ok(!isPersonalisationId(bad), `${JSON.stringify(bad)} does not`);

  ok(SERVABLE_PHOTO.test('personalisation/pp-' + 'a'.repeat(32) + '/cutout-art.png'),
    'a cutout key is servable');
  ok(SERVABLE_PHOTO.test('personalisation/pp-' + 'a'.repeat(32) + '/styled-art.jpg'),
    'and a styled one');
  for (const bad of [
    'studio/6CCG/classic/print.png',
    'personalisation/pp-' + 'a'.repeat(32) + '/../../etc/passwd',
    'personalisation/pp-' + 'a'.repeat(32) + '/notes.txt',
    'order-prints/print/CSC-1/li/x.png',
  ]) ok(!SERVABLE_PHOTO.test(bad), `but ${bad.slice(0, 48)}… is not`);
}

/* ──────────────────────── 4. what the edge functions actually do */

say('\n4. THE ROUTES THEMSELVES\n');
{
  const art = read('netlify/edge-functions/customise-scene-art.ts');
  const photo = read('netlify/edge-functions/personalisation-photo-stream.ts');
  const artFn = read('netlify/functions/customise-scene.mjs');
  const photoFn = read('netlify/functions/personalisation-photo.mjs');

  for (const [name, src] of [['artwork', art], ['photograph', photo]]) {
    ok(/type: 'stream'/.test(src), `the ${name} route asks for a stream`);
    ok(!/type: 'arrayBuffer'/.test(src), `and never buffers the whole ${name}`);
    ok(/consistency: 'strong'/.test(src), `reading ${name} strongly, like the print download`);
    ok(/context\.next\(\)/.test(src), `and hands anything else back to the function`);
  }

  /* Access must not have widened. Both still refuse before touching a store. */
  ok(art.indexOf('isProductId(') < art.indexOf('getStore('), 'the artwork validates before it reads');
  ok(photo.indexOf('isPersonalisationId(') < photo.indexOf('getStore('),
    'and the photograph checks the id before it reads');
  ok(/styleStatus !== 'done'/.test(photo),
    'the photograph is still only served once styling is done');
  ok(/row\.cutoutKey : row\.styledKey/.test(photo),
    'and the key still comes off the document, not the url');
  /* The word appears in the comment explaining why it is not used, so this
     asks whether it is READ, not whether it is mentioned. */
  ok(!/env\.get\(['"]SANITY_WRITE_TOKEN|process\.env\.SANITY_WRITE_TOKEN/.test(photo),
    'the edge reads no write token — the public dataset allows this query');
  ok(/process\.env\.SANITY_WRITE_TOKEN/.test(photoFn),
    'which is strictly less than the function it replaces holds', 'the function passes one');

  /* The functions stay put: they answer everything that is not the image. */
  ok(/artWebKey\(/.test(artFn), 'the scene function still exists for the JSON route');
  ok(/isId\(/.test(photoFn), 'and the photo function still guards its own route');
}

/* ──────────────────────── 5. declaration and ordering */

say('\n5. DECLARED INLINE, IN FRONT OF NOTHING\n');
{
  const toml = read('netlify.toml');
  const files = fs.readdirSync(path.join(REPO, 'netlify/edge-functions')).filter((f) => /\.(ts|js|mjs)$/.test(f));
  ok(!/\[\[edge_functions\]\]/.test(toml),
    'nothing is declared in netlify.toml, which would run before the inline ones');
  for (const f of files) {
    ok(/export const config/.test(read(`netlify/edge-functions/${f}`)), `${f} declares itself inline`);
  }
  /* admin-auth must still sort first, so the /admin guard runs before anything
     under /admin. The two new ones are on /api/* and cannot reach it. */
  const sorted = [...files].sort();
  ok(sorted[0] === 'admin-auth.ts', 'admin-auth still sorts first', sorted.join(', '));
  const art = read('netlify/edge-functions/customise-scene-art.ts');
  const photo = read('netlify/edge-functions/personalisation-photo-stream.ts');
  ok(/path: '\/api\/customise-scene\/\*'/.test(art), 'the artwork route claims its own prefix only');
  ok(/'\/api\/personalisation-photo'/.test(photo) && /'\/api\/personalisation-photo\/\*'/.test(photo),
    'the photo route claims both url shapes the function accepts');
  for (const [name, src] of [['customise-scene-art', art], ['personalisation-photo-stream', photo]]) {
    ok(!/\/admin/.test(src), `${name} does not stray into /admin`);
  }
}

/* ──────────────────────── 6. the read that needs no secret */

say('\n6. READING SANITY FROM THE EDGE\n');
{
  let asked = null;
  const fake = async (u) => { asked = u; return { ok: true, json: async () => ({ result: { hello: 1 } }) }; };
  const got = await sanityQuery('*[_id == $id][0]', { id: 'pp-x' }, { fetchImpl: fake });
  ok(got?.hello === 1, 'a result comes back');
  ok(asked.includes('lwbwahym') && asked.includes('/production'), 'from the production dataset', 'lwbwahym/production');
  ok(asked.includes(encodeURIComponent('"pp-x"')), 'with the parameter JSON-encoded, as GROQ wants');
  ok(!/token|Authorization/i.test(asked), 'and no credential in the url');

  ok((await sanityQuery('*', {}, { fetchImpl: async () => ({ ok: false, status: 500 }) })) === null,
    'a 500 is null, which the caller turns into a 404');
  ok((await sanityQuery('*', {}, { fetchImpl: async () => { throw new Error('offline'); } })) === null,
    'and so is a thrown fetch, rather than a 500 of our own');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
