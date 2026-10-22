// netlify/functions/sanity-content-changed.mts
//
// POST /api/sanity-content-changed   (the Sanity "Netlify rebuild" webhook)
//
// Content that static pages read at build time was published, changed or
// deleted. Checks Sanity's signature (SANITY_REBUILD_WEBHOOK_SECRET), records the
// change in Blobs "content-build", and starts the debounce waiter if none is
// running. The build itself happens there — see _shared/content-build.mjs.
//
// Answers fast: Sanity sends one request at a time per webhook and retries a
// 5xx. A failure to start the waiter answers 500 so that retry re-arms it.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   SANITY_REBUILD_WEBHOOK_SECRET  the secret set on the Sanity "Netlify rebuild" webhook
//                                 (not SANITY_WEBHOOK_SECRET: that one is the Order Shipped webhook's)
//   CONTENT_BUILD_INTERNAL_KEY    shared with content-build-background
//   URL                           set by Netlify (the site's main address)

import { getStore } from "@netlify/blobs";
import { isValidSignature, SIGNATURE_HEADER_NAME } from "@sanity/webhook";
import { classify, recordChange, disarm, startWaiter, waiterUrl, STATE_STORE } from "./_shared/content-build.mjs";

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return text("Method not allowed", 405);

  const secret = Netlify.env.get("SANITY_REBUILD_WEBHOOK_SECRET");
  const key = Netlify.env.get("CONTENT_BUILD_INTERNAL_KEY");
  if (!secret || !key) {
    console.error("content-changed: SANITY_REBUILD_WEBHOOK_SECRET or CONTENT_BUILD_INTERNAL_KEY not set — refusing");
    return text("Webhook not configured", 500);
  }
  const body = await req.text();
  const sig = req.headers.get(SIGNATURE_HEADER_NAME);
  let valid = false;
  try { valid = Boolean(sig) && (await isValidSignature(body, sig!, secret)); } catch { valid = false; }
  if (!valid) {
    console.warn("content-changed: invalid or missing signature");
    return text("Invalid signature", 401);
  }

  let payload: any = null;
  try { payload = JSON.parse(body); } catch { return text("Bad JSON", 400); }
  const c = classify(payload);
  if (!c.build) {
    console.log(`content-changed: ignored (${c.reason})`);
    return text(`Ignored: ${c.reason}`);
  }

  const store = getStore({ name: STATE_STORE, consistency: "strong" });
  const now = Date.now();
  const { arm, state } = await recordChange(store, { now, type: c.type! });
  if (arm) {
    const r = await startWaiter(waiterUrl(req, Netlify.env.get("URL")), key);
    if (!r.ok) {
      await disarm(store, now).catch(() => {});
      console.error(`content-changed: could not start the build waiter (${r.error}) — asking Sanity to retry`);
      return text("Could not queue the build", 500);
    }
  }
  console.log(`content-changed: change to ${c.type} — ${state.changes} pending${arm ? ", waiter started" : ""}`);
  return text("Queued");
}
