"""
Refuse to run when scenes.json was not built against the scenes on disk.

Corners are pixel coordinates in one particular photograph. Replace that
photograph with a different-sized one and every number in scenes.json is
silently meaningless -- not wrong in a way anything notices, just pointing at
the wrong part of a different picture.

That happened. The six scenes were regenerated at 3504x2336, the corners were
re-clicked and refined against them, and then the originals at 1536x1024 were
restored. Nothing complained. What the tools did instead was carry on: the edge
keying looked for pink where there was now a wall and produced masks of ZERO
pixels for two scenes, the face check sampled background and reported it as
clean, and the renders put artwork through quads that were off the canvas
entirely. Every one of those is a silent pass, which is the worst kind.

So each scene records the size of the image its corners were measured in, and
every tool checks that before it does anything. A stale scenes.json is now a
refusal naming the scene, which costs a re-click; a stale scenes.json that runs
costs a batch of wrong mockups that look plausible.
"""
import os
import sys

try:
    import cv2
except ImportError:  # pragma: no cover - callers report this themselves
    cv2 = None


def scene_size(scenes_dir, name):
    """(width, height) of the scene on disk, or None if it cannot be read."""
    img = cv2.imread(os.path.join(scenes_dir, name + ".png"))
    if img is None:
        return None
    return img.shape[1], img.shape[0]


def check(scenes_dir, scenes):
    """
    Every scene whose recorded size disagrees with the file on disk.

    A scene with no recorded size is reported separately: it predates this
    check and cannot be verified, which is a different thing from being wrong.
    """
    bad, unknown = [], []
    for name, info in scenes.items():
        got = scene_size(scenes_dir, name)
        if got is None:
            bad.append((name, info.get("size"), None))
            continue
        want = info.get("size")
        if want is None:
            unknown.append(name)
        elif list(want) != list(got):
            bad.append((name, list(want), list(got)))
    return bad, unknown


def require(scenes_dir, scenes, log=print, allow_unknown=True):
    """Check, complain, and stop the process if the sizes disagree."""
    bad, unknown = check(scenes_dir, scenes)
    for name in unknown:
        log(f"  note: {name} has no recorded size — cannot verify it matches the scene")
    if not bad:
        return True

    log("")
    log("  STOPPING: scenes.json does not match the scenes on disk.")
    for name, want, got in bad:
        if got is None:
            log(f"    {name}: cannot read the scene file")
        else:
            log(f"    {name}: corners were measured in {want[0]}x{want[1]}, "
                f"the file on disk is {got[0]}x{got[1]}")
    log("")
    log("  The corners are pixel coordinates in a particular image. Against a")
    log("  different-sized one they point at the wrong place, and every tool")
    log("  downstream will produce something that looks finished and is not.")
    log("")
    log("  Either restore the scenes these corners were clicked against, or")
    log("  re-click them with pick-corners.py against the scenes you have.")
    sys.exit(2)
