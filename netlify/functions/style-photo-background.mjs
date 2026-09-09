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

/* ---------------------------------------------------------------- cutout */
/* Only the standard comic book cover. The strip, the icons and the full-bleed
   cover use the styled image whole -- their artwork has no burst for a cut-out
   subject to sit on, so removing the background would just leave a hole. */
const CUTOUT_TEMPLATES = new Set(['cover']);
const CUTOUT_TIMEOUT_MS = 90000;

/* The gate. A matting model fails in two directions and both look like a
   success from the outside: it keeps nearly everything, so the cover shows the
   whole photograph with a ragged edge where the burst should be, or it keeps
   nearly nothing and the cover shows an empty burst. Neither throws, so the
   only defence is to measure the alpha and refuse the result.

   Coverage alone does the work. An earlier rule also refused a subject whose
   bounding box spanned both axes, on the theory that it meant nothing had been
   removed -- but a real styled portrait (Martin, 2048 x 2048) cuts out cleanly
   at 61% coverage with a box of 2048 x 2015, because a person photographed
   close up touches all four edges and is still a person, not a background.
   That rule rejected a good cutout, so it is gone; the box is still measured
   and logged, because it is worth seeing when one of these goes wrong. */
const CUTOUT_MIN_COVERAGE = 0.05;
const CUTOUT_MAX_COVERAGE = 0.90;

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

/**
 * Cut the background out of a styled cover.
 *
 * Best-effort throughout: every failure path returns a reason rather than
 * throwing, because a cover without a cutout is a cover that still prints. The
 * only thing that must not happen is a cutout failure costing the customer
 * their styled photograph, so nothing here touches styleStatus or styleCalls.
 *
 * @returns {{ ok: true, png: Buffer, width, height, coverage, bbox, ms }
 *          | { ok: false, reason: string }}
 */
async function makeCutout(jpeg) {
  const base = (process.env.CUTOUT_SERVICE_URL || '').replace(/\/+$/, '');
  const token = process.env.CUTOUT_TOKEN || '';
  if (!base || !token) return { ok: false, reason: 'cutout service not configured' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CUTOUT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/cutout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
      body: jpeg,
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: `service returned ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}` };
    }
    const png = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - started;

    const coverage = Number(res.headers.get('x-alpha-coverage'));
    const bbox = (res.headers.get('x-bbox') || '').split(',').map(Number);
    if (!Number.isFinite(coverage) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
      return { ok: false, reason: 'service gave no coverage or bbox' };
    }

    /* Dimensions come from the service rather than from decoding the PNG here
       again -- it already had the pixels open to count them. */
    const [w, h] = (res.headers.get('x-cutout-px') || '').split('x').map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      return { ok: false, reason: 'service gave no size' };
    }

    if (coverage < CUTOUT_MIN_COVERAGE) {
      return { ok: false, reason: `too little kept (coverage ${coverage.toFixed(3)})` };
    }
    if (coverage > CUTOUT_MAX_COVERAGE) {
      return { ok: false, reason: `too little removed (coverage ${coverage.toFixed(3)})` };
    }
    return { ok: true, png, width: w, height: h, coverage, bbox, ms };
  } catch (err) {
    const aborted = ac.signal.aborted;
    return { ok: false, reason: aborted ? 'timeout' : `request failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

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
      '*[_id == $id][0]{ photos, styleSize, styleCalls, templateId }', { id }
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

    /* The cutout runs AFTER the panel is already 'done' and committed, which
       is what makes it non-fatal by construction: whatever happens next, the
       customer has their styled photograph and can check out. */
    if (CUTOUT_TEMPLATES.has(doc.templateId)) {
      const cut = await makeCutout(jpeg);
      if (cut.ok) {
        const cutoutKey = `personalisation/${id}/cutout-${panel}.png`;
        await photos.set(cutoutKey, cut.png, {
          metadata: {
            panel, kind: 'cutout', contentType: 'image/png',
            coverage: String(cut.coverage), bbox: cut.bbox.join(','),
            uploadedAt: new Date().toISOString(),
          },
        });
        await sanity
          .patch(id)
          .unset([`photos[panel == "${panel}"].cutoutError`])
          .set(setPanel(panel, {
            cutoutKey, cutoutWidth: cut.width ?? null, cutoutHeight: cut.height ?? null,
          }))
          .commit();
        console.log(
          `style-photo: ${id} ${panel} cutout in ${cut.ms} ms — ${cut.width}x${cut.height}, ` +
          `coverage ${cut.coverage.toFixed(3)}, bbox ${cut.bbox.join(',')}, ` +
          `${(cut.png.length / 1024).toFixed(0)} KB -> ${cutoutKey}`
        );
      } else {
        await sanity
          .patch(id)
          .set(setPanel(panel, { cutoutError: String(cut.reason).slice(0, 200) }))
          .commit();
        console.warn(`style-photo: ${id} ${panel} no cutout — ${cut.reason} (the cover still prints styled)`);
      }
    }

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
