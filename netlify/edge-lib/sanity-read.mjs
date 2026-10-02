/**
 * One published-content read, from the edge -- tokenless unless given one.
 *
 * Products are public and are read without credentials. A pendingPersonalisation
 * is not: it lives at a dotted _id (pendingPersonalisation.<ref>), which anonymous
 * reads do not return, so its caller passes a read-only token (SANITY_READ_TOKEN).
 * The history below explains why the photo route once held no secret at all.
 *
 * Both image routes need a document before they know which blob to serve: the
 * product says which scene its artwork came from, the personalisation says
 * which key holds a panel's photo. Neither needs a token — the production
 * dataset is publicly readable, which is the same route src/lib/sanity.ts and
 * the customer builder already take, and was confirmed against both document
 * types before this was written.
 *
 * That matters more here than it looks. The function this replaces for the
 * photo route passed SANITY_WRITE_TOKEN to its client, to run a query that
 * needs no token at all. Moving the read to the edge without it means the edge
 * runtime holds no secret, so there is nothing here to leak and nothing to
 * rotate.
 *
 * useCdn is off for the same reason src/lib/sanity.ts turns it off: the CDN
 * lags a publish, and a stale answer here is a 404 on artwork that exists.
 */

const PROJECT = 'lwbwahym';
const DATASET = 'production';

/** @returns the query result, or null if anything at all went wrong. */
export async function sanityQuery(query, params = {}, { timeoutMs = 4000, fetchImpl = fetch, token = '' } = {}) {
  const url = new URL(`https://${PROJECT}.api.sanity.io/v2021-10-21/data/query/${DATASET}`);
  url.searchParams.set('query', query);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v));

  /* A hung read must not hold a request open: the caller's answer to "no
     document" is a 404, and arriving at it late is worse than arriving early. */
  const stop = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    const res = await fetchImpl(url.toString(), { signal: stop, headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.result ?? null;
  } catch {
    return null;
  }
}
