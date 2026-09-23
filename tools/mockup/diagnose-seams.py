"""
What is actually in the seam, side by side, with the crops to prove it.

    python tools/mockup/diagnose-seams.py [--scenes-list room-landscape,...]
                                          [--crops DIR]

"There is still edging on the canvases" is a report about a rim a few pixels
wide somewhere on a boundary. It is not yet something anyone can fix, because a
rim has several causes that look alike at 100% and want opposite remedies --
see seam_band.py, which owns the classification and is shared with both
verifiers so the three cannot drift apart.

The scene is composited with a NEUTRAL GREY stand-in rather than real artwork.
That removes the hard part: real artwork is saturated and so is the
placeholder, so telling "covered" from "not covered" would mean comparing two
pictures that look alike, and dark artwork at its own edge would read as a
black rim. Against flat grey, anything saturated is something the renderer
failed to cover and anything black is something it painted.

The crops, though, come from the REAL rendered JPEGs, because those are what
Alan is looking at when he says there is edging.
"""
import argparse
import importlib.util
import json
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("This needs opencv-python and numpy:\n    python -m pip install opencv-python numpy")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene_guard  # noqa: E402
import seam_band as SB  # noqa: E402

_spec = importlib.util.spec_from_file_location("_render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
# Which rendered product stands in for each scene when cutting crops.
CROP_SOURCE = {"portrait": "bruce-lee-cover", "landscape": "mad-max-desert-rig"}
OUT_FOR = {"room": "room", "studio": "studio", "poster": "poster"}
CROP_HALF = 16
CROP_ZOOM = 4


def stand_in(w, h):
    """Flat neutral grey. Nothing here is saturated and nothing here is black."""
    return np.full((h, w, 3), 128, np.uint8)


def composite(scene, info, name, edge, shading_dir):
    """
    The scene with grey stand-ins, through render.py's own compositor.

    Not a local reconstruction of it. This file used to rebuild the composite
    itself, and so did both verifiers, and each was a slightly different
    picture from the one that gets written -- which is how three checks came to
    pass on a renderer that was drawing a black rim round every canvas.

    Returned at OUTPUT resolution, because that is where the render is now
    assembled; callers scale their geometry to match.
    """
    art = stand_in(1500, 1000) if info["orientation"] == "landscape" else stand_in(1000, 1500)
    return R.compose_scene(scene, info, name, edge, art, shading_dir, "#f9dd3c")


def cut_crop(name, orientation, quad, side_index, out_dir, label):
    """A 400% crop of the middle of one side, from the real rendered JPEG."""
    slug = CROP_SOURCE[orientation]
    kind = OUT_FOR[name.split("-")[0]]
    path = os.path.join(HERE, "out", slug, kind + ".jpg")
    im = cv2.imread(path)
    if im is None:
        return None
    s = im.shape[1] / 1536.0
    a, b = np.array(quad[side_index], float), np.array(quad[(side_index + 1) % 4], float)
    p = (a + b) / 2.0 * s
    x, y = int(round(p[0])), int(round(p[1]))
    x = max(CROP_HALF, min(im.shape[1] - CROP_HALF - 1, x))
    y = max(CROP_HALF, min(im.shape[0] - CROP_HALF - 1, y))
    crop = im[y - CROP_HALF:y + CROP_HALF, x - CROP_HALF:x + CROP_HALF]
    big = cv2.resize(crop, None, fx=CROP_ZOOM * 2, fy=CROP_ZOOM * 2,
                     interpolation=cv2.INTER_NEAREST)
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, label + ".png")
    cv2.imwrite(dest, big)
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--corners", default=os.path.join(HERE, "scenes.json"))
    ap.add_argument("--edges", default=os.path.join(HERE, "edges"))
    ap.add_argument("--shading", default=os.path.join(HERE, "shading"))
    ap.add_argument("--scenes-list", default="room-landscape,studio-portrait,studio-landscape")
    ap.add_argument("--crops", default=os.path.join(HERE, "seam-crops"))
    args = ap.parse_args()

    corners = json.load(open(args.corners, encoding="utf-8"))
    scene_guard.require(args.scenes, corners)
    wanted = [s.strip() for s in args.scenes_list.split(",") if s.strip()]

    findings = []
    for name in wanted:
        info = corners.get(name)
        if not info:
            print(f"  {name}: not in scenes.json")
            continue
        scene = cv2.imread(os.path.join(args.scenes, name + ".png"))
        edge = cv2.imread(os.path.join(args.edges, name + ".png"), cv2.IMREAD_GRAYSCALE)
        composed = composite(scene, info, name, edge, args.shading)
        # The composite is at output size now, so the plate and the geometry
        # have to be brought to the same place before anything is measured.
        k = composed.shape[1] / float(scene.shape[1])
        scene = R.fit_long_side(scene, R.OUT_LONG_SIDE)

        print("")
        print(f"  {name}")
        for q in info["quads"]:
            quad = [[p[0] * k, p[1] * k] for p in R.quad_of(q)]
            nud = R.nudge_of(q)
            extra = f"   nudge {dict(zip(SB.SIDES, nud))}" if any(nud) else ""
            print(f"    {q['name']}{extra}")
            sig = SB.content_signature(scene, quad)
            for i, side in enumerate(SB.SIDES):
                rows = SB.walk_side(scene, composed, quad[i], quad[(i + 1) % 4], sig=sig)
                kind, start, depth = SB.score_side(rows)
                label = f"{name}__{q['name']}__{side}"
                cut_crop(name, info["orientation"], quad, i, args.crops, label)
                print(f"      {side:7s} {SB.describe(kind, start, depth)}")
                if depth:
                    findings.append((name, q["name"], side, kind, start, depth))

    print("")
    if not findings:
        print("  every side clean")
    else:
        print(f"  {len(findings)} side(s) affected:")
        for name, qn, side, kind, start, depth in findings:
            print(f"    {name:18s} {qn:22s} {side:7s} {depth:2d} px  {kind:12s} from {start:+d}")
    print(f"  crops in {args.crops}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
