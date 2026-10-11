// Time limits for every outside call the newsletter functions make, and a
// per-request timing line for the function log.
//
// Why budgets and not just request timeouts: the Netlify Blobs client retries
// a failed or 5xx request after a fixed 5-second sleep, up to five times, so a
// slow Blobs edge turned one rate-limit check into 5, 10, 15 seconds. A
// timeout on each request does not stop that (a timed-out request is retried
// too); a budget on the whole operation does.
//
// What happens when a limit is hit is decided by the caller and is unchanged:
// Turnstile and the MailerLite lookup fail closed, Blobs and DNS fail open.

export const LIMITS_MS = {
  turnstile: 4000,
  mailerlite: 4000,
  resend: 4000,
  mx: 2000,
  blobsRequest: 2000,   // each request the Blobs client makes
  blobsOp: 2500,        // a whole rate-limit check or token spend, retries included
};

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} took longer than ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEOUT';
  }
}

/** fetch with a hard deadline: rejects with a TimeoutError once `ms` passes. */
export async function fetchWithTimeout(url, init = {}, ms, label = 'request') {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new TimeoutError(label, ms);
    throw err;
  }
}

/** A fetch for the Blobs client, so no single request it makes can hang. */
export const blobsFetch = (url, init = {}) =>
  fetchWithTimeout(url, init, LIMITS_MS.blobsRequest, 'blobs request');

/** Settle with `promise`, or reject with a TimeoutError after `ms`. */
export function withinBudget(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Step timings for one request, logged as a single line with no visitor data:
 *   [subscribe] timing total=840ms turnstile=210ms ip=95ms mx=40ms lookup=380ms ...
 */
export function stopwatch(tag) {
  const start = Date.now();
  const steps = [];
  return {
    /** Time a promise under `name`, passing its result (or error) through. */
    async time(name, promise) {
      const t0 = Date.now();
      try {
        return await promise;
      } finally {
        steps.push(`${name}=${Date.now() - t0}ms`);
      }
    },
    note(text) {
      steps.push(text);
    },
    log(outcome) {
      console.info(`${tag} timing total=${Date.now() - start}ms ${steps.join(' ')}${outcome ? ` -> ${outcome}` : ''}`);
    },
  };
}
