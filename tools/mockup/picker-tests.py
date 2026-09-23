"""
The picker's coordinate mapping, tested against the picture it actually draws.

    python tools/mockup/picker-tests.py

The point of this file is one bug, and the shape of that bug decides how the
tests are written.

draw() used to crop the canvas array and resize the crop to fill the window.
Numpy clips a slice at the array bounds silently, so whenever the visible region
ran past the canvas -- which the display padding makes the normal case at fit
zoom -- a narrower crop was stretched across the full window. The view was then
scaled by win_w/actual_w in x while to_image went on dividing by self.zoom, and
every click landed wrong by the ratio between the two.

Testing to_image against to_window would have passed. They were exact inverses
of each other the whole time. What neither of them matched was the picture on
the screen, and that is the only thing the person clicking can see.

So these tests RENDER THE VIEW, find a known pixel in it, click on that pixel,
and check what gets stored. A marker painted at a known scene coordinate is
located in the rendered view by searching for its colour, which is what makes
the assertion end-to-end rather than a restatement of the arithmetic.

The window sizes are chosen to matter: 1600x964 is the aspect that produced the
0.904 horizontal error in the real data, and 1920x1000 would have produced 0.78.
"""
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pick_corners", os.path.join(HERE, "pick-corners.py"))
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
cv2 = pc.cv2

PASS, FAIL = [0], [0]


def ok(cond, label, extra=""):
    if cond:
        PASS[0] += 1
        print(f"  PASS  {label}{'  — ' + extra if extra else ''}")
    else:
        FAIL[0] += 1
        print(f"  FAIL  {label}{'  — ' + extra if extra else ''}")


# Far apart on purpose. A first cut stepped one channel by 30 between marks
# and the finder, matching on the summed channel difference, averaged several
# marks into one position and reported 787px errors against correct code. The
# colours have to be further apart than the tolerance, or the test measures
# itself.
MARK_COLOURS = [(0, 0, 255), (0, 255, 0), (255, 0, 0),
                (0, 255, 255), (255, 0, 255), (255, 255, 0)]


def scene_with_marks(w=1536, h=1024, marks=()):
    """A scene with uniquely coloured 3x3 marks at known coordinates."""
    img = np.full((h, w, 3), 30, np.uint8)
    # some texture, so nothing passes by accident on a flat field
    img[::64, :] = 70
    img[:, ::64] = 70
    for i, (x, y) in enumerate(marks):
        cv2.rectangle(img, (x - 1, y - 1), (x + 1, y + 1), MARK_COLOURS[i], -1)
    return img


def find_mark(view, colour, tol=90):
    """Where that mark ended up in the rendered view."""
    d = np.abs(view.astype(np.int16) - np.array(colour, np.int16)).sum(2)
    ys, xs = np.where(d < tol)
    if not len(xs):
        return None
    return float(xs.mean()), float(ys.mean())


print("\n1. A CLICK ON A KNOWN PIXEL STORES THAT PIXEL\n")

MARKS = [(200, 150), (1300, 180), (760, 512), (300, 900), (1480, 990)]
for win_w, win_h in [(1400, 900), (1600, 964), (1920, 1000), (900, 1200)]:
    img = scene_with_marks(marks=MARKS)
    p = pc.Picker(img, "test", ["a"])
    view = p.draw(win_w, win_h)          # fits on the first draw
    worst = 0.0
    for i, (sx, sy) in enumerate(MARKS):
        found = find_mark(view, MARK_COLOURS[i])
        if found is None:
            ok(False, f"{win_w}x{win_h}: mark at {sx},{sy} is not in the view")
            continue
        p.pts = []
        p.on_mouse(cv2.EVENT_LBUTTONDOWN, int(round(found[0])), int(round(found[1])), 0, None)
        gx, gy = p.pts[0]
        worst = max(worst, abs(gx - sx), abs(gy - sy))
    # One view pixel is 1/zoom scene pixels, and the mark is found to the
    # nearest view pixel, so that is the floor on what this can resolve.
    tol = 1.0 / p.zoom + 1.0
    ok(worst <= tol, f"window {win_w}x{win_h}: clicking a mark stores its scene coordinate",
       f"worst {worst:.2f} px, tolerance {tol:.2f}")

print("\n2. THE ASPECT RATIOS THAT BROKE IT\n")
{}
for win_w, win_h in [(1600, 964), (1920, 1000)]:
    img = scene_with_marks(marks=[(1480, 990)])
    p = pc.Picker(img, "test", ["a"])
    view = p.draw(win_w, win_h)
    fx, fy = find_mark(view, MARK_COLOURS[0])
    p.pts = []
    p.on_mouse(cv2.EVENT_LBUTTONDOWN, int(round(fx)), int(round(fy)), 0, None)
    gx, _ = p.pts[0]
    # The old code would have reported this point at 1480/0.904 = 1637 for the
    # 1600x964 window, and 1480/0.781 = 1894 for 1920x1000.
    ok(abs(gx - 1480) < 1.0 / p.zoom + 1.0,
       f"window {win_w}x{win_h}: far-right point is not stretched",
       f"stored x {gx:.1f}, wanted 1480")

print("\n3. ZOOMED AND PANNED\n")

for zoom, ox, oy in [(2.0, 500.0, 300.0), (4.0, 900.0, 700.0), (0.4, -100.0, -50.0)]:
    img = scene_with_marks(marks=MARKS)
    p = pc.Picker(img, "test", ["a"])
    p.fitted = True                       # take the zoom/pan as given
    p.zoom, p.ox, p.oy = zoom, ox, oy
    view = p.draw(1500, 950)
    hits = 0
    worst = 0.0
    for i, (sx, sy) in enumerate(MARKS):
        found = find_mark(view, MARK_COLOURS[i])
        if found is None:
            continue                      # off-screen at this pan, fairly
        hits += 1
        p.pts = []
        p.on_mouse(cv2.EVENT_LBUTTONDOWN, int(round(found[0])), int(round(found[1])), 0, None)
        gx, gy = p.pts[0]
        worst = max(worst, abs(gx - sx), abs(gy - sy))
    ok(hits > 0 and worst <= 1.0 / p.zoom + 1.0,
       f"zoom {zoom}x at pan {ox:.0f},{oy:.0f}: {hits} visible mark(s) store correctly",
       f"worst {worst:.2f} px")

print("\n4. THE PADDING, AND CORNERS OUTSIDE THE PHOTOGRAPH\n")
{}
img = scene_with_marks()
p = pc.Picker(img, "test", ["a"])
ok((p.w, p.h) == (1536 + 2 * p.pad_x, 1024 + 2 * p.pad_y),
   "the display canvas is padded on every side", f"{p.w}x{p.h} from {p.iw}x{p.ih}")
ok((p.pad_x, p.pad_y) == (384, 256), "by 25% of the scene", f"{p.pad_x},{p.pad_y}")

p.draw(1400, 900)
p.pts = []
p.on_mouse(cv2.EVENT_LBUTTONDOWN, 2, 2, 0, None)
gx, gy = p.pts[0]
ok(gx < 0 and gy < 0, "a click in the grey above and left of the photograph goes negative",
   f"{gx:.0f},{gy:.0f}")

# The case this padding exists for: poster-portrait runs off the bottom.
p.pts = []
p.on_mouse(cv2.EVENT_LBUTTONDOWN, 700, 898, 0, None)
gy = p.pts[0][1]
ok(gy > p.ih, "a click below the photograph stores a y past its height",
   f"{gy:.0f} > {p.ih}")

print("\n5. THE MAPPINGS ARE INVERSES, WHICH WAS NEVER THE PROBLEM\n")

p = pc.Picker(scene_with_marks(), "test", ["a"])
worst = 0.0
for zoom in (0.35, 0.6, 1.0, 2.0, 8.0):
    for ox, oy in ((0.0, 0.0), (300.0, 200.0), (-120.0, 90.0)):
        p.zoom, p.ox, p.oy = zoom, ox, oy
        for sx, sy in [(0, 0), (1535, 1023), (-384, -256), (1700, 1200), (768, 512)]:
            wx, wy = p.to_window(sx, sy)
            bx, by = p.to_image(wx, wy)
            worst = max(worst, abs(bx - sx), abs(by - sy))
ok(worst <= 1.0 / 0.35 + 0.01,
   "to_window and to_image round-trip within the integer-window quantisation",
   f"worst {worst:.2f} px at the coarsest zoom")
ok(True, "…and passed throughout the bug, which is why section 1 renders the view")

print(f"\n{PASS[0]} passed, {FAIL[0]} failed.")
sys.exit(1 if FAIL[0] else 0)
