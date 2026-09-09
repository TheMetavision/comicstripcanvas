import crypto from 'node:crypto';
import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { styleSizeForTemplate, MAX_STYLE_CALLS } from './_shared/style.mjs';
import { findStyledTwin, adoptStyledTwin } from './_shared/style-dedupe.mjs';

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
 *   thumb     id=<id> thumb=<file>                        -> { id, key }
 *             The builder's own snapshot of the live preview, for the basket
 *             line and the Stripe line-item image. Best-effort: Add to basket
 *             has already succeeded by the time this is sent, and a failure
 *             only costs the basket its picture.
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

// A 600px JPEG at q0.8 lands well under 200 KB. The cap is generous enough to
// absorb a busy strip without giving the endpoint a way to store real photos.
const MAX_THUMB_BYTES = 512 * 1024;

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

    const thumb = form.get('thumb');
    if (thumb && typeof thumb !== 'string') return await saveThumb(form, thumb);

    const photo = form.get('photo');
    return photo && typeof photo !== 'string'
      ? await savePhoto(form, photo, req)
      : await finalise(form);
  } catch (error) {
    console.error('Personalisation save error:', error);
    return json({ error: error.message || 'Failed to save personalisation' }, 500);
  }
};

/* ---------- one photo ---------- */
async function savePhoto(form, file, req) {
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

  const store = getStore(STORE);
  await store.set(key, buf, {
    metadata: {
      panelId,
      contentType: type,
      originalName: str(file.name, 120),
      // Read by the retention job's orphan sweep. Blobs carry no server-side
      // timestamp -- list() returns keys and etags only -- so the age of a blob
      // has to be something we write ourselves.
      uploadedAt: new Date().toISOString(),
    },
  });

  /* Identifies the photograph itself, not the upload. The same picture dropped
     into several panels of a strip is one model call, not twelve -- which on a
     12-panel strip is the difference between 36 seconds and seven minutes. */
  const sha256 = crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');

  /* The template decides the style size, and it is not known here: the builder
     posts the recipe at Add to basket, long after the first photo goes up. An
     optional templateId on the upload lets it be right from the first call;
     without one this defaults to 2K and finalise() corrects the field later.
     Wiring the builder to send it is 10b-2b. */
  const templateId = str(form.get('templateId'), 40) || null;

  const consentRaw = form.get('consentAt');
  const consentAt =
    typeof consentRaw === 'string' && !Number.isNaN(Date.parse(consentRaw))
      ? new Date(consentRaw).toISOString()
      : new Date().toISOString();

  /* The blob goes up before the document, and if the document write fails the
     blob is taken back down again.

     The blob is the half with no owner: nothing points at it, so nothing will
     ever find it again. Before this, a failed create left one behind for good
     -- retention walks documents, so a blob belonging to no document was
     invisible to it. A burst of failing uploads (a phone on a bad connection,
     which is exactly when creates fail) leaked one blob per attempt.

     Writing the document first was the other option and is worse: the id is
     only handed back on success, so a client that failed after the create
     would retry and make a SECOND document, leaking documents instead of
     blobs -- visible in the Studio, and referencing photos that may not exist.
     Keys are deterministic per panel, so a retry of this path overwrites
     rather than accumulating. The sweep in retention.mjs catches whatever
     still slips through, e.g. if this delete fails too. */
  try {
    if (creating) {
      await sanity.create({
        _id: id,
        _type: 'pendingPersonalisation',
        status: 'draft',
        photoKeys: [key],
        styledKeys: [],
        photos: [photoRow({ panel: panelId, rawKey: key, sha256 })],
        styleSize: styleSizeForTemplate(templateId),
        styleCalls: 0,
        consentAt,
        createdAt: new Date().toISOString(),
      });
    } else {
      /* Two arrays to append to, and a patch carries only ONE insert -- a
         second .append() on the same patch silently REPLACES the first rather
         than adding to it. Appending photoKeys and photos from one patch
         therefore wrote photos and quietly dropped photoKeys, which is the
         field kept for compatibility. Two patches in one transaction: still
         atomic, one insert each.

         unset-then-insert in each keeps it idempotent when a panel is
         re-uploaded. */
      await sanity
        .transaction()
        .patch(id, (p) => p
          .setIfMissing({ photoKeys: [], styleCalls: 0 })
          .unset([`photoKeys[@ == "${key}"]`])
          .append('photoKeys', [key]))
        .patch(id, (p) => p
          .setIfMissing({ photos: [] })
          .unset([`photos[panel == "${panelId}"]`])
          .append('photos', [photoRow({ panel: panelId, rawKey: key, sha256 })]))
        .commit();
    }
  } catch (err) {
    // Only the create can strand a blob: a failed patch leaves the document,
    // and the document still owns the prefix. Deleting on a failed patch would
    // throw away a photo the customer had already uploaded successfully.
    if (creating) {
      try {
        await store.delete(key);
        console.warn(`personalise-save: create failed for ${id}, removed orphaned blob ${key}`);
      } catch (delErr) {
        console.error(
          `personalise-save: create failed for ${id} AND its blob ${key} could not be removed ` +
          `(${delErr.message}) — retention's orphan sweep will collect it`
        );
      }
    }
    throw err;
  }

  // Styling is best-effort from here: the photo is stored and the document is
  // written, so a trigger that does not fire leaves a retryable 'pending' row
  // rather than losing anything.
  const style = await triggerStyle({ id, panelId, sha256, req });

  return json({ id, key, sha256, style });
}

const photoRow = ({ panel, rawKey, sha256, styleStatus = 'pending' }) => ({
  _type: 'styledPhoto',
  _key: `p-${panel}`,
  panel,
  rawKey,
  sha256,
  styleStatus,
});

/**
 * Decide what should happen to a freshly stored photo, and set it going.
 *
 * Three outcomes, in order of preference: reuse an identical photo already
 * styled on this document, refuse because the personalisation has used its
 * quota, or invoke the background styler.
 *
 * Never throws. The caller has already stored the photo and answered for it;
 * a styling trigger that fails leaves the row 'pending' and is retryable
 * through /api/personalisation-style.
 */
async function triggerStyle({ id, panelId, sha256, req }) {
  try {
    const doc = await sanity.fetch('*[_id == $id][0]{ photos, styleCalls, styledKeys }', { id });
    const photos = doc?.photos || [];

    // Dedupe before anything is spent -- see _shared/style-dedupe.mjs.
    const twin = findStyledTwin(photos, { panel: panelId, sha256 });
    if (twin) {
      await adoptStyledTwin(sanity, id, panelId, twin);
      console.log(`personalise-save: dedupe hit — ${id} ${panelId} reused the styled photo from ${twin.panel} (same sha256)`);
      return { deduped: true, from: twin.panel };
    }

    if ((doc?.styleCalls || 0) >= MAX_STYLE_CALLS) {
      await markFailed(id, panelId, 'cap');
      console.warn(`personalise-save: ${id} ${panelId} refused — ${MAX_STYLE_CALLS} style calls already used`);
      return { capped: true };
    }

    // Same shape as the webhook's call to /api/render-personalisation: post to
    // the /api/* alias and let netlify.toml find the -background function.
    const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
    const res = await fetch(`${origin}/api/style-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, panel: panelId }),
    });
    if (!res.ok) {
      console.error(`personalise-save: style trigger for ${id} ${panelId} returned ${res.status}`);
      return { triggered: false, status: res.status };
    }
    return { triggered: true };
  } catch (err) {
    console.error(`personalise-save: could not trigger styling for ${id} ${panelId}:`, err.message);
    return { triggered: false, error: err.message };
  }
}

/** Shared by the trigger and the retry endpoint. */
export async function markFailed(id, panelId, reason) {
  await sanity
    .patch(id)
    .set({
      [`photos[panel == "${panelId}"].styleStatus`]: 'failed',
      [`photos[panel == "${panelId}"].styleError`]: reason,
    })
    .commit();
}

/**
 * Re-seat photos[] into the panels the recipe puts them in.
 *
 * Matched on rawKey, which identifies the photograph's upload and never
 * changes, rather than on panel, which is exactly what a swap changes.
 *
 * Deliberately all-or-nothing. It only rewrites when the recipe's rawKeys are
 * a clean permutation of the existing rows' -- same set, no duplicates, none
 * missing. A partial match would mean the two disagree about which
 * photographs exist, and quietly writing half a mapping in that state is worse
 * than leaving a stale one: at least a stale mapping is coherent, and the
 * render job refuses a panel it cannot resolve rather than printing the wrong
 * photograph. Returns null to mean "leave it alone".
 */
export function remapPhotoPanels(photos, recipePanels) {
  if (!Array.isArray(photos) || !photos.length) return null;
  if (!Array.isArray(recipePanels) || !recipePanels.length) return null;

  const byRawKey = new Map();
  for (const row of photos) {
    if (!row || !row.rawKey) return null;          // nothing to match on
    if (byRawKey.has(row.rawKey)) return null;     // ambiguous
    byRawKey.set(row.rawKey, row);
  }

  const wanted = recipePanels.filter((p) => p && p.rawKey && !p.placeholder);
  if (wanted.length !== byRawKey.size) return null;

  const seen = new Set();
  const out = [];
  for (const p of wanted) {
    const row = byRawKey.get(p.rawKey);
    if (!row || seen.has(p.rawKey)) return null;   // unknown or duplicated
    seen.add(p.rawKey);
    if (!isPanelId(p.id)) return null;
    out.push({ ...row, _key: `p-${p.id}`, panel: p.id });
  }
  return out;
}

/* ---------- the basket thumbnail ---------- */
/* Stored beside the photos, under the same personalisation/<id>/ prefix, so the
   retention sweep collects it with everything else -- that job lists the prefix
   rather than trusting photoKeys, so it needs no change to cover this.
   Deliberately NOT appended to photoKeys: that array drives the render, where
   every entry is matched to a panel, and a key that answers to no panel has no
   business in it. */
async function saveThumb(form, file) {
  const id = form.get('id');
  if (!isId(id)) return json({ error: 'Invalid id' }, 400);

  const type = (file.type || '').toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/jpg') {
    return json({ error: `Thumbnail must be a JPEG (got ${file.type || 'unknown'})` }, 400);
  }

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_THUMB_BYTES) {
    return json({ error: 'Thumbnail is too large' }, 413);
  }

  const existing = await sanity.fetch('*[_id == $id][0]{ _id }', { id });
  if (!existing) return json({ error: 'Unknown personalisation' }, 404);

  const key = `personalisation/${id}/thumb.jpg`;
  await getStore(STORE).set(key, buf, {
    // uploadedAt as above: the orphan sweep has no other way to age a blob.
    metadata: {
      contentType: 'image/jpeg',
      role: 'basket-thumb',
      uploadedAt: new Date().toISOString(),
    },
  });

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

  const existing = await sanity.fetch('*[_id == $id][0]{ _id, photoKeys, photos }', { id });
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
    // Authoritative: the template is known for certain here. Photos already
    // styled keep the size they were done at -- correcting the field does not
    // re-style them, and re-styling a finished cover to gain 4K would double
    // its cost for a difference the customer has already approved.
    styleSize: styleSizeForTemplate(recipe.template),
  };

  /* Panels can be swapped in the builder after their photographs were
     uploaded, so the panel a photograph sits in at Add to basket is not
     necessarily the one it was uploaded under.
     photos[] is rewritten to the customer's final arrangement rather than
     leaving the render job to consult the recipe instead. photos[] is what the
     status endpoint, the styled-photo endpoint, the Studio panel and the
     render job all read; teaching only the renderer about the recipe would
     leave every other reader describing an arrangement the customer never
     approved, and two sources of truth to keep in step. One rewrite here and
     everything downstream stays correct without knowing swapping exists. */
  const remapped = remapPhotoPanels(existing.photos, recipe.panels);
  if (remapped) {
    set.photos = remapped;
    const moved = remapped.filter((r, i) => r.panel !== (existing.photos || [])[i]?.panel).length;
    if (moved) console.log(`personalise-save: ${id} remapped ${moved} panel(s) after a swap`);
  }
  // omit rather than send null -- an absent field reads better in the Studio
  if (dpis.length) set.minEffectiveDpi = Math.min(...dpis);

  await sanity.patch(id).set(set).commit();
  return json({ id });
}

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalise-save is routed by the forced /api/* redirect in netlify.toml
// (/api/* -> /.netlify/functions/:splat). An inline config.path collides with
// that forced rewrite and 404s, so we rely on the redirect like contact does.
