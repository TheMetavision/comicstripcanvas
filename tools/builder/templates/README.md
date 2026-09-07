# Personalised product templates

Three products, one engine. Each template folder holds everything needed to
render both a browser proof and a print master.

| File | Role |
|---|---|
| `template.json` | Canvas, art window, layer order, live text fields, record of what was re-rendered |
| `background.png` | Product artwork that sits **under** the customer photo (cover only) |
| `overlay.png` | Furniture that sits **over** the photo, including all fixed text |
| `_fonts/` | The two licensed faces |

Layer order is in `template.json` under `layerOrder`. For the cover it's
background → art → overlay → live text. For the icon there is no background
plate; the photo is full-bleed.

## Fonts

| Was | Now | Licence |
|---|---|---|
| Grinched | Chewy | Apache 2.0 |
| DamnNoisyKids | Luckiest Guy | Apache 2.0 |

Both permit commercial use, product embedding and webfont delivery. The
originals permitted none of those without a paid licence.

Every Grinched and DamnNoisyKids pixel has been replaced. The eight fixed text
layers on the cover (masthead, page count, issue, date, price, launch number,
publisher, title) were re-rendered in the new faces and baked back into
`overlay.png` — baking the old fonts as pixels would not have solved the
licensing, only hidden it.

## Sizes

| Product | Canvas | DPI | Print size | Art window |
|---|---|---|---|---|
| Comic cover | 4200 × 5800 | 200 | 21 × 29 in | 3411 × 5000 inset at (397, 378) |
| Comic icon (portrait) | 3600 × 5400 | 150 | 24 × 36 in | full bleed |
| Comic strip | 7350 × 4950 | 300 | 24 × 16 in + bleed | 12 shaped panels |

Three different standards, and only the strip carries bleed. Worth unifying.

## Text handling

Live fields carry `fontSize`, `rotationDeg`, `fill`, `strokeColour` and
`strokeRatio` (outline width as a fraction of font size — 0.065). The PSDs did
this two different ways, a layer effect on the icon and a text stroke on the
cover; one ratio now covers both.

Fit the text in the browser, then write the resolved size and line breaks into
the recipe. The renderer draws at a known size and cannot disagree with the
proof.

## Open items

- The issue-number block (`31`) has an unusually narrow ink box in the PSD, so
  its re-rendered size is the one element worth eyeballing against the original.
- Fixed cover text is baked. Promoting any of it to a customer field (issue
  number, date, price) is a small change — the geometry is already recorded.
- Landscape icon template still to ingest.
