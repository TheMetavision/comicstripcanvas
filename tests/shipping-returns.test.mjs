// The /returns endpoint and the return label: who may ask, what is stored,
// and the label email with its postage deduction. Turnstile, the rate limiter,
// Sanity, the service and Resend are all fakes.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReturns } from '../netlify/functions/returns.mjs';
import { processReturn } from '../netlify/functions/shipping-return-background.mjs';
import { fakeSanity, fakeResend, quiet } from './fixtures/fake-sanity.mjs';

const NOW = Date.UTC(2026, 9, 25, 12, 0);
const ORDER = {
  _id: 'order.cs_test_returns', _type: 'order', orderNumber: 'CSC-4001', customerName: 'Mary Shelley', customerEmail: 'Mary@Example.com',
  status: 'delivered', shippingEmailSentAt: '2026-10-18T09:00:00Z',
  shippingAddress: { line1: '9 Close', city: 'Bath', postcode: 'BA1 1AA', country: 'GB' },
  shipment: { dispatchedAt: '2026-10-18T09:00:00Z', deliveredAt: '2026-10-20T10:00:00Z' },
  lineItems: [
    { _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 },
    { _key: 'p', productTitle: 'Your Photo', formatKey: 'canvas-gallery', sizeKey: 'large', quantity: 1, unitPrice: 90, buildKind: 'personalised' },
  ],
};

const QUERIES = {
  'orderNumber == \\$n && lower\\(customerEmail\\) == \\$e': (docs, p) =>
    docs.find((d) => d._type === 'order' && d.orderNumber === p.n && d.customerEmail.toLowerCase() === p.e) ?? null,
  '_type == "order" && _id == \\$id': (docs, p) => docs.find((d) => d._id === p.id) ?? null,
  '_type == "returnRequest" && orderId == \\$id': (docs, p) => docs.filter((d) => d._type === 'returnRequest' && d.orderId === p.id),
};

const env = { SHIPPING_ENABLED: 'true', SHIPPING_SECRET: 'sek', TURNSTILE_SECRET_KEY: 'ts' };
const post = (body) => new Request('https://x/api/returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const human = { csc_extra_note: '', csc_extra_confirm: '', csc_ts_load: '1000', csc_ts_submit: '9000' };

function setup({ turnstileOk = true, order = ORDER, quoteResult = { option: 'inpost_gb:l2l/size=m', carrier: 'inpost_gb', price: 2.57, currency: 'GBP' } } = {}) {
  const sanity = fakeSanity([order], { queries: QUERIES });
  const resend = fakeResend();
  const quotes = [];
  const deps = {
    sanity, env, getResend: () => resend, log: quiet, now: () => NOW,
    turnstile: async () => (turnstileOk ? { ok: true } : { ok: false, status: 400, error: 'Anti-spam check failed.' }),
    rateLimit: async () => true,
    quote: async (body) => {
      quotes.push(body);
      if (quoteResult instanceof Error) throw quoteResult;
      return quoteResult;
    },
  };
  return { sanity, resend, quotes, deps };
}

const lookup = async (deps) => (await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', turnstileToken: 't', ...human }), deps)).body;

test('switched off: the endpoint answers 404', async () => {
  const { deps } = setup();
  const r = await handleReturns(post({ action: 'lookup' }), { ...deps, env: {} });
  assert.equal(r.status, 404);
});

test('lookup needs Turnstile, and a wrong email looks exactly like a wrong number', async () => {
  const { deps } = setup({ turnstileOk: false });
  assert.equal((await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', turnstileToken: 't', ...human }), deps)).status, 400);
  const { deps: d2 } = setup();
  assert.equal((await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', ...human }), d2)).status, 400, 'no token');
  const wrongEmail = await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'eve@example.com', turnstileToken: 't', ...human }), d2);
  const wrongNumber = await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-9999', email: 'mary@example.com', turnstileToken: 't', ...human }), d2);
  assert.equal(wrongEmail.status, 404);
  assert.deepEqual(wrongEmail.body, wrongNumber.body);
});

test('honeypot or a 1-second submit: treated as not found', async () => {
  const { deps } = setup();
  const pot = await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', turnstileToken: 't', ...human, csc_extra_note: 'buy now' }), deps);
  assert.equal(pot.status, 404);
  const fast = await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', turnstileToken: 't', ...human, csc_ts_submit: '1500' }), deps);
  assert.equal(fast.status, 404);
});

test('the full customer path: lookup, choose, request stored privately, team emailed', async () => {
  const { sanity, resend, deps } = setup();
  const look = await handleReturns(post({ action: 'lookup', orderNumber: 'csc 4001', email: ' MARY@example.com ', turnstileToken: 't', ...human }), deps);
  assert.equal(look.status, 200);
  assert.equal(look.body.eligible, true);
  assert.equal(look.body.windowEndsOn, '3 November 2026');
  assert.deepEqual(look.body.lines.map((l) => [l.lineKey, l.returnable]), [['a', 1], ['p', 0]]);
  assert.ok(look.body.session);
  assert.equal(JSON.stringify(look.body).includes('BA1 1AA'), false, 'no address is handed back');

  const sub = await handleReturns(post({ action: 'submit', session: look.body.session, lines: [{ lineKey: 'a', quantity: 1 }], reason: 'changed_mind', notes: 'Too big', ...human }), deps);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.returnNumber, 'CSC-4001-R1');
  const doc = [...sanity.store.values()].find((d) => d._type === 'returnRequest');
  assert.match(doc._id, /^returnRequest\.ret-[0-9a-f]{16}$/, 'a dotted, private id');
  assert.equal(doc.status, 'requested');
  assert.equal(doc.band, 'P3', 'one item: its band is filled in');
  assert.equal(doc.freeLabel, false);
  assert.equal(doc.deliveryDateUnknown, false);
  assert.equal(doc.lines[0].unitPrice, 25);
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subject, /Return request CSC-4001-R1/);

  // The same line cannot be asked for twice.
  const again = await handleReturns(post({ action: 'submit', session: look.body.session, lines: [{ lineKey: 'a', quantity: 1 }], reason: 'changed_mind', ...human }), deps);
  assert.equal(again.status, 400);
});

test('a personalised line cannot be submitted, whatever the page sends', async () => {
  const { deps } = setup();
  const look = await handleReturns(post({ action: 'lookup', orderNumber: 'CSC-4001', email: 'mary@example.com', turnstileToken: 't', ...human }), deps);
  const sub = await handleReturns(post({ action: 'submit', session: look.body.session, lines: [{ lineKey: 'p', quantity: 1 }], reason: 'changed_mind', ...human }), deps);
  assert.equal(sub.status, 400);
  assert.match(sub.body.error, /can't be returned/);
});

test('a forged or expired session is refused', async () => {
  const { deps } = setup();
  const sub = await handleReturns(post({ action: 'submit', session: 'abc.def', lines: [{ lineKey: 'a', quantity: 1 }], reason: 'changed_mind', ...human }), deps);
  assert.equal(sub.status, 400);
  assert.match(sub.body.error, /timed out/);
});

/* ---------------------------------------------------------------- the quote */

const TWO_POSTERS = {
  ...ORDER,
  lineItems: [{ _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 2, unitPrice: 25 }],
};

test('quote: one item is quoted from its band and the order postcode, and the exact figure comes back', async () => {
  const { sanity, quotes, deps } = setup();
  const { session } = await lookup(deps);
  const q = await handleReturns(post({ action: 'quote', session, lines: [{ lineKey: 'a', quantity: 1 }] }), deps);
  assert.equal(q.status, 200);
  assert.equal(q.body.postage, 2.57);
  assert.deepEqual(quotes, [{ band: 'P3', postalCode: 'BA1 1AA', countryCode: 'GB' }]);
  assert.equal(JSON.stringify(q.body).includes('BA1'), false, 'the address is not handed back');
  assert.equal([...sanity.store.values()].some((d) => d._type === 'returnRequest'), false, 'a quote creates nothing');
});

test('quote: no exact figure when the box is Alan\'s choice, the quote fails, or the price is not GBP -- never an error', async () => {
  const two = setup({ order: TWO_POSTERS });
  const s2 = (await lookup(two.deps)).session;
  const one = await handleReturns(post({ action: 'quote', session: s2, lines: [{ lineKey: 'a', quantity: 1 }] }), two.deps);
  assert.equal(one.body.postage, 2.57, 'one of two is still one box');
  const both = await handleReturns(post({ action: 'quote', session: s2, lines: [{ lineKey: 'a', quantity: 2 }] }), two.deps);
  assert.deepEqual([both.status, both.body.postage], [200, null]);
  assert.equal(two.quotes.length, 1, 'two items: the service is not asked');

  const down = setup({ quoteResult: Object.assign(new Error('Band P3 has no sizes yet'), { code: 'band_not_configured' }) });
  const q = await handleReturns(post({ action: 'quote', session: (await lookup(down.deps)).session, lines: [{ lineKey: 'a', quantity: 1 }] }), down.deps);
  assert.deepEqual([q.status, q.body.postage], [200, null]);

  const eur = setup({ quoteResult: { price: 3, currency: 'EUR' } });
  const e = await handleReturns(post({ action: 'quote', session: (await lookup(eur.deps)).session, lines: [{ lineKey: 'a', quantity: 1 }] }), eur.deps);
  assert.equal(e.body.postage, null);

  const abroad = setup({ order: { ...ORDER, shippingAddress: { ...ORDER.shippingAddress, country: 'IE', postcode: 'D02 X285' } } });
  const a = await handleReturns(post({ action: 'quote', session: (await lookup(abroad.deps)).session, lines: [{ lineKey: 'a', quantity: 1 }] }), abroad.deps);
  assert.deepEqual([a.body.postage, abroad.quotes.length], [null, 0]);

  // Nothing returnable chosen (the personalised line): no figure, no call.
  const p = setup();
  const pq = await handleReturns(post({ action: 'quote', session: (await lookup(p.deps)).session, lines: [{ lineKey: 'p', quantity: 1 }] }), p.deps);
  assert.deepEqual([pq.status, pq.body.postage, p.quotes.length], [200, null, 0]);
});

test('quote: needs the session the lookup signed', async () => {
  const { quotes, deps } = setup();
  const q = await handleReturns(post({ action: 'quote', session: 'abc.def', lines: [{ lineKey: 'a', quantity: 1 }] }), deps);
  assert.equal(q.status, 400);
  assert.equal(quotes.length, 0);
});

/* ---------------------------------------------------------------- the label */

const RET = (extra = {}) => ({
  _id: 'returnRequest.ret-abc', _type: 'returnRequest', returnRef: 'ret-abc', returnNumber: 'CSC-4001-R1',
  orderId: ORDER._id, orderNumber: 'CSC-4001', customerName: 'Mary Shelley', customerEmail: 'Mary@Example.com',
  status: 'approved', band: 'P3', freeLabel: false,
  lines: [{ _key: 'a', lineKey: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', quantity: 1, unitPrice: 25 }],
  ...extra,
});

function labelSetup(ret, { price = { amount: 2.95, currency: 'GBP' }, fail } = {}) {
  const sanity = fakeSanity([ORDER, ret]);
  const resend = fakeResend();
  const calls = [];
  const deps = {
    sanity, getResend: () => resend, log: quiet,
    shipping: async (path, body) => {
      calls.push({ path, body });
      if (fail) throw Object.assign(new Error('No option fits'), { code: 'no_available_option' });
      return {
        parcelId: 77, shipmentId: 's77', carrier: 'inpost_gb', method: 'inpost_gb:l2l/size=m', trackingNumber: 'IP77',
        trackingUrl: 'https://track/ip77', labelId: '77', customerInstructions: 'Drop it at any InPost Locker.\nScan the QR code.',
        ...(price ? { quotedPrice: price } : {}),
      };
    },
    fetchLabel: async () => Buffer.from('%PDF-label'),
  };
  return { sanity, resend, calls, deps };
}

test('approved: the label is bought, emailed with instructions and the deduction, and recorded for the refund', async () => {
  const { sanity, resend, calls, deps } = labelSetup(RET());
  const r = await processReturn('returnRequest.ret-abc', deps);
  assert.equal(r.outcome, 'label_sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'create-return');
  assert.deepEqual([calls[0].body.orderRef, calls[0].body.returnRef, calls[0].body.band], ['CSC-4001', 'ret-abc', 'P3']);
  assert.equal(calls[0].body.customer.postalCode, 'BA1 1AA');

  const d = sanity.store.get('returnRequest.ret-abc');
  assert.equal(d.status, 'label_sent');
  assert.equal(d.postageDeduction, 2.95);
  assert.equal(d.labelId, '77');
  assert.ok(d.labelSentAt);

  assert.equal(resend.sent.length, 1);
  const m = resend.sent[0];
  assert.deepEqual(m.to, ['Mary@Example.com']);
  assert.equal(m.attachments[0].filename, 'return-label-CSC-4001-R1.pdf');
  assert.equal(Buffer.from(m.attachments[0].content, 'base64').toString(), '%PDF-label');
  assert.match(m.html, /£2\.95 return postage will be deducted from your refund/);
  assert.match(m.html, /Drop it at any InPost Locker/);

  // A second webhook for the same approval does nothing.
  assert.equal((await processReturn('returnRequest.ret-abc', deps)).outcome, 'ignored');
  assert.equal(calls.length, 1);
  assert.equal(resend.sent.length, 1);
});

test('a faulty-item return is a free label: no deduction, and the email says so', async () => {
  const { sanity, resend, deps } = labelSetup(RET({ freeLabel: true }));
  await processReturn('returnRequest.ret-abc', deps);
  assert.equal(sanity.store.get('returnRequest.ret-abc').postageDeduction, 0);
  assert.doesNotMatch(resend.sent[0].html, /deducted/);
  assert.match(resend.sent[0].html, /This label is free/);
});

test('in test mode the deduction is the quotedPrice of the option real routing would choose', async () => {
  const { sanity, resend, deps } = labelSetup(RET(), { price: { amount: 3.4, currency: 'GBP' } });
  const shipping = deps.shipping;
  deps.shipping = async (...a) => ({ ...(await shipping(...a)), test: true, method: 'sendcloud:letter' });
  await processReturn('returnRequest.ret-abc', deps);
  const d = sanity.store.get('returnRequest.ret-abc');
  assert.deepEqual([d.postageDeduction, d.quotedPrice, d.test], [3.4, 3.4, true]);
  assert.match(resend.sent[0].html, /£3\.40 return postage will be deducted from your refund/);
});

test('no quoted price from the service: the label still goes, without a figure, and the request says so', async () => {
  const { sanity, resend, deps } = labelSetup(RET(), { price: null });
  const r = await processReturn('returnRequest.ret-abc', deps);
  assert.equal(r.outcome, 'label_sent');
  const d = sanity.store.get('returnRequest.ret-abc');
  assert.equal(d.status, 'label_sent');
  assert.equal(d.postageDeduction, undefined, 'no figure is invented');
  assert.match(d.error, /gave no price/);
  assert.equal(resend.sent.length, 1);
  assert.deepEqual(resend.sent[0].to, ['Mary@Example.com']);
  assert.match(resend.sent[0].html, /The cost of this return label will be deducted from your refund/);
  assert.doesNotMatch(resend.sent[0].html, /£/);
});

test('no band, or a service error: an error on the request and a team email, never a customer email', async () => {
  const a = labelSetup(RET({ band: undefined }));
  assert.equal((await processReturn('returnRequest.ret-abc', a.deps)).outcome, 'error');
  assert.equal(a.calls.length, 0);
  assert.match(a.sanity.store.get('returnRequest.ret-abc').error, /band/);

  const b = labelSetup(RET(), { fail: true });
  assert.equal((await processReturn('returnRequest.ret-abc', b.deps)).outcome, 'error');
  assert.match(b.sanity.store.get('returnRequest.ret-abc').error, /no_available_option/);
  assert.ok(b.resend.sent.every((m) => m.to[0] !== 'Mary@Example.com'));
});

test('rejected: the reason Alan wrote, once; no reason, no email', async () => {
  const none = labelSetup(RET({ status: 'rejected' }));
  assert.equal((await processReturn('returnRequest.ret-abc', none.deps)).outcome, 'error');
  assert.ok(none.resend.sent.every((m) => m.to[0] !== 'Mary@Example.com'));

  const { sanity, resend, calls, deps } = labelSetup(RET({ status: 'rejected', rejectionReason: 'The print has been hung and has nail holes.' }));
  assert.equal((await processReturn('returnRequest.ret-abc', deps)).outcome, 'rejected');
  assert.equal((await processReturn('returnRequest.ret-abc', deps)).outcome, 'ignored');
  assert.equal(calls.length, 0);
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].html, /nail holes/);
  assert.ok(sanity.store.get('returnRequest.ret-abc').rejectionEmailSentAt);
});

test('the return of a Stripe test-mode order asks for a free test label; a live order\'s does not', async () => {
  for (const [order, expectTest] of [[{ ...ORDER, test: true }, true], [ORDER, false]]) {
    const sanity = fakeSanity([order, RET()]);
    const calls = [];
    const r = await processReturn('returnRequest.ret-abc', {
      sanity, getResend: () => fakeResend(), log: quiet,
      shipping: async (path, body) => { calls.push({ path, body }); return { parcelId: 77, carrier: 'inpost_gb', method: 'inpost_gb:l2l/size=m', trackingNumber: 'IP77', labelId: '77', quotedPrice: { amount: 0, currency: 'GBP' } }; },
      fetchLabel: async () => Buffer.from('%PDF-label'),
    });
    assert.equal(r.outcome, 'label_sent');
    assert.equal(calls[0].path, 'create-return');
    assert.equal(calls[0].body.test === true, expectTest);
    if (!expectTest) assert.equal('test' in calls[0].body, false);
  }
});
