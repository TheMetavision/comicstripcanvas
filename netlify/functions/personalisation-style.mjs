import { createClient } from '@sanity/client';
import { MAX_STYLE_CALLS } from './_shared/style.mjs';

/**
 * Re-style one panel:
 *   POST /api/personalisation-style/<id>/<panel>?retry=1
 *
 * Used by the builder's per-panel retry, and later by a Studio action. It only
 * re-triggers the background function; the work, the cap accounting and the
 * status writes all stay in one place there.
 *
 * Same guards as personalisation-proof: the unguessable id is the access
 * control, and anything not shaped like a pp- id is refused before Sanity is
 * touched. Note this endpoint SPENDS MONEY, so it also refuses a panel that is
 * already styling (a double tap must not buy two generations) and one that is
 * already done unless retry=1 is explicit.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isPanel = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

const PRIVATE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: PRIVATE });
const notFound = () => reply({ error: 'Not found' }, 404);

export default async (req) => {
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const { pathname, searchParams } = new URL(req.url);
  const segs = pathname.split('/').filter(Boolean);
  let id = null, panel = null;
  if (segs.length >= 2 && isId(segs[segs.length - 2]) && isPanel(segs[segs.length - 1])) {
    id = segs[segs.length - 2];
    panel = segs[segs.length - 1];
  } else if (isId(searchParams.get('id')) && isPanel(searchParams.get('panel'))) {
    id = searchParams.get('id');
    panel = searchParams.get('panel');
  }
  if (!id || !panel) {
    console.log(`personalisation-style: refusing "${pathname}" — not a well-formed id/panel pair`);
    return notFound();
  }
  const retry = searchParams.get('retry') === '1';

  try {
    const doc = await sanity.fetch('*[_id == $id][0]{ photos, styleCalls }', { id });
    if (!doc) return notFound();
    const row = (doc.photos || []).find((p) => p.panel === panel);
    if (!row || !row.rawKey) return notFound();

    if (row.styleStatus === 'styling') {
      return reply({ id, panel, triggered: false, reason: 'already styling' }, 409);
    }
    if (row.styleStatus === 'done' && !retry) {
      return reply({ id, panel, triggered: false, reason: 'already styled; pass retry=1 to redo' }, 409);
    }
    if ((doc.styleCalls || 0) >= MAX_STYLE_CALLS) {
      await sanity
        .patch(id)
        .set({
          [`photos[panel == "${panel}"].styleStatus`]: 'failed',
          [`photos[panel == "${panel}"].styleError`]: 'cap',
        })
        .commit();
      console.warn(`personalisation-style: ${id} ${panel} refused — ${MAX_STYLE_CALLS} calls already used`);
      return reply({ id, panel, triggered: false, reason: 'cap', styleCalls: doc.styleCalls }, 429);
    }

    // Put it back to pending before firing, so a poll between the two sees an
    // honest state rather than the previous 'failed'.
    await sanity
      .patch(id)
      .set({ [`photos[panel == "${panel}"].styleStatus`]: 'pending' })
      .unset([`photos[panel == "${panel}"].styleError`])
      .commit();

    const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
    const res = await fetch(`${origin}/api/style-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, panel }),
    });
    if (!res.ok) {
      console.error(`personalisation-style: trigger for ${id} ${panel} returned ${res.status}`);
      return reply({ id, panel, triggered: false, reason: `trigger returned ${res.status}` }, 502);
    }
    console.log(`personalisation-style: re-styling ${id} ${panel}${retry ? ' (retry)' : ''}`);
    return reply({ id, panel, triggered: true });
  } catch (err) {
    console.error(`personalisation-style: ${id} ${panel} failed:`, err.message);
    return reply({ error: 'Could not trigger styling' }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml. An inline config.path collides with it.
