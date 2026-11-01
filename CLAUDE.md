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

### Sendcloud dispatch and returns (feat/sendcloud-dispatch)

Labels, returns and tracking go through the metavision-shipping service
(`C:\Users\chris\Projects\metavision-shipping`, read its README). Everything is
behind `SHIPPING_ENABLED` (functions) and `SANITY_STUDIO_SHIPPING_ENABLED`
(Studio build); unset, orders, emails and the Studio are as before.

- `_shared/shipping-client.mjs` signs every call; `SHIPPING_TEST_MODE=true`
  makes every label the free `sendcloud:letter` test label (and flags
  `quote-return`). Never set it in production. Prices arrive as
  `quotedPrice: {amount, currency}`; read them with `quotedPounds`.
- `_shared/parcel-bands.mjs` maps formatKey + sizeKey to bands. A line it
  cannot place is flagged (`shipment.planProblem`), never guessed.
- One Sanity webhook, "CSC orders" -> `/api/sanity-orders-webhook`, routes
  every order and return event (the plan allows two webhooks; "Netlify
  rebuild" is the other). It sends the dispatch email itself and starts the
  two shipping background functions with an awaited request signed with
  SANITY_WEBHOOK_SECRET_SHIPPING, now internal only. Each handler's claim,
  not the router, is what stops a double send.
- Alan sets `shipment.status = ready_to_ship` -> "CSC orders" ->
  `shipping-dispatch-background` buys labels -> team "Label ready" email.
  `shipping-event` (the service's callback) does the rest; the customer's
  dispatch email goes out at the first carrier scan via
  `_shared/dispatch-email.mjs`, which `order-shipped.mjs` also uses. It claims
  the order before sending, so the email cannot go twice.
- `/returns` -> `returns.mjs` -> `returnRequest.<ref>` (private dotted id).
  Before submitting, the page shows the exact postage from the service's
  `quote-return` (one item only; several items, or a failed quote, get the
  general wording). Alan approves -> `shipping-return-background` -> label
  emailed with the deduction, which is create-return's `quotedPrice` (stored
  as `postageDeduction`). Refunds stay manual in Stripe.
- `shipment.status` and `parcelPlan` are operator fields in
  `studio/lib/guarded-publish.mjs`; everything else under `shipment` is the
  server's. Return requests publish by the same rule.

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

- **Sanity webhooks.** The plan allows two, and both are in use (confirmed in
  sanity.io/manage):
  - "Netlify rebuild" -> `https://comicstripcanvas.co.uk/api/sanity-content-changed`
    (secret SANITY_REBUILD_WEBHOOK_SECRET). That function debounces and
    `content-build-background` then POSTs the Netlify build hook
    `69e7bb39d8d2859ae7a81ff1` ("Sanity Content Update", branch `main`), held
    in NETLIFY_BUILD_HOOK_URL. Sanity does not call the build hook directly.
  - "CSC orders" (formerly "Order Shipped Email") ->
    `https://comicstripcanvas.co.uk/api/sanity-orders-webhook` (secret
    SANITY_WEBHOOK_SECRET). See the Sendcloud section above.

  A third webhook cannot be added: route new document events through one of
  these two.

- **Sanity build hook.** Exists and fires on product changes (2026-09-08), via
  "Netlify rebuild" above. Confirmed
  from the deploy history rather than assumed: three `product` documents were
  updated at 21:16 on 2026-09-07 and hook-triggered production deploys ran at
  21:16 and 21:18. The hook is filtered -- roughly twenty `contactSubmission`
  writes in the same window triggered nothing -- but the exact GROQ filter is
  only visible in sanity.io/manage; `SANITY_WRITE_TOKEN` has no management-API
  scope, so `sanity hook list` and the API cannot show it.

  This matters for pricing: `personalisationFee` is read from Sanity at build
  time, so a fee edit reaches the site only once this hook's rebuild finishes.

- **Function env is capped at 4 KB** (AWS Lambda). A deploy failed on it.
  Every Functions-scoped variable goes into every function, and Edge
  Functions read the same scope, so re-scoping helps only for variables that
  only the build reads. Only secrets belong in Netlify: non-secret settings
  go in `netlify/functions/_shared/site-config.mjs` (read with `setting()`,
  and an env var of the same name still overrides). Check before adding a
  variable.

