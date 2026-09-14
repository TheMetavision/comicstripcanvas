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
      throw new Error(`stub: no answer for query ${q.slice(0, 120)}`);
    },
    async create(doc) {
      if (failures.create) throw new Error('stub: create refused');
      if (docs.has(doc._id)) throw new Error(`stub: ${doc._id} already exists`);
      docs.set(doc._id, { ...clone(doc), _rev: 'rev-1' });
      return clone(docs.get(doc._id));
    },
    patch(id) { return patchBuilder(id); },
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
