/**
 * Enough of @netlify/blobs to run the handlers.
 *
 * One Map per store name, and working etags, so the spend guard's
 * compare-and-swap takes its real path rather than the degraded one it falls
 * back to when a store reports no etag.
 */

export const stores = new Map();

export function reset() { stores.clear(); }

/** Everything written to one store, for a test to assert against. */
export const dump = (name) => Object.fromEntries(
  [...(stores.get(name) || new Map()).entries()].map(([k, v]) => [k, v.value])
);

export function getStore(nameOrOpts) {
  const name = typeof nameOrOpts === 'string' ? nameOrOpts : (nameOrOpts?.name || 'default');
  if (!stores.has(name)) stores.set(name, new Map());
  const data = stores.get(name);
  let seq = 0;

  const read = (key) => data.get(key) || null;

  return {
    name,
    async get(key, opts = {}) {
      const e = read(key);
      if (!e) return null;
      if (opts.type === 'json') return JSON.parse(e.value);
      if (opts.type === 'arrayBuffer') {
        return e.value instanceof ArrayBuffer ? e.value : new TextEncoder().encode(String(e.value)).buffer;
      }
      return e.value;
    },
    async getWithMetadata(key, opts = {}) {
      const e = read(key);
      if (!e) return null;
      return {
        data: opts.type === 'json' ? JSON.parse(e.value) : e.value,
        etag: e.etag,
        metadata: e.metadata || {},
      };
    },
    async set(key, value, opts = {}) {
      data.set(key, { value, etag: `etag-${++seq}`, metadata: opts.metadata || {} });
      return { modified: true };
    },
    async setJSON(key, value, cond = {}) {
      const e = read(key);
      if (cond.onlyIfNew && e) return { modified: false };
      if (cond.onlyIfMatch && (!e || e.etag !== cond.onlyIfMatch)) return { modified: false };
      data.set(key, { value: JSON.stringify(value), etag: `etag-${++seq}`, metadata: {} });
      return { modified: true };
    },
    async delete(key) { data.delete(key); },
    async list({ prefix } = {}) {
      return {
        blobs: [...data.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((key) => ({ key, etag: data.get(key).etag })),
      };
    },
  };
}
