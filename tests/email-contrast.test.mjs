// Every email CSC can send, customer and team, is readable: each visible text
// element reaches WCAG 4.5:1 against its real background (3:1 when large).
// The emails are rendered with full sample data by tests/_email-samples.mjs,
// which stubs Resend, Stripe, Sanity and Blobs -- nothing is sent.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastIssues, assertReadable } from './_email-contrast.mjs';
import { renderAllEmails } from './_email-samples.mjs';
import { EMAIL_BRAND, readableShade, contrastRatio } from '../netlify/functions/_shared/email.mjs';

const mails = await renderAllEmails();

test('the checker flags a known-bad sample', () => {
  const bad = `<div style="background:#ffffff"><p style="color:#aaaaaa;font-size:12px">Order number</p>
    <div style="background:#EC008C"><p style="color:rgba(255,255,255,0.8);font-size:13px">Tuesday</p></div>
    <a href="#" style="color:#28a745">FREE UK P&amp;P</a></div>`;
  const issues = contrastIssues(bad);
  assert.equal(issues.length, 3, JSON.stringify(issues));
  assert.throws(() => assertReadable(bad, 'bad sample'), /3 text element\(s\) below WCAG contrast/);
  assert.doesNotThrow(() => assertReadable('<p style="color:#111111">fine</p>', 'good sample'));
});

test('every email the site sends was rendered, with no blank sample fields', () => {
  assert.ok(mails.length >= 39, `${mails.length} emails`);
  const titles = mails.map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length, 'titles are unique');
  for (const want of [
    'Order confirmation (stock order, discount, free P&P)', 'Referral thank-you', 'New order alert (stock order, all warnings)',
    'New order alert (friend code, no reward)', 'Personalised order alert (strip, brief and photos)', 'Order confirmation (personalised, builder)',
    'Dispatch (shipping service, two parcels)', 'Return label (postage deducted)', 'Return declined', 'Proof to approve (with a note)',
    'Newsletter: confirm subscription', 'Contact form acknowledgement', 'Contact form notification', 'Label ready', 'Shipment problem',
    'Parcel alert (delivery problem)', 'New return request', 'Return problem', 'Return alert (carrier problem)', 'Return ready to collect (postage deducted)',
    'Proof approved', 'Stale Studio drafts', 'Styling paused (customer budget)', 'Styling paused (studio budget)', 'Customer used their style attempts',
  ]) assert.ok(titles.includes(want), `missing: ${want}`);
  for (const { title, mail } of mails) {
    assert.ok(mail.html && mail.subject && [].concat(mail.to || []).length, `${title}: html, subject and recipient`);
    assert.doesNotMatch(mail.html, /undefined|null|NaN|\[object Object\]/, `${title}: no blank fields`);
  }
  // The new-order alert really carries every warning block and the discount row.
  const alert = mails.find((m) => m.title === 'New order alert (stock order, all warnings)').mail.html;
  for (const s of ['Print file missing', 'Repeat welcome code', 'Discount (POW10, PAL-7KQ2XM):', 'FREE UK P&P', 'Action Required']) assert.ok(alert.includes(s), `alert has ${s}`);
  assert.ok(mails.find((m) => m.title === 'New order alert (friend code, no reward)').mail.html.includes('Friend code, no reward'));
});

for (const { group, title, mail } of mails) {
  test(`${group}: ${title} is readable`, () => assertReadable(mail.html, title));
}

test('brand text shades: same hue, readable where they are used', () => {
  assert.ok(contrastRatio(EMAIL_BRAND.pinkText, '#eeeeee') >= 4.5);
  assert.ok(contrastRatio(EMAIL_BRAND.pinkOnDark, EMAIL_BRAND.dark) >= 4.5);
  assert.ok(contrastRatio('#ffffff', EMAIL_BRAND.pinkBanner) >= 4.5);
  assert.ok(contrastRatio('#ffffff', EMAIL_BRAND.cyanBanner) >= 4.5);
  assert.ok(contrastRatio(EMAIL_BRAND.cyanText, '#f0f9ff') >= 4.5);
  assert.ok(contrastRatio(EMAIL_BRAND.greenText, '#f0fff0') >= 4.5);
  // An already-readable colour is left alone; an unreadable one is shaded, not replaced.
  assert.equal(readableShade('#111111', '#ffffff'), '#111111');
  const pale = readableShade('#FFE14D', '#ffffff');
  assert.ok(contrastRatio(pale, '#ffffff') >= 4.5 && pale !== '#000000', pale);
  assert.ok(contrastRatio(readableShade('#EC008C', '#000000'), '#000000') >= 4.5);
});
