# Comic Strip Canvas -- agent handoff

---

## Path migration (May 2026)

Generated 2026-05-02 during the Downloads -> Projects migration.

### Path change

- **Old path:** `C:\Users\chris\Downloads\Comic Strip Canvas Astro Site\csc`
- **New path:** `C:\Users\chris\Projects\comicstripcanvas`

Any older agent instructions, scripts, or notes that reference the old path should be treated as referring to the new path.

### Quick stack reference

- **Brand:** Comic Strip Canvas
- **Sanity project ID:** `lwbwahym`
- **GitHub remote:** https://github.com/TheMetavision/comicstripcanvas.git
- **Stack:** Astro + Sanity CMS + Netlify (per Metavision house standard)

### Public dataset, private customer documents

The `production` dataset is publicly readable (Free plan), and site content is
read without a token (`src/lib/sanity.ts`). Customer documents are not public:
`order`, `contactSubmission`, `orderCounter` and `pendingPersonalisation` live at
dotted `_id`s, which anonymous reads never return. Check with
`node tools/check-public-exposure.mjs` (exit 1 if anything shows).

A build is known everywhere outside Sanity by its ref (`pp-<hex>`): URLs, basket,
Stripe metadata, order lines, emails, Blobs keys. Its document is at
`pendingPersonalisation.<ref>` -- always go through
`netlify/functions/_shared/pp-id.mjs` (`docIdFor` / `refOf`).

Anything that reads a build document needs a token: the functions use
SANITY_WRITE_TOKEN; `checkout.mjs`, the admin pages (`src/lib/sanity-server.ts`)
and the photo edge function prefer the Viewer token SANITY_READ_TOKEN. Without a
token, checkout refuses personalised lines as unpriced rather than undercharging,
and the photo edge function steps aside to the buffered function.

Customer photos never go in Sanity assets (asset URLs and the asset list are
public). The builder's photos are in Blobs; the legacy flow's were moved to the
`legacy-customer-photos` store by `tools/migrate-private-personalisation.mjs`
and are served only at `/admin/api/legacy-photo/*` behind Basic Auth.

### Notes

Pending: domain DNS to Netlify.

Resolved -- verified against production, not assumed:

- **personalise function 500 error.** Was never reproducible: the function
  returned 200 in production and for all 27 valid style x format x size inputs.
  The inline `config.path` behind the original routing failure had already been
  removed in commit f1ada47, and that fault produced a 404, not a 500.

  Moot now -- `/api/personalise` and its five-step form were deleted when the
  builder replaced them. **The rule it taught still stands: no function under
  `netlify/functions/` may set `config.path`,** because it collides with the
  forced `/api/*` rewrite in netlify.toml and 404s. Schedules and memory go in
  netlify.toml instead.
- **live Stripe keys.** Already in place. Originally confirmed by a production
  POST to `/api/personalise` returning a `cs_live_...` Checkout session URL;
  that endpoint is gone, and `/api/checkout` is now the only path that creates
  a session.
- **Resend DNS verify.** Done (2026-09-08). Production sends succeed from
  `Comic Strip Canvas <orders@comicstripcanvas.co.uk>`: an Approve on a real
  personalisation returned `{"ok":true,"status":"approved","emailed":true}`,
  and Resend rejects an unverified sending domain rather than accepting it.
  Note `EMAIL_FROM` is not set in Netlify, so every transactional email uses
  that hardcoded fallback address.

- **Sanity build hook.** Exists and fires on product changes (2026-09-08). The
  Sanity webhook "Netlify rebuild" POSTs to Netlify build hook
  `69e7bb39d8d2859ae7a81ff1` ("Sanity Content Update", branch `main`). Confirmed
  from the deploy history rather than assumed: three `product` documents were
  updated at 21:16 on 2026-09-07 and hook-triggered production deploys ran at
  21:16 and 21:18. The hook is filtered -- roughly twenty `contactSubmission`
  writes in the same window triggered nothing -- but the exact GROQ filter is
  only visible in sanity.io/manage; `SANITY_WRITE_TOKEN` has no management-API
  scope, so `sanity hook list` and the API cannot show it.

  This matters for pricing: `personalisationFee` is read from Sanity at build
  time, so a fee edit reaches the site only once this hook's rebuild finishes.

