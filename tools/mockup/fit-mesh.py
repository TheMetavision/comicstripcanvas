"""
Bend each side of a poster quad onto the edge the photograph actually has.

    python tools/mockup/fit-mesh.py [--search 12] [--apply]

A canvas is stretched flat over a frame, so four corners describe it. A poster
lying on a table is a sheet of paper: it lifts at the corners and bows along
the edges, and a straight line between two clicked corners cuts the corner off
at one end of a side and hangs off the paper at the other. render.py therefore
warps posters through a twelve-point thin-plate spline instead -- corner, then
a third and two thirds along the edge leaving it, four times round.

Those twelve points used to be clicked by hand, which made them a SECOND
independent record of where the poster is. When the corners were re-clicked and
the mesh was not, the two records drifted 27 px apart, and nothing noticed:
render.py warps through the mesh while verify-faces measures inside the quad,
so each was right about a different poster.

So the mesh is no longer independent. It is derived here FROM the corners: each
side is sampled along its length, the perpendicular offset to the strongest
gradient is measured at each sample, that profile is smoothed, and the two mesh
points are read off it. The corners themselves stay exactly where they were
clicked -- only the four mid-side pairs move -- so a mesh can never again
describe a different poster from the quad it belongs to.

Where a side has no edge under it -- the poster runs out of frame at the bottom
of poster-portrait -- the offset falls back to zero, which is the straight line
between two corners that are known good.
"""
import argparse
import json
import os
import shutil
import sys
import time

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("This needs opencv-python and numpy:\n    python -m pip install opencv-python numpy")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene_guard  # noqa: E402
import refine_corners_lib as RC  # noqa: E402

DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_CORNERS = os.path.join(HERE, "scenes.json")

# Wider than refine-corners' six: that looks for a straight side clicked a few
# pixels out, this looks for a curl, and the landscape poster bows by about ten.
SEARCH = 12
SAMPLES = 160
# Skip the ends of each side. The corners are fixed, and near them the other
# side's gradient is the strongest thing in the search window.
END_SKIP = 0.12
# An offset only counts if there is really an edge under it.
MIN_RESPONSE = 12.0
# Median window over the offset profile, in samples. Wide enough to shrug off a
# shadow or a fold, narrow enough to keep the curl.
SMOOTH = 21


def side_profile(mag, a, b, search):
    """Perpendicular offset to the strongest edge, at each sample along a to b."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    length = np.linalg.norm(d)
    t = d / (length or 1)
    n = np.array([t[1], -t[0]])

    ts, offs = [], []
    for s in np.linspace(END_SKIP, 1 - END_SKIP, SAMPLES):
        p = a + d * s
        best, best_o = -1.0, None
        for o in np.arange(-search, search + 0.25, 0.25):
            q = p + n * o
            v = RC.sample(mag, q[0], q[1])
            if v > best:
                best, best_o = v, o
        ts.append(s)
        offs.append(best_o if best > MIN_RESPONSE else np.nan)

    offs = np.array(offs, float)
    found = int(np.isfinite(offs).sum())
    if found < SAMPLES * 0.25:
        return np.array(ts), np.zeros(len(ts)), found

    # Median-smooth over the samples that found an edge, and hold straight
    # wherever none did.
    out = np.zeros(len(offs))
    half = SMOOTH // 2
    for i in range(len(offs)):
        w = offs[max(0, i - half):i + half + 1]
        w = w[np.isfinite(w)]
        out[i] = float(np.median(w)) if len(w) else 0.0
    return np.array(ts), out, found


def fit(scene, corners, search=SEARCH):
    """The twelve mesh points, and what each side was found to do."""
    mag = RC.gradient(scene)
    mesh, notes = [], []
    for i in range(4):
        a = np.array(corners[i], float)
        b = np.array(corners[(i + 1) % 4], float)
        d = b - a
        length = np.linalg.norm(d) or 1
        n = np.array([d[1] / length, -d[0] / length])

        ts, offs, found = side_profile(mag, a, b, search)
        mesh.append([float(a[0]), float(a[1])])
        picked = []
        for t in (1 / 3, 2 / 3):
            o = float(np.interp(t, ts, offs))
            picked.append(o)
            p = a + d * t + n * o
            mesh.append([float(p[0]), float(p[1])])
        notes.append((picked, found))
    return mesh, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--corners", default=DEFAULT_CORNERS)
    ap.add_argument("--search", type=int, default=SEARCH)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    data = json.load(open(args.corners, encoding="utf-8"))
    scene_guard.require(args.scenes, data)
    SIDE = ["top", "right", "bottom", "left"]

    for name, info in data.items():
        scene = cv2.imread(os.path.join(args.scenes, name + ".png"))
        for q in info["quads"]:
            if "mesh" not in q:
                continue
            quad = [list(map(float, c)) for c in (q.get("cornersRefined") or q["corners"])]
            mesh, notes = fit(scene, quad, args.search)
            print("")
            print(f"  {name} / {q['name']}")
            for i, (picked, found) in enumerate(notes):
                where = "no edge found, held straight" if not found else f"from {found}/{SAMPLES} samples"
                print(f"      {SIDE[i]:6s} side bows {picked[0]:+5.1f} / {picked[1]:+5.1f} px  ({where})")
            q["mesh"] = [[round(x, 1), round(y, 1)] for x, y in mesh]

            # The mesh is what render.py fills; the quad is what everything else
            # measures. They have to describe the same poster.
            h, w = scene.shape[:2]
            qm = np.zeros((h, w), np.uint8)
            cv2.fillConvexPoly(qm, np.array(quad, np.int32), 255)
            hm = np.zeros((h, w), np.uint8)
            cv2.fillConvexPoly(hm, cv2.convexHull(np.array(mesh, np.int32)), 255)
            outside = int(cv2.bitwise_and(qm, cv2.bitwise_not(hm)).sum() // 255)
            print(f"      quad pixels the mesh does not cover: {outside}")

    if not args.apply:
        print("")
        print("  not applied - pass --apply")
        return 0
    backup = args.corners.replace(".json", f".preMesh-{time.strftime('%Y%m%dT%H%M%S')}.json")
    shutil.copy2(args.corners, backup)
    json.dump(data, open(args.corners, "w", encoding="utf-8"), indent=2)
    print("")
    print(f"  written; backup at {os.path.basename(backup)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
