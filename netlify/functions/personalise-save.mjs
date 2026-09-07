import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

/**
 * Two operations, both multipart, told apart by whether a file came with them:
 *
 *   photo     photo=<file> panelId=<id> [id] [consentAt]  -> { id, key }
 *             The first one creates the pendingPersonalisation document and
 *             returns its id; every later one carries that id and appends a key.
 *
 *   finalise  id=<id> recipe=<json> [notes]               -> { id }
 *             Called once from Add to basket, when every panel is filled.
 *
 * Photos go to Netlify Blobs. Only their keys are ever written to Sanity.
 *
 * One request carries one photo on purpose. Functions run on Lambda with a
 * ~6 MB request payload cap, so a whole strip in a single post cannot work; the
 * browser re-encodes each photo to fit under MAX_BYTES before sending it.
 */
const MAX_BYTES = 5.5 * 1024 * 1024;   // matches the builder's encode ceiling
const MAX_PHOTOS = 12;                 // the strip is the widest template
const STORE = 'personalisation';

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

// Sanity ids allow [A-Za-z0-9._-]; short, opaque, and safe as a Blob path segment.
function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'pp-' + [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}
const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

// A panel id off the wire becomes part of a Blob key, so hold it to the shape
// the builder actually produces (panel-01 … panel-12, art) and nothing else.
const isPanelId = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export default async (req, context) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!(req.headers.get('content-type') || '').includes('multipart/form-data')) {
    return json({ error: 'Content-Type must be multipart/form-data' }, 400);
  }

  try {
    let form;
    try {
      form = await req.formData();
    } catch {
      return json({ error: 'Malformed form data' }, 400);
    }

    const photo = form.get('photo');
    return photo && typeof photo !== 'string'
      ? await savePhoto(form, photo)
      : await finalise(form);
  } catch (error) {
    console.error('Personalisation save error:', error);
    return json({ error: error.message || 'Failed to save personalisation' }, 500);
  }
};

/* ---------- one photo ---------- */
async function savePhoto(form, file) {
  const panelId = form.get('panelId');
  if (!isPanelId(panelId)) return json({ error: 'Invalid panel id' }, 400);

  const type = (file.type || '').toLowerCase();
  if (!type.startsWith('image/') || !EXT[type]) {
    return json({ error: `Unsupported file type: ${file.type || 'unknown'}` }, 400);
  }

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: 'That photo is too large once encoded — try a smaller image' }, 413);
  }

  const given = form.get('id');
  if (given !== null && given !== '' && !isId(given)) {
    return json({ error: 'Invalid id' }, 400);
  }
  const creating = !given;
  const id = creating ? newId() : given;

  // The key is deterministic per panel, so replacing a panel's photo overwrites
  // rather than accumulating.
  const key = `personalisation/${id}/${panelId}.${EXT[type]}`;

  if (!creating) {
    const existing = await sanity.fetch('*[_id == $id][0]{ photoKeys }', { id });
    if (!existing) return json({ error: 'Unknown personalisation' }, 404);
    const keys = existing.photoKeys || [];
    if (!keys.includes(key) && keys.length >= MAX_PHOTOS) {
      return json({ error: `No more than ${MAX_PHOTOS} photos` }, 400);
    }
  }

  await getStore(STORE).set(key, buf, {
    metadata: {
      panelId,
      contentType: type,
      originalName: str(file.name, 120),
    },
  });

  const consentRaw = form.get('consentAt');
  const consentAt =
    typeof consentRaw === 'string' && !Number.isNaN(Date.parse(consentRaw))
      ? new Date(consentRaw).toISOString()
      : new Date().toISOString();

  if (creating) {
    await sanity.create({
      _id: id,
      _type: 'pendingPersonalisation',
      status: 'draft',
      photoKeys: [key],
      styledKeys: [],
      consentAt,
      createdAt: new Date().toISOString(),
    });
  } else {
    // unset-then-insert keeps this idempotent when a panel is re-uploaded
    await sanity
      .patch(id)
      .setIfMissing({ photoKeys: [] })
      .unset([`photoKeys[@ == "${key}"]`])
      .append('photoKeys', [key])
      .commit();
  }

  return json({ id, key });
}

/* ---------- the brief, once every panel is filled ---------- */
async function finalise(form) {
  const id = form.get('id');
  if (!isId(id)) return json({ error: 'Invalid id' }, 400);

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

  const existing = await sanity.fetch('*[_id == $id][0]{ _id, photoKeys }', { id });
  if (!existing) return json({ error: 'Unknown personalisation' }, 404);
  if (!(existing.photoKeys || []).length) {
    return json({ error: 'No photos have been uploaded yet' }, 400);
  }

  // The scene is stored on its own field; the rest stays as the recipe.
  const { svg: sceneSvg, ...recipeRest } = recipe;
  const out = recipe.output || {};
  const dpis = Array.isArray(recipe.panels)
    ? recipe.panels.map((p) => p.effectiveDpi).filter((d) => typeof d === 'number')
    : [];

  const set = {
    templateId: recipe.template,
    printSize: out.faceInches ? `${out.faceInches[0]} × ${out.faceInches[1]} in` : '',
    outputFormat: out.format || '',
    recipe: JSON.stringify(recipeRest),
    sceneSvg: typeof sceneSvg === 'string' ? sceneSvg : '',
    customerNotes: str(form.get('notes'), 4000),
  };
  // omit rather than send null -- an absent field reads better in the Studio
  if (dpis.length) set.minEffectiveDpi = Math.min(...dpis);

  await sanity.patch(id).set(set).commit();
  return json({ id });
}

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalise-save is routed by the forced /api/* redirect in netlify.toml
// (/api/* -> /.netlify/functions/:splat). An inline config.path collides with
// that forced rewrite and 404s, so we rely on the redirect like contact does.
