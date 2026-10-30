// Which lines a customer may return for a change of mind, per the refund
// policy: 14 days from delivery, personalised and customised excluded.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReturn, pickLines, windowEndsOn, londonDate } from '../netlify/functions/_shared/returns-eligibility.mjs';
import { normaliseOrderNumber, issueSession, readSession } from '../netlify/functions/returns.mjs';

const DAY = 86400_000;
const delivered = Date.UTC(2026, 9, 20, 10, 0, 0);   // 20 Oct 2026, 11:00 BST

const order = (extra = {}) => ({
  _id: 'order.cs_1', orderNumber: 'CSC-1042', status: 'dispatched',
  shippingEmailSentAt: '2026-10-18T09:00:00Z',
  shipment: { dispatchedAt: '2026-10-18T09:00:00Z', deliveredAt: new Date(delivered).toISOString() },
  lineItems: [
    { _key: 'stock', productTitle: 'Hulk Smash', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 2, unitPrice: 25 },
    { _key: 'pers', productTitle: 'Your Photo Cover', formatKey: 'canvas-gallery', sizeKey: 'large', quantity: 1, unitPrice: 90, buildKind: 'personalised' },
    { _key: 'cust', productTitle: 'Custom Strip', formatKey: 'poster', sizeKey: 'small', quantity: 1, unitPrice: 30, buildKind: 'customise' },
  ],
  ...extra,
});

test('the window ends at the end of the 14th day after delivery, UK time', () => {
  assert.equal(windowEndsOn(new Date(delivered).toISOString()), '2026-11-03');
  // 23:30 UTC on 31 Oct is still 31 Oct in London after the clocks change (GMT)...
  assert.equal(londonDate(Date.UTC(2026, 9, 31, 23, 30)), '2026-10-31');
  // ...and 23:30 UTC on 20 Oct is already 21 Oct in London (BST).
  assert.equal(londonDate(Date.UTC(2026, 9, 20, 23, 30)), '2026-10-21');
});

test('within 14 days: stock lines are returnable, personalised and customised are not', () => {
  const v = evaluateReturn(order(), { now: delivered + 5 * DAY });
  assert.equal(v.eligible, true);
  assert.equal(v.deliveryDateUnknown, false);
  const by = Object.fromEntries(v.lines.map((l) => [l.lineKey, l]));
  assert.equal(by.stock.returnable, 2);
  assert.equal(by.pers.returnable, 0);
  assert.match(by.pers.why, /made to your specification/);
  assert.equal(by.cust.returnable, 0);
});

test('the last day counts; the day after does not', () => {
  const lastDay = Date.UTC(2026, 10, 3, 23, 0);   // 3 Nov 23:00 GMT
  assert.equal(evaluateReturn(order(), { now: lastDay }).eligible, true);
  const after = evaluateReturn(order(), { now: Date.UTC(2026, 10, 4, 0, 30) });
  assert.equal(after.eligible, false);
  assert.match(after.reason, /ended on 3 November 2026/);
});

test('no delivery date: allowed, and marked for Alan to judge', () => {
  const v = evaluateReturn(order({ shipment: undefined }), { now: delivered + 60 * DAY });
  assert.equal(v.eligible, true);
  assert.equal(v.deliveryDateUnknown, true);
  assert.equal(v.windowEndsOn, null);
});

test('not yet dispatched, or cancelled: nothing to return', () => {
  const pending = evaluateReturn(order({ status: 'in-production', shipment: {}, shippingEmailSentAt: undefined }), { now: delivered });
  assert.equal(pending.eligible, false);
  assert.match(pending.reason, /hasn't been dispatched/);
  assert.equal(evaluateReturn(order({ status: 'refunded' }), { now: delivered }).eligible, false);
});

test('an order from the old personalise form is excluded line by line', () => {
  const v = evaluateReturn(order({
    personalisationDetails: { style: 'classic' },
    lineItems: [
      { _key: 'p', productTitle: 'Personalised classic', format: 'Canvas', size: 'Large', quantity: 1, unitPrice: 60 },
      { _key: 'f', productTitle: 'Artwork Fee', format: '—', size: '—', quantity: 1, unitPrice: 15 },
    ],
  }), { now: delivered + DAY });
  assert.equal(v.eligible, false);
  assert.equal(v.lines.length, 1, 'the artwork fee is not a thing to send back');
});

test('quantities already requested are taken off; a rejected request gives them back', () => {
  const existing = [{ status: 'requested', lines: [{ lineKey: 'stock', quantity: 1 }] }, { status: 'rejected', lines: [{ lineKey: 'stock', quantity: 1 }] }];
  const v = evaluateReturn(order(), { now: delivered + DAY, existing });
  assert.equal(v.lines.find((l) => l.lineKey === 'stock').returnable, 1);
  const all = evaluateReturn(order(), { now: delivered + DAY, existing: [{ status: 'label_sent', lines: [{ lineKey: 'stock', quantity: 2 }] }] });
  assert.equal(all.eligible, false);
});

test('the picked lines are checked against the verdict', () => {
  const v = evaluateReturn(order(), { now: delivered + DAY });
  assert.deepEqual(pickLines(v, [{ lineKey: 'stock', quantity: 2 }]).lines.map((l) => [l.lineKey, l.quantity]), [['stock', 2]]);
  assert.match(pickLines(v, [{ lineKey: 'stock', quantity: 3 }]).error, /at most 2/);
  assert.match(pickLines(v, [{ lineKey: 'pers', quantity: 1 }]).error, /can't be returned/);
  assert.match(pickLines(v, [{ lineKey: 'nope', quantity: 1 }]).error, /not on this order/);
  assert.match(pickLines(v, []).error, /at least one/);
  assert.match(pickLines(v, [{ lineKey: 'stock', quantity: 0 }]).error, /at least one/);
});

test('order numbers are read the ways people type them', () => {
  assert.equal(normaliseOrderNumber('CSC-1042'), 'CSC-1042');
  assert.equal(normaliseOrderNumber('csc 1042'), 'CSC-1042');
  assert.equal(normaliseOrderNumber('#1042'), 'CSC-1042');
  assert.equal(normaliseOrderNumber('1042'), 'CSC-1042');
  assert.equal(normaliseOrderNumber('CSC-10a42'), null);
  assert.equal(normaliseOrderNumber(''), null);
});

test('the returns session is signed, bound to the order, and expires', () => {
  const env = { SHIPPING_SECRET: 's3cret' };
  const t = issueSession({ orderId: 'order.cs_1', email: 'a@b.co' }, { env, now: 1000 });
  assert.deepEqual(readSession(t, { env, now: 2000 }), { orderId: 'order.cs_1', email: 'a@b.co' });
  assert.equal(readSession(t, { env, now: 1000 + 31 * 60_000 }), null, 'expired');
  assert.equal(readSession(t, { env: { SHIPPING_SECRET: 'other' }, now: 2000 }), null, 'other key');
  const [payload, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ o: 'order.someone_else', e: 'a@b.co', x: 9e15 })).toString('base64url');
  assert.equal(readSession(`${forged}.${sig}`, { env, now: 2000 }), null, 'a changed payload fails');
  void payload;
});
