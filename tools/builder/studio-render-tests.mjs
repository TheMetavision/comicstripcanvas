/**
 * Where a studio render is allowed to put the pictures, and what it leaves
 * behind when it cannot.
 *
 *   node tools/builder/studio-render-tests.mjs
 *
 * Two rules, both learned the same afternoon.
 *
 * A render attaches to the DRAFT, because publishing is a person's decision and
 * artwork nobody has looked at must not go live on its own. But publishing
 * CONSUMES the draft, so a product that has been published has no drafts.<id>
 * at all -- and the repair route exists precisely to re-render such products
 * months later. The patch threw, and it threw after the print master had been
 * written and two Sanity assets uploaded, so the render was half-done with
 * nothing anywhere saying so. Both published products in the cutoutClip
 * migration failed exactly this way and neither was flagged.
 *
 * So: create the draft from the published document, never write to the
 * published one, and if anything fails, write the reason where somebody will
 * find it.
 */
import { draftTargetFor, recordSceneError } from '../../netlify/functions/studio-render-background.mjs';
import { sceneRevOf } from '../../netlify/functions/_shared/order-print.mjs';
import { classify } from './render-sweep.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/** A Sanity stub that records every write, so "published untouched" is checkable. */
function fakeSanity(docs = {}) {
  const store = { ...docs };
  const writes = [];
  return {
    store, writes,
    async getDocument(id) { return store[id] ? { ...store[id] } : undefined; },
    async createIfNotExists(doc) {
      writes.push({ op: 'createIfNotExists', id: doc._id });
      if (!store[doc._id]) store[doc._id] = { ...doc, _rev: 'rev-new' };
      return store[doc._id];
    },
    patch(id) {
      const ops = { id, set: {}, unset: [] };
      const api = {
        setIfMissing() { return api; },
        set(v) { Object.assign(ops.set, v); return api; },
        unset(keys) { ops.unset.push(...keys); return api; },
        async commit() {
          if (!store[id]) throw new Error(`document ${id} does not exist`);
          writes.push({ op: 'patch', id, set: Object.keys(ops.set), unset: ops.unset });
          store[id] = { ...store[id], ...ops.set };
          for (const k of ops.unset) delete store[id][k];
          return store[id];
        },
      };
      return api;
    },
  };
}

const PUBLISHED = {
  _id: 'p1', _type: 'product', _rev: 'rev-published',
  title: 'Bruce Lee', slug: { current: 'bruce-lee-cover' }, price: 4900,
  images: [{ _key: 'listing', asset: { _ref: 'image-old' } }],
};

/* ───────────────────────────────── 1. published product, no draft */

say('\n1. A PUBLISHED PRODUCT WITH NO DRAFT\n');
{
  const sanity = fakeSanity({ p1: PUBLISHED });
  const { target, doc, created } = await draftTargetFor(sanity, 'drafts.p1');

  ok(target === 'drafts.p1', 'the target is the draft', target);
  ok(created === true, 'and it had to be made');
  ok(!!sanity.store['drafts.p1'], 'the draft now exists');
  ok(sanity.store['drafts.p1'].title === 'Bruce Lee' && sanity.store['drafts.p1'].price === 4900,
    'carrying the published content — the shop\'s own words are not lost');
  ok(sanity.store['drafts.p1']._rev !== 'rev-published',
    'without the published document\'s revision, which is not this document\'s');
  ok(doc && doc._id === 'drafts.p1', 'and the caller gets it back to patch');

  /* The whole point. */
  const touchedPublished = sanity.writes.filter((w) => w.id === 'p1');
  ok(touchedPublished.length === 0, 'the PUBLISHED document was not written to at all',
    JSON.stringify(sanity.writes));
  ok(sanity.store.p1._rev === 'rev-published', 'it still carries the revision it had');

  /* And the patch that follows lands, which is what used to throw. */
  await sanity.patch(target).set({ images: [{ _key: 'listing', asset: { _ref: 'image-new' } }] }).commit();
  ok(sanity.store['drafts.p1'].images[0].asset._ref === 'image-new', 'the pictures attach to the draft');
  ok(sanity.store.p1.images[0].asset._ref === 'image-old',
    'and the live product still shows what it showed before — Alan publishes');
}

/* ───────────────────────────────── 2. a draft already there */

say('\n2. A DRAFT THAT IS ALREADY THERE\n');
{
  /* Somebody is mid-edit: a new price and a retitled product, unpublished. */
  const draft = {
    _id: 'drafts.p1', _type: 'product', _rev: 'rev-draft',
    title: 'Bruce Lee — Enter the Dragon', slug: { current: 'bruce-lee-cover' }, price: 5400,
    images: [{ _key: 'listing', asset: { _ref: 'image-old' } }],
  };
  const sanity = fakeSanity({ p1: PUBLISHED, 'drafts.p1': draft });
  const { target, created } = await draftTargetFor(sanity, 'drafts.p1');

  ok(created === false, 'no draft is created');
  ok(!sanity.writes.some((w) => w.op === 'createIfNotExists'),
    'createIfNotExists is not even called');
  await sanity.patch(target).set({ images: [{ _key: 'listing', asset: { _ref: 'image-new' } }] }).commit();

  ok(sanity.store['drafts.p1'].title === 'Bruce Lee — Enter the Dragon',
    'the edit in progress survives the render');
  ok(sanity.store['drafts.p1'].price === 5400, 'including the price nobody has published yet');
  ok(sanity.store['drafts.p1'].images[0].asset._ref === 'image-new', 'and the new picture is on it');
  ok(sanity.store.p1.title === 'Bruce Lee', 'the published document is still untouched');
}

say('\n3. NEITHER DOCUMENT EXISTS\n');
{
  const sanity = fakeSanity({});
  let threw = null;
  await draftTargetFor(sanity, 'drafts.gone').catch((e) => { threw = e; });
  ok(!!threw, 'it refuses rather than inventing a product');
  ok(/no document to attach/.test(threw?.message || ''), 'and says why', threw?.message);
  ok(sanity.writes.length === 0, 'having written nothing');
}

/* ───────────────────────────────── 4. a render that dies partway */

say('\n4. A RENDER THAT DIES PARTWAY\n');

/** A blob store stub that keeps bytes and metadata the way Netlify Blobs does. */
function fakeStore(initial = {}) {
  const blobs = { ...initial };
  return {
    blobs,
    async get(key, opts) {
      const b = blobs[key];
      if (!b) return null;
      return opts?.type === 'json' ? JSON.parse(b.data) : b.data;
    },
    async getWithMetadata(key) {
      const b = blobs[key];
      return b ? { data: b.data, metadata: b.metadata } : null;
    },
    async getMetadata(key) {
      const b = blobs[key];
      return b ? { metadata: b.metadata } : null;
    },
    async set(key, data, opts) { blobs[key] = { data, metadata: (opts && opts.metadata) || {} }; },
  };
}

{
  /* A scene as a completed render leaves it: stamped with the rev of its own
     bytes, and marked as rendered. */
  const body = JSON.stringify({
    id: 'p1', docId: 'drafts.p1', style: 'classic', svg: '<svg/>',
    savedAt: '2026-09-13T13:54:48.418Z', renderedAt: '2026-09-13T13:55:09.211Z',
  });
  const key = 'studio/p1/classic/scene.json';
  const store = fakeStore({
    [key]: { data: body, metadata: { kind: 'scene', rendered: 'true', renderedRev: sceneRevOf(body) } },
  });

  const healthy = classify({
    savedAt: '2026-09-13T13:54:48.418Z', renderedAt: '2026-09-13T13:55:09.211Z',
    hasProduct: true, hasDraft: false, draftsKnown: true,
    rev: sceneRevOf(body), renderedRev: sceneRevOf(body), rendererWrote: true, renderError: null,
  });
  ok(healthy.mode === 'ok', 'before the failure the sweep is happy', healthy.mode);

  /* Now it dies where the migration's renders died: after the master, before
     the scene rewrite. */
  const wrote = await recordSceneError(store, key, body,
    new Error('neither drafts.p1 nor p1 exists — there is no document to attach the artwork to'));
  ok(wrote === true, 'the reason is written onto the scene');

  const after = await store.getWithMetadata(key);
  const scene = JSON.parse(after.data);
  ok(/no document to attach/.test(scene.renderError), 'the message is readable on the scene', scene.renderError);
  ok(!!scene.renderErrorAt, 'with when it happened');
  ok(after.metadata.renderedRev === sceneRevOf(body),
    'the stamp from the last GOOD render is kept, not overwritten by the failure');
  ok(after.metadata.renderError === 'true', 'and the metadata says there is a fault to find');

  const verdict = classify({
    savedAt: scene.savedAt, renderedAt: scene.renderedAt,
    hasProduct: true, hasDraft: false, draftsKnown: true,
    rev: sceneRevOf(after.data), renderedRev: after.metadata.renderedRev,
    rendererWrote: after.metadata.rendered === 'true', renderError: scene.renderError,
  });
  ok(verdict.mode === 'FAILED', 'and the sweep reports it', verdict.mode);
  ok(/no document to attach/.test(verdict.why), 'quoting the reason', verdict.why);

  /* Even with the message stripped out, the rev alone convicts it: the
     timestamps still look perfectly healthy. */
  const onRevAlone = classify({
    savedAt: scene.savedAt, renderedAt: scene.renderedAt,
    hasProduct: true, hasDraft: false, draftsKnown: true,
    rev: sceneRevOf(after.data), renderedRev: after.metadata.renderedRev,
    rendererWrote: true, renderError: null,
  });
  ok(onRevAlone.mode === 'STALE', 'a changed scene is STALE on the rev alone', onRevAlone.mode);
  ok(/savedAt/.test(onRevAlone.why) === false && /changed since it was rendered/.test(onRevAlone.why),
    'which is a different question from savedAt vs renderedAt', onRevAlone.why);
}

/* ─────────────────── 5. the two products that were actually missed */

say('\n5. THE TWO THE OLD RULE MISSED\n');
{
  /* Bruce Lee and Walter White as the migration left them: the scene rewritten
     at 18:13 on the 24th, the timestamps still those of the last good render,
     and the metadata gone because the migration wrote the blob without it. */
  for (const [name, savedAt, renderedAt] of [
    ['bruce-lee-cover', '2026-09-13T13:54:48.418Z', '2026-09-13T13:55:09.211Z'],
    ['walter-white', '2026-09-24T08:58:41.456Z', '2026-09-24T08:59:09.902Z'],
  ]) {
    const old = classify({
      savedAt, renderedAt, publishedAt: null, hasProduct: true, hasDraft: false, draftsKnown: true,
    });
    ok(old.mode === 'ok', `${name}: the OLD rule saw nothing wrong`, old.mode);

    const now = classify({
      savedAt, renderedAt, publishedAt: null, hasProduct: true, hasDraft: false, draftsKnown: true,
      rev: '110b93845ae2f570', renderedRev: null, rendererWrote: false, renderError: null,
    });
    ok(now.mode === 'STALE', `${name}: the new rule flags it`, `${now.mode} — ${now.why}`);
  }

  /* Bobby Moore, whose render did finish, must stay quiet. */
  const bobby = classify({
    savedAt: '2026-09-24T09:12:40.924Z', renderedAt: '2026-09-24T18:13:51.485Z',
    publishedAt: null, hasProduct: true, hasDraft: true, draftsKnown: true,
    rev: '511afb71833cf139', renderedRev: null, rendererWrote: true, renderError: null,
  });
  ok(bobby.mode === 'ok', 'bobby-moore, which did complete, is not flagged', bobby.mode);
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
