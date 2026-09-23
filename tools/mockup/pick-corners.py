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

CORNERS MAY BE OUTSIDE THE PHOTOGRAPH. The display is padded with grey all the
way round, so a canvas that runs off the frame -- poster-portrait falls off the
bottom -- still has somewhere to click for the corners that are not on the
image. What gets stored is the scene's own coordinate, negative or past its
width and height as needed, and the status bar says how many of the current
quad's corners are off-frame so it reads as a decision rather than a slip.

Nothing downstream needs to care: a perspective transform is defined by its
four points wherever they fall, and only ever samples the artwork inside the
quad. Guessing an off-frame corner instead would throw out the whole
perspective, which is the thing this avoids.

Controls
    left click      drop a corner (inside the photograph or out in the grey)
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_guard  # noqa: E402

# ── the mesh, for things that are not flat ─────────────────────────────────
#
# Four corners define a plane, and a poster lying on a table is not one: it
# lifts at the corners and bows along the edges. Forcing that through a
# perspective transform straightens it, which runs the artwork off the curl on
# one side and leaves the scene's own placeholder showing on the other.
#
# Twelve points instead -- each corner, then two more a third and two thirds
# along the edge leaving it -- and render.py bends the artwork through a
# thin-plate spline. THE ORDER IS THE CONTRACT with mesh_source_points() over
# there; clicked in any other order the poster comes out as a bow tie.
MESH_LABELS = []
for _a, _b in (("top-left", "top-right"), ("top-right", "bottom-right"),
               ("bottom-right", "bottom-left"), ("bottom-left", "top-left")):
    MESH_LABELS += [_a, f"1/3 of the way to {_b}", f"2/3 of the way to {_b}"]
# Which corners of the twelve are the corners.
MESH_CORNER_INDICES = (0, 3, 6, 9)


# ── the canvas edges ───────────────────────────────────────────────────────
#
# The wrapped side of the canvas, which in these scenes is the placeholder
# design's hot pink. On a real product it is a colour taken from that product's
# own artwork, so the mockup has to recolour it -- and to recolour it, it has to
# be found.
#
# Colour alone does not find it. The edge sits at hue ~170, saturation 163-218;
# the placeholder ARTWORK's pink sits at hue ~168-172, saturation 196-209. They
# overlap almost exactly, which is why an earlier attempt keyed the lettering
# and the neon as readily as the edge.
#
# What separates them is FLATNESS. The edge is one solid colour with nothing
# printed on it; the artwork is a picture. Measured over a 7x7 window, pink on
# the edge has a local standard deviation of 1.0-3.4, and pink in the artwork
# 16.6-28.7 -- an order of magnitude, and stable across every scene.
#
# Two guards on top of that, because flat pink can occur inside a picture too
# (this placeholder has a flat pink sky and flat pink letter fills):
#
#   NEAR   the strip has to hug a quad, so flat pink elsewhere in the room is
#          not a canvas edge
#   NOT DEEP INSIDE  anything well within the face is artwork by definition
#
# A poster has no wrapped edge at all, so its mask is empty by construction
# rather than by whatever the keying happens to find on a curled paper corner.

EDGE_PINK_LO = (150, 80, 50)
EDGE_PINK_HI = (178, 255, 255)
# Local standard deviation below this is "solid colour, nothing printed on it".
EDGE_FLAT_MAX = 8.0
# How far either side of a quad boundary an edge strip may live.
EDGE_BAND = 95
# How far inside the clicked quad the edge mask may reach. The quad IS the face
# boundary -- someone put those corners on it, at zoom, looking at it -- so
# anything beyond a pixel or two inside is face, whatever colour it happens to
# be.
#
# Zero, now that refine-corners has put the boundary where the photograph says
# it is. It was 2 while the corners were clicked values that might be a pixel or
# two out, and before that 18, which is invisible on a portrait canvas and a
# band on a landscape one. Portrait canvases show their wrapped edge at the SIDES, where 18px of
# over-reach is lost against a 600px-tall face; landscape canvases show it top
# and bottom, where the same 18px is a visible stripe across a 430px one. The
# mask claimed those stripes, the face mask lost them, the artwork never covered
# them, and the edge recolour painted them carrying the placeholder's own
# luminance -- which is what the bands across the Mad Max landscapes were.
EDGE_INSIDE_MARGIN = 0
# Strips smaller than this are speckle.
EDGE_MIN_AREA = 400
# Dilations outward, to cover the antialiased outer rows. See the note below.
EDGE_GROW = 3
# A looser pink, used only to claim pixels that already touch the mask. Wider
# than the keying range because a blended pixel has lost saturation to whatever
# it is blending with.
EDGE_CLAIM_LO = (145, 45, 40)
EDGE_CLAIM_HI = (180, 255, 255)
# How far the claim may creep. Enough for a blend band, not enough to cross a
# gap into something else pink.
EDGE_CLAIM_STEPS = 10
# Width of the ring just outside the face that may be claimed as edge.
EDGE_RIM = 13


def edge_mask(img, quads, is_poster):
    """The solid-colour canvas edge, as an 8-bit mask. Empty for a poster."""
    h, w = img.shape[:2]
    if is_poster:
        return np.zeros((h, w), np.uint8)

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    pink = cv2.inRange(hsv, EDGE_PINK_LO, EDGE_PINK_HI)

    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mu = cv2.boxFilter(grey, -1, (7, 7))
    sd = np.sqrt(np.maximum(cv2.boxFilter(grey * grey, -1, (7, 7)) - mu * mu, 0))
    flat = (sd < EDGE_FLAT_MAX).astype(np.uint8) * 255

    near = np.zeros((h, w), np.uint8)
    deep = np.zeros((h, w), np.uint8)
    for q in quads:
        pts = np.array(q.get("cornersRefined") or q["corners"], np.int32)
        cv2.polylines(near, [pts], True, 255, EDGE_BAND)
        cv2.fillConvexPoly(deep, pts, 255)
    deep = cv2.erode(deep, np.ones((EDGE_INSIDE_MARGIN * 2 + 1,) * 2, np.uint8))

    m = cv2.bitwise_and(cv2.bitwise_and(pink, flat), near)
    m = cv2.bitwise_and(m, cv2.bitwise_not(deep))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    seeds = np.zeros_like(m)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in cnts:
        if cv2.contourArea(c) >= EDGE_MIN_AREA:
            cv2.drawContours(seeds, [c], -1, 255, -1)
    if not seeds.any():
        return seeds

    # The band and the depth guard are there to decide WHETHER something is an
    # edge, and they are good at that. They are bad at saying how much of it
    # there is: both clip the ends of a strip, so recolouring the seed alone
    # left a canvas yellow down the middle and pink at top and bottom.
    #
    # So the seed only has to touch the strip. Everything flat-and-pink joined
    # to it comes too, whatever the guards said about the far end -- a strip is
    # one connected surface, and the test for belonging to it is belonging to it.
    candidate = cv2.bitwise_and(pink, flat)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, labels = cv2.connectedComponents(candidate)
    keep = np.unique(labels[seeds > 0])
    out = np.isin(labels, keep[keep > 0]).astype(np.uint8) * 255
    # Anything deep inside a face is still artwork, even if it touches a strip
    # through a one-pixel bridge.
    out = cv2.bitwise_and(out, cv2.bitwise_not(deep))
    out = cv2.morphologyEx(out, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    # ── reaching the last few pixels ──────────────────────────────────────
    #
    # The outermost rows of the strip are antialiased against whatever is
    # behind them, so they are neither flat nor purely pink and the key stops
    # short. One dilation was not enough: 1-3px of pink survived down both
    # studio canvases, which is the one artefact on the whole picture that the
    # eye goes straight to.
    #
    # Two passes, in this order:
    #
    #   grow    a fixed dilation, which covers the fully-blended rows
    #   claim   then ANY pink-hued pixel touching the mask, flatness ignored.
    #           Flatness was only ever there to tell a solid edge from a
    #           picture; a pixel already touching known edge does not need that
    #           test, and it is exactly the test the blended rows fail.
    #
    # The claim is iterated so it creeps along the whole blend rather than one
    # row of it, and bounded so it cannot walk off into a pink sky.
    out = cv2.dilate(out, np.ones((3, 3), np.uint8), iterations=EDGE_GROW)

    # Seed from the face boundary as well as from the flat-pink strips. A
    # canvas has edges on more than one side and they need not be connected in
    # the picture: the thin top edge of the studio canvases touches no side
    # strip, so a claim that could only creep outward from the sides never
    # reached it and left pink along the top. Pink immediately outside the face
    # is canvas edge by construction, whatever it is or is not joined to.
    rim = np.zeros((h, w), np.uint8)
    for q in quads:
        cv2.polylines(rim, [np.array(q["corners"], np.int32)], True, 255, EDGE_RIM)
    rim = cv2.bitwise_and(rim, cv2.bitwise_not(deep))

    hue_only = cv2.inRange(hsv, EDGE_CLAIM_LO, EDGE_CLAIM_HI)
    # Close single-pixel gaps first. At the top corners of the studio canvases
    # the blend band is broken by a pixel or two of something else, and an
    # unbridged claim stopped there and left 14 pink pixels behind -- few, but
    # at the corner of a canvas, which is where a mockup is looked at.
    hue_only = cv2.morphologyEx(hue_only, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    hue_only = cv2.bitwise_and(hue_only, cv2.bitwise_not(deep))
    out = cv2.bitwise_or(out, cv2.bitwise_and(rim, hue_only))
    for _ in range(EDGE_CLAIM_STEPS):
        grown = cv2.dilate(out, np.ones((3, 3), np.uint8))
        claimed = cv2.bitwise_and(grown, hue_only)
        merged = cv2.bitwise_or(out, claimed)
        if np.array_equal(merged, out):
            break
        out = merged

    # Last word, after every growth and claim above. The dilations and the creep
    # each run after their own deep-exclusion, so without this a pixel could be
    # added back inside the quad by a later step than the one that excluded it.
    return cv2.bitwise_and(out, cv2.bitwise_not(deep))


def write_edge_masks(scenes_dir, scenes, out_dir, log=print):
    """One mask per scene, beside the quads. Both studio depths are included:
    the 18mm and the 38mm strips are simply two more regions in the same mask,
    which is what keeps a single recolour pass correct for both."""
    os.makedirs(out_dir, exist_ok=True)
    written = {}
    for name, info in scenes.items():
        img = cv2.imread(os.path.join(scenes_dir, name + ".png"))
        if img is None:
            log(f"  {name}: cannot read the scene")
            continue
        m = edge_mask(img, info["quads"], name.startswith("poster"))
        path = os.path.join(out_dir, name + ".png")
        cv2.imwrite(path, m)
        px = int(m.sum() // 255)
        written[name] = px
        log(f"  {name:20s} edge mask {px:6d} px"
            + ("  (poster — no wrapped edge)" if name.startswith("poster") else ""))
    return written


# ── the padded canvas ──────────────────────────────────────────────────────
#
# How much empty room to put around the scene, as a fraction of its size.
#
# A canvas is not always wholly inside the photograph. poster-portrait runs off
# the bottom of the frame, so two of its corners are simply not on the image --
# and a corner you cannot click is a corner you have to guess, which puts the
# whole perspective out. Padding the DISPLAY gives somewhere to click; the
# coordinates stored stay in the scene's own frame and go negative, or past its
# width and height, exactly as they should.
#
# warpPerspective is perfectly happy with that: the transform is defined by the
# four points wherever they fall, and it only ever samples the artwork inside
# the quad. Nothing downstream needs to know the corner was off-frame.
PAD_FRACTION = 0.25
# The dead area around the scene. Mid grey rather than black, so the edge of the
# photograph is obvious against it and a corner clicked in the void is clearly
# in the void.
PAD_COLOUR = (60, 60, 60)


class Picker:
    """One scene's worth of clicking, with zoom and pan."""

    def __init__(self, img, scene, quad_names, n_points=4):
        self.scene = scene
        self.quad_names = quad_names
        self.n_points = n_points
        self.labels = MESH_LABELS if n_points == 12 else CORNER_LABELS
        self.ih, self.iw = img.shape[:2]           # the scene's own size
        self.pad_x = int(round(self.iw * PAD_FRACTION))
        self.pad_y = int(round(self.ih * PAD_FRACTION))
        self.img = cv2.copyMakeBorder(
            img, self.pad_y, self.pad_y, self.pad_x, self.pad_x,
            cv2.BORDER_CONSTANT, value=PAD_COLOUR)
        self.h, self.w = self.img.shape[:2]        # the padded size
        self.quads = []
        self.pts = []
        self.zoom = 1.0
        self.ox, self.oy = 0.0, 0.0
        self.panning = False
        self.pan_from = None
        self.fitted = False

    def fit(self, win_w, win_h):
        """Start with the whole padded canvas in view, once."""
        self.zoom = min(win_w / self.w, win_h / self.h)
        self.ox = (self.w - win_w / self.zoom) / 2
        self.oy = (self.h - win_h / self.zoom) / 2
        self.fitted = True

    # ---- coordinate mapping between the window and the SCENE ----
    # Everything outside these two methods -- stored corners, what goes into
    # scenes.json, what render.py reads -- is in the scene's frame. The padding
    # exists only between here and the screen.
    def to_image(self, x, y):
        return (self.ox + x / self.zoom - self.pad_x,
                self.oy + y / self.zoom - self.pad_y)

    def to_window(self, x, y):
        return (int((x + self.pad_x - self.ox) * self.zoom),
                int((y + self.pad_y - self.oy) * self.zoom))

    def clamp(self, win_w, win_h):
        """Keep the canvas somewhere in view, without pinning it.

        The old version clamped the offset into [0, canvas - visible], which
        with a visible region larger than the canvas collapsed to exactly 0 --
        forcing the very alignment that the crop-and-stretch then got wrong.
        Now it only stops the canvas being dragged entirely off screen, and
        panning into the surrounding grey is allowed, because that grey is
        where the off-frame corners are."""
        vis_w, vis_h = win_w / self.zoom, win_h / self.zoom
        self.ox = max(-vis_w * 0.9, min(self.ox, self.w - vis_w * 0.1))
        self.oy = max(-vis_h * 0.9, min(self.oy, self.h - vis_h * 0.1))

    def on_mouse(self, event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN:
            if len(self.pts) < self.n_points:
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
        if not self.fitted:
            self.fit(win_w, win_h)
        self.clamp(win_w, win_h)

        # One affine, exactly the one to_window describes.
        #
        # This used to crop the array and resize the crop to fill the window.
        # Numpy clips a slice at the array bounds without saying so, so whenever
        # the visible region ran past the canvas -- which padding makes the
        # NORMAL case at fit zoom -- a narrower crop was stretched to the full
        # window width. The view was then horizontally scaled by win_w/actual_w
        # while to_image went on dividing by self.zoom, and every click landed
        # wrong by the ratio between them.
        #
        # It is a quiet failure: the picture looks right, the corners look like
        # they are on the canvas, and the error only appears much later as
        # artwork that does not fit its frame. Eight quads were clicked through
        # it. The factor depended on the window's aspect -- 0.96 at 1400x900,
        # 0.90 at 1600x964, 0.78 at 1920x1000 -- so it was invisible to anyone
        # who did not happen to resize.
        #
        # warpAffine samples wherever it is asked and fills the rest with the
        # border colour, so there is no clipping and nothing to stretch: the
        # view IS to_window applied to the canvas, and to_image is its exact
        # inverse for any window shape, zoom or pan.
        m = np.float32([[self.zoom, 0, -self.ox * self.zoom],
                        [0, self.zoom, -self.oy * self.zoom]])
        view = cv2.warpAffine(self.img, m, (win_w, win_h), flags=cv2.INTER_NEAREST,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=PAD_COLOUR)

        # Where the photograph actually ends. Without this the padding reads as
        # more scene, and a corner placed just outside the frame looks like a
        # corner placed just inside it.
        tl = self.to_window(0, 0)
        br = self.to_window(self.iw - 1, self.ih - 1)
        cv2.rectangle(view, tl, br, (110, 110, 110), 1, cv2.LINE_AA)

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
        mark(self.pts, (60, 200, 255), len(self.pts) == self.n_points)

        nth = len(self.quads)
        name = self.quad_names[nth] if nth < len(self.quad_names) else "-"
        nxt = self.labels[len(self.pts)] if len(self.pts) < self.n_points else "press n to accept"
        off = sum(1 for px, py in self.pts
                  if px < 0 or py < 0 or px > self.iw - 1 or py > self.ih - 1)
        bar = (f"{self.scene}  quad {nth + 1}/{len(self.quad_names)} ({name})  next: {nxt}"
               f"  zoom {self.zoom:.1f}x" + (f"  [{off} corner(s) off-frame]" if off else ""))
        cv2.rectangle(view, (0, 0), (win_w, 26), (0, 0, 0), -1)
        cv2.putText(view, bar, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(view, "click corners TL TR BR BL | u undo | r restart | n next | s save | q quit",
                    (8, win_h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1, cv2.LINE_AA)
        return view


def pick_scene(path, scene, quad_names, n_points=4):
    img = cv2.imread(path)
    if img is None:
        print(f"  cannot read {path}")
        return None
    p = Picker(img, scene, quad_names, n_points)
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
            if len(p.pts) != p.n_points:
                print(f"  {p.n_points} points first")
                continue
            pts = [[round(a, 1), round(b, 1)] for a, b in p.pts]
            entry = {"name": quad_names[len(p.quads)]}
            if p.n_points == 12:
                # The quad stays, taken from the four corners among the twelve:
                # the edge mask and the silhouette are both built from it, and
                # neither wants the curl.
                entry["corners"] = [pts[i] for i in MESH_CORNER_INDICES]
                entry["mesh"] = pts
            else:
                entry["corners"] = pts
            p.quads.append(entry)
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
    ap.add_argument("--mesh", action="store_true",
                    help="12 points instead of 4 on the poster scenes, for the curl")
    ap.add_argument("--edges-only", action="store_true",
                    help="skip the clicking and just rebuild the edge masks from the saved quads")
    args = ap.parse_args()

    existing = {}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            existing = json.load(f)
        print(f"  loaded {len(existing)} scene(s) from {args.out}")

    if args.edges_only:
        if not existing:
            sys.exit('No quads yet — pick corners before keying edges.')
        scene_guard.require(args.scenes, existing)
        write_edge_masks(args.scenes, existing, os.path.join(os.path.dirname(args.out), 'edges'))
        return

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
