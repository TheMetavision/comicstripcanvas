/**
 * Publishing an order draft without undoing what the server wrote meanwhile.
 *
 * THE PROBLEM
 * -----------
 * Sanity's Publish replaces the published document with the draft, whole. The
 * server only ever writes to the PUBLISHED order -- the shipping webhook sets
 * shippingEmailSent and writes the carrier back, the Stripe webhook records
 * email failures -- and none of that reaches a draft opened before it. Publish
 * that draft and every one of those writes is rolled back: shippingEmailSent
 * goes back to false, and the next save that touches the order can send the
 * customer a second shipping email.
 *
 * THE RULE
 * --------
 * Only six fields belong to whoever is editing (OPERATOR_FIELDS). Everything
 * else comes from the published order as it is NOW, read at the moment of
 * publishing -- including fields added after this was written, which is why
 * the rule names what the operator owns rather than what the server owns.
 *
 * The six are merged three ways against BASE, the published order as it was
 * when this draft was created:
 *
 *   draft == base                  untouched here; the published value stands
 *   draft != base, published == base   changed here only; the draft's value wins
 *   draft == published             both agree; nothing to decide
 *   otherwise                      changed in both places -- refuse, and say which
 *
 * That third row matters for carrier, which the operator sets and the shipping
 * webhook also writes. Without a base, a draft holding the old carrier and a
 * draft deliberately changing it look identical, so a publish with no base it
 * can trust refuses rather than guess.
 *
 * Then ONE transaction: the merged document replaces the draft and is
 * published with ifPublishedRevisionId set to the revision read above. If
 * anything wrote the published order in between, the whole transaction fails
 * and nothing is written.
 *
 * Plain JavaScript and no Node built-ins: the Studio bundles this for the
 * browser, and tools/builder/guarded-publish-tests.mjs runs the same file.
 */

export const OPERATOR_FIELDS = [
  'status', 'trackingNumber', 'carrier', 'carrierOverride', 'carrierOther', 'notes',
];

const SYSTEM = new Set(['_id', '_rev', '_createdAt', '_updatedAt']);

/** Order-insensitive JSON, with absent and null treated alike. */
const stable = (v) => (v === undefined || v === null ? 'null' : JSON.stringify(v, (k, x) => (
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
    : x
)));
export const same = (a, b) => stable(a) === stable(b);

/**
 * The document to publish.
 *
 * @param {object} p
 * @param {object} p.draft      the draft as it is now
 * @param {object} p.published  the published order as it is now
 * @param {object|null|undefined} p.base  published order when the draft was
 *   created; null if there was no published order then, undefined if unknown
 * @returns {{ doc: object, taken: string[], conflicts: object[], blind: string[] }}
 *   taken      operator fields whose value comes from the draft
 *   conflicts  fields changed in both places -- publishing must not go ahead
 *   blind      fields the draft changes but no base could vouch for
 */
export function mergeForPublish({ draft, published, base }) {
  const doc = {};
  for (const [k, v] of Object.entries(published || {})) {
    if (!SYSTEM.has(k)) doc[k] = v;
  }
  doc._type = (published && published._type) || draft._type;

  const taken = [];
  const conflicts = [];
  const blind = [];
  for (const f of OPERATOR_FIELDS) {
    const d = draft[f];
    const p = published ? published[f] : undefined;
    if (same(d, p)) continue;                         // nothing to decide
    if (base === undefined) { blind.push(f); continue; }
    const b = base ? base[f] : undefined;
    if (same(d, b)) continue;                         // untouched in the draft
    if (same(p, b)) {                                 // changed in the draft only
      if (d === undefined || d === null) delete doc[f];
      else doc[f] = d;
      taken.push(f);
      continue;
    }
    conflicts.push({ field: f, draft: d ?? null, published: p ?? null, base: b ?? null });
  }
  return { doc, taken, conflicts, blind };
}

/* ------------------------------------------------------------------ history */

const CREATES = ['create', 'createOrReplace', 'createIfNotExists'];

/** Transactions on one document, newest first, from the History API. */
export async function draftTransactions(client, draftId, limit = 200) {
  const { dataset } = client.config();
  const raw = await client.request({
    uri: `/data/history/${dataset}/transactions/${encodeURIComponent(draftId)}`,
    query: { excludeContent: 'true', reverse: 'true', limit: String(limit) },
  });
  /* NDJSON: the client hands it back as text because it is not one JSON value. */
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

/** A document as it was at a moment, or null if it did not exist then. */
export async function docAt(client, id, time) {
  const { dataset } = client.config();
  const res = await client.request({
    uri: `/data/history/${dataset}/documents/${encodeURIComponent(id)}`,
    query: { time },
  });
  return (res && Array.isArray(res.documents) && res.documents[0]) || null;
}

const justBefore = (iso) => new Date(Date.parse(iso) - 1).toISOString();

/**
 * The published order as it was when this draft came into being.
 *
 * The draft's own transactions are walked newest first to the one that created
 * it. A create or createOrReplace always does; a createIfNotExists only did if
 * the draft did not exist just before it -- the Studio sends one with edits it
 * makes long after the draft exists. A draft deleted and started again is
 * found at its LATEST start, which is the one its content descends from.
 *
 * @returns {{ base: object|null|undefined, createdAt?: string, why?: string }}
 *   base undefined means it could not be established; `why` says why.
 */
export async function findDraftBase({ client, draftId, publishedId, deps = {} }) {
  const listTx = deps.draftTransactions || ((id) => draftTransactions(client, id));
  const at = deps.docAt || ((id, t) => docAt(client, id, t));
  let txs;
  try {
    txs = await listTx(draftId);
  } catch (err) {
    return { base: undefined, why: `the draft's history could not be read (${err.message})` };
  }
  for (const tx of txs) {
    const mine = (tx.mutations || []).filter((m) => {
      const [kind] = Object.keys(m);
      return CREATES.includes(kind) && m[kind] && m[kind]._id === draftId;
    });
    if (!mine.length) continue;
    const kind = Object.keys(mine[0])[0];
    if (kind === 'createIfNotExists') {
      const existed = await at(draftId, justBefore(tx.timestamp));
      if (existed) continue;
    }
    return { base: await at(publishedId, tx.timestamp), createdAt: tx.timestamp };
  }
  return {
    base: undefined,
    why: txs.length >= 200
      ? 'the draft has more history than can be searched for its starting point'
      : 'no transaction that created this draft was found',
  };
}

/* ------------------------------------------------------------------ publish */

export class PublishRefused extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PublishRefused';
    Object.assign(this, details);
  }
}

const describe = (v) => (v === null || v === undefined ? '(empty)' : JSON.stringify(v));

/**
 * Publish an order's draft by the rule above. Resolves with what was taken
 * from the draft; rejects with PublishRefused, whose message is written for
 * the person who pressed the button.
 *
 * @param {object} p
 * @param {object} p.client       a client that can read drafts and history
 * @param {string} p.publishedId  e.g. order.cs_live_...
 * @param {Function} [p.beforeCommit]  test hook, called after every read and
 *   before the transaction -- where a concurrent write would land
 */
export async function guardedPublish({ client, publishedId, beforeCommit, deps }) {
  const draftId = `drafts.${publishedId}`;
  const [draft, published] = await Promise.all([
    client.getDocument(draftId),
    client.getDocument(publishedId),
  ]);
  if (!draft) throw new PublishRefused('There are no unpublished changes on this order.');
  if (!published) {
    throw new PublishRefused(
      'This order has no published version. Orders are created by the payment webhook, '
      + 'never in the Studio -- discard this draft.');
  }

  const { base, why } = await findDraftBase({ client, draftId, publishedId, deps });
  const { doc, taken, conflicts, blind } = mergeForPublish({ draft, published, base });

  if (conflicts.length) {
    throw new PublishRefused(
      `Not published: ${conflicts.map((c) => c.field).join(', ')} changed on the order while `
      + 'this draft was open. '
      + conflicts.map((c) => `${c.field} is now ${describe(c.published)}, this draft says ${describe(c.draft)}`).join('; ')
      + '. Discard this draft, reopen the order and make the change again.',
      { conflicts });
  }
  if (blind.length) {
    throw new PublishRefused(
      `Not published: could not tell whether ${blind.join(', ')} was changed in this draft or `
      + `on the order since (${why}). Discard this draft and make the change again.`,
      { blind });
  }

  if (beforeCommit) await beforeCommit();

  try {
    await client.action([
      {
        actionType: 'sanity.action.document.version.replace',
        document: { ...doc, _id: draftId },
      },
      {
        actionType: 'sanity.action.document.publish',
        versionId: draftId,
        publishedId,
        ifPublishedRevisionId: published._rev,
      },
    ]);
  } catch (err) {
    const status = err && (err.statusCode || err.response?.statusCode);
    if (status === 409 || /revision/i.test((err && err.message) || '')) {
      throw new PublishRefused(
        'Not published: the order changed while it was being published (something else saved '
        + 'it at the same moment). Nothing was written. Press Publish again.',
        { raced: true });
    }
    throw err;
  }
  return { taken, kept: OPERATOR_FIELDS.filter((f) => !taken.includes(f)) };
}
