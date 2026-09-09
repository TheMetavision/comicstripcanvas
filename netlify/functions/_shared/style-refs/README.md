# Style references

Three of our own comic-style generations, shown to the image model ahead of the
customer's photograph so it has the house style to copy.

    ref-1.jpg
    ref-2.jpg
    ref-3.jpg

Exactly these three filenames, JPEG, in this folder. `style.mjs` reads them from
disk relative to `import.meta.url` and **hard-fails if any is missing or empty**
— the same invariant the fonts have in `render.mjs`: styling in an unknown style
is worse than not styling at all, so it must stop rather than guess.

## They have to be deployed with the function

They are read from the filesystem at runtime, so any function that imports
`style.mjs` needs them bundled. That is the `included_files` entry in
`netlify.toml`:

```toml
[functions."style-photo-background"]
  included_files = ["netlify/functions/_shared/style-refs/*.jpg"]
```

Without it the files are absent in production and every call throws.

Two things this entry must NOT be:

- **Top-level.** A `[functions]` entry applies to every function, so all
  seventeen bundles carry the same 1.2 MB — and the parallel copies race each
  other on Windows and fail the dev build with `EBUSY`. It belongs to the one
  function that reads them. `loadStyleRefs()` is lazy, so importing
  `_shared/style.mjs` for a constant does not need the files.
- **Assumed from the fonts.** They do not work this way — `render.mjs` fetches
  those over HTTP from `${origin}/builder/fonts/`.

## Measured

Nano Banana Pro, these three references, five test photographs:

| Size | Time | Output |
| ---- | ---- | ------ |
| 2K   | ~36 s | |
| 4K   | ~52 s | 5504 × 3072 from a 16:9 source |

All five passed on likeness — faces, poses, framing and the number of people
came back as they went in.

Known limits, in the order they are likely to be noticed:

- **Clothing text can garble.** The prompt now asks for it letter for letter,
  which helps but does not guarantee it. A photo whose subject is a slogan
  t-shirt is the weak case.
- **Backgrounds shift to the references' purple/orange palette.** Accepted as
  house style — it is what makes the output look like ours — but it does mean
  the references' colouring propagates to every order, which is worth
  remembering before swapping them.
- **Small framing drift.** Not enough to change the composition, but the crop
  is not pixel-identical to the source.

## Choosing them

They define the output, so it is worth being fussy:

- Pick generations that agree with each other. Three different styles average
  into a fourth nobody chose.
- Show the range the builder actually needs: at least one with faces at
  portrait scale, since likeness is the thing customers judge.
- Keep them free of text, panel borders and signatures. The prompt asks for
  none of those, and a reference containing them argues the other way.
- Keep them reasonably sized. They are base64'd into every request, so three
  large files are paid for on every single call.
