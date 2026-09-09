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
[functions]
  included_files = ["netlify/functions/_shared/style-refs/*.jpg"]
```

Without it the files are absent in production and every call throws. This is
the first `included_files` entry in the project — the fonts do **not** work this
way, they are fetched over HTTP from `${origin}/builder/fonts/`.

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
