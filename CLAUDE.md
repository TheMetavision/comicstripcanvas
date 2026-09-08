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

### Sanity dataset must stay public

`netlify/functions/checkout.mjs` reads the `personalisationFee` off the product
document with **no auth token** -- the same way `src/lib/sanity.ts` reads content.
That works only while the `production` dataset is publicly readable.

If the dataset is ever switched to private, personalised checkout stops working:
the fee lookup returns nothing and the function refuses the line with "This
personalised product is not priced yet" rather than undercharging. Non-personalised
checkout is unaffected, so it would fail quietly for one product family only.

Either keep the dataset public, or give the function a read token and use it there.

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

