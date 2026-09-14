import { createClient } from '@sanity/client';
import { cutoutConfigured } from './_shared/cutout.mjs';
import { MAX_STYLE_CALLS } from './_shared/style-limits.mjs';
import { busyMessageFor } from './_shared/spend-guard.mjs';
import { pausedRows, resumeDocument, PAUSED } from './_shared/style-resume.mjs';

/**
 * Styling progress: GET /api/personalisation-status/<id>
 *
 * What the builder polls between dropping a photo in and being able to check
 * out, and what a Studio reviewer sees per panel.
 *
 * Same access control as personalisation-proof: the unguessable id IS the
 * control, so anything that is not exactly a pp- id is refused before Sanity
 * is touched, and a malformed id and an unknown one are indistinguishable from
 * outside. Nothing here reveals a photograph -- only per-panel state -- but the
 * response still says which panels exist, so it gets the same treatment.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

const PRIVATE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
};

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: PRIVATE });

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: PRIVATE });
  }

  // /api/personalisation-status/<id> arrives as
  // /.netlify/functions/personalisation-status/<id>
  const { pathname, searchParams } = new URL(req.url);
  const last = pathname.split('/').filter(Boolean).pop();
  const id = isId(last) ? last : (isId(searchParams.get('id')) ? searchParams.get('id') : null);
  if (!id) {
    console.log(`personalisation-status: refusing "${pathname}" — not a well-formed id`);
    return notFound();
  }

  try {
    let doc = await sanity.fetch(
      '*[_id == $id][0]{ _id, _rev, photos, styleSize, styleCalls, templateId, guardKey, origin }', { id }
    );
    if (!doc) return notFound();

    /* The poll is where a paused photograph comes back to life for a customer
       who is still watching. Nothing is read from the counter store unless this
       document actually has something paused, so the ordinary poll -- three
       seconds apart, for the whole time a strip is styling -- costs exactly
       what it did before.

       The hourly sweep in style-resume covers everyone who closed the tab; this
       is the path that gets the waiting customer moving within one poll of the
       breaker reopening rather than within the hour. */
    if (pausedRows(doc).length) {
      const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
      try {
        const { resumed } = await resumeDocument({ sanity, doc, origin });
        if (resumed) {
          doc = await sanity.fetch(
            '*[_id == $id][0]{ _id, _rev, photos, styleSize, styleCalls, templateId, guardKey, origin }', { id }
          ) || doc;
        }
      } catch (err) {
        // A resume that fails leaves the panels paused and reports them as
        // such; the sweep will try again. Never fatal to a status poll.
        console.warn(`personalisation-status: could not resume ${id}: ${err.message}`);
      }
    }

    const photos = (doc.photos || []).map((p) => ({
      panel: p.panel,
      styleStatus: p.styleStatus || 'pending',
      styleError: p.styleError || null,
      styledWidth: p.styledWidth ?? null,
      styledHeight: p.styledHeight ?? null,
      /* The builder records this in the recipe, so the brief says exactly which
         blob its measurements came from. Given out rather than derived from the
         panel name: a key the client guesses by convention is a key that goes
         quietly wrong the day the convention changes. It discloses nothing --
         the bytes still come from /api/personalisation-photo, which checks the
         id and the panel's status before it reads anything. */
      styledKey: p.styledKey || null,
      /* Cover-only, and absent is normal everywhere else. cutoutError present
         with no cutoutKey means the cover prints from the styled image -- the
         builder treats that as settled, not as something to wait for. */
      cutoutKey: p.cutoutKey || null,
      cutoutWidth: p.cutoutWidth ?? null,
      cutoutHeight: p.cutoutHeight ?? null,
      cutoutError: p.cutoutError || null,
    }));

    /* allDone is false for a document with no photos yet. "Nothing to do" and
       "everything is finished" look the same to a vacuous truth, and the
       builder would take it as permission to check out an empty build. */
    const body = {
      photos,
      allDone: photos.length > 0 && photos.every((p) => p.styleStatus === 'done'),
      anyFailed: photos.some((p) => p.styleStatus === 'failed'),
      styleSize: doc.styleSize || null,
      styleCalls: doc.styleCalls || 0,
      /* The cap itself, so the builder can say "this design has reached its
         limit" from the numbers rather than from a constant copied into the
         bundle and left to drift. */
      styleMax: MAX_STYLE_CALLS,
      /* Waiting on the site-wide breaker rather than on the model. The builder
         shows this message on those panels and keeps its gate shut; the wording
         lives on the server so the panel, the Studio row and the email all say
         the same thing. */
      paused: photos.filter((p) => p.styleStatus === PAUSED).length,
      /* Which budget paused it decides the wording: a customer is told the shop
         is busy, the Studio is told which ceiling to raise. */
      busyMessage: busyMessageFor(doc.origin),
      templateId: doc.templateId || null,
      /* Whether a cutout is coming at all. Without this the builder cannot tell
         "not ready yet" from "this deployment has no cutout service", and its
         Add to basket gate would wait for ever on the second one. */
      cutoutEnabled: cutoutConfigured(),
    };
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers: PRIVATE });
  } catch (err) {
    console.error(`personalisation-status: could not read ${id}:`, err.message);
    return notFound();
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml, which carries the id through as a
// trailing path segment. An inline config.path collides with it and 404s.
