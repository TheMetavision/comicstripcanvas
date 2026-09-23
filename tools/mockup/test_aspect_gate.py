"""
The shape gate that decides whether an icon may be put into a poster scene.

Run: python tools/mockup/test_aspect_gate.py

Tested here rather than by running the catalogue past it, because the catalogue
cannot test it: every one of the 244 comic icons is exactly 2000x1333 or
1333x2000, so the measured spread is 0.02% to 0.03% and nothing comes close to
the limit. A gate that never fires on the data available is a gate nobody has
checked, and the first icon that needs it will arrive on a day when nobody is
looking at this file.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("_render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def main():
    # The catalogue's own shapes, which must always be let through.
    for w, h, o in ((1333, 2000, "portrait"), (2000, 1333, "landscape")):
        fits, why = R.aspect_fits(w, h, o)
        check(f"catalogue {w}x{h} {o} is accepted", fits, why)

    # A square badge: 50% off portrait, 33% off landscape, refused either way.
    for o in ("portrait", "landscape"):
        fits, why = R.aspect_fits(1500, 1500, o)
        check(f"a square icon is refused as {o}", not fits, why)

    # Just inside and just outside the limit, on both orientations and on both
    # sides of the reference. 0.86x is fourteen percent BELOW and so is inside
    # the limit -- getting that backwards is what this pair is here to catch,
    # and it caught it.
    for o, ref in R.SHIP_REFERENCE_ASPECT.items():
        for factor, want_ok in ((1.14, True), (1.16, False), (0.86, True), (0.84, False)):
            h = 2000
            w = ref * factor * h
            fits, _why = R.aspect_fits(int(round(w)), h, o)
            check(f"{o} at {factor:.2f}x the reference is {'accepted' if want_ok else 'refused'}",
                  fits == want_ok, f"aspect {w / h:.3f}:1")

    fits, why = R.aspect_fits(0, 100, "portrait")
    check("artwork with no width is refused rather than dividing by zero", not fits, why)

    # The gate must not be silently disabled by a wide tolerance.
    check("the tolerance is still 15%", abs(R.SHIP_ASPECT_TOLERANCE - 0.15) < 1e-9,
          f"is {R.SHIP_ASPECT_TOLERANCE}")

    print("")
    print(f"  {'FAILED: ' + ', '.join(FAILS) if FAILS else 'all aspect-gate checks passed'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
