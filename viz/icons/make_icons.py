"""Spirit Tracker's icon: a Glencairn glass with a dram of amber, on the app's dark --bg.

Drawn at 8x and downsampled, which is the whole anti-aliasing strategy: PIL's polygon
fills have hard edges and a Glencairn is all curves.

Run from this directory: `python3 make_icons.py`. Pillow is the only dependency.
"""
from PIL import Image, ImageDraw

S = 512
K = 8
W = S * K

BG        = (11, 13, 16)            # --bg
GLASS     = (231, 237, 243, 46)     # --text, faint: the body of the glass
RIM       = (231, 237, 243, 235)    # --text: the outline
ACCENT    = (125, 211, 252, 255)    # --accent
AMBER     = (214, 128, 38, 255)
AMBER_TOP = (240, 170, 70, 255)


def catmull_rom(pts, steps=24):
    out = []
    ext = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for s in range(steps):
            t = s / steps
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                .5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                      + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
                for k in (0, 1)))
    out.append(pts[-1])
    return out


def draw():
    img = Image.new('RGBA', (W, W), BG + (255,))
    layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx = W / 2
    top, bowl_bot, foot_bot = W * .15, W * .73, W * .85
    half = W * .25          # widest half-width of the bowl

    # Right-hand profile of the bowl as (half-width fraction, y). A Glencairn's mouth is
    # NARROWER than its belly; that tuck-in is what makes it read as one rather than a tumbler.
    profile = [(.58, 0), (.56, .16), (.66, .42), (.92, .70), (1.0, .82), (.86, .94), (.40, 1.0)]
    right = catmull_rom([(cx + half * f, top + (bowl_bot - top) * y) for f, y in profile])
    left = [(2 * cx - x, y) for x, y in reversed(right)]
    bowl = right + left

    # The heavy solid base: a short neck flaring into a wide flat foot.
    neck_w, foot_w = W * .09, W * .21
    foot = [(cx - neck_w, bowl_bot - W * .01), (cx + neck_w, bowl_bot - W * .01),
            (cx + neck_w * 1.15, foot_bot - W * .05), (cx + foot_w, foot_bot - W * .025),
            (cx + foot_w, foot_bot), (cx - foot_w, foot_bot),
            (cx - foot_w, foot_bot - W * .025), (cx - neck_w * 1.15, foot_bot - W * .05)]

    d.polygon(foot, fill=GLASS)
    d.polygon(bowl, fill=GLASS)

    # The dram: everything in the bowl below the fill line.
    fill_y = top + (bowl_bot - top) * .58
    liquid = [p for p in right if p[1] >= fill_y]
    liquid = [(liquid[0][0], fill_y)] + liquid + [(2 * cx - x, y) for x, y in reversed(liquid)] \
        + [(2 * cx - liquid[0][0], fill_y)]
    d.polygon(liquid, fill=AMBER)
    surf_w = liquid[0][0] - cx
    d.ellipse([cx - surf_w, fill_y - W * .022, cx + surf_w, fill_y + W * .022], fill=AMBER_TOP)

    lw = int(W * .016)
    d.line(bowl + [bowl[0]], fill=RIM, width=lw, joint='curve')
    d.line(foot + [foot[0]], fill=RIM, width=lw, joint='curve')
    rim_w = right[0][0] - cx
    d.ellipse([cx - rim_w, top - W * .018, cx + rim_w, top + W * .018], outline=RIM, width=lw)

    # A single highlight down the left of the bowl, in the app accent.
    streak = [(2 * cx - x + W * .045, y) for x, y in right if top + W * .1 <= y <= top + W * .42]
    d.line(streak, fill=ACCENT, width=int(W * .018), joint='curve')

    img.alpha_composite(layer)
    return img.convert('RGB').resize((S, S), Image.LANCZOS)


icon = draw()
icon.save('icon-512.png')
icon.resize((192, 192), Image.LANCZOS).save('icon-192.png')
icon.resize((180, 180), Image.LANCZOS).save('apple-touch-icon-180.png')
icon.resize((32, 32), Image.LANCZOS).save('favicon-32.png')
icon.save('../favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])

# Maskable needs the safe zone: Android crops to a circle inscribed in the middle 80%, so
# the glass is scaled into that and the rest is bled background.
inner = icon.resize((int(S * .78), int(S * .78)), Image.LANCZOS)
mask = Image.new('RGB', (S, S), BG)
mask.paste(inner, ((S - inner.width) // 2, (S - inner.height) // 2))
mask.save('icon-512-maskable.png')
print('written')
