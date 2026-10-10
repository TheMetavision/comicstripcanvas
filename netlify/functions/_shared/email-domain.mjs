// Can this domain receive mail at all, and is it a throwaway inbox?
//
// Rejects:
//   - known disposable-mail domains, and domains whose mail servers are those
//     services' own (catches their many rotating alias domains);
//   - domains with no MX record, or a "null MX" (RFC 7505: "this domain accepts
//     no mail") -- typos and made-up domains.
//
// Allows when DNS itself fails (timeout, SERVFAIL): a resolver hiccup must not
// turn real sign-ups away; Turnstile and double opt-in still stand in front.
//
// This does not stop subscription bombing with real third-party addresses --
// those domains have perfectly good MX records. Turnstile, the rate limit and
// double opt-in do that; this keeps junk out of the list.
import { resolveMx } from 'node:dns/promises';

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'anonaddy.me',
  'burnermail.io', 'byom.de', 'deadaddress.com', 'discard.email', 'dispostable.com',
  'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com',
  'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'grr.la',
  'harakirimail.com', 'inboxbear.com', 'incognitomail.org', 'jetable.org',
  'mail-temp.com', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net',
  'mailinator2.com', 'mailnesia.com', 'mailpoof.com', 'mailsac.com', 'mintemail.com',
  'moakt.com', 'mohmal.com', 'mytemp.email', 'nada.email', 'sharklasers.com',
  'spam4.me', 'spambox.us', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org',
  'tempail.com', 'tempmail.dev', 'tempmail.net', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'tmail.ws', 'tmpmail.org', 'trashmail.com', 'trashmail.de',
  'trashmail.net', 'wegwerfmail.de', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
]);

// Mail servers belonging to disposable services. A domain whose MX points here
// is a throwaway alias even if the domain itself is not on the list above.
const DISPOSABLE_MX_SUFFIXES = [
  'mailinator.com', 'guerrillamail.com', 'yopmail.com', 'mail.tm', 'maildrop.cc',
  'mailsac.com', 'temp-mail.org', 'trashmail.com', 'dispostable.com', 'getnada.com',
];

const DNS_TIMEOUT_MS = 2500;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const endsWithDomain = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * Returns { ok: true } or { ok: false, reason } where reason is
 * 'disposable' | 'no-mx'. Never throws.
 */
export async function checkEmailDomain(email, { resolver = resolveMx } = {}) {
  const domain = String(email).split('@').pop().trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return { ok: false, reason: 'no-mx' };
  if ([...DISPOSABLE_DOMAINS].some((d) => endsWithDomain(domain, d))) {
    return { ok: false, reason: 'disposable' };
  }

  let records;
  try {
    records = await withTimeout(resolver(domain), DNS_TIMEOUT_MS);
  } catch (err) {
    // The domain does not exist, or exists with no MX: it cannot take mail.
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) return { ok: false, reason: 'no-mx' };
    console.warn('newsletter: MX lookup failed (allowing):', err?.code || err?.message || err);
    return { ok: true };
  }

  const hosts = (records || [])
    .map((r) => String(r.exchange || '').toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  // No usable host, or RFC 7505 null MX ("." / empty exchange): accepts no mail.
  if (hosts.length === 0) return { ok: false, reason: 'no-mx' };
  if (hosts.some((h) => DISPOSABLE_MX_SUFFIXES.some((s) => endsWithDomain(h, s)))) {
    return { ok: false, reason: 'disposable' };
  }
  return { ok: true };
}
