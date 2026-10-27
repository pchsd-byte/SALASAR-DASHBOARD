# Clouds out, goddess in. Two halves to this:
#   1. A protected core - a handful of ellipses and capsules over her crown, body, lap, the lotus,
#      the veena and the swan's neck. The flood may never enter it. Without this the flood walks
#      straight out of the clouds into her white silk, because they are the same smooth grey, and
#      eats holes in her lap and the lotus.
#   2. Outside that core, a region grow inwards from the border across pixels that are both flat
#      (clouds are smooth gradients; jewellery and petal edges are not) and close in colour to the
#      pixel it stepped from.
#
# Usage:  python docs/saraswati-cutout.py <source-artwork> client/public/saraswati.webp
#
# Run by hand, never by a build — the output is committed. Needs pillow and numpy.
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
DETAIL = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0   # how flat counts as flat
TOL = float(sys.argv[4]) if len(sys.argv) > 4 else 52.0      # how far colour may drift per step
WIDTH = 980                                                   # what ships
G = 384                                                       # the grid the flood runs on

full = Image.open(SRC).convert('RGB')
small = full.resize((G, G), Image.LANCZOS)
a = np.asarray(small).astype(np.float32)
ys, xs = np.mgrid[0:G, 0:G]
nx, ny = xs / (G - 1), ys / (G - 1)

def ellipse(cx, cy, rx, ry):
    return ((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2 <= 1.0

def capsule(x0, y0, x1, y1, r):
    px, py = nx - x0, ny - y0
    dx, dy = x1 - x0, y1 - y0
    t = np.clip((px * dx + py * dy) / (dx * dx + dy * dy), 0, 1)
    return (px - t * dx) ** 2 + (py - t * dy) ** 2 <= r * r

core = (
    ellipse(0.50, 0.17, 0.18, 0.18)          # crown and halo disc
    | ellipse(0.50, 0.57, 0.34, 0.31)        # torso, arms, lap
    | ellipse(0.50, 0.82, 0.47, 0.15)        # the lotus, nearly the full width
    | capsule(0.37, 0.60, 0.88, 0.31, 0.07)  # the veena across to her right
    | capsule(0.14, 0.36, 0.31, 0.63, 0.07)  # the swan's head and neck
)

blur = np.asarray(small.filter(ImageFilter.GaussianBlur(2.5))).astype(np.float32)
flat = np.abs(a - blur).mean(axis=2) < DETAIL
passable = flat & ~core

bg = np.zeros((G, G), bool)
q = deque()
for x in range(G):
    for y in (0, G - 1):
        if passable[y, x]: bg[y, x] = True; q.append((y, x))
for y in range(G):
    for x in (0, G - 1):
        if passable[y, x]: bg[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    c = a[y, x]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        j, i = y + dy, x + dx
        if 0 <= j < G and 0 <= i < G and not bg[j, i] and passable[j, i] and np.abs(a[j, i] - c).max() < TOL:
            bg[j, i] = True; q.append((j, i))

# The flood cannot cross a cloud's own hard edge, so wisps survive near the border and read as
# torn paper. Fade whatever is left as it approaches the frame; the core sits well inside this.
def ss(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
d = (np.abs((nx - .5) / .54) ** 3 + np.abs((ny - .5) / .53) ** 3) ** (1 / 3)
vignette = 1 - ss(0.80, 1.12, d)
vignette *= 1 - ss(0.93, 0.99, ny)            # and nothing below the lotus
alpha = np.maximum(core.astype(np.float32), (~bg).astype(np.float32) * vignette)
m = Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8), 'L')
m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))   # close pinholes
m = m.resize(full.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(4))
cut = full.convert('RGBA')
cut.putalpha(m)

# The flood cannot reach the cloud trapped between her veena, the swan and her shoulder, so a
# little mist stays. Grey mist on the popup's ivory frame looks like dirt; warmed, it reads as the
# cloud it is. Weighted by how desaturated a pixel is, so it lands on the mist and leaves her
# skin, the rose in her hand and the pink of the lotus alone.
arr = np.asarray(cut).astype(np.float32)
rgb = arr[:, :, :3]
grey = 1.0 - np.clip((rgb.max(axis=2) - rgb.min(axis=2)) / 42.0, 0, 1)
warm = np.array([1.030, 1.008, 0.962], dtype=np.float32)
arr[:, :, :3] = np.clip(rgb * (1 + (warm - 1) * grey[..., None]), 0, 255)

out = Image.fromarray(arr.astype(np.uint8), 'RGBA')
out = out.crop(out.getbbox())
w, h = out.size
out = out.resize((WIDTH, round(WIDTH * h / w)), Image.LANCZOS)
out.save(OUT, 'WEBP', quality=86, method=6)
print(f'detail<{DETAIL} tol<{TOL}  removed {bg.mean()*100:.1f}%  ->  {OUT} {out.size}')
