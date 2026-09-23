"""
Nothing of the placeholder may survive inside a canvas face.

    python tools/mockup/verify-faces.py

The scenes were photographed with a real design on the canvas -- Cats on Crack,
in hot pink and neon purple -- and every mockup replaces it. Any of it left
showing is the worst failure this pipeline has: not a mockup that looks slightly
wrong, a mockup that advertises somebody else's artwork on a product page.

It has happened once already, and not by the obvious route. The face mask used
to be trimmed by a test that removed boundary pixels resembling the surroundings;
parts of the placeholder near the edge resemble a dark room, so they were cut
out of the mask, so the warp never covered them, so the placeholder showed
through in strips. The check that would have caught it is this one.

── Two things this got wrong, and they are the point ──────────────────────

It measured inside the FACE MASK, which is the quad minus the edge mask. The
face mask is derived from the edge mask, so any error in the edge mask was
invisible to a test scoped by it: when the edge keying over-reached and claimed
bands inside the quad, those bands were dropped from the face, never covered by
artwork, painted by the edge recolour -- and not looked at, because they were
not in the region the test had decided to examine. A test must not take its
scope from the thing it is testing. It now measures inside the QUAD.

And it used artwork shaped like the quad, so the artwork fitted the quad by
construction. The catalogue is 3:2 and 2:3 and the quads are not -- the studio
landscape canvases are 1.22:1 against artwork at 1.50:1 -- so the shapes that
matter were never the shapes being tried.

── How it decides ─────────────────────────────────────────────────────────

The signature is taken from the scene itself: the face region of the untouched
photograph, clustered, keeping only the SATURATED clusters. That matters,
because the test then composites a deliberately neutral grey artwork. Grey
cannot accidentally match hot pink, so every hit is placeholder rather than a
coincidence of the product's own palette -- which is also why this cannot be
run against a real product's render and mean anything.

Measured inside the QUAD, pulled in by a couple of pixels for the inset and the
feather -- and deliberately NOT by the edge mask, for the reason above.
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
cv2 = R.cv2
sys.path.insert(0, HERE)
import scene_guard  # noqa: E402
import seam_band as SB  # noqa: E402

SCENES = R.DEFAULT_SCENES
# Only clusters this saturated count as signature: the grey stand-in artwork
# must be incapable of matching them.
SIG_MIN_SAT = 70
SIG_CLUSTERS = 6
# Lab distance within which a pixel is that placeholder colour.
SIG_TOLERANCE = 14.0
# Saturation a composited pixel must have before it can be a survivor at all.
SURVIVOR_MIN_SAT = 60
# How far inside the quad the artwork is REQUIRED to be the only thing present.
#
# Three deliberate allowances stack up at the boundary, and the test has to
# start beyond all of them or it fails the pipeline for doing what it was told:
#
#     0px   the edge mask, now that refine-corners puts the boundary where the
#           photograph says it is, stops at it rather than crossing
#     0px   FACE_INSET, for the same reason -- the artwork runs to the boundary
#     2px   EDGE_CROSSFADE_PX, where the recoloured edge fades over the artwork
#     ----
#     2px   and one more, so the limit is not also the measurement
#
# This was 5 when those allowances were 2 + 1 + 1. They shrank, so it shrinks:
# a margin left generous after the thing it was allowing for went away is a
# test quietly checking less than it says it does.
QUAD_MARGIN = 3


def signature(scene, face):
    """The placeholder's saturated colours, in Lab."""
    hsv = cv2.cvtColor(scene, cv2.COLOR_BGR2HSV)
    sel = (face > 0) & (hsv[..., 1] > SIG_MIN_SAT)
    if sel.sum() < 50:
        return None
    lab = cv2.cvtColor(scene, cv2.COLOR_BGR2LAB).astype(np.float32)
    samples = lab[sel].reshape(-1, 3)
    k = min(SIG_CLUSTERS, len(samples))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 25, 1.0)
    _, _, centres = cv2.kmeans(samples, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    return centres


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenes", default="poster",
                    help="which scenes to check, comma separated (default poster, "
                         "the only one that ships)")
    args = ap.parse_args()
    kinds = [k.strip() for k in args.scenes.split(",") if k.strip()]

    corners = json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))
    # Guarded across the WHOLE file even when only some scenes are checked: a
    # scene swapped under corners nobody is looking at today is still a stale
    # scenes.json tomorrow.
    scene_guard.require(SCENES, corners)
    corners = {n: i for n, i in corners.items() if n.split("-")[0] in kinds}
    print(f"  checking {len(corners)} scene(s): {', '.join(kinds)}")
    # Flat grey with a faint grid: nothing in it is saturated, so nothing in it
    # can be mistaken for the placeholder.
    # At the aspects the catalogue actually has. An earlier version used one
    # portrait stand-in and let it stretch, which fits any quad by construction
    # and so could not detect a face the artwork fails to fill.
    def stand_in(w, h):
        a = np.full((h, w, 3), 128, np.uint8)
        a[::40, :] = 96
        a[:, ::40] = 96
        return a
    ARTWORKS = {"landscape": stand_in(1500, 1000), "portrait": stand_in(1000, 1500)}

    total = 0
    for name, info in corners.items():
        scene = cv2.imread(os.path.join(SCENES, name + ".png"))
        edge = cv2.imread(os.path.join(HERE, "edges", name + ".png"), cv2.IMREAD_GRAYSCALE)

        art = ARTWORKS["landscape" if info["orientation"] == "landscape" else "portrait"]
        composed = scene
        for q in info["quads"]:
            sh = R.load_shading(os.path.join(HERE, "shading"), f"{name}__{q['name']}")
            if q.get("mesh"):
                composed = R.warp_mesh(art, composed, q["mesh"], sh,
                                       shade_gain=R.POSTER_SHADING_GAIN)
            else:
                sil = R.face_silhouette(scene, R.quad_of(q), edge)
                composed = R.warp_into(art, composed, R.quad_of(q), sh, silhouette=sil,
                                       shade_gain=R.SCENE_SHADING_GAIN.get(name.split("-")[0], 1.0))
        if edge is not None and edge.any():
            composed = R.recolour_edge(composed, edge, "#f9dd3c")

        lab_after = cv2.cvtColor(composed, cv2.COLOR_BGR2LAB).astype(np.float32)
        # A survivor has to be COLOURED. At low lightness Lab's a/b spread
        # compresses, so a near-black neutral sits within any sane tolerance of
        # a near-black saturated colour -- which flagged 15-18% of the portrait
        # faces as placeholder when what was actually there was grey stand-in
        # artwork in deep shadow. The stand-in is neutral everywhere, so
        # requiring saturation costs nothing and removes the whole false class.
        sat_after = cv2.cvtColor(composed, cv2.COLOR_BGR2HSV)[..., 1]
        for q in info["quads"]:
            # The quad, not the face mask. See the note at the top.
            region = np.zeros(scene.shape[:2], np.uint8)
            cv2.fillConvexPoly(region, np.array(R.quad_of(q), np.int32), 255)
            face = R.face_silhouette(scene, R.quad_of(q), edge)
            sig = signature(scene, face)
            # The outermost row is a deliberate blend. warp_into feathers its
            # mask by 3x3 so the warp's own jaggies do not show against a hard
            # canvas edge, which means that row is part artwork and part scene
            # by design -- and every one of the 11 hits this found before was
            # exactly 1.0px from the boundary, i.e. that row and nothing else.
            # Measured inside it, so the check is about coverage rather than
            # about the anti-aliasing it deliberately has.
            inner = cv2.erode(region, np.ones((2 * QUAD_MARGIN + 1,) * 2, np.uint8))
            if sig is None:
                print(f"  {name:20s} {q['name']:22s} no saturated placeholder here, nothing to check")
                continue
            ys, xs = np.where((inner > 0) & (sat_after > SURVIVOR_MIN_SAT))
            if not len(xs):
                print(f"  {name:20s} {q['name']:22s} placeholder pixels inside the face: "
                      f"     0 (no coloured pixel inside the face at all)")
                continue
            px = lab_after[ys, xs]
            d = np.min(np.linalg.norm(px[:, None, :] - sig[None, :, :], axis=2), axis=1)
            hit = int((d < SIG_TOLERANCE).sum())
            total += hit
            face_px = int((inner > 0).sum())
            pct = 100.0 * hit / max(1, face_px)
            print(f"  {name:20s} {q['name']:22s} placeholder pixels inside the face: "
                  f"{hit:6d}   ({pct:.4f}% of {face_px} face px; "
                  f"{len(xs)} coloured px examined)")
            if hit:
                bad = np.where(d < SIG_TOLERANCE)[0][:4]
                print(f"        e.g. at {[(int(xs[i]), int(ys[i])) for i in bad]}")

    print(f"\n  TOTAL {total}")
    # The count above says whether placeholder survives ANYWHERE inside the
    # face. It cannot say whether there is a RIM: a rim is one or two pixels at
    # a boundary and a face is half a million pixels, so two px of black round
    # every side is 0.0% of the face and rounds away to a pass. That is exactly
    # what happened -- this reported zero on scenes that visibly had a black
    # rim drawn round them. So every boundary is now walked directly, per side,
    # through the same shared seam_band question verify-edges asks.
    rim = 0
    for name, info in corners.items():
        scene = cv2.imread(os.path.join(SCENES, name + ".png"))
        edge = cv2.imread(os.path.join(HERE, "edges", name + ".png"), cv2.IMREAD_GRAYSCALE)
        art = ARTWORKS["landscape" if info["orientation"] == "landscape" else "portrait"]
        composed = scene
        for q in info["quads"]:
            sh = R.load_shading(os.path.join(HERE, "shading"), f"{name}__{q['name']}")
            if q.get("mesh"):
                composed = R.warp_mesh(art, composed, q["mesh"], sh,
                                       shade_gain=R.POSTER_SHADING_GAIN)
            else:
                sil = R.face_silhouette(scene, R.quad_of(q), edge)
                composed = R.warp_into(art, composed, R.quad_of(q), sh, silhouette=sil,
                                       shade_gain=R.SCENE_SHADING_GAIN.get(name.split("-")[0], 1.0))
        if edge is not None and edge.any():
            composed = R.recolour_edge(composed, edge, "#f9dd3c")
        for q in info["quads"]:
            quad = R.quad_of(q)
            sig = SB.content_signature(scene, quad)
            for i, side in enumerate(SB.SIDES):
                rows = SB.walk_side(scene, composed, quad[i], quad[(i + 1) % 4], sig=sig)
                kind, start, depth = SB.score_side(rows)
                if depth:
                    rim += depth
                    print(f"  {name:20s} {q['name']:22s} {side:7s} "
                          f"{SB.describe(kind, start, depth)}")

    print("")
    print(f"  rim pixels at face boundaries: {rim}")
    return 0 if total == 0 and rim == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
