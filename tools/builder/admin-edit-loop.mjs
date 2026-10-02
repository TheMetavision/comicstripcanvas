/**
 * The whole loop, through netlify dev, against the real functions and routes.
 *
 *   npx netlify dev --offline --port 8899
 *   node --env-file=.env tools/builder/admin-edit-loop.mjs
 *
 * WHAT THIS PROVES THAT THE UNIT TESTS CANNOT
 * -------------------------------------------
 * The handler tests call the functions directly, so they never exercise the part
 * most likely to be wrong: the ROUTING. /admin/api/personalisation-scene/<id>
 * reaching the right function with the id still in the path, the public /api/
 * address being closed, and the save's internal call to the render job resolving
 * to something real. Every one of those lives in netlify.toml, which no unit test
 * reads. The order-print-file rules in that same file needed three attempts.
 *
 * WHAT IT WRITES, AND TAKES BACK
 * ------------------------------
 * There is no local Sanity, so the stub build is created in the production
 * dataset and DELETED at the end, including on failure. It is named so nobody
 * would mistake it for a customer's: no order number, no Stripe session, and an
 * id of its own. Blobs under netlify dev are sandboxed and local, so nothing is
 * written to the real blob stores at all.
 */
import { createClient } from '@sanity/client';

const BASE = process.env.LOOP_BASE || 'http://localhost:8899';
const ID = `pp-${'f0'.repeat(16)}`;          // unmistakably not a real build
// The stub build's document, at the dotted _id the code now reads (netlify/functions/_shared/pp-id.mjs).
const DOC_ID = `pendingPersonalisation.${ID}`;

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const ORIGINAL_TITLE = 'WHAT THE CUSTOMER TYPED';
const EDITED_TITLE = 'WHAT WE TIDIED IT TO';
const CROP = { zoom: 1.7, offsetX: -88, offsetY: 42 };

const recipeFor = (title) => ({
  template: 'cover',
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150" width="100" height="150">`
    + `<image data-role="panel" data-panel="art" href="{{IMAGE:art}}"/>`
    + `<text>${title}</text></svg>`,
  output: { format: 'standard', faceInches: [16, 24], sizeKey: 'large' },
  panels: [{
    id: 'art', image: 'holiday.jpg', placeholder: false,
    transform: { ...CROP },
    sourcePx: [3000, 4000], effectiveDpi: 143, styledPx: [3000, 4000],
    imageVariant: 'styled',
    rawKey: `personalisation/${ID}/art.jpg`,
    styledKey: `personalisation/${ID}/styled-art.jpg`,
    cutoutKey: null, cutoutPx: null,
    removeBackground: { on: false, spread: 34, soften: 2 },
  }],
  text: [{ id: 'title', value: title, pos: { x: 10, y: 20 } }],
  boxes: [], logo: null,
});

async function seed() {
  const r = recipeFor(ORIGINAL_TITLE);
  const { svg, ...rest } = r;
  await sanity.createOrReplace({
    _id: DOC_ID,
    _type: 'pendingPersonalisation',
    status: 'rendered',
    templateId: 'cover',
    printSize: '16 × 24 in',
    outputFormat: 'standard',
    minEffectiveDpi: 143,
    customerNotes: 'STUB BUILD for tools/builder/admin-edit-loop.mjs — safe to delete.',
    recipe: JSON.stringify(rest),
    sceneSvg: svg,
    proofUrl: `${BASE}/api/personalisation-proof/${ID}`,
    photoKeys: [`personalisation/${ID}/art.jpg`],
    photos: [{
      _type: 'styledPhoto', panel: 'art', styleStatus: 'done',
      rawKey: `personalisation/${ID}/art.jpg`,
      styledKey: `personalisation/${ID}/styled-art.jpg`,
    }],
    styleCalls: 0,
    createdAt: new Date().toISOString(),
  });
  return (await sanity.getDocument(DOC_ID))._rev;
}

async function main() {
  say(`\nnetlify dev at ${BASE}\n`);

  /* Is it actually up? A refused connection reads as every assertion failing. */
  try {
    const probe = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok(probe.status < 500, 'the dev server answers', String(probe.status));
  } catch (e) {
    say(`\nCould not reach ${BASE}: ${e.message}`);
    say('Start it with:  npx netlify dev --offline --port 8899\n');
    process.exit(2);
  }

  const rev = await seed();
  say(`stub build ${ID} created in Sanity at ${rev}\n`);

  say('1. THE GUARDED ROUTE REACHES THE FUNCTION\n');
  const sceneRes = await fetch(`${BASE}/admin/api/personalisation-scene/${ID}`);
  const scene = await sceneRes.json().catch(() => ({}));
  ok(sceneRes.status === 200, 'GET /admin/api/personalisation-scene/<id> is 200',
    `${sceneRes.status} ${JSON.stringify(scene).slice(0, 90)}`);
  ok(scene.id === ID, '  and the id survived the rewrite', scene.id);
  ok(scene.editable === true, '  the build is editable');
  ok(scene.template === 'cover', '  with its template', scene.template);
  ok(scene.recipe?.panels?.[0]?.transform?.zoom === CROP.zoom,
    '  and the crop comes back', String(scene.recipe?.panels?.[0]?.transform?.zoom));
  ok(typeof scene.rev === 'string', '  and a revision to save against', scene.rev);
  ok(scene.panels?.art?.styled?.includes('/api/personalisation-photo/'),
    '  with a panel url', scene.panels?.art?.styled);

  say('\n2. THE PUBLIC ADDRESS IS CLOSED\n');
  for (const path of [
    `/api/personalisation-scene/${ID}`,
    '/api/personalisation-edit-save',
  ]) {
    const res = await fetch(`${BASE}${path}`, {
      method: path.includes('edit-save') ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: path.includes('edit-save') ? JSON.stringify({ id: ID, recipe: recipeFor('X') }) : undefined,
    });
    ok(res.status === 404, `${path} is 404`, String(res.status));
  }
  /* And the function's own address, which no redirect covers. */
  const direct = await fetch(`${BASE}/.netlify/functions/personalisation-edit-save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, recipe: recipeFor('X'), rev: scene.rev }),
  });
  ok(direct.status === 404,
    '/.netlify/functions/personalisation-edit-save refuses too — the function checks the path itself',
    String(direct.status));
  const stillOriginal = await sanity.getDocument(DOC_ID);
  ok(stillOriginal.sceneSvg.includes(ORIGINAL_TITLE),
    '  and none of that changed the build');

  say('\n3. THE SAVE\n');
  const saveRes = await fetch(`${BASE}/admin/api/personalisation-edit-save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, rev: scene.rev, recipe: recipeFor(EDITED_TITLE) }),
  });
  const saved = await saveRes.json().catch(() => ({}));
  ok(saveRes.status === 200 && saved.ok, 'the save is accepted',
    `${saveRes.status} ${JSON.stringify(saved)}`);
  ok(saved.keptOriginal === true, '  and says it kept the original');

  const after = await sanity.getDocument(DOC_ID);
  ok(after.sceneSvg.includes(EDITED_TITLE), '  the edited scene is stored');
  ok(JSON.parse(after.recipe).text[0].value === EDITED_TITLE, '  and the edited recipe');
  ok(JSON.parse(after.recipe).panels[0].transform.zoom === CROP.zoom,
    '  with the crop intact', String(JSON.parse(after.recipe).panels[0].transform.zoom));
  ok(JSON.parse(after.recipe).panels[0].styledKey === `personalisation/${ID}/styled-art.jpg`,
    '  and the paid artwork still referenced');
  ok(after.customerOriginal?.sceneSvg?.includes(ORIGINAL_TITLE),
    '  the customer’s own design is kept');
  ok(after.editCount === 1, '  the edit is counted', String(after.editCount));
  ok(!!after.editedAt, '  and stamped');
  /* preparing if the render job was reached; on_hold if it was not. Both are
     correct and the difference is worth printing rather than asserting away --
     under netlify dev the blobs are sandboxed, so the render itself has no
     styled image to work from and may well fail after being started. */
  ok(after.status === 'preparing' || after.status === 'on_hold',
    '  and the build moved on', `${after.status}${after.renderError ? ` (${after.renderError})` : ''}`);
  ok(after.proofUrl === undefined, '  the stale proof url is cleared');

  say('\n4. A SECOND SAVE LEAVES THE ORIGINAL ALONE\n');
  await sanity.patch(DOC_ID).set({ status: 'rendered' }).commit();
  const rev2 = (await sanity.getDocument(DOC_ID))._rev;
  const res2 = await fetch(`${BASE}/admin/api/personalisation-edit-save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, rev: rev2, recipe: recipeFor('A THIRD VERSION') }),
  });
  const body2 = await res2.json().catch(() => ({}));
  ok(res2.status === 200, 'the second save is accepted', String(res2.status));
  ok(body2.keptOriginal === false, '  and kept nothing new');
  const after2 = await sanity.getDocument(DOC_ID);
  ok(after2.customerOriginal?.sceneSvg?.includes(ORIGINAL_TITLE),
    '  customerOriginal is still the customer’s');
  ok(after2.editCount === 2, '  and the count is 2', String(after2.editCount));

  say('\n5. A STALE REVISION IS REFUSED\n');
  const res3 = await fetch(`${BASE}/admin/api/personalisation-edit-save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, rev: rev2, recipe: recipeFor('SHOULD NOT LAND') }),
  });
  const body3 = await res3.json().catch(() => ({}));
  ok(res3.status === 409, 'a save against the revision we just used is refused', String(res3.status));
  ok(body3.conflict === true, '  as a conflict');
  const after3 = await sanity.getDocument(DOC_ID);
  ok(!after3.sceneSvg.includes('SHOULD NOT LAND'), '  and did not land');
  ok(after3.editCount === 2, '  the count did not move', String(after3.editCount));

  say('\n6. AND FROM A STATUS THE CUSTOMER HAS APPROVED\n');
  await sanity.patch(DOC_ID).set({ status: 'in_production' }).commit();
  const rev4 = (await sanity.getDocument(DOC_ID))._rev;
  const res4 = await fetch(`${BASE}/admin/api/personalisation-edit-save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ID, rev: rev4, recipe: recipeFor('TOO LATE') }),
  });
  const body4 = await res4.json().catch(() => ({}));
  ok(res4.status === 409, 'in_production is refused', String(res4.status));
  ok(/already approved/i.test(body4.error || ''), '  saying why', (body4.error || '').slice(0, 54));
  const sceneRes4 = await fetch(`${BASE}/admin/api/personalisation-scene/${ID}`);
  const scene4 = await sceneRes4.json().catch(() => ({}));
  ok(scene4.editable === false, '  and the editor will not open it either');
}

try {
  await main();
} catch (err) {
  fail++;
  say(`\nTHREW: ${err.message}`);
} finally {
  /* Always, including on a throw: a stub build left in the dataset would show up
     in the Studio and be picked up by the render sweep. */
  try {
    await sanity.delete(DOC_ID);
    say(`\nstub build ${ID} deleted`);
    const gone = await sanity.getDocument(DOC_ID);
    say(gone ? 'WARNING: it is still there' : 'confirmed gone');
  } catch (e) {
    say(`\nCOULD NOT DELETE ${ID}: ${e.message} — remove it in the Studio`);
    fail++;
  }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
