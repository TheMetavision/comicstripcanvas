/**
 * The GA4 purchase the Stripe webhook sends through the Measurement Protocol.
 *
 *   node tools/builder/ga4-mp-tests.mjs
 *
 * What must hold: nothing is sent without consent (no ga_client_id), without
 * both env vars, or for a test-mode session; a failure of any kind comes back
 * as a value and never as a throw, because analytics must not fail an order;
 * and the value is what was charged for the goods, not including postage.
 */
import { sendPurchase, buildPurchasePayload, itemsFromLineItems, GA_CLIENT_ID_RE, GA_SESSION_ID_RE }
  from '../../netlify/functions/_shared/ga4-mp.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const ENV = { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret' };
const session = (over = {}) => ({
  id: 'cs_live_abc',
  livemode: true,
  amount_total: 3694,                       // £31.99 of goods (LINES below) + £4.95 postage
  shipping_cost: { amount_total: 495 },
  total_details: { amount_tax: 0, amount_shipping: 495, amount_discount: 0 },
  metadata: { ga_client_id: '1234567890.1700000000', ga_session_id: '1700000123' },
  ...over,
});
// 1 × £16.99 poster + 1 × £15.00 (a £17.00 line with £2.00 off) = £31.99 of goods
const LINES = [
  {
    quantity: 1, amount_subtotal: 1699, amount_discount: 0, amount_total: 1699,
    price: { unit_amount: 1699, product: { id: 'prod_1', name: 'Ali', metadata: { slug: 'ali', format: 'poster', size: 'large', artworkStyle: 'classic' } } },
  },
  {
    quantity: 2, amount_subtotal: 1700, amount_discount: 200, amount_total: 1500,
    price: { unit_amount: 850, product: { id: 'prod_2', name: 'Your cover', metadata: { slug: 'personalised-book-covers', format: 'poster', size: 'small', personalisationId: 'pp-x', buildKind: 'customise' } } },
  },
];
// amount_total = 1699 + 1500 + 495 postage
const S = () => session({ amount_total: 3694 });

/** A fetch that records what it was asked and answers as told. */
const fakeFetch = (respond = () => ({ ok: true, status: 204 })) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  fn.calls = calls;
  return fn;
};

say('\n1. SKIPS WITHOUT SENDING\n');
{
  for (const [label, env] of [
    ['no GA4_MEASUREMENT_ID', { GA4_API_SECRET: 'secret' }],
    ['no GA4_API_SECRET', { GA4_MEASUREMENT_ID: 'G-TEST123' }],
    ['neither env var', {}],
  ]) {
    const f = fakeFetch();
    const r = await sendPurchase({ session: S(), orderNumber: 'CSC-1', lineItems: LINES, env, fetch: f });
    ok(!r.sent && r.skipped === 'not-configured' && f.calls.length === 0, label, JSON.stringify(r));
  }

  for (const [label, meta] of [
    ['no metadata at all', undefined],
    ['no ga_client_id (visitor did not accept)', {}],
    ['a client id that is not the _ga shape', { ga_client_id: 'GA1.1.123.456' }],
    ['an empty client id', { ga_client_id: '' }],
  ]) {
    const f = fakeFetch();
    const r = await sendPurchase({ session: session({ metadata: meta }), orderNumber: 'CSC-1', lineItems: LINES, env: ENV, fetch: f });
    ok(!r.sent && r.skipped === 'no-client-id' && f.calls.length === 0, label, JSON.stringify(r));
  }

  for (const [label, livemode] of [['livemode false', false], ['livemode absent', undefined]]) {
    const f = fakeFetch();
    const r = await sendPurchase({ session: session({ livemode }), orderNumber: 'CSC-1', lineItems: LINES, env: ENV, fetch: f });
    ok(!r.sent && r.skipped === 'test-mode' && f.calls.length === 0, `${label} (test mode)`, JSON.stringify(r));
  }
}

say('\n2. NEVER THROWS\n');
{
  const cases = [
    ['fetch rejects (network down)', async () => { throw new Error('fetch failed'); }],
    ['fetch times out', async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }],
    ['Google answers 500', async () => ({ ok: false, status: 500 })],
    ['fetch throws synchronously', () => { throw new TypeError('boom'); }],
  ];
  for (const [label, fn] of cases) {
    let threw = false, r;
    try { r = await sendPurchase({ session: S(), orderNumber: 'CSC-1', lineItems: LINES, env: ENV, fetch: fn }); }
    catch { threw = true; }
    ok(!threw && r && r.sent === false && typeof r.error === 'string', label, JSON.stringify(r));
  }
  let threw = false, r;
  try { r = await sendPurchase({ session: null, env: ENV, fetch: fakeFetch() }); } catch { threw = true; }
  ok(!threw && r && r.sent === false, 'a null session is a skip, not a crash', JSON.stringify(r));
  threw = false;
  try { r = await sendPurchase({ session: session({ amount_total: undefined, shipping_cost: undefined, total_details: undefined }), lineItems: [{}, null].filter(Boolean), env: ENV, fetch: fakeFetch() }); }
  catch { threw = true; }
  ok(!threw && r.sent === true, 'a session missing its totals still sends rather than crashing', JSON.stringify(r));

  // The timeout is real: a fetch that never answers is abandoned.
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  // AbortSignal.timeout's timer is unref'd, so hold the event loop open here
  // the way an in-flight webhook request does in production.
  const keepAlive = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  r = await sendPurchase({ session: S(), orderNumber: 'CSC-1', lineItems: LINES, env: ENV, fetch: hang, timeoutMs: 50 });
  clearTimeout(keepAlive);
  ok(!r.sent && r.error && Date.now() - t0 < 1000, 'a hung request is abandoned at the timeout', `${Date.now() - t0} ms, ${r.error}`);
}

say('\n3. WHAT IS SENT\n');
{
  const f = fakeFetch();
  const r = await sendPurchase({ session: S(), orderNumber: 'CSC-1042', lineItems: LINES, env: ENV, fetch: f });
  ok(r.sent === true && f.calls.length === 1, 'a consented live purchase is sent once');
  const { url, init } = f.calls[0];
  ok(url.startsWith('https://www.google-analytics.com/mp/collect?')
    && url.includes('measurement_id=G-TEST123') && url.includes('api_secret=secret'),
    'to the MP endpoint with the id and secret from the environment');
  ok(init.method === 'POST' && init.signal instanceof AbortSignal, 'POSTed with an abort signal');

  const body = JSON.parse(init.body);
  const p = body.events[0].params;
  ok(body.client_id === '1234567890.1700000000', 'client_id is the one stored at checkout');
  ok(body.events[0].name === 'purchase', 'event is purchase');
  ok(p.transaction_id === 'CSC-1042', 'transaction_id is the order number');
  ok(p.currency === 'GBP', 'currency GBP');
  ok(p.value === 31.99, 'value excludes postage: £36.94 charged − £4.95 = £31.99', String(p.value));
  ok(p.shipping === 4.95, 'postage in its own field', String(p.shipping));
  ok(p.tax === 0, 'tax in its own field', String(p.tax));
  ok(body.consent?.ad_user_data === 'DENIED' && body.consent?.ad_personalization === 'DENIED',
    'ads signals sent as denied, matching the browser consent default');
  ok(!/@|Customer|line1|postcode/i.test(init.body), 'no name, email or address in the payload');

  const free = buildPurchasePayload({ session: session({ amount_total: 5200, shipping_cost: { amount_total: 0 } }), orderNumber: 'CSC-2', lineItems: [], clientId: '1.2' });
  ok(free.events[0].params.value === 52 && free.events[0].params.shipping === 0, 'free postage: value is the whole total');

  const fallback = buildPurchasePayload({ session: session({ amount_total: 1494, shipping_cost: undefined, total_details: { amount_shipping: 495 } }), lineItems: [], clientId: '1.2' });
  ok(fallback.events[0].params.value === 9.99, 'postage read from total_details when shipping_cost is absent', String(fallback.events[0].params.value));
  ok(fallback.events[0].params.transaction_id === 'cs_live_abc', 'no order number: falls back to the session id');
}

say('\n4. ITEMS\n');
{
  const [a, b] = itemsFromLineItems(LINES);
  ok(a.item_id === 'ali' && a.item_name === 'Ali' && a.price === 16.99 && a.quantity === 1 && !('discount' in a),
    'a full-price line: unit price as charged, no discount field', JSON.stringify(a));
  ok(a.item_variant === 'poster / large / classic' && a.item_category === 'stock', 'variant and category', JSON.stringify(a));
  ok(b.price === 7.5 && b.discount === 1 && b.quantity === 2,
    'a discounted line: price after discount per unit, discount share per unit', JSON.stringify(b));
  ok(b.item_category === 'personalised' && b.item_category2 === 'customise', 'build kind kept as category2', JSON.stringify(b));
  const sum = Math.round([a, b].reduce((t, i) => t + i.price * i.quantity, 0) * 100) / 100;
  ok(sum === 31.99, 'items add up to the purchase value', String(sum));
  ok(itemsFromLineItems(undefined).length === 0, 'no line items: an empty list, not a crash');
}

say('\n5. CLIENT ID SHAPE\n');
{
  ok(GA_CLIENT_ID_RE.test('1234567890.1700000000'), 'accepts gtag\'s client_id');
  for (const bad of ['GA1.1.1.2', '123', '1.2.3', 'abc.def', ' 1.2', '1.2\n']) ok(!GA_CLIENT_ID_RE.test(bad), `rejects ${JSON.stringify(bad)}`);
}

say('\n6. SESSION ID\n');
{
  const sent = async (meta) => {
    const f = fakeFetch();
    const r = await sendPurchase({ session: session({ metadata: meta }), orderNumber: 'CSC-7', lineItems: LINES, env: ENV, fetch: f });
    return { r, params: f.calls[0] ? JSON.parse(f.calls[0].init.body).events[0].params : null };
  };

  let { r, params } = await sent({ ga_client_id: '1.2', ga_session_id: '1700000123' });
  ok(r.sent && params.session_id === '1700000123', 'session_id from the checkout metadata is in the purchase params', params?.session_id);
  ok(params.engagement_time_msec === 1, 'engagement_time_msec: 1 alongside it', String(params?.engagement_time_msec));

  ({ r, params } = await sent({ ga_client_id: '1.2' }));
  ok(r.sent && params && !('session_id' in params), 'no ga_session_id: the purchase is still sent, without session_id');
  ok(params.engagement_time_msec === 1, '  and still with engagement_time_msec: 1');

  for (const bad of ['17000.00123', 'abc', '', ' 1700000123', '1700000123x']) {
    ({ r, params } = await sent({ ga_client_id: '1.2', ga_session_id: bad }));
    ok(r.sent && params && !('session_id' in params), `a malformed session id ${JSON.stringify(bad)} is dropped, not sent`);
  }

  // A session id never rescues a missing client id: no consent, no send.
  ({ r, params } = await sent({ ga_session_id: '1700000123' }));
  ok(!r.sent && r.skipped === 'no-client-id' && params === null, 'a session id without a client id sends nothing');

  const direct = buildPurchasePayload({ session: session(), lineItems: [], clientId: '1.2', sessionId: '42' });
  ok(direct.events[0].params.session_id === '42', 'buildPurchasePayload takes sessionId directly');

  ok(GA_SESSION_ID_RE.test('1700000123'), 'session id shape: digits accepted');
  for (const bad of ['1.2', '-1', '1e9', '12 ', '1700000123\n', '']) ok(!GA_SESSION_ID_RE.test(bad), `session id shape rejects ${JSON.stringify(bad)}`);
}

say(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
