/**
 * Getting a print file out of the building.
 *
 *   node tools/builder/print-download-tests.mjs
 *
 * Netlify caps a serverless function's response at 6 MB buffered and 20 MB
 * streamed, and neither can be raised. Measured against real masters, EVERY
 * size and finish CSC sells is over the first cap -- the smallest, an 8x12in
 * poster, is 8.9 MB -- and five of the nine are over the second. A 24x16in
 * gallery canvas made from a heavy master came to 118 MB. The download action
 * read the whole blob into an ArrayBuffer and returned it, so it could not
 * deliver a single file the renderer had just spent minutes making.
 *
 * The bytes now come from an edge function that hands the Blobs stream
 * straight to the Response. These tests cover the three things that can go
 * wrong with that: it lets the wrong person in, it mangles the bytes, or it
 * runs in front of the guard instead of behind it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkBasicAuth, sameSecret, runningLocally } from '../../netlify/edge-lib/basic-auth.mjs';
import { PRINT_STORE, SERVABLE, isSafeId, stateKey } from '../../netlify/edge-lib/print-download-keys.mjs';
import { PRINT_STORE as FUNCTION_STORE } from '../../netlify/functions/_shared/order-print.mjs';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const basic = (u, p) => new Request('https://x/admin/api/print-file/download', {
  headers: { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') },
});
const CREDS = { user: 'alan', pass: 'correct horse:battery' };

/* ─────────────────────────────────────────── 1. who gets in */

say('\n1. WITHOUT CREDENTIALS, NOTHING\n');
{
  const none = await checkBasicAuth(new Request('https://x/admin/api/print-file/download'), CREDS);
  ok(none instanceof Response && none.status === 401, 'no Authorization header is 401', String(none?.status));
  ok(/Basic realm="Comic Strip Canvas admin"/.test(none.headers.get('www-authenticate') || ''),
    'with a challenge the browser will act on', none.headers.get('www-authenticate'));
  ok(none.headers.get('cache-control') === 'no-store', 'and nothing cached');

  const wrongPass = await checkBasicAuth(basic('alan', 'nope'), CREDS);
  ok(wrongPass?.status === 401, 'a wrong password is 401');
  const wrongUser = await checkBasicAuth(basic('someone', 'correct horse:battery'), CREDS);
  ok(wrongUser?.status === 401, 'a wrong username is 401');
  const bearer = await checkBasicAuth(
    new Request('https://x/a', { headers: { authorization: 'Bearer abc' } }), CREDS);
  ok(bearer?.status === 401, 'another scheme is 401');
  const rubbish = await checkBasicAuth(
    new Request('https://x/a', { headers: { authorization: 'Basic !!!not-base64!!!' } }), CREDS);
  ok(rubbish?.status === 401, 'unparseable credentials are 401, not a crash');
  const noColon = await checkBasicAuth(
    new Request('https://x/a', { headers: { authorization: 'Basic ' + Buffer.from('justauser').toString('base64') } }), CREDS);
  ok(noColon?.status === 401, 'credentials with no colon are 401');

  ok((await checkBasicAuth(basic('alan', 'correct horse:battery'), CREDS)) === null,
    'the right ones are let through');
  ok((await checkBasicAuth(basic('alan', 'correct horse:battery'),
    { user: 'alan', pass: 'correct horse:battery' })) === null,
  'and a password containing a colon still works — only the first one splits');

  /* Fails closed. An unset variable must not open the admin area. */
  const unset = await checkBasicAuth(basic('alan', 'x'), { user: '', pass: '' });
  ok(unset?.status === 503, 'no credentials configured is 503 for everyone', String(unset?.status));
  ok((await checkBasicAuth(basic('a', 'b'), { user: '', pass: '', isLocal: true })) === null,
    'except under netlify dev, where there is nothing to protect');
  ok(runningLocally({ get: (k) => (k === 'NETLIFY_DEV' ? 'true' : undefined) }) === true,
    'which netlify dev is recognised by');
  ok(runningLocally({ get: () => undefined }) === false, 'and a deploy is not');

  ok(await sameSecret('abc', 'abc'), 'the comparison agrees with itself');
  ok(!(await sameSecret('abc', 'abd')), 'and disagrees by one byte');
  ok(!(await sameSecret('abc', 'abcdefghijklmnop')), 'and on length');
}

/* ────────────────────────────── 2. a file bigger than the caps */

say('\n2. A FILE BIGGER THAN EITHER CAP, INTACT\n');
{
  /* 24 MB: over the 6 MB buffered cap and over the 20 MB streamed cap, which
     is the case that had no working route at all. Built from a repeating but
     non-uniform pattern so a truncation or a dropped chunk changes the hash. */
  const SIZE = 24 * 1024 * 1024;
  const original = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) original[i] = (i * 31 + (i >> 13)) & 0xff;
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const want = sha(original);

  /* The store as the edge function uses it: chunks out, nothing buffered. */
  const chunks = [];
  for (let at = 0; at < SIZE; at += 64 * 1024) chunks.push(original.subarray(at, Math.min(SIZE, at + 64 * 1024)));
  const fakeStore = {
    async get(key, opts) {
      if (opts?.type === 'json') return { state: 'ready', key: 'print/CSC-1003/li_1/large-gallery-classic-abc.png' };
      if (opts?.type !== 'stream') throw new Error('the download must ask for a stream, not a buffer');
      let i = 0;
      return new ReadableStream({
        pull(c) { i < chunks.length ? c.enqueue(new Uint8Array(chunks[i++])) : c.close(); },
      });
    },
    async getMetadata() { return { metadata: { filename: 'CSC-1003-bruce-lee-large-gallery.png', bytes: SIZE } }; },
  };

  const key = 'print/CSC-1003/li_1/large-gallery-classic-abc.png';
  const body = await fakeStore.get(key, { type: 'stream' });
  const meta = await fakeStore.getMetadata(key);
  const res = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${meta.metadata.filename}"`,
      'Content-Length': String(meta.metadata.bytes),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });

  const got = Buffer.from(await res.arrayBuffer());
  ok(got.length === SIZE, 'every byte arrives', `${(got.length / 1048576).toFixed(1)} MB of ${(SIZE / 1048576).toFixed(1)} MB`);
  ok(sha(got) === want, 'and they are the same bytes', sha(got).slice(0, 16));
  ok(got.length > 20 * 1024 * 1024, 'which is past the streamed cap a function could manage');
  ok(res.headers.get('content-length') === String(SIZE),
    'Content-Length matches the body exactly', res.headers.get('content-length'));
  ok(/attachment; filename="CSC-1003-bruce-lee-large-gallery\.png"/.test(res.headers.get('content-disposition')),
    'and it saves under the name the renderer chose', res.headers.get('content-disposition'));
  ok(res.headers.get('cache-control').includes('private'), 'somebody\'s order is not cached publicly');
}

/* ───────────────────────────────── 3. the keys it will serve */

say('\n3. WHAT IT WILL AND WILL NOT FETCH\n');
{
  ok(PRINT_STORE === FUNCTION_STORE,
    'the edge reads the same store the function writes', `${PRINT_STORE} / ${FUNCTION_STORE}`);

  /* The function builds this note's key inline; if that spelling changes, the
     download silently stops finding finished files. */
  const fn = read('netlify/functions/order-print-file.mjs');
  ok(fn.includes('`pending/${orderId}/${lineKey}`'),
    'and looks for the state note where the function writes it');
  ok(stateKey('CSC-1003', 'li_1') === 'pending/CSC-1003/li_1.state',
    'spelled the same way', stateKey('CSC-1003', 'li_1'));

  ok(SERVABLE.test('print/CSC-1003/li_1/large-gallery-classic-abc.png'), 'a print key is servable');
  for (const bad of [
    'pending/CSC-1003/li_1.state',
    'print/../../etc/passwd',
    'studio/6CCG/classic/print.png',
    'print/CSC-1003/li_1/file.txt',
    'print/CSC-1003/li_1/deeper/file.png',
  ]) ok(!SERVABLE.test(bad), `but ${bad} is not`);

  ok(isSafeId('CSC-1003') && isSafeId('li_1'), 'ordinary ids pass');
  for (const bad of ['../secret', 'a/b', '', 'x'.repeat(121), 'a b']) {
    ok(!isSafeId(bad), `${JSON.stringify(bad)} does not`);
  }
}

/* ──────────────────────── 4. it runs behind the guard, not in front */

say('\n4. DECLARED BEHIND THE ADMIN GUARD\n');
{
  const guard = read('netlify/edge-functions/admin-auth.ts');
  const download = read('netlify/edge-functions/print-file-download.ts');
  const toml = read('netlify.toml');

  /* Netlify runs edge functions declared in netlify.toml BEFORE those declared
     inline, and inline ones in alphabetical order by filename. So both must be
     inline, and admin-auth must sort first. */
  ok(/export const config/.test(guard), 'the guard is declared inline');
  ok(/export const config/.test(download), 'and so is the download');
  ok(!/\[\[edge_functions\]\]/.test(toml),
    'neither is declared in netlify.toml, which would run it in FRONT of the guard');
  ok(['admin-auth', 'print-file-download'].sort().join() === 'admin-auth,print-file-download',
    'and admin-auth sorts before print-file-download, so the guard runs first');

  ok(/path: '\/admin\/\*'/.test(guard), 'the guard covers /admin/*', 'path: /admin/*');
  ok(/path: '\/admin\/api\/print-file\/download'/.test(download),
    'and the download sits inside it');

  /* Belt as well as braces: the route checks for itself, so it is not one
     rename away from being public. */
  ok(/checkBasicAuth\(/.test(download), 'the download checks Basic Auth itself as well');
  ok(download.indexOf('checkBasicAuth') < download.indexOf('getStore('),
    'before it touches the store');

  /* And the old address still goes somewhere useful. */
  const fn = read('netlify/functions/order-print-file.mjs');
  ok(/status: 302/.test(fn) && /print-file\/download/.test(fn),
    'the old download action redirects to the edge route rather than 404ing');
  ok(!/type: 'arrayBuffer' \}\).catch\(\(\) => null\);\s*\n\s*if \(!blob\)/.test(fn),
    'and no longer reads the whole file into memory');

  /* The page must ask the edge route, not the function. */
  const page = read('src/pages/admin/print-file/[orderId]/[lineKey].astro');
  ok(/\/admin\/api\/print-file\/download\?order=/.test(page), 'the admin page links to the edge route');
  ok(!/api\('download'\)/.test(page), 'and nothing still calls the old action');
  ok(/api\('start'\)|api\('status'\)/.test(page), 'while start and status are untouched');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
