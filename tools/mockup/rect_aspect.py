"""
The true width:height of a rectangle seen in perspective.

A quad's proportions in the image are the rectangle's proportions only when the
rectangle is square to the camera. Tilt it and the near edge grows, the far edge
shrinks, and the shape you measure is mostly the angle. Every canvas in these
scenes is at an angle and both posters lie on a table, so measuring the image
quad was measuring perspective and calling it shape.

── The method ─────────────────────────────────────────────────────────────

Zhang's, for a single rectangle, with the two assumptions that let one work at
all from four points:

    square pixels, no skew
    the principal point at the centre of the image

Both hold well enough for a photograph out of a normal camera, and neither can
be recovered from one rectangle anyway.

The two pairs of opposite edges meet at two vanishing points. Those directions
are perpendicular in the world, so for a camera with focal length f their
back-projected rays must be orthogonal, which gives

    (v1 - p) . (v2 - p) + f^2 = 0

and hence f directly. With f the camera matrix K is known, and the rectangle's
aspect falls out of the homography that maps a unit square onto the quad: the
first two columns of K^-1 H are the world x and y axes scaled by the
rectangle's own width and height, so their lengths are in that ratio.

── When it cannot answer ──────────────────────────────────────────────────

If the rectangle is nearly fronto-parallel the vanishing points run off towards
infinity, the dot product above approaches zero from the wrong side, and f^2
comes out negative. That case is easy: there is no perspective to invert, and
the caller is told so.

The dangerous case is the one just short of it, where f^2 is positive and the
answer is arithmetic performed on noise. Measured on these scenes with one
pixel of jitter on each corner, the two posters -- flat on a table, plenty of
perspective -- hold to within a couple of percent. The wall-mounted room canvas
swings between 0.53 and 1.64 and fails outright a third of the time, and the
studio landscape pair fail 190 and 200 times out of 200. A single rectangle
simply does not carry enough information when it is nearly square to the camera.

So the estimate is not offered on its own. estimate() jitters the corners,
re-solves, and reports the spread, and a caller that is about to make a
decision should refuse an estimate whose spread is wide -- see UNSTABLE_SPREAD.
An unstable answer here is not a slightly worse number, it is a different one
every time you ask.
"""
import numpy as np

# Fraction of the estimate that the 5-95% jitter spread may occupy before the
# answer is treated as noise. Ten percent is generous -- the usable faces come
# in under five, the unusable ones at forty and up -- so this separates the two
# populations rather than splitting a continuum.
UNSTABLE_SPREAD = 0.10
JITTER_TRIALS = 48
JITTER_PX = 1.0


def _cross(a, b):
    return np.cross(np.asarray(a, float), np.asarray(b, float))


def _vanishing(p1, p2, p3, p4):
    """Where line p1p2 meets line p3p4, in homogeneous coordinates."""
    l1 = _cross([p1[0], p1[1], 1.0], [p2[0], p2[1], 1.0])
    l2 = _cross([p3[0], p3[1], 1.0], [p4[0], p4[1], 1.0])
    return _cross(l1, l2)


def true_aspect(corners, image_size):
    """
    Estimated real width:height of the rectangle, and the focal length used.

    @param corners     four image points, TL TR BR BL
    @param image_size  (width, height) of the photograph the points came from
    @returns (aspect, focal, note) -- focal and note are None and "" when the
             perspective is too slight to invert, and aspect is then the plain
             image-space ratio.
    """
    c = [np.asarray(p, float) for p in corners]
    w, h = image_size
    u0, v0 = w / 2.0, h / 2.0

    # Vanishing points of the two edge directions.
    v1 = _vanishing(c[0], c[1], c[3], c[2])     # the "horizontal" pair
    v2 = _vanishing(c[0], c[3], c[1], c[2])     # the "vertical" pair

    img_aspect = _image_aspect(c)

    # Nearly parallel edges put the vanishing point at infinity, where the
    # homogeneous w vanishes and the inhomogeneous coordinates blow up.
    if abs(v1[2]) < 1e-9 or abs(v2[2]) < 1e-9:
        return img_aspect, None, "edges parallel in the image: no perspective to invert"

    v1 = v1[:2] / v1[2]
    v2 = v2[:2] / v2[2]

    f2 = -((v1[0] - u0) * (v2[0] - u0) + (v1[1] - v0) * (v2[1] - v0))
    if f2 <= 0:
        return img_aspect, None, "f^2 <= 0: too near fronto-parallel to solve"
    f = float(np.sqrt(f2))

    k_inv = np.array([[1 / f, 0, -u0 / f],
                      [0, 1 / f, -v0 / f],
                      [0, 0, 1.0]])

    # Homography taking the unit square to the quad. Built here rather than with
    # cv2 so this module needs only numpy and can be tested on its own.
    h_mat = _homography_from_unit_square(c)
    h1 = k_inv @ h_mat[:, 0]
    h2 = k_inv @ h_mat[:, 1]
    n1, n2 = np.linalg.norm(h1), np.linalg.norm(h2)
    if n2 < 1e-12:
        return img_aspect, f, "degenerate homography"
    return float(n1 / n2), f, ""


def _image_aspect(c):
    """The quad's proportions as drawn, averaging opposite edges."""
    w = (np.linalg.norm(c[1] - c[0]) + np.linalg.norm(c[2] - c[3])) / 2
    h = (np.linalg.norm(c[3] - c[0]) + np.linalg.norm(c[2] - c[1])) / 2
    return float(w / h) if h else 0.0


def _homography_from_unit_square(c):
    """H with H @ (x, y, 1) mapping (0,0),(1,0),(1,1),(0,1) onto the quad."""
    src = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    a = []
    b = []
    for (x, y), p in zip(src, c):
        a.append([x, y, 1, 0, 0, 0, -x * p[0], -y * p[0]])
        b.append(p[0])
        a.append([0, 0, 0, x, y, 1, -x * p[1], -y * p[1]])
        b.append(p[1])
    sol = np.linalg.solve(np.array(a, float), np.array(b, float))
    return np.append(sol, 1.0).reshape(3, 3)


def estimate(corners, image_size, trials=JITTER_TRIALS, jitter=JITTER_PX, seed=11):
    """
    The true aspect, with an honest account of whether it can be trusted.

    @returns dict with
        image      the quad's proportions as drawn
        aspect     the estimate, or None when it cannot be made or trusted
        focal      the focal length it implies, in pixels
        spread     5-95% range of the estimate under one pixel of corner jitter,
                   as a fraction of the estimate
        note       why there is no usable answer, when there is not
    """
    c = np.array(corners, float)
    img = _image_aspect([np.array(p, float) for p in c])
    nominal, focal, note = true_aspect(c, image_size)
    if note:
        return {"image": img, "aspect": None, "focal": None, "spread": None, "note": note}

    rng = np.random.default_rng(seed)
    vals, fails = [], 0
    for _ in range(trials):
        a, _f, n = true_aspect(c + rng.normal(0, jitter, c.shape), image_size)
        if n:
            fails += 1
        else:
            vals.append(a)

    if fails > trials * 0.25:
        return {"image": img, "aspect": None, "focal": focal, "spread": None,
                "note": f"unstable: {fails} of {trials} jittered solves found no solution"}
    lo, hi = np.percentile(vals, [5, 95])
    spread = float((hi - lo) / nominal) if nominal else None
    if spread is not None and spread > UNSTABLE_SPREAD:
        return {"image": img, "aspect": None, "focal": focal, "spread": spread,
                "note": f"unstable: 1px of corner jitter moves it by {spread * 100:.0f}%"}
    return {"image": img, "aspect": float(nominal), "focal": float(focal),
            "spread": spread, "note": ""}
