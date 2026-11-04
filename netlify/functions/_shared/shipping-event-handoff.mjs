/**
 * Fast reply for shipping-service tracking callbacks.
 *
 * metavision-shipping posts each tracking event to /api/shipping-event and
 * wants a 2xx within 4 seconds. The work an event triggers (Sanity writes, the
 * dispatch email, the referral code in Stripe, MailerLite) can take longer on
 * a first carrier scan, so shipping-event only checks the event and hands it,
 * unchanged, to shipping-event-background:
 *
 *   shipping-event (synchronous)
 *     - bad signature           -> 401, nothing started
 *     - SHIPPING_ENABLED off    -> 503 (the service keeps it and retries)
 *     - not JSON / unknown kind -> 400 / 200 ignored, nothing started
 *     - otherwise POSTs the SAME raw body and the service's x-mv-* signature
 *       headers to the background function (awaited: the environment freezes
 *       on return), plus an internal key, and answers 200 once that start is
 *       accepted; if the start fails, 503 so the service retries.
 *
 *   shipping-event-background (15-minute budget)
 *     - needs the internal key AND the service's signature over the body,
 *       with a 15-minute freshness window instead of 5 (Netlify re-runs a
 *       failed background function about 1 and 3 minutes later);
 *     - then does exactly what shipping-event used to do. Every step there is
 *       once-only (event keys, the dispatch-email claim, postDeliveryStartedAt),
 *       so a repeat is harmless.
 *     - an outcome that used to answer 5xx (e.g. the dispatch email failed)
 *       is returned with retry: true; the function throws on it so Netlify
 *       retries, and the next tracking event re-checks the email anyway.
 *
 * Identical in every brand repo that takes shipping events.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { shippingEnabled, verifyShippingCallback } from './shipping-client.mjs';

export const EVENT_BACKGROUND_FUNCTION = 'shipping-event-background';
export const EVENT_HANDOFF_HEADER = 'x-mv-event-handoff';
export const SIGNATURE_HEADERS = ['x-mv-brand', 'x-mv-timestamp', 'x-mv-signature'];
export const BACKGROUND_MAX_SKEW_SECONDS = 15 * 60;
export const START_TIMEOUT_MS = 3000;

/** Key the fast function shows the background one; null without SHIPPING_SECRET. */
export function eventHandoffKey(env = process.env) {
  const secret = env.SHIPPING_SECRET;
  return secret ? createHmac('sha256', secret).update('shipping-event-background').digest('hex').slice(0, 48) : null;
}

export function isEventHandoff(req, env = process.env) {
  const want = eventHandoffKey(env);
  if (!want) return false;
  const a = Buffer.from(String(req.headers.get(EVENT_HANDOFF_HEADER) || ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Where the background function is: same origin under netlify dev, the site's
 * main URL live (Netlify sets URL), else the origin the event arrived on.
 * `path` defaults to /.netlify/functions/<name>; a repo that routes its
 * background functions elsewhere passes its own.
 */
export function backgroundUrl(req, { env = process.env, path = `/.netlify/functions/${EVENT_BACKGROUND_FUNCTION}` } = {}) {
  const here = new URL(req.url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(here.hostname);
  const base = local ? here.origin : String(env.URL || here.origin).replace(/\/+$/, '');
  return `${base}${path}`;
}

/** POST the unchanged body + signature to the background function. Never throws. */
export async function startEventBackground(req, rawBody, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = START_TIMEOUT_MS, path } = {}) {
  const key = eventHandoffKey(env);
  if (!key) return { ok: false, error: 'SHIPPING_SECRET is not set' };
  const headers = { 'Content-Type': 'application/json', [EVENT_HANDOFF_HEADER]: key };
  for (const h of SIGNATURE_HEADERS) headers[h] = req.headers.get(h) || '';
  try {
    const res = await fetchImpl(backgroundUrl(req, { env, path }), {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'timed out' : (err?.message || String(err)) };
  }
}

const KINDS = new Set(['parcel', 'return']);

/**
 * shipping-event: check, hand off, reply. Returns { status, body }.
 * `start` is startEventBackground (tests pass a fake).
 */
export async function acceptShippingEvent(req, { env = process.env, now = Date.now(), start = startEventBackground, path, log = console } = {}) {
  if (req.method !== 'POST') return { status: 405, body: 'Method not allowed' };
  const rawBody = await req.text();
  if (!verifyShippingCallback(req, rawBody, { env, now })) return { status: 401, body: 'Invalid signature' };
  if (!shippingEnabled(env)) return { status: 503, body: 'Shipping is not enabled here yet — retry later' };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON' }; }
  if (!KINDS.has(event?.kind)) return { status: 200, body: 'Unknown kind — ignored' };
  const started = await start(req, rawBody, { env, path });
  if (!started.ok) {
    log.error(`shipping-event: background not started (${started.error}); asking the service to retry`);
    return { status: 503, body: 'Could not start processing — retry later' };
  }
  return { status: 200, body: 'Accepted' };
}

/**
 * shipping-event-background: re-check, then the existing work.
 * `apply(event)` returns { status, body } exactly as shipping-event used to
 * answer. Returns { status, body, retry }.
 */
export async function runShippingEvent(req, { apply, env = process.env, now = Date.now(), log = console } = {}) {
  if (req.method !== 'POST') return { status: 405, body: 'Method not allowed', retry: false };
  const rawBody = await req.text();
  if (!isEventHandoff(req, env)) {
    log.warn('shipping-event-background: request without the handoff key — ignored');
    return { status: 403, body: 'Forbidden', retry: false };
  }
  if (!verifyShippingCallback(req, rawBody, { env, now, maxSkewSeconds: BACKGROUND_MAX_SKEW_SECONDS })) {
    log.warn('shipping-event-background: signature check failed — ignored');
    return { status: 401, body: 'Invalid signature', retry: false };
  }
  if (!shippingEnabled(env)) return { status: 200, body: 'Shipping is not enabled — ignored', retry: false };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON', retry: false }; }
  if (!KINDS.has(event?.kind)) return { status: 200, body: 'Unknown kind — ignored', retry: false };
  const r = await apply(event);
  return { ...r, retry: r.status >= 500 };
}
