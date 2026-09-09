import sharp from 'sharp';
import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { styleImage, imageSize, nearestRatio, loadStyleRefs, StyleError, MAX_STYLE_CALLS } from './_shared/style.mjs';

/**
 * Style one photograph.
 *
 * A background function because the model takes ~36s at 2K and ~52s at 4K,
 * against a 10-second budget for a synchronous one. One panel per invocation:
 * the trigger fires once per uploaded photo, and a panel that fails should not
 * take its neighbours down with it.
 *
 * personalise-save POSTs { id, panel } to /api/style-photo, which netlify.toml
 * rewrites here -- the same arrangement the render job has, and for the same
 * reason: an inline config.path collides with the forced /api/* rewrite.
 *
 * Customer photographs never reach Sanity's asset library. The raw bytes come
 * out of the blob store and the styled bytes go back into it under the same
 * personalisation/<id>/ prefix, so retention collects both together. Only keys
 * are written to Sanity.
 *
 * Deliberately no retry loop. style.mjs already retries once on 429/5xx, and a
 * refusal is an answer -- asking again bills twice for the same "no". A failed
 * panel is retried by a person, through /api/personalisation-style.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const PHOTO_STORE = 'personalisation';
const JPEG_QUALITY = 90;

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isPanel = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

/* Three kinds of failure a human needs to tell apart: the model declined the
   photograph, the model took too long, or something else broke. Anything more
   specific belongs in the logs, not in a field a reviewer scans. */
function shortReason(err) {
  if (err instanceof StyleError) {
    const blocked = err.blockReason || err.finishReason;
    if (blocked && /SAFETY|PROHIBITED|BLOCK|SPII|RECITATION/i.test(String(blocked))) {
      return `safety: ${String(blocked).toLowerCase()}`;
    }
    if (/abort|timed out|timeout/i.test(err.message || '')) return 'timeout';
    if (err.status) return `http ${err.status}`;
    if (blocked) return `no image: ${String(blocked).toLowerCase()}`;
    return `other: ${String(err.message).slice(0, 120)}`;
  }
  if (/abort|timed out|timeout/i.test(err?.message || '')) return 'timeout';
  return `other: ${String(err?.message || 'unknown').slice(0, 120)}`;
}

const setPanel = (panel, fields) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [`photos[panel == "${panel}"].${k}`, v]));

/* Did the model actually do any work?

   A refusal from a gateway, an auth failure or a quota rejection never reached
   the model, so it must not spend the cap. That mattered the moment Netlify's
   AI Gateway started answering 401: every upload burned a call against a
   budget of 16 without a single generation, so a build could exhaust itself
   and become permanently unretryable over an outage that produced nothing.

   A safety block DOES count -- the model looked at the photograph and gave its
   answer. So does a timeout: nothing says the generation did not happen, and
   assuming it did is the side to be wrong on. */
const NEVER_REACHED_MODEL = new Set([401, 403, 429]);
const shouldRefund = (err) =>
  typeof err?.status === 'number' &&
  (NEVER_REACHED_MODEL.has(err.status) || (err.status >= 500 && err.status < 600));

async function markFailed(id, panel, reason) {
  try {
    await sanity.patch(id).set(setPanel(panel, { styleStatus: 'failed', styleError: reason })).commit();
  } catch (err) {
    console.error(`style-photo: could not mark ${id} ${panel} failed:`, err.message);
  }
}

export default async (req) => {
  const started = Date.now();
  let id = null, panel = null, charged = false;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id; panel = body.panel;
    if (!isId(id) || !isPanel(panel)) {
      console.error('style-photo: bad id or panel', JSON.stringify(body).slice(0, 200));
      return new Response('Bad request', { status: 400 });
    }

    const doc = await sanity.fetch(
      '*[_id == $id][0]{ photos, styleSize, styleCalls }', { id }
    );
    if (!doc) {
      console.error(`style-photo: ${id} does not exist`);
      return new Response('Unknown', { status: 404 });
    }
    const row = (doc.photos || []).find((p) => p.panel === panel);
    if (!row || !row.rawKey) {
      console.error(`style-photo: ${id} has no photo row for panel ${panel}`);
      return new Response('No such panel', { status: 404 });
    }

    /* The cap is counted here as well as at the trigger, because this function
       is reachable from the retry endpoint too and the count is the only thing
       standing between a stuck retry and an open-ended bill. */
    if ((doc.styleCalls || 0) >= MAX_STYLE_CALLS) {
      await markFailed(id, panel, 'cap');
      console.warn(`style-photo: ${id} ${panel} refused — ${MAX_STYLE_CALLS} calls already used`);
      return new Response('Cap reached', { status: 200 });
    }

    await sanity
      .patch(id)
      .set(setPanel(panel, { styleStatus: 'styling' }))
      .unset([`photos[panel == "${panel}"].styleError`])
      .commit();

    const photos = getStore(PHOTO_STORE);
    const raw = await photos.get(row.rawKey, { type: 'arrayBuffer' });
    if (!raw) throw new Error(`Raw photo blob missing (${row.rawKey})`);
    const rawBuf = Buffer.from(raw);

    const src = imageSize(rawBuf);
    const aspectRatio = nearestRatio(src.width, src.height);
    const size = doc.styleSize === '4K' ? '4K' : '2K';

    // The reference directory is worth a line: it is resolved differently in a
    // bundle than in a local run, and that difference has already bitten once.
    console.log(
      `style-photo: ${id} ${panel} styling ${src.width ?? '?'}x${src.height ?? '?'} ` +
      `ratio ${aspectRatio} size ${size} refs ${loadStyleRefs().dir}`
    );

    /* Claim the call immediately before making it, not earlier: everything
       above this line -- reading the blob, sizing it -- costs nothing and must
       not eat the customer's budget if it fails. Claiming BEFORE rather than
       after still matters, because a call that times out may well have
       generated, and an increment written afterwards would miss exactly the
       kind of call that runs away. Refunded below if it never reached the
       model at all. */
    await sanity.patch(id).setIfMissing({ styleCalls: 0 }).inc({ styleCalls: 1 }).commit();
    charged = true;   // set only after the increment has committed

    const styled = await styleImage({
      buffer: rawBuf,
      mimeType: row.rawKey.endsWith('.png') ? 'image/png' : 'image/jpeg',
      aspectRatio,
      imageSize: size,
    });

    /* Always re-encoded to JPEG at a known quality, whatever came back. The
       model returned image/jpeg on the calls measured here, but nothing in the
       API promises that, and a 4K PNG of a photograph runs to tens of
       megabytes -- paid for in blob storage and again on every render read.
       Even JPEG-in, JPEG-out is worth normalising: 2415 KB at the model's own
       quality became 628 KB at q90 on the first real call, with the print
       pipeline rasterising through resvg either way. */
    const jpeg = await sharp(styled.buffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    const styledKey = `personalisation/${id}/styled-${panel}.jpg`;
    await photos.set(styledKey, jpeg, {
      metadata: {
        panel,
        kind: 'styled',
        contentType: 'image/jpeg',
        model: styled.model,
        styleSize: size,
        aspectRatio,
        jpegQuality: JPEG_QUALITY,
        sourceMimeType: styled.mimeType,
        uploadedAt: new Date().toISOString(),
      },
    });

    await sanity
      .patch(id)
      .setIfMissing({ styledKeys: [] })
      .unset([`styledKeys[@ == "${styledKey}"]`, `photos[panel == "${panel}"].styleError`])
      .append('styledKeys', [styledKey])
      .set(setPanel(panel, {
        styledKey,
        styleStatus: 'done',
        styledWidth: styled.width ?? null,
        styledHeight: styled.height ?? null,
        styledAt: new Date().toISOString(),
      }))
      .commit();

    console.log(
      `style-photo: ${id} ${panel} done in ${styled.ms} ms model, ${Date.now() - started} ms total — ` +
      `${styled.width ?? '?'}x${styled.height ?? '?'} ${styled.mimeType} ` +
      `${(styled.buffer.length / 1024).toFixed(0)} KB -> jpeg q${JPEG_QUALITY} ` +
      `${(jpeg.length / 1024).toFixed(0)} KB -> ${styledKey}`
    );
    return new Response('Styled', { status: 200 });
  } catch (err) {
    const reason = shortReason(err);
    console.error(
      `style-photo: ${id} ${panel} failed after ${Date.now() - started} ms — ${reason}`,
      err instanceof StyleError
        ? JSON.stringify({
            finishReason: err.finishReason, blockReason: err.blockReason,
            status: err.status, modelText: err.modelText,
          })
        : err?.stack || err?.message
    );
    /* Hand the call back if it never reached the model. Paired with the
       increment above -- charged is only true once that has committed -- so
       this cannot take the count below where it started. */
    if (charged && shouldRefund(err) && isId(id)) {
      try {
        await sanity.patch(id).dec({ styleCalls: 1 }).commit();
        console.warn(`style-photo: ${id} ${panel} refunded its call — status ${err.status} never reached the model`);
      } catch (refundErr) {
        console.error(`style-photo: could not refund the call for ${id} ${panel}:`, refundErr.message);
      }
    }
    if (isId(id) && isPanel(panel)) await markFailed(id, panel, reason);
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// personalise-save posts to /api/style-photo, which netlify.toml rewrites to
// this function by name. An inline config.path collides with that forced
// rewrite and 404s, as it does for every other function in this directory.
