/**
 * Calls the metavision-shipping service (Sendcloud labels, returns, tracking).
 *
 * The request signing is the helper from the service's README, unchanged in
 * what it sends: x-mv-brand, x-mv-timestamp (unix seconds) and x-mv-signature,
 * a hex HMAC-SHA256 of `${timestamp}.${rawBody}` with the brand's secret (an
 * empty body for a GET). The service answers 401 to anything else.
 *
 * Env vars:
 *   SHIPPING_ENABLED     "true" turns the whole Sendcloud flow on. Unset or
 *                        empty, nothing in this file is reached: the order flow,
 *                        emails and Studio views are as they were.
 *   SHIPPING_SECRET      same value as SHIPPING_SECRET_CSC on the service
 *   SHIPPING_API_URL     optional override; the address is committed in
 *                        _shared/site-config.mjs
 *   SHIPPING_BRAND       optional override; "CSC" is committed there too
 *   SHIPPING_TEST_MODE   "true" adds "test": true to create-parcel,
 *                        create-return and quote-return, so the service makes
 *                        a FREE sendcloud:letter label instead of a real one
 *                        (and quotes a band whose sizes are not filled yet).
 *                        For testing only -- leave it unset in production.
 *
 * Secrets are read per call, never logged, never put in an error message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { setting } from './site-config.mjs';

const truthy = (v) => ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());

/** The one switch. Read per request, so changing the env var needs no code. */
export const shippingEnabled = (env = process.env) => truthy(env.SHIPPING_ENABLED);

/** Free test labels instead of real ones. */
export const shippingTestMode = (env = process.env) => truthy(env.SHIPPING_TEST_MODE);

/**
 * { test: true } for an order paid in Stripe test mode (order.test === true),
 * {} for any other. Spread into a create-parcel / create-return body, so a
 * test-mode order always gets the service's free void label, even once
 * SHIPPING_TEST_MODE is off in production. The service honours it only for
 * brands in its SHIPPING_TEST_BRANDS and answers 403 (nothing bought) for any
 * other. A live order is never affected. Not sent on quote-return: a quote
 * buys nothing.
 */
export const testOrderFlag = (order) => (order && order.test === true ? { test: true } : {});

export function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** The bodies that buy (or quote) a label. Only these carry the test flag. */
const TESTABLE = new Set(['create-parcel', 'create-return', 'quote-return']);

export class ShippingServiceError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message);
    this.name = 'ShippingServiceError';
    this.code = code || 'service_error';
    this.status = status || 0;
    this.details = details;
  }
}

/**
 * One signed call. Resolves with the parsed JSON (or a Buffer for the label
 * PDF); rejects with ShippingServiceError carrying the service's error code.
 *
 * @param {string} path  e.g. 'create-parcel' or `label?labelId=123`
 * @param {object} [opts]
 * @param {'GET'|'POST'} [opts.method]
 * @param {object} [opts.body]
 * @param {object} [opts.env]        defaults to process.env (tests pass their own)
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.now]        ms, for tests
 */
export async function shippingRequest(path, { method = 'POST', body, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const base = setting('SHIPPING_API_URL', env).replace(/\/+$/, '');
  const brand = setting('SHIPPING_BRAND', env);
  if (!env.SHIPPING_SECRET) {
    throw new ShippingServiceError('SHIPPING_SECRET is not set', { code: 'not_configured' });
  }
  const name = path.split('?')[0];
  let payload = body;
  if (method !== 'GET' && TESTABLE.has(name) && shippingTestMode(env)) {
    payload = { ...(body || {}), test: true };
  }
  const rawBody = method === 'GET' || payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));

  let res;
  try {
    res = await fetchImpl(`${base}/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-mv-brand': brand,
        'x-mv-timestamp': timestamp,
        'x-mv-signature': sign(env.SHIPPING_SECRET, timestamp, rawBody),
      },
      body: method === 'GET' ? undefined : rawBody,
    });
  } catch (err) {
    throw new ShippingServiceError(`shipping service unreachable: ${err?.message || err}`, { code: 'unreachable' });
  }

  if (name === 'label') {
    if (!res.ok) throw new ShippingServiceError(`label: HTTP ${res.status}`, { code: res.status === 404 ? 'not_found' : 'label_failed', status: res.status });
    return Buffer.from(await res.arrayBuffer());
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON: reported below */ }
  if (!res.ok) {
    throw new ShippingServiceError(json?.error?.message || `HTTP ${res.status}`, {
      code: json?.error?.code || `http_${res.status}`, status: res.status, details: json?.error?.details,
    });
  }
  if (!json) throw new ShippingServiceError(`HTTP ${res.status} with no JSON body`, { code: 'bad_response', status: res.status });
  return json;
}

/**
 * create-parcel / create-return, retried while the service says the same
 * parcel is being created right now (409 in_progress). Anything else is thrown
 * at once: the service is idempotent per orderRef + parcelRef, so the caller
 * may simply run again later.
 */
export async function shippingCreate(path, body, { attempts = 3, delayMs = 2000, sleep, ...opts } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await shippingRequest(path, { ...opts, body });
    } catch (err) {
      if (err?.code !== 'in_progress' || i >= attempts) throw err;
      await wait(delayMs);
    }
  }
}

/**
 * Verify a status callback from the service (read the raw body BEFORE
 * parsing). Same checks as the README helper: fresh timestamp (5 minutes, or
 * maxSkewSeconds for shipping-event-background), our
 * brand, and a constant-time signature comparison.
 */
export function verifyShippingCallback(request, rawBody, { env = process.env, now = Date.now(), maxSkewSeconds = 300 } = {}) {
  const secret = env.SHIPPING_SECRET;
  const ourBrand = setting('SHIPPING_BRAND', env);
  if (!secret) return false;
  const timestamp = request.headers.get('x-mv-timestamp') || '';
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const fresh = Math.abs(now / 1000 - Number(timestamp)) <= maxSkewSeconds;
  const brand = (request.headers.get('x-mv-brand') || '').toLowerCase();
  const given = Buffer.from(request.headers.get('x-mv-signature') || '');
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  return fresh && brand === ourBrand.toLowerCase()
    && given.length === expected.length && timingSafeEqual(given, expected);
}

/** An amount in pounds, to the penny, or null if it is not a GBP number. */
function pounds(amount, currency) {
  const v = Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(v)) return null;
  if (currency && String(currency).toUpperCase() !== 'GBP') return null;
  return Math.round(v * 100) / 100;
}

/**
 * The price create-parcel / create-return quoted, in pounds, or null. The
 * service sends quotedPrice as {amount, currency}; in test mode it is the
 * price of the option real routing would have chosen, not the free letter.
 */
export const quotedPounds = (result) => pounds(result?.quotedPrice?.amount, result?.quotedPrice?.currency);

/** The price quote-return gave ({price, currency}), in pounds, or null. */
export const quoteReturnPounds = (result) => pounds(result?.price, result?.currency);
