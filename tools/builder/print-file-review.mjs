/**
 * Make the print file for every size and finish, and look at all of them.
 *
 *   node tools/builder/print-file-review.mjs
 *
 * A cover and an icon, each at 3 sizes x 3 finishes = 18 files, plus a contact
 * sheet of the lot. Writes to tools/builder/print-out/_review/ (gitignored).
 *
 * This is the check that cannot be done with assertions alone. The numbers are
 * asserted too -- pixel size, the wrap band, pHYs -- but whether a gallery-wrap
 * cover actually carries its burst round the corner is a thing somebody has to
 * see, and 18 thumbnails on one sheet is the cheapest way to see it.
 *
 * Needs the 20 proof captures, which are gitignored:
 *   npm run build && cd tools/builder/renderer && node extract-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import { SIZE_KEYS } from '../../netlify/functions/_shared/sizes.mjs';
import { wrapInchesFor, DPI } from '../../netlify/functions/_shared/print-geometry.mjs';
import {
  faceFor, renderFromScene, readDpi, expectedPixels,
} from '../../netlify/functions/_shared/print-file.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RUN = path.join(ROOT, 'tools/builder/renderer/run');
const OUT = path.join(ROOT, 'tools/builder/print-out/_review');
const FONTS = path.join(ROOT, 'tools/builder/renderer/_fonts');
const ASSETS = path.join(ROOT, 'tools/builder/renderer/assets-preview');

const FINISHES = ['poster', 'standard', 'gallery'];
const CASES = [
  { tag: 'Classiccover-poster-2', template: 'cover', orientation: 'portrait', name: 'cover' },
  { tag: 'Iconportrait-poster-2', template: 'icon-portrait', orientation: 'portrait', name: 'icon' },
];

if (!fs.existsSync(path.join(RUN, 'cases.json'))) {
  console.log('No captures in tools/builder/renderer/run.');
  console.log('  npm run build && cd tools/builder/renderer && node extract-all.mjs');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const fontFiles = fs.readdirSync(FONTS).map((f) => path.join(FONTS, f));
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const dataUri = (buf, name) =>
  `data:${MIME[path.extname(name).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`;

/* Stand-ins for the two things the deployed function gets from elsewhere: the
   template artwork off the site, and the design's own photographs out of the
   blob store. Here both come off disk, which is what the proof harness does. */
const ASSET_REL = {
  OVERLAY: {
    cover: 'comic-cover/overlay.png',
    'cover-fullbleed': 'comic-cover/overlay.png',
  },
  LOGO: { cover: 'csc-logo.png', 'cover-fullbleed': 'csc-logo.png' },
};

async function prepare({ sceneSvg, recipe, imageFor }) {
  let svg = sceneSvg;
  const ids = [...svg.matchAll(/\{\{IMAGE:([^}]+)\}\}/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const uri = await imageFor(id);
    svg = svg.split(`{{IMAGE:${id}}}`).join(uri);
  }
  for (const kind of ['OVERLAY', 'LOGO']) {
    if (!svg.includes(`{{${kind}}}`)) continue;
    const rel = ASSET_REL[kind][recipe.template];
    const buf = fs.readFileSync(path.join(ASSETS, rel));
    svg = svg.split(`{{${kind}}}`).join(dataUri(buf, rel));
  }
  if (svg.includes('{{BACKGROUND}}')) {
    const buf = fs.readFileSync(path.join(ASSETS, 'comic-cover/background.png'));
    svg = svg.split('{{BACKGROUND}}').join(dataUri(buf, 'background.png'));
  }
  return { svg, fontFiles, cleanup: null };
}

const rasterise = (svg, fonts, width) => new Resvg(svg, {
  fitTo: { mode: 'width', value: width },
  font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
  background: '#FFFFFF',
}).render();

const placeholder = fs.readFileSync(path.join(ASSETS, 'placeholder.png'));
const imageFor = async () => dataUri(placeholder, 'placeholder.png');

const rows = [];
const thumbs = [];
const faceRef = new Map();
let bad = 0;

for (const c of CASES) {
  const recipe = JSON.parse(fs.readFileSync(path.join(RUN, `${c.tag}.recipe.json`), 'utf8'));
  for (const sizeKey of SIZE_KEYS) {
    for (const finish of FINISHES) {
      const face = faceFor(sizeKey, c.orientation);
      const t0 = Date.now();
      const { png, width, height } = await renderFromScene({
        sceneSvg: recipe.svg, recipe, template: c.template, face, finish,
        prepare, rasterise, origin: '', imageFor,
      });
      const ms = Date.now() - t0;

      const meta = await sharp(png).metadata();
      const want = expectedPixels(face, finish);
      const dpi = readDpi(png);
      const wrapIn = wrapInchesFor(finish);

      const okSize = meta.width === want.width && meta.height === want.height;
      const okDpi = dpi === DPI;
      if (!okSize || !okDpi) bad++;

      const file = `${c.name}-${sizeKey}-${finish}.png`;
      fs.writeFileSync(path.join(OUT, file), png);

      /* THE WRAP HAS TO BE PAINTED.

         This is the failure the whole feature exists to prevent: a canvas whose
         wrap is blank, so the picture stops at the corner and the sides of the
         frame are white. Sampling the outer band rather than trusting the
         geometry, because "the viewBox was bigger" and "there are pixels there"
         are different claims.

         Note what is NOT asserted here. The face is not a pixel-identical crop
         of the poster: the builder re-fits a full-canvas photo to COVER the
         enlarged rect and stretches a background to it, so a canvas shows a
         slightly tighter crop than the poster of the same design. That is the
         builder's own behaviour -- print-geometry-tests proves this
         re-projection reproduces the builder's gallery output byte for byte --
         and it is what the customer saw in the preview. */
      if (finish !== 'poster') {
        const wrapPx = Math.round(wrapIn * DPI);
        const band = Math.max(8, Math.floor(wrapPx / 3));
        const strips = await Promise.all([
          sharp(png).extract({ left: 0, top: 0, width: meta.width, height: band }).stats(),
          sharp(png).extract({ left: 0, top: meta.height - band, width: meta.width, height: band }).stats(),
          sharp(png).extract({ left: 0, top: 0, width: band, height: meta.height }).stats(),
          sharp(png).extract({ left: meta.width - band, top: 0, width: band, height: meta.height }).stats(),
        ]);
        /* An unpainted wrap is flat white: every channel at 255 with no spread.
           Real artwork in the band has some variation in it. */
        const edges = ['top', 'bottom', 'left', 'right'].map((side, i) => {
          const ch = strips[i].channels;
          const meanAll = ch.reduce((a, c) => a + c.mean, 0) / ch.length;
          const sd = ch.reduce((a, c) => a + c.stdev, 0) / ch.length;
          return { side, blank: meanAll > 250 && sd < 2, mean: meanAll, sd };
        });
        const blank = edges.filter((e) => e.blank).map((e) => e.side);
        if (blank.length) bad++;
        console.log(`    ${finish} wrap painted on all four edges: ` +
          `${blank.length ? 'NO — blank on ' + blank.join(', ') : 'yes'} ` +
          `(sd ${edges.map((e) => e.sd.toFixed(0)).join('/')})`);
      }
      rows.push({
        file, face: `${face.w}x${face.h}`, finish, wrapIn,
        sheet: `${(face.w + 2 * wrapIn)}x${(face.h + 2 * wrapIn)} in`,
        px: `${meta.width}x${meta.height}`, want: `${want.width}x${want.height}`,
        okSize, dpi, mb: +(png.length / 1048576).toFixed(1), ms,
      });
      thumbs.push({ png, label: `${c.name} ${sizeKey} ${finish}` });
      console.log(`  ${file.padEnd(28)} ${String(meta.width + 'x' + meta.height).padEnd(12)} ` +
        `${okSize ? 'ok' : 'WRONG SIZE'} ${dpi}dpi ${ms}ms`);
    }
  }
}

/* ---- the contact sheet ---- */
const COLS = 6, CELL = 320, PADDING = 8;
const rowsN = Math.ceil(thumbs.length / COLS);
const sheetW = COLS * (CELL + PADDING) + PADDING;
const sheetH = rowsN * (CELL + PADDING) + PADDING;
const composites = [];
for (let i = 0; i < thumbs.length; i++) {
  const buf = await sharp(thumbs[i].png)
    .resize(CELL, CELL, { fit: 'contain', background: '#202020' })
    .png().toBuffer();
  composites.push({
    input: buf,
    left: PADDING + (i % COLS) * (CELL + PADDING),
    top: PADDING + Math.floor(i / COLS) * (CELL + PADDING),
  });
}
await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: '#202020' } })
  .composite(composites).png().toFile(path.join(OUT, 'contact-sheet.png'));

fs.writeFileSync(path.join(OUT, 'print-files.json'), JSON.stringify(rows, null, 2));

console.log('');
console.log('file                          face     finish    sheet          pixels        dpi');
for (const r of rows) {
  console.log(`${r.file.padEnd(29)} ${r.face.padEnd(8)} ${r.finish.padEnd(9)} ` +
    `${r.sheet.padEnd(14)} ${r.px.padEnd(13)} ${r.dpi}`);
}
console.log(`\n${rows.length} files, ${bad} wrong. Contact sheet: ${path.join(OUT, 'contact-sheet.png')}`);
process.exit(bad ? 1 : 0);
