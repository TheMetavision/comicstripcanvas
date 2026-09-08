import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/**
 * Scene rendering, shared by the two things that rasterise a builder scene:
 *
 *   render-personalisation-background.mjs  a paid customer build
 *   studio-save.mjs                        a design the shop is turning into a
 *                                          catalogue product
 *
 * They differ only in where the panel images come from and what they do with
 * the output, so that is exactly what is injected: `imageFor(panelId)` returns
 * a data URI, and each caller rasterises at whatever widths it needs.
 *
 * The idea is unchanged from tools/builder/renderer/render.mjs: the scene the
 * customer approved carries every asset as a token, and rendering swaps the
 * tokens for full-resolution files and rasterises that same document. Nothing
 * is recalculated, so nothing can drift.
 *
 *   {{IMAGE:panel-01}}  a photo for that panel
 *   {{OVERLAY}}         template line art and furniture
 *   {{BACKGROUND}}      template background artwork
 *   {{LOGO}}            publisher logo
 */

export const DPI = 300;

/* Template artwork lives on the deployed site. These are the full-resolution
   files, kept beside the smaller ones the builder loads in the browser -- the
   builder's copies are downscaled for the canvas and reading their pixels is
   part of how it works, so they cannot simply be swapped. */
export const TEMPLATE_SLUG = { cover: 'comic-cover', 'cover-fullbleed': 'comic-cover' };
export const ASSET_PATH = {
  OVERLAY: (t) => (TEMPLATE_SLUG[t] ? `/builder/templates/${TEMPLATE_SLUG[t]}/overlay-print.png` : null),
  BACKGROUND: (t) => (t === 'cover' ? `/builder/templates/${TEMPLATE_SLUG[t]}/background-print.png` : null),
  LOGO: () => '/builder/csc-logo-print.png',
};
export const FONT_FILES = ['Chewy-Regular.ttf', 'LuckiestGuy-Regular.ttf'];

export const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

export const dataUri = (buf, name) =>
  `data:${MIME[path.extname(name).toLowerCase()] || 'image/png'};base64,${Buffer.from(buf).toString('base64')}`;

/* A renderer matches fonts on the family name inside the file, not on whatever
   name a stylesheet gave it. Get that wrong and the print silently comes out in
   a different typeface -- so check it rather than trust it. */
export function readFamilies(b) {
  const numTables = b.readUInt16BE(4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString('ascii', rec, rec + 4) === 'name') nameOff = b.readUInt32BE(rec + 8);
  }
  if (!nameOff) return [];
  const count = b.readUInt16BE(nameOff + 2);
  const strOff = nameOff + b.readUInt16BE(nameOff + 4);
  const out = new Set();
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    const platform = b.readUInt16BE(r), nameId = b.readUInt16BE(r + 6);
    const len = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const raw = b.subarray(strOff + off, strOff + off + len);
    out.add(platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1'));
  }
  return [...out];
}

export async function fetchBinary(url, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${what} (${res.status}) from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch the brand fonts to disk for resvg.
 *
 * Fonts are NOT inlined into the scene -- prepareScene inlines images only --
 * so anything that rasterises a scene has to load these itself, or resvg will
 * quietly fall back to a different typeface.
 */
export async function loadFonts(origin) {
  const fontDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-fonts-'));
  const fontFiles = [];
  const available = new Set();
  for (const name of FONT_FILES) {
    const buf = await fetchBinary(`${origin}/builder/fonts/${name}`, `font ${name}`);
    const file = path.join(fontDir, name);
    fs.writeFileSync(file, buf);
    fontFiles.push(file);
    readFamilies(buf).forEach((f) => available.add(f));
  }
  return {
    fontFiles,
    available,
    cleanup: () => { try { fs.rmSync(fontDir, { recursive: true, force: true }); } catch { /* tmp */ } },
  };
}

/** Refuse to render text in a typeface nobody chose. */
export function assertFontsPresent(svg, available) {
  const wanted = new Set([...svg.matchAll(/font-family="([^"]+)"/g)]
    .map((m) => m[1].replace(/^['"]|['"]$/g, '')));
  const absent = [...wanted].filter((f) => !available.has(f));
  if (absent.length) {
    throw new Error(
      `Font not available — the render would silently substitute. Wanted ` +
      `${absent.map((f) => `"${f}"`).join(', ')}; loaded ` +
      `${[...available].map((f) => `"${f}"`).join(', ') || '(none)'}`
    );
  }
}

/**
 * Swap every token in the scene for real artwork and check the fonts.
 *
 * @param {string}   sceneSvg  the tokenised scene from the builder
 * @param {object}   recipe    the builder's recipe (template, panels, output)
 * @param {string}   origin    where the print assets and fonts are served from
 * @param {Function} imageFor  async (panelId) => data URI for that panel
 * @returns {{svg, fontFiles, fileInches, printWidth, template, cleanup}}
 */
export async function prepareScene({ sceneSvg, recipe, origin, imageFor }) {
  if (!sceneSvg) throw new Error('There is no sceneSvg to render');
  const template = recipe.template;
  if (!template) throw new Error('The recipe has no template');

  let svg = sceneSvg;

  /* ---- the photos ---- */
  const panelIds = [...svg.matchAll(/\{\{IMAGE:([^}]+)\}\}/g)].map((m) => m[1]);
  const panelData = new Map();
  for (const panelId of new Set(panelIds)) {
    const recipePanel = (recipe.panels || []).find((p) => p.id === panelId);
    if (recipePanel && recipePanel.placeholder) {
      // A print must never contain the example artwork.
      throw new Error(`Panel ${panelId} still holds the example graphic, not a real photo`);
    }
    const uri = await imageFor(panelId);
    if (!uri) throw new Error(`No image supplied for panel ${panelId}`);
    panelData.set(panelId, uri);
  }
  svg = svg.replace(/\{\{IMAGE:([^}]+)\}\}/g, (_, pid) => panelData.get(pid) || '');

  /* ---- template artwork, full resolution, off the deployed site ---- */
  for (const kind of ['OVERLAY', 'BACKGROUND', 'LOGO']) {
    const token = new RegExp(`\\{\\{${kind}\\}\\}`, 'g');
    if (!token.test(svg)) continue;
    const rel = ASSET_PATH[kind](template);
    if (!rel) throw new Error(`No ${kind} asset defined for template "${template}"`);
    const buf = await fetchBinary(origin + rel, `${kind} for ${template}`);
    svg = svg.replace(token, dataUri(buf, rel));
  }

  /* ---- fonts: loaded explicitly, checked, never substituted ---- */
  const fonts = await loadFonts(origin);
  assertFontsPresent(svg, fonts.available);
  const { fontFiles, cleanup: cleanupFonts } = fonts;

  const out = recipe.output || {};
  const canvas = recipe.canvas || {};
  const face = out.faceInches || [(canvas.width || 3000) / DPI, (canvas.height || 3000) / DPI];
  const wrap = out.wrapInches || 0;
  const fileInches = out.fileInches || [face[0] + 2 * wrap, face[1] + 2 * wrap];

  return {
    svg,
    fontFiles,
    template,
    fileInches,
    printWidth: Math.round(fileInches[0] * DPI),
    cleanup: cleanupFonts,
  };
}

/**
 * Rasterise a prepared scene at a given pixel width.
 * Print files must be opaque: a transparent edge row shows as white on one
 * press and black on another.
 */
export function rasterise(svg, fontFiles, width) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
    background: '#FFFFFF',
  }).render();
}
