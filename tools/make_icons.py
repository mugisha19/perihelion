"""Generate the PWA icon set for Perihelion into site/icons/.

Usage: python tools/make_icons.py

All icons share one full-bleed design whose content stays inside the central 80% circle,
so the same artwork works as a regular icon, a maskable icon (Android crops it to a
circle/squircle) and an iOS home-screen icon (iOS rounds the corners itself).
"""
import math
import pathlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "icons"
SS = 4  # supersampling factor for smooth edges

BG_EDGE = (4, 5, 13)
BG_CENTER = (20, 22, 52)
CYAN = (95, 243, 255)
GOLD = (255, 201, 60)
SUN_HOT = (255, 246, 220)
SUN_MID = (255, 179, 71)
SUN_EDGE = (255, 106, 61)


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
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=round(255 * strength))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    tint = Image.new("RGB", canvas.size, color)
    lit = ImageChops.multiply(tint, Image.merge("RGB", (layer, layer, layer)))
    return ImageChops.screen(canvas, lit)


def ship_points(cx, cy, heading, k):
    """The in-game ship polygon, rotated to `heading` and scaled by k."""
    local = [(20, 0), (-12, -12), (-6, 0), (-12, 12)]
    ca, sa = math.cos(heading), math.sin(heading)
    return [(cx + (x * ca - y * sa) * k, cy + (x * sa + y * ca) * k) for x, y in local]


def draw_icon(size):
    s = size * SS
    c = s / 2
    img = radial(s, BG_CENTER, BG_EDGE, power=0.9)

    # Soft nebula tints, as in the game's backdrop.
    img = glow(img, (s * 0.22, s * 0.2), s * 0.22, (90, 50, 170), 0.22, s * 0.12)
    img = glow(img, (s * 0.82, s * 0.84), s * 0.24, (20, 100, 170), 0.2, s * 0.12)

    # The two orbits.
    r_outer, r_inner = s * 0.33, s * 0.21
    ring = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    w = max(2, round(s * 0.008))
    for r, alpha in ((r_outer, 120), (r_inner, 70)):
        rd.ellipse((c - r, c - r, c + r, c + r), outline=(150, 165, 255, alpha), width=w)
    img.paste(ring, (0, 0), ring)

    # Sun: wide glow, then a shaded disc.
    img = glow(img, (c, c), s * 0.16, SUN_MID, 0.9, s * 0.07)
    img = glow(img, (c, c), s * 0.1, SUN_HOT, 0.7, s * 0.035)
    sun_r = s * 0.088
    sun = radial(round(sun_r * 2), SUN_HOT, SUN_EDGE, power=0.8)
    mask = Image.new("L", sun.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, sun.size[0] - 1, sun.size[1] - 1), fill=255)
    img.paste(sun, (round(c - sun_r), round(c - sun_r)), mask)

    # Gold orb on the inner orbit.
    oa = math.radians(145)
    ox, oy = c + math.cos(oa) * r_inner, c + math.sin(oa) * r_inner
    img = glow(img, (ox, oy), s * 0.05, GOLD, 0.9, s * 0.03)
    d = ImageDraw.Draw(img)
    orb_r = s * 0.03
    d.ellipse((ox - orb_r, oy - orb_r, ox + orb_r, oy + orb_r), fill=(255, 224, 138))
    d.ellipse((ox - orb_r * 0.55, oy - orb_r * 0.6, ox - orb_r * 0.05, oy - orb_r * 0.1), fill=(255, 251, 230))

    # Cyan ship on the outer orbit, pointing along its direction of travel.
    sa_ = math.radians(-48)
    sx, sy = c + math.cos(sa_) * r_outer, c + math.sin(sa_) * r_outer
    img = glow(img, (sx, sy), s * 0.07, CYAN, 0.8, s * 0.04)
    d = ImageDraw.Draw(img)
    k = s * 0.0042
    pts = ship_points(sx, sy, sa_ + math.pi / 2, k)
    d.polygon(pts, fill=(234, 252, 255), outline=CYAN, width=max(2, round(s * 0.006)))

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("icon-maskable-512.png", 512), ("apple-touch-icon.png", 180)):
        draw_icon(size).save(OUT / name, optimize=True)
        print(f"wrote {OUT / name} ({(OUT / name).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
