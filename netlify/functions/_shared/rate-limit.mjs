// Sliding-window limits kept in Netlify Blobs, so they hold across function
// instances (an in-memory count resets with every cold start). Each key holds
// the timestamps of recent hits; a hit is allowed while fewer than `limit`
// fall inside the window.
//
// Writes are conditional on the entry's ETag, so two requests racing cannot
// both take the last slot: the loser re-reads and counts again. Keys are
// SHA-256 hashes, never a raw IP or email address.
//
// If Blobs is unreachable the hit is allowed and the failure logged: a broken
// limiter must not block real sign-ups (Turnstile still stands in front).
// Losing the write race four times in a row is a burst, though, and is refused.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

export const hashKey = (...parts) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);

/**
 * Record a hit on `key` if it is within `limit` per `windowMs`.
 * Returns true when allowed (and recorded), false when over the limit.
 */
export async function takeSlot(storeName, key, limit, windowMs) {
  try {
    const store = getStore({ name: storeName, consistency: 'strong' });
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
      if (res.modified) return true;
    }
    console.warn('rate-limit: repeated write conflicts; refusing');
    return false;
  } catch (err) {
    console.warn('rate-limit check failed (continuing):', err?.message || err);
    return true;
  }
}
