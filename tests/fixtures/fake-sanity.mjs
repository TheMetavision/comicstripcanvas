// An in-memory stand-in for @sanity/client, enough for the shipping functions:
// getDocument, fetch (by a small table of the queries they make), create, and
// patch with set / setIfMissing / unset / ifRevisionId. ifRevisionId really
// refuses a stale revision with a 409, so the once-only claims are tested
// against the same rule the Content Lake enforces.

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function setPath(doc, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = doc;
  for (const k of keys) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[last] = clone(value);
}

function unsetPath(doc, path) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = doc;
  for (const k of keys) { if (!o[k]) return; o = o[k]; }
  delete o[last];
}

export function fakeSanity(docs = [], { queries = {} } = {}) {
  const store = new Map();
  let rev = 0;
  const nextRev = () => `r${++rev}`;
  for (const d of docs) store.set(d._id, { ...clone(d), _rev: nextRev() });
  const writes = [];

  const client = {
    store,
    writes,
    async getDocument(id) {
      await Promise.resolve();
      return clone(store.get(id));
    },
    async create(doc) {
      if (store.has(doc._id)) throw Object.assign(new Error('Document already exists'), { statusCode: 409 });
      store.set(doc._id, { ...clone(doc), _rev: nextRev() });
      writes.push({ create: doc._id });
      return clone(store.get(doc._id));
    },
    async fetch(query, params = {}) {
      await Promise.resolve();
      for (const [re, fn] of Object.entries(queries)) {
        if (new RegExp(re).test(query)) return clone(fn([...store.values()], params));
      }
      throw new Error(`fakeSanity: no handler for query ${query}`);
    },
    patch(id) {
      const ops = [];
      let ifRev = null;
      const b = {
        ifRevisionId(r) { ifRev = r; return b; },
        set(obj) { ops.push(['set', obj]); return b; },
        setIfMissing(obj) { ops.push(['setIfMissing', obj]); return b; },
        unset(paths) { ops.push(['unset', paths]); return b; },
        async commit() {
          await Promise.resolve();
          const doc = store.get(id);
          if (!doc) throw Object.assign(new Error(`Document ${id} not found`), { statusCode: 404 });
          if (ifRev && doc._rev !== ifRev) {
            throw Object.assign(new Error(`Document ${id} has unexpected revision ID ("${doc._rev}"), expected "${ifRev}"`), { statusCode: 409 });
          }
          for (const [op, arg] of ops) {
            if (op === 'set') for (const [k, v] of Object.entries(arg)) setPath(doc, k, v);
            if (op === 'setIfMissing') for (const [k, v] of Object.entries(arg)) if (doc[k] === undefined) setPath(doc, k, v);
            if (op === 'unset') for (const p of arg) unsetPath(doc, p);
          }
          doc._rev = nextRev();
          writes.push({ patch: id, ops: clone(ops) });
          return clone(doc);
        },
      };
      return b;
    },
  };
  return client;
}

/** A Resend stand-in that records what was sent. */
export function fakeResend({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    emails: {
      async send(msg) {
        await Promise.resolve();
        if (fail) return { error: { name: 'validation_error', message: 'rejected' } };
        sent.push(msg);
        return { data: { id: `em_${sent.length}` } };
      },
    },
  };
}

export const quiet = { log() {}, warn() {}, error() {} };
