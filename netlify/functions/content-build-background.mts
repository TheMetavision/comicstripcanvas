// netlify/functions/content-build-background.mts
//
// POST /api/content-build-background   (internal only)
//
// The debounce waiter started by sanity-content-changed: waits until the
// edits settle, then POSTs the Netlify build hook once. See
// _shared/content-build.mjs for the timing rules.
//
// NETLIFY_BUILD_HOOK_URL holds the hook (a Netlify env var, never in the
// repo, never logged). Internal only: x-content-build-key must match
// CONTENT_BUILD_INTERNAL_KEY (constant-time), because a background function's
// path is public.

import { getStore } from "@netlify/blobs";
import { runWaiter, isInternal, startWaiter, waiterUrl, STATE_STORE } from "./_shared/content-build.mjs";

const HOOK_RE = /^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9]+$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = Netlify.env.get("CONTENT_BUILD_INTERNAL_KEY") || "";
  if (!isInternal(req, key)) return new Response("Forbidden", { status: 403 });

  const hook = (Netlify.env.get("NETLIFY_BUILD_HOOK_URL") || "").trim();
  const r = await runWaiter({
    store: getStore({ name: STATE_STORE, consistency: "strong" }),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
    triggerBuild: async (title: string) => {
      if (!HOOK_RE.test(hook)) return { ok: false, error: "NETLIFY_BUILD_HOOK_URL is not set or not a Netlify build hook URL" };
      try {
        const res = await fetch(`${hook}?trigger_title=${encodeURIComponent(title)}`, {
          method: "POST", body: "{}", signal: AbortSignal.timeout(15_000),
        });
        return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
      } catch (err: any) {
        return { ok: false, error: err?.name === "TimeoutError" ? "timed out" : err?.message };
      }
    },
    rearm: () => startWaiter(waiterUrl(req, Netlify.env.get("URL")), key),
    log: (m: string) => console.log(m),
  });
  console.log(`content-build: waiter done — ${r.outcome}, ${r.builds} build(s)`);
  return new Response("OK");
}
