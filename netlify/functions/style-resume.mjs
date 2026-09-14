import { createClient } from '@sanity/client';
import { resumeAllPaused } from './_shared/style-resume.mjs';

/**
 * Restart photos the circuit breaker paused. Hourly (schedule in netlify.toml).
 *
 * The status poll already resumes a document the customer still has open, which
 * covers the person sitting watching their panel. This covers everyone else:
 * the tab that was closed, the phone that went to sleep, the build abandoned at
 * 11pm whose counter reset at midnight. Without it a paused photo would wait
 * for a poll that is never coming.
 *
 * Hourly rather than daily because the ceiling can be raised by hand --
 * STYLE_DAILY_MAX is read per request, so a breaker opened at lunchtime can be
 * reopened with an environment variable and cleared within the hour, with no
 * deploy. The sweep never spends more than the budget it reads, so running it
 * often is cheap and running it when there is nothing to do costs one query.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A Netlify scheduled invocation, as closely as one can be recognised.
 *
 * The scheduler posts a next_run body AND an X-NF-Event: schedule header (the
 * CLI emulates both, which is where these come from). retention.mjs checks the
 * body alone; this one spends money, so it wants both -- a body is trivially
 * forged by anyone who can reach the forced /api/* rewrite, and asking for the
 * header as well means a forgery has to be deliberate rather than accidental.
 *
 * Neither marker is a secret, so neither is the real defence. That is the
 * budget: resumeAllPaused never spends past a day's ceiling -- STYLE_DAILY_MAX
 * for customer work, STUDIO_STYLE_DAILY_MAX for studio work, counted and spent
 * separately so neither queue can eat into the other's -- nor past a visitor's
 * own 24-hour allowance. So the worst a forged invocation can do is bring work
 * forward that we had already decided to pay for.
 */
const looksScheduled = (req, body) =>
  (req.headers.get('x-nf-event') || '').toLowerCase() === 'schedule' &&
  !!body && typeof body === 'object' && 'next_run' in body;

export default async (req) => {
  if (!process.env.SANITY_WRITE_TOKEN) {
    console.error('style-resume: SANITY_WRITE_TOKEN is not set — refusing to run.');
    return json({ error: 'SANITY_WRITE_TOKEN is not set on this deploy' }, 503);
  }

  const body = await req.json().catch(() => null);
  const scheduled = looksScheduled(req, body);

  /* Netlify does not route scheduled functions publicly, but netlify.toml
     force-rewrites /api/* to /.netlify/functions/, so assume this is reachable
     and require the shared secret for anything that is not the scheduler. This
     one SPENDS MONEY, so a bare GET must not be able to start it. */
  const secret = process.env.PERSONALISATION_ACTION_SECRET;
  const authorised = !!secret && req.headers.get('x-csc-action-secret') === secret;
  if (!scheduled && !authorised) {
    console.warn('style-resume: refused an unauthorised manual invocation');
    return json({ error: 'Not authorised' }, 401);
  }

  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
  try {
    const report = await resumeAllPaused({ sanity, origin });
    return json(report);
  } catch (err) {
    console.error('style-resume: run failed:', err.message);
    return json({ error: err.message }, 500);
  }
};

// NOTE: deliberately NO `export const config = { ... }` here. The schedule is
// declared in netlify.toml like retention's, and an inline config.path would
// collide with the forced /api/* rewrite.
