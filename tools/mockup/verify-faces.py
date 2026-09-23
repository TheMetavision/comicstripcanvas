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

── How it decides ─────────────────────────────────────────────────────────

The signature is taken from the scene itself: the face region of the untouched
photograph, clustered, keeping only the SATURATED clusters. That matters,
because the test then composites a deliberately neutral grey artwork. Grey
cannot accidentally match hot pink, so every hit is placeholder rather than a
coincidence of the product's own palette -- which is also why this cannot be
run against a real product's render and mean anything.

Measured inside the quad, minus the edge mask, minus the inset, and minus one
more row for the feather: the edge is recoloured rather than covered, the inset
ring is deliberately left to the scene, and the outermost row is a deliberate
blend between artwork and scene so that the warp's jaggies do not show against
a hard canvas edge. None of those three is the artwork's job.
"""
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

SCENES = R.DEFAULT_SCENES
# Only clusters this saturated count as signature: the grey stand-in artwork
# must be incapable of matching them.
SIG_MIN_SAT = 70
SIG_CLUSTERS = 6
# Lab distance within which a pixel is that placeholder colour.
SIG_TOLERANCE = 14.0
# Saturation a composited pixel must have before it can be a survivor at all.
SURVIVOR_MIN_SAT = 60


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
    corners = json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))
    # Flat grey with a faint grid: nothing in it is saturated, so nothing in it
    # can be mistaken for the placeholder.
    art = np.full((1200, 900, 3), 128, np.uint8)
    art[::40, :] = 96
    art[:, ::40] = 96

    total = 0
    for name, info in corners.items():
        scene = cv2.imread(os.path.join(SCENES, name + ".png"))
        edge = cv2.imread(os.path.join(HERE, "edges", name + ".png"), cv2.IMREAD_GRAYSCALE)

        composed = scene
        for q in info["quads"]:
            sh = R.load_shading(os.path.join(HERE, "shading"), f"{name}__{q['name']}")
            if q.get("mesh"):
                composed = R.warp_mesh(art, composed, q["mesh"], sh,
                                       shade_gain=R.POSTER_SHADING_GAIN)
            else:
                sil = R.face_silhouette(scene, q["corners"], edge)
                composed = R.warp_into(art, composed, q["corners"], sh, silhouette=sil,
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
            face = R.face_silhouette(scene, q["corners"], edge)
            sig = signature(scene, face)
            # The outermost row is a deliberate blend. warp_into feathers its
            # mask by 3x3 so the warp's own jaggies do not show against a hard
            # canvas edge, which means that row is part artwork and part scene
            # by design -- and every one of the 11 hits this found before was
            # exactly 1.0px from the boundary, i.e. that row and nothing else.
            # Measured inside it, so the check is about coverage rather than
            # about the anti-aliasing it deliberately has.
            inner = cv2.erode(face, np.ones((3, 3), np.uint8))
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
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
