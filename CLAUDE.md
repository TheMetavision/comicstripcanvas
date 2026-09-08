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

Pending: Resend DNS verify, domain DNS to Netlify.

Resolved -- verified against production, not assumed:

- **personalise function 500 error.** `/api/personalise` returns 200 in production
  and for all 27 valid style x format x size inputs locally. The inline
  `config.path` that caused the original routing failure was removed in commit
  f1ada47; no function under `netlify/functions/` sets it, and that fault mode
  produced a 404, not a 500.
- **live Stripe keys.** Already in place. A production POST to `/api/personalise`
  returns a `cs_live_...` Checkout session URL.
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

