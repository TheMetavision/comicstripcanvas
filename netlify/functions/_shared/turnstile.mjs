/**
 * Verifies a Cloudflare Turnstile token (same rules as contact.mts).
 *
 * Returns { ok: true } on a pass, or { ok: false, status, error } describing how
 * to answer. A token Cloudflare rejects is the caller's problem (400); a
 * siteverify call that fails or takes longer than LIMITS_MS.turnstile is ours
 * (503, retryable) -- failing open there would hand every spammer a trivial
 * bypass.
 */
import { LIMITS_MS, fetchWithTimeout } from './timing.mjs';

export async function verifyTurnstile(secret, token, remoteIp) {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  let outcome;
  try {
    const res = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, LIMITS_MS.turnstile, 'turnstile siteverify');
    outcome = await res.json();
  } catch (err) {
    console.error('turnstile siteverify unreachable:', err && err.message);
    return {
      ok: false,
      status: 503,
      error: 'Could not run the anti-spam check right now. Please try again in a moment.',
    };
  }

  if (outcome && outcome.success) return { ok: true };

  console.warn('turnstile verification failed:', JSON.stringify(outcome && outcome['error-codes']));
  return {
    ok: false,
    status: 400,
    error: 'Anti-spam check failed. Please reload the page and try again.',
  };
}
