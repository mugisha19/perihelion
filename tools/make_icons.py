"""Generate the PWA icon set into site/icons/.

Usage: python tools/make_icons.py [variant]

Variants (all share the game's orbit scene and keep their artwork inside the central 80% circle,
so each works as a regular icon, a maskable icon that Android crops to a circle/squircle, and an
iOS home-screen icon that iOS rounds itself):

  classic   the original orbit scene with the sun, no lettering
  sun-l     the sun itself is a bold "L" (Liad)
  monogram  a big glowing "L" with the ship orbiting it
  wordmark  small orbit scene above the name "LIAD"
"""
import math
import pathlib
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "icons"
FONT = "C:/Windows/Fonts/seguibl.ttf"  # Segoe UI Black
DEFAULT_VARIANT = "classic"
SS = 4  # supersampling factor for smooth edges

BG_EDGE = (4, 5, 13)
BG_CENTER = (20, 22, 52)
CYAN = (95, 243, 255)
GOLD = (255, 201, 60)
SUN_HOT = (255, 246, 220)
SUN_MID = (255, 179, 71)
SUN_EDGE = (255, 106, 61)
INK = (74, 28, 8)


def radial(size, inner, outer, power=1.0):
    """Square image fading from `inner` at the centre to `outer` at the corners."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    c = (size - 1) / 2
    far = math.hypot(c, c)
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - c, y - c) / far) ** power
            px[x, y] = tuple(round(inner[i] + (outer[i] - inner[i]) * t) for i in range(3))
    return img


def glow(canvas, center, radius, color, strength, blur):
    """Additive soft glow: a filled disc, blurred, screened over the canvas."""
    layer = Image.new("L", canvas.size, 0)
    cx, cy = center
    ImageDraw.Draw(layer).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=round(255 * strength))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    tint = Image.new("RGB", canvas.size, color)
    lit = ImageChops.multiply(tint, Image.merge("RGB", (layer, layer, layer)))
    return ImageChops.screen(canvas, lit)


def glow_mask(canvas, mask, color, strength, blur):
    """Like glow(), but the shape is an arbitrary L-mode mask (used for lettering)."""
    soft = mask.point(lambda v: round(v * strength)).filter(ImageFilter.GaussianBlur(blur))
    tint = Image.new("RGB", canvas.size, color)
    lit = ImageChops.multiply(tint, Image.merge("RGB", (soft, soft, soft)))
    return ImageChops.screen(canvas, lit)


def ship_points(cx, cy, heading, k):
    """The in-game ship polygon, rotated to `heading` and scaled by k."""
    local = [(20, 0), (-12, -12), (-6, 0), (-12, 12)]
    ca, sa = math.cos(heading), math.sin(heading)
    return [(cx + (x * ca - y * sa) * k, cy + (x * sa + y * ca) * k) for x, y in local]


# ---------- scene building blocks (all in supersampled pixel coordinates) ----------

def backdrop(s):
    img = radial(s, BG_CENTER, BG_EDGE, power=0.9)
    img = glow(img, (s * 0.22, s * 0.2), s * 0.22, (90, 50, 170), 0.22, s * 0.12)
    return glow(img, (s * 0.82, s * 0.84), s * 0.24, (20, 100, 170), 0.2, s * 0.12)


def rings(img, s, center, radii_alphas):
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    w = max(2, round(s * 0.008))
    cx, cy = center
    for r, alpha in radii_alphas:
        rd.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(150, 165, 255, alpha), width=w)
    img.paste(ring, (0, 0), ring)


def sun(img, s, center, radius, glow_scale=1.0):
    cx, cy = center
    img = glow(img, center, radius * 1.8 * glow_scale, SUN_MID, 0.9, radius * 0.8)
    img = glow(img, center, radius * 1.15, SUN_HOT, 0.7, radius * 0.4)
    disc = radial(round(radius * 2), SUN_HOT, SUN_EDGE, power=0.8)
    mask = Image.new("L", disc.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, disc.size[0] - 1, disc.size[1] - 1), fill=255)
    img.paste(disc, (round(cx - radius), round(cy - radius)), mask)
    return img


def orb(img, s, center, r_orb, glow_r):
    ox, oy = center
    img = glow(img, center, glow_r, GOLD, 0.9, glow_r * 0.6)
    d = ImageDraw.Draw(img)
    d.ellipse((ox - r_orb, oy - r_orb, ox + r_orb, oy + r_orb), fill=(255, 224, 138))
    d.ellipse((ox - r_orb * 0.55, oy - r_orb * 0.6, ox - r_orb * 0.05, oy - r_orb * 0.1), fill=(255, 251, 230))
    return img


def ship(img, s, center, angle_deg, radius, k):
    a = math.radians(angle_deg)
    sx, sy = center[0] + math.cos(a) * radius, center[1] + math.sin(a) * radius
    img = glow(img, (sx, sy), k * 17, CYAN, 0.8, k * 9.5)
    pts = ship_points(sx, sy, a + math.pi / 2, k)
    ImageDraw.Draw(img).polygon(pts, fill=(234, 252, 255), outline=CYAN, width=max(2, round(k * 1.4)))
    return img


def text_mask(size, text, font_px, tracking=0.0):
    """L-mode mask of `text` plus its tight bounding box, drawn glyph by glyph so tracking is exact."""
    font = ImageFont.truetype(FONT, font_px)
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    x = 0.0
    # Lay out on a scratch origin, then re-centre afterwards via the bbox.
    for ch in text:
        d.text((x + size[0] * 0.25, size[1] * 0.25), ch, font=font, fill=255)
        x += font.getlength(ch) + tracking
    return mask, mask.getbbox()


def gradient_fill(mask, top, bottom):
    """Fill the mask's bounding box with a vertical top->bottom gradient, return RGBA layer."""
    x0, y0, x1, y1 = mask.getbbox()
    grad = Image.new("RGB", mask.size)
    gd = ImageDraw.Draw(grad)
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(1, y1 - y0)
        gd.line([(0, y), (mask.size[0], y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    layer = grad.convert("RGBA")
    layer.putalpha(mask)
    return layer


def place_text(img, text, center, font_px, fill, tracking=0.0, glow_color=None, glow_strength=0.0, glow_blur=0.0):
    """Draw `text` centred on `center` (centre of its ink bounding box). `fill` is a colour or (top, bottom)."""
    mask, bbox = text_mask(img.size, text, font_px, tracking)
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    dx = round(center[0] - (bbox[0] + bw / 2))
    dy = round(center[1] - (bbox[1] + bh / 2))
    mask = ImageChops.offset(mask, dx, dy)
    if glow_color:
        img = glow_mask(img, mask, glow_color, glow_strength, glow_blur)
    if isinstance(fill[0], tuple):
        layer = gradient_fill(mask, fill[0], fill[1])
    else:
        layer = Image.new("RGBA", img.size, fill + (255,))
        layer.putalpha(mask)
    img.paste(layer, (0, 0), layer)
    return img


# ---------- variants ----------

def draw_classic(s):
    c = s / 2
    img = backdrop(s)
    rings(img, s, (c, c), ((s * 0.33, 120), (s * 0.21, 70)))
    img = sun(img, s, (c, c), s * 0.088)
    oa = math.radians(145)
    img = orb(img, s, (c + math.cos(oa) * s * 0.21, c + math.sin(oa) * s * 0.21), s * 0.03, s * 0.05)
    return ship(img, s, (c, c), -48, s * 0.33, s * 0.0042)


def draw_sun_l(s):
    c = s / 2
    img = backdrop(s)
    rings(img, s, (c, c), ((s * 0.345, 120), (s * 0.245, 70)))
    r = s * 0.125
    img = sun(img, s, (c, c), r)
    # Dark "L" cut into the sun; nudged right because the glyph's mass sits on its left.
    img = place_text(img, "L", (c + r * 0.06, c + r * 0.02), round(r * 1.75), INK)
    oa = math.radians(150)
    img = orb(img, s, (c + math.cos(oa) * s * 0.245, c + math.sin(oa) * s * 0.245), s * 0.028, s * 0.05)
    return ship(img, s, (c, c), -48, s * 0.345, s * 0.0042)


def draw_monogram(s):
    c = s / 2
    img = backdrop(s)
    rings(img, s, (c, c), ((s * 0.335, 130),))
    img = place_text(
        img, "L", (c + s * 0.012, c + s * 0.01), round(s * 0.56),
        ((255, 236, 170), (255, 128, 52)),
        glow_color=SUN_MID, glow_strength=0.85, glow_blur=s * 0.045,
    )
    oa = math.radians(152)
    img = orb(img, s, (c + math.cos(oa) * s * 0.335, c + math.sin(oa) * s * 0.335), s * 0.03, s * 0.05)
    return ship(img, s, (c, c), -48, s * 0.335, s * 0.0042)


def draw_wordmark(s):
    c = s / 2
    img = backdrop(s)
    oc = (c, s * 0.385)  # orbit scene sits in the upper part
    rings(img, s, oc, ((s * 0.205, 120), (s * 0.125, 70)))
    img = sun(img, s, oc, s * 0.055)
    oa = math.radians(150)
    img = orb(img, s, (oc[0] + math.cos(oa) * s * 0.125, oc[1] + math.sin(oa) * s * 0.125), s * 0.02, s * 0.034)
    img = ship(img, s, oc, -48, s * 0.205, s * 0.0028)
    return place_text(
        img, "LIAD", (c, s * 0.7), round(s * 0.17),
        ((255, 236, 170), (255, 150, 60)), tracking=s * 0.012,
        glow_color=SUN_MID, glow_strength=0.5, glow_blur=s * 0.03,
    )


VARIANTS = {
    "classic": draw_classic,
    "sun-l": draw_sun_l,
    "monogram": draw_monogram,
    "wordmark": draw_wordmark,
}


def draw_icon(size, variant=DEFAULT_VARIANT):
    s = size * SS
    return VARIANTS[variant](s).resize((size, size), Image.LANCZOS)


def main():
    variant = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VARIANT
    if variant not in VARIANTS:
        sys.exit(f"unknown variant {variant!r}; choose from {', '.join(VARIANTS)}")
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("icon-maskable-512.png", 512), ("apple-touch-icon.png", 180)):
        draw_icon(size, variant).save(OUT / name, optimize=True)
        print(f"wrote {OUT / name} ({(OUT / name).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
