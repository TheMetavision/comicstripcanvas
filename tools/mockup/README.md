# Mockup pipeline

Puts a product's artwork into a photographed scene and writes the result onto
the product in Sanity.

> **House rule:** never write files in this repo with PowerShell
> `Set-Content` / `Out-File`. Both can add a UTF-8 BOM and, on a
> read-modify-write, re-encode non-ASCII characters through the ANSI codepage —
> which silently corrupted `verify-faces.py` once. Use an editor, or Node/Python
> writing UTF-8 without a BOM.

## What ships

**Posters only.** One mockup per product, from the poster scene matching the
artwork's orientation:

| artwork | scene |
|---|---|
| portrait (1333×2000) | `poster-portrait` |
| landscape (2000×1333) | `poster-landscape` |

The **room and studio scenes are retired**. They are not rendered, not
uploaded, and not checked; Alan is replacing them with generated imagery. The
work on them is not deleted — it is kept whole at the tag

    archive/mockup-room-studio-attempt

which holds the output-resolution compositor, true-coverage antialiasing, the
side-panel geometry in `sides.py`, and the three geometry verifiers
(`verify-junctions`, `verify-outside`, `verify-aa`). If canvas scenes ever come
back, start there rather than from this branch. The tag is local; it has not
been pushed.

The shipped poster renders are the ones Alan signed off, byte for byte. The
commits that changed them were reverted rather than reset, so the history of
why is still readable.

## Commands

Render every comic icon's poster:

    python tools/mockup/render.py --category comic-book-icons --scenes poster

`--scenes` chooses **which** scenes (`poster`, `room`, `studio`, comma
separated; default `poster`). The **directory** the scene photographs live in
is `--scenes-dir`. That split is unique to `render.py` — the other tools in
this folder take a directory as `--scenes`, because none of them choose between
scenes. Passing a path to `render.py --scenes` fails loudly rather than
rendering the wrong set.

Add `--force` to redo products that already have output, `--dry-run` to list
what would happen, `--slug <slug>` (repeatable) instead of `--category`.

Check the renders:

    python tools/mockup/verify-faces.py --scenes poster
    python tools/mockup/verify-edges.py --scenes poster

Both default to `poster`. Both run `scene_guard` across the **whole** of
`scenes.json` regardless of what is being checked, because a scene swapped
under corners nobody is looking at today is still a stale `scenes.json`
tomorrow.

Plan the upload, then do it:

    node tools/mockup/upload.mjs --category comic-book-icons --scenes poster --dry-run
    node tools/mockup/upload.mjs --category comic-book-icons --scenes poster

Stage a real upload in batches, or target individual products:

    node tools/mockup/upload.mjs --category comic-book-icons --scenes poster --limit 5
    node tools/mockup/upload.mjs --slug walter-white-icon --slug zz-top --scenes poster

`--limit` takes the first *n* by slug, so the same *n* come back on a repeat.
`--slug` is repeatable and takes precedence over `--category`.

Publish the drafts the upload made — plan first:

    node tools/mockup/publish.mjs --category comic-book-icons --dry-run
    node tools/mockup/publish.mjs --category comic-book-icons --limit 5

`publish.mjs` publishes a draft only when the **only** difference from the
published document is the images array gaining `mockup-*` entries. Anything
else — a retitle, a price correction, an image added by hand, a mockup that is
already live being *changed* rather than added — is held and listed by name,
because a draft is shared state and the Studio writes to it too. Publishing one
because it happens to contain a mockup would push somebody's half-finished edit
live alongside it.

`_id`, `_rev`, `_createdAt` and `_updatedAt` are ignored; they differ by
definition. Everything else is compared deeply with key order normalised.

A dry run also sends the first batch to the actions API with `dryRun: true`, so
the endpoint, API version and action shape are checked against Sanity without
anything being published.

Takes `--slug`, `--limit` and `--batch` (default 10). Every run writes
`publish-backup-<timestamp>.json` with the **published** documents as they were
before anything was sent — that is what a publish overwrites.

Tests:

    python tools/mockup/test_aspect_gate.py
    python tools/mockup/test_nudge.py
    python tools/mockup/picker-tests.py
    node   tools/mockup/test-upload-slots.mjs
    node   tools/mockup/test-publish.mjs

## Slots

Each mockup has a fixed `_key` on the product's `images[]`:

| scene | key |
|---|---|
| poster | `mockup-poster` |
| room | `mockup-room` |
| studio | `mockup-studio` |

Order is **listing first, then poster, room, studio**, whichever exist.

Fixed keys make the upload an upsert: present, and the entry is replaced in
place; absent, and it is inserted. Running twice does what running once does.
Before this, keys were random hex, so a re-upload appended a second copy and
the script had to refuse to run on any product that already had one — which
meant a strip-then-upload, with the product pages carrying no mockup in
between.

Every mutation names a mockup key or inserts after one. The images array is
never rewritten wholesale, so the `listing` entry is not merely preserved, it
is never addressed.

New entries anchor on `images[_key=="listing"]`, **never on an index**.
`images[0]` is a position, and a position is only the listing entry until
something moves — a Studio reorder, an image added by hand — after which
"after images[0]" means "after whatever is first now" and the mockup lands in
front of the product image on the store grid. A product with no `listing` key
is skipped and named, rather than anchored somewhere plausible.

Everything is written to `drafts.<id>`, so nothing reaches a customer until
somebody opens the Studio and presses Publish. Where no draft exists it is
created from the published document with `createIfNotExists`, **in the same
transaction as the patch** — sent separately, a patch could arrive against a
document that was never created (the create failing, or the draft being
discarded in the Studio in between), which is an error partway through a batch.
Where a draft already exists the create is a no-op and whatever is in that
draft survives untouched.

Every run — dry runs included — writes `upload-backup-<timestamp>.json` with
each touched document's `images[]` as it was, before anything is sent.

### The alt text is a contract

    "<title> lifestyle mockup — Comic Strip Canvas"

`strip-mockups.mjs` finds these entries by matching `/lifestyle mockup/i` and
nothing else. Change the wording and the mockups become unremovable by the tool
built to remove them.

## The shape gate

An icon is skipped, not stretched, if its aspect is more than 15% from the
shape its poster scene was signed off carrying (2:3 portrait, 3:2 landscape). A
square icon is 50% off portrait and 33% off landscape, so it fails without
needing a rule of its own.

The comparison is against the catalogue shape rather than the face's own
measured proportions, because the faces do not match the catalogue and never
will — the portrait poster is about 9% off and the landscape one 20%, and that
difference has been looked at and accepted. Comparing against the face would
reject the very renders Alan approved.

All 244 comic icons are within 0.03% of 2:3 or 3:2, so the gate currently never
fires. That is why `test_aspect_gate.py` exists: a gate that never fires on the
available data is a gate nobody has checked.

## Scene geometry

`scenes.json` holds, per scene, the image size its corners were measured in and
per-face:

- `corners` — what Alan clicked. Never written by a tool.
- `cornersRefined` — `refine-corners.py` snapping each side onto the gradient
  that is really there. Never overwrites `corners`.
- `nudge` — optional per-side offsets in pixels, positive outward, applied in
  `quad_of()`. Currently all zero.
- `mesh` — poster faces only: twelve points, derived from the corners by
  `fit-mesh.py`, because a poster on a table bows and four corners cannot say
  so.
- `acceptedAspect` — the face's signed-off shape. A face that moves more than
  2% from it warns loudly; one that stays put says nothing.

`scene_guard.py` refuses to run any tool when a scene on disk is not the size
its corners were measured in. That check exists because the scenes were once
regenerated at 3504×2336 and then restored at 1536×1024, and every tool carried
on silently against corners that pointed at the wrong part of a different
picture.
