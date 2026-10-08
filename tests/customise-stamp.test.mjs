// The publisher stamp is locked on "Customise this design" saves.
//
//   npm test
//
// lockStamp() is pure and tested directly. The last tests run the real
// personalise-save handler with Sanity and Netlify Blobs stubbed: nothing is
// read from or written to the production dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/* ---------- stubs for the handler tests (installed before it is imported) ---------- */
globalThis.__cscTest = { created: [], scene: null, product: null };
const STUBS = {
  '@sanity/client': `
    export function createClient() {
      const t = globalThis.__cscTest;
      return {
        fetch: async () => t.product,
        create: async (doc) => { t.created.push(doc); return doc; },
        patch: () => ({ set() { return this; }, setIfMissing() { return this; }, commit: async () => ({}) }),
        getDocument: async () => null,
      };
    }`,
  '@netlify/blobs': `
    export function getStore() {
      return { get: async () => globalThis.__cscTest.scene, set: async () => {}, delete: async () => {} };
    }`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in STUBS) return { url: `stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
    return next(url, context);
  },
});

const { lockStamp, stampFromRecipeLogo } = await import('../netlify/functions/_shared/customise-stamp.mjs');

/* ---------- a product scene, shaped like the builder's export ---------- */
const PLATE = '<rect x="3354" y="640" width="237" height="183" rx="14" ry="14" fill="#ffffff"/>';
const LOGO = '<image href="{{LOGO}}" x="3360" y="650" width="225" height="163" data-role="logo" preserveAspectRatio="none" clip-path="url(#logoClip)"/>';
const CLIP = '<clipPath id="logoClip"><rect x="3354" y="640" width="237" height="183" rx="14" ry="14"/></clipPath>';
const svgWith = ({ plate = PLATE, logo = LOGO, clip = CLIP, extra = '', title = 'ORIGINAL' } = {}) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 6000">' +
  `<defs>${clip}</defs>` +
  '<image href="{{IMAGE:panel-01}}" x="0" y="0" width="4000" height="6000" data-role="panel" data-panel="panel-01"/>' +
  '<image href="{{OVERLAY}}" x="0" y="0" width="4000" height="6000" data-role="overlay"/>' +
  `${plate}${logo}${extra}` +
  `<text data-field="title">${title}</text>` +
  '</svg>';

const PRODUCT_LOGO = { custom: null, slot: [3354, 640, 237, 183], fitted: [3360, 650, 225, 163], fillPlate: true, plateColour: '#ffffff' };
const SOURCE = {
  svg: svgWith(),
  recipe: {
    template: 'cover',
    logo: PRODUCT_LOGO,
    panels: [{ id: 'panel-01', transform: { zoom: 1, offsetX: 0, offsetY: 0 } }],
    text: [{ id: 'title', value: 'ORIGINAL' }, { id: 'publisher', value: 'COMIC STRIP CANVAS' }],
  },
  images: { 'panel-01': 'studio/product-bruce-lee-cover/classic/art/panel-01.png' },
};
const customerRecipe = (over = {}) => ({
  template: 'cover',
  logo: PRODUCT_LOGO,
  panels: [{ id: 'panel-01', transform: { zoom: 1, offsetX: 0, offsetY: 0 } }],
  text: [{ id: 'title', value: 'MY TITLE' }, { id: 'publisher', value: 'COMIC STRIP CANVAS' }],
  ...over,
});

/* ---------- lockStamp ---------- */

test('an untouched stamp passes through unchanged; the customer wording is kept', () => {
  const sent = svgWith({ title: 'MY TITLE' });
  const r = lockStamp(sent, customerRecipe(), SOURCE);
  assert.equal(r.ok, true);
  assert.equal(r.svg, sent);
  assert.deepEqual(r.changed, []);
  assert.match(r.svg, /MY TITLE/);
});

test('a moved, resized or re-plated logo is put back exactly as the product has it', () => {
  const tampered = svgWith({
    title: 'MY TITLE',
    plate: '<rect x="0" y="0" width="900" height="900" rx="14" ry="14" fill="#ff0000"/>',
    logo: '<image href="{{LOGO}}" x="10" y="10" width="880" height="880" data-role="logo" preserveAspectRatio="none" clip-path="none"/>',
    clip: '<clipPath id="logoClip"><rect x="0" y="0" width="900" height="900"/></clipPath>',
  });
  const r = lockStamp(tampered, customerRecipe({ logo: { custom: 'my-logo.png', slot: [0, 0, 900, 900], fillPlate: false } }), SOURCE);
  assert.equal(r.ok, true);
  assert.ok(r.svg.includes(PLATE + LOGO), 'product plate + logo restored');
  assert.ok(r.svg.includes(CLIP), 'product clip restored');
  assert.ok(!r.svg.includes('#ff0000') && !r.svg.includes('width="880"'));
  assert.match(r.svg, /MY TITLE/, 'wording untouched');
  assert.deepEqual(r.recipe.logo, PRODUCT_LOGO, 'recipe.logo is the product\'s');
  assert.deepEqual(r.changed.sort(), ['recipe.logo', 'stamp', 'stamp clip']);
});

test('a customer logo picture by URL or path is refused, wherever it is placed', () => {
  for (const href of ['https://evil.example/logo.png', '/builder/other.png', 'blob:https://x/1', 'my-logo.png']) {
    const asLogo = svgWith({ logo: LOGO.replace('{{LOGO}}', href) });
    assert.equal(lockStamp(asLogo, customerRecipe(), SOURCE).ok, false, `logo href ${href}`);
    const asExtra = svgWith({ extra: `<image href="${href}" x="3354" y="640" width="237" height="183"/>` });
    assert.equal(lockStamp(asExtra, customerRecipe(), SOURCE).ok, false, `extra image ${href}`);
    const xlink = svgWith({ extra: `<image xlink:href="${href}" x="1" y="1" width="2" height="2"/>` });
    assert.equal(lockStamp(xlink, customerRecipe(), SOURCE).ok, false, `xlink image ${href}`);
  }
});

test('removing or duplicating the stamp is refused', () => {
  assert.equal(lockStamp(svgWith({ plate: '', logo: '' }), customerRecipe(), SOURCE).ok, false);
  assert.equal(lockStamp(svgWith({ logo: LOGO + LOGO }), customerRecipe(), SOURCE).ok, false);
});

test('a missing clip is put back from the product', () => {
  const r = lockStamp(svgWith({ clip: '' }), customerRecipe(), SOURCE);
  assert.equal(r.ok, true);
  assert.ok(r.svg.includes(CLIP));
});

test('a stored scene without SVG: the stamp is rebuilt from its recipe.logo', () => {
  const noSvg = { ...SOURCE, svg: undefined };
  const tampered = svgWith({ logo: LOGO.replace('x="3360"', 'x="1"') });
  const r = lockStamp(tampered, customerRecipe(), noSvg);
  assert.equal(r.ok, true);
  const built = stampFromRecipeLogo(PRODUCT_LOGO);
  assert.ok(r.svg.includes(built.plateAndLogo));
  assert.match(built.plateAndLogo, /x="3360" y="650" width="225" height="163"/);
  assert.match(built.plateAndLogo, /fill="#ffffff"/);
});

test('a product with no stamp: a stamp sent by the customer is refused', () => {
  const plain = { svg: svgWith({ plate: '', logo: '', clip: '' }), recipe: { ...SOURCE.recipe, logo: null } };
  assert.equal(lockStamp(svgWith({ clip: '' }), customerRecipe(), plain).ok, false);
  assert.equal(lockStamp(svgWith({ plate: '', logo: '', clip: '' }), customerRecipe({ logo: null }), plain).ok, true);
});

/* ---------- the real save path ---------- */

const { default: handler } = await import('../netlify/functions/personalise-save.mjs');

async function saveCustomise(svg, recipe) {
  const t = globalThis.__cscTest;
  t.created.length = 0;
  t.scene = JSON.stringify(SOURCE);
  t.product = { _id: 'product-bruce-lee-cover', title: 'Bruce Lee Cover', slug: 'bruce-lee-cover', customiseFee: 500, classicSceneId: 'product-bruce-lee-cover' };
  const fd = new FormData();
  fd.append('kind', 'customise');
  fd.append('productId', 'product-bruce-lee-cover');
  fd.append('style', 'classic');
  fd.append('recipe', JSON.stringify({ ...recipe, svg }));
  fd.append('notes', '');
  const res = await handler(new Request('http://localhost/api/personalise-save', { method: 'POST', body: fd }), {});
  return { status: res.status, body: await res.json(), doc: t.created[0] };
}

test('personalise-save: a tampered logo in a customise recipe is ignored; the product stamp is saved', async () => {
  const tampered = svgWith({
    title: 'MY TITLE',
    plate: '<rect x="0" y="0" width="900" height="900" rx="14" ry="14" fill="#ff0000"/>',
    logo: '<image href="{{LOGO}}" x="10" y="10" width="880" height="880" data-role="logo" preserveAspectRatio="none" clip-path="none"/>',
  });
  const r = await saveCustomise(tampered, customerRecipe({ logo: { custom: 'mine.png', slot: [0, 0, 900, 900], fillPlate: false } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.doc.kind, 'customise');
  assert.ok(r.doc.sceneSvg.includes(PLATE + LOGO), 'saved scene carries the product stamp');
  assert.ok(!r.doc.sceneSvg.includes('#ff0000'));
  assert.match(r.doc.sceneSvg, /MY TITLE/);
  assert.deepEqual(JSON.parse(r.doc.recipe).logo, PRODUCT_LOGO);
  assert.equal(r.doc.customerTitle, 'MY TITLE');
});

test('personalise-save: a customise recipe with a foreign logo picture is refused (422)', async () => {
  const r = await saveCustomise(svgWith({ logo: LOGO.replace('{{LOGO}}', 'https://evil.example/logo.png') }), customerRecipe());
  assert.equal(r.status, 422);
  assert.equal(r.doc, undefined, 'nothing written');
});

test('personalise-save: an honest customise save still works and keeps the wording', async () => {
  const r = await saveCustomise(svgWith({ title: 'MY TITLE' }), customerRecipe());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.doc.sceneSvg, /MY TITLE/);
  assert.deepEqual(r.doc.artworkKeys.map((a) => a.key), ['studio/product-bruce-lee-cover/classic/art/panel-01.png']);
});

/* ---------- against a real stored scene ---------- */
import { readFileSync } from 'node:fs';
const REAL = JSON.parse(readFileSync(new URL('./fixtures/customise-scene-bruce-lee-cover.json', import.meta.url), 'utf8'));
const realSource = { svg: REAL.sceneSvg, recipe: REAL.recipe };

test('real scene: an untouched export passes unchanged', () => {
  const { svg, ...rest } = { ...REAL.recipe, svg: REAL.sceneSvg };
  const r = lockStamp(svg, rest, realSource);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.svg, REAL.sceneSvg);
  assert.deepEqual(r.changed, []);
});

test('real scene: rebuilding the stamp from recipe.logo gives the stored stamp byte for byte', () => {
  const built = stampFromRecipeLogo(REAL.recipe.logo);
  assert.ok(REAL.sceneSvg.includes(built.plateAndLogo), built.plateAndLogo);
  assert.ok(REAL.sceneSvg.includes(built.clip), built.clip);
});

test('real scene: a re-plated, moved logo is restored', () => {
  const tampered = REAL.sceneSvg
    .replace('fill="#030305"/><image href="{{LOGO}}" x="3583"', 'fill="#ff00ff"/><image href="{{LOGO}}" x="100"');
  assert.notEqual(tampered, REAL.sceneSvg);
  const r = lockStamp(tampered, { ...REAL.recipe, logo: { ...REAL.recipe.logo, fillPlate: false } }, realSource);
  assert.equal(r.ok, true);
  assert.equal(r.svg, REAL.sceneSvg);
  assert.deepEqual(r.recipe.logo, REAL.recipe.logo);
});
