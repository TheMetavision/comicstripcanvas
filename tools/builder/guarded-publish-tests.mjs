/**
 * The stale-draft guard: orders publish without undoing the server, builds
 * cannot be drafted at all, and somebody hears about any draft left lying.
 *
 *   node --env-file=.env tools/builder/guarded-publish-tests.mjs           all
 *   node --env-file=.env tools/builder/guarded-publish-tests.mjs --offline  no Sanity
 *
 * OFFLINE: the merge rule, the search for a draft's base, the action list per
 * type, the daily check's decision, and the REAL schema objects -- loaded from
 * studio/schemas/*.ts through module hooks that stand in for `sanity` and the
 * React components, so "this field is read-only" is read off the schema the
 * Studio builds, not off a regex.
 *
 * LIVE: the guarded publish itself, against the Content Lake, because the
 * parts most likely to be wrong are the parts only the server can answer --
 * whether the History API finds the draft's start, whether the Actions API
 * accepts replace + publish in one transaction, and whether
 * ifPublishedRevisionId really refuses. The stub order has an id no real order
 * could have and NO customer email -- the live order-shipped webhook ignores an
 * order without one, so dispatching the stub cannot email anybody -- and it is
 * deleted at the end, including on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  OPERATOR_FIELDS, mergeForPublish, findDraftBase, guardedPublish, PublishRefused,
} from '../../studio/lib/guarded-publish.mjs';
import { resolveDocumentActions, BUILD_REMOVED } from '../../studio/actions/resolve-actions.mjs';
import { runStaleDraftCheck, findStaleDrafts, publishedIdOf } from '../../netlify/functions/_shared/stale-drafts.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OFFLINE = process.argv.includes('--offline');

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const quiet = { log() {}, warn() {}, error() {} };

/* ═════════ 1. the merge rule */

say('\n1. WHAT A PUBLISH KEEPS AND WHAT IT TAKES\n');
{
  const base = { _id: 'order.x', _type: 'order', _rev: 'r0', status: 'received', notes: '', carrier: undefined,
    shippingEmailSent: false, totalAmount: 10 };
  /* The server has since dispatched it and recorded the email; the draft only
     added a note. */
  const published = { ...base, _rev: 'r1', status: 'dispatched', trackingNumber: 'TRK1', carrier: 'ups',
    shippingEmailSent: true, shippingEmailSentAt: '2026-10-05T10:00:00Z', teamEmailError: 'x' };
  const draft = { ...base, _id: 'drafts.order.x', _rev: 'd1', notes: 'packed by Alan' };
  const m = mergeForPublish({ draft, published, base });
  ok(m.doc.shippingEmailSent === true, 'shippingEmailSent stays true — the draft held false');
  ok(m.doc.shippingEmailSentAt === '2026-10-05T10:00:00Z', '  and its timestamp, which the draft never had');
  ok(m.doc.status === 'dispatched', 'status stays dispatched — the draft held the old received');
  ok(m.doc.trackingNumber === 'TRK1' && m.doc.carrier === 'ups', '  tracking and carrier stand');
  ok(m.doc.teamEmailError === 'x', '  a server-only field the draft never saw is kept');
  ok(m.doc.notes === 'packed by Alan', 'the note the operator wrote is taken');
  ok(JSON.stringify(m.taken) === '["notes"]', '  and only that', JSON.stringify(m.taken));
  ok(!m.conflicts.length && !m.blind.length, '  with no conflict');
  ok(!('_rev' in m.doc) && !('_id' in m.doc), 'system fields are not carried into the publish');

  /* A real change of status in the draft, the order otherwise untouched. */
  const pub2 = { ...base, _rev: 'r2' };
  const m2 = mergeForPublish({ draft: { ...base, status: 'in-production' }, published: pub2, base });
  ok(m2.doc.status === 'in-production' && m2.taken.includes('status'), 'a status changed only in the draft is taken');

  /* Changed both places, differently. */
  const m3 = mergeForPublish({
    draft: { ...base, status: 'cancelled' }, published: { ...base, status: 'delivered' }, base,
  });
  ok(m3.conflicts.length === 1 && m3.conflicts[0].field === 'status', 'status changed in both places is a conflict',
    JSON.stringify(m3.conflicts[0]));

  /* No base to judge by: a differing operator field cannot be attributed. */
  const m4 = mergeForPublish({ draft: { ...base, carrier: 'royal-mail' }, published: { ...base, carrier: 'ups' }, base: undefined });
  ok(m4.blind.includes('carrier'), 'without a base, a differing field is refused rather than guessed', JSON.stringify(m4.blind));
  const m5 = mergeForPublish({ draft: { ...base }, published: { ...base, shippingEmailSent: true }, base: undefined });
  ok(!m5.blind.length && m5.doc.shippingEmailSent === true, '  but server fields need no base: they always come from published');

  /* Clearing a field in the draft is a change too. */
  const m6 = mergeForPublish({ draft: { ...base, notes: undefined }, published: { ...base, notes: 'old' }, base: { ...base, notes: 'old' } });
  ok(!('notes' in m6.doc) && m6.taken.includes('notes'), 'a field the operator emptied is emptied');
}

/* ═════════ 2. finding where the draft came from */

say('\n2. THE DRAFT\'S STARTING POINT\n');
{
  const d = 'drafts.order.x', p = 'order.x';
  const tx = (timestamp, kind, id = d) => ({ id: timestamp, timestamp, mutations: [{ [kind]: { _id: id } }] });
  const snapshots = { '2026-10-01T09:00:00.000Z': { _id: p, status: 'received' } };
  const docAt = async (id, t) => {
    if (id === p) return { _id: p, at: t, status: 'received' };
    // The draft existed from 09:00 on; a createIfNotExists after that is an edit, not a start.
    return Date.parse(t) >= Date.parse('2026-10-01T09:00:00.000Z') ? { _id: d } : null;
  };
  const txs = [                                   // newest first, as the API is asked for
    { id: 't4', timestamp: '2026-10-01T09:30:00.000Z', mutations: [{ patch: { id: d } }] },
    tx('2026-10-01T09:20:00.000Z', 'createIfNotExists'),
    tx('2026-10-01T09:00:00.000Z', 'createIfNotExists'),
  ];
  const r = await findDraftBase({ draftId: d, publishedId: p, deps: { draftTransactions: async () => txs, docAt } });
  ok(r.createdAt === '2026-10-01T09:00:00.000Z', 'a later createIfNotExists on an existing draft is skipped', r.createdAt);
  ok(r.base && r.base.at === '2026-10-01T09:00:00.000Z', '  and the base is the order as it was at the real start');

  const r2 = await findDraftBase({
    draftId: d, publishedId: p,
    deps: { draftTransactions: async () => [tx('2026-10-02T08:00:00.000Z', 'create'), tx('2026-10-01T08:00:00.000Z', 'create')], docAt },
  });
  ok(r2.createdAt === '2026-10-02T08:00:00.000Z', 'a draft discarded and started again is based on its LATEST start');

  const r3 = await findDraftBase({ draftId: d, publishedId: p, deps: { draftTransactions: async () => { throw new Error('403'); }, docAt } });
  ok(r3.base === undefined && /could not be read/.test(r3.why), 'unreadable history means no base, said why', r3.why);
  void snapshots;
}

/* ═════════ 3. which actions each type gets */

say('\n3. THE BUTTONS\n');
{
  const std = ['publish', 'unpublish', 'discardChanges', 'delete', 'duplicate', 'restore']
    .map((action) => Object.assign(() => null, { action }));
  const Guarded = () => null;
  const Approve = () => null;
  const order = resolveDocumentActions(std, { schemaType: 'order' }, { OrderPublishAction: Guarded, buildExtras: [Approve] });
  ok(order[0] === Guarded, 'an order\'s Publish is the guarded one, in Publish\'s place');
  ok(!order.some((a) => a.action === 'publish'), '  and the standard Publish is gone');
  ok(order.length === std.length && !order.includes(Approve), '  nothing else added or lost');

  const build = resolveDocumentActions(std, { schemaType: 'pendingPersonalisation' }, { OrderPublishAction: Guarded, buildExtras: [Approve] });
  for (const a of BUILD_REMOVED) ok(!build.some((x) => x.action === a), `a build has no ${a}`);
  ok(build.some((x) => x.action === 'discardChanges'), '  but can still discard a stray draft');
  ok(build.includes(Approve) && !build.includes(Guarded), '  and gets Approve / Hold / Re-render, not the order Publish');

  const other = resolveDocumentActions(std, { schemaType: 'product' }, { OrderPublishAction: Guarded, buildExtras: [Approve] });
  ok(other === std, 'every other type is left exactly as it was');
}

/* ═════════ 4. the schemas, as the Studio builds them */

say('\n4. WHAT CAN BE EDITED IN THE STUDIO\n');
{
  /* `sanity` and the React components are stood in for: the schema files only
     call defineType / defineField (identity functions) and hand the components
     to the Studio, so the objects that come back are the real definitions. */
  const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'sanity') {
        return { url: stub('export const defineType=(x)=>x;export const defineField=(x)=>x;export const defineArrayMember=(x)=>x;'), shortCircuit: true };
      }
      if (/\/components\//.test(specifier) && context.parentURL && context.parentURL.includes('/studio/schemas/')) {
        return { url: stub('export default function Component(){}'), shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const load = async (name) => (await import(pathToFileURL(path.join(ROOT, 'studio', 'schemas', name)).href)).default;
  let pp, order;
  try {
    pp = await load('pendingPersonalisation.ts');
    order = await load('order.ts');
  } finally {
    hooks.deregister();
  }

  ok(pp.readOnly === true, 'a build is read-only as a whole document');
  const statusField = pp.fields.find((f) => f.name === 'status');
  const proofUrl = pp.fields.find((f) => f.name === 'proofUrl');
  ok(statusField.readOnly === true && proofUrl.readOnly === true, '  status and proofUrl are read-only in their own right too');
  const overridden = pp.fields.filter((f) => f.readOnly === false || typeof f.readOnly === 'function');
  ok(overridden.length === 0, '  and no field opts back out of it', overridden.map((f) => f.name).join(', '));

  const editable = order.fields.filter((f) => f.readOnly !== true).map((f) => f.name).sort();
  ok(JSON.stringify(editable) === JSON.stringify([...OPERATOR_FIELDS].sort()),
    'on an order, exactly the guard\'s six operator fields are editable', editable.join(', '));
  ok(order.fields.find((f) => f.name === 'lineItems').readOnly === true
    && order.fields.find((f) => f.name === 'personalisationDetails').readOnly === true,
    '  line data and personalisation details are not');
}

/* ═════════ 5. the daily check's decision */

say('\n5. THE DAILY CHECK\n');
{
  const now = new Date('2026-10-06T07:00:00Z');
  const fake = (rows) => ({ fetch: async (q, params) => rows.filter((r) => r._updatedAt < params.cutoff) });
  const sent = [];
  const send = async (m) => { sent.push(m); return { data: { id: 'x' } }; };

  const none = await runStaleDraftCheck({ sanity: fake([]), send, now, log: quiet });
  ok(none.sent === false && sent.length === 0, 'no drafts: no email', none.reason);

  const fresh = await runStaleDraftCheck({
    sanity: fake([{ _id: 'drafts.order.a', _type: 'order', _updatedAt: '2026-10-06T01:00:00Z' }]), send, now, log: quiet,
  });
  ok(fresh.sent === false && sent.length === 0, 'a draft six hours old: still no email', fresh.reason);

  const stale = await runStaleDraftCheck({
    sanity: fake([
      { _id: 'drafts.order.a', _type: 'order', _updatedAt: '2026-10-04T07:00:00Z', orderNumber: 'CSC-1009' },
      { _id: 'drafts.pendingPersonalisation.pp-1', _type: 'pendingPersonalisation', _updatedAt: '2026-10-05T06:00:00Z' },
    ]), send, now, log: quiet,
  });
  ok(stale.sent === true && sent.length === 1, 'drafts over 24 hours: one email', `${stale.found} found`);
  ok(/2 Studio drafts left open over 24 hours/.test(sent[0].subject), '  saying how many', sent[0].subject);
  ok(sent[0].html.includes('CSC-1009') && sent[0].html.includes('48 h') && sent[0].html.includes('25 h'),
    '  which, and how long untouched');
  ok(sent[0].html.includes('intent/edit/id=order.a;type=order'), '  each with a link to the published document');
  ok(sent[0].to[0] === (process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk'),
    '  to TEAM_EMAIL, else EMAIL_FROM', sent[0].to[0]);

  const failing = await runStaleDraftCheck({
    sanity: fake([{ _id: 'drafts.order.a', _type: 'order', _updatedAt: '2026-10-01T00:00:00Z' }]),
    send: async () => ({ error: { message: 'rejected' } }), now, log: quiet,
  });
  ok(failing.sent === false && /rejected/.test(failing.reason), 'a Resend refusal is reported, not thrown');
  ok(publishedIdOf('versions.rel1.order.b') === 'order.b' && publishedIdOf('drafts.order.b') === 'order.b',
    'release versions are mapped back to their order as well');
}

/* ═════════ 6. live: the guarded publish against the Content Lake */

if (OFFLINE) {
  say('\n6. LIVE — skipped (--offline)\n');
} else {
  say('\n6. LIVE: PUBLISHING A STALE DRAFT\n');
  const require = createRequire(path.join(ROOT, 'studio', 'package.json'));
  const { createClient } = require('@sanity/client');
  const client = createClient({
    projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
    token: process.env.SANITY_WRITE_TOKEN, useCdn: false, perspective: 'raw',
  });
  const PUB = 'order.cs_test_STUB_guarded_publish_tests';
  const DRAFT = `drafts.${PUB}`;
  const settle = () => new Promise((r) => setTimeout(r, 2500));   // let history index the draft's start

  /* What an order looks like when the payment webhook has just made it -- minus
     any customer email, so the live shipping webhook can never act on it. */
  const fresh = {
    _id: PUB, _type: 'order', orderNumber: 'CSC-TEST-GUARD', status: 'received',
    customerName: 'STUB — tools/builder/guarded-publish-tests.mjs', shippingEmailSent: false,
    totalAmount: 1, isPersonalised: false, notes: '',
    lineItems: [{ _key: 'l1', _type: 'object', productTitle: 'Stub', format: 'Poster Print', size: 'Small', quantity: 1, unitPrice: 1 }],
  };
  /* The Studio starts a draft by copying the published document. */
  const startDraft = async () => client.createIfNotExists({ ...(await client.getDocument(PUB)), _id: DRAFT });

  try {
    await client.delete(DRAFT).catch(() => {});
    await client.createOrReplace(fresh);

    /* (a) The draft is opened, the server then dispatches and emails, the
       operator only adds a note -- and publishes the old copy. */
    await startDraft();
    await client.patch(DRAFT).set({ notes: 'wrapped twice' }).commit();
    await client.patch(PUB).set({
      shippingEmailSent: true, shippingEmailSentAt: new Date().toISOString(),
      status: 'dispatched', trackingNumber: 'TEST-TRK', carrier: 'ups',
    }).commit();
    await settle();
    const r = await guardedPublish({ client, publishedId: PUB });
    const a = await client.getDocument(PUB);
    ok(a.shippingEmailSent === true, 'a stale draft no longer turns shippingEmailSent back to false');
    ok(a.status === 'dispatched', '  nor status back to received', a.status);
    ok(a.trackingNumber === 'TEST-TRK' && a.carrier === 'ups', '  tracking and the written-back carrier stand');
    ok(a.notes === 'wrapped twice', '  and the operator\'s note is published', a.notes);
    ok(JSON.stringify(r.taken) === '["notes"]', '  reported as the one change taken', JSON.stringify(r.taken));
    ok(!(await client.getDocument(DRAFT)), '  the draft is gone, as after any publish');

    /* (b) Somebody writes the published order between our read and our commit. */
    say('');
    await startDraft();
    await client.patch(DRAFT).set({ notes: 'should not land' }).commit();
    await settle();
    let raced = null;
    try {
      await guardedPublish({
        client, publishedId: PUB,
        beforeCommit: async () => { await client.patch(PUB).set({ teamEmailError: 'written mid-publish' }).commit(); },
      });
    } catch (err) { raced = err; }
    const b = await client.getDocument(PUB);
    ok(raced instanceof PublishRefused && raced.raced === true, 'a revision change mid-publish is refused',
      raced && raced.message);
    ok(/Nothing was written/.test(raced?.message || ''), '  saying nothing was written');
    ok(b.teamEmailError === 'written mid-publish' && b.notes === 'wrapped twice',
      '  and nothing was: the concurrent write stands, the draft\'s note did not land', b.notes);
    ok(!!(await client.getDocument(DRAFT)), '  the draft is still there to try again');

    /* (c) The same field changed in both places. */
    say('');
    await client.delete(DRAFT);
    await startDraft();
    await client.patch(DRAFT).set({ status: 'cancelled' }).commit();
    await client.patch(PUB).set({ status: 'delivered' }).commit();
    await settle();
    let clash = null;
    try { await guardedPublish({ client, publishedId: PUB }); } catch (err) { clash = err; }
    const c = await client.getDocument(PUB);
    ok(clash instanceof PublishRefused && clash.conflicts?.[0]?.field === 'status',
      'status changed in the draft AND on the order is refused', clash && clash.message);
    ok(c.status === 'delivered', '  and the order keeps what it had', c.status);

    /* (d) The daily check, for real, against the dataset with this draft in it. */
    say('');
    const sent = [];
    const send = async (m) => { sent.push(m); return { data: { id: 'stub' } }; };
    const live0 = await runStaleDraftCheck({ sanity: client, send, log: quiet });
    ok(!live0.drafts?.some((d) => d._id === DRAFT), 'the live query does not report a draft minutes old');
    const live1 = await runStaleDraftCheck({ sanity: client, send, log: quiet, now: new Date(Date.now() + 25 * 3600_000) });
    ok(live1.drafts?.some((d) => d._id === DRAFT) && live1.sent === true,
      '  and does once it is over 24 hours untouched — one email', `${live1.found} found`);
    const others = (live1.drafts || []).filter((d) => d._id !== DRAFT);
    if (others.length) say(`  note: ${others.length} other draft(s) in the dataset: ${others.map((d) => d._id).join(', ')}`);
    void findStaleDrafts;
  } catch (err) {
    fail++;
    say(`\nTHREW: ${err.stack || err.message}`);
  } finally {
    for (const id of [DRAFT, PUB]) {
      try { await client.delete(id); } catch { /* may already be gone */ }
    }
    const left = await client.fetch('*[_id in [$a, $b]]._id', { a: PUB, b: DRAFT });
    say(`\nstub order ${left.length ? `STILL THERE: ${left.join(', ')}` : 'and its draft deleted, confirmed gone'}`);
    if (left.length) fail++;
  }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
