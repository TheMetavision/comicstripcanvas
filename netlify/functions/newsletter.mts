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
 *   5. Per-IP rate limit: 3 per hour, in Netlify Blobs (hashed IP). Every
 *      request that gets this far counts, confirmation email or not.
 *   6. Domain check: disposable-mail domains and domains with no MX refused.
 *   7. Our own double opt-in -- see below. Nothing is written to MailerLite
 *      here; the subscriber is created only by /api/newsletter-confirm.
 *
 * Double opt-in is ours, not MailerLite's account-wide "double opt-in for API"
 * (that sends one account-branded email for every brand on the account). The
 * address is looked up (read only) and:
 *
 *   already active in this brand's group  -> nothing
 *   unsubscribed, bounced or junk         -> nothing (never re-mailed from a form)
 *   anything else (new, unconfirmed, or
 *   active on another of the account's lists) -> a branded "Confirm your
 *     subscription" email via Resend, at most 1 per address per 24 hours,
 *     carrying a single-use link that expires in 48 hours
 *
 * Every accepted request gets the same answer, so the endpoint cannot be used
 * to find out who is on the list.
 *
 * Env vars: MAILERLITE_API_KEY, MAILERLITE_GROUP_ID, TURNSTILE_SECRET_KEY,
 * RESEND_API_KEY, NEWSLETTER_CONFIRM_SECRET; optional EMAIL_FROM (sender) and
 * URL (Netlify's own: the site address the link points at).
 * TURNSTILE_SITE_KEY is read at build time by NewsletterSignup.astro.
 */
import type { Context } from "@netlify/functions";
import { verifyTurnstile } from "./_shared/turnstile.mjs";
import { hashKey, takeSlot } from "./_shared/rate-limit.mjs";
import { checkEmailDomain } from "./_shared/email-domain.mjs";
import { makeToken } from "./_shared/newsletter-token.mjs";
import { confirmationEmail } from "./_shared/newsletter-email.mjs";

const MIN_SUBMIT_MS = 3000;
const IP_LIMIT = 3;
const IP_WINDOW_MS = 60 * 60 * 1000;
const ADDRESS_LIMIT = 1;
const ADDRESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_STORE = "newsletter-rate-limits";
const HONEYPOT = "csc_nl_extra";
const ML = "https://connect.mailerlite.com/api";
const DEFAULT_FROM = "Comic Strip Canvas <orders@comicstripcanvas.co.uk>";

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
 * Should this address get a confirmation email? Read only: never writes to
 * MailerLite. Returns true/false, or null when MailerLite could not answer.
 */
async function needsConfirmation(apiKey: string, groupId: string, email: string): Promise<boolean | null> {
  const res = await fetch(`${ML}/subscribers/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 404) return true;
  if (res.status !== 200) {
    console.error("MailerLite lookup failed:", res.status, await res.text().catch(() => ""));
    return null;
  }
  const sub = (await res.json().catch(() => null))?.data;
  const status = sub?.status;
  if (status === "unsubscribed" || status === "bounced" || status === "junk") return false;
  const inGroup = (sub?.groups || []).some((g: any) => String(g?.id) === String(groupId));
  if (status === "active" && inGroup) return false;
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
  const turnstileSecret = Netlify.env.get("TURNSTILE_SECRET_KEY") || "";
  if (!turnstileSecret) {
    console.error("newsletter misconfigured: TURNSTILE_SECRET_KEY is not set");
    return json({ error: "Sign-up is temporarily unavailable. Please try again later." }, 503);
  }
  const token = String(body.turnstileToken || body["cf-turnstile-response"] || "").slice(0, 2048);
  if (!token) return json({ error: "Please complete the anti-spam check and try again." }, 400);
  const ip = clientIp(req, context);
  const verdict = await verifyTurnstile(turnstileSecret, token, ip);
  if (!verdict.ok) return json({ error: verdict.error }, verdict.status);

  // 4. Format.
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  if (!email) return json({ error: "Email is required." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email address." }, 400);

  // Everything the rest needs, checked before the request counts against anyone.
  const apiKey = Netlify.env.get("MAILERLITE_API_KEY");
  const groupId = Netlify.env.get("MAILERLITE_GROUP_ID");
  const resendKey = Netlify.env.get("RESEND_API_KEY");
  const confirmSecret = Netlify.env.get("NEWSLETTER_CONFIRM_SECRET");
  if (!apiKey || !groupId || !resendKey || !confirmSecret) {
    console.error(
      "newsletter misconfigured: missing",
      [!apiKey && "MAILERLITE_API_KEY", !groupId && "MAILERLITE_GROUP_ID", !resendKey && "RESEND_API_KEY",
        !confirmSecret && "NEWSLETTER_CONFIRM_SECRET"].filter(Boolean).join(", "),
    );
    return json({ error: "Sign-up is temporarily unavailable. Please try again later." }, 503);
  }

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

  // 7. Double opt-in.
  try {
    const needed = await needsConfirmation(apiKey, groupId, email);
    if (needed === null) return json({ error: FAILED }, 502);
    if (!needed) {
      console.info("newsletter: already subscribed or opted out - nothing sent");
      return json(ACCEPTED);
    }

    // At most one confirmation per address per day, whichever IPs ask.
    if (!(await takeSlot(RATE_STORE, hashKey("addr", email), ADDRESS_LIMIT, ADDRESS_WINDOW_MS))) {
      console.info("newsletter: confirmation already sent to this address today - nothing sent");
      return json(ACCEPTED);
    }

    const site = (Netlify.env.get("URL") || new URL(req.url).origin).replace(/\/$/, "");
    const { token: confirmToken } = makeToken(confirmSecret, email);
    const mail = confirmationEmail({ confirmUrl: `${site}/newsletter/confirm/?t=${encodeURIComponent(confirmToken)}` });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Netlify.env.get("EMAIL_FROM") || DEFAULT_FROM,
        to: [email],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });
    if (!res.ok) {
      console.error("newsletter: confirmation email failed:", res.status, await res.text().catch(() => ""));
      return json({ error: FAILED }, 502);
    }
  } catch (err: any) {
    console.error("Newsletter function error:", err?.message || err);
    return json({ error: FAILED }, 502);
  }
  return json(ACCEPTED);
};
