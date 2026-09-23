"""
Where a face and its side panel meet, they must meet at the SAME two points.

A canvas's front and its wrapped edge share a physical line. In the render they
are two polygons, and if each works out that line from its own evidence -- the
face from the clicked corners, the panel from wherever the pink keying happened
to stop -- then the two answers differ, and the difference is visible as a step
at the corner. On room-landscape it is twelve pixels.

There is no tolerance worth arguing about here, so the tolerance is half a
pixel: either the panel is built from the face's edge or it is not.
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify_common as V  # noqa: E402
import sides as SD  # noqa: E402

TOLERANCE = 0.5


def main():
    scenes = V.load_scenes()
    worst, bad, checked, how = 0.0, [], 0, None

    for name, info in scenes.items():
        scene, edge = V.scene_and_edge(name)
        if edge is None or not edge.any():
            continue
        for q in info["quads"]:
            if q.get("mesh"):
                continue
            quad = V.R.quad_of(q)
            panels, how = V.side_polys(scene, edge, quad)
            for i, poly in panels.items():
                # The panel's first two points are its inner edge, and they are
                # supposed to BE the face's corners i and i+1.
                for k, corner in ((0, i), (1, (i + 1) % 4)):
                    d = float(np.linalg.norm(np.array(poly[k], float)
                                             - np.array(quad[corner], float)))
                    checked += 1
                    worst = max(worst, d)
                    if d > TOLERANCE:
                        bad.append((name, q["name"], SD.SIDES[i], SD.SIDES[corner], d))

    print(f"  side panels taken from: {how}")
    print("")
    for name, qn, side, corner, d in sorted(bad, key=lambda r: -r[4]):
        print(f"  {name:18s} {qn:22s} {side:6s} panel / {corner:6s} corner "
              f"apart by {d:6.2f} px")
    print("")
    print(f"  {len(bad)} of {checked} shared vertices are more than {TOLERANCE} px apart; "
          f"worst {worst:.2f} px")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
