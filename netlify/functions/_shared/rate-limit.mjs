// Sliding-window limits kept in Netlify Blobs, so they hold across function
// instances (an in-memory count resets with every cold start). Each key holds
// the timestamps of recent hits; a hit is allowed while fewer than `limit`
// fall inside the window.
//
// Writes are conditional on the entry's ETag, so two requests racing cannot
// both take the last slot: the loser re-reads and counts again. Keys are
// SHA-256 hashes, never a raw IP or email address.
//
// If Blobs is unreachable, or slower than LIMITS_MS.blobsOp, the hit is allowed
// and the failure logged: a broken or slow limiter must not block real
// sign-ups (Turnstile still stands in front). Losing the write race four times
// in a row is a burst, though, and is refused.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { LIMITS_MS, blobsFetch, withinBudget } from './timing.mjs';

export const hashKey = (...parts) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);

const storeFor = (name) => getStore({ name, consistency: 'strong', fetch: blobsFetch });

async function take(storeName, key, limit, windowMs) {
  const store = storeFor(storeName);
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = Date.now();
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const hits = Array.isArray(entry?.data?.hits)
      ? entry.data.hits.filter((t) => typeof t === 'number' && t > now - windowMs)
      : [];
    if (hits.length >= limit) return false;
    hits.push(now);
    // Conditional on the ETag read. An entry with no ETag (the local
    // netlify dev sandbox sends none) gets a plain write: not race-proof,
    // but onlyIfNew would fail on it forever and lock everyone out.
    const res = await store.setJSON(
      key,
      { hits },
      entry?.etag ? { onlyIfMatch: entry.etag } : entry ? {} : { onlyIfNew: true },
    );
    if (res.modified) return now;
  }
  console.warn('rate-limit: repeated write conflicts; refusing');
  return false;
}

/**
 * Record a hit on `key` if it is within `limit` per `windowMs`.
 * Returns the hit's timestamp when allowed (truthy; pass it to releaseSlot to
 * give the slot back), false when over the limit, and true when the limiter
 * could not answer in time and the hit was let through.
 */
export async function takeSlot(storeName, key, limit, windowMs) {
  try {
    return await withinBudget(take(storeName, key, limit, windowMs), LIMITS_MS.blobsOp, 'rate-limit check');
  } catch (err) {
    console.warn('rate-limit check failed (continuing):', err?.message || err);
    return true;
  }
}

/**
 * Give back a slot taken by takeSlot (by the timestamp it returned), when what
 * it was taken for did not happen -- e.g. the confirmation email could not be
 * sent, so the visitor may try again without waiting out the window. Best
 * effort, within the same budget; a failure only means the slot stays taken.
 */
export async function releaseSlot(storeName, key, at) {
  if (typeof at !== 'number') return;
  try {
    await withinBudget((async () => {
      const store = storeFor(storeName);
      for (let attempt = 0; attempt < 4; attempt++) {
        const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
        if (!entry || !Array.isArray(entry.data?.hits) || !entry.data.hits.includes(at)) return;
        const hits = entry.data.hits.filter((t) => t !== at);
        const res = await store.setJSON(key, { hits }, entry.etag ? { onlyIfMatch: entry.etag } : {});
        if (res.modified) return;
      }
    })(), LIMITS_MS.blobsOp, 'rate-limit release');
  } catch (err) {
    console.warn('rate-limit release failed:', err?.message || err);
  }
}
