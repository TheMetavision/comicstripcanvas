/**
 * Which stored designs and rendered images carry a SELECTION outline?
 *
 *   node tools/builder/selection-outline-audit.mjs                  # sources only
 *   node tools/builder/selection-outline-audit.mjs --pixels         # + rendered images
 *   node tools/builder/selection-outline-audit.mjs --pixels --masters=all
 *
 * Until this branch, exportSVG() kept the selected panel's outline in the
 * accent colour. A panel outline is a real part of a strip -- the black border
 * round each frame -- so the element belongs in the export; only its colour
 * does not. Whichever panel was selected when Save was pressed therefore went
 * into the saved scene, and would print cyan.
 *
 * Two questions, and they are different. A SOURCE carries the fault if a stored
 * scene has a stroke-width 9 path stroked anything but black. A rendered IMAGE
 * shows it only if those pixels actually reached the file. A scene can carry it
 * without any image showing it, if nothing was ever rendered from that scene.
 *
 * Every pass runs a positive control first, on real stored bytes, because the
 * finding here is a negative and a search that matches nothing looks identical
 * to a search that is broken. The first version of this scan read recipe.svg on
 * pendingPersonalisation, a field that has never existed, and reported a clean
 * 58 out of 58.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(REPO, 'package.json'));
const { getStore } = require('@netlify/blobs');
const { resolveCredentials } = await import(pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);

/** The three brand colours a selection can paint an outline. */
export const ACCENTS = { '#EC008C': [236, 0, 140], '#00AEEF': [0, 174, 239], '#FFF200': [255, 242, 0] };
/** A panel outline is drawn at this width, and nothing else in a scene is. */
const OUTLINE_WIDTH = 9;

/**
 * The outlines in an SVG that are not black.
 *
 * Two alternatives because attribute order is not guaranteed: the builder emits
 * stroke before stroke-width, but a scene that has been through any other
 * serialiser may not. `none` counts as unlit -- an unstroked path is invisible,
 * whatever else it says.
 */
export function litOutlines(svg) {
  if (typeof svg !== 'string' || !svg) return [];
  const re = new RegExp(
    '<path[^>]*stroke="(?!#000\\b|#000000\\b|none\\b)([^"]+)"[^>]*stroke-width="' + OUTLINE_WIDTH + '"'
    + '|<path[^>]*stroke-width="' + OUTLINE_WIDTH + '"[^>]*stroke="(?!#000\\b|#000000\\b|none\\b)([^"]+)"',
    'gi');
  const hits = [];
  let m;
  while ((m = re.exec(svg))) hits.push(m[1] || m[2]);
  return hits;
}

/** Every string in a stored record that might be a scene, named. */
export function sceneFieldsOf(doc) {
  const out = [];
  if (typeof doc.sceneSvg === 'string') out.push(['sceneSvg', doc.sceneSvg]);
  if (typeof doc.svg === 'string') out.push(['svg', doc.svg]);
  /* recipe is a JSON string on pendingPersonalisation and an object in a studio
     scene. Both are searched raw as well as parsed: raw catches a scene nested
     anywhere in it without needing to know the shape. */
  if (typeof doc.recipe === 'string') {
    out.push(['recipe (raw)', doc.recipe]);
    try {
      const p = JSON.parse(doc.recipe);
      if (p && typeof p.svg === 'string') out.push(['recipe.svg', p.svg]);
    } catch { /* not JSON; the raw search still covered it */ }
  } else if (doc.recipe && typeof doc.recipe === 'object') {
    out.push(['recipe (serialised)', JSON.stringify(doc.recipe)]);
  }
  return out;
}

/* ─────────────────────────────────────────── pixels */

/** Anything worth printing: a colour present at all. */
const anyAccent = (found) => Object.entries(found).filter(([, v]) => v.count > 0);

/**
 * Accent-coloured pixels in one encoded image.
 *
 * The run lengths are what separate an outline from the logo. A panel border
 * runs the length of a frame -- hundreds or thousands of pixels in one straight
 * line -- while a mark that merely uses the same brand colour is compact. Both
 * are reported so a hit can be read rather than guessed at.
 */
export async function accentPixels(buf, { tolerance = 30, sharp } = {}) {
  const img = sharp(buf, { limitInputPixels: false, unlimited: true });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const found = {};
  for (const [name, rgb] of Object.entries(ACCENTS)) {
    const [r, g, b] = rgb;
    found[name] = {
      count: 0, minX: width, minY: height, maxX: -1, maxY: -1, runH: 0, runV: 0, exact: 0,
    };
    const f = found[name];
    const cols = new Uint32Array(width);      // vertical runs, one counter per column
    for (let y = 0; y < height; y++) {
      let run = 0;
      const row = y * width * channels;
      for (let x = 0; x < width; x++) {
        const i = row + x * channels;
        const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
        const hit = (dr * dr + dg * dg + db * db) <= tolerance * tolerance;
        if (hit) {
          f.count++;
          if (!dr && !dg && !db) f.exact++;
          if (x < f.minX) f.minX = x;
          if (x > f.maxX) f.maxX = x;
          if (y < f.minY) f.minY = y;
          if (y > f.maxY) f.maxY = y;
          run++; if (run > f.runH) f.runH = run;
          cols[x]++; if (cols[x] > f.runV) f.runV = cols[x];
        } else { run = 0; cols[x] = 0; }
      }
    }
  }
  return { width, height, found };
}

/* ─────────────────────────────────────────── the run */

const mb = (n) => (n / 1048576).toFixed(2);

async function sanity(query, token) {
  const url = 'https://lwbwahym.api.sanity.io/v2021-10-21/data/query/production?query=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

export async function run(argv = []) {
  const arg = (n, d = null) => {
    const hit = argv.find((a) => a === '--' + n || a.startsWith('--' + n + '='));
    if (!hit) return d;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const doPixels = !!arg('pixels');
  const masters = String(arg('masters', '6'));
  const out = [];
  const say = (t = '') => { out.push(t); console.log(t); };

  const { siteID, token } = resolveCredentials();
  if (!siteID || !token) { say('No Netlify credentials — see render-sweep --help.'); return { ok: false }; }
  const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
  const renders = getStore({ name: 'renders', siteID, token, consistency: 'strong' });
  const sanityToken = process.env.SANITY_WRITE_TOKEN || process.env.SANITY_API_TOKEN || null;

  const affected = { studio: [], pending: [], images: [] };

  /* ───────── 1. stored studio scenes */
  say('\n1. STUDIO SCENES IN BLOBS\n');
  const { blobs } = await studio.list();
  const sceneKeys = blobs.map((b) => b.key).filter((k) => /scene\.(json|svg)$/.test(k));
  say('   ' + sceneKeys.length + ' stored scenes (' + blobs.length + ' objects in the store)');
  let control = null;
  const tpl = {};
  let outlinesAtAll = 0;
  for (const key of sceneKeys) {
    const raw = await studio.get(key, { type: 'text' }).catch(() => null);
    if (raw == null) { say('   ! unreadable: ' + key); continue; }
    let doc = null;
    if (/\.json$/.test(key)) { try { doc = JSON.parse(raw); } catch { /* fall through */ } }
    const fields = doc ? sceneFieldsOf(doc) : [['scene.svg', raw]];
    if (!fields.length) fields.push(['(whole object)', raw]);
    const t = (doc && doc.recipe && doc.recipe.template) || (doc && doc.template) || '(unknown)';
    tpl[t] = (tpl[t] || 0) + 1;
    const lit = [];
    for (const field of fields) {
      const name = field[0], val = field[1];
      if (new RegExp('stroke-width="' + OUTLINE_WIDTH + '"').test(String(val))) outlinesAtAll++;
      const l = litOutlines(val);
      if (l.length) lit.push(name + ': ' + [...new Set(l)].join(', '));
      if (!control && String(val).includes('<svg')) control = { key, svg: String(val) };
    }
    if (lit.length) affected.studio.push({ key, template: t, lit });
  }
  say('   by template: ' + JSON.stringify(tpl));
  say('   scenes containing a stroke-width ' + OUTLINE_WIDTH + ' outline of any colour: ' + outlinesAtAll);
  say('   CARRYING A LIT OUTLINE: ' + affected.studio.length);
  affected.studio.forEach((a) => say('     ' + a.key + ' [' + a.template + '] ' + a.lit.join(' | ')));

  /* The control: the same search, on real stored bytes, with one lit outline
     spliced in. If this does not find it, nothing above means anything. */
  if (control) {
    const faked = control.svg
      + '<path d="M0,0" fill="none" stroke="#00AEEF" stroke-width="9" stroke-linejoin="round"/>';
    const c = litOutlines(faked);
    say('   control on real bytes (' + control.key + '): ' + (c.length === 1 && c[0] === '#00AEEF'
      ? 'finds the spliced outline — the search works' : 'FAILED: ' + JSON.stringify(c)));
    if (c.length !== 1) return { ok: false, reason: 'control failed' };
  }

  /* ───────── 2. personalisations, paid and unpaid */
  say('\n2. PENDING PERSONALISATIONS IN SANITY\n');
  if (!sanityToken) say('   no SANITY_WRITE_TOKEN — skipped');
  else {
    const rows = await sanity('*[_type=="pendingPersonalisation"]{_id,orderNumber,orderId,status,templateId,'
      + 'printSize,recipe,sceneSvg,proofUrl,_createdAt}|order(_createdAt asc)', sanityToken);
    const withScene = rows.filter((r) => typeof r.sceneSvg === 'string' && r.sceneSvg.length);
    const byTpl = {};
    rows.forEach((r) => { byTpl[r.templateId || '(none)'] = (byTpl[r.templateId || '(none)'] || 0) + 1; });
    say('   ' + rows.length + ' records, ' + withScene.length + ' with a stored scene');
    say('   by template: ' + JSON.stringify(byTpl));
    for (const r of rows) {
      const lit = [];
      for (const field of sceneFieldsOf(r)) {
        const l = litOutlines(field[1]);
        if (l.length) lit.push(field[0] + ': ' + [...new Set(l)].join(', '));
      }
      if (lit.length) affected.pending.push({ ...r, lit });
    }
    say('   CARRYING A LIT OUTLINE: ' + affected.pending.length);
    affected.pending.forEach((a) => say('     ' + a._id + ' [' + a.templateId + '] status=' + a.status
      + ' order=' + (a.orderNumber || '(unpaid — no order)')
      + ' proof=' + (a.proofUrl ? 'rendered' : 'none') + ' — ' + a.lit.join(' | ')));
    /* Same control, against a real stored scene. */
    const real = withScene[0];
    if (real) {
      const c = litOutlines(real.sceneSvg + '<path d="M0,0" fill="none" stroke="#00AEEF" stroke-width="9"/>');
      say('   control on real bytes (' + real._id + '): ' + (c.length ? 'finds the spliced outline' : 'FAILED'));
    }
  }

  /* ───────── 3. the ordered print cache */
  say('\n3. THE ORDERED PRINT CACHE\n');
  try {
    const op = getStore({ name: 'order-prints', siteID, token, consistency: 'strong' });
    const cache = (await op.list()).blobs;
    say('   ' + cache.length + ' objects');
    for (const b of cache) {
      const raw = await op.get(b.key, { type: 'text' }).catch(() => null);
      const lit = raw ? litOutlines(raw) : [];
      say('     ' + b.key + (lit.length ? '  LIT: ' + lit.join(',') : ''));
      if (lit.length) affected.pending.push({ _id: b.key, lit });
    }
    say('   no finished print file is cached — these are the state notes only');
  } catch (e) { say('   store unavailable: ' + e.message); }

  /* ───────── 4. do any rendered pixels show it? */
  if (!doPixels) {
    say('\n4. RENDERED IMAGES — skipped (pass --pixels)\n');
  } else {
    say('\n4. WHAT THE RENDERED IMAGES ACTUALLY SHOW\n');
    const sharp = require('sharp');
    /* Control first: a swatch of pure accent must be found, and a black one
       must not. */
    const swatch = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 174, b: 239 } } })
      .png().toBuffer();
    const cs = await accentPixels(swatch, { sharp });
    const grey = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png().toBuffer();
    const cg = await accentPixels(grey, { sharp });
    say('   control: cyan swatch -> ' + cs.found['#00AEEF'].count + ' px (expect 1600), '
      + 'black swatch -> ' + anyAccent(cg.found).length + ' accent colours (expect 0)');
    if (cs.found['#00AEEF'].count !== 1600 || anyAccent(cg.found).length) {
      say('   CONTROL FAILED — the pixel check is not trustworthy'); return { ok: false };
    }

    /**
     * The end-to-end control, and the thing that makes a negative mean anything.
     *
     * Comic artwork is FULL of these three colours -- they are the process
     * inks, and half of every pop-art panel is cyan. So "contains accent
     * pixels" says nothing at all. What separates artwork from a vector stroke
     * is that a stroke is drawn, not photographed: over the interior of a
     * 30-pixel-wide line every pixel is the colour EXACTLY, and it runs the
     * length of a panel edge. Halftone dots and JPEG blocks land near the
     * colour and never on it.
     *
     * So this renders the real thing -- a panel outline, lit, through the same
     * renderer the masters go through -- and measures what it looks like. Until
     * that number is on the page, "no exact pixels found" is a hope.
     */
    const { Resvg } = require('@resvg/resvg-js');
    const panel = (stroke) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" '
      + 'width="400" height="600"><rect width="400" height="600" fill="#fff"/>'
      + '<path d="M40,40 H360 V560 H40 Z" fill="none" stroke="' + stroke
      + '" stroke-width="9" stroke-linejoin="round"/></svg>';
    const renderAt = (svg, w) => new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
    for (const scale of [1333, 4800]) {
      const litPng = await accentPixels(renderAt(panel('#00AEEF'), scale), { sharp });
      const blackPng = await accentPixels(renderAt(panel('#000'), scale), { sharp });
      const v = litPng.found['#00AEEF'];
      say('   control at ' + scale + 'px wide: a LIT outline renders ' + v.count + ' px, '
        + v.exact + ' of them exact, longest run ' + v.runH + ' across / ' + v.runV + ' down');
      say('                       the same outline in black renders '
        + anyAccent(blackPng.found).length + ' accent pixels');
      if (!v.exact || anyAccent(blackPng.found).length) {
        say('   CONTROL FAILED — a lit outline is not detectable this way'); return { ok: false };
      }
    }
    say('   so: many EXACT pixels in one long run is an outline; near-misses scattered about are artwork.');
    say('');

    const targets = [];
    const rl = await renders.list();
    rl.blobs.forEach((b) => targets.push({ store: renders, key: b.key, what: 'rendered proof/print' }));
    const listings = blobs.map((b) => b.key).filter((k) => /listing\.(jpg|png)$/.test(k));
    listings.forEach((k) => targets.push({ store: studio, key: k, what: 'listing image' }));
    const prints = blobs.map((b) => b.key).filter((k) => /print(-prev)?\.png$/.test(k));
    const take = masters === 'all' ? prints.length : Math.max(0, parseInt(masters, 10) || 0);
    /* Spread the sample across the list rather than taking the first N, which
       would all be the same style and template. */
    const step = take ? Math.max(1, Math.floor(prints.length / take)) : 0;
    const sampled = take ? prints.filter((_, i) => i % step === 0).slice(0, take) : [];
    sampled.forEach((k) => targets.push({ store: studio, key: k, what: 'print master' }));
    say('   ' + rl.blobs.length + ' rendered proof/print, ' + listings.length + ' listing images, '
      + sampled.length + ' of ' + prints.length + ' print masters (--masters=' + masters + ')');
    say('');

    let done = 0, artworkOnly = 0;
    let worstExact = { key: null, colour: null, exact: 0, run: 0 };
    for (const t of targets) {
      const buf = await t.store.get(t.key, { type: 'arrayBuffer' }).catch((e) => ({ err: e.message }));
      if (buf && buf.err) { say('   ! ' + t.key + ': ' + buf.err); continue; }
      const b = Buffer.from(buf);
      let res;
      try { res = await accentPixels(b, { sharp }); }
      catch (e) { say('   ! ' + t.key + ': decode failed ' + e.message); continue; }
      const hits = anyAccent(res.found);
      done++;
      /* A stroke is exact and long. Artwork is neither, however much of the
         colour it contains. Both thresholds are far below what the control
         measured for a real outline and far above what any artwork reached. */
      const outline = hits.filter((h) => h[1].exact >= 200 && Math.max(h[1].runH, h[1].runV) >= 100);
      if (hits.length) artworkOnly++;
      if (outline.length) {
        artworkOnly--;
        affected.images.push({ key: t.key, what: t.what, hits: outline });
        say('   SHOWS AN OUTLINE  ' + t.key + '  ' + res.width + 'x' + res.height + '  ' + mb(b.length) + ' MB');
        for (const hit of outline) {
          const name = hit[0], v = hit[1];
          say('       ' + name + ': ' + v.count + ' px (' + v.exact + ' EXACT), box '
            + v.minX + ',' + v.minY + '..' + v.maxX + ',' + v.maxY
            + ', longest run ' + v.runH + ' across / ' + v.runV + ' down');
        }
      }
      for (const hit of hits) if (hit[1].exact > worstExact.exact) worstExact = { key: t.key, colour: hit[0], exact: hit[1].exact, run: Math.max(hit[1].runH, hit[1].runV) };
      if (done % 25 === 0) say('   ...' + done + '/' + targets.length + ' images checked');
    }
    say('');
    say('   ' + done + ' images decoded');
    say('   showing a lit outline:                 ' + affected.images.length);
    say('   containing accent-coloured artwork:    ' + artworkOnly + ' (expected — these are comics)');
    say('   most exact accent pixels in any image: ' + worstExact.exact
      + (worstExact.key ? ' (' + worstExact.colour + ', longest run ' + worstExact.run + ', ' + worstExact.key + ')' : ''));
  }

  /* ───────── the answer */
  say('\nSUMMARY\n');
  say('   studio scenes carrying the outline:     ' + affected.studio.length);
  say('   personalisations carrying it:           ' + affected.pending.length);
  say('   rendered images showing the outline:    ' + (doPixels ? affected.images.length : '(not checked)'));
  const report = path.join(REPO, 'tools/builder/print-out/_review/selection-outline-audit.txt');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n') + '\n', 'utf8');
  say('\n   written to ' + path.relative(REPO, report));
  return { ok: true, affected };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await run(process.argv.slice(2));
  process.exit(r.ok ? 0 : 1);
}
