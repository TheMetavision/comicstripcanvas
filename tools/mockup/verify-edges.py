"""Pink survivors near the canvas edge, measured on the real composite."""
import cv2, numpy as np, json, os, sys, importlib.util
HERE="tools/mockup"
sys.path.insert(0, HERE)
import scene_guard
spec=importlib.util.spec_from_file_location("r", os.path.join(HERE,"render.py"))
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
S=r"C:\Users\chris\Documents\Comic Strip Canvas\Mockup Scenes"
scenes=json.load(open(os.path.join(HERE,"scenes.json"),encoding="utf-8"))
scene_guard.require(S, scenes)
TARGET="#f9dd3c"
# A neutral artwork: nothing in it is pink, so every pink pixel found is scene.
art=np.full((1200,900,3), 128, np.uint8)
art[::40,:]=90; art[:,::40]=90
total=0
for name,info in scenes.items():
    em=cv2.imread(os.path.join(HERE,"edges",name+".png"), cv2.IMREAD_GRAYSCALE)
    im=cv2.imread(os.path.join(S,name+".png"))
    comp=im
    for q in info["quads"]:
        sh=r.load_shading(os.path.join(HERE,"shading"), f"{name}__{q['name']}")
        comp=r.warp_into(art, comp, q["corners"], sh)
    if em is None or not em.any():
        print(f"  {name:20s} no edge mask (poster)"); continue
    comp=r.recolour_edge(comp, em, TARGET)
    near=cv2.dilate(em, np.ones((13,13),np.uint8))
    hsv=cv2.cvtColor(comp, cv2.COLOR_BGR2HSV)
    # Two floors. A pixel at value 45 has a magenta cast but is black to look
    # at; "pink survived" means pink you can SEE.
    loose=cv2.inRange(hsv,(145,45,40),(180,255,255))
    visible=cv2.inRange(hsv,(145,60,80),(180,255,255))
    nl=int(cv2.bitwise_and(loose,near).sum()//255)
    surv=cv2.bitwise_and(visible, near)
    n=int(surv.sum()//255); total+=n
    print(f"  {name:20s} visible pink within 6px: {n:5d}   (any magenta cast incl. shadow: {nl})")
    if n:
        ys,xs=np.where(surv>0)
        print(f"        e.g. at {list(zip(xs[:4].tolist(),ys[:4].tolist()))}")
print(f"\n  TOTAL {total}")
sys.exit(0 if total==0 else 1)
