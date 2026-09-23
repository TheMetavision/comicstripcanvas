"""
Warp a product's artwork into every mockup scene.

    python tools/mockup/render.py --slug walter-white-icon
    python tools/mockup/render.py --category comic-book-icons --dry-run

For each product: take the image the shop already shows, pick the portrait or
landscape scene set to match its shape, warp it into each canvas face, multiply
the scene's light back over it, and write out/<slug>/{room,studio,poster}.jpg.

── Which image ────────────────────────────────────────────────────────────

images[_key == "listing"] when there is one, else images[0]. That is the file
the product page leads with, so a mockup made from it shows the customer the
thing they were just looking at. Taken from Sanity at FULL resolution -- no
width parameter -- because the whole job is resampling it down into a quad and
starting from a thumbnail throws away the detail that makes the warp look real.

── Which scenes ───────────────────────────────────────────────────────────

By the image's own aspect, not by the product's category. A landscape icon and
a landscape cover both want the landscape canvases; the category says what the
thing IS, and the shape says what it will LOOK like on a wall. All six scenes
are landscape photographs either way -- only the canvas inside them differs --
so every output is landscape.

The studio scene holds two canvases, Standard 18mm and Premium Gallery 38mm.
Both are filled from the same artwork in one pass, which is why studio.jpg is
one file and not two.

── Resume ─────────────────────────────────────────────────────────────────

On by default: a slug whose three JPEGs already exist is skipped. A batch of
several hundred will be interrupted -- by a rate limit, a flat battery, a
thought -- and starting again should cost nothing for the ones already done.
--force overrides it.
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("This needs opencv-python and numpy:\n    python -m pip install opencv-python numpy")

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_CORNERS = os.path.join(HERE, "scenes.json")
DEFAULT_SHADING = os.path.join(HERE, "shading")
DEFAULT_OUT = os.path.join(HERE, "out")

PROJECT = "lwbwahym"
DATASET = "production"
OUT_LONG_SIDE = 2000
JPEG_QUALITY = 92

# scene file -> output name. Two scenes per output name, one per orientation.
OUTPUTS = ["room", "studio", "poster"]


def groq(query, params=None):
    url = f"https://{PROJECT}.api.sanity.io/v2021-10-21/data/query/{DATASET}?query={urllib.parse.quote(query)}"
    for k, v in (params or {}).items():
        url += f"&${k}=" + urllib.parse.quote(json.dumps(v))
    with urllib.request.urlopen(url, timeout=60) as r:
        body = json.load(r)
    if "error" in body:
        raise RuntimeError(json.dumps(body["error"]))
    return body.get("result")


def asset_url(ref):
    """image-<hash>-<w>x<h>-<ext> is the whole address; no width parameter, on
    purpose -- see the note above about starting from a thumbnail."""
    m = re.match(r"^image-([a-f0-9]+)-(\d+x\d+)-(\w+)$", ref or "")
    if not m:
        return None
    return f"https://cdn.sanity.io/images/{PROJECT}/{DATASET}/{m.group(1)}-{m.group(2)}.{m.group(3)}"


def fetch_image(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        buf = np.frombuffer(r.read(), np.uint8)
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def warp_into(art, scene, corners, shading=None):
    """The artwork, in the scene, wearing the scene's light."""
    h, w = scene.shape[:2]
    src = np.array([[0, 0], [art.shape[1] - 1, 0],
                    [art.shape[1] - 1, art.shape[0] - 1], [0, art.shape[0] - 1]], dtype=np.float32)
    dst = np.array(corners, dtype=np.float32)
    m = cv2.getPerspectiveTransform(src, dst)

    warped = cv2.warpPerspective(art, m, (w, h), flags=cv2.INTER_LANCZOS4,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))

    if shading is not None:
        # The shading was measured in the face's own rectangle, so it goes
        # through the same transform as the artwork and lands in register.
        sh = cv2.resize(shading, (art.shape[1], art.shape[0]), interpolation=cv2.INTER_LINEAR)
        sh = cv2.warpPerspective(sh, m, (w, h), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=1.0)
        warped = np.clip(warped.astype(np.float32) * sh[..., None], 0, 255).astype(np.uint8)

    # A 1px feather on the mask only. The canvas edge in the scene is a hard
    # edge and should stay one; this is to stop the warp's own jaggies showing
    # against it, not to soften the canvas.
    mask = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(mask, dst.astype(np.int32), 255, cv2.LINE_AA)
    mask = cv2.GaussianBlur(mask, (3, 3), 0).astype(np.float32) / 255.0
    return (scene.astype(np.float32) * (1 - mask[..., None])
            + warped.astype(np.float32) * mask[..., None]).astype(np.uint8)


def load_shading(shading_dir, key):
    path = os.path.join(shading_dir, key + ".png")
    if not os.path.exists(path):
        return None
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        return None
    if raw.ndim == 3:
        raw = raw[..., 0]
    return raw.astype(np.float32) / 32768.0


def fit_long_side(img, long_side):
    h, w = img.shape[:2]
    k = long_side / max(w, h)
    if abs(k - 1.0) < 1e-6:
        return img
    interp = cv2.INTER_AREA if k < 1 else cv2.INTER_LANCZOS4
    return cv2.resize(img, (max(1, round(w * k)), max(1, round(h * k))), interpolation=interp)


def render_product(product, scenes, corners, shading_dir, out_dir, force, log):
    slug = product["slug"]
    ref = product.get("listing") or product.get("first")
    url = asset_url(ref)
    if not url:
        log(f"  {slug}: no usable image on the product")
        return None

    dest = os.path.join(out_dir, slug)
    done = [os.path.join(dest, n + ".jpg") for n in OUTPUTS]
    if not force and all(os.path.exists(p) for p in done):
        log(f"  {slug}: already done, skipping")
        return {"slug": slug, "skipped": True}

    art = fetch_image(url)
    if art is None:
        log(f"  {slug}: could not decode {url}")
        return None
    ah, aw = art.shape[:2]
    orientation = "landscape" if aw >= ah else "portrait"
    log(f"  {slug}: artwork {aw}x{ah} -> {orientation} scenes")

    os.makedirs(dest, exist_ok=True)
    written = []
    for name in OUTPUTS:
        scene_name = f"{name}-{orientation}"
        info = corners.get(scene_name)
        if not info:
            log(f"     {scene_name}: no corners, skipped")
            continue
        scene = cv2.imread(os.path.join(scenes, scene_name + ".png"))
        if scene is None:
            log(f"     {scene_name}: cannot read the scene")
            continue
        composed = scene
        for q in info["quads"]:
            sh = load_shading(shading_dir, f"{scene_name}__{q['name']}")
            composed = warp_into(art, composed, q["corners"], sh)
        out = fit_long_side(composed, OUT_LONG_SIDE)
        path = os.path.join(dest, name + ".jpg")
        cv2.imwrite(path, out, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        written.append((name, out.shape[1], out.shape[0], len(info["quads"])))
        log(f"     {name+'.jpg':12s} {out.shape[1]}x{out.shape[0]}  from {scene_name}  ({len(info['quads'])} face(s))")
    return {"slug": slug, "orientation": orientation, "artwork": [aw, ah], "written": written}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", action="append", help="one product; repeatable")
    ap.add_argument("--category")
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--corners", default=DEFAULT_CORNERS)
    ap.add_argument("--shading", default=DEFAULT_SHADING)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="redo slugs that already have output")
    args = ap.parse_args()

    if not args.slug and not args.category:
        sys.exit("Give --slug or --category.")
    with open(args.corners, encoding="utf-8") as f:
        corners = json.load(f)

    q = ('*[_type == "product" && !(_id in path("drafts.**")) && '
         + ('slug.current in $slugs' if args.slug else 'category == $category')
         + ']{_id, title, "slug": slug.current, category, '
         '"listing": images[_key == "listing"][0].asset._ref, '
         '"first": images[0].asset._ref} | order(slug asc)')
    params = {"slugs": args.slug} if args.slug else {"category": args.category}
    products = groq(q, params) or []
    print(f"  {len(products)} product(s)")

    if args.dry_run:
        for p in products:
            ref = p.get("listing") or p.get("first")
            which = "listing" if p.get("listing") else ("images[0]" if p.get("first") else "NONE")
            dest = os.path.join(args.out, p["slug"])
            state = "would skip (done)" if all(
                os.path.exists(os.path.join(dest, n + ".jpg")) for n in OUTPUTS) and not args.force else "would render"
            print(f"     {p['slug']:34s} {which:10s} {state}")
            if not ref:
                print("        no image on this product")
        print("\n  dry run: nothing written")
        return 0

    results = []
    for p in products:
        r = render_product(p, args.scenes, corners, args.shading, args.out, args.force, print)
        if r:
            results.append(r)
    made = sum(len(r.get("written", [])) for r in results)
    print(f"\n  {made} file(s) written for {len(results)} product(s) into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
