"""
The per-side nudge: does it move the side it names, by the amount it says?

Run: python tools/mockup/test_nudge.py

The nudges are currently all zero -- the seam they were added for turned out to
be a black warp border, not a misplaced boundary -- so nothing in the rendered
set exercises this. That is exactly when a mechanism rots, and the next person
to need a nudge will be someone looking at a rim, in a hurry, with no reason to
doubt the tool. So it is tested against geometry rather than against a render.
"""
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("_render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

# A deliberately non-axis-aligned quad: a nudge that only works on rectangles
# would pass on a square and fail on every scene in the set.
QUAD = [[100.0, 100.0], [500.0, 140.0], [520.0, 460.0], [80.0, 420.0]]
FAILS = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def side_distance(quad, i, point):
    """Signed distance from the line of side i to a point, positive outward."""
    a = np.array(quad[i], float)
    b = np.array(quad[(i + 1) % 4], float)
    n = R._shift_side(a, b, 1.0)[0] - a          # the unit outward normal
    return float(np.dot(np.array(point, float) - a, n))


def main():
    base = {"corners": QUAD}

    check("no nudge returns the corners untouched",
          R.quad_of(base) == QUAD)

    check("an all-zero nudge is the same as no nudge",
          R.quad_of({**base, "nudge": {"top": 0, "right": 0, "bottom": 0, "left": 0}}) == QUAD)

    check("cornersRefined wins over corners",
          R.quad_of({"corners": QUAD, "cornersRefined": [[1, 2]] * 4}) == [[1, 2]] * 4)

    # Each side, on its own, by two pixels.
    for i, side in enumerate(R.SIDE_NAMES):
        moved = R.quad_of({**base, "nudge": {side: 2}})
        # Both corners of that side sit 2px outside the original side's line.
        d0 = side_distance(QUAD, i, moved[i])
        d1 = side_distance(QUAD, i, moved[(i + 1) % 4])
        check(f"nudge {side}=2 moves that side out by 2px",
              abs(d0 - 2) < 1e-6 and abs(d1 - 2) < 1e-6,
              f"corners at {d0:+.3f}, {d1:+.3f}")

        # And the two corners NOT on that side do not move at all.
        others = [k for k in range(4) if k not in (i, (i + 1) % 4)]
        still = all(abs(moved[k][0] - QUAD[k][0]) < 1e-6 and abs(moved[k][1] - QUAD[k][1]) < 1e-6
                    for k in others)
        check(f"nudge {side}=2 leaves the opposite corners alone", still)

    # A nudge must not bend the quad: the corners of a nudged side stay on one
    # straight line, which is what moving SIDES rather than corners buys.
    moved = R.quad_of({**base, "nudge": {"top": 3, "left": 2}})
    for i in range(4):
        a, b = np.array(moved[i]), np.array(moved[(i + 1) % 4])
        mid = (a + b) / 2
        check(f"side {R.SIDE_NAMES[i]} is still straight after a two-side nudge",
              abs(side_distance(moved, i, mid)) < 1e-6)

    check("a negative nudge pulls the side inward",
          side_distance(QUAD, 0, R.quad_of({**base, "nudge": {"top": -2}})[0]) < -1.9)

    print("")
    print(f"  {'FAILED: ' + ', '.join(FAILS) if FAILS else 'all nudge checks passed'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
