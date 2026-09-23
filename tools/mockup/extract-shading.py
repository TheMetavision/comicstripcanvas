"""
One shading layer per canvas face, so warped artwork picks up the scene's light.

    python tools/mockup/extract-shading.py [--scenes DIR] [--corners FILE] [--out DIR]

A mockup fails on lighting long before it fails on geometry. Warp a flat image
into a perfect quad and it still looks pasted on, because the scene has a
softbox on the left, a fall-off down the wall, and a slight sheen across the
canvas weave, and the artwork has none of them. The fix is a greyscale multiply
layer per face, holding only the light.

── Two ways to get it, and only one of them is available here ──────────────

    DIVIDE (accurate).  Given source-artwork.png -- the flat file that was
    printed into the scene -- the light is simply what the scene did to it:

        shading = luma(scene face) / luma(source, warped to the same quad)

    Everything the artwork contributes cancels, and what is left is the light.

    LUMINANCE (fallback, and what runs today).  With no source file there is
    nothing to divide by, so the artwork's own tones have to be separated from
    the light by the only thing that distinguishes them: SCALE. Light varies
    slowly across a canvas; artwork varies fast. A heavy blur keeps the first
    and discards the second.

The fallback's weakness is exactly where that assumption breaks. The placeholder
artwork in these scenes is a dark cityscape with a hot pink sky across the top
third -- a low-frequency feature the blur cannot tell from a light source. So
the extracted shading carries a faint memory of it: a broad brightening where
the sky was. It is mild after normalising, and far better than no shading at
all, but it is a real artefact and the reason SOURCE_ARTWORK exists below.

Drop source-artwork.png into the scenes folder and this switches to divide
automatically -- no flag, because a method that is available and better should
not need to be asked for.
"""
import argparse
import json
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("This needs opencv-python and numpy:\n    python -m pip install opencv-python numpy")

HERE = os.path.dirname(__file__)
DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_CORNERS = os.path.join(HERE, "scenes.json")
DEFAULT_OUT = os.path.join(HERE, "shading")
SOURCE_ARTWORK = "source-artwork.png"

# The rectangle a face is unwarped into before the light is measured. Big
# enough to keep the gradient smooth, small enough that the blur is cheap.
WORK_LONG_SIDE = 1400
# Blur radius as a fraction of the long side. Large on purpose: it is the only
# thing separating "light" from "picture" in the fallback.
BLUR_FRACTION = 0.20
# How hard the fallback is allowed to push, as a fraction of what it measured.
#
# Measured at full strength the layers pinned against the clip at both ends,
# which is the placeholder artwork showing through rather than the light: its
# dark cityscape and hot pink sky are a slow, broad tonal split that no blur
# separates from a real gradient. Halving the deviation keeps the direction of
# the light -- which is the part that sells a mockup -- and drops most of the
# borrowed picture. The divide method needs none of this, and says so below.
FALLBACK_STRENGTH = 0.45
# How far the multiplier may stray from 1.0 whatever the method says.
CLIP = (0.62, 1.42)


def quad_size(corners):
    """The rectangle this quad is closest to, keeping its longer edges."""
    c = np.array(corners, dtype=np.float32)
    w = max(np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[2] - c[3]))
    h = max(np.linalg.norm(c[3] - c[0]), np.linalg.norm(c[2] - c[1]))
    k = WORK_LONG_SIDE / max(w, h)
    return max(8, int(round(w * k))), max(8, int(round(h * k)))


def unwarp(img, corners, size):
    """The face, flattened back into a rectangle."""
    w, h = size
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(np.array(corners, dtype=np.float32), dst)
    return cv2.warpPerspective(img, m, (w, h), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)


def shading_from_luminance(face_bgr):
    """The fallback: keep what varies slowly, discard what varies fast."""
    luma = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    k = int(max(3, round(min(luma.shape) * BLUR_FRACTION)) | 1)
    slow = cv2.GaussianBlur(luma, (k, k), 0)
    mean = float(np.mean(slow)) or 1.0
    return slow / mean


def shading_from_divide(face_bgr, source_bgr):
    """The accurate one: whatever the scene did to a known flat file."""
    a = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) + 1.0
    b = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) + 1.0
    ratio = a / b
    # A light touch only: this is already free of the artwork, so the blur is
    # here to take out sensor noise and JPEG mush, not to separate anything.
    k = int(max(3, round(min(ratio.shape) * 0.012)) | 1)
    ratio = cv2.GaussianBlur(ratio, (k, k), 0)
    mean = float(np.mean(ratio)) or 1.0
    return ratio / mean


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--corners", default=DEFAULT_CORNERS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    if not os.path.exists(args.corners):
        sys.exit(f"No corners yet: {args.corners}\nRun tools/mockup/pick-corners.py first.")
    with open(args.corners, encoding="utf-8") as f:
        scenes = json.load(f)
    os.makedirs(args.out, exist_ok=True)

    src_path = os.path.join(args.scenes, SOURCE_ARTWORK)
    source = cv2.imread(src_path) if os.path.exists(src_path) else None
    method = "divide" if source is not None else "luminance"
    print(f"  method: {method}" + ("" if source is not None
          else f"  (no {SOURCE_ARTWORK} in the scenes folder)"))

    index = {}
    for scene, info in scenes.items():
        img = cv2.imread(os.path.join(args.scenes, scene + ".png"))
        if img is None:
            print(f"  {scene}: cannot read the scene")
            continue
        for q in info["quads"]:
            size = quad_size(q["corners"])
            face = unwarp(img, q["corners"], size)
            if source is not None:
                # The source is flat art, so it only needs resizing to the face
                # rectangle -- it was never in the scene's perspective.
                s = cv2.resize(source, size, interpolation=cv2.INTER_AREA)
                sh = shading_from_divide(face, s)
            else:
                sh = shading_from_luminance(face)
                sh = 1.0 + (sh - 1.0) * FALLBACK_STRENGTH
            sh = np.clip(sh, *CLIP)

            key = f"{scene}__{q['name']}"
            path = os.path.join(args.out, key + ".png")
            # 16-bit, with 1.0 at mid-scale: the multiplier both darkens and
            # brightens, and 8 bits across that range bands visibly on a large
            # flat area of sky.
            cv2.imwrite(path, np.clip(sh * 32768.0, 0, 65535).astype(np.uint16))
            index[key] = {"scene": scene, "quad": q["name"], "size": list(size),
                          "method": method, "scale": 32768.0,
                          "min": round(float(sh.min()), 3), "max": round(float(sh.max()), 3),
                          "mean": round(float(sh.mean()), 3)}
            print(f"  {key:44s} {size[0]}x{size[1]}  range {sh.min():.2f}-{sh.max():.2f}")

    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    print(f"\n  {len(index)} shading layer(s) in {args.out}")


if __name__ == "__main__":
    main()
