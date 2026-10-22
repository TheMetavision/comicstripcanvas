/**
 * netlify/functions/_shared/content-build.mjs
 *
 * Publishing content in Studio rebuilds the site — once per burst of edits.
 * Ported from Pixel8 via Wyrmfuel (same file name there); the timing rules are identical.
 *
 *   Sanity webhook ──► /api/sanity-content-changed  (signature checked)
 *                        records the change in Blobs "content-build"
 *                        and, if no waiter is running, starts one
 *                      /api/content-build-background  (the waiter)
 *                        waits for the edits to settle, then POSTs the
 *                        Netlify build hook (NETLIFY_BUILD_HOOK_URL)
 *
 * When the waiter builds (decide()):
 *   - QUIET_MS after the LAST change (trailing edge: the last change always
 *     builds), but
 *   - never sooner than MIN_GAP_MS after the previous build, and
 *   - no later than MAX_WAIT_MS after the first unbuilt change, so a script
 *     patching for half an hour still gets a build every ~10 minutes.
 *
 * Why not point Sanity straight at the build hook (as before): Sanity sends
 * one webhook per document, so a script (or a run of
 * studio-save product writes) starts one build per document. Here the
 * request is signed, the hook URL lives in one env var, and a burst makes one
 * build (two if it outlasts MAX_WAIT_MS).
 *
 * State (one JSON blob, conditional writes on its ETag so the webhook and the
 * waiter never overwrite each other's news):
 *   { pending, firstPendingAt, lastChangeAt, changes, types[], lastBuildAt,
 *     armedAt, buildFailures }
 * Times are ms since the epoch. No document ids or content: types only.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Customer / operational types. Never a build, whatever the webhook's filter
 * says. Unlike Pixel8 this is a blocklist, matching the Sanity webhook's
 * filter: any other published type is assumed to be read at build time.
 */
export const NEVER_BUILD = ['contactSubmission', 'order', 'orderCounter', 'pendingPersonalisation', 'artworkChange'];
/** Sanity's own documents (assets, AI Assist status, …) and system docs. */
export const NEVER_BUILD_PREFIXES = ['sanity.', 'system.'];

/** The Sanity webhook's filter, kept here so the test can check the two agree. */
export const WEBHOOK_FILTER =
  `!(_type match "sanity.*") && !(_type match "system.*") && !(_type in [${NEVER_BUILD.map((t) => `"${t}"`).join(',')}])`;

/** The webhook's projection: what changed, never its content. */
export const WEBHOOK_PROJECTION =
  '{"_id": coalesce(after()._id, before()._id), "_type": coalesce(after()._type, before()._type)}';

export const STATE_STORE = 'content-build';
export const STATE_KEY = 'state';

/** The waiter's path (netlify.toml sends /api/* to the function of that name). */
export const WAITER_PATH = '/api/content-build-background';
export const INTERNAL_HEADER = 'x-content-build-key';

export const QUIET_MS = 60 * 1000;
export const MIN_GAP_MS = 5 * 60 * 1000;
export const MAX_WAIT_MS = 10 * 60 * 1000;
/** A waiter armed longer ago than this is presumed dead (background limit 15 min). */
export const ARM_STALE_MS = 16 * 60 * 1000;
/** The waiter hands over to a fresh one before its 15-minute limit. */
export const WAITER_BUDGET_MS = 12 * 60 * 1000;
/** Re-read the state at least this often while waiting. */
export const POLL_MS = 20 * 1000;
export const MAX_BUILD_FAILURES = 3;

const EMPTY = { pending: false, firstPendingAt: 0, lastChangeAt: 0, changes: 0, types: [], lastBuildAt: 0, armedAt: 0, buildFailures: 0 };

/**
 * What the waiter should do now. Pure.
 * @returns {{ action: 'idle' } | { action: 'build' } | { action: 'wait', ms: number }}
 */
export function decide(state, now) {
  const s = { ...EMPTY, ...state };
  if (!s.pending) return { action: 'idle' };
  const gapOk = s.lastBuildAt + MIN_GAP_MS;
  const settled = Math.max(s.lastChangeAt + QUIET_MS, gapOk);
  const deadline = Math.max(s.firstPendingAt + MAX_WAIT_MS, gapOk);
  const due = Math.min(settled, deadline);
  return now >= due ? { action: 'build' } : { action: 'wait', ms: due - now };
}

/** Is this webhook payload something to build for? Pure. */
export function classify(payload) {
  const id = typeof payload?._id === 'string' ? payload._id : '';
  const type = typeof payload?._type === 'string' ? payload._type : '';
  if (id.startsWith('drafts.') || id.startsWith('versions.')) return { build: false, reason: 'draft or version' };
  if (type && NEVER_BUILD_PREFIXES.some((p) => type.startsWith(p))) return { build: false, reason: `system type ${type}` };
  if (type && NEVER_BUILD.includes(type)) return { build: false, reason: `operational type ${type}` };
  // No _type: the signed request came through the filter (a delete whose
  // projection lost its type still counts).
  return { build: true, type: type || 'unknown' };
}

/** Constant-time check of the internal header against CONTENT_BUILD_INTERNAL_KEY. */
export function isInternal(req, key) {
  if (!key) return false;
  const digest = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(req.headers.get(INTERNAL_HEADER) || ''), digest(key));
}

/**
 * Where to start the waiter: this site's own functions. A request that came
 * in on localhost (netlify dev) stays on this machine; otherwise Netlify's
 * URL env var (the site's main address).
 */
export function waiterUrl(req, siteUrl) {
  const here = new URL(req.url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(here.hostname);
  return `${local || !siteUrl ? here.origin : siteUrl.replace(/\/$/, '')}${WAITER_PATH}`;
}

/**
 * POST the waiter. A background function answers 202 as soon as it is
 * queued. Never throws: { ok, status?, error? }.
 */
export async function startWaiter(url, key, { timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [INTERNAL_HEADER]: key },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'timed out' : err?.message };
  }
}

async function read(store) {
  const r = await store.getWithMetadata(STATE_KEY, { type: 'json' });
  return r ? { state: { ...EMPTY, ...r.data }, etag: r.etag } : { state: { ...EMPTY }, etag: null };
}

/** Read-modify-write with the ETag; retried if someone else wrote first. */
async function update(store, fn, { tries = 8 } = {}) {
  for (let i = 0; i < tries; i++) {
    const { state, etag } = await read(store);
    const out = fn(state);
    if (!out) return { state, changed: false };
    const next = { ...state, ...out.state };
    const res = await store.setJSON(STATE_KEY, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res?.modified !== false) return { state: next, changed: true, ...out.extra };
  }
  throw new Error('content-build: state kept changing under us');
}

/**
 * The webhook half: note one change, and say whether a waiter must be started
 * (none armed, or the armed one is presumed dead).
 * @returns {{ arm: boolean, state }}
 */
export async function recordChange(store, { now, type }) {
  const r = await update(store, (s) => {
    const arm = !s.armedAt || now - s.armedAt >= ARM_STALE_MS;
    const types = s.types.includes(type) || s.types.length >= 10 ? s.types : [...s.types, type];
    return {
      state: {
        pending: true,
        firstPendingAt: s.pending ? s.firstPendingAt : now,
        lastChangeAt: now,
        changes: (s.pending ? s.changes : 0) + 1,
        types: s.pending ? types : [type],
        ...(arm ? { armedAt: now } : {}),
      },
      extra: { arm },
    };
  });
  return { arm: r.arm, state: r.state };
}

/** The webhook couldn't start the waiter: disarm, so the next change (or Sanity's retry) tries again. */
export async function disarm(store, armedAt) {
  await update(store, (s) => (s.armedAt === armedAt ? { state: { armedAt: 0 } } : null));
}

/** Deploy-list title for the build: counts and types, nothing else. */
export const buildTitle = (s) =>
  `Sanity: ${s.changes} change${s.changes === 1 ? '' : 's'} (${(s.types || []).join(', ') || 'content'})`;

/**
 * The waiter. Loops until there's nothing left to build, then disarms.
 *
 * deps: store, now(), sleep(ms), triggerBuild(title) → { ok, status?, error? },
 *       rearm() → Promise<{ ok }> (start a fresh waiter), log(msg)
 * @returns {{ builds: number, outcome: 'idle'|'handed-over'|'gave-up' }}
 */
export async function runWaiter(deps) {
  const { store, now, sleep, triggerBuild, rearm, log = () => {} } = deps;
  const started = now();
  let builds = 0;
  for (;;) {
    const { state } = await read(store);
    const d = decide(state, now());

    if (d.action === 'idle') {
      // Disarm only if nothing arrived since: pending is still false.
      const r = await update(store, (s) => (s.pending ? null : { state: { armedAt: 0 } }));
      if (r.changed || !r.state.pending) return { builds, outcome: 'idle' };
      continue;
    }

    if (now() - started >= WAITER_BUDGET_MS) {
      const at = now();
      await update(store, () => ({ state: { armedAt: at } }));
      const r = await rearm();
      if (!r?.ok) await disarm(store, at);
      log(`content-build: handing over to a fresh waiter (${r?.ok ? 'started' : 'FAILED — next change will re-arm'})`);
      return { builds, outcome: 'handed-over' };
    }

    if (d.action === 'wait') {
      await sleep(Math.min(d.ms, POLL_MS));
      continue;
    }

    // Build. Snapshot what this build covers; anything later stays pending.
    const covered = state.lastChangeAt;
    const res = await triggerBuild(buildTitle(state));
    if (!res?.ok) {
      const failures = state.buildFailures + 1;
      log(`content-build: BUILD HOOK FAILED (${res?.error || res?.status || 'unknown'}), attempt ${failures}/${MAX_BUILD_FAILURES}`);
      if (failures >= MAX_BUILD_FAILURES) {
        await update(store, () => ({ state: { buildFailures: 0, armedAt: 0 } }));
        return { builds, outcome: 'gave-up' };
      }
      await update(store, () => ({ state: { buildFailures: failures } }));
      await sleep(QUIET_MS);
      continue;
    }
    builds++;
    const at = now();
    await update(store, (s) => ({
      state: s.lastChangeAt > covered
        // Changes arrived during the build call: keep them pending, counted from now.
        ? { lastBuildAt: at, buildFailures: 0, firstPendingAt: at, changes: Math.max(1, s.changes - state.changes) }
        : { lastBuildAt: at, buildFailures: 0, pending: false, changes: 0, types: [] },
    }));
    log(`content-build: build triggered — ${buildTitle(state)}`);
  }
}
