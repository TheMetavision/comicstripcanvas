# Builder — as built

What the personalisation system actually is, now that it is built. This file
used to be a fourteen-step plan; the plan is done, and several of its decisions
were overtaken while the work happened. It is now a description, not a sequence.

Two rules still run through everything:

- **The customer's proof and the print file are the same SVG document.**
  Nothing is recalculated server-side. Any change to layout maths breaks this
  silently.
- **After every code step, run the proof:**
  `node tools/builder/renderer/prove.mjs` must report `20/20 match`.

---

## The shape of it

A customer opens a personalised product page, ticks the rights box, and drops a
photograph into a panel. From that moment:

1. **`personalise-save.mjs`** stores the photo in Netlify Blobs under
   `personalisation/<id>/<panel>.jpg` and creates a `pendingPersonalisation`
   document with `status: draft`. Photographs never go into Sanity's asset
   library — only their blob keys do.
2. **`style-photo-background.mjs`** applies the comic style, then the cutout.
3. The builder polls **`personalisation-status.mjs`** and swaps the styled
   image, then the cutout, into the panel. The customer crops and positions the
   *styled* image, so what they approve is what prints.
4. **Add to basket** posts the recipe and the tokenised scene SVG, and the
   basket line carries the document id.
5. **`checkout.mjs`** adds the personalisation fee, read from each product's
   `personalisationFee` in Sanity, and passes the id to Stripe as line-item
   metadata.
6. **`webhook.mjs`** moves the document to `paid` on
   `checkout.session.completed` and triggers the render.
7. **`render-personalisation-background.mjs`** swaps the tokens for
   full-resolution files and rasterises the identical document at 300dpi,
   plus a 1200px proof. Failure sets `on_hold` with the reason; it never
   writes a partial print file.
8. A reviewer approves the proof in the Sanity Studio, and the customer gets
   the proof email.

### The comic style

**Google Gemini**, via `@google/genai`, in `_shared/style.mjs`. Three reference
images of our own artwork travel with every request, which is what makes the
style consistent. Google is named in the privacy policy as our data processor;
we use the paid tier, under which Google does not train on what we send.

- The base URL is pinned to `generativelanguage.googleapis.com`. Netlify's AI
  Gateway intercepts it otherwise and answers 401.
- Sixteen model calls per personalisation, retries included, then a panel is
  refused rather than called again. Calls that fail before any generation
  (401/403/429/5xx) do not count against it.
- The same photograph dropped into several panels is styled once and the result
  shared, keyed on the sha256 of the raw bytes.

### The cutout

**Our own service on Fly.io, in London** — `services/cutout`, app `csc-cutout`.
It runs `@imgly/background-removal-node`, which cannot be a Netlify function:
`onnxruntime-node` alone is 49.5 MB zipped against a 50 MB budget for an entire
function. Standard comic book cover only.

Bytes in, RGBA PNG out; the service stores nothing. Gated on alpha coverage —
under 5% or over 90% is refused — and a refusal is not an error: the cover keeps
its styled image and the customer simply gets no Cutout | Full picture toggle.

See `services/cutout/README.md` for the deploy, the token, and why Cloud Run was
abandoned.

### Review and email

In the **Sanity Studio**, not a page on the site: `studio/components/ProofPanel.tsx`
shows the proof, and `studio/actions/personalisationActions.tsx` offers Approve,
Hold and Re-render through `personalisation-action.mjs`. Transactional email —
the proof and its Approve link — goes out through **Resend**. MailerLite is the
newsletter and nothing else.

### Retention

**Live, daily, deleting for real.** `[functions."retention"]` with
`schedule = "@daily"` in `netlify.toml`. Customer photographs go 90 days after
dispatch, abandoned builds 30 days after they were started, and an orphan sweep
collects blobs no document points at. A *manual* invocation defaults to a dry
run and needs the shared secret — that guard exists because a developer testing
it once triggered a real deletion.

### Environment

| | |
| --- | --- |
| `SANITY_WRITE_TOKEN` | writes orders and personalisations |
| `GOOGLE_AI_API_KEY` | the comic style |
| `CUTOUT_SERVICE_URL` / `CUTOUT_TOKEN` | the Fly cutout service |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **live**, not test |
| `RESEND_API_KEY` | transactional email |
| `PERSONALISATION_ACTION_SECRET` | Studio actions and `studio-save` |

With either cutout variable unset the cutout step is skipped rather than failed:
nothing is logged, the cover keeps its styled image, and the status endpoint
reports `cutoutEnabled: false` so the builder does not wait for it.

---

## Go-live checklist

- [ ] **One real order end to end** — paid, styled, rendered, approved, into
      production. Everything below this line has been exercised in pieces; this
      is the only test that exercises the joins.
- [ ] **Print file opened at 100%** — pixel size, fonts, no seams. Take it from
      the order above rather than rendering a separate one.
- [ ] **Decide about `/admin/studio`.** There is no admin auth in this project,
      so the page is open to anyone with the URL. It is `noindex`, and
      `studio-save` refuses without `PERSONALISATION_ACTION_SECRET`, which the
      page prompts for once per session — so a visitor gets a builder and can
      save nothing. That may be enough, or it may not.
- [ ] **Someone owns the review queue** and knows the promise the proof email
      makes about timing.

---

## Known issues

Recorded rather than fixed, in `services/cutout/README.md`: a Google **400**
still counts against a personalisation's sixteen style calls, where 401, 403,
429 and 5xx correctly do not. A rejected API key returns a 400, so a
misconfiguration can spend a customer's allowance without reaching a model.

---

## When Claude Code drifts

Two failure modes, both of which happened while building the prototype:

**It tidies the geometry.** The layout maths was verified pixel-for-pixel
against the renderer. Any change makes the proof and print diverge silently.
`prove.mjs` after every step.

**It renames a font.** `Luckiest Guy` has a space. A stylesheet accepts
anything; the renderer does not. The font check in `render.mjs` exists for this
— a non-zero exit is a real failure, not a warning to suppress.
