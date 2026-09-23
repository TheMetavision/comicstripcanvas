"""
Click the four corners of every canvas face, once per scene.

    python tools/mockup/pick-corners.py [--scenes DIR] [--out FILE] [--scene NAME]

Why this is a hand job and not a detector: it was tried. The canvas edges are a
saturated pink, which sounds like a perfect key until you notice the placeholder
artwork on the canvas is ALSO saturated pink -- the magenta mask lands on the
lettering and the neon as readily as on the edge. Generic quad-finding does no
better: Canny plus approxPolyDP found nothing at all in five of the six scenes
and two wrong regions in the sixth. Four clicks per canvas takes a minute and is
right, which beats a detector that is subtly wrong in a way nobody notices until
a hundred mockups are on the site.

CLICK ORDER IS FIXED and it matters: top-left, top-right, bottom-right,
bottom-left, as the artwork sees it. Not as the screen sees it -- for a canvas
turned away from camera the artwork's top-left may not be the highest point on
screen. Getting this wrong produces artwork that is mirrored or rotated, which
is obvious on a photograph and easy to miss on an abstract print.

Controls
    left click      drop a corner
    u               undo the last corner
    r               restart this quad
    n               accept the quad and move to the next
    s               save and quit
    q               quit without saving
    scroll          zoom about the cursor (the corners are worth zooming for)
    middle drag     pan

Scenes with two canvases -- the studio pair, Standard 18mm and Premium Gallery
38mm -- ask for two quads. The order is left canvas then right canvas, which is
also the order the labels read in the scene.

Output is scenes.json, keyed by scene name, e.g.

    {
      "studio-portrait": {
        "orientation": "portrait",
        "quads": [
          {"name": "standard-18mm", "corners": [[x,y],[x,y],[x,y],[x,y]]},
          {"name": "premium-gallery-38mm", "corners": [...]}
        ]
      }
    }

Re-running is safe: an existing scenes.json is loaded, only the scenes you
actually work through are replaced, and the rest are left exactly as they were.
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

DEFAULT_SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "scenes.json")

# Every scene is a landscape photograph; only the canvas inside it differs.
# The quad names are what render.py writes into its output and what a later
# reader needs to tell the two studio canvases apart.
SCENES = {
    "poster-portrait":   ("portrait",  ["poster"]),
    "room-portrait":     ("portrait",  ["room"]),
    "studio-portrait":   ("portrait",  ["standard-18mm", "premium-gallery-38mm"]),
    "poster-landscape":  ("landscape", ["poster"]),
    "room-landscape":    ("landscape", ["room"]),
    "studio-landscape":  ("landscape", ["standard-18mm", "premium-gallery-38mm"]),
}

CORNER_LABELS = ["top-left", "top-right", "bottom-right", "bottom-left"]


class Picker:
    """One scene's worth of clicking, with zoom and pan."""

    def __init__(self, img, scene, quad_names):
        self.img = img
        self.scene = scene
        self.quad_names = quad_names
        self.h, self.w = img.shape[:2]
        self.quads = []
        self.pts = []
        self.zoom = 1.0
        self.ox, self.oy = 0.0, 0.0
        self.panning = False
        self.pan_from = None

    # ---- coordinate mapping between the window and the image ----
    def to_image(self, x, y):
        return (self.ox + x / self.zoom, self.oy + y / self.zoom)

    def to_window(self, x, y):
        return (int((x - self.ox) * self.zoom), int((y - self.oy) * self.zoom))

    def clamp(self, win_w, win_h):
        vis_w, vis_h = win_w / self.zoom, win_h / self.zoom
        self.ox = max(0.0, min(self.ox, max(0.0, self.w - vis_w)))
        self.oy = max(0.0, min(self.oy, max(0.0, self.h - vis_h)))

    def on_mouse(self, event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN:
            if len(self.pts) < 4:
                self.pts.append(list(self.to_image(x, y)))
        elif event == cv2.EVENT_MBUTTONDOWN:
            self.panning, self.pan_from = True, (x, y)
        elif event == cv2.EVENT_MBUTTONUP:
            self.panning = False
        elif event == cv2.EVENT_MOUSEMOVE and self.panning:
            dx, dy = x - self.pan_from[0], y - self.pan_from[1]
            self.ox -= dx / self.zoom
            self.oy -= dy / self.zoom
            self.pan_from = (x, y)
        elif event == cv2.EVENT_MOUSEWHEEL:
            ix, iy = self.to_image(x, y)
            step = 1.25 if flags > 0 else 1 / 1.25
            self.zoom = max(0.25, min(16.0, self.zoom * step))
            # keep the pixel under the cursor under the cursor
            self.ox, self.oy = ix - x / self.zoom, iy - y / self.zoom

    def draw(self, win_w, win_h):
        self.clamp(win_w, win_h)
        vis_w, vis_h = int(win_w / self.zoom), int(win_h / self.zoom)
        x0, y0 = int(self.ox), int(self.oy)
        crop = self.img[y0:y0 + vis_h, x0:x0 + vis_w]
        view = cv2.resize(crop, (win_w, win_h), interpolation=cv2.INTER_NEAREST)

        def mark(pts, colour, closed):
            wp = [self.to_window(px, py) for px, py in pts]
            for i, (wx, wy) in enumerate(wp):
                cv2.drawMarker(view, (wx, wy), colour, cv2.MARKER_CROSS, 18, 2)
                cv2.putText(view, str(i + 1), (wx + 8, wy - 8),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)
            if len(wp) > 1:
                cv2.polylines(view, [np.array(wp, np.int32)], closed, colour, 1, cv2.LINE_AA)

        for q in self.quads:
            mark(q["corners"], (120, 220, 120), True)
        mark(self.pts, (60, 200, 255), len(self.pts) == 4)

        nth = len(self.quads)
        name = self.quad_names[nth] if nth < len(self.quad_names) else "-"
        nxt = CORNER_LABELS[len(self.pts)] if len(self.pts) < 4 else "press n to accept"
        bar = f"{self.scene}  quad {nth + 1}/{len(self.quad_names)} ({name})  next: {nxt}  zoom {self.zoom:.1f}x"
        cv2.rectangle(view, (0, 0), (win_w, 26), (0, 0, 0), -1)
        cv2.putText(view, bar, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(view, "click corners TL TR BR BL | u undo | r restart | n next | s save | q quit",
                    (8, win_h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1, cv2.LINE_AA)
        return view


def pick_scene(path, scene, quad_names):
    img = cv2.imread(path)
    if img is None:
        print(f"  cannot read {path}")
        return None
    p = Picker(img, scene, quad_names)
    win = "pick corners"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, 1400, 900)
    cv2.setMouseCallback(win, p.on_mouse)

    while True:
        _, _, w, h = cv2.getWindowImageRect(win)
        w, h = max(200, w), max(200, h)
        cv2.imshow(win, p.draw(w, h))
        k = cv2.waitKey(20) & 0xFF
        if k == ord('u') and p.pts:
            p.pts.pop()
        elif k == ord('r'):
            p.pts = []
        elif k == ord('n'):
            if len(p.pts) != 4:
                print("  four corners first")
                continue
            p.quads.append({"name": quad_names[len(p.quads)], "corners": [[round(a, 1), round(b, 1)] for a, b in p.pts]})
            p.pts = []
            if len(p.quads) == len(quad_names):
                cv2.destroyWindow(win)
                return p.quads
        elif k == ord('s'):
            cv2.destroyWindow(win)
            if len(p.quads) != len(quad_names):
                print(f"  {scene}: only {len(p.quads)} of {len(quad_names)} quads done — not saved")
                return None
            return p.quads
        elif k == ord('q'):
            cv2.destroyWindow(win)
            return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenes", default=DEFAULT_SCENES)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--scene", action="append", help="just this scene; repeatable")
    args = ap.parse_args()

    existing = {}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            existing = json.load(f)
        print(f"  loaded {len(existing)} scene(s) from {args.out}")

    todo = args.scene or list(SCENES)
    for scene in todo:
        if scene not in SCENES:
            print(f"  unknown scene {scene}")
            continue
        orientation, quad_names = SCENES[scene]
        path = os.path.join(args.scenes, scene + ".png")
        print(f"\n{scene}  ({orientation}, {len(quad_names)} canvas face(s))")
        quads = pick_scene(path, scene, quad_names)
        if quads is None:
            print("  skipped")
            continue
        existing[scene] = {"orientation": orientation, "quads": quads}
        # Written after every scene, so a long session cannot be lost to a
        # stray q at the end of it.
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2)
        print(f"  saved {len(quads)} quad(s)")

    print(f"\n{len(existing)} scene(s) in {args.out}")


if __name__ == "__main__":
    main()
