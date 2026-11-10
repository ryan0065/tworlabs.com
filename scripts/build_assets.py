#!/usr/bin/env python3
"""Build transparent logo, icons, social image, and pixel scenery for /production.

The preferred master is the textured-hair JPEG. Its backdrop is plain white, so
the background is removed with an edge flood-fill. The earlier transparent PNG
is only used if the cutout eats the mark or leaves the center empty.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "production"
ASSETS = OUT / "assets"
UPLOADS = Path("/home/ubuntu/.cursor/projects/workspace/uploads")
JPG = UPLOADS / "logo_latest_textured_hair_461f.jpg"
FALLBACK = UPLOADS / "logo_transparent_1200_5942.png"
FONT = Path("/tmp/font/press-start-2p.ttf")

NAVY = (2, 32, 90, 255)
GOLD = (251, 207, 26, 255)
WHITE = (228, 226, 226, 255)
DIRT = (106, 59, 17, 255)
DIRT_DARK = (67, 35, 10, 255)
GRASS = (111, 184, 25, 255)
GRASS_DARK = (56, 117, 7, 255)
GRASS_HI = (143, 210, 58, 255)


def flood_cutout(rgb: np.ndarray) -> np.ndarray:
    """Return an RGBA image with the edge-connected near-white backdrop removed."""
    height, width, _ = rgb.shape
    red = rgb[:, :, 0].astype(np.int16)
    green = rgb[:, :, 1].astype(np.int16)
    blue = rgb[:, :, 2].astype(np.int16)
    chroma = np.maximum(np.maximum(red, green), blue) - np.minimum(np.minimum(red, green), blue)
    minimum = np.minimum(np.minimum(red, green), blue)
    # JPEG edges are not pure white. Keep this tight so banner letters stay.
    background = (minimum >= 246) & (chroma <= 14)

    visited = np.zeros((height, width), dtype=bool)
    alpha = np.full((height, width), 255, dtype=np.uint8)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if background[0, x]:
            queue.append((0, x))
        if background[height - 1, x]:
            queue.append((height - 1, x))
    for y in range(height):
        if background[y, 0]:
            queue.append((y, 0))
        if background[y, width - 1]:
            queue.append((y, width - 1))

    while queue:
        y, x = queue.popleft()
        if visited[y, x]:
            continue
        visited[y, x] = True
        if not background[y, x]:
            continue
        alpha[y, x] = 0
        if y > 0:
            queue.append((y - 1, x))
        if y + 1 < height:
            queue.append((y + 1, x))
        if x > 0:
            queue.append((y, x - 1))
        if x + 1 < width:
            queue.append((y, x + 1))

    transparent = alpha == 0
    ring = np.zeros_like(transparent)
    ring[1:] |= transparent[:-1]
    ring[:-1] |= transparent[1:]
    ring[:, 1:] |= transparent[:, :-1]
    ring[:, :-1] |= transparent[:, 1:]
    ring &= ~transparent
    ys, xs = np.where(ring)
    for y, x in zip(ys.tolist(), xs.tolist()):
        whiteness = int((int(red[y, x]) + int(green[y, x]) + int(blue[y, x])) / 3)
        pixel_chroma = int(chroma[y, x])
        if whiteness >= 220 and pixel_chroma <= 28:
            # 220 -> mostly opaque, 250+ -> gone. Softens the JPEG fringe.
            alpha[y, x] = int(max(0, min(255, (250 - whiteness) * 12)))

    out = np.dstack([rgb, alpha])
    return out


def trim_alpha(image: Image.Image, pad: int = 8) -> Image.Image:
    arr = np.array(image)
    ys, xs = np.where(arr[:, :, 3] > 8)
    if len(xs) == 0:
        return image
    left = max(0, int(xs.min()) - pad)
    top = max(0, int(ys.min()) - pad)
    right = min(image.width, int(xs.max()) + 1 + pad)
    bottom = min(image.height, int(ys.max()) + 1 + pad)
    return image.crop((left, top, right, bottom))


def cutout_is_healthy(image: Image.Image) -> bool:
    arr = np.array(image)
    alpha = arr[:, :, 3]
    opaque = alpha > 200
    if opaque.mean() < 0.18 or opaque.mean() > 0.85:
        return False
    # Banner letters are white and must survive.
    red, green, blue = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    white_letters = opaque & (red > 235) & (green > 235) & (blue > 235)
    if int(white_letters.sum()) < 800:
        return False
    # The shield center should still be painted, not punched out.
    cy, cx = image.height // 2, image.width // 2
    if int(alpha[cy - 20 : cy + 20, cx - 20 : cx + 20].mean()) < 200:
        return False
    return True


def load_logo() -> Image.Image:
    rgb = np.array(Image.open(JPG).convert("RGB"))
    cut = Image.fromarray(flood_cutout(rgb), "RGBA")
    cut = trim_alpha(cut, pad=12)
    if cutout_is_healthy(cut):
        print("logo: using textured-hair cutout", cut.size)
        return cut
    print("logo: cutout failed checks, using fallback transparent PNG")
    fallback = Image.open(FALLBACK).convert("RGBA")
    return trim_alpha(fallback, pad=12)


def save_logo(logo: Image.Image) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    logo.save(ASSETS / "logo.png", "PNG", optimize=True)
    logo.save(ASSETS / "logo.webp", "WEBP", quality=90, method=6)
    print("logo bytes", (ASSETS / "logo.png").stat().st_size, (ASSETS / "logo.webp").stat().st_size)


def fit_on_square(logo: Image.Image, size: int, padding: int, background: tuple[int, int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), background)
    inner = size - padding * 2
    scale = min(inner / logo.width, inner / logo.height)
    resized = logo.resize((max(1, int(logo.width * scale)), max(1, int(logo.height * scale))), Image.Resampling.LANCZOS)
    x = (size - resized.width) // 2
    y = (size - resized.height) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas


def save_icons(logo: Image.Image) -> None:
    # Favicons read better if they emphasize the shield rather than the banner.
    # Keep the full mark; the banner is part of the identity.
    touch = fit_on_square(logo, 180, 10, NAVY)
    touch.convert("RGB").save(OUT / "apple-touch-icon.png", "PNG", optimize=True)
    icon192 = fit_on_square(logo, 192, 12, NAVY).convert("RGB")
    icon192.save(ASSETS / "icon-192.png", "PNG", optimize=True)
    icon512 = fit_on_square(logo, 512, 28, NAVY).convert("RGB")
    icon512.save(ASSETS / "icon-512.png", "PNG", optimize=True)

    sizes = [16, 32, 48]
    frames = []
    for size in sizes:
        frame = fit_on_square(logo, size, max(1, size // 16), NAVY).convert("RGBA")
        frames.append(frame)
        if size in (16, 32):
            frame.convert("RGB").save(OUT / f"favicon-{size}.png", "PNG", optimize=True)
    frames[0].save(
        OUT / "favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[1:],
    )


def sprinkle(draw: ImageDraw.ImageDraw, width: int, height: int, count: int, rng: np.random.Generator) -> None:
    for _ in range(count):
        x = int(rng.integers(0, width))
        y = int(rng.integers(0, height))
        kind = int(rng.integers(0, 8))
        color = GOLD if kind == 0 else (255, 255, 255, 255)
        if kind < 2:
            arm = int(rng.integers(3, 7))
            draw.line((x - arm, y, x + arm, y), fill=color, width=2)
            draw.line((x, y - arm, x, y + arm), fill=color, width=2)
        else:
            radius = 1 if kind < 6 else 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def save_og(logo: Image.Image) -> None:
    width, height = 1200, 630
    image = Image.new("RGBA", (width, height), NAVY)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        # Slight horizon lift so the card is not a flat rectangle of navy.
        t = y / (height - 1)
        shade = int(8 * (1 - t))
        if shade:
            draw.line((0, y, width, y), fill=(2, 32 + shade, 90 + shade * 2, 255))
    rng = np.random.default_rng(7)
    sprinkle(draw, width, height - 90, 90, rng)

    font_title = ImageFont.truetype(str(FONT), 42)
    font_tag = ImageFont.truetype(str(FONT), 16)
    title = "COMING SOON"
    tag = "Two brothers. Big ideas. Building a new world."
    title_box = draw.textbbox((0, 0), title, font=font_title)
    title_w = title_box[2] - title_box[0]
    title_x = (width - title_w) // 2
    # Blocky extrusion, then the gold face.
    for step, color in ((6, (9, 13, 24)), (4, (67, 35, 10)), (2, (166, 107, 18))):
        draw.text((title_x + step, 36 + step), title, font=font_title, fill=color)
    draw.text((title_x, 36), title, font=font_title, fill=GOLD)

    max_h = 390
    scale = min(520 / logo.width, max_h / logo.height)
    resized = logo.resize((int(logo.width * scale), int(logo.height * scale)), Image.Resampling.LANCZOS)
    x = (width - resized.width) // 2
    y = 100
    image.alpha_composite(resized, (x, y))

    tag_box = draw.textbbox((0, 0), tag, font=font_tag)
    tag_w = tag_box[2] - tag_box[0]
    tag_y = height - 78
    draw.text(((width - tag_w) // 2 + 3, tag_y + 3), tag, font=font_tag, fill=(9, 13, 24))
    draw.text(((width - tag_w) // 2, tag_y), tag, font=font_tag, fill=WHITE)

    # Grass strip along the bottom, matching the page.
    ground = build_ground().resize((96, 40), Image.Resampling.NEAREST)
    strip = Image.new("RGBA", (width, 40), DIRT)
    for gx in range(0, width, 96):
        strip.alpha_composite(ground, (gx, 0))
    image.alpha_composite(strip, (0, height - 40))

    rgb = image.convert("RGB")
    rgb.save(ASSETS / "og.jpg", "JPEG", quality=86, optimize=True, progressive=True)
    print("og bytes", (ASSETS / "og.jpg").stat().st_size)


def build_ground() -> Image.Image:
    """Three grass-over-dirt blocks. Each block is 16 source pixels wide."""
    w, h = 48, 20
    img = Image.new("RGBA", (w, h), DIRT)
    pix = img.load()
    grass = [
        (126, 196, 40),
        (111, 184, 25),
        (143, 210, 58),
        (90, 168, 22),
        (111, 184, 25),
    ]
    overhang = [(56, 117, 7), (46, 100, 8), (74, 140, 16), (67, 35, 10)]
    dirt_colors = [(106, 59, 17), (122, 74, 24), (90, 48, 14), (67, 35, 10), (138, 85, 32), (80, 44, 12)]
    rng = np.random.default_rng(3)
    for y in range(h):
        for x in range(w):
            if y < 3:
                pix[x, y] = (*grass[(x + y * 3) % len(grass)], 255)
            elif y < 6:
                pix[x, y] = (*overhang[(x // 2 + y) % len(overhang)], 255)
            else:
                # Darker seam between blocks so the cubes read.
                if x % 16 in (0, 15):
                    pix[x, y] = (*DIRT_DARK[:3], 255)
                else:
                    pix[x, y] = (*dirt_colors[int(rng.integers(0, len(dirt_colors)))], 255)
    pix[6, 11] = (88, 76, 66, 255)
    pix[24, 14] = (72, 64, 58, 255)
    pix[40, 9] = (100, 86, 70, 255)
    return img


def save_ground() -> None:
    ground = build_ground()
    # Pre-scale with nearest neighbor so the blocks stay crisp.
    big = ground.resize((ground.width * 4, ground.height * 4), Image.Resampling.NEAREST)
    big.save(ASSETS / "ground.png", "PNG", optimize=True)


def paint_map(rows: list[str], scale: int = 8) -> Image.Image:
    """Paint a legend map. Each character is one block, scaled up nearest-neighbor."""
    legend = {
        ".": None,
        "G": (56, 117, 7),
        "g": (90, 168, 22),
        "L": (143, 210, 58),
        "D": (46, 92, 8),
        "B": (106, 59, 17),
        "b": (74, 42, 12),
        "W": (255, 255, 255),
        "w": (214, 226, 238),
        "s": (168, 190, 214),
        "R": (159, 168, 180),
        "r": (114, 112, 116),
        "k": (78, 82, 90),
    }
    height = len(rows)
    width = max(len(row) for row in rows)
    img = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            color = legend.get(ch)
            if color is None:
                continue
            x0, y0 = x * scale, y * scale
            x1, y1 = x0 + scale - 1, y0 + scale - 1
            draw.rectangle((x0, y0, x1, y1), fill=color + (255,))
            hi = tuple(min(255, c + 32) for c in color)
            lo = tuple(max(0, int(c * 0.66)) for c in color)
            draw.line((x0, y0, x1, y0), fill=hi + (255,))
            draw.line((x0, y0, x0, y1), fill=hi + (255,))
            draw.line((x0, y1, x1, y1), fill=lo + (255,))
            draw.line((x1, y0, x1, y1), fill=lo + (255,))
    return img


def save_scenery() -> None:
    trees = {
        "tree-a.png": [
            "......ggLgg.....",
            "....ggLLGGggg...",
            "...gLGGGGGGGgg..",
            "..ggGGGGGGGGGgg.",
            "..gGGGGGGGGGDg..",
            "...gGGGGGGDggg..",
            "....ggDgggg.....",
            ".......bb.......",
            ".......BB.......",
            ".......bb.......",
            ".......BB.......",
        ],
        "tree-b.png": [
            "....gLgg....",
            "..ggGGGggg..",
            ".gLGGGGGGgg.",
            ".gGGGGGGDGg.",
            "..gGGDGggg..",
            "...ggggg....",
            ".....bb.....",
            ".....BB.....",
            ".....bb.....",
        ],
        "tree-c.png": [
            ".......gggg.......",
            ".....ggLLGggg.....",
            "...ggLGGGGGGGg....",
            "..gLGGGGGGGGGGgg..",
            ".ggGGGGGGGGGGGDg..",
            ".gGGGGGGGGGGGGGg..",
            "..gGGGGGGGGDGgg...",
            "...ggGGGGGggg.....",
            ".....gggggg.......",
            "........bb........",
            "........BB........",
            "........bb........",
            "........BB........",
            "........bb........",
        ],
    }
    for name, rows in trees.items():
        image = paint_map(rows, scale=10)
        image.save(ASSETS / name, "PNG", optimize=True)
        print(name, image.size)

    paint_map(
        [
            "..Rr..",
            ".RRRk.",
            "RRkkk.",
            ".rkk..",
        ],
        scale=10,
    ).save(ASSETS / "rock.png", "PNG", optimize=True)

    paint_map(
        [
            "....wwwww.......",
            "..wwWWWWwwww....",
            ".wWWWWWWWWWWw...",
            "wwWWWWWWWWWWWw..",
            ".wwwwssssssww...",
            "..ssssssssss....",
        ],
        scale=10,
    ).save(ASSETS / "cloud.png", "PNG", optimize=True)

    paint_map(
        [
            "...wwww........",
            ".wwWWWWww......",
            "wWWWWWWWWww....",
            "wwssssssssww...",
            ".ssssssssss....",
        ],
        scale=10,
    ).save(ASSETS / "cloud-b.png", "PNG", optimize=True)


def preview_on_navy(logo: Image.Image) -> None:
    preview = Image.new("RGBA", logo.size, NAVY)
    preview.alpha_composite(logo)
    preview.convert("RGB").save("/tmp/logo_on_navy.jpg", "JPEG", quality=90)
    # Magenta makes leftover white fringes obvious.
    magenta = Image.new("RGBA", logo.size, (255, 0, 255, 255))
    magenta.alpha_composite(logo)
    magenta.convert("RGB").save("/tmp/logo_on_magenta.jpg", "JPEG", quality=90)


def main() -> None:
    logo = load_logo()
    save_logo(logo)
    save_icons(logo)
    save_og(logo)
    save_ground()
    save_scenery()
    preview_on_navy(logo)
    print("done", logo.size)


if __name__ == "__main__":
    main()
