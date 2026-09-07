import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { Resvg } from '@resvg/resvg-js';

/**
 * Render a paid personalisation to a print file and a proof.
 *
 * This is tools/builder/renderer/render.mjs as a background function. The idea
 * is unchanged: the scene the customer approved carries every asset as a token,
 * and rendering swaps the tokens for full-resolution files and rasterises that
 * same document. Nothing is recalculated, so nothing can drift.
 *
 *   {{IMAGE:panel-01}}  the customer's photo for that panel
 *   {{OVERLAY}}         template line art and furniture
 *   {{BACKGROUND}}      template background artwork
 *   {{LOGO}}            publisher logo
 *
 * A background function because a 24 x 16 in file at 300dpi is a 7200 x 4800
 * raster; that wants time and memory, not a 10-second request budget.
 *
 * One document per invocation. The webhook POSTs { id, orderId, orderNumber }
 * to /api/render-personalisation, which netlify.toml rewrites here.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const PHOTO_STORE = 'personalisation';
const RENDER_STORE = 'renders';
const DPI = 300;
const PROOF_WIDTH = 1200;

// Only these may be rendered. "rendered" is excluded so a repeat delivery does
// not redo work; "draft"/"awaiting_payment" because nothing has been paid for.
const RENDERABLE = new Set(['paid', 'preparing', 'on_hold']);

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

/* Template artwork lives on the deployed site. These are the full-resolution
   files, kept beside the smaller ones the builder loads in the browser --
   the builder's copies are downscaled for the canvas and reading their pixels
   is part of how it works, so they cannot simply be swapped. */
const TEMPLATE_SLUG = { cover: 'comic-cover', 'cover-fullbleed': 'comic-cover' };
const ASSET_PATH = {
  OVERLAY: (t) => (TEMPLATE_SLUG[t] ? `/builder/templates/${TEMPLATE_SLUG[t]}/overlay-print.png` : null),
  BACKGROUND: (t) => (t === 'cover' ? `/builder/templates/${TEMPLATE_SLUG[t]}/background-print.png` : null),
  LOGO: () => '/builder/csc-logo-print.png',
};
const FONT_FILES = ['Chewy-Regular.ttf', 'LuckiestGuy-Regular.ttf'];

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif',
};
const dataUri = (buf, name) =>
  `data:${MIME[path.extname(name).toLowerCase()] || 'image/png'};base64,${Buffer.from(buf).toString('base64')}`;

/* A renderer matches fonts on the family name inside the file, not on whatever
   name a stylesheet gave it. Get that wrong and the print silently comes out in
   a different typeface -- so check it rather than trust it. */
function readFamilies(b) {
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

async function fetchBinary(url, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${what} (${res.status}) from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export default async (req, context) => {
  let id = null;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id;
    if (!isId(id)) {
      console.error('render-personalisation: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const doc = await sanity.getDocument(id);
    if (!doc) {
      console.error(`render-personalisation: ${id} does not exist`);
      return new Response('Unknown', { status: 404 });
    }
    if (!RENDERABLE.has(doc.status)) {
      // Not an error: a repeat webhook delivery, or a build that was never paid
      // for. Say which so it is obvious in the logs why nothing happened.
      console.log(`render-personalisation: skipping ${id} — status is "${doc.status}", ` +
        `only ${[...RENDERABLE].join(', ')} are rendered.`);
      return new Response('Not renderable', { status: 200 });
    }

    await render(id, doc, req);
    return new Response('Rendered', { status: 200 });
  } catch (err) {
    console.error(`render-personalisation: ${id} failed:`, err.message);
    // Park it for a human rather than leaving it looking paid-and-forgotten.
    if (isId(id)) {
      try {
        await sanity.patch(id).set({ status: 'on_hold', renderError: String(err.message).slice(0, 2000) }).commit();
      } catch (patchErr) {
        console.error(`render-personalisation: could not mark ${id} on hold:`, patchErr.message);
      }
    }
    return new Response('Failed', { status: 500 });
  }
};

async function render(id, doc, req) {
  if (!doc.sceneSvg) throw new Error('The document has no sceneSvg to render');
  const recipe = JSON.parse(doc.recipe || '{}');
  const template = recipe.template || doc.templateId;
  if (!template) throw new Error('The recipe has no template');

  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
  let svg = doc.sceneSvg;

  /* ---- the customer's photos, out of the blob store ---- */
  const photos = getStore(PHOTO_STORE);
  const keyFor = (panelId) => {
    const hit = (arr) => (arr || []).find((k) => new RegExp(`/${panelId}\\.[^/.]+$`).test(k));
    // a styled version supersedes the original for that panel
    return hit(doc.styledKeys) || hit(doc.photoKeys) || null;
  };

  const panelIds = [...svg.matchAll(/\{\{IMAGE:([^}]+)\}\}/g)].map((m) => m[1]);
  const panelData = new Map();
  for (const panelId of new Set(panelIds)) {
    const recipePanel = (recipe.panels || []).find((p) => p.id === panelId);
    if (recipePanel && recipePanel.placeholder) {
      // A paid print must never contain the example artwork.
      throw new Error(`Panel ${panelId} still holds the example graphic, not a customer photo`);
    }
    const key = keyFor(panelId);
    if (!key) throw new Error(`No photo stored for panel ${panelId}`);
    const buf = await photos.get(key, { type: 'arrayBuffer' });
    if (!buf) throw new Error(`Photo blob missing for panel ${panelId} (${key})`);
    panelData.set(panelId, dataUri(buf, key));
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

  /* ---- rasterise ---- */
  const out = recipe.output || {};
  const canvas = recipe.canvas || doc.canvas || {};
  const face = out.faceInches || [(canvas.width || 3000) / DPI, (canvas.height || 3000) / DPI];
  const wrap = out.wrapInches || 0;
  const fileIn = out.fileInches || [face[0] + 2 * wrap, face[1] + 2 * wrap];
  const printWidth = Math.round(fileIn[0] * DPI);

  const raster = (width) => new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
    // print files must be opaque; a transparent edge row would show as white
    // on one press and black on another
    background: '#FFFFFF',
  }).render();

  // Both are produced before anything is written, so a failure never leaves a
  // half-written print file behind.
  const print = raster(printWidth);
  const proof = raster(PROOF_WIDTH);
  const printPng = print.asPng();
  const proofPng = proof.asPng();

  const renders = getStore(RENDER_STORE);
  const printKey = `renders/${id}/print.png`;
  const proofKey = `renders/${id}/proof.png`;
  await renders.set(printKey, printPng, {
    metadata: { id, kind: 'print', width: print.width, height: print.height, dpi: DPI },
  });
  await renders.set(proofKey, proofPng, {
    metadata: { id, kind: 'proof', width: proof.width, height: proof.height },
  });

  await sanity.patch(id).set({
    status: 'rendered',
    proofUrl: `${origin}/api/personalisation-proof/${id}`,
  }).unset(['renderError']).commit();

  try { fs.rmSync(fontDir, { recursive: true, force: true }); } catch { /* tmp */ }

  console.log(
    `render-personalisation: ${id} ${template} ` +
    `${fileIn[0]} x ${fileIn[1]} in @ ${DPI}dpi -> print ${print.width} x ${print.height} px ` +
    `(${printPng.length} B), proof ${proof.width} x ${proof.height} px`
  );
}

// NOTE: deliberately NO `export const config = { path }` here.
// The webhook posts to /api/render-personalisation, which netlify.toml rewrites
// to this function by name. An inline config.path collides with that forced
// rewrite and 404s, exactly as it does for the other functions here.
