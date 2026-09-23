"""
The canvas's wrapped edge, as geometry instead of as a keyed blob of pixels.

Until now the edge was only ever a MASK: pixels of the scene that matched the
placeholder's pink, recoloured in place. That works until you ask it a question
a mask cannot answer.

    Where does the side meet the face?   Wherever the keying happened to stop,
                                         which is not where the face stops --
                                         hence a side panel whose bottom corner
                                         sits twelve pixels off the face's.

    Where does the side end?             Wherever the pink ran out. The rim of
                                         the canvas catches a specular highlight
                                         and goes white, the keying does not
                                         call white pink, and so a two or three
                                         pixel band of the original blank canvas
                                         survives outside the mask -- and then
                                         gets tinted by the recolour's outward
                                         falloff, which is the cyan halo.

So the side becomes a quadrilateral with two different provenances, on purpose:

    inner edge   the FACE's own final edge, the same two points after refine
                 and nudge. Not measured, not keyed -- taken. Two surfaces that
                 meet along an edge share that edge; anything else is two
                 independent guesses at one line, and they will differ.

    outer edge   measured from this scene: the mask's outer boundary, then
                 extended outward while the scene still looks like canvas
                 rather than wall, so the un-keyed specular rim is inside the
                 polygon rather than just outside it.
"""
import cv2
import numpy as np

SIDES = ("top", "right", "bottom", "left")

# How far out to look for the band at all.
MAX_DEPTH = 80
# ... but it has to START against the face. A wrapped edge begins where the
# front stops; a band of pink forty pixels out is the NEXT canvas along, and in
# the studio scenes there is always a next canvas along. Without this the
# 18mm's right side adopts the 38mm's left edge and reports a junction fifty
# pixels out, which is a true measurement of the wrong strip.
ADJACENT = 6
# Samples along a side when measuring its depth profile.
PROFILE_SAMPLES = 160
# A side counts as carrying an edge band when this many of its samples find one.
PRESENCE = 0.45
# How far past the keyed mask the rim may be chased, and how different from the
# wall a pixel must be to still count as canvas.
RIM_EXTEND = 8
RIM_DELTA = 26
# Wall reference is sampled from this far beyond the mask.
WALL_GAP = 10
WALL_SPAN = 8
# A little past the measured rim, so the polygon closes OVER it rather than on
# it: the outermost row of the rim is half canvas and half wall, and a boundary
# drawn exactly through it leaves the canvas half showing. Kept small because
# the cost of too far is tinting the wall.
OUTER_MARGIN = 1.5
# The furthest the mitre is ever allowed to run past a corner. Only a ceiling:
# the actual extent is measured off the mask by _mitre_extent.
MITRE_MAX = 14.0
# Empty steps tolerated while crossing a patchy mask past a corner.
MITRE_GAP = 2


def outward_normal(a, b):
    """Unit normal pointing out of the face, for corners in TL TR BR BL order."""
    d = np.asarray(b, float) - np.asarray(a, float)
    t = d / (np.linalg.norm(d) or 1.0)
    return np.array([t[1], -t[0]])


def _at(img, p):
    x, y = int(round(p[0])), int(round(p[1]))
    h, w = img.shape[:2]
    if x < 0 or y < 0 or x >= w or y >= h:
        return None
    return img[y, x]


def _profile(scene, mask, a, b):
    """
    Per-sample (inner, outer) offsets of the edge band along one side.

    Offsets are in pixels along the outward normal, measured from the face's
    own edge, so zero is the boundary the artwork stops at.
    """
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    n = outward_normal(a, b)
    ts, inner, outer = [], [], []

    for t in np.linspace(0.02, 0.98, PROFILE_SAMPLES):
        base = a + d * t
        hits = [o for o in range(-3, MAX_DEPTH)
                if (_at(mask, base + n * o) or 0) > 0]
        if not hits or hits[0] > ADJACENT:
            continue
        # The run touching the face, not some other canvas further out.
        lo = hits[0]
        hi = lo
        for o in hits:
            if o <= hi + 2:
                hi = o
            else:
                break
        ts.append(t)
        inner.append(float(lo))
        outer.append(float(_extend_rim(scene, base, n, hi)))

    return np.array(ts), np.array(inner), np.array(outer)


def _extend_rim(scene, base, n, hi):
    """
    How far the canvas really goes, past where the pink keying stopped.

    The wall is sampled a little beyond the mask and used as the reference; the
    rim is then followed outward for as long as the scene disagrees with the
    wall. On the studio scenes this recovers the two or three pixels of blown
    highlight along the top of the wrap, which the keying never saw because a
    specular white is not pink.
    """
    ref = []
    for o in range(hi + WALL_GAP, hi + WALL_GAP + WALL_SPAN):
        px = _at(scene, base + n * o)
        if px is not None:
            ref.append(px.astype(np.float32))
    if not ref:
        return hi
    wall = np.mean(ref, axis=0)

    out = hi
    for o in range(hi + 1, hi + 1 + RIM_EXTEND):
        px = _at(scene, base + n * o)
        if px is None:
            break
        if float(np.linalg.norm(px.astype(np.float32) - wall)) < RIM_DELTA:
            break
        out = o
    return out


def _robust_line(ts, vals):
    """
    A straight fit that a few wild samples cannot drag.

    The band is a straight strip on a flat canvas, so its depth varies linearly
    along the side. A plant in front of the canvas, or the label text under it,
    supplies confident nonsense at a handful of samples; this fits, throws out
    everything more than a pixel and a half from that fit, and fits again.
    """
    if len(ts) < 4:
        return (0.0, float(np.median(vals)) if len(vals) else 0.0)
    m, c = np.polyfit(ts, vals, 1)
    keep = np.abs(vals - (m * ts + c)) < 1.5
    if keep.sum() >= 4:
        m, c = np.polyfit(ts[keep], vals[keep], 1)
    return float(m), float(c)


def _mitre_extent(mask, corner, along, n, depth):
    """
    How far the wrap actually continues past this corner, in pixels.

    Measured, not inferred from the panel's depth. Inferring it was worse than
    the fault it fixed: the room canvas's edge is twenty pixels deep, so a
    depth-sized mitre threw a fourteen-pixel wedge of blue across the brick
    below the corner -- far more visible than the pixel and a half of junction
    error it was closing. What the wrap does at a corner depends on the angle
    the canvas is seen at, not on how deep its edge is, and the mask already
    knows.
    """
    corner = np.asarray(corner, float)
    out, gap = 0.0, 0
    for e in range(1, int(MITRE_MAX) + 1):
        base = corner + along * e
        if any((_at(mask, base + n * o) or 0) > 0
               for o in range(0, max(1, int(round(depth)) + 1))):
            out = float(e)
            gap = 0
        else:
            # The keyed mask thins out as the wrap turns away from the camera,
            # so it arrives in patches rather than stopping cleanly. Giving up
            # on the first empty step left the wrap's last few pixels to
            # nobody; a short tolerance crosses the gaps without ever running
            # on into open wall, because two clear steps end it.
            gap += 1
            if gap > MITRE_GAP:
                break
    return out


def measure(scene, mask, quad):
    """
    Which sides of this face carry an edge band, and how deep it is.

    @returns {side_index: {"outer": (slope, intercept), "presence": fraction}}
    """
    found = {}
    if mask is None or not mask.any():
        return found
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        ts, inner, outer = _profile(scene, mask, a, b)
        presence = len(ts) / float(PROFILE_SAMPLES)
        if presence < PRESENCE:
            continue
        line = _robust_line(ts, outer)
        a_pt, b_pt = np.asarray(a, float), np.asarray(b, float)
        d = b_pt - a_pt
        t = d / (np.linalg.norm(d) or 1.0)
        n = outward_normal(a_pt, b_pt)
        found[i] = {"outer": line,
                    "inner": _robust_line(ts, inner),
                    "presence": presence,
                    "mitre": (_mitre_extent(mask, a_pt, -t, n, line[1]),
                              _mitre_extent(mask, b_pt, t, n, line[0] + line[1]))}
    return found


def constructed_poly(quad, i, band):
    """
    The side panel: the face's own edge, and an outer edge measured here.

    Corner order is [inner a, inner b, outer b, outer a], so the first two
    points ARE the face's corners i and i+1 -- not copies of them rounded
    through a measurement, the same numbers. That is the whole point: a
    junction cannot be out by twelve pixels if there is only one set of
    numbers describing it.
    """
    a, b = np.asarray(quad[i], float), np.asarray(quad[(i + 1) % 4], float)
    n = outward_normal(a, b)
    d = b - a
    t = d / (np.linalg.norm(d) or 1.0)
    m, c = band["outer"]
    da = (m * 0.0 + c) + OUTER_MARGIN
    db = (m * 1.0 + c) + OUTER_MARGIN

    # The outer edge flares past the corners; the inner edge does not.
    #
    # A canvas is a box, and at a corner its silhouette turns outward: the far
    # corner of the wrap sits diagonally beyond the corner of the face, and the
    # little triangle between them belongs to the edge. Stopping the panel dead
    # on the face's corner leaves that triangle to nobody, and it is still the
    # photograph -- a handful of the placeholder's pink survived at the top
    # corner of every wrapped canvas once the recolour stopped flooding the
    # whole keyed mask.
    #
    # So each outer point is carried along the side by as much as the panel is
    # deep, which is the mitre a right-angled box makes. The inner points are
    # left exactly where they are, because they are the face's corners and the
    # junction is the one thing here that is not allowed to be approximate.
    ea, eb = band.get("mitre", (0.0, 0.0))
    return [list(a), list(b),
            list(b + n * db + t * eb),
            list(a + n * da - t * ea)]


def as_built_poly(quad, i, band):
    """
    The side as the OLD renderer drew it: both edges from the keyed mask.

    Kept so the junction check has something to measure on the current
    outputs. Its inner edge is wherever the keying stopped, which is the
    fault -- this function exists to fail.
    """
    a, b = np.asarray(quad[i], float), np.asarray(quad[(i + 1) % 4], float)
    n = outward_normal(a, b)
    mi, ci = band["inner"]
    mo, co = band["outer"]
    return [list(a + n * ci), list(b + n * (mi + ci)),
            list(b + n * (mo + co)), list(a + n * co)]


def polys(scene, mask, quad, as_built=False):
    """Every side panel for one face, as {side_index: 4 points}."""
    bands = measure(scene, mask, quad)
    make = as_built_poly if as_built else constructed_poly
    return {i: make(quad, i, band) for i, band in bands.items()}
