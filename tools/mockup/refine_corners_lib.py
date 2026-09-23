"""
The edge-finding helpers from refine-corners.py, under an importable name.

`refine-corners.py` has a hyphen in it and so cannot be imported. Rather than
copy `gradient` and `sample` into fit-mesh.py -- two files disagreeing about
what an edge is, is exactly how the mesh and the corners drifted apart -- both
tools load them from here.
"""
import importlib.util
import os

_spec = importlib.util.spec_from_file_location(
    "_refine_corners",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "refine-corners.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

gradient = _mod.gradient
sample = _mod.sample
side_offset = _mod.side_offset
