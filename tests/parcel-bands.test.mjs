// Format + size -> parcel band, the proposed plan, and the never-guess rule.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor, bandForLine, proposeParcelPlan, validateParcelPlan, parcelItems, mapCarrier, carrierName, ALL_BANDS,
} from '../netlify/functions/_shared/parcel-bands.mjs';
import { classifyStatus, isCarrierScan } from '../netlify/functions/_shared/tracking-status.mjs';

test('every format and size the shop sells has its band', () => {
  const want = {
    poster: { small: 'P1', medium: 'P3', large: 'P4' },
    'canvas-standard': { small: 'CS1', medium: 'CS3', large: 'CS4' },
    'canvas-gallery': { small: 'CG1', medium: 'CG3', large: 'CG4' },
  };
  for (const [format, sizes] of Object.entries(want)) {
    for (const [size, band] of Object.entries(sizes)) assert.equal(bandFor(format, size), band, `${format} ${size}`);
  }
  assert.equal(ALL_BANDS.length, 9);
});

test('an unknown combination has no band, and is flagged rather than guessed', () => {
  assert.equal(bandFor('framed', 'small'), null);
  assert.equal(bandFor('poster', 'xl'), null);
  assert.match(bandForLine({ productTitle: 'X', formatKey: 'framed', sizeKey: 'small' }).problem, /no parcel band/);
  // An older line with labels only: not parsed, flagged.
  const legacy = bandForLine({ productTitle: 'Old', format: 'Poster Print', size: 'Small (12×8")' });
  assert.equal(legacy.band, undefined);
  assert.match(legacy.problem, /no format\/size key/);
});

const line = (key, formatKey, sizeKey, quantity = 1, extra = {}) => ({
  _key: key, productTitle: `Print ${key}`, format: formatKey, size: sizeKey, formatKey, sizeKey, quantity, unitPrice: 20, ...extra,
});

test('the proposed plan is one parcel per physical item', () => {
  const { plan, problems } = proposeParcelPlan([line('a', 'poster', 'medium', 2), line('b', 'canvas-gallery', 'large')]);
  assert.deepEqual(problems, []);
  assert.deepEqual(plan.map((p) => [p.parcelRef, p.band, p.items[0].lineKey, p.items[0].quantity]),
    [['1', 'P3', 'a', 1], ['2', 'P3', 'a', 1], ['3', 'CG4', 'b', 1]]);
  assert.deepEqual(validateParcelPlan(plan, [line('a', 'poster', 'medium', 2), line('b', 'canvas-gallery', 'large')]), []);
});

test('a legacy artwork-fee line is not a parcel; an unplaceable line is planned without a band and named', () => {
  const lines = [
    line('a', 'poster', 'small'),
    { _key: 'fee', productTitle: 'Artwork Fee', format: '—', size: '—', quantity: 1 },
    { _key: 'old', productTitle: 'Personalised Classic', format: 'Canvas', size: 'Large', quantity: 1 },
  ];
  const { plan, problems } = proposeParcelPlan(lines);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].band, undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Personalised Classic/);
  assert.ok(validateParcelPlan(plan, lines).some((p) => /Parcel 2 has no band/.test(p)), 'dispatch refuses it until a band is chosen');
});

test('Alan can combine two posters into one tube; a plan that does not add up is refused', () => {
  const lines = [line('a', 'poster', 'medium'), line('b', 'poster', 'large')];
  const combined = [{ parcelRef: '1', band: 'P4', items: [{ lineKey: 'a', quantity: 1 }, { lineKey: 'b', quantity: 1 }] }];
  assert.deepEqual(validateParcelPlan(combined, lines), []);

  const short = [{ parcelRef: '1', band: 'P4', items: [{ lineKey: 'a', quantity: 1 }] }];
  assert.ok(validateParcelPlan(short, lines).some((p) => /1 ordered, 0 in the parcel plan/.test(p)));
  const dupes = [{ parcelRef: '1', band: 'P3', items: [{ lineKey: 'a', quantity: 1 }] }, { parcelRef: '1', band: 'P4', items: [{ lineKey: 'b', quantity: 1 }] }];
  assert.ok(validateParcelPlan(dupes, lines).some((p) => /used twice/.test(p)));
  const badBand = [{ parcelRef: '1', band: 'Z9', items: [{ lineKey: 'a', quantity: 1 }, { lineKey: 'b', quantity: 1 }] }];
  assert.ok(validateParcelPlan(badBand, lines).some((p) => /not a known band/.test(p)));
  const stranger = [{ parcelRef: '1', band: 'P4', items: [{ lineKey: 'zz', quantity: 1 }] }];
  assert.ok(validateParcelPlan(stranger, lines).some((p) => /not on this order/.test(p)));
  assert.deepEqual(validateParcelPlan([], lines), ['The parcel plan is empty']);
});

test('parcel items carry the line value and a SKU', () => {
  const lines = [line('a', 'canvas-standard', 'medium', 2, { productSlug: 'hulk' })];
  const items = parcelItems({ items: [{ lineKey: 'a', quantity: 2 }] }, lines);
  assert.deepEqual(items, [{ description: 'Print a — canvas-standard — medium', qty: 2, valueGBP: 40, sku: 'hulk-canvas-standard-medium' }]);
});

test('Sendcloud carrier codes map onto the order schema\'s carrier list', () => {
  assert.deepEqual(mapCarrier('royal_mailv2'), { carrier: 'royal-mail', carrierOther: null });
  assert.deepEqual(mapCarrier('hermes_c2c_gb'), { carrier: 'evri', carrierOther: null });
  assert.deepEqual(mapCarrier('inpost_gb'), { carrier: 'inpost', carrierOther: null });
  assert.deepEqual(mapCarrier('dpd_gb'), { carrier: 'dpd', carrierOther: null });
  assert.deepEqual(mapCarrier('ups'), { carrier: 'ups', carrierOther: null });
  assert.equal(mapCarrier('sendcloud').carrier, 'other');
  assert.equal(carrierName('hermes_c2c_gb'), 'Evri');
});

test('Sendcloud statuses: the ids the service simulates, and what counts as a carrier scan', () => {
  assert.equal(classifyStatus(91, 'Parcel en route'), 'in_transit');
  assert.equal(classifyStatus(11, 'Delivered'), 'delivered');
  assert.equal(classifyStatus(62996, 'Exception'), 'exception');
  assert.equal(classifyStatus(62992, 'Returned to sender'), 'returned_to_sender');
  assert.equal(classifyStatus(12, 'Awaiting customer pickup'), 'ready_to_collect');
  assert.equal(classifyStatus(1000, 'Ready to send'), 'pre_transit');
  assert.equal(classifyStatus(1, 'Announced'), 'pre_transit');
  assert.equal(classifyStatus(424242, 'Out for delivery'), 'in_transit', 'an unknown scan means a carrier has it');
  assert.equal(classifyStatus(424242, 'Delivery attempt failed'), 'exception');
  assert.equal(isCarrierScan('in_transit'), true);
  assert.equal(isCarrierScan('delivered'), true);
  assert.equal(isCarrierScan('pre_transit'), false);
  assert.equal(isCarrierScan('exception'), false, 'announcement failed must not tell the customer it is on its way');
});
