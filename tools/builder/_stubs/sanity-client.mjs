/**
 * Enough of @sanity/client to run the handlers, and nothing more.
 *
 * Documents live in a Map the test can read, so "did this actually store
 * anything" is a question the test can answer rather than infer from a 200.
 * Every query the handlers make is matched by shape; an unrecognised one
 * THROWS rather than returning null, because a stub that quietly answers
 * "nothing found" to a query it does not understand is how a test passes
 * while the thing it is testing does not work.
 */

export const docs = new Map();
export const queries = [];
export const failures = { create: false, patch: false };

export function reset() {
  docs.clear();
  queries.length = 0;
  failures.create = false;
  failures.patch = false;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** What `asset->url` would resolve to for a seeded file/image asset. */
const assetUrl = (asset) => {
  if (!asset) return null;
  if (asset.url) return asset.url;
  if (!asset._ref) return null;
  return `https://cdn.sanity.io/files/stub/production/${asset._ref}.png`;
};

/** Apply one patch operation set to a document, the way Sanity would. */
function applyPatch(doc, ops) {
  for (const [k, v] of Object.entries(ops.set || {})) setPath(doc, k, v);
  for (const [k, v] of Object.entries(ops.setIfMissing || {})) {
    if (doc[k] === undefined) doc[k] = clone(v);
  }
  for (const [k, v] of Object.entries(ops.inc || {})) doc[k] = (Number(doc[k]) || 0) + v;
  for (const path of ops.unset || []) unsetPath(doc, path);
  for (const [path, items] of ops.appends || []) {
    const key = path.split('[')[0];
    doc[key] = [...(doc[key] || []), ...clone(items)];
  }
}

/* The handlers address array members by predicate -- photos[panel == "art"].x
   -- so the stub has to understand that much of the path syntax or the writes
   it is meant to be checking would silently go nowhere. */
const MEMBER = /^(\w+)\[(\w+) == "([^"]+)"\](?:\.(\w+))?$/;

function setPath(doc, path, value) {
  const m = MEMBER.exec(path);
  if (!m) { doc[path] = clone(value); return; }
  const [, arr, field, want, prop] = m;
  const row = (doc[arr] || []).find((r) => r && r[field] === want);
  if (!row) return;
  if (prop) row[prop] = clone(value); else Object.assign(row, clone(value));
}

function unsetPath(doc, path) {
  const m = MEMBER.exec(path);
  if (m) {
    const [, arr, field, want, prop] = m;
    if (prop) {
      const row = (doc[arr] || []).find((r) => r && r[field] === want);
      if (row) delete row[prop];
    } else {
      doc[arr] = (doc[arr] || []).filter((r) => !(r && r[field] === want));
    }
    return;
  }
  const at = /^(\w+)\[@ == "([^"]+)"\]$/.exec(path);
  if (at) {
    const [, arr, want] = at;
    doc[arr] = (doc[arr] || []).filter((v) => v !== want);
    return;
  }
  delete doc[path];
}

function patchBuilder(id) {
  const ops = { set: {}, setIfMissing: {}, inc: {}, unset: [], appends: [] };
  const api = {
    set(o) { Object.assign(ops.set, o); return api; },
    setIfMissing(o) { Object.assign(ops.setIfMissing, o); return api; },
    inc(o) { Object.assign(ops.inc, o); return api; },
    /* dec, because the refund path uses it. Its absence did not throw anywhere
       visible -- the handler wraps its refund in a try/catch and logs -- so the
       count simply never came back and the test read it as a handler bug. */
    dec(o) {
      for (const [k, v] of Object.entries(o)) ops.inc[k] = -(Number(v) || 0);
      return api;
    },
    unset(paths) { ops.unset.push(...paths); return api; },
    append(path, items) { ops.appends.push([path, items]); return api; },
    ifRevisionId() { return api; },
    async commit() {
      if (failures.patch) throw new Error('stub: patch refused');
      const doc = docs.get(id);
      if (!doc) throw new Error(`stub: no document ${id} to patch`);
      applyPatch(doc, ops);
      doc._rev = `rev-${Math.random().toString(16).slice(2, 8)}`;
      return clone(doc);
    },
    _ops: ops,
    _id: id,
  };
  return api;
}

export function createClient() {
  return {
    async fetch(query, params = {}) {
      queries.push({ query, params });
      const q = query.replace(/\s+/g, ' ').trim();
      if (/^\*\[_id == \$id\]\[0\]/.test(q)) {
        const doc = docs.get(params.id);
        return doc ? clone(doc) : null;
      }
      if (/count\(photos\[styleStatus == "paused"\]\)/.test(q)) return [];

      /* checkout's three lookups. Projected out of the same documents a test
         seeds, rather than answered from a canned list -- otherwise the test
         would be asserting against its own fixture instead of against what the
         handler asks for. */
      const products = () => [...docs.values()].filter((d) => d._type === 'product');
      if (/_type == "product".*slug\.current in \$slugs/.test(q)) {
        const want = new Set(params.slugs || []);
        return products()
          .filter((p) => want.has(p.slug?.current))
          .map((p) => {
            const row = { slug: p.slug.current };
            if (/defined\(fullBleed\.printFile\.asset\)/.test(q)) {
              row.fullBleed = !!p.fullBleed?.printFile?.asset;
            }
            /* The webhook's print-file lookup, which dereferences the asset for
               its URL. Distinct from checkout's query above, which only asks
               whether a full-bleed file EXISTS -- matching on "->url" rather
               than "defined(" keeps the two apart. A seeded asset may carry an
               explicit url; otherwise one is derived from the ref, because what
               the handler does with the value is pass it on, not parse it. */
            if (/printFile\.asset->url/.test(q)) {
              row.classic = assetUrl(p.printFile?.asset);
              row.fullBleed = assetUrl(p.fullBleed?.printFile?.asset);
            }
            if (/images\[0\]\.asset\._ref/.test(q)) {
              row.classicListing = p.images?.[0]?.asset?._ref ?? null;
              row.fullBleedListing = p.fullBleed?.listingImage?.asset?._ref ?? null;
            }
            /* The orientation the size label is built from. Projected off the
               seeded asset's own metadata, so a test that wants a landscape
               product says so by seeding a landscape image rather than by
               setting a flag this stub invented. */
            if (/metadata\.dimensions\.aspectRatio/.test(q)) {
              row.aspect = p.images?.[0]?.asset?.metadata?.dimensions?.aspectRatio ?? null;
              row.fbAspect =
                p.fullBleed?.listingImage?.asset?.metadata?.dimensions?.aspectRatio ?? null;
            }
            if (/personalisationFee/.test(q)) row.personalisationFee = p.personalisationFee;
            return row;
          });
      }
      /* The print-file renderer's two reads: one order by id, then the product
         that line is for, by slug. Projected off the seeded documents like
         every other branch here. */
      if (/_type == "order" && _id == \$id/.test(q)) {
        const doc = docs.get(params.id);
        return doc && doc._type === 'order' ? clone(doc) : null;
      }
      if (/_type == "product" && slug\.current == \$slug/.test(q)) {
        const p = products().find((d) => d.slug?.current === params.slug);
        if (!p) return null;
        return {
          _id: p._id,
          title: p.title ?? null,
          slug: p.slug?.current ?? null,
          edgeColour: p.edgeColour ?? null,
          classicSceneId: p.classicSceneId ?? null,
          fbSceneId: p.fullBleed?.sceneId ?? null,
          printUrl: p.printFile?.asset?.url ?? null,
          printAssetId: p.printFile?.asset?._ref ?? null,
          fullBleedPrintUrl: p.fullBleed?.printFile?.asset?.url ?? null,
          fullBleedAssetId: p.fullBleed?.printFile?.asset?._ref ?? null,
          aspect: p.images?.[0]?.asset?.metadata?.dimensions?.aspectRatio ?? null,
          fbAspect: p.fullBleed?.listingImage?.asset?.metadata?.dimensions?.aspectRatio ?? null,
        };
      }
      if (/_type == "order" && _id in \$ids/.test(q)) {
        const want = new Set(params.ids || []);
        return [...docs.values()]
          .filter((d) => d._type === 'order' && want.has(d._id))
          .map((o) => ({
            _id: o._id, status: o.status ?? null,
            shippingEmailSentAt: o.shippingEmailSentAt ?? null,
          }));
      }
      if (/_type == "pendingPersonalisation" && _id in \$ids/.test(q)) {
        const want = new Set(params.ids || []);
        return [...docs.values()]
          .filter((d) => d._type === 'pendingPersonalisation' && want.has(d._id))
          .map((b) => ({
            _id: b._id,
            kind: b.kind ?? null,
            productId: b.productId ?? null,
            artworkStyle: b.artworkStyle ?? null,
            /* The joined subquery: the customiseFee off the PRODUCT the build
               was made from, which is where checkout reads it. */
            customiseFee: products().find((p) => p._id === b.productId)?.customiseFee ?? null,
          }));
      }

      /* retention's two reads. The orphan sweep asks for nothing but the ids,
         and the document sweep joins each build to its order for the dispatch
         date -- both projected from the same seeded documents. */
      const builds = () => [...docs.values()].filter((d) => d._type === 'pendingPersonalisation');
      if (/^\*\[_type == "pendingPersonalisation"\]\._id$/.test(q)) {
        return builds().map((d) => d._id);
      }
      if (/^\*\[_type == "pendingPersonalisation"\]\{/.test(q)) {
        return builds().map((d) => {
          const order = d.orderId ? docs.get(d.orderId) : null;
          return {
            _id: d._id,
            _createdAt: d._createdAt ?? null,
            status: d.status ?? null,
            orderId: d.orderId ?? null,
            orderStatus: order?.status ?? null,
            orderDispatchedAt: order?.shippingEmailSentAt ?? null,
          };
        });
      }

      throw new Error(`stub: no answer for query ${q.slice(0, 160)}`);
    },
    async create(doc) {
      if (failures.create) throw new Error('stub: create refused');
      if (docs.has(doc._id)) {
        /* The shape Sanity actually returns for a duplicate, because the
           webhook's concurrent-delivery branch keys off statusCode 409 and
           would otherwise never be reachable in a test. */
        const err = new Error(`Document by ID "${doc._id}" already exists`);
        err.statusCode = 409;
        throw err;
      }
      docs.set(doc._id, { ...clone(doc), _rev: 'rev-1' });
      return clone(docs.get(doc._id));
    },
    async getDocument(id) {
      const doc = docs.get(id);
      return doc ? clone(doc) : undefined;
    },
    async createIfNotExists(doc) {
      if (!docs.has(doc._id)) docs.set(doc._id, { ...clone(doc), _rev: 'rev-1' });
      return clone(docs.get(doc._id));
    },
    /* The second argument is Sanity's patch options -- ifRevisionID for the
       order-number counter. Honoured rather than ignored: the retry loop around
       it only means anything if a stale revision can actually be refused. */
    patch(id, opts = {}) {
      const p = patchBuilder(id);
      if (opts.ifRevisionID) {
        const commit = p.commit;
        p.commit = async () => {
          const doc = docs.get(id);
          if (doc && doc._rev !== opts.ifRevisionID) {
            const err = new Error('stub: revision mismatch');
            err.statusCode = 409;
            throw err;
          }
          return commit();
        };
      }
      return p;
    },
    transaction() {
      const patches = [];
      const tx = {
        patch(id, fn) { patches.push(fn(patchBuilder(id))); return tx; },
        async commit() {
          for (const p of patches) await p.commit();
          return patches.length;
        },
      };
      return tx;
    },
    async delete(id) { docs.delete(id); },
  };
}
