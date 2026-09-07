#!/usr/bin/env python3
"""
Template ingest — turn any blank panel template into a manifest the builder
and the compositor can both read.

    python ingest.py blank-template.png ./templates/comic-strip-12 --dpi 300

Emits:
    panels.json        bounding boxes, aspect ratios, coverage
    panel-paths.json   SVG path per panel (for the browser builder)
    masks/panel-NN.png RGBA silhouettes (for the Sharp compositor)
    overlay.png        line art with panels + surround punched transparent
    panel-map.png      numbered reference render

Assumptions: panels are closed shapes drawn in dark ink on a light ground,
separated by gutters, with a single surround region outside the page frame.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage
import cv2

ap = argparse.ArgumentParser()
ap.add_argument('source')
ap.add_argument('outdir')
ap.add_argument('--dpi', type=int, default=300)
ap.add_argument('--bleed', type=float, default=0.25, help='inches per edge')
ap.add_argument('--threshold', type=int, default=128)
ap.add_argument('--dilate', type=int, default=4, help='px of art tucked under the ink')
ap.add_argument('--simplify', type=float, default=2.0, help='path simplification, px')
ap.add_argument('--min-area', type=float, default=0.004, help='fraction of canvas')
ap.add_argument('--band', type=int, default=0, help='row-banding height; 0 = auto')
args = ap.parse_args()

os.makedirs(os.path.join(args.outdir, 'masks'), exist_ok=True)
grey = np.array(Image.open(args.source).convert('L'))
H, W = grey.shape

lab, n = ndimage.label(grey > args.threshold)
sizes = ndimage.sum(grey > args.threshold, lab, range(1, n + 1))
boxes = ndimage.find_objects(lab)

regions = []
for i in range(1, n + 1):
    sl = boxes[i - 1]
    y, x = sl[0].start, sl[1].start
    h, w = sl[0].stop - y, sl[1].stop - x
    if sizes[i - 1] < args.min_area * W * H:
        continue
    regions.append(dict(id=i, area=float(sizes[i - 1]), x=int(x), y=int(y),
                        w=int(w), h=int(h), fill=float(sizes[i - 1] / (w * h))))

surround = lab[0, 0]                                    # region touching the corner
rest = [r for r in regions if r['id'] != surround]
if not rest:
    sys.exit('No panels found — try adjusting --threshold or --min-area.')
web = min(rest, key=lambda r: r['fill'])['id']          # gutter web: lowest fill ratio
panels = [r for r in rest if r['id'] != web]
print(f'{len(panels)} panels detected in {W}x{H}')

for r in panels:                                        # centroid for reading order
    ys, xs = np.where(lab[r['y']:r['y']+r['h'], r['x']:r['x']+r['w']] == r['id'])
    r['cy'], r['cx'] = r['y'] + ys.mean(), r['x'] + xs.mean()
band = args.band or max(1, int(np.median([r['h'] for r in panels]) * 0.8))
panels.sort(key=lambda r: (round(r['cy'] / band), r['cx']))

k = 2 * args.dilate + 1
struct = np.ones((k, k), bool)
manifest, paths = [], []

for idx, r in enumerate(panels, start=1):
    shape = ndimage.binary_dilation(lab == r['id'], structure=struct)
    ys, xs = np.where(shape)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    crop = shape[y0:y1, x0:x1]
    name = f'panel-{idx:02d}'

    a = (crop * 255).astype(np.uint8)
    Image.fromarray(np.dstack([np.full_like(a, 255)] * 3 + [a])).save(
        os.path.join(args.outdir, 'masks', name + '.png'))

    cs, _ = cv2.findContours(crop.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = cv2.approxPolyDP(max(cs, key=cv2.contourArea), args.simplify, True).reshape(-1, 2)
    d = 'M' + 'L'.join(f'{int(px)+x0},{int(py)+y0}' for px, py in c) + 'Z'

    w, h = x1 - x0, y1 - y0
    entry = dict(id=name, x=x0, y=y0, width=w, height=h,
                 aspect=round(w / h, 3), coverage=round(float(crop.mean()), 3))
    manifest.append({**entry, 'mask': f'masks/{name}.png'})
    paths.append({**entry, 'd': d})

# overlay: ink and gutters stay opaque, panels and surround punch through
rgb = np.array(Image.open(args.source).convert('RGB'))
alpha = np.full((H, W), 255, np.uint8)
alpha[lab == surround] = 0
for r in panels:
    alpha[ndimage.binary_dilation(lab == r['id'], structure=struct)] = 0
rgb[alpha == 0] = 255
Image.fromarray(np.dstack([rgb, alpha])).save(os.path.join(args.outdir, 'overlay.png'))

# page frame, for builders that redraw the template from vectors alone
ink = np.where(grey < args.threshold)
frame = dict(x=int(ink[1].min()), y=int(ink[0].min()),
             width=int(ink[1].max() - ink[1].min()),
             height=int(ink[0].max() - ink[0].min()))

canvas = dict(width=W, height=H, dpi=args.dpi, bleed_in=args.bleed,
              trim_in=[round(W / args.dpi - 2 * args.bleed, 3),
                       round(H / args.dpi - 2 * args.bleed, 3)],
              frame=frame)

json.dump(dict(canvas=canvas, panels=manifest),
          open(os.path.join(args.outdir, 'panels.json'), 'w'), indent=2)
json.dump(dict(canvas=canvas, panels=paths),
          open(os.path.join(args.outdir, 'panel-paths.json'), 'w'), indent=1)

# numbered reference render
prev = Image.new('RGB', (W, H), (226, 167, 214))
cols = [(255,214,214),(214,235,255),(222,247,214),(255,240,201),(235,220,255),(206,241,238)]
for i, p in enumerate(manifest):
    m = Image.open(os.path.join(args.outdir, p['mask'])).split()[-1]
    prev.paste(Image.new('RGB', (p['width'], p['height']), cols[i % len(cols)]), (p['x'], p['y']), m)
ov = Image.open(os.path.join(args.outdir, 'overlay.png'))
prev = Image.alpha_composite(prev.convert('RGBA'), ov)
d = ImageDraw.Draw(prev)
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', max(40, H // 33))
except OSError:
    font = ImageFont.load_default()
for p in manifest:
    d.text((p['x'] + p['width'] // 2, p['y'] + p['height'] // 2), p['id'][-2:],
           fill=(40, 40, 40), font=font, anchor='mm')
prev.convert('RGB').resize((W // 5, H // 5), Image.LANCZOS).save(
    os.path.join(args.outdir, 'panel-map.png'))

for p in manifest:
    print(f"  {p['id']}  {p['width']:>5}x{p['height']:<5} aspect {p['aspect']:>5}  "
          f"inside shape {p['coverage']*100:.0f}%")
print(f"\ntrim {canvas['trim_in'][0]} x {canvas['trim_in'][1]} in  ->  {args.outdir}")
