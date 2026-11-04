/**
 * Every email Comic Strip Canvas can send, rendered with full sample data.
 *
 *   const mails = await renderAllEmails();   // [{ group, title, mail: { to, subject, html } }]
 *
 * Used by tests/email-contrast.test.mjs (WCAG contrast on every one) and by the
 * preview renderer. NOTHING IS SENT: Resend, Stripe, Sanity and Netlify Blobs
 * are in-memory stubs (tests/_stubs/hooks.mjs, registered before any handler is
 * imported), and fetch is answered locally.
 *
 * Emails built inside a handler are captured from the stubbed Resend by running
 * the handler itself (webhook.mjs, breaker-email, limit-email); the rest come
 * from their exported builders.
 *
 * Inventory (send site -> email):
 *   webhook.mjs              customer order confirmation (stock / builder / legacy personalised),
 *                            referral thank-you, team new-order alert (all its warning blocks)
 *   dispatch-email.mjs       customer "on the way" (order-shipped.mjs, sanity-orders-webhook.mjs,
 *                            shipping-events.mjs): service parcels, hand-dispatched with/without link
 *   shipping-emails.mjs      team: label ready, shipment problem, parcel alert, new return, return
 *                            problem, return alert, return ready; customer: return label, return declined
 *                            (shipping-dispatch/return-background, shipping-events, returns.mjs)
 *   approval-email.mjs       team: proof approved (personalisation-approve.mjs)
 *   personalisation-action   customer: proof to approve
 *   breaker-email.mjs        team: styling budget spent (customer / studio)
 *   limit-email.mjs          team: a visitor ran out of style attempts
 *   stale-drafts.mjs         team: Studio drafts left open
 *   newsletter-email.mjs     customer: confirm subscription (newsletter.mts)
 *   contact.mts              team: contact-form notification; customer: acknowledgement
 */
import { register } from 'node:module';

register('./_stubs/hooks.mjs', import.meta.url);

const ROOT = new URL('../', import.meta.url).href;
const fn = (p) => import(`${ROOT}netlify/functions/${p}`);

const sanityStub = await import('./_stubs/sanity.mjs');
const stripeStub = await import('../tools/builder/_stubs/stripe.mjs');
const resendStub = await import('../tools/builder/_stubs/resend.mjs');
const blobStub = await import('../tools/builder/_stubs/netlify-blobs.mjs');

const ENV = {
  RESEND_API_KEY: 'stub-resend-key',
  STRIPE_SECRET_KEY: 'sk_test_stub',
  STRIPE_WEBHOOK_SECRET: 'whsec_stub',
  SANITY_WRITE_TOKEN: 'stub-token',
  CSC_INTERNAL_SECRET: 'stub-action-secret',
  URL: 'https://comicstripcanvas.co.uk',
};

function quietly(run) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(run).finally(() => Object.assign(console, saved));
}

/* ---------------------------------------------------------------- webhook */

const CUSTOMER = { email: 'ann.example@example.com', name: 'Ann Example' };
const ADDRESS = { line1: '12 Panel Street', line2: 'Flat 3', city: 'Leeds', state: 'West Yorkshire', postal_code: 'LS1 4AB', country: 'GB' };
const BUILD = 'pp-0123456789abcdef0123456789abcdef';

const line = (name, unit, qty, metadata) => ({
  price_data: { currency: 'gbp', unit_amount: unit, product_data: { name, metadata } },
  quantity: qty,
});

function session(id, { lines = [], amount, shipping = 0, discount = null, metadata = {} }) {
  const s = {
    id,
    livemode: true,
    payment_status: 'paid',
    payment_intent: `pi_${id.slice(3)}`,
    amount_total: amount,
    currency: 'gbp',
    customer_details: { email: CUSTOMER.email, name: CUSTOMER.name, address: ADDRESS },
    collected_information: { shipping_details: { name: CUSTOMER.name, address: ADDRESS } },
    shipping_cost: { amount_total: shipping },
    metadata,
    line_items: lines,
  };
  if (discount) {
    s.total_details = {
      amount_discount: discount.pence, amount_shipping: shipping, amount_tax: 0,
      breakdown: { discounts: discount.promos.map((p) => ({ amount: discount.pence, discount: { promotion_code: p, coupon: { id: 'co_1', name: 'Coupon' } } })) },
    };
  }
  return s;
}

const welcomePromo = { id: 'promo_pow10', code: 'POW10', restrictions: { first_time_transaction: true }, metadata: {} };
const friendPromo = (referrer) => ({ id: 'promo_pal', code: 'PAL-7KQ2XM', restrictions: { first_time_transaction: true }, metadata: { kind: 'csc-referral', referrer_email: referrer, referrer_order: 'CSC-1003' } });

async function runWebhook(webhook, s) {
  stripeStub.sessions.push(s);
  const body = JSON.stringify({ id: `evt_${s.id}`, type: 'checkout.session.completed', data: { object: s } });
  const res = await webhook(new Request('https://comicstripcanvas.co.uk/api/webhook', {
    method: 'POST', headers: { 'stripe-signature': 'good-signature', 'Content-Type': 'application/json' }, body,
  }), {});
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}: ${await res.text()}`);
}

function seedProducts() {
  const img = (ref, aspect) => ({ asset: { _ref: ref, metadata: { dimensions: { aspectRatio: aspect } } } });
  sanityStub.docs.set('product-hulk', {
    _id: 'product-hulk', _type: 'product', title: 'Hulk Smash', slug: { current: 'hulk-smash' },
    printFile: { asset: { _ref: 'file-hulk-classic' } }, images: [img('image-hulk', 0.667)],
    fullBleed: { printFile: { asset: { _ref: 'file-hulk-fb' } }, listingImage: img('image-hulk-fb', 0.667) },
  });
}

function seedEarlierOrder() {
  sanityStub.docs.set('order.cs_earlier', {
    _id: 'order.cs_earlier', _type: 'order', orderNumber: 'CSC-1002', customerEmail: CUSTOMER.email,
    stripeSessionId: 'cs_earlier', createdAt: '2026-06-01T10:00:00Z', status: 'delivered',
  });
}

async function webhookEmails(out) {
  const webhook = (await fn('webhook.mjs')).default;
  const capture = async (label, setup, s, names) => {
    sanityStub.reset(); stripeStub.reset(); resendStub.reset();
    sanityStub.answers.length = 0;
    setup();
    await quietly(() => runWebhook(webhook, s));
    const sent = [...resendStub.sent];
    if (sent.length !== names.length) throw new Error(`${label}: expected ${names.length} emails, got ${sent.length}: ${sent.map((m) => m.subject).join(' | ')}`);
    sent.forEach((mail, i) => out.push({ group: names[i][0], title: names[i][1], mail }));
  };

  // 1. Stock order: welcome + friend code (discount row), free P&P, a style
  //    name under a line, a line with no print file, a repeat welcome code,
  //    and a genuine referral -> the referrer's thank-you.
  await capture('stock order', () => {
    seedProducts(); seedEarlierOrder();
    // The referral's "earlier order?" check: none, so the friend is rewarded.
    sanityStub.answers.push([/path\("drafts\.\*\*"\)/, () => null]);
  }, session('cs_test_stock_1', {
    lines: [
      line('Hulk Smash', 3499, 1, { productId: 'product-hulk', slug: 'hulk-smash', format: 'canvas-gallery', size: 'medium', artworkStyle: 'fullBleed' }),
      line('Thor Thunder', 1999, 2, { productId: 'product-thor', slug: 'thor-thunder', format: 'poster', size: 'small', artworkStyle: 'classic' }),
    ],
    amount: 6797, shipping: 0, discount: { pence: 700, promos: [welcomePromo, friendPromo('pal.friend@example.com')] },
  }), [['Customer', 'Order confirmation (stock order, discount, free P&P)'], ['Customer', 'Referral thank-you'], ['Team', 'New order alert (stock order, all warnings)']]);

  // 2. Paid P&P, a friend code used by its own owner -> the "no reward" note.
  await capture('self referral', () => { seedProducts(); }, session('cs_test_stock_2', {
    lines: [line('Hulk Smash', 2499, 1, { productId: 'product-hulk', slug: 'hulk-smash', format: 'poster', size: 'large', artworkStyle: 'classic' })],
    amount: 2744, shipping: 495, discount: { pence: 250, promos: [friendPromo(CUSTOMER.email)] },
  }), [['Customer', 'Order confirmation (paid P&P)'], ['Team', 'New order alert (friend code, no reward)']]);

  // 3. Builder-personalised order.
  await capture('builder', () => { seedProducts(); }, session('cs_test_build_1', {
    lines: [line('Your Comic Book Cover', 4999, 1, { productId: 'product-hulk', slug: 'hulk-smash', format: 'canvas-standard', size: 'medium', artworkStyle: 'classic', personalisationId: BUILD, personalisationFee: '10', buildKind: 'personalised' })],
    amount: 5494, shipping: 495,
  }), [['Customer', 'Order confirmation (personalised, builder)'], ['Team', 'Personalised order alert (builder)']]);

  // 4 + 5. The legacy personalised flow, with the full brief and photos:
  //    a comic strip, then a cover (which adds Name/Title and Caption).
  const legacy = (id, style, ref) => session(id, {
    amount: 7495, shipping: 0,
    metadata: { isPersonalised: 'true', style, format: 'Canvas (Gallery Frame)', size: '18×12', basePrice: '59.95', artFee: '15.00', personalisationRef: ref },
  });
  const pending = (ref) => sanityStub.docs.set(`pendingPersonalisation.${ref}`, {
    _id: `pendingPersonalisation.${ref}`, _type: 'pendingPersonalisation',
    customerTitle: 'The Amazing Ann', captionText: 'Saving Leeds since 1990', instructions: 'Please make the cape red and keep the dog in panel 3.',
    uploadedImages: [1, 2, 3].map((n) => `https://cdn.sanity.io/images/lwbwahym/production/photo${n}-800x800.jpg`),
  });
  const strip = 'pp-1111111111111111aaaaaaaaaaaaaaaa';
  const cover = 'pp-2222222222222222bbbbbbbbbbbbbbbb';
  await capture('legacy strip', () => pending(strip), legacy('cs_test_legacy_1', 'Comic Book Strip', strip),
    [['Customer', 'Order confirmation (personalised comic strip)'], ['Team', 'Personalised order alert (strip, brief and photos)']]);
  await capture('legacy cover', () => pending(cover), legacy('cs_test_legacy_2', 'Comic Book Cover', cover),
    [['Customer', 'Order confirmation (personalised cover)'], ['Team', 'Personalised order alert (cover, brief and photos)']]);
}

/* --------------------------------------------------------- shared builders */

async function builderEmails(out) {
  const S = await fn('_shared/shipping-emails.mjs');
  const { buildDispatchEmail } = await fn('_shared/dispatch-email.mjs');
  const { approvalHtml, approvalSubject } = await fn('_shared/approval-email.mjs');
  const { staleDraftsEmail } = await fn('_shared/stale-drafts.mjs');
  const { confirmationEmail } = await fn('_shared/newsletter-email.mjs');
  const { proofEmailHtml } = await fn('personalisation-action.mjs');
  const { buildNotificationHtml, buildAckHtml } = await fn('contact.mts');
  const { setting } = await fn('_shared/site-config.mjs');

  const add = (group, title, mail) => out.push({ group, title, mail });
  const addr = { line1: '12 Panel Street', line2: 'Flat 3', city: 'Leeds', county: 'West Yorkshire', postcode: 'LS1 4AB', country: 'GB' };
  const order = {
    _id: 'order.cs_test_ship_1', orderNumber: 'CSC-1042', customerName: 'Ann Example', customerEmail: CUSTOMER.email,
    shippingAddress: addr, totalAmount: 67.97, shippingCost: 0, discountAmount: 7, discountCode: 'POW10',
    lineItems: [
      { productTitle: 'Hulk Smash', format: 'canvas-gallery', size: '18×12', quantity: 1, unitPrice: 34.99 },
      { productTitle: 'Thor Thunder', format: 'poster', size: '12×8', quantity: 2, unitPrice: 19.99 },
    ],
  };
  const parcel = (n) => ({ parcelRef: String(n), band: n === 1 ? 'CG4' : 'P3', carrier: 'royal_mailv2', option: 'Tracked 48 (medium parcel)', quotedPrice: 4.5, trackingNumber: `RM10000${n}GB`, trackingUrl: `https://track.example/RM10000${n}GB`, labelId: `10${n}` });
  const event = { status: 'Delivery failed', statusCode: 80, carrierStatus: 'Address not found, card left', trackingNumber: 'RM100001GB', trackingUrl: 'https://track.example/RM100001GB', at: '2026-11-04T10:00:00Z' };
  const ret = {
    _id: 'returnRequest.r1', returnNumber: 'R-1001', orderNumber: 'CSC-1042', customerName: 'Ann Example', customerEmail: CUSTOMER.email,
    lines: [{ productTitle: 'Hulk Smash', format: 'Canvas (Gallery Frame)', size: '18×12', quantity: 1, unitPrice: 34.99 }],
    reason: 'changed_mind', reasonLabel: 'Changed my mind', customerNotes: 'It is lovely, but too big for the hallway.',
    deliveredAt: '2026-11-01T10:00:00Z', windowEndsOn: '15 November 2026', carrier: 'inpost', trackingNumber: 'IP7788990011',
    postageDeduction: 3.2, rejectionReason: 'The canvas was returned with a damaged frame that was not there at dispatch.',
  };

  // Customer: dispatch (sendDispatchEmail sends it to order.customerEmail)
  const dispatch = (o) => ({ to: [o.customerEmail], ...buildDispatchEmail(o) });
  add('Customer', 'Dispatch (shipping service, two parcels)', dispatch({ ...order, shipment: { parcels: [parcel(1), parcel(2)] } }));
  add('Customer', 'Dispatch (hand-dispatched, tracking link)', dispatch({ ...order, trackingNumber: '1Z999AA10123456784', shippingCost: 4.95, totalAmount: 72.92 }));
  add('Customer', 'Dispatch (other courier, no link)', dispatch({ ...order, carrierOverride: true, carrier: 'other', carrierOther: 'Parcelforce', trackingNumber: 'PF123456789' }));

  // Customer: returns
  const pdf = Buffer.from('%PDF-1.4 stub');
  add('Customer', 'Return label (postage deducted)', S.returnLabelEmail(ret, { pdf, instructions: 'Print the label, stick it on the parcel and drop it at any InPost locker.\nKeep your receipt.', postage: 3.2 }));
  add('Customer', 'Return label (free label)', S.returnLabelEmail({ ...ret, freeLabel: true }, { pdf, instructions: 'Drop it at any InPost locker.', postage: null }));
  add('Customer', 'Return declined', S.returnDeclinedEmail(ret));

  // Customer: proof, newsletter, contact acknowledgement
  add('Customer', 'Proof to approve (with a note)', {
    to: [CUSTOMER.email], subject: 'Your artwork proof is ready to approve — Comic Strip Canvas',
    html: proofEmailHtml({ proofUrl: 'https://comicstripcanvas.co.uk/api/personalisation-proof/' + BUILD, approveLink: `https://comicstripcanvas.co.uk/approve/${BUILD}?t=abc`, shopEmail: 'hello@comicstripcanvas.co.uk', subject: 'Your artwork proof', note: 'We nudged the caption up a little so it clears the frame edge.' }),
  });
  add('Customer', 'Newsletter: confirm subscription', { to: [CUSTOMER.email], ...confirmationEmail({ confirmUrl: 'https://comicstripcanvas.co.uk/newsletter/confirm/?t=tok123' }) });
  const brand = { brandName: setting('BRAND_NAME'), logoUrl: setting('LOGO_URL'), headerBg: setting('EMAIL_HEADER_BG'), accent: setting('BRAND_ACCENT'), siteUrl: setting('SITE_URL') };
  const enquiry = { refCode: 'CSC-7F3K9Q', name: 'Ann Example', email: CUSTOMER.email, phone: '07700 900123', subject: 'Custom size enquiry', message: 'Hi,\nCould you do the Hulk print at 30x20?\nThanks, Ann', pageUri: 'https://comicstripcanvas.co.uk/products/hulk-smash' };
  add('Customer', 'Contact form acknowledgement', { to: [CUSTOMER.email], subject: 'We’ve received your message — Comic Strip Canvas (CSC-7F3K9Q)', html: buildAckHtml(brand, { firstName: 'Ann', ...enquiry }) });
  add('Team', 'Contact form notification', { to: [setting('NOTIFICATION_TO')], subject: '[Comic Strip Canvas] Custom size enquiry — CSC-7F3K9Q', html: buildNotificationHtml(brand, enquiry) });
  // BRAND_ACCENT is an env override; a pale accent must still give a readable link.
  add('Team', 'Contact form notification (pale BRAND_ACCENT override)', { to: [setting('NOTIFICATION_TO')], subject: '[Comic Strip Canvas] accent override', html: buildNotificationHtml({ ...brand, accent: '#FFE14D' }, enquiry) });

  // Team: shipping and returns
  add('Team', 'Label ready', S.labelReadyEmail(order, [parcel(1), parcel(2)]));
  add('Team', 'Shipment problem', S.shipmentProblemEmail(order, 'Line 2 (Canvas Gallery 30x20) fits no parcel band.\nAdd a band or split the parcel.'));
  add('Team', 'Parcel alert (delivery problem)', S.parcelAlertEmail(order, parcel(1), event, 'delivery_problem'));
  add('Team', 'Parcel alert (returned to sender)', S.parcelAlertEmail(order, parcel(1), event, 'returned_to_sender'));
  add('Team', 'New return request', S.newReturnEmail(ret));
  add('Team', 'New return request (delivery date unknown)', S.newReturnEmail({ ...ret, deliveryDateUnknown: true }));
  add('Team', 'Return problem', S.returnProblemEmail(ret, 'No band for Canvas (Gallery Frame) 18x12 on InPost.'));
  add('Team', 'Return alert (carrier problem)', S.returnAlertEmail(ret, event, 'delivery_problem'));
  add('Team', 'Return alert (going back to customer)', S.returnAlertEmail(ret, event, 'returned_to_sender'));
  add('Team', 'Return ready to collect (postage deducted)', S.returnReadyEmail(ret, { ...event, status: 'Ready for collection' }));
  add('Team', 'Return ready to collect (free label)', S.returnReadyEmail({ ...ret, freeLabel: true }, { ...event, status: 'Ready for collection' }));

  // Team: proof approved, stale drafts
  const d = { orderNumber: 'CSC-1042', customerName: 'Ann Example', product: 'Comic Book Cover', size: '18×12', finish: 'Canvas (Gallery Frame)', style: 'Classic', editCount: 2 };
  add('Team', 'Proof approved', {
    to: [setting('TEAM_EMAIL')], subject: approvalSubject(d),
    html: approvalHtml({ id: BUILD, d, proofUrl: `https://comicstripcanvas.co.uk/api/personalisation-proof/${BUILD}`, adminUrl: `https://comicstripcanvas.co.uk/admin/personalisation/${BUILD}`, orderUrl: S.studioLink('order.cs_test_build_1', 'order'), approvedAt: '2026-11-04T09:30:00.000Z' }),
  });
  add('Team', 'Proof approved (not edited)', {
    to: [setting('TEAM_EMAIL')], subject: approvalSubject({ ...d, editCount: 0 }),
    html: approvalHtml({ id: BUILD, d: { ...d, editCount: 0 }, proofUrl: null, adminUrl: `https://comicstripcanvas.co.uk/admin/personalisation/${BUILD}`, orderUrl: null, approvedAt: '2026-11-04T09:30:00.000Z' }),
  });
  add('Team', 'Stale Studio drafts', { to: [setting('TEAM_EMAIL')], ...staleDraftsEmail([
    { _id: 'drafts.order.cs_test_1', publishedId: 'order.cs_test_1', _type: 'order', orderNumber: 'CSC-1042', ageHours: 49 },
    { _id: `drafts.pendingPersonalisation.${BUILD}`, publishedId: `pendingPersonalisation.${BUILD}`, _type: 'pendingPersonalisation', customerTitle: 'The Amazing Ann', ageHours: 30 },
    { _id: 'drafts.order.cs_test_2', publishedId: 'order.cs_test_2', _type: 'order', orderNumber: 'CSC-1043', ageHours: 26 },
  ]) });
}

/* ------------------------------------------- team notices sent in-function */

async function alertEmails(out) {
  const { notifyBreakerTripped } = await fn('_shared/breaker-email.mjs');
  const { notifyStyleLimit } = await fn('_shared/limit-email.mjs');
  const take = async (label, run) => {
    resendStub.reset(); blobStub.reset();
    const r = await quietly(run);
    if (!r?.sent || resendStub.sent.length !== 1) throw new Error(`${label}: not sent (${r?.reason})`);
    out.push({ group: 'Team', title: label, mail: resendStub.sent[0] });
  };
  const store = () => blobStub.getStore('spend-guard');
  const now = new Date('2026-11-04T15:20:00Z');
  await take('Styling paused (customer budget)', () => notifyBreakerTripped({ store: store(), calls: 400, origin: 'customer', now }));
  await take('Styling paused (studio budget)', () => notifyBreakerTripped({ store: store(), calls: 150, origin: 'studio', now }));
  await take('Customer used their style attempts', () => notifyStyleLimit({ store: store(), key: 'v_3f9a1c2e7b', buildId: BUILD, templateId: 'cover-classic', calls: 6, now }));
}

export async function renderAllEmails() {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  delete process.env.SHIPPING_TEST_MODE;
  delete process.env.SHIPPING_ENABLED;
  delete process.env.EMAIL_FROM;
  // Nothing leaves the process: the render trigger and anything else get a 202.
  globalThis.fetch = async () => new Response('Accepted', { status: 202 });
  const out = [];
  try {
    await webhookEmails(out);
    await builderEmails(out);
    await alertEmails(out);
  } finally {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
  return out;
}
