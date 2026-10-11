/**
 * netlify/functions/newsletter-confirm.mts -- /api/newsletter-confirm (routed
 * by netlify.toml; no config.path here, see CLAUDE.md).
 *
 * The second half of the newsletter's double opt-in. The confirmation email
 * links to the page /newsletter/confirm/?t=..., whose button POSTs the token
 * here. Only the POST subscribes anyone: mail scanners (Outlook Safe Links and
 * the like) fetch links in emails on their own, and a GET that subscribed would
 * let a scanner confirm on the recipient's behalf. A GET here is sent on to
 * the page without spending anything.
 *
 * On a valid, unexpired, unspent token the address is created in MailerLite as
 * ACTIVE in the brand group -- exactly what the form used to do directly -- so
 * the welcome automation and its code fire as before. Then a 303 to the
 * "You're in" page. Anything else goes to /newsletter/link-expired/ with a
 * reason, which offers the form again.
 *
 * Single use: the token's nonce is recorded (hashed, with its expiry, nothing
 * else) in the `newsletter-confirm-used` Blobs store before MailerLite is
 * called; if MailerLite then fails, the record is removed so the same link can
 * be tried again.
 *
 * Speed: the Blobs write has a 2.5s budget (retries included) and the
 * MailerLite call a 4s limit (_shared/timing.mjs). A slow Blobs is treated like
 * an unavailable one (carry on); a slow MailerLite like a failed one (error
 * page, link given back). Each request logs one "[newsletter-confirm] timing"
 * line.
 */
import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { readToken } from "./_shared/newsletter-token.mjs";
import { hashKey } from "./_shared/rate-limit.mjs";
import { LIMITS_MS, blobsFetch, fetchWithTimeout, stopwatch, withinBudget } from "./_shared/timing.mjs";

const ML = "https://connect.mailerlite.com/api";
const USED_STORE = "newsletter-confirm-used";
const CONFIRMED = "/newsletter/confirmed/";
const LINK_PROBLEM = "/newsletter/link-expired/";

const goTo = (req: Request, path: string) =>
  new Response(null, { status: 303, headers: { Location: new URL(path, req.url).toString(), "Cache-Control": "no-store" } });
const problem = (req: Request, reason: "invalid" | "expired" | "used" | "error") => goTo(req, `${LINK_PROBLEM}?r=${reason}`);

async function tokenFrom(req: Request): Promise<string> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const b = await req.json().catch(() => ({}));
    return String(b?.t || "");
  }
  const form = await req.formData().catch(() => null);
  return String(form?.get("t") || "");
}

export default async (req: Request, _context: Context) => {
  if (req.method === "GET") {
    const t = new URL(req.url).searchParams.get("t") || "";
    return goTo(req, `/newsletter/confirm/?t=${encodeURIComponent(t)}`);
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Netlify.env.get("NEWSLETTER_CONFIRM_SECRET");
  const apiKey = Netlify.env.get("MAILERLITE_API_KEY");
  const groupId = Netlify.env.get("MAILERLITE_GROUP_ID");
  if (!secret || !apiKey || !groupId) {
    console.error("newsletter-confirm misconfigured: missing NEWSLETTER_CONFIRM_SECRET, MAILERLITE_API_KEY or MAILERLITE_GROUP_ID");
    return problem(req, "error");
  }

  const verdict = readToken(secret, (await tokenFrom(req)).slice(0, 4096));
  if (!verdict.ok) return problem(req, verdict.reason);
  const clock = stopwatch("[newsletter-confirm]");

  // Spend the nonce first, atomically: two clicks racing cannot both get past.
  let store: ReturnType<typeof getStore> | null = null;
  const usedKey = hashKey("nonce", verdict.nonce);
  try {
    store = getStore({ name: USED_STORE, consistency: "strong", fetch: blobsFetch });
    const res = await clock.time("spend", withinBudget(
      store.setJSON(usedKey, { x: verdict.expiresAt }, { onlyIfNew: true }),
      LIMITS_MS.blobsOp, "token spend",
    ));
    if (!res.modified) {
      clock.log("used");
      return problem(req, "used");
    }
  } catch (err: any) {
    // Without Blobs single use cannot be enforced; a repeat only repeats the
    // same idempotent upsert below, so carry on rather than refuse a real click.
    // The store is kept: a write that ran out of budget may still land, and
    // the release below must be able to undo it (deleting nothing is harmless).
    console.warn("newsletter-confirm: used-token store unavailable (continuing):", err?.message || err);
  }

  let ok = false;
  try {
    const res = await clock.time("mailerlite", fetchWithTimeout(`${ML}/subscribers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: verdict.email, groups: [groupId], status: "active" }),
    }, LIMITS_MS.mailerlite, "MailerLite create"));
    ok = res.ok;
    if (!ok) console.error("newsletter-confirm: MailerLite refused:", res.status, await res.text().catch(() => ""));
  } catch (err: any) {
    console.error("newsletter-confirm: MailerLite unreachable:", err?.message || err);
  }

  if (!ok) {
    // Give the link back, so trying again later works.
    if (store) await withinBudget(store.delete(usedKey), LIMITS_MS.blobsOp, "token release").catch(() => {});
    clock.log("mailerlite failed");
    return problem(req, "error");
  }
  clock.log("confirmed");
  return goTo(req, CONFIRMED);
};
