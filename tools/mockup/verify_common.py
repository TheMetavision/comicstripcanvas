"""
Shared rig for the geometry verifiers: one plate, one composite, one probe.

Every one of these checks needs the same two pictures -- the scene as it was,
and the scene as the renderer left it, both at the resolution the render is
finally written at. Getting those two out of step is how a verifier ends up
reporting on a picture nobody ships, so they are made here and only here.
"""
import importlib.util
import json
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
EDGE_HEX = "#f9dd3c"

_spec = importlib.util.spec_from_file_location("_render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

import scene_guard  # noqa: E402
import sides as SD  # noqa: E402


def load_scenes():
    data = json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))
    scene_guard.require(SCENES, data)
    return data


def scene_and_edge(name):
    scene = cv2.imread(os.path.join(SCENES, name + ".png"))
    edge = cv2.imread(os.path.join(HERE, "edges", name + ".png"), cv2.IMREAD_GRAYSCALE)
    return scene, edge


def flat_art(info, value):
    """A featureless stand-in. Flat, so nothing in it can be mistaken for a seam."""
    w, h = (1500, 1000) if info["orientation"] == "landscape" else (1000, 1500)
    return np.full((h, w, 3), value, np.uint8)


def composite(name, info, scene, edge, art):
    """The render, through render.py's own function, at output resolution."""
    return R.compose_scene(scene, info, name, edge, art, os.path.join(HERE, "shading"), EDGE_HEX)


def plate(scene):
    """The untouched scene, brought to the same resolution the render is written at."""
    return R.fit_long_side(scene, R.OUT_LONG_SIDE)


def plate_scale(scene):
    return R.fit_long_side(scene, R.OUT_LONG_SIDE).shape[1] / float(scene.shape[1])


def scaled(points, k):
    return [[p[0] * k, p[1] * k] for p in points]


def side_polys(scene, edge, quad):
    """
    The side panels, asking the renderer first.

    render.py grows a `side_polys` once the sides are real geometry. Until it
    does, the panels are reconstructed from the keyed mask the way the old
    compositor effectively drew them -- which is the state these checks exist
    to fail on. Which one was used is printed, so a pass can never be mistaken
    for the wrong question having been asked.
    """
    fn = getattr(R, "side_polys", None)
    if fn is not None:
        return fn(scene, edge, quad), "render.py geometry"
    return SD.polys(scene, edge, quad, as_built=True), "reconstructed from the keyed mask"


def face_poly(quad, panels):
    """
    What the face actually covers: the quad, plus the overlap on bare sides.

    The renderer deliberately paints a couple of pixels past the quad on any
    side with no wrap to hide behind, so the quad alone is not the coverage and
    a check that assumed it was would flag the renderer's own remedy.
    """
    out = []
    quad = [np.asarray(p, float) for p in quad]
    lines = []
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        grow = 0.0 if i in panels else float(R.FAR_SIDE_OVERLAP_PX)
        n = SD.outward_normal(a, b)
        lines.append((a + n * grow, b + n * grow))
    for i in range(4):
        prev, cur = lines[(i - 1) % 4], lines[i]
        p = R._intersect(prev[0], prev[1], cur[0], cur[1])
        out.append(list(p) if p else list(quad[i]))
    return out


def coverage_mask(polys, shape):
    """
    Every pixel any polygon touches at all, however slightly.

    Through render.py's own coverage(), so the verifier and the compositor
    cannot disagree about where a shape is -- and thresholded at "more than
    nothing" rather than at a half, because a pixel the renderer wrote with
    alpha 0.05 is a pixel the renderer wrote, and the band has to start beyond
    it or the check marks the renderer's own antialiasing as a leak.
    """
    acc = np.zeros(shape[:2], np.float32)
    for p in polys:
        acc = np.maximum(acc, R.coverage(p, shape))
    return (acc > 0).astype(np.uint8) * 255


def alpha_probe(name, info, scene, edge, lo=40, hi=210):
    """
    The rendered alpha, recovered without caring what the scene looks like.

    Composite the same geometry twice with two flat artworks. Every pixel is
    scene*(1-a) + warped*a, so the DIFFERENCE between the two composites is
    a * (warped_hi - warped_lo): the scene cancels exactly, and what is left is
    the coverage times a smooth shading term. Normalised against its own value
    well inside the face, that difference is the alpha ramp -- which is the
    thing an antialiasing check has to look at, and the thing you cannot see
    directly in a finished render because the artwork is in the way.
    """
    a_lo = composite(name, info, scene, edge, flat_art(info, lo))
    a_hi = composite(name, info, scene, edge, flat_art(info, hi))
    d = cv2.cvtColor(a_hi, cv2.COLOR_BGR2GRAY).astype(np.float32) \
        - cv2.cvtColor(a_lo, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return d


def crossing(profile, level):
    """
    Where a monotone profile passes `level`, to sub-pixel, or None.

    Linear interpolation between the two samples that straddle it. That is the
    whole measurement: if the renderer produces true coverage this lands
    anywhere between two pixels, and if it produces whole-pixel steps it lands
    in the same place over and over.
    """
    for i in range(len(profile) - 1):
        a, b = profile[i], profile[i + 1]
        if (a - level) * (b - level) <= 0 and a != b:
            return i + (level - a) / (b - a)
    return None
