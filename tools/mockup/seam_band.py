"""
What is in the band either side of a face boundary, per side.

Shared by diagnose-seams.py, verify-faces.py and verify-edges.py so that the
three cannot disagree about what a seam is. They ask different questions --
"what is wrong", "is any placeholder left", "is any pink left" -- but all three
have to measure the same band in the same place, and when they did not, each
was right about a different picture.

-- what counts as a defect ------------------------------------------------

Five things can be at a boundary. Four are faults and one is the point:

    pink          the scene's own edge strip, not covered and not recoloured
    placeholder   the scene's printed face, showing past the artwork
    black         near-black the RENDER put there over a brighter scene. This
                  is not a thing the photograph contains; it is the warp's
                  border showing through mask that reaches past the quad.
    background    wall or table INSIDE the face: the artwork stopped short
    covered       artwork, recoloured edge, or scene left alone outside the
                  face -- all fine

-- why a run, not a threshold at the boundary -----------------------------

An earlier version of this walked outward from offset zero and stopped at the
first offset that was mostly clean. That found nothing on any side, on scenes
that visibly had a black rim, because offset zero is the boundary itself: half
artwork, half whatever is outside it, never a majority of anything. The rim
started at +1 and was never reached.

So a side is scored by the longest CONTIGUOUS RUN of defect anywhere in the
band, and the run is reported with where it starts. A rim one pixel out from
the boundary is exactly the case this has to catch, because that is the case a
human sees and a tool anchored at zero does not.
"""
import cv2
import numpy as np

SIDES = ("top", "right", "bottom", "left")

IN_MAX = 6
OUT_MAX = 12
SAMPLES = 240
# Skip the ends: near a corner the neighbouring side's own band is in the
# window, and a corner is not a side.
END_SKIP = 0.10

UNCHANGED = 14.0          # a pixel the render did not move
CONTENT_SAT = 60          # saturation at which scene content is not wall
PINK_HUE = (140, 178)     # OpenCV hue band for the placeholder magenta
PINK_SAT = 60
BLACK_V = 45              # rendered value that reads as a black rim
BLACK_DROP = 60           # ... and only when the scene there was this much brighter
MAJORITY = 0.5
# How close, in Lab, an outside pixel must sit to a colour actually present in
# the placeholder before it is called placeholder rather than scenery.
SIG_TOLERANCE = 12.0
SIG_SAMPLES = 600
# ... and it must look MORE like the placeholder than like the surroundings, by
# this margin in Lab. See why in content_signature.
SIG_MARGIN = 6.0
# Where the surroundings are sampled from: a ring starting this far outside the
# quad, far enough out to be past any rim being measured.
BG_INNER = 22
BG_OUTER = 46


def outward_normal(a, b):
    """Unit normal pointing out of the face, for corners in TL TR BR BL order."""
    d = np.array(b, float) - np.array(a, float)
    t = d / (np.linalg.norm(d) or 1.0)
    return np.array([t[1], -t[0]])


def content_signature(scene, quad, inset=12):
    """
    The colours the placeholder actually uses, from well inside the face.

    Returns (placeholder colours, surrounding colours) -- both are needed,
    because either on its own gets this wrong.

    "Saturated and unchanged" is not enough once you are OUTSIDE the boundary:
    a brick wall is saturated orange and a studio table is saturated wood, and
    scoring those as uncovered placeholder produced ten-pixel faults on every
    bottom edge in the set, all of them the scenery the canvas stands on.

    Matching against the placeholder's own colours is not enough either, and
    this is the subtler trap. The placeholder is a busy illustration containing
    browns and tans, so a wooden table IS within twelve Lab units of something
    in it -- and in deep shadow, where Lab's a/b spread compresses, almost
    anything is within twelve of almost anything. That produced a confident
    seven-pixel "placeholder rim" on a bottom edge where the artwork visibly
    meets the table with nothing between.

    So a pixel has to look more like the placeholder than like the
    surroundings, with both sampled from this scene: close to the inside of
    THIS face, and clearly not the ring of wall and table around it.
    """
    m = np.zeros(scene.shape[:2], np.uint8)
    cv2.fillConvexPoly(m, np.array(quad, np.int32), 255)
    inner = cv2.erode(m, np.ones((2 * inset + 1,) * 2, np.uint8))
    ring = cv2.bitwise_and(cv2.dilate(m, np.ones((2 * BG_OUTER + 1,) * 2, np.uint8)),
                           cv2.bitwise_not(cv2.dilate(m, np.ones((2 * BG_INNER + 1,) * 2, np.uint8))))
    return (_sample(scene, inner), _sample(scene, ring))


def _sample(scene, mask):
    px = scene[mask > 0]
    if not len(px):
        return None
    if len(px) > SIG_SAMPLES:
        px = px[np.linspace(0, len(px) - 1, SIG_SAMPLES).astype(int)]
    return cv2.cvtColor(px.reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)


def _matches(sig, bgr):
    """Closer to the placeholder than to the surroundings, and close in absolute terms."""
    if sig is None:
        return False
    fg, bg = sig
    if fg is None:
        return False
    lab = cv2.cvtColor(bgr.reshape(1, 1, 3), cv2.COLOR_BGR2LAB).reshape(3).astype(np.float32)
    d_fg = float(np.min(np.linalg.norm(fg - lab, axis=1)))
    if d_fg >= SIG_TOLERANCE:
        return False
    if bg is None:
        return True
    d_bg = float(np.min(np.linalg.norm(bg - lab, axis=1)))
    return d_fg + SIG_MARGIN < d_bg


def classify_pixel(orig, rend, sig=None):
    """One of: pink, placeholder, black, background, covered."""
    o = orig.astype(float)
    r = rend.astype(float)
    ohsv = cv2.cvtColor(orig.reshape(1, 1, 3), cv2.COLOR_BGR2HSV)[0, 0]
    rhsv = cv2.cvtColor(rend.reshape(1, 1, 3), cv2.COLOR_BGR2HSV)[0, 0]

    # Black the render introduced. Checked before "covered", because painting
    # black over the scene IS a change and would otherwise pass as success.
    if int(rhsv[2]) <= BLACK_V and int(ohsv[2]) - int(rhsv[2]) >= BLACK_DROP:
        return "black"

    if float(np.linalg.norm(o - r)) >= UNCHANGED:
        return "covered"
    if PINK_HUE[0] <= int(ohsv[0]) <= PINK_HUE[1] and int(ohsv[1]) >= PINK_SAT:
        return "pink"
    if int(ohsv[1]) >= CONTENT_SAT and _matches(sig, orig):
        return "placeholder"
    return "background"


def walk_side(scene, composed, a, b, in_max=IN_MAX, out_max=OUT_MAX, sig=None):
    """Tallies per offset, from in_max inside the boundary to out_max outside."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    n = outward_normal(a, b)
    h, w = scene.shape[:2]

    rows = {}
    for off in range(-in_max, out_max + 1):
        tally = {"pink": 0, "placeholder": 0, "black": 0, "background": 0, "covered": 0}
        for s in np.linspace(END_SKIP, 1 - END_SKIP, SAMPLES):
            p = a + d * s + n * off
            x, y = int(round(p[0])), int(round(p[1]))
            if x < 0 or y < 0 or x >= w or y >= h:
                continue
            tally[classify_pixel(scene[y, x], composed[y, x], sig)] += 1
        rows[off] = tally
    return rows


def _fault_at(tally, offset):
    """
    The dominant fault at one offset, or None.

    Inside the boundary, background is a fault: the artwork was supposed to
    reach here. Outside it, background is the wall and entirely correct.
    """
    total = sum(tally.values()) or 1
    # Outside the face, "background" is the wall and entirely correct; inside
    # it, the artwork was supposed to reach here and did not.
    kinds = ["pink", "placeholder", "black"]
    if offset < 0:
        kinds.append("background")
    worst, count = None, 0
    for k in kinds:
        if tally[k] > count:
            worst, count = k, tally[k]
    return (worst, count / total) if count / total >= MAJORITY else (None, 0.0)




def _attached(rows, start):
    """Is everything between the boundary and `start` covered by the render?"""
    if start <= 0:
        return True
    for off in range(0, start):
        t = rows.get(off)
        if not t:
            return False
        total = sum(t.values()) or 1
        if t["covered"] / total < MAJORITY:
            return False
    return True


def score_side(rows):
    """
    The longest contiguous run of fault that TOUCHES the boundary.

    Contiguity is what makes a seam a seam, but contiguous with the ARTWORK,
    not with offset zero. Requiring a run to start at +1 looked right and was
    wrong: the renderer covers a pixel or two past the quad itself, so a real
    rim begins just beyond the coverage, not just beyond the boundary. On
    room-landscape's bottom edge that rule hid six pixels of placeholder
    because the two pixels in front of it were artwork -- it reported clean on
    the very fault a nudge exists to fix.

    So a run counts when everything between the boundary and it is COVERED. If
    any offset in between is wall, the run is detached from the canvas and is
    the scenery behind it: brick at +5, with clear wall at +1 to +4, cannot be
    a rim on a canvas whatever colour it is.

    @returns (kind, start_offset, depth) -- depth 0 when the side is clean.
    """
    best = (None, 0, 0)
    run_kind, run_start, run_len = None, 0, 0
    for off in sorted(rows):
        kind, _frac = _fault_at(rows[off], off)
        if kind is not None and (run_kind is None or kind == run_kind):
            if run_kind is None:
                run_kind, run_start, run_len = kind, off, 0
            run_len += 1
            if run_len > best[2] and _attached(rows, run_start):
                best = (run_kind, run_start, run_len)
        elif kind is not None:
            run_kind, run_start, run_len = kind, off, 1
            if run_len > best[2] and _attached(rows, run_start):
                best = (run_kind, run_start, run_len)
        else:
            run_kind, run_len = None, 0
    return best


def describe(kind, start, depth):
    """A sentence a person can act on."""
    if not depth:
        return "clean"
    what = {
        "pink": "original pink edge",
        "placeholder": "placeholder artwork",
        "black": "BLACK rim painted by the render",
        "background": "gap - artwork stopped short",
    }[kind]
    where = f"from {start:+d}" if start else "from the boundary"
    return f"{depth:2d} px of {what} ({where})"
