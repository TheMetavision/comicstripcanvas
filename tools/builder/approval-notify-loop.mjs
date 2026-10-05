/**
 * The customer approves their proof; the team hears about it once.
 *
 *   # in one shell -- netlify dev must send its Resend calls to this script:
 *   $env:RESEND_API_KEY = 're_stub'; $env:RESEND_BASE_URL = 'http://localhost:8790'
 *   $env:TEAM_EMAIL = 'team@example.test'
 *   npx netlify dev --offline --port 8899
 *
 *   # in another:
 *   node --env-file=.env tools/builder/approval-notify-loop.mjs
 *
 * The Resend SDK reads RESEND_BASE_URL when it loads, so pointing it here means
 * no real email is sent and every attempt can be counted. This script IS that
 * Resend: it answers POST /emails, records what it was given, and can be told
 * to refuse or to hang.
 *
 * WHAT IT WRITES, AND TAKES BACK
 * ------------------------------
 * A stub build and a stub order in the production dataset -- there is no local
 * Sanity -- both with ids no customer could have, both deleted at the end,
 * including on failure.
 */
import http from 'node:http';
import { createClient } from '@sanity/client';

const BASE = process.env.LOOP_BASE || 'http://localhost:8899';
const STUB_PORT = Number(process.env.RESEND_STUB_PORT || 8790);
const ID = `pp-${'a9'.repeat(16)}`;
const DOC_ID = `pendingPersonalisation.${ID}`;
const ORDER_ID = 'order.cs_test_STUB_approval_notify_loop';
const ORDER_NUMBER = 'CSC-TEST-0001';
const CUSTOMER = 'Stub O’Customer';

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* ---------- the stand-in Resend ---------- */
const sent = [];
let mode = 'ok';                    // 'ok' | 'reject' | 'hang'
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/emails')) {
      res.writeHead(404).end();
      return;
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded as null */ }
    sent.push({ mode, body, auth: req.headers.authorization });
    if (mode === 'hang') return;    // never answers; the approve page must not wait for it
    if (mode === 'reject') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ statusCode: 500, name: 'internal_server_error', message: 'stub refused the send' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ id: `stub-${sent.length}` }));
  });
});

const token = () => [...crypto.getRandomValues(new Uint8Array(24))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

async function seed(t) {
  await sanity.createOrReplace({
    _id: ORDER_ID,
    _type: 'order',
    orderNumber: ORDER_NUMBER,
    customerName: CUSTOMER,
    status: 'paid',
    isPersonalised: true,
    notes: 'STUB ORDER for tools/builder/approval-notify-loop.mjs — safe to delete.',
    createdAt: new Date().toISOString(),
  });
  await sanity.createOrReplace({
    _id: DOC_ID,
    _type: 'pendingPersonalisation',
    status: 'approved',
    approveToken: t,
    approvedAt: new Date().toISOString(),
    kind: 'personalised',
    templateId: 'cover-fullbleed',
    printSize: '16 × 24 in',
    outputFormat: 'gallery',
    orderId: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    editCount: 2,
    editedAt: new Date().toISOString(),
    proofUrl: `${BASE}/api/personalisation-proof/${ID}`,
    customerNotes: 'STUB BUILD for tools/builder/approval-notify-loop.mjs — safe to delete.',
    createdAt: new Date().toISOString(),
  });
}

/** Put the build back to "proof sent, awaiting the customer" with a fresh link. */
async function rearm() {
  const t = token();
  await sanity.patch(DOC_ID)
    .set({ status: 'approved', approveToken: t })
    .unset(['customerApprovedAt'])
    .commit();
  return t;
}

const approve = async (t) => {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/personalisation-approve?id=${ID}&t=${t}`);
  return { status: res.status, html: await res.text(), ms: Date.now() - started };
};
const settle = () => new Promise((r) => setTimeout(r, 1500));

async function main() {
  await new Promise((r) => stub.listen(STUB_PORT, r));
  say(`\nResend stub on :${STUB_PORT}, netlify dev at ${BASE}\n`);
  try {
    const probe = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok(probe.status < 500, 'the dev server answers', String(probe.status));
  } catch (e) {
    say(`\nCould not reach ${BASE}: ${e.message} — see the header of this file for how to start it.\n`);
    process.exit(2);
  }

  const t1 = token();
  await seed(t1);
  say(`stub build ${ID} and order ${ORDER_ID} created\n`);

  say('1. APPROVE SENDS ONE EMAIL\n');
  const first = await approve(t1);
  ok(first.status === 200 && /approved/i.test(first.html), 'the customer sees the thank-you page', String(first.status));
  const doc1 = await sanity.getDocument(DOC_ID);
  ok(doc1.status === 'in_production' && !doc1.approveToken, '  the build is in production, the token spent', doc1.status);
  await settle();
  ok(sent.length === 1, 'exactly one email reached Resend', String(sent.length));
  const mail = sent[0]?.body || {};
  if (sent.length === 0) {
    say('\n  No request reached the stub. Was netlify dev started with RESEND_API_KEY and');
    say(`  RESEND_BASE_URL=http://localhost:${STUB_PORT} in its environment?\n`);
  }
  ok(mail.subject === `✅ PROOF APPROVED — ${ORDER_NUMBER} — ${CUSTOMER}`, '  with the subject', mail.subject);
  ok(Array.isArray(mail.to) && mail.to[0] === (process.env.LOOP_TEAM_EMAIL || 'team@example.test'),
    '  to TEAM_EMAIL', JSON.stringify(mail.to));
  const html = mail.html || '';
  ok(html.includes('BOLD POP CULTURE WALL ART'), '  under the branded header');
  ok(html.includes(ORDER_NUMBER), '  naming the order number');
  ok(html.includes('Personalised comic book cover'), '  the product');
  ok(html.includes('16 × 24 in') && html.includes('Canvas (Gallery Frame)'), '  the size and finish');
  ok(/Style<\/td>\s*<td[^>]*>Full bleed</.test(html), '  the style: Full bleed');
  ok(html.includes('Edited by us') && html.includes('2 times'), '  that we edited it, twice');
  ok(html.includes(`<img src="${BASE}/api/personalisation-proof/${ID}"`), '  a thumbnail of the approved proof');
  ok(html.includes(`/admin/personalisation/${ID}"`), '  the admin page link');
  ok(html.includes(`/intent/edit/id=${encodeURIComponent(ORDER_ID)};type=order`), '  and the order in the Studio');
  ok(html.includes('Stub O&rsquo;Customer') || html.includes('Stub O’Customer'), '  addressed by name');

  say('\n2. THE SAME LINK AGAIN SENDS NOTHING\n');
  const again = await approve(t1);
  ok(again.status === 410, 'a second click gets the expired page', String(again.status));
  await settle();
  ok(sent.length === 1, '  and no second email', String(sent.length));

  say('\n3. RESEND REFUSES — THE APPROVAL STILL STANDS\n');
  mode = 'reject';
  const t3 = await rearm();
  const before3 = sent.length;
  const third = await approve(t3);
  ok(third.status === 200 && /approved/i.test(third.html), 'the customer still sees the thank-you page', String(third.status));
  const doc3 = await sanity.getDocument(DOC_ID);
  ok(doc3.status === 'in_production' && !doc3.approveToken, '  and the build still moved to production', doc3.status);
  ok(sent.length > before3 && sent.slice(before3).every((s) => s.mode === 'reject'),
    '  the send was attempted and refused', `${sent.length - before3} attempt(s)`);

  say('\n4. RESEND HANGS — THE PAGE DOES NOT\n');
  mode = 'hang';
  const t4 = await rearm();
  const fourth = await approve(t4);
  ok(fourth.status === 200, 'the thank-you page still arrives', String(fourth.status));
  ok(fourth.ms < 9000, '  within the timeout, not after it', `${fourth.ms} ms`);
  const doc4 = await sanity.getDocument(DOC_ID);
  ok(doc4.status === 'in_production', '  and the approval is recorded', doc4.status);
}

try {
  await main();
} catch (err) {
  fail++;
  say(`\nTHREW: ${err.stack || err.message}`);
} finally {
  for (const docId of [DOC_ID, ORDER_ID]) {
    try {
      await sanity.delete(docId);
      const gone = await sanity.getDocument(docId);
      say(`${docId} ${gone ? 'STILL THERE — remove it in the Studio' : 'deleted'}`);
      if (gone) fail++;
    } catch (e) {
      say(`COULD NOT DELETE ${docId}: ${e.message} — remove it in the Studio`);
      fail++;
    }
  }
  stub.closeAllConnections?.();
  stub.close();
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
