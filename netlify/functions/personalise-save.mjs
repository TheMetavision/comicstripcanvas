import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const MAX_BYTES = 25 * 1024 * 1024;   // 25 MB per photo
const MAX_PHOTOS = 12;                // the strip is the widest template
const STORE = 'personalisation';

// Only what we can safely hand to a renderer. Keyed by the browser's MIME type.
const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Sanity document ids allow [A-Za-z0-9._-]; keep it short, opaque and URL-safe
// so it can double as the Blob path segment.
function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'pp-' + [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

// A panel id off the wire becomes part of a Blob key, so keep it to the shape
// the builder actually produces (panel-01 … panel-12, art) and nothing else.
const safePanelId = (s) => /^[a-zA-Z0-9_-]{1,40}$/.test(s);

export default async (req, context) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Content-Type must be multipart/form-data' }, 400);
  }

  try {
    let form;
    try {
      form = await req.formData();
    } catch {
      return json({ error: 'Malformed form data' }, 400);
    }

    // ── recipe ────────────────────────────────────────────────────────────
    const recipeRaw = form.get('recipe');
    if (typeof recipeRaw !== 'string' || !recipeRaw.trim()) {
      return json({ error: 'Missing recipe' }, 400);
    }
    let recipe;
    try {
      recipe = JSON.parse(recipeRaw);
    } catch {
      return json({ error: 'Recipe is not valid JSON' }, 400);
    }
    if (!recipe || typeof recipe !== 'object' || !recipe.template) {
      return json({ error: 'Recipe is missing its template' }, 400);
    }

    // The scene is stored on its own field; the rest stays as the recipe.
    const { svg: sceneSvg, ...recipeRest } = recipe;

    // ── photos ────────────────────────────────────────────────────────────
    // Each arrives as a field named photo:<panelId> so we know where it belongs.
    const photos = [];
    for (const [field, value] of form.entries()) {
      if (!field.startsWith('photo:')) continue;
      if (typeof value === 'string') {
        return json({ error: 'Expected a file for ' + field }, 400);
      }
      const panelId = field.slice('photo:'.length);
      if (!safePanelId(panelId)) {
        return json({ error: 'Invalid panel id' }, 400);
      }
      photos.push({ panelId, file: value });
    }

    if (photos.length < 1) {
      return json({ error: 'At least one photo is required' }, 400);
    }
    if (photos.length > MAX_PHOTOS) {
      return json({ error: `No more than ${MAX_PHOTOS} photos` }, 400);
    }

    for (const { file } of photos) {
      const type = (file.type || '').toLowerCase();
      if (!type.startsWith('image/') || !EXT[type]) {
        return json({ error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
      }
      if (typeof file.size === 'number' && file.size > MAX_BYTES) {
        return json({ error: 'Each photo must be under 25 MB' }, 400);
      }
    }

    // ── write the photos to Blobs, never to Sanity ────────────────────────
    const id = newId();
    const store = getStore(STORE);
    const photoKeys = [];

    for (const { panelId, file } of photos) {
      const buf = await file.arrayBuffer();
      // size can be absent on the File; the buffer is authoritative
      if (buf.byteLength > MAX_BYTES) {
        return json({ error: 'Each photo must be under 25 MB' }, 400);
      }
      const key = `personalisation/${id}/${panelId}.${EXT[file.type.toLowerCase()]}`;
      await store.set(key, buf, {
        metadata: {
          panelId,
          contentType: file.type,
          originalName: typeof file.name === 'string' ? file.name.slice(0, 120) : '',
        },
      });
      photoKeys.push(key);
    }

    // ── the brief ─────────────────────────────────────────────────────────
    const out = recipe.output || {};
    const dpis = Array.isArray(recipe.panels)
      ? recipe.panels.map((p) => p.effectiveDpi).filter((d) => typeof d === 'number')
      : [];

    const notes = typeof form.get('notes') === 'string' ? form.get('notes').slice(0, 4000) : '';
    const consentRaw = form.get('consentAt');
    const consentAt =
      typeof consentRaw === 'string' && !Number.isNaN(Date.parse(consentRaw))
        ? new Date(consentRaw).toISOString()
        : new Date().toISOString();

    const doc = {
      _id: id,
      _type: 'pendingPersonalisation',
      status: 'draft',
      templateId: recipe.template,
      printSize: out.faceInches ? `${out.faceInches[0]} × ${out.faceInches[1]} in` : '',
      outputFormat: out.format || '',
      recipe: JSON.stringify(recipeRest),
      sceneSvg: typeof sceneSvg === 'string' ? sceneSvg : '',
      photoKeys,
      styledKeys: [],
      customerNotes: notes,
      consentAt,
      createdAt: new Date().toISOString(),
    };
    // omit rather than send null -- an absent field reads better in the Studio
    if (dpis.length) doc.minEffectiveDpi = Math.min(...dpis);

    await sanity.create(doc);

    return json({ id, photoKeys: photoKeys.length });
  } catch (error) {
    console.error('Personalisation save error:', error);
    return json({ error: error.message || 'Failed to save personalisation' }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalise-save is routed by the forced /api/* redirect in netlify.toml
// (/api/* -> /.netlify/functions/:splat). An inline config.path collides with
// that forced rewrite and 404s, so we rely on the redirect like contact does.
