/**
 * netlify/functions/newsletter.mts -- /api/newsletter (routed by netlify.toml;
 * no config.path here, see CLAUDE.md).
 *
 * Newsletter sign-up, hardened against subscription bombing (bots signing real
 * third-party addresses up to many lists to bury them in confirmation mail).
 * In order, cheapest first:
 *
 *   1. Honeypot (`csc_nl_extra` must be empty) -- a bot that fills it is told
 *      it succeeded and nothing happens.
 *   2. Time on page: under MIN_SUBMIT_MS between the form rendering and the
 *      submit is a script. Missing timestamps do not trip it (a direct POST
 *      sends none; Turnstile is the defence there).
 *   3. Cloudflare Turnstile, verified server-side. No secret configured means
 *      the endpoint is closed (503), never open.
 *   4. Email format.
 *   5. Per-IP rate limit: 3 sign-ups per hour, in Netlify Blobs (hashed IP).
 *   6. Domain check: disposable-mail domains and domains with no MX refused.
 *   7. MailerLite, with double opt-in -- see subscribe() below.
 *
 * Every accepted request gets the same answer, whether the address was new,
 * already subscribed, unconfirmed or unsubscribed, so the endpoint cannot be
 * used to find out who is on the list.
 *
 * Env vars: MAILERLITE_API_KEY, MAILERLITE_GROUP_ID, TURNSTILE_SECRET_KEY
 * (TURNSTILE_SITE_KEY is read at build time by NewsletterSignup.astro).
 */
import type { Context } from "@netlify/functions";
import { verifyTurnstile } from "./_shared/turnstile.mjs";
import { hashKey, takeSlot } from "./_shared/rate-limit.mjs";
import { checkEmailDomain } from "./_shared/email-domain.mjs";

const MIN_SUBMIT_MS = 3000;
const IP_LIMIT = 3;
const IP_WINDOW_MS = 60 * 60 * 1000;
const RATE_STORE = "newsletter-rate-limits";
const HONEYPOT = "csc_nl_extra";
const ML = "https://connect.mailerlite.com/api";

// One answer for every accepted request (see above).
const ACCEPTED = {
  success: true,
  message: "Thanks! If you're new here, check your inbox for a link to confirm your subscription.",
};
const FAILED = "Something went wrong. Please try again.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function clientIp(req: Request, context: Context): string {
  const xff = req.headers.get("x-forwarded-for");
  return (
    (context as any)?.ip ||
    req.headers.get("x-nf-client-connection-ip") ||
    (xff ? xff.split(",")[0].trim() : "") ||
    "unknown"
  );
}

/**
 * Double opt-in, without letting the form be turned against existing
 * subscribers. MailerLite sends its confirmation email when a subscriber is
 * created with status "unconfirmed" (needs "Double opt-in for API and
 * integrations" ON in Subscribe settings). But sending "unconfirmed" for an
 * EXISTING active or unsubscribed subscriber also re-sends that email and
 * resets them to unconfirmed -- so the address is looked up first:
 *
 *   not found     -> created unconfirmed in the group; MailerLite emails them
 *   active        -> added to the group if missing (status untouched)
 *   unconfirmed   -> nothing: they already have a confirmation email; sending
 *                    another on every submit is exactly the bombing to stop
 *   unsubscribed, bounced, junk -> nothing: never resubscribed from a form
 *
 * Returns true when MailerLite answered as expected.
 */
async function subscribe(apiKey: string, groupId: string, email: string): Promise<boolean> {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };

  const found = await fetch(`${ML}/subscribers/${encodeURIComponent(email)}`, { headers });
  let existing: any = null;
  if (found.status === 200) {
    existing = (await found.json().catch(() => null))?.data ?? null;
  } else if (found.status !== 404) {
    console.error("MailerLite lookup failed:", found.status, await found.text().catch(() => ""));
    return false;
  }

  let payload: Record<string, unknown> | null = null;
  if (!existing) {
    payload = { email, groups: [groupId], status: "unconfirmed" };
  } else if (existing.status === "active") {
    const inGroup = (existing.groups || []).some((g: any) => String(g?.id) === String(groupId));
    if (!inGroup) payload = { email, groups: [groupId] };
  }
  if (!payload) {
    console.info("newsletter: existing subscriber, status", existing?.status, "- nothing sent");
    return true;
  }

  const res = await fetch(`${ML}/subscribers`, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    console.error("MailerLite API error:", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);

  // 1. Honeypot: only a non-empty string trips it.
  if (typeof body[HONEYPOT] === "string" && body[HONEYPOT].trim()) {
    console.warn("newsletter bot signal: honeypot filled - discarded");
    return json(ACCEPTED);
  }

  // 2. Time on page, from the visitor's own clock (no client/server skew).
  const elapsed = Number(body.csc_nl_ts_submit) - Number(body.csc_nl_ts_load);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_SUBMIT_MS) {
    console.warn(`newsletter bot signal: submitted ${elapsed}ms after load - discarded`);
    return json(ACCEPTED);
  }

  // 3. Turnstile.
  const secret = Netlify.env.get("TURNSTILE_SECRET_KEY") || "";
  if (!secret) {
    console.error("newsletter misconfigured: TURNSTILE_SECRET_KEY is not set");
    return json({ error: "Sign-up is temporarily unavailable. Please try again later." }, 503);
  }
  const token = String(body.turnstileToken || body["cf-turnstile-response"] || "").slice(0, 2048);
  if (!token) return json({ error: "Please complete the anti-spam check and try again." }, 400);
  const ip = clientIp(req, context);
  const verdict = await verifyTurnstile(secret, token, ip);
  if (!verdict.ok) return json({ error: verdict.error }, verdict.status);

  // 4. Format.
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  if (!email) return json({ error: "Email is required." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email address." }, 400);

  // 5. Per IP, hashed with the day so it is never stored raw.
  const day = new Date().toISOString().slice(0, 10);
  if (!(await takeSlot(RATE_STORE, hashKey("ip", ip, day), IP_LIMIT, IP_WINDOW_MS))) {
    return json({ error: "Too many sign-ups from your connection. Please try again later." }, 429);
  }

  // 6. Domain.
  const domain = await checkEmailDomain(email);
  if (!domain.ok) {
    return json(
      {
        error:
          domain.reason === "disposable"
            ? "Please use a permanent email address, not a disposable one."
            : "That email domain can't receive mail. Please check the address.",
      },
      400,
    );
  }

  // 7. MailerLite.
  const apiKey = Netlify.env.get("MAILERLITE_API_KEY");
  const groupId = Netlify.env.get("MAILERLITE_GROUP_ID");
  if (!apiKey || !groupId) {
    console.error("Missing MAILERLITE_API_KEY or MAILERLITE_GROUP_ID env vars");
    return json({ error: FAILED }, 500);
  }
  try {
    if (!(await subscribe(apiKey, groupId, email))) return json({ error: FAILED }, 502);
  } catch (err: any) {
    console.error("Newsletter function error:", err?.message || err);
    return json({ error: FAILED }, 502);
  }
  return json(ACCEPTED);
};
