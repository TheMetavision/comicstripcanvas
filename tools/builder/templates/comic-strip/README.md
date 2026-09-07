# Comic Strip Canvas — panel workflow

Template: 7350 × 4950 px @ 300dpi = **24.5 × 16.5 in**, i.e. a 24 × 16 in trim with 0.25 in bleed all round.
12 panels, none of them rectangular — 8 slanted quadrilaterals and 4 rounded capsules.

## Files

| File | What it is |
|---|---|
| `panels.json` | The manifest. Canvas spec plus each panel's bounding box, aspect ratio and mask path. Everything else reads from this. |
| `masks/panel-NN.png` | Exact silhouette of each panel as an alpha mask, dilated 4px so artwork tucks under the ink and leaves no white halo. |
| `overlay.png` | The template line art with panel interiors *and* the outer surround punched transparent. Sits on top of the artwork so the borders stay crisp. |
| `panel-map.png` | Numbered reference showing which panel is which. |
| `panel-paths.json` | The same twelve outlines as SVG paths — 2.4 KB total. What the browser builder uses. |
| `strip-builder.html` | Self-contained drop-in builder. Exports a recipe. |
| `compose.mjs` | Sharp compositor. Replays a recipe at 300dpi, or auto-crops a bare folder. |
| `ingest.py` | Turns any new blank template into all of the above. |

## How it runs

Replaying a recipe exported from the builder — studio proofs and customer orders
take the identical path:

```
node compose.mjs --recipe recipe.json --images ./images --out strip-001.png
```

Zoom and offsets are reproduced exactly as they were dragged on screen, so the
300dpi master matches the proof. Panels below 150dpi are reported at the end of
the run rather than failing it.

Or straight from a folder, letting Sharp pick the crop:

```
node compose.mjs --images ./images --bg "#E2A7D6" --out strip-001.png
```

Drop `panel-01.png` … `panel-12.png` into `./images` and run it. Missing panels are
skipped with a warning rather than failing the batch, so you can composite a
part-finished strip to review.

## Adding another template

```
python ingest.py blank-template.png ./templates/comic-cover-a --dpi 300
```

Detects the panels, cuts the masks, traces the paths, punches the overlay and
renders a numbered map. Rows are clustered by vertical overlap rather than by
y-position, so slanted layouts read in the right order.

`--bg` sets the surround colour — the overlay is punched there too, so the colour
is a live layer underneath rather than baked into the template. That's what makes
it matchable to whatever palette the product images land on.

Layer order is: background colour → masked artwork → ink overlay.

## Panel spec — feed this into generation

Generate to the bounding box, not to a square. Where the model takes exact pixel
dimensions, use the px column; otherwise use the nearest ratio and let the
compositor's cover-crop take up the slack.

| Panel | Box (px) | Aspect | Nearest std. ratio | Inside the shape |
|---|---|---|---|---|
| 01 | 2822 × 1432 | 1.97 | 2:1 | 80% |
| 02 | 2730 × 1239 | 2.20 | 2:1 | 83% |
| 03 | 1917 × 1154 | 1.66 | 5:3 | 85% |
| 04 | 1814 × 858 | 2.11 | 2:1 | 84% |
| 05 | 3143 × 962 | 3.27 | 3:1 / outpaint | 82% |
| 06 | 2262 × 1058 | 2.14 | 2:1 | 80% |
| 07 | 1528 × 982 | 1.56 | 3:2 | 79% |
| 08 | 3545 × 1139 | 3.11 | 3:1 | 80% |
| 09 | 2439 × 1263 | 1.93 | 2:1 | 82% |
| 10 | 2529 × 993 | 2.55 | 21:9 | 88% |
| 11 | 3169 × 923 | 3.43 | 3.5:1 / outpaint | 84% |
| 12 | 1525 × 830 | 1.84 | 16:9 | 83% |

**The 79–88% column is the thing to design around.** That's how much of each
bounding box actually falls inside the panel silhouette — the rest is lost to
slanted edges and rounded ends. So every prompt wants the subject centred with
generous headroom, and nothing important within about 12% of any edge. The four
capsules (05, 08, 11 and the top-right of 02) lose their corners entirely.

Panels 05, 08 and 11 exceed 3:1, which is wider than most generators will go
natively. Two options: generate at 21:9 and outpaint sideways, or build them as
deliberate wide establishing shots where a centre crop is harmless.

## Crop anchoring

By default each panel uses Sharp's `attention` strategy, which finds the most
visually salient region. When it guesses wrong, add a `position` key to that
panel in `panels.json` — `"centre"`, `"top"`, `"left"`, `"north west"` etc. —
and re-run. That's the per-panel override; no need to regenerate the art.

## Still to define

- The house style block: the fixed prompt fragment reused verbatim on all 12 panels.
- Character/subject consistency method — reference image, character sheet, or trained identity.
- Whether this is one template of several, or the fixed layout for every strip.
