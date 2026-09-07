# Comic Strip Canvas — wording audit for the builder launch

Swept on 6 September 2026: home, /personalise, /services, /terms-and-conditions,
/refund-policy, /privacy-policy, /shipping-policy, plus the Sanity FAQ and
product documents (already covered by `fix-csc-copy.mjs`).

Two kinds of change are needed. **Mechanical** — text that describes the old
five-step form and will be plainly wrong once the builder replaces it.
**Substantive** — promises about who does the work, how long it takes, and what
happens to photos, which change because the flow changes.

One decision drives several of these: whether the comic style is applied
**instantly in the builder** or **after ordering**. The audit assumes instant
where the builder shows it, with a short human check before print. Where a
line depends on that decision it's marked ⚑.

---

## /personalise — the commission form page

This page *is* the old flow. Every step of it is replaced by the builder, so
most of the copy goes, not gets edited. What follows is what to keep or write.

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Meta description | "Made to order with a 2-3 working day proof." | ⚑ The layout proof is now instant | "Build your own comic cover, icon or strip from your photos — see it as you make it. Made to order." |
| Hero sub | "Follow the steps below to design your personalised comic art. We'll send you a proof within 2-3 working days and get your artwork printed once you're happy." | Describes the form | "Choose a style, drop your photos in, arrange everything yourself and see your layout as you build it. Nothing is printed until you've approved it." |
| Style cards | "+£10 artwork fee" / "+£25 artwork fee" | Fee is for customisation now, not artist labour | "+£10 personalisation" / "+£25 personalisation" |
| Step 2 | "Upload your photo(s) … Photos required: 1 … You need to upload 1 clear photo … JPG, PNG, WEBP — Max 10MB per file" | Whole step is replaced by the builder's panels | Remove. The builder's panel hint carries this: "Click any panel to choose a photo, or drop one straight on." |
| Step 2 vs FAQ | Form says JPG/PNG/WEBP; FAQ says "JPG and PNG files only" | Contradiction | Builder accepts what the code accepts — state one list, once |
| Step 3 | "Name / Title", "Speech Bubble / Caption Text", "Special Instructions" | Text is typed straight into the artwork now | Remove title and caption fields. **Keep** an optional "Anything we should know?" notes box at basket — the builder handles layout but not "please make the tie blue" |
| Step 3 | "Your 12 photos will appear on the canvas in the order you uploaded them … A visual drag-and-drop panel arranger is coming soon." | The builder is that arranger | Remove entirely |
| Step 5 | "We'll send you a digital proof within 2-3 working days of receiving your order. Printing begins only after your approval." | ⚑ | "You've approved the layout. We'll email your finished artwork before anything is printed." |
| FAQ: photo | "If you are unsure, upload what you have and we will let you know within 24 hours." | Nobody is checking within 24 hours; the builder checks instantly | "The builder shows the print quality of each photo as you position it and warns you before anything would print soft." |
| FAQ: photo | "we will always sharpen and enhance where we can" | A promise of manual work | Remove |
| FAQ: photo | "that is exactly how your commission will be illustrated" | "Commission" and "illustrated" both imply an artist | "that is exactly how it will appear in your artwork" |
| FAQ: photo | "all 12 slots need to be filled to complete your commission" | True, but "commission" again | "all twelve panels need a photo before you can add it to your basket" |
| FAQ: changes | "If you'd like adjustments to colours, composition, or any detail, just let us know and we'll revise it." | Composition is now the customer's, set in the builder | "You set the layout, crop and wording yourself, so those are exactly as you approved them. If the finished artwork isn't right once you've seen it, reply to the proof email and we'll look at it." |
| FAQ: order | "Use the commission form above" | The form is gone | "Open the builder above" — or drop the question, since the page now *is* the answer |
| FAQ: cost | "Canvas sizes (Small, Medium, Large) are priced separately." | Fine | Keep |

---

## Home

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Section 01 | "We take your photo and transform it into a stunning, vintage-style cover complete with your name in lights" | "We take … and transform" implies an artist | "Drop your photo onto a bold, vintage-style cover, put your name in lights, and see it come together as you build it." |
| Section 02 | "We transform your portrait into a bold, graphic pop-art icon" | Same | "Turn your portrait into a bold, graphic pop-art icon — add your quote, pick your colours, and it's done." |
| Section 03 | "Provide your photos and details, and we'll craft a bespoke multi-panel narrative you'll treasure forever." | The customer crafts it now | "Drop twelve photos into the panels, arrange them how the story happened, and choose your border colour." |
| Section intro | "Your photos. Your story. Our art. We transform your favourite pictures into one-of-a-kind comic book masterpieces." | Borderline — "our art" is still true of the style | Acceptable. If changing: "Your photos. Your story. Built by you, finished in our comic style." |
| CTA buttons ×3 | "START YOUR CUSTOM ORDER" | Fine, but "BUILD YOURS" says what actually happens | Optional |
| Testimonials | "the team turned it into…", "the proof came back in less than 48 hours, and the team worked with me on tiny tweaks" | These are real reviews of the old flow | **Leave them.** Don't rewrite customers' words. They'll age naturally as new reviews arrive. |

---

## Services

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Pricing | "Personalisation Artwork Fee" | "Artwork" implies artist time | "Personalisation Fee" |
| FAQ ×3 | "Our artists will create a digital proof within 2-3 working days" and the two proof answers | Already rewritten by `fix-csc-copy.mjs` | Run the script |
| CTA | "START A CUSTOM ORDER" | Fine | Keep |

---

## Terms & Conditions

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Personalised Products | "you are responsible for providing suitable photographs and accurate customisation details. We will provide a digital proof for your approval before printing. Once approved, the order is final" | The customer now approves *the layout* in the builder, then receives a *finished* proof. Two approvals, and responsibility for composition has moved to them | "You build and approve your own layout — the position and crop of each photo, and all wording — before ordering, and you are responsible for it being as you want it. We then apply our comic style and email you the finished artwork for approval. Once you approve that, the order is final." |
| Personalised Products | — | Nothing says the style is applied automatically | Add: "The comic style is applied by an automated process. We may hold or decline any order where the result is unsuitable for print, and will contact you if so." |
| Intellectual Property | "When you upload photos … you confirm that you own the rights" | Fine. Should also be a tick in the builder, not just buried here | Keep; add the consent checkbox to the builder before upload |
| Delivery | "Personalised orders require proof approval before printing begins — please allow 3-6 working days from the date of proof approval." | Still true | Keep |

---

## Refund Policy

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Proof Approval | "you will receive a digital proof within 2-3 working days. You may request up to two rounds of revisions." | ⚑ Timing changes. More importantly, revisions to *layout* no longer make sense — they set it | "You approve your layout in the builder before ordering. We then email the finished artwork with the comic style applied. If something about the finish isn't right, tell us and we'll look at it; the layout, crop and wording are as you set them. Once you approve the finished artwork, printing begins and the order cannot be cancelled." |
| Incorrect Orders | "If we have made an error … (wrong size, format, or design)" | "Design" is now largely the customer's | "(wrong size or format, or the artwork differs from the proof you approved)" |

---

## Privacy Policy

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Photos & Personalised Orders | "We may retain your photos for a reasonable period after order completion" | "Reasonable" isn't a period. Say one. | "We keep your photos and the finished artwork for 90 days after dispatch in case a reprint is needed, then delete them." (Pick the number you can actually honour.) |
| Photos & Personalised Orders | — | If the comic style or background removal runs through a third-party service, photos leave your systems and the policy **must name the processor** | ⚑ Add: "To apply the comic style, your photos are processed by [provider], acting as our data processor, and are not retained by them." — or, if self-hosted, "processed on our own systems and not shared." |
| How We Use Your Data | "create personalised artwork based on photos you provide" | Fine | Keep |

---

## Shipping Policy

| Where | Current | Problem | Replace with |
|---|---|---|---|
| Delivery Times | "the proof process typically takes 2-3 working days" | ⚑ Depends on whether the finished proof is instant or checked | If instant with a human check: "You'll usually have your finished artwork to approve within one working day." If checked before sending: keep as is. |

---

## Things that aren't wording but will bite

- **The old form must not stay reachable.** If `/personalise` keeps the five
  steps and the builder lives elsewhere, some customers will find the form,
  and the copy above becomes contradictory again. Replace the page or redirect
  it.
- **The strip requires twelve photos.** Decide whether that stays a hard rule.
  Eleven is a broken product; but a customer with eight strong photos might
  reasonably want to repeat some. If repeats are allowed, the builder needs to
  permit dropping the same file twice and the copy should say so.
- **Consent goes in the flow, not just the policy.** A checkbox before the
  first upload: "I own the rights to these photos or have permission to use
  them." The T&Cs already say it; the builder should ask it.
- **The proof email is a new artefact.** It needs writing — subject, body, what
  to do if it's wrong — and it needs to match the FAQ wording so the customer
  meets one consistent story.
