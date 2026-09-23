"""
The canvas edge, checked two ways: no pink left, and no rim at any boundary.

-- what this used to do, and why it passed a scene with a rim on it ---------

It composited with `q["corners"]` and NO silhouette, then counted pink within
six pixels of the edge mask. Three things were wrong with that and they
compounded:

    the clicked corners, not quad_of()   so neither cornersRefined nor any
                                         nudge reached it
    no silhouette                        so the edge mask was never subtracted
                                         and the far-side overlap never applied
    pink only, near the mask only        so anything that was not pink, or was
                                         not beside the mask, was invisible to it

Between them it was not testing the picture render.py makes. It reported zero
while every canvas in the set had a one to two pixel BLACK rim drawn round its
top and side edges -- the warp's constant-black border showing through mask
that reached past the quad -- because black is not pink and the rim was on the
sides that have no edge mask at all.

So it now composites through exactly the same calls as render.py, and asks the
shared seam_band question at every side of every face: what is in the band
either side of this boundary, and does it touch the boundary. The pink count is
kept, because a pink survivor and a rim are different faults and the fix for
one is not the fix for the other.
"""
import importlib.util
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene_guard  # noqa: E402
import seam_band as SB  # noqa: E402

_spec = importlib.util.spec_from_file_location("_render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
TARGET = "#f9dd3c"


def stand_in(w, h):
    """Neutral, lightly gridded. Nothing in it is pink and nothing is black."""
    a = np.full((h, w, 3), 128, np.uint8)
    a[::40, :] = 90
    a[:, ::40] = 90
    return a


def main():
    scenes = json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))
    scene_guard.require(SCENES, scenes)

    pink_total, rim_total = 0, 0
    for name, info in scenes.items():
        scene = cv2.imread(os.path.join(SCENES, name + ".png"))
        edge = cv2.imread(os.path.join(HERE, "edges", name + ".png"), cv2.IMREAD_GRAYSCALE)
        art = stand_in(1500, 1000) if info["orientation"] == "landscape" else stand_in(1000, 1500)

        # render.py's composite, by calling it -- not by repeating it here.
        # Repeating it here is what let this file pass a renderer that was
        # drawing a black rim round every canvas.
        composed = R.compose_scene(scene, info, name, edge, art,
                                   os.path.join(HERE, "shading"), TARGET)
        k = composed.shape[1] / float(scene.shape[1])
        scene = R.fit_long_side(scene, R.OUT_LONG_SIDE)
        if edge is not None:
            edge = R.fit_long_side(edge, R.OUT_LONG_SIDE)

        # 1. pink survivors beside the recoloured strip
        if edge is not None and edge.any():
            near = cv2.dilate(edge, np.ones((13, 13), np.uint8))
            hsv = cv2.cvtColor(composed, cv2.COLOR_BGR2HSV)
            # Two floors. A pixel at value 45 has a magenta cast but is black to
            # look at; "pink survived" means pink you can SEE.
            loose = cv2.inRange(hsv, (145, 45, 40), (180, 255, 255))
            visible = cv2.inRange(hsv, (145, 60, 80), (180, 255, 255))
            surv = cv2.bitwise_and(visible, near)
            n = int(surv.sum() // 255)
            nl = int(cv2.bitwise_and(loose, near).sum() // 255)
            pink_total += n
            print(f"  {name:20s} visible pink within 6px: {n:5d}   "
                  f"(any magenta cast incl. shadow: {nl})")
        else:
            print(f"  {name:20s} no edge mask (poster)")

        # 2. a rim at any boundary, whatever it is made of
        for q in info["quads"]:
            quad = [[p[0] * k, p[1] * k] for p in R.quad_of(q)]
            sig = SB.content_signature(scene, quad)
            for i, side in enumerate(SB.SIDES):
                rows = SB.walk_side(scene, composed, quad[i], quad[(i + 1) % 4], sig=sig)
                kind, start, depth = SB.score_side(rows)
                if depth:
                    rim_total += depth
                    print(f"      {q['name']:22s} {side:7s} {SB.describe(kind, start, depth)}")

    print("")
    print(f"  TOTAL pink {pink_total}   rim px {rim_total}")
    return 0 if pink_total == 0 and rim_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
