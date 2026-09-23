"""
Undo the horizontal stretch in quads clicked before the draw() fix.

    python tools/mockup/migrate-stretched-quads.py [--factor 0.9039] [--apply]

Eight quads were clicked through a view that was horizontally stretched. The
crop feeding the display was clipped at the canvas bounds and then resized to
the full window width anyway, so the picture was scaled by win_w/actual_w in x
while to_image went on dividing by the nominal zoom.

WHAT THIS IS NOT is a padding offset. Subtracting (384, 256) would be the fix if
the clicks had been stored in padded-display space, and they were not -- they
went through to_image, which already takes the padding off, and the y values
came out right, which a padding bug could not have managed. The error is
multiplicative in x about the PADDED origin, and it grows with x: in the real
data the corners moved by +55 to +199 pixels depending where they were, and by
0 to 5 in y.

So the inverse is:

    x_true = (x_stored + pad_x) * k - pad_x        y unchanged

k is the ratio the view was stretched by, which depends only on the window's
shape: at fit zoom it is the padded canvas's aspect over the window's. 1.5/1.66
gives 0.904 for a 1600x964 window, and that is what the data shows -- comparing
the clicked quads against the earlier detected ones gives a median x ratio of
0.9041 with the y ratio at 0.9989.

── What this recovers, and what it does not ───────────────────────────────

The direction and the size of the correction are certain. The exact k is not:
it was inferred, and the corners it produces are Alan's clicks to within about
a percent rather than exactly. That is close enough to judge the mockups by and
not the same as clicking them again on a view that is now correct.
"""
import argparse
import json
import os
import shutil
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SCENES = os.path.join(HERE, "scenes.json")
# 25% padding, as pick-corners applies it, on a 1536x1024 scene.
PAD_X, PAD_Y = 384, 256
# Median of (detected + pad) / (clicked + pad) over all 32 clicked corners,
# which agrees to four decimal places with the 0.9039 a 1600x964 window gives.
DEFAULT_FACTOR = 0.9039


def unstretch(corners, k, pad_x=PAD_X):
    """Scene coordinates as they would have been on an unstretched view."""
    return [[round((x + pad_x) * k - pad_x, 1), round(y, 1)] for x, y in corners]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--factor", type=float, default=DEFAULT_FACTOR)
    ap.add_argument("--apply", action="store_true", help="write it; otherwise just show")
    args = ap.parse_args()

    with open(args.scenes, encoding="utf-8") as f:
        data = json.load(f)

    print(f"  factor {args.factor}  (x only, about the padded origin)")
    out = {}
    for name, info in data.items():
        quads = []
        for q in info["quads"]:
            new = unstretch(q["corners"], args.factor)
            moved = max(abs(a[0] - b[0]) for a, b in zip(new, q["corners"]))
            print(f"    {name:20s} {q['name']:22s} worst x move {moved:6.1f} px")
            print(f"        from {[[int(a), int(b)] for a, b in q['corners']]}")
            print(f"        to   {[[int(a), int(b)] for a, b in new]}")
            quads.append({**q, "corners": new})
        out[name] = {**info, "quads": quads}

    if not args.apply:
        print("\n  not applied — pass --apply")
        return

    backup = args.scenes.replace(".json", f".stretched-{time.strftime('%Y%m%dT%H%M%S')}.json")
    shutil.copy2(args.scenes, backup)
    with open(args.scenes, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"\n  backed up the clicked values to {os.path.basename(backup)}")
    print(f"  wrote {args.scenes}")


if __name__ == "__main__":
    main()
