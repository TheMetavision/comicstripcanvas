// Team emails carry CSC's own logo (fix/email-logos, 4 Nov 2026). The seven
// shipping/returns notices go through plainWrap, which now puts the logo bar
// on top; the new-order alert in webhook.mjs is covered end to end in
// tools/builder/handler-tests.mjs, and its source is checked here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  labelReadyEmail, shipmentProblemEmail, parcelAlertEmail,
  newReturnEmail, returnProblemEmail, returnAlertEmail, returnReadyEmail,
} from '../netlify/functions/_shared/shipping-emails.mjs';
import { EMAIL_BRAND, teamEmailHeader } from '../netlify/functions/_shared/email.mjs';

const CSC_LOGO = 'https://cdn.sanity.io/images/lwbwahym/production/d3b36041ed3eb60d6ef9e6a6353c30ab79363be4-440x440.png';
const OTHER_BRANDS = ['pixel8multimedia', 'wyrmfuel', 'thefuglys', 'labrats', 'catsoncrack', 'bikerbabies', 'dottyandfriends', 'themetavision'];

const order = {
  _id: 'order.cs_test_1', orderNumber: 'CSC-4001', customerName: 'Ann Example', customerEmail: 'ann@example.com',
  shippingAddress: { city: 'Leeds', postcode: 'LS1 1AA' },
};
const parcel = { parcelRef: 'P1', band: 'medium', carrier: 'royal_mail', option: 'Tracked 48', quotedPrice: 4.5, trackingNumber: 'TN1', labelId: 'L1' };
const event = { status: 'Delivery failed', statusCode: 80, carrierStatus: 'Address not found', trackingNumber: 'TN1', trackingUrl: 'https://track.example/TN1', at: '2026-11-04T10:00:00Z' };
const ret = {
  _id: 'returnRequest.r1', returnNumber: 'R-1001', orderNumber: 'CSC-4001', customerName: 'Ann Example', customerEmail: 'ann@example.com',
  lines: [{ productTitle: 'Chucky', format: 'canvas', size: 'medium', quantity: 1, unitPrice: 30 }],
  reason: 'changed_mind', deliveredAt: '2026-11-01T10:00:00Z', windowEndsOn: '15 Nov 2026',
  carrier: 'inpost', trackingNumber: 'RT1', postageDeduction: 3.2,
};

const emails = {
  labelReadyEmail: labelReadyEmail(order, [parcel]),
  shipmentProblemEmail: shipmentProblemEmail(order, 'No band fits'),
  parcelAlertEmail: parcelAlertEmail(order, parcel, event, 'delivery_problem'),
  newReturnEmail: newReturnEmail(ret),
  returnProblemEmail: returnProblemEmail(ret, 'No band'),
  returnAlertEmail: returnAlertEmail(ret, event, 'returned_to_sender'),
  returnReadyEmail: returnReadyEmail(ret, event),
};

test('the team header uses the EMAIL_BRAND logo (CSC Sanity asset), cropped', () => {
  assert.equal(EMAIL_BRAND.logo, CSC_LOGO);
  assert.ok(teamEmailHeader.includes(`${CSC_LOGO}?rect=${EMAIL_BRAND.logoRect}`));
  assert.ok(teamEmailHeader.includes(EMAIL_BRAND.headerBar));
});

for (const [name, mail] of Object.entries(emails)) {
  test(`${name}: CSC logo at the top, no other brand`, () => {
    const html = mail.html;
    assert.ok(html.includes(CSC_LOGO), 'has the lwbwahym logo');
    assert.ok(html.indexOf(CSC_LOGO) < html.indexOf('<h2'), 'logo comes before the heading');
    const lower = html.toLowerCase();
    for (const b of OTHER_BRANDS) assert.ok(!lower.includes(b), `no ${b}`);
    // The only Sanity project in the email is CSC's.
    for (const m of html.matchAll(/cdn\.sanity\.io\/images\/([a-z0-9]+)\//g)) assert.equal(m[1], 'lwbwahym');
  });
}

test('webhook.mjs: the new-order team email opens with teamEmailHeader, above the banner', () => {
  const src = readFileSync(new URL('../netlify/functions/webhook.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bteamEmailHeader\b[^}]*\} from '\.\/_shared\/email\.mjs'/);
  const team = src.indexOf("const teamEmail = setting('TEAM_EMAIL')");
  const header = src.indexOf('${teamEmailHeader}', team);
  const banner = src.indexOf("'📦 NEW ORDER RECEIVED'", team);
  assert.ok(team > 0 && header > team && header < banner, 'header sits before the NEW ORDER banner');
});
