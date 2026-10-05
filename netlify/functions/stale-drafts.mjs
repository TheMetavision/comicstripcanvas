import { createClient } from '@sanity/client';
import { runStaleDraftCheck } from './_shared/stale-drafts.mjs';

/**
 * Daily: email the team about any order or build draft untouched for over
 * 24 hours. Nothing is sent on a day with none. The rule and the email are in
 * _shared/stale-drafts.mjs.
 *
 * A token is required: drafts are never readable anonymously, and the orders
 * and builds are at dotted ids besides.
 */
const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: 'raw',
});

export default async () => {
  const result = await runStaleDraftCheck({ sanity });
  return new Response(JSON.stringify({ found: result.found, sent: result.sent, reason: result.reason || null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// NOTE: deliberately NO `export const config` -- the schedule is in netlify.toml
// ([functions."stale-drafts"]), like retention and style-resume. An inline
// config.path collides with the forced /api/* rewrite and 404s.
