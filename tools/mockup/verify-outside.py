"""
Outside the geometry it draws, the renderer must not have touched the scene.

A mockup is a photograph with some polygons drawn on it. Every pixel outside
those polygons belongs to the photograph, and if the render has changed one
then something is leaking: a tint whose falloff runs past the shape it was
meant to fill, a mask keyed a little too generously, artwork spilling onto the
wall.

Both faults Alan found on the right-hand canvas are this. The recolour's alpha
came from a distance transform, which ramps in EVERY direction from the mask --
outward onto the wall as readily as inward onto the face -- so a couple of
pixels of the room were being tinted the product's colour. What made it obvious
was that the canvas's own specular rim was not keyed as pink, so it sat outside
the mask, got tinted anyway, and came out bright cyan.

Measured on the composite before JPEG, because a JPEG's ringing around a hard
edge is real but is not the renderer's doing, and a check that has to tolerate
it cannot see a two-pixel halo underneath.
"""
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify_common as V  # noqa: E402

BAND = 4
# Per-channel difference that counts as touched. Small, but not zero: the plate
# is resampled and the composite is built on a resampled plate, and the two
# resamplings are the same operation but not always the same rounding.
TOLERANCE = 3


def main():
    scenes = V.load_scenes()
    total_bad, worst, rows = 0, 0, []

    for name, info in scenes.items():
        scene, edge = V.scene_and_edge(name)
        k = V.plate_scale(scene)
        base = V.plate(scene)
        comp = V.composite(name, info, scene, edge, V.flat_art(info, 128))

        polys = []
        for q in info["quads"]:
            if q.get("mesh"):
                polys.append(V.scaled(cv2.convexHull(
                    np.array(q["mesh"], np.float32)).reshape(-1, 2).tolist(), k))
                continue
            quad = V.R.quad_of(q)
            panels, _how = V.side_polys(scene, edge, quad)
            polys.append(V.scaled(V.face_poly(quad, panels), k))
            for poly in panels.values():
                polys.append(V.scaled(poly, k))

        drawn = V.coverage_mask(polys, comp.shape)
        band = cv2.bitwise_and(cv2.dilate(drawn, np.ones((2 * BAND + 1,) * 2, np.uint8)),
                               cv2.bitwise_not(drawn))
        diff = np.max(np.abs(comp.astype(np.int16) - base.astype(np.int16)), axis=2)
        hit = (band > 0) & (diff > TOLERANCE)
        n = int(hit.sum())
        mx = int(diff[band > 0].max()) if (band > 0).any() else 0
        total_bad += n
        worst = max(worst, mx)
        rows.append((name, n, mx, int((band > 0).sum())))
        if n:
            ys, xs = np.where(hit)
            where = f"   e.g. at {[(int(xs[i]), int(ys[i])) for i in range(0, min(4 * 40, len(xs)), max(1, len(xs) // 4))][:4]}"
        else:
            where = ""
        print(f"  {name:20s} touched outside: {n:6d} px of {int((band > 0).sum()):7d} "
              f"in the {BAND}px band   worst delta {mx:3d}{where}")

    print("")
    print(f"  TOTAL {total_bad} px changed outside the drawn geometry; worst delta {worst}")
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())
