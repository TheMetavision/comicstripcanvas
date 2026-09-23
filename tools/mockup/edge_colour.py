"""
Which colour the canvas edge should be, for a given piece of artwork.

The site guidelines say the wrapped edge takes "a colour prominent in the
design". Prominent, not dominant -- and the difference is the whole problem.
Most of these products are a figure on a dark background, so the dominant
colour is very nearly black every time. An edge printed in the dominant colour
would be black on a Walter White, black on a Mad Max, black on a Bruce Lee, and
the guideline would be satisfied while the shelf looked like a row of coffins.

So: cluster the artwork, then score the clusters by how much of the picture
they are AND how much colour they have, with near-black and near-white pushed
down hard. What wins is the most colour-carrying thing big enough to notice --
Walter White's yellow hazmat, not the dark lab behind it.

Population is taken to a fractional power on purpose. Linear, and a large dull
region beats a smaller vivid one; ignored, and a hundred stray pixels of pure
cyan win. The square root sits between those and behaves on this catalogue.
"""
import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover - the caller reports this properly
    cv2 = None

# Clusters to look for. Enough to separate a figure from its background and
# its highlights; few enough that each one still means something.
K = 8
# Long side the artwork is reduced to before clustering. The answer is a broad
# colour, so the detail is only cost.
SAMPLE_LONG_SIDE = 320
# Below this value a colour is "near black". Legitimate in artwork, useless on
# an edge.
DARK_V = 0.20
# Bright enough to be a candidate for "near white" -- but only alongside
# NEAR_WHITE_S below, never on its own. See _is_near_white.
LIGHT_V = 0.94
NEAR_WHITE_S = 0.25
# How little saturation counts as grey.
MIN_S = 0.18
# How much the size of a cluster counts, against how colourful it is.
POP_POWER = 0.5


def _is_near_white(s, v):
    """Bright AND washed out.

    Brightness alone is not whiteness, and treating it as such threw away the
    right answer: Bruce Lee's yellow is 20% of that artwork at saturation 0.76
    and value 0.97, and a plain v > 0.94 test binned it as near-white and
    handed the edge a muddy teal instead. A colour is only useless on an edge
    when it is bright and has no colour left in it.
    """
    return v > LIGHT_V and s < NEAR_WHITE_S


def _score(fraction, s, v):
    """How good an edge this colour would make."""
    if v < DARK_V or _is_near_white(s, v) or s < MIN_S:
        # Not refused outright -- a genuinely monochrome design has to return
        # something -- but pushed far below anything with colour in it.
        return (fraction ** POP_POWER) * 0.02
    # Saturation squared: the guideline wants the edge to read as a colour from
    # the design at a glance, and a washed-out one does not.
    return (fraction ** POP_POWER) * (s ** 2) * min(1.0, v / 0.6)


def prominent_colour(bgr, k=K, detail=False):
    """
    The colour an edge should take, as '#rrggbb'.

    @param bgr  the artwork, as OpenCV reads it
    """
    small = bgr
    h, w = bgr.shape[:2]
    scale = SAMPLE_LONG_SIDE / max(w, h)
    if scale < 1:
        small = cv2.resize(bgr, (max(1, round(w * scale)), max(1, round(h * scale))),
                           interpolation=cv2.INTER_AREA)
    data = small.reshape(-1, 3).astype(np.float32)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centres = cv2.kmeans(data, k, None, criteria, 4, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    total = len(labels)

    rows = []
    for i, c in enumerate(centres):
        frac = float((labels == i).sum()) / total
        b, g, r = [float(x) for x in c]
        hsv = cv2.cvtColor(np.uint8([[[b, g, r]]]), cv2.COLOR_BGR2HSV)[0][0]
        s, v = hsv[1] / 255.0, hsv[2] / 255.0
        rows.append({
            "hex": "#%02x%02x%02x" % (int(round(r)), int(round(g)), int(round(b))),
            "fraction": frac, "s": float(s), "v": float(v),
            "score": _score(frac, float(s), float(v)),
        })
    rows.sort(key=lambda t: -t["score"])
    return (rows[0]["hex"], rows) if detail else rows[0]["hex"]


def hex_to_bgr(hx):
    hx = hx.lstrip("#")
    r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
    return (b, g, r)
