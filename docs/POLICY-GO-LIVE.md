# Policy wording to publish at go-live (Comic Strip Canvas)

Prepared 2026-11-01 on branch `chore/policy-wording`. **Nothing here is applied.** Shipping was switched off again on 2026-11-01, so `/returns` redirects. Apply this on a new branch once `SHIPPING_ENABLED` is back on at build time and `/returns` serves the form, then merge.

The privacy policy's "Delivery & Returns" section is already live and needs nothing.

⚠ Legal wording. Check it yourself before publishing.

## Refund policy: `src/pages/refund-policy.astro`

The return window stays CSC's own: **14 days from delivery to change your mind on standard (non-personalised) prints, then 14 days to send it back**. Personalised and customised items keep no change-of-mind right. Faulty or wrong items stay free.

"Your Right to Cancel — Standard Products", third paragraph (line 28). Replace:

```html
        <p class="mt-3">The item must be unused and returned in its original packaging. You pay the cost of return postage, unless the item is faulty or we sent you the wrong thing &mdash; then we cover it.</p>
```

with:

```html
        <p class="mt-3">The item must be unused and returned in its original packaging. You pay the cost of return postage, unless the item is faulty or we sent you the wrong thing &mdash; then we cover it. You can request a return at <a href="/returns/" class="text-comic-cyan hover:text-comic-yellow transition-colors">comicstripcanvas.co.uk/returns</a>: we email you a prepaid return label, and its cost is deducted from your refund (for a single item you'll see the amount before you submit; otherwise the email with your label states it).</p>
```

The second paragraph ("Tell us within those 14 days — a message through our contact page … is enough") stays: a customer can still cancel by message, and the returns page is an extra route.

The bracketed wording follows `returns.astro`. It shows the exact postage before submitting for one item only. With several items, or if the quote fails, it says the label email states the amount.

The Terms & Conditions don't mention return postage, so they need nothing.
