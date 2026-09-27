/**
 * Whether a customise design is a cut-out, and where it stops.
 *
 *   node tools/builder/customise-variant-tests.mjs
 *
 * variantOf() asked whether the server held a cut-out of the CUSTOMER'S OWN
 * photograph. On "Customise this design" the artwork is the shop's, already
 * cut out, delivered as one finished image -- so there was never a cutoutUrl,
 * bleeds() was false, and the preview clipped the figure to the inner art
 * window while the print used the clip stored in the scene. On Bruce Lee the
 * two disagreed by a quarter to a third of the sheet. The print was right.
 *
 * So the scene says what it is. These tests are about that rule, and about the
 * one thing that must NOT change: a personalised build, where the customer's
 * own photo really does come in two versions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { customiseCutout, storedClipRect, sameRect } from '../../src/scripts/customise-variant.js';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* The cover template's art window, and the face box the three migrated covers
   are clipped to — both measured from the real scenes. */
const WINDOW = { x: 397, y: 378, width: 3411, height: 5000 };
const FACE = { x: 166.67, y: 0, width: 3866.67, height: 5800 };
const svgWith = (rect, extra = '') =>
  `<svg><defs><clipPath id="clip-art"><rect${extra} x="${rect.x}" y="${rect.y}" `
  + `width="${rect.width}" height="${rect.height}"/></clipPath></defs></svg>`;

/* ─────────────────────────────────── 1. the scene says so */

say('\n1. WHEN THE SCENE DECLARES ITSELF\n');
{
  const cut = customiseCutout({ recipe: { imageVariant: 'cutout' }, sceneSvg: svgWith(FACE) }, WINDOW);
  ok(cut.variant === 'cutout', 'imageVariant cutout is a cut-out', cut.why);
  ok(sameRect(cut.rect, FACE), 'and it carries the clip it was saved with', JSON.stringify(cut.rect));

  const full = customiseCutout({ recipe: { imageVariant: 'styled' }, sceneSvg: svgWith(WINDOW) }, WINDOW);
  ok(full.variant === 'styled', 'imageVariant styled is a full picture', full.why);
  ok(full.rect === null, 'and overrides nothing — the art window is already the rule');

  /* A declaration beats the clip, in both directions. */
  const oddFull = customiseCutout({ recipe: { imageVariant: 'styled' }, sceneSvg: svgWith(FACE) }, WINDOW);
  ok(oddFull.variant === 'styled', 'a scene that says full picture is believed, whatever its clip');
  const oddCut = customiseCutout({ recipe: { imageVariant: 'cutout' }, sceneSvg: svgWith(WINDOW) }, WINDOW);
  ok(oddCut.variant === 'cutout', 'and so is one that says cut-out');
}

/* ─────────────────────── 2. cutoutClip, which is the migrated case */

say('\n2. WITH A cutoutClip — THE THREE MIGRATED COVERS\n');
{
  const clip = { top: 'face', right: 'face', bottom: 'face', left: 'face' };
  const d = customiseCutout({ recipe: { cutoutClip: clip }, sceneSvg: svgWith(FACE) }, WINDOW);
  ok(d.variant === 'cutout', 'a cutoutClip means a cut-out even with no imageVariant', d.why);
  ok(d.rect === null,
    'and no stored rect is handed over: the clip is recomputed per finish, as the print does');

  const declared = customiseCutout(
    { recipe: { imageVariant: 'cutout', cutoutClip: clip }, sceneSvg: svgWith(FACE) }, WINDOW);
  ok(declared.variant === 'cutout' && declared.rect === null,
    'with both, the clip still wins over the stored rect', declared.why);
}

/* ──────────────────────── 3. neither — fall back to the stored rect */

say('\n3. NEITHER — THE CLIP IT WAS SAVED WITH\n');
{
  const legacy = customiseCutout({ recipe: {}, sceneSvg: svgWith(FACE) }, WINDOW);
  ok(legacy.variant === 'cutout', 'a clip that is not the art window means a cut-out', legacy.why);
  ok(sameRect(legacy.rect, FACE),
    'and the preview is given that exact rect — the print will not move it either',
    JSON.stringify(legacy.rect));

  const window = customiseCutout({ recipe: {}, sceneSvg: svgWith(WINDOW) }, WINDOW);
  ok(window.variant === 'styled', 'a clip that IS the art window is a full picture', window.why);
  ok(window.rect === null, 'with nothing to override');

  /* Half a pixel of rounding must not flip the verdict. */
  const nudged = { x: WINDOW.x + 0.3, y: WINDOW.y - 0.2, width: WINDOW.width, height: WINDOW.height };
  ok(customiseCutout({ recipe: {}, sceneSvg: svgWith(nudged) }, WINDOW).variant === 'styled',
    'and rounding does not turn one into the other');

  ok(customiseCutout({ recipe: {}, sceneSvg: svgWith(FACE) }, null).variant === 'cutout',
    'with no art window to compare, a stored clip is taken at its word');
  ok(customiseCutout({ recipe: {}, sceneSvg: '<svg></svg>' }, WINDOW).variant === 'styled',
    'and a scene with no clip at all stays a full picture');
  ok(customiseCutout({}, WINDOW).variant === 'styled', 'an empty payload does not throw');
  ok(customiseCutout(null, WINDOW).variant === 'styled', 'nor a missing one');
}

/* ─────────────────────────────── 4. reading the rect */

say('\n4. READING THE STORED RECT\n');
{
  ok(sameRect(storedClipRect(svgWith(FACE)), FACE), 'the rect comes back as written');
  ok(storedClipRect(svgWith(FACE, ' data-role="cutout-clip" data-clip-top="face"')) !== null,
    'a marked rect reads the same way');
  ok(storedClipRect('<svg><clipPath id="other"><rect x="1" y="2" width="3" height="4"/></clipPath></svg>') === null,
    'another clipPath is not mistaken for it');
  ok(storedClipRect('<svg><defs><clipPath id="clip-art"><rect x="1" y="2"/></clipPath></defs></svg>') === null,
    'a rect missing width and height is null, not NaN');
  ok(storedClipRect(null) === null && storedClipRect(undefined) === null, 'and nothing is null');
}

/* ───────── 5. a personalised build must behave exactly as before */

say('\n5. A CUSTOMER\'S OWN PHOTO IS UNTOUCHED\n');
{
  const builder = read('src/scripts/product-builder.js');

  /* The customer rule still keys on the cut-out OF THEIR PHOTO. */
  ok(/s\.cutoutUrl \|\| s\.shopCutout/.test(builder),
    'variantOf still asks for cutoutUrl first — a personalised build is decided the same way');
  ok(/s\.variant !== 'styled'/.test(builder),
    'and the customer can still switch their cover back to the full picture');
  ok(/MODE === 'studio'[\s\S]{0,120}s\.variant === 'cutout'/.test(builder),
    'the studio branch is unchanged');

  /* shopCutout is only ever set from a customise scene, so an uploaded photo
     can never acquire it. */
  const sets = [...builder.matchAll(/shopCutout\s*=/g)];
  ok(sets.length === 1, 'shopCutout is written in exactly one place', `${sets.length} assignment(s)`);
  const at = builder.indexOf('shopCutout =');
  const fn = builder.lastIndexOf('async function loadCustomise', at);
  ok(fn !== -1 && fn < at, 'and that place is loadCustomise — nothing else can set it');
  ok(/customiseCutout\(data, window\)/.test(builder), 'from the scene the customise endpoint returned');

  /* Same for the stored-rect override. */
  const rectSets = [...builder.matchAll(/shopClipRect\s*=/g)];
  ok(rectSets.length === 1, 'and so is shopClipRect', `${rectSets.length} assignment(s)`);
  ok(/bleedable\(CUTOUT_PANEL_OF_COVER\)/.test(builder),
    'both are guarded by the template that has a cut-out at all');

  /* applyCutout, which is the personalised path, is untouched by any of it. */
  const applyCutout = builder.slice(builder.indexOf('async function applyCutout'),
    builder.indexOf('async function applyCutout') + 900);
  ok(!/shopCutout|shopClipRect|customiseCutout/.test(applyCutout),
    'and the customer cut-out path mentions none of them');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
