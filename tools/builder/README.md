# tools/builder

Everything from the product builder work, laid out so Claude Code can find it.
Nothing in here is wired into the site yet — that's Steps 4 onward in
`builder-launch-sequence.md`.

| Path | What it is |
|---|---|
| `product-builder.html` | The working prototype. Source of truth for behaviour. Open it in a browser. |
| `data/` | The JSON the prototype embeds: strip panel paths, cover text fields, cover caption box, icon speech boxes, font metrics. Step 5 moves these to `src/data/builder/`. |
| `templates/` | Full-resolution template artwork per product, the two licensed fonts, placeholders and logo. Step 5 moves these to `public/builder/`. |
| `templates/comic-strip/` | Strip manifest, vector panel paths, masks and overlay, plus the original `compose.mjs` (superseded by the renderer — kept for reference). |
| `renderer/` | The print renderer and its proof harness. `npm install` then `npm run capture && npm run prove` must report 20/20. |
| `ingest.py` | Turns any new blank template PNG into a manifest, masks and paths. |
| `comicfx.py` | Prototype comic-style filter — the shape of the effect, not the final style. |
| `fix-csc-copy.mjs` | Sanity copy corrections. Already applied (Step 2). |
| `site-wording-audit.md` | Page-by-page copy changes for Step 13. |
| `builder-launch-sequence.md` | The plan and the prompts. |

Two rules for anyone touching this:

- **The proof and the print are the same SVG.** Don't recalculate layout server-side.
- **Font family names must match the font files** — `Chewy` and `Luckiest Guy` (with the space).
