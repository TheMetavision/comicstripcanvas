import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { MIME } from './_shared/scene.mjs';
import { STUDIO_STORE, isUploadId, partKey, artKey } from './_shared/studio-uploads.mjs';

/**
 * Chunked upload for studio artwork.
 *
 * A function request is capped at 6 MB by Netlify's edge, and the cap is
 * enforced BEFORE the function runs -- the reply is a 413 from the platform
 * with no body, which is why the studio's "Save as product" used to fail
 * saying nothing at all. A full-resolution transparent PNG cutout is 20 MB on
 * its own, so the artwork cannot travel in the save request at any size.
 *
 * So it travels ahead of it, in pieces. The browser sends the file in <= 4 MB
 * chunks; each is written as its own blob under
 *
 *     studio/<uploadId>/parts/<index>
 *
 * and the final chunk assembles them, in order, into
 *
 *     studio/<uploadId>/art.<ext>
 *
 * then deletes the parts and returns the key. studio-save is handed that key
 * instead of the bytes, so its request stays a few kilobytes whatever the
 * artwork weighs.
 *
 * The id is issued HERE, on the first chunk, rather than accepted from the
 * caller: it names a key prefix in a shared store, and a caller that chooses
 * its own can write over somebody else's upload. Every later chunk quotes it
 * back.
 *
 * Integrity is checked rather than assumed. The client declares the total byte
 * length up front; assembly refuses if what arrived does not add up to it, and
 * the reply carries the sha256 of the assembled file so the browser can
 * confirm that what landed is what it sent.
 *
 * Nothing here is a customer photograph -- studio mode is the shop preparing
 * its own catalogue artwork. See the note in studio-save.mjs.
 */

/* 4 MB chunks with headroom, because the platform's 6 MB is on the whole
   request and the headers ride along with it. */
const MAX_CHUNK_BYTES = 5 * 1024 * 1024;
/* A sane ceiling, not a technical one: a 60 MB PNG is far beyond anything a
   16 x 24 in print needs, and the number exists so a mistake fails fast rather
   than filling the store. */
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_CHUNKS = 32;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const newUploadId = () => 'up-' + crypto.randomBytes(16).toString('hex');

/** The extension the assembled blob is stored under, from the original name. */
function extensionFor(name) {
  const m = /(\.[A-Za-z0-9]+)$/.exec((name || '').trim());
  const ext = m ? m[1].toLowerCase() : '';
  return MIME[ext] ? ext : '.png';
}

const intHeader = (req, name) => {
  const raw = req.headers.get(name);
  if (raw === null || raw.trim() === '') return NaN;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
};

export default async (req) => {
  const expected = process.env.PERSONALISATION_ACTION_SECRET;
  if (!expected) {
    console.error('studio-upload: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return json({ error: 'Uploading is not configured on this deploy' }, 503);
  }
  if (!sameSecret(req.headers.get('x-csc-action-secret'), expected)) {
    console.warn('studio-upload: rejected a call with a bad or missing secret');
    return json({ error: 'Not authorised' }, 401);
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const index = intHeader(req, 'x-upload-index');
  const total = intHeader(req, 'x-upload-total');
  const bytes = intHeader(req, 'x-upload-bytes');
  if (!Number.isInteger(index) || index < 0) return json({ error: 'X-Upload-Index must be a whole number' }, 400);
  if (!Number.isInteger(total) || total < 1) return json({ error: 'X-Upload-Total must be at least 1' }, 400);
  if (index >= total) return json({ error: `Chunk ${index} is outside a ${total}-chunk upload` }, 400);
  if (total > MAX_CHUNKS) {
    return json({ error: `That is ${total} chunks; the limit is ${MAX_CHUNKS}. Send larger chunks.` }, 400);
  }
  if (!Number.isInteger(bytes) || bytes < 1) return json({ error: 'X-Upload-Bytes must be the whole file size' }, 400);
  if (bytes > MAX_TOTAL_BYTES) {
    return json({
      error: `That image is ${Math.round(bytes / 1048576)} MB; the limit is ${MAX_TOTAL_BYTES / 1048576} MB.`,
    }, 413);
  }

  /* First chunk issues the id; later chunks must quote one this function could
     have issued, and cannot invent a prefix of their own. */
  let id = (req.headers.get('x-upload-id') || '').trim();
  if (index === 0 && !id) id = newUploadId();
  if (!isUploadId(id)) return json({ error: 'X-Upload-Id is missing or not one of ours' }, 400);

  let chunk;
  try {
    chunk = Buffer.from(await req.arrayBuffer());
  } catch (err) {
    return json({ error: `Could not read the chunk: ${err.message}` }, 400);
  }
  if (!chunk.length) return json({ error: 'That chunk was empty' }, 400);
  if (chunk.length > MAX_CHUNK_BYTES) {
    return json({ error: `That chunk is ${chunk.length} bytes; the limit is ${MAX_CHUNK_BYTES}.` }, 413);
  }

  const store = getStore(STUDIO_STORE);
  const startedAt = new Date().toISOString();

  try {
    await store.set(partKey(id, index), chunk, {
      metadata: { kind: 'upload-part', uploadId: id, index, total, uploadedAt: startedAt },
    });
  } catch (err) {
    console.error(`studio-upload: could not store chunk ${index}/${total} of ${id}:`, err.message);
    return json({ error: `Could not store that chunk: ${err.message}` }, 502);
  }

  // Not the last one: acknowledge and wait for the rest.
  if (index < total - 1) {
    return json({ ok: true, uploadId: id, received: index + 1, total, done: false });
  }

  /* ---- assemble ---- */
  const ext = extensionFor(req.headers.get('x-upload-name'));
  const key = artKey(id, ext);
  try {
    const parts = [];
    const missing = [];
    for (let i = 0; i < total; i++) {
      const part = await store.get(partKey(id, i), { type: 'arrayBuffer' });
      if (!part) { missing.push(i); continue; }
      parts.push(Buffer.from(part));
    }
    /* A chunk that never arrived would otherwise be a silently truncated image
       -- which is a print file with a band of it missing, discovered by
       whoever opens it. */
    if (missing.length) {
      return json({
        error: `Chunk${missing.length > 1 ? 's' : ''} ${missing.join(', ')} never arrived — send the image again.`,
        uploadId: id, missing,
      }, 409);
    }

    const whole = Buffer.concat(parts);
    if (whole.length !== bytes) {
      return json({
        error: `The pieces add up to ${whole.length} bytes but ${bytes} were declared — send the image again.`,
        uploadId: id,
      }, 409);
    }

    const sha256 = crypto.createHash('sha256').update(whole).digest('hex');
    await store.set(key, whole, {
      metadata: {
        kind: 'upload', uploadId: id, uploadedAt: startedAt,
        name: (req.headers.get('x-upload-name') || '').slice(0, 120),
        bytes: whole.length, sha256, chunks: total,
      },
    });

    /* The parts are duplicate bytes the moment the whole exists. Failing to
       tidy them up is not a failure of the upload -- the retention sweep
       collects anything left under an upload prefix. */
    await Promise.all(
      Array.from({ length: total }, (_, i) => store.delete(partKey(id, i)).catch(() => null))
    );

    console.log(`studio-upload: ${id} assembled ${total} chunk(s) into ${key} ` +
      `(${whole.length} B, sha256 ${sha256.slice(0, 12)})`);
    return json({ ok: true, uploadId: id, received: total, total, done: true, key, bytes: whole.length, sha256 });
  } catch (err) {
    console.error(`studio-upload: could not assemble ${id}:`, err.message);
    return json({ error: `Could not assemble the upload: ${err.message}` }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/studio-upload is routed by the forced /api/* redirect in netlify.toml,
// like every other function in this directory.
