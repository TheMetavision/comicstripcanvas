/**
 * Where the artwork sits on a face, and moving a saved design onto another one.
 *
 *   node tools/builder/print-geometry-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An order is for ONE size and finish; the stored print master is whatever the
 * design was built at. Fulfilment therefore has to lay a saved scene onto a
 * face it was not laid out for, and tools/builder/README.md is explicit that
 * layout must not be recalculated server-side. The compromise is that there is
 * exactly one geom(), shared by the builder and the renderer, and that moving a
 * scene between faces is a re-projection of the handful of boxes the builder
 * stretched -- not a second layout engine.
 *
 * The strong assertion is at the bottom. The builder has already produced the
 * answer for every template at two sizes and two finishes: the 20 proof cases
 * in tools/builder/renderer/run. Re-projecting the poster capture onto the
 * gallery face must reproduce the gallery capture the builder made, byte for
 * byte. That is ground truth rather than a restatement of the implementation.
 *
 * Those captures are gitignored, so that section SKIPS when they are absent and
 * says so. To make them:
 *   npm run build && cd tools/builder/renderer && node extract-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  WRAP, FIT, DPI, wrapInchesFor, geom, viewBoxFor, printPixels, reprojectScene,
} from '../../netlify/functions/_shared/print-geometry.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0, skip = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/* ───────────────────────────────────────────────────── the tables */

say('\n1. WRAP AND FIT\n');
{
  ok(WRAP.poster === 0, 'a poster has no wrap');
  ok(WRAP.standard === 1.5, 'a standard canvas wraps 1.5 in');
  ok(WRAP.gallery === 2.5, 'a gallery canvas wraps 2.5 in');
  ok(wrapInchesFor('nonsense') === 0, 'an unknown finish wraps nothing rather than NaN');
  ok(FIT.strip === 'pad', 'a strip pads — its panels are the picture');
  ok(FIT.cover === 'fill' && FIT['icon-portrait'] === 'fill',
    'covers and icons fill — their edge is decorative');
  ok(DPI === 300, 'print is 300 dpi');
}

/* ───────────────────────────────────────────────────── geom() */

say('\n2. WHERE THE ARTWORK SITS\n');
{
  /* The strip, whose canvas is 7350x4950 = 1.4848, against an 18x12 face. */
  const g = geom({ width: 7350, height: 4950 }, { w: 18, h: 12 }, 'pad', 0);
  ok(close(g.ppi, 412.5), 'strip at 18x12: 412.5 canvas px per inch', String(g.ppi));
  ok(close(g.padX / g.ppi, 0.0909, 0.001), 'a 0.091 in border left and right',
    (g.padX / g.ppi).toFixed(4));
  ok(close(g.padY, 0), 'and none top or bottom', String(g.padY));

  /* 'pad' never crops: both pads are >= 0 whatever the face. */
  for (const face of [{ w: 12, h: 8 }, { w: 18, h: 12 }, { w: 24, h: 16 }, { w: 10, h: 10 }]) {
    const p = geom({ width: 7350, height: 4950 }, face, 'pad', 0);
    ok(p.padX >= -0.001 && p.padY >= -0.001,
      `pad keeps the whole design at ${face.w}x${face.h}`,
      `${p.padX.toFixed(1)}, ${p.padY.toFixed(1)}`);
  }

  /* 'fill' never leaves a border: at least one pad is <= 0. */
  for (const face of [{ w: 8, h: 12 }, { w: 12, h: 18 }, { w: 16, h: 24 }]) {
    const f = geom({ width: 4200, height: 5800 }, face, 'fill', 0);
    ok(f.padX <= 0.001 || f.padY <= 0.001,
      `fill leaves no border at ${face.w}x${face.h}`,
      `${f.padX.toFixed(1)}, ${f.padY.toFixed(1)}`);
  }

  /* The wrap is added outside whatever the pad did, on all four sides. */
  const poster = geom({ width: 4200, height: 5800 }, { w: 12, h: 18 }, 'fill', 0);
  const gallery = geom({ width: 4200, height: 5800 }, { w: 12, h: 18 }, 'fill', 2.5);
  ok(close(gallery.dx - poster.dx, 2.5 * poster.ppi),
    'gallery adds exactly 2.5 in of wrap either side',
    String((gallery.dx - poster.dx) / poster.ppi));
  ok(gallery.fileInches[0] === 17 && gallery.fileInches[1] === 23,
    'a 12x18 gallery canvas is a 17x23 in sheet', gallery.fileInches.join('x'));
  const px = printPixels(gallery);
  ok(px.width === 5100 && px.height === 6900, 'which is 5100x6900 px at 300 dpi',
    `${px.width}x${px.height}`);

  /* ex/ey are the clamped ones: a box cannot have negative overhang. */
  const cropping = geom({ width: 4200, height: 5800 }, { w: 12, h: 18 }, 'fill', 0);
  ok(cropping.dx < 0, 'a cover at 12x18 crops the sides', cropping.dx.toFixed(1));
  ok(cropping.ex === 0, 'and its element boxes clamp that to zero', String(cropping.ex));

  ok((() => { try { geom(null, { w: 1, h: 1 }, 'pad', 0); return false; } catch { return true; } })(),
    'a missing canvas throws rather than producing a silent NaN geometry');
}

/* ─────────────────────────────────────────── re-projection, synthetic */

say('\n3. MOVING A SAVED SCENE ONTO ANOTHER FACE\n');
{
  const canvas = { width: 1000, height: 1000 };
  const scene =
    '<svg viewBox="0 0 1000 1000" width="1000" height="1000">'
    + '<rect data-role="bg-colour" x="0" y="0" width="1000" height="1000" fill="#EC008C"/>'
    + '<defs><clipPath id="clip-art"><rect x="0" y="0" width="1000" height="1000"/></clipPath></defs>'
    + '<g clip-path="url(#clip-art)">'
    + '<image data-role="panel" data-panel="art" href="{{IMAGE:art}}" x="0" y="0" width="1000" height="1000"/>'
    + '</g>'
    + '<rect x="100" y="100" width="50" height="50" fill="#000"/>'
    + '</svg>';

  const from = geom(canvas, { w: 10, h: 10 }, 'fill', 0);
  const to = geom(canvas, { w: 10, h: 10 }, 'fill', 1);   // 1 in of wrap = 100 px
  const { svg, changed } = reprojectScene(scene, canvas, from, to);

  ok(svg.includes('viewBox="-100 -100 1200 1200"'), 'the viewBox grows by the wrap',
    /viewBox="[^"]*"/.exec(svg)?.[0]);
  ok(svg.includes('width="1200" height="1200"'), 'and so does the declared size');
  ok(/data-role="bg-colour"[^>]*x="-100"[^>]*width="1200"/.test(svg)
    || /<rect data-role="bg-colour" x="-100" y="-100" width="1200" height="1200"/.test(svg),
    'the background stretches into the wrap');
  ok(/<clipPath id="clip-art"><rect x="-100" y="-100" width="1200" height="1200"/.test(svg),
    'the clip rect grows with it');
  ok(/data-panel="art"[^>]*x="-100"[^>]*width="1200"/.test(svg),
    'and the photo grows to cover the new rect',
    /<image[^>]*data-panel="art"[^>]*>/.exec(svg)?.[0]?.slice(0, 120));
  ok(svg.includes('<rect x="100" y="100" width="50" height="50"'),
    'an ordinary element is left exactly where it was');
  ok(changed.includes('viewBox') && changed.includes('panel:art'),
    'and it reports what it moved', changed.join(','));

  /* Same face, same finish: nothing should move. */
  const same = reprojectScene(scene, canvas, from, from).svg;
  ok(same.includes('viewBox="0 0 1000 1000"'),
    're-projecting onto the same face leaves the viewBox alone');

  /* A photo zoomed and panned by the customer keeps its zoom and its pan. */
  const panned = scene.replace(
    '<image data-role="panel" data-panel="art" href="{{IMAGE:art}}" x="0" y="0" width="1000" height="1000"/>',
    '<image data-role="panel" data-panel="art" href="{{IMAGE:art}}" x="-200" y="-100" width="1500" height="1500"/>');
  const moved = reprojectScene(panned, canvas, from, to).svg;
  const tag = /<image[^>]*data-panel="art"[^>]*>/.exec(moved)[0];
  const num = (a) => Number(new RegExp(`\\b${a}="([^"]*)"`).exec(tag)[1]);
  ok(close(num('width') / 1200, 1500 / 1000, 0.001),
    'the zoom is preserved as a fraction of the cover', String(num('width')));
  ok(close(num('width') / num('height'), 1, 0.001),
    'and the photograph is not stretched', (num('width') / num('height')).toFixed(4));

  ok((() => { try { reprojectScene('<svg/>', canvas, from, to); return false; } catch { return true; } })(),
    'a scene with no viewBox throws rather than rendering something arbitrary');
}

/* ───────────────────────── re-projection against the builder itself */

say('\n4. AGAINST THE BUILDER’S OWN OUTPUT\n');
{
  const RUN = path.join(ROOT, 'tools/builder/renderer/run');
  const casesFile = path.join(RUN, 'cases.json');
  if (!fs.existsSync(casesFile)) {
    skip++;
    say('  SKIP  no captures in tools/builder/renderer/run —');
    say('        npm run build && cd tools/builder/renderer && node extract-all.mjs');
  } else {
    const TEMPLATE_OF = {
      Strip: 'strip', Classiccover: 'cover', Cover: 'cover',
      Coverfullbleed: 'cover-fullbleed', Fullbleed: 'cover-fullbleed',
      Iconportrait: 'icon-portrait', Iconlandscape: 'icon-landscape',
    };
    /* The builder writes long decimals; compare at two places, which is the
       precision it rounds its own re-projected boxes to. */
    const norm = (s) => s
      .replace(/(-?\d+\.\d{3,})/g, (m) => String(Math.round(Number(m) * 100) / 100))
      .replace(/\s+/g, ' ').trim();

    const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    const names = [...new Set(cases.map((c) => c.split('-')[0]))];
    let compared = 0;

    for (const name of names) {
      for (const si of [0, 2]) {
        const fromFile = path.join(RUN, `${name}-poster-${si}.recipe.json`);
        const toFile = path.join(RUN, `${name}-gallery-${si}.recipe.json`);
        if (!fs.existsSync(fromFile) || !fs.existsSync(toFile)) continue;
        const a = JSON.parse(fs.readFileSync(fromFile, 'utf8'));
        const b = JSON.parse(fs.readFileSync(toFile, 'utf8'));
        const fit = FIT[TEMPLATE_OF[name]];
        const from = geom(a.canvas, { w: a.output.faceInches[0], h: a.output.faceInches[1] },
          fit, a.output.wrapInches);
        const to = geom(b.canvas, { w: b.output.faceInches[0], h: b.output.faceInches[1] },
          fit, b.output.wrapInches);
        const got = reprojectScene(a.svg, a.canvas, from, to).svg;
        compared++;
        ok(norm(got) === norm(b.svg),
          `${name} poster→gallery at size ${si} matches the builder exactly`);
      }
    }
    ok(compared >= 8, `compared ${compared} real captures`, String(compared));
  }
}

say(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}.`);
process.exit(fail ? 1 : 0);
