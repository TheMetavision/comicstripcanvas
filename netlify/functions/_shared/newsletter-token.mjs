// The newsletter confirmation link's token.
//
// It carries everything the confirm step needs -- the address, an expiry and a
// random nonce -- so nothing about the subscriber is stored while they decide.
// The payload is encrypted and authenticated with AES-256-GCM under a key
// derived (HMAC-SHA256) from NEWSLETTER_CONFIRM_SECRET: the address never
// appears readable in a URL, a server log or a Referer header, and any change
// to the token fails authentication. Single use is enforced separately, by a
// record of the spent nonce (see newsletter-confirm.mts), which holds no
// subscriber data.
//
// Format: v1.<iv>.<ciphertext+tag>, base64url.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;

const keyFor = (secret) => createHmac('sha256', String(secret)).update('csc-newsletter-confirm:v1').digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function makeToken(secret, email, now = Date.now()) {
  const nonce = b64u(randomBytes(16));
  const payload = JSON.stringify({ e: email, x: now + CONFIRM_TTL_MS, n: nonce });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { token: `v1.${b64u(iv)}.${b64u(body)}`, nonce, expiresAt: now + CONFIRM_TTL_MS };
}

/**
 * Returns { ok: true, email, nonce, expiresAt } or { ok: false, reason } where
 * reason is 'invalid' (malformed, tampered, wrong secret) or 'expired'.
 */
export function readToken(secret, token, now = Date.now()) {
  try {
    const [v, ivPart, bodyPart] = String(token || '').split('.');
    if (v !== 'v1' || !ivPart || !bodyPart) return { ok: false, reason: 'invalid' };
    const iv = Buffer.from(ivPart, 'base64url');
    const body = Buffer.from(bodyPart, 'base64url');
    if (iv.length !== 12 || body.length < 17) return { ok: false, reason: 'invalid' };
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), iv);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const json = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
    const p = JSON.parse(json);
    if (typeof p.e !== 'string' || typeof p.x !== 'number' || typeof p.n !== 'string') return { ok: false, reason: 'invalid' };
    if (now > p.x) return { ok: false, reason: 'expired' };
    return { ok: true, email: p.e, nonce: p.n, expiresAt: p.x };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
