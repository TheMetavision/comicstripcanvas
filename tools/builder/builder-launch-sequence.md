# Builder launch sequence

Fourteen steps, in the order I'd do them. Each one says who does it (you or
Claude Code), gives the prompt where there is one, and ends with a check.
Don't start a step until the previous check passes — most of them assume it.

Two rules run through all of it:

- **The customer's proof and the print file are the same SVG document.**
  Nothing is recalculated server-side. Any step that changes layout maths breaks
  this silently.
- **After every code step, run the proof:**
  `node tools/builder/renderer/prove.mjs` must report `20/20 match`.

---

## Step 1 — Decisions (made 7 Sep 2026)

| Decision | Answer |
|---|---|
| Style pipeline | **Replicate**: a Flux LoRA trained on Alan's own new-style generations, run as image-to-image; Real-ESRGAN on Replicate for the upscale. Replicate is named as a data processor in the privacy policy. |
| Photo retention | **90 days** after dispatch, then deleted. |
| Strip's twelve photos | All twelve panels must hold a photo before Add to basket. **Repeats are allowed** — the same file may be dropped into more than one panel. |
| Strip artwork | Unchanged. The existing border is the front face (no separate bleed). **16 × 12 stays** for now, with a deeper border top and bottom. |

These are already written into the prompts below where they matter.

---

## Step 2 — Fix the live copy (you)

Independent of everything else, and it's a live misdescription.

```powershell
cd C:\Users\chris\Projects\ComicStripCanvas
npm install @sanity/client
$env:SANITY_TOKEN_CSC="sk..."
node fix-csc-copy.mjs
node fix-csc-copy.mjs --apply
```
Delete the duplicate FAQ in the Studio using the ID the script prints.

**Check:** the services FAQ no longer says "our artists"; the icon product
reads "an Icon".

---

## Step 3 — Put the deliverables in the repo (you)

```
tools/builder/product-builder.html
tools/builder/templates/           ← everything from outputs/templates
tools/builder/renderer/            ← render.mjs, prove.mjs, extract-all.mjs, README.md
tools/builder/ingest.py
tools/builder/comicfx.py
tools/builder/site-wording-audit.md
```

---

## Step 4 — Trace the personalise 500 (Claude Code)

```
Before any new work: the existing personalise function returns a 500. Find it under netlify/functions/, read it, and read netlify.toml. This site previously had a function break because it set config.path, which collides with the /api/* redirect. Check for that first. Reproduce the 500 locally, tell me the cause, and fix it. Do not add features. List what you changed.
```

**Check:** the personalise page submits without a 500.

---

## Step 5 — Builder becomes an Astro island (Claude Code)

```
Read tools/builder/product-builder.html fully before doing anything. It is a working prototype and the source of truth for behaviour. Then read astro.config.mjs, src/pages/, src/layouts/BaseLayout.astro, src/styles/global.css and tailwind.config.* so you know the site's structure and design tokens.

Convert the prototype into an Astro client island at src/components/ProductBuilder.astro (use .tsx only if the project already uses a framework). Rules:

1. Assets out of the file. Move every base64 asset to public/builder/: fonts to public/builder/fonts/, template overlays and backgrounds to public/builder/templates/<slug>/, placeholders and logo to public/builder/. Load fonts with @font-face from those paths. Family names must be exactly "Chewy" and "Luckiest Guy" — the second has a space, and the print renderer matches on the name inside the font file.

2. Data out of the file. The embedded JSON blobs (PATHS, COVER, CAPBOX, BOXES, METRICS) become JSON files under src/data/builder/, imported at build time.

3. Behaviour unchanged. Every control, every geometry rule, the recipe export and exportSVG() must work identically. Do not improve or tidy the layout maths. If something looks wrong, tell me instead of fixing it.

4. Styling. Replace the prototype's inline CSS with the site's Tailwind tokens and classes from global.css (btn-primary, btn-secondary, comic-border, font-bangers, font-russo, charcoal / panel-dark / off-white). Keep the per-product accent switching.

5. The component takes a `mode` prop: "customer" (default) or "studio". For now both behave identically — Step 12 changes that. Just plumb the prop through.

6. Mount it on the three personalised product pages keyed off slug: personalised-strips → strip, personalised-book-covers → cover, personalised-icons → icon portrait. Orientation and full-bleed variants stay as switches inside the builder.

7. The Copy recipe button stays hidden unless ?dev is in the URL.

8. Do not touch checkout, functions or Sanity in this task.

output: 'static' stays. No new dependencies unless you tell me why. List every file you created or changed.
```

**Check:** on each personalised page — drop a photo, type text, move a box,
change size and output, download a draft. Add `?dev`, copy the recipe, confirm
it has an `svg` field starting `<svg`. Run `prove.mjs`.

---

## Step 6 — Consent, storage and the order record (Claude Code)

```
Read the pendingPersonalisation schema in the Sanity studio project and the personalise function under netlify/functions/.

Extend the schema. Keep every existing field and add: recipe (text, JSON), sceneSvg (text), templateId (string), printSize (string), outputFormat (string), proofUrl (url), minEffectiveDpi (number), status (string: draft, awaiting_payment, paid, preparing, rendered, approved, in_production, dispatched, on_hold), photoKeys (array of strings — Netlify Blob keys, never the photos), styledKeys (array of strings), customerNotes (text).

Add a consent checkbox to the builder that must be ticked before the first upload: "I own the rights to these photos or have permission to use them, and I'm happy for Comic Strip Canvas to use them to make my artwork." Store the timestamp on the document as consentAt.

Add an optional notes box at Add to basket labelled "Anything we should know?" — stored as customerNotes.

Create netlify/functions/personalise-save.mjs. It accepts multipart: the recipe JSON, the notes, and 1 to 12 image files. Validate each file is an image under 25 MB. Write each to Netlify Blobs under personalisation/<id>/<panelId>.<ext>. Create the pendingPersonalisation document with status draft and the blob keys, and return the id. The recipe's svg field goes into sceneSvg; the rest into recipe.

Route it through the existing /api/* redirect. Do NOT set config.path on the function.

Add to basket is disabled until every panel holds a customer photo (the example graphic does not count). A customer may use the same photo in more than one panel — dropping or choosing the same file for a second panel must work, and the basket line counts photos as placed, not as unique files.

Wire Add to basket to post to it, then add a basket line carrying the returned id, product, size and format, described as e.g. "Comic cover · 16 × 24 in · gallery wrap · 1 photo".

Use SANITY_TOKEN_CSC. Customer photos must never go into Sanity's asset library. List every file you changed.
```

**Manual:** enable Netlify Blobs on the site.

**Check:** build a layout, tick consent, add to basket. A `pendingPersonalisation`
exists with `status: draft`, `consentAt`, a `sceneSvg` starting `<svg`, and
blob keys. Photos are in Blobs, not Sanity.

---

## Step 7 — Checkout (Claude Code)

```
Read netlify/functions/checkout.mjs and the existing Stripe webhook handler.

When a basket line carries a personalisationId, pass it to Stripe as line-item metadata. Add the personalisation fee using the amounts on the product documents in Sanity (+£10 covers and icons, +£25 strips) — read them, do not hard-code them.

In the webhook, on checkout.session.completed, for each line with a personalisationId: set the document's status to paid, record the Stripe session id and order id on it, and trigger the render function (Step 8) with the document id.

Do not change how non-personalised orders flow. List every file you changed.
```

**Check:** a Stripe test-mode purchase moves the document to `paid` with the
order id on it.

---

## Step 8 — The render job (Claude Code)

```
Read tools/builder/renderer/render.mjs and its README fully. It takes a recipe containing a tokenised SVG, swaps {{IMAGE:panel-xx}}, {{OVERLAY}}, {{BACKGROUND}}, {{LOGO}} for full-resolution assets, checks every font family the scene asks for is actually loaded (exiting non-zero if not), and rasterises with @resvg/resvg-js.

Create netlify/functions/render-personalisation-background.mjs as a Netlify background function. Given a pendingPersonalisation id it:

1. Loads the document; refuses unless status is paid, preparing or on_hold.
2. Fetches the panel images from Blobs — styledKeys if present, otherwise photoKeys.
3. Resolves template assets from public/builder/templates/<slug>/ — the full-resolution files.
4. Runs the same substitution and rasterisation as render.mjs, at the file size in the recipe's output block, 300dpi, opaque white background.
5. Also renders a 1200px-wide proof.
6. Writes both to Blobs under renders/<id>/print.png and renders/<id>/proof.png, stores the proof URL on the document, sets status rendered.
7. On any failure, including a missing font, sets status on_hold with the error on the document. Never write a partial print file.

Keep the font check exactly as it is. Fonts load explicitly from public/builder/fonts/ with system fonts disabled. Process one document per invocation with maximum memory. List every file you changed and any dependency added.
```

**Check:** `prove.mjs` still 20/20. Trigger a render for the test order; open
`print.png` — right pixel size, opaque, title in Luckiest Guy.

---

## Step 9 — Review page and proof email (Claude Code)

```
Create a review page at /admin/personalisation behind the site's existing admin auth — find how the admin portal authenticates and reuse it, do not build a new login.

It lists pendingPersonalisation documents by status. For each rendered one it shows the proof, the customer's text and notes, the effective DPI per photo, size and output, and three actions: Approve (sets approved, sends the proof email), Hold (sets on_hold with a note), Re-render. For on_hold it shows the error or note.

Write the proof email template. Subject: "Your Comic Strip Canvas artwork is ready to approve". Body: the proof image, one line reminding them they set the layout themselves, a clear Approve link and a "Something's not right" link that replies to you. Send through the existing transactional setup with the Comic Strip Canvas MailerLite token, not Wyrmfuel's. The Approve link sets status in_production.

Keep the page plain. List every file you changed.
```

**Check:** a test order flows draft → paid → rendered → approved →
in_production and the email arrives with a working Approve link.

**At this point the whole pipeline works with raw photos.** Everything below
adds the comic style and the launch polish on top of a working system.

---

## Step 10a — Train the style LoRA (you, on Replicate)

Do this before Step 10b. It's a one-off, and it's what makes every customer
image come out in the same style.

1. Gather **25–40 of your new-style generations**. Consistent look, varied
   subjects, no text overlays, no watermarks. All the same aspect if you can.
   This is the whole definition of the style — quality here matters more than
   anything in the code.
2. On Replicate, use the Flux LoRA trainer (`ostris/flux-dev-lora-trainer`).
   Zip the images, set a trigger word like `CSCSTYLE`, default steps, and
   train. Cost is a few pounds and it takes around 20–30 minutes.
3. Note the resulting model version id — the prompt in 10b needs it.
4. **Test likeness before wiring anything.** Run five real photos of people
   through image-to-image with the LoRA at denoise strengths 0.5, 0.6 and 0.7.
   Pick the strongest setting where the person still looks like themselves.
   That number goes in `style.json` as the default. If none of them keep the
   likeness, tell me — it changes the model choice, not the plumbing.

## Step 10b — Image preparation: cutout, style, upscale (Claude Code)

```
Read tools/builder/comicfx.py for the shape of the effect, and read the recipe format in tools/builder/renderer/README.md.

Create netlify/functions/prepare-image-background.mjs. Given a pendingPersonalisation id and a panel id, it takes that panel's photo from Blobs and runs a three-stage pipeline, writing the result to Blobs under personalisation/<id>/<panelId>.styled.png and adding the key to styledKeys:

1. Background removal — only when the recipe's panel entry has removeBackground.on set, which the builder sets for the bordered cover template. Use [the matting service decided in Step 1]. Output RGBA.
2. Comic style — image-to-image on Replicate using the Flux LoRA model version [PASTE THE VERSION ID FROM STEP 10a], prompt "CSCSTYLE comic book illustration" plus any per-template suffix from config, denoise strength from config (default: the value chosen in Step 10a), guidance and steps from config. All of it lives in src/data/builder/style.json so it can be tuned without a code change, and the exact values used are written into the recipe's panel entry as styleParams.
3. Upscale — Real-ESRGAN via Replicate to at least the panel's target pixel size (panel width in the recipe × 300dpi / the face width in inches), capped at 4×.

Set status to preparing while running; on completion of all panels, trigger the render function. On failure set on_hold with the error.

In the builder: after a photo is dropped, upload it immediately via personalise-save (creating the draft document on first upload if needed), call prepare-image for that panel, show a "Applying comic style…" state on the panel, and when the styled image returns, replace the panel's image with it. The customer positions the STYLED image. The recipe must reference the styled key so the print uses the identical file. Never re-style at render time.

Add a per-image cost log so we can see spend per order. List every file you changed.
```

**Manual:** Replicate is named in the privacy policy as a data processor
(Step 13). Set REPLICATE_API_TOKEN as a Netlify env var.

**Check:** drop a photo; it comes back styled within the expected time; the
proof and the print use the same styled file; `prove.mjs` still 20/20.

---

## Step 11 — Retire the form (Claude Code)

```
The five-step commission form at /personalise is replaced by the builder. Rewrite src/pages/personalise.astro as a landing page: a short intro, the three style cards (Comic Book Cover, Comic Book Icon, Comic Book Strip) each linking to its personalised product page where the builder lives, and the personalise FAQ block. Remove all five steps, the upload zone, the "name / caption / special instructions" fields, and the "drag-and-drop arranger coming soon" note. Remove the old form's submit function and its route if nothing else uses them.

Change the style card fees from "artwork fee" to "personalisation". Keep the nav link and the existing CTAs pointing at /personalise. List every file you changed and anything you deleted.
```

**Check:** /personalise shows three cards, no form; each card lands on a working
builder.

---

## Step 12 — Studio mode (Claude Code)

```
The ProductBuilder component already takes a mode prop. Implement mode="studio":

- No consent checkbox, no customer notes box, no upload to Blobs.
- Download draft renders at full resolution with no watermark.
- Replace Add to basket with Save as product. It posts the recipe and the exported SVG to a new function netlify/functions/studio-save.mjs, which runs the same render as Step 8 (reading panel images from the files the studio user dropped, uploaded with the request), stores the print master and a 1600px listing image, and creates a Sanity product document in the right category with the listing image attached, status draft. Return the Studio URL for that document.
- Mount it at /admin/studio behind the existing admin auth, with the same template switcher.

Everything about layout, text and colours is shared with customer mode — do not fork the component. List every file you changed.
```

**Check:** build a design in the studio, save it, find it as a draft product in
the Studio with its listing image.

---

## Step 13 — Site copy and policies (Claude Code, then you)

```
Read tools/builder/site-wording-audit.md. It lists, page by page, the current wording that describes the old commission form and the artist-led flow, with replacement copy.

Apply every replacement marked as mechanical. For the ones marked ⚑, use these decisions: the comic style is applied automatically and shown in the builder as the customer works; photos and artwork are kept for 90 days after dispatch then deleted; Replicate (replicate.com) processes photos as our data processor to apply the style and does not retain them; the finished artwork is emailed for approval within one working day. Do not touch the testimonials. Where copy lives in Sanity rather than in the repo, produce a patch script like fix-csc-copy.mjs with a dry-run mode rather than editing the Studio by hand.

Then update the four policy pages per the audit: Terms (customer approves layout in the builder; automated styling; right to hold), Refund (revisions are to finish, not layout), Privacy (named retention period; named processor if styling runs off-site; consent), Shipping (proof timing). Update the "Last updated" dates. List every file changed.
```

**You:** read the four policies before they go live. They're legal text, and
you're the one bound by them.

**Check:** search the built site for "commission", "our artists",
"hand-illustrated", "2-3 working days", "coming soon" — none should remain
except inside testimonials.

---

## Step 14 — Go-live (you)

- [ ] `prove.mjs` 20/20 against the deployed builder
- [ ] One real order end to end in Stripe test mode, styled, rendered, approved
- [ ] Print file opened and checked at 100%: size, fonts, no seams
- [ ] Old form unreachable; /personalise redirects or shows the landing page
- [ ] Privacy policy names the retention period and any processor
- [ ] Blob deletion after the retention period is actually running
- [ ] Someone owns the review queue and knows the proof-email promise
- [ ] The How-it-works overlay says the same thing as the FAQ

Then take Stripe out of test mode.

---

## When Claude Code drifts

Two failure modes to watch for, both of which happened while building the
prototype:

**It tidies the geometry.** The layout maths was verified pixel-for-pixel
against the renderer. Any change makes the proof and print diverge silently.
`prove.mjs` after every step.

**It renames a font.** `Luckiest Guy` has a space. A stylesheet accepts
anything; the renderer doesn't. The font check in `render.mjs` exists for this
— a non-zero exit is a real failure, not a warning to suppress.
