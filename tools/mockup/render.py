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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("This needs opencv-python and numpy:\n    python -m pip install opencv-python numpy")

# Beside this file, hence the sys.path line above: the edge colour is wanted by
# the batch and by anyone checking a single product's answer, so it lives in its
# own module rather than halfway down this one.
from edge_colour import prominent_colour, hex_to_bgr  # noqa: E402

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_CORNERS = os.path.join(HERE, "scenes.json")
DEFAULT_SHADING = os.path.join(HERE, "shading")
DEFAULT_EDGES = os.path.join(HERE, "edges")
DEFAULT_OUT = os.path.join(HERE, "out")

PROJECT = "lwbwahym"
DATASET = "production"
OUT_LONG_SIDE = 2000
JPEG_QUALITY = 92
# How far an edge pixel may stray from the strip's average brightness. Wide
# enough for a real highlight, tight enough that a blown one does not turn the
# edge white.
EDGE_SHADE_CLIP = (0.45, 1.65)

# ── seating the artwork in the scene ───────────────────────────────────────
# How far inside its own boundary the artwork stops.
FACE_INSET = 1
# The ring outside the quad that is sampled for "what the surroundings look
# like", and how far inside the boundary a pixel may be trimmed as background.
BG_RING_IN, BG_RING_OUT = 3, 14
BG_BAND = 5
BG_CLUSTERS = 6
# Lab distance within which a boundary pixel counts as surroundings, not print.
BG_TOLERANCE = 11.0
# The band of shade just inside the face boundary, and how dark it goes.
INNER_SHADOW_PX = 6
INNER_SHADOW_STRENGTH = 0.18
# Extra weight on the scene's own lighting for the rigid canvases. Their broad
# gradient is real light on a flat surface, not the placeholder's picture, so
# it can be trusted harder than the shared default allows.
SCENE_SHADING_GAIN = {"room": 1.6, "studio": 1.6, "poster": 1.0}
# The poster carries a specular highlight along its curl. That is real
# light on a real surface and the most convincing thing in the frame, so
# it is let through harder still.
POSTER_SHADING_GAIN = 2.1

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


def warp_into(art, scene, corners, shading=None, silhouette=None, shade_gain=1.0):
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
        # A rigid canvas can take the scene's lighting harder than a sheet of
        # paper can: its broad gradient is light falling on a flat surface, not
        # the placeholder's own picture leaking through the blur.
        if shade_gain != 1.0:
            sh = 1.0 + (sh - 1.0) * shade_gain
        warped = np.clip(warped.astype(np.float32) * sh[..., None], 0, 255).astype(np.uint8)

    # Where the artwork may land. The quad is the fallback; the silhouette is
    # the quad after the scene has been asked what is actually there.
    if silhouette is not None:
        mask = silhouette.copy()
        shadow = inner_shadow(mask)
        if shadow is not None:
            warped = np.clip(warped.astype(np.float32) * shadow[..., None], 0, 255).astype(np.uint8)
    else:
        mask = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(mask, dst.astype(np.int32), 255, cv2.LINE_AA)
    # A 1px feather on the mask only. The canvas edge in the scene is a hard
    # edge and should stay one; this is to stop the warp's own jaggies showing
    # against it, not to soften the canvas.
    mask = cv2.GaussianBlur(mask, (3, 3), 0).astype(np.float32) / 255.0
    return (scene.astype(np.float32) * (1 - mask[..., None])
            + warped.astype(np.float32) * mask[..., None]).astype(np.uint8)


def _tps_fit(src, dst):
    """
    Thin-plate spline through a handful of control points.

    Written out rather than called: OpenCV's createThinPlateSplineShapeTransformer
    lives in the shape module, which the 5.x main package no longer ships, and a
    second opencv wheel is a poor trade for twenty lines of linear algebra.

    Standard formulation. f(p) = a0 + a1.x + a2.y + sum_i w_i U(|p - c_i|) with
    U(r) = r^2 log r, solved so that f interpolates the control points exactly
    and bends as little as possible between them -- which is what a sheet of
    paper does.
    """
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    n = len(src)

    d = np.linalg.norm(src[:, None, :] - src[None, :, :], axis=2)
    k = np.where(d > 0, d * d * np.log(np.maximum(d, 1e-12)), 0.0)
    pmat = np.hstack([np.ones((n, 1)), src])
    a = np.zeros((n + 3, n + 3))
    a[:n, :n] = k
    a[:n, n:] = pmat
    a[n:, :n] = pmat.T
    b = np.zeros((n + 3, 2))
    b[:n] = dst
    # lstsq rather than solve: three collinear control points would make this
    # singular, and a poster edge clicked carelessly can supply them.
    sol = np.linalg.lstsq(a, b, rcond=None)[0]
    return src, sol[:n], sol[n:]


def _tps_apply(pts, centres, weights, affine):
    """Evaluate the spline at many points at once."""
    pts = np.asarray(pts, np.float64)
    d = np.linalg.norm(pts[:, None, :] - centres[None, :, :], axis=2)
    u = np.where(d > 0, d * d * np.log(np.maximum(d, 1e-12)), 0.0)
    lin = affine[0] + pts @ affine[1:]
    return lin + u @ weights


def mesh_source_points(w, h):
    """
    The 12 points on the flat artwork that the 12 clicked points correspond to.

    Same walk as pick-corners uses: each corner, then two points at a third and
    two thirds along the edge leaving it. The order is the contract between the
    two files -- get it wrong and the poster is warped into a bow tie.
    """
    tl, tr, br, bl = (0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)
    out = []
    for a, b in ((tl, tr), (tr, br), (br, bl), (bl, tl)):
        out.append(a)
        for t in (1 / 3, 2 / 3):
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return np.array(out, np.float32)


def warp_mesh(art, scene, mesh, shading=None, shade_gain=1.0, inset=FACE_INSET):
    """
    A poster is not flat, so a perspective transform cannot place it.

    Four corners define a plane. A sheet of paper lying on a table lifts at the
    corners and bows along the edges, and forcing that through
    getPerspectiveTransform straightens it -- the artwork runs off the curl on
    one side and leaves bare paper showing on the other, which is exactly what
    the Cats on Crack placeholder was doing along the top of the landscape
    poster.

    A thin-plate spline through twelve points bends instead. It is fitted from
    the SCENE to the ARTWORK, because what a remap needs is, for each scene
    pixel, where to read from -- the inverse of the direction the points were
    clicked in.
    """
    h, w = scene.shape[:2]
    scene_pts = np.array(mesh, np.float64)
    art_pts = mesh_source_points(art.shape[1], art.shape[0]).astype(np.float64)
    # Fitted scene -> artwork: a remap asks, for each destination pixel, where
    # to READ from, which is the opposite direction to the one clicked.
    centres, weights, affine = _tps_fit(scene_pts, art_pts)

    hull = cv2.convexHull(np.array(mesh, np.int32))
    region = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(region, hull, 255)
    if inset > 0:
        region = cv2.erode(region, np.ones((2 * inset + 1,) * 2, np.uint8))

    ys, xs = np.where(region > 0)
    if not len(xs):
        return scene
    pts = np.stack([xs, ys], 1).astype(np.float64)
    mapped = _tps_apply(pts, centres, weights, affine)

    map_x = np.full((h, w), -1, np.float32)
    map_y = np.full((h, w), -1, np.float32)
    map_x[ys, xs] = mapped[:, 0].astype(np.float32)
    map_y[ys, xs] = mapped[:, 1].astype(np.float32)
    warped = cv2.remap(art, map_x, map_y, cv2.INTER_LANCZOS4,
                       borderMode=cv2.BORDER_REPLICATE)

    if shading is not None:
        sh = cv2.resize(shading, (art.shape[1], art.shape[0]), interpolation=cv2.INTER_LINEAR)
        shw = cv2.remap(sh, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        if shade_gain != 1.0:
            shw = 1.0 + (shw - 1.0) * shade_gain
        warped = np.clip(warped.astype(np.float32) * shw[..., None], 0, 255).astype(np.uint8)

    mask = cv2.GaussianBlur(region, (3, 3), 0).astype(np.float32) / 255.0
    return (scene.astype(np.float32) * (1 - mask[..., None])
            + warped.astype(np.float32) * mask[..., None]).astype(np.uint8)


def face_silhouette(scene, corners, edge_mask, inset=FACE_INSET):
    """
    Where the artwork is actually allowed to land.

    The quad says where the canvas face is, and it is never exactly right: a
    corner clicked a pixel or two out puts warped artwork over the wrapped edge
    or onto the wall behind, and a hard-edged rectangle of print sitting on top
    of a brick wall is the single most obvious tell that a mockup is a mockup.

    So the quad is only the starting point, and the scene is asked what is
    really there:

        inside the quad
        minus the edge mask, so nothing lands on the wrapped edge
        minus anything near the boundary that matches what is OUTSIDE the quad,
            which is the wall, or the table, or the room
        eroded by a pixel, so the artwork stops just short of its own boundary
            rather than exactly on it

    The background test is local and self-calibrating: a ring just outside the
    quad is sampled for what "not canvas" looks like right there, and only
    pixels within a few pixels of the boundary are eligible. A wall is a
    different colour everywhere, and an absolute rule for "brick" would be
    wrong in the studio and wrong again in the next scene photographed.
    """
    h, w = scene.shape[:2]
    quad = np.array(corners, np.int32)

    inside = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inside, quad, 255)

    if edge_mask is not None and edge_mask.any():
        inside = cv2.bitwise_and(inside, cv2.bitwise_not(
            cv2.dilate(edge_mask, np.ones((3, 3), np.uint8))))

    # What the surroundings look like, here.
    outer = cv2.dilate(inside, np.ones((2 * BG_RING_OUT + 1,) * 2, np.uint8))
    inner = cv2.dilate(inside, np.ones((2 * BG_RING_IN + 1,) * 2, np.uint8))
    ring = cv2.bitwise_and(outer, cv2.bitwise_not(inner))
    if ring.any():
        lab = cv2.cvtColor(scene, cv2.COLOR_BGR2LAB).astype(np.float32)
        samples = lab[ring > 0].reshape(-1, 3)
        # A handful of representative surround colours rather than one mean:
        # a brick wall is several, and their average is none of them.
        k = min(BG_CLUSTERS, len(samples))
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, _, centres = cv2.kmeans(samples, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)

        band = cv2.bitwise_and(inside, cv2.bitwise_not(
            cv2.erode(inside, np.ones((2 * BG_BAND + 1,) * 2, np.uint8))))
        ys, xs = np.where(band > 0)
        if len(xs):
            px = lab[ys, xs]
            d = np.min(np.linalg.norm(px[:, None, :] - centres[None, :, :], axis=2), axis=1)
            cand = np.zeros((h, w), np.uint8)
            cand[ys[d < BG_TOLERANCE], xs[d < BG_TOLERANCE]] = 255

            # Only what the surroundings can actually reach.
            #
            # Background intrudes from the outside; it does not appear in the
            # middle of a print. Without this the test removed any dark patch
            # of artwork that happened to resemble a dark room -- 10-12% of the
            # face on the room and studio scenes, which is not a trim, it is a
            # crop. Keeping only the components that touch the boundary makes
            # it an intrusion test rather than a colour-similarity test.
            edge_ring = cv2.bitwise_and(inside, cv2.bitwise_not(
                cv2.erode(inside, np.ones((3, 3), np.uint8))))
            n, labels = cv2.connectedComponents(cand)
            touching = np.unique(labels[(edge_ring > 0) & (cand > 0)])
            keep = np.isin(labels, touching[touching > 0])
            inside[keep] = 0

    if inset > 0:
        inside = cv2.erode(inside, np.ones((2 * inset + 1,) * 2, np.uint8))
    return inside


def inner_shadow(mask, depth=INNER_SHADOW_PX, strength=INNER_SHADOW_STRENGTH):
    """
    A few pixels of shade just inside the face boundary.

    A print in a frame is not uniformly lit to its very edge: the edge of the
    canvas catches slightly less light than the middle, and the eye reads that
    band as evidence of a surface. Without it a warped image sits ON the
    photograph rather than IN it, however good the perspective is.

    Returns a multiplier, 1.0 everywhere except a soft ramp at the boundary.
    """
    if not mask.any() or depth <= 0:
        return None
    dist = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    ramp = np.clip(dist / float(depth), 0.0, 1.0)
    return 1.0 - strength * (1.0 - ramp)


def recolour_edge(scene, mask, hex_colour):
    """
    Paint the canvas edge in the product's own colour, keeping the light on it.

    The scene's edge is a flat pink lit by the room -- brighter where it faces a
    softbox, darker in shadow, with a soft falloff down its length. Flooding the
    mask with a new colour throws all of that away and the edge stops being a
    surface: it reads as a sticker laid over the photograph.

    So only the COLOUR is replaced and the LUMINANCE is kept. Each pixel's
    brightness relative to the strip's own average becomes a multiplier on the
    target colour, so a spot that was 12% brighter than the rest of the edge is
    still 12% brighter afterwards. The lighting is the scene's; the hue is the
    product's.

    Measured relative to the strip's mean rather than to absolute brightness,
    because the two studio depths are lit differently -- the 38mm edge catches
    more light than the 18mm -- and an absolute mapping would make one of them
    wrong in every scene.
    """
    if mask is None or not mask.any():
        return scene
    target = np.array(hex_to_bgr(hex_colour), dtype=np.float32)

    grey = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sel = mask > 0
    mean = float(grey[sel].mean()) or 1.0
    ratio = np.clip(grey / mean, EDGE_SHADE_CLIP[0], EDGE_SHADE_CLIP[1])

    painted = np.clip(target[None, None, :] * ratio[..., None], 0, 255).astype(np.uint8)

    # Feathered by a pixel so the strip meets the wall and the face cleanly;
    # the mask came from a colour key and its border is a shade ragged.
    a = cv2.GaussianBlur(mask, (3, 3), 0).astype(np.float32) / 255.0
    return (scene.astype(np.float32) * (1 - a[..., None])
            + painted.astype(np.float32) * a[..., None]).astype(np.uint8)


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


def render_product(product, scenes, corners, shading_dir, edges_dir, out_dir, force, log):
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

    # The override wins whenever it is set. "Prominent" is a judgement, and the
    # scorer will sometimes land on a caption box rather than the thing the
    # design is about; one Studio edit beats arguing with the algorithm.
    override = (product.get("edgeColour") or "").strip()
    if override:
        edge_hex, why = override, "edgeColour on the product"
    else:
        edge_hex, why = prominent_colour(art), "extracted from the artwork"
    log(f"  {slug}: artwork {aw}x{ah} -> {orientation} scenes, edge {edge_hex} ({why})")

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
        edge = cv2.imread(os.path.join(edges_dir, scene_name + ".png"), cv2.IMREAD_GRAYSCALE)
        gain = SCENE_SHADING_GAIN.get(name, 1.0)
        composed = scene
        for q in info["quads"]:
            sh = load_shading(shading_dir, f"{scene_name}__{q['name']}")
            if q.get("mesh"):
                # A poster curls; a canvas does not. The scene's own light is
                # let through harder here on purpose -- the highlight running
                # along the curl is the thing that says "paper", and at the
                # canvas weighting it flattens out to nothing.
                composed = warp_mesh(art, composed, q["mesh"], sh,
                                     shade_gain=POSTER_SHADING_GAIN)
            else:
                sil = face_silhouette(scene, q["corners"], edge)
                composed = warp_into(art, composed, q["corners"], sh,
                                     silhouette=sil, shade_gain=gain)
        # After the faces, not before: the warp writes over the face and would
        # otherwise take a freshly painted edge with it wherever the quad and
        # the strip overlap by a pixel.
        if edge is not None and edge.any():
            composed = recolour_edge(composed, edge, edge_hex)
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
    ap.add_argument("--edges", default=DEFAULT_EDGES)
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
         '"first": images[0].asset._ref, edgeColour} | order(slug asc)')
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
            ov = (p.get("edgeColour") or "").strip()
            print(f"     {p['slug']:34s} {which:10s} {state}"
                  + (f"  edge {ov} (override)" if ov else ""))
            if not ref:
                print("        no image on this product")
        print("\n  dry run: nothing written")
        return 0

    results = []
    for p in products:
        r = render_product(p, args.scenes, corners, args.shading, args.edges, args.out, args.force, print)
        if r:
            results.append(r)
    made = sum(len(r.get("written", [])) for r in results)
    print(f"\n  {made} file(s) written for {len(results)} product(s) into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
