"""
A sloping edge must move across the pixel grid smoothly, not in whole steps.

An edge at a slight angle crosses a pixel row a fraction of a pixel further
along each time. If the renderer computes real coverage, the measured position
of that boundary walks smoothly -- the 50% point lands at x.13, x.37, x.61, and
so on. If it fills a binary polygon and blurs it, the boundary can only sit in
whole pixels: the same little ramp, repeated, jumping a pixel when the edge has
finally moved far enough. That is what a staircase IS, and it is what Alan is
looking at along the gallery canvas's bottom edge -- an identical 14, 57, 127,
184 ramp in column after column.

-- the measurement ---------------------------------------------------------

The alpha is recovered by compositing twice with two flat artworks and taking
the difference, so the scene cancels and what remains is coverage (see
verify_common.alpha_probe). Along each edge, at many stations, the 50% point of
that ramp is found by linear interpolation. Those points should lie on a
straight line, because the edge is straight.

The test is the RESIDUAL about that line. A renderer with true coverage leaves
residuals of a few hundredths of a pixel. A staircase leaves a sawtooth: the
measured point is pinned to the grid while the true edge slides away from it
and then jumps back, which for a uniformly distributed offset has a standard
deviation of 1/sqrt(12) = 0.289 px. The two populations are nowhere near each
other, so the threshold sits between them and is not a judgement call.

Only edges that actually slope are tested. An edge running exactly along a
pixel row has no sub-pixel motion to measure and would pass or fail at random,
so it is reported as untestable rather than counted either way.
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verify_common as V  # noqa: E402
import sides as SD  # noqa: E402

STATIONS = 90
# Across the edge, in output pixels, either way.
REACH = 6
# The edge must traverse at least this much of the grid over its length for the
# sub-pixel question to mean anything.
MIN_TRAVERSE = 1.5
# Residual standard deviation, in pixels, and it is set from the two
# populations rather than from taste:
#
#   an ideal coverage ramp, measured by this same code    0.070
#   the real renders once compositing at output size      0.067 - 0.128
#   an ideal binary fill blurred 3x3                      0.289  ( = 1/sqrt(12) )
#   the real renders before that change                   0.298 - 0.707
#
# The floor is 0.070 rather than zero because the 50% point of a ramp only one
# pixel wide is estimated by interpolating two samples, and that estimate has a
# small bias that depends on the sub-pixel phase. So this sits above everything
# a correct renderer produces and below everything a staircase produces, with
# about half again of margin on each side.
MAX_RESIDUAL = 0.20


def measure_edge(alpha, a, b):
    """
    Residual std of the 50% crossing about a straight fit, in pixels.

    Measured along an IMAGE AXIS, not perpendicular to the edge. That is the
    whole point and it is easy to get backwards: sampled perpendicular to
    itself, a straight edge crosses at the same offset at every station by
    construction, so there is no sub-pixel motion to test and the only thing
    that ever moves is the error you were trying to measure. Walked along the
    grid instead, a sloping edge must advance by its slope -- a fraction of a
    pixel per column -- and a renderer that can only place boundaries on whole
    pixels cannot follow it.

    So: for a mostly-horizontal edge, step across the columns and find the row
    where coverage passes half; for a mostly-vertical one, step down the rows.
    """
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    horizontal = abs(d[0]) >= abs(d[1])

    us, pos = [], []
    for t in np.linspace(0.12, 0.88, STATIONS):
        base = a + d * t
        # Sample real pixels, and report the boundary in those same real
        # pixels. Sampling on the grid but reporting against a fractional
        # nominal origin adds a half-pixel sawtooth of pure bookkeeping, which
        # is indistinguishable from the staircase being looked for -- it scored
        # true coverage at 0.288 and a blurred binary fill at 0.000, exactly
        # backwards, until the two were made the same coordinates.
        fixed = int(round(base[0] if horizontal else base[1]))
        start = int(round(base[1] if horizontal else base[0])) - REACH
        prof = []
        for j in range(2 * REACH + 1):
            v = start + j
            xi, yi = (fixed, v) if horizontal else (v, fixed)
            if 0 <= xi < alpha.shape[1] and 0 <= yi < alpha.shape[0]:
                prof.append(float(alpha[yi, xi]))
            else:
                prof.append(0.0)
        prof = np.array(prof)

        # Orient the profile so it runs from outside the face to inside it.
        if float(np.median(prof[:3])) > float(np.median(prof[-3:])):
            prof = prof[::-1]
            flipped = True
        else:
            flipped = False
        inside = float(np.median(prof[-3:]))
        if inside < 20:
            continue
        c = V.crossing(list(prof), inside * 0.5)
        if c is None:
            continue
        if flipped:
            c = (2 * REACH) - c
        us.append(float(fixed))
        pos.append(float(start) + c)

    if len(us) < STATIONS // 3:
        return None, 0.0, len(us)

    us, pos = np.array(us), np.array(pos)
    traverse = float(pos.max() - pos.min())
    m, c0 = np.polyfit(us, pos, 1)
    resid = pos - (m * us + c0)
    return float(np.std(resid)), traverse, len(us)


def main():
    scenes = V.load_scenes()
    bad, untestable, tested, worst = [], 0, 0, 0.0

    for name, info in scenes.items():
        scene, edge = V.scene_and_edge(name)
        k = V.plate_scale(scene)
        alpha = V.alpha_probe(name, info, scene, edge)

        for q in info["quads"]:
            if q.get("mesh"):
                continue
            quad = V.scaled(V.R.quad_of(q), k)
            for i in range(4):
                std, traverse, n = measure_edge(alpha, quad[i], quad[(i + 1) % 4])
                if std is None or traverse < MIN_TRAVERSE:
                    untestable += 1
                    continue
                tested += 1
                worst = max(worst, std)
                flag = ""
                if std > MAX_RESIDUAL:
                    bad.append((name, q["name"], SD.SIDES[i], std, traverse))
                    flag = "   <-- whole-pixel steps"
                print(f"  {name:18s} {q['name']:22s} {SD.SIDES[i]:6s} "
                      f"residual {std:5.3f} px over {traverse:4.1f} px of traverse{flag}")

    print("")
    print(f"  {len(bad)} of {tested} testable edges step in whole pixels "
          f"(threshold {MAX_RESIDUAL}; this method floors at 0.070 on ideal coverage "
          f"and reads 0.289 on a blurred binary fill); "
          f"worst {worst:.3f}")
    print(f"  {untestable} edge(s) too flat or too obscured to test")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
