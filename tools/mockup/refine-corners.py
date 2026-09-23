"""
Snap the clicked corners onto the edge the scene actually has.

    python tools/mockup/refine-corners.py [--search 6] [--apply]

A click at zoom is good to a few pixels, and a few pixels is what the seam
between artwork and canvas edge is made of. This looks at the photograph and
moves each corner onto the boundary that is really there.

── By sides, not by corners ───────────────────────────────────────────────

The obvious approach is to search a window around each corner for the strongest
edge response. It is also the weakest: a corner is one pixel of evidence, it is
where two edges meet and therefore where both are least well defined, and the
canvas corner in these scenes is slightly rounded by the wrap.

A SIDE, meanwhile, is hundreds of pixels of the same straight boundary. So each
side is sampled along its length, the perpendicular offset to the strongest
gradient is measured at every sample, and the side is moved by the MEDIAN of
those offsets -- median, because a plant in front of the canvas, a highlight, or
the label text below it will each produce a confident wrong answer at a handful
of samples and none of them should count for much. The refined corners are then
the intersections of the refined sides, which means every corner is positioned
by the two sides that meet there rather than by itself.

── What it writes ─────────────────────────────────────────────────────────

`cornersRefined` on each quad. `corners` is never touched: it is what Alan
clicked, it is the input to this, and if the refinement is ever wrong the way
back has to still be there. render.py prefers cornersRefined when it exists.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_guard  # noqa: E402
DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_CORNERS = os.path.join(HERE, "scenes.json")

# How far either way a side may move. Wider than a careful click should be out,
# narrow enough that the search cannot find a different edge altogether -- the
# canvas edge strip is only a few pixels across and the wall is right behind it.
SEARCH = 6
# Samples along each side. Enough that a third of them can be obscured and the
# median still comes from the boundary.
SAMPLES = 120
# Ignore the last of each side: that is the corner, where the other side's
# gradient contaminates this one's.
END_SKIP = 0.08


def gradient(scene):
    """Edge response, smoothed just enough to be stable at one-pixel steps."""
    g = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 1.0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def sample(mag, x, y):
    """Bilinear, so a sub-pixel offset means something."""
    h, w = mag.shape
    if x < 0 or y < 0 or x > w - 2 or y > h - 2:
        return 0.0
    x0, y0 = int(x), int(y)
    fx, fy = x - x0, y - y0
    return float(
        mag[y0, x0] * (1 - fx) * (1 - fy) + mag[y0, x0 + 1] * fx * (1 - fy)
        + mag[y0 + 1, x0] * (1 - fx) * fy + mag[y0 + 1, x0 + 1] * fx * fy)


def side_offset(mag, a, b, search=SEARCH):
    """
    How far this side should move, perpendicular to itself.

    Positive is to the right of travel from a to b.
    """
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    length = np.linalg.norm(d)
    if length < 4:
        return 0.0, 0
    t = d / length
    n = np.array([t[1], -t[0]])          # perpendicular

    offsets = []
    for s in np.linspace(END_SKIP, 1 - END_SKIP, SAMPLES):
        p = a + d * s
        best, best_o = -1.0, None
        for o in np.arange(-search, search + 0.25, 0.25):
            q = p + n * o
            v = sample(mag, q[0], q[1])
            if v > best:
                best, best_o = v, o
        # A sample with no edge under it anywhere in the window is not evidence
        # of the side being at offset zero; it is no evidence at all.
        if best > 12.0:
            offsets.append(best_o)
    if not offsets:
        return 0.0, 0
    return float(np.median(offsets)), len(offsets)


def shift_line(a, b, offset):
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    t = d / (np.linalg.norm(d) or 1)
    n = np.array([t[1], -t[0]])
    return a + n * offset, b + n * offset


def intersect(p1, p2, p3, p4):
    """Where line p1p2 meets line p3p4."""
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-9:
        return None
    a = x1 * y2 - y1 * x2
    b = x3 * y4 - y3 * x4
    return ((a * (x3 - x4) - (x1 - x2) * b) / den,
            (a * (y3 - y4) - (y1 - y2) * b) / den)


def refine(scene, corners, search=SEARCH):
    """Refined corners, plus what each side was told to do."""
    mag = gradient(scene)
    lines, notes = [], []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        off, n = side_offset(mag, a, b, search)
        lines.append(shift_line(a, b, off))
        notes.append((off, n))

    out = []
    for i in range(4):
        prev = lines[(i - 1) % 4]
        cur = lines[i]
        p = intersect(prev[0], prev[1], cur[0], cur[1])
        out.append(list(p) if p else list(corners[i]))
    return out, notes


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
    LABEL = ["TL", "TR", "BR", "BL"]
    worst = 0.0
    out = {}

    for name, info in data.items():
        scene = cv2.imread(os.path.join(args.scenes, name + ".png"))
        if scene is None:
            print(f"  {name}: cannot read the scene")
            out[name] = info
            continue
        quads = []
        for q in info["quads"]:
            clicked = [list(map(float, c)) for c in q["corners"]]
            refined, notes = refine(scene, clicked, args.search)
            print(f"\n  {name} / {q['name']}")
            for i, (off, n) in enumerate(notes):
                print(f"      {SIDE[i]:6s} side moved {off:+5.2f} px  (from {n}/{SAMPLES} usable samples)")
            for i in range(4):
                dx = refined[i][0] - clicked[i][0]
                dy = refined[i][1] - clicked[i][1]
                dist = (dx * dx + dy * dy) ** 0.5
                worst = max(worst, dist)
                print(f"      {LABEL[i]}  {clicked[i][0]:7.1f},{clicked[i][1]:7.1f}"
                      f"  ->  {refined[i][0]:7.1f},{refined[i][1]:7.1f}"
                      f"   moved {dist:4.1f} px")
            quads.append({**q, "cornersRefined": [[round(x, 2), round(y, 2)] for x, y in refined]})
        out[name] = {**info, "quads": quads}

    print(f"\n  worst corner adjustment: {worst:.1f} px")
    if not args.apply:
        print("  not applied — pass --apply")
        return 0

    backup = args.corners.replace(".json", f".preRefine-{time.strftime('%Y%m%dT%H%M%S')}.json")
    shutil.copy2(args.corners, backup)
    json.dump(out, open(args.corners, "w", encoding="utf-8"), indent=2)
    print(f"  clicked corners preserved as `corners`; backup at {os.path.basename(backup)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
