# Print renderer

## The idea

The preview and the print file are **the same document**. The builder exports the
SVG it is actually showing, with every asset replaced by a token; the renderer
swaps the tokens for full-resolution files and rasterises that identical
document.

Nothing is recalculated server-side, so nothing can drift. A customer cannot be
sent something they didn't approve, because the approved scene *is* the file.

```
{{IMAGE:panel-01}}   the customer's photo for that panel
{{OVERLAY}}          template line art and furniture
{{BACKGROUND}}       template background artwork
{{LOGO}}             publisher logo
```

## Running it

```
npm install @resvg/resvg-js
node render.mjs --recipe recipe.json --images ./uploads --assets ./assets \
                --fonts ./_fonts --out print.png
```

Options: `--dpi` (default 300), `--width` to force a pixel width, `--preview`
to render at the scene's own scale, `--background` (defaults to white — print
files must be opaque).

## Proving it

```
node extract-all.mjs     # drive the builder headlessly, capture 20 scenes
node prove.mjs           # rasterise both sides and diff pixel by pixel
```

Result across every template, both output formats and the smallest and largest
size of each:

```
20/20 match. Worst divergence 0.0000%.
```

Three real defects were found by this and fixed:

- **The title printed in the wrong typeface.** The scene asked for
  `font-family="LuckiestGuy"`, which a browser resolves through `@font-face`,
  but a renderer matches on the name inside the font file — which is
  `Luckiest Guy`, with a space. It fell through to the default family and
  printed in Chewy. The builder now uses the real family name, and the renderer
  checks every family the scene asks for against the fonts actually loaded and
  **exits rather than substituting**.


- The renderer rasterised onto transparency while the builder assumed white, so
  partially-covered edge rows disagreed. Print files are now opaque by default.
- The example artwork is per-template; the renderer was using the strip's for
  every product.

## What it needs

- `assets/comic-cover/overlay.png`, `assets/comic-cover/background.png`
- `assets/csc-logo.png`, `assets/placeholder*.png`
- `_fonts/Chewy-Regular.ttf`, `_fonts/LuckiestGuy-Regular.ttf`

Fonts are loaded explicitly with system fonts disabled, and every family the
scene requests is checked against the family names read from the font files
themselves. A missing font stops the render with a non-zero exit code instead
of quietly printing in something else.

## Not yet done

- The comic style filter. It runs before compositing, on the customer's photo,
  and its parameters belong in the recipe so the print reproduces the proof.
- Colour management. Everything is sRGB; if the press wants CMYK that is a
  conversion step on the output.
- `--dpi` applies to the whole file. A very large canvas at 300dpi is a big
  raster (21 × 29 in is 6300 × 8700), so the render job wants memory headroom.
