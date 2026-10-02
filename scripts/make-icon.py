"""Draws the app icon: a charcoal rounded square with the five-bar waveform in brand gold.

Run: python3 scripts/make-icon.py  (needs Pillow; writes build/icon.png and build/icon.icns)
"""
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SCALE = 4  # draw large, then scale down for smooth edges
BARS = [6, 12, 16, 10, 6]  # same proportions as the menu bar icon


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(width, height, stops, angle_deg=135):
    """A linear gradient across (width, height) with (position, rgb) stops."""
    import math
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    dx, dy = math.cos(math.radians(angle_deg - 90)), math.sin(math.radians(angle_deg - 90))
    span = abs(dx) * width + abs(dy) * height
    for y in range(height):
        for x in range(width):
            t = ((x - (width if dx < 0 else 0)) * dx + (y - (height if dy < 0 else 0)) * dy) / span
            t = min(1, max(0, t))
            for i in range(len(stops) - 1):
                (p0, c0), (p1, c1) = stops[i], stops[i + 1]
                if p0 <= t <= p1:
                    pixels[x, y] = lerp(c0, c1, (t - p0) / (p1 - p0 or 1))
                    break
    return image


def main():
    big = SIZE * SCALE
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # macOS icon grid: an 824 px rounded square centred in 1024, corner radius about 185.
    inset, radius = 100 * SCALE, 185 * SCALE
    box = (inset, inset, big - inset, big - inset)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)

    # Soft drop shadow under the tile.
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((inset, inset + 18 * SCALE, big - inset, big - inset + 18 * SCALE), radius, fill=(0, 0, 0, 110))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(24 * SCALE)))

    # Charcoal tile, lighter at the top.
    tile = gradient(big // 8, big // 8, [(0, (44, 46, 51)), (1, (20, 21, 24))], angle_deg=180).resize((big, big), Image.BICUBIC).convert("RGBA")
    tile.putalpha(mask)
    canvas.alpha_composite(tile)

    # Hairline highlight along the edge.
    edge = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(box, radius, outline=(255, 255, 255, 28), width=3 * SCALE)
    canvas.alpha_composite(edge)

    # The waveform: bars 44 px wide with 30 px gaps, the tallest 520 px.
    bar_width, gap, unit = 44 * SCALE, 30 * SCALE, 520 * SCALE / 16
    total = len(BARS) * bar_width + (len(BARS) - 1) * gap
    left = (big - total) // 2
    bars = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(bars)
    for index, height in enumerate(BARS):
        x = left + index * (bar_width + gap)
        h = height * unit
        draw.rounded_rectangle((x, big / 2 - h / 2, x + bar_width, big / 2 + h / 2), bar_width // 2, fill=255)

    # Gold glow behind the bars, then the bars in the brand's gold gradient.
    glow = Image.new("RGBA", (big, big), (217, 178, 95, 0))
    glow.putalpha(bars.filter(ImageFilter.GaussianBlur(40 * SCALE)).point(lambda v: int(v * 0.45)))
    glow_mask = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    glow_mask.paste(glow, (0, 0), mask)
    canvas.alpha_composite(glow_mask)
    gold = gradient(big // 8, big // 8, [(0, (240, 216, 150)), (0.48, (220, 182, 99)), (1, (185, 140, 58))]).resize((big, big), Image.BICUBIC).convert("RGBA")
    gold.putalpha(bars)
    canvas.alpha_composite(gold)

    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    root = os.path.join(os.path.dirname(__file__), "..", "build")
    icon.save(os.path.join(root, "icon.png"))

    with tempfile.TemporaryDirectory() as folder:
        iconset = os.path.join(folder, "icon.iconset")
        os.mkdir(iconset)
        for points in (16, 32, 128, 256, 512):
            for factor in (1, 2):
                pixels = points * factor
                name = f"icon_{points}x{points}{'@2x' if factor == 2 else ''}.png"
                icon.resize((pixels, pixels), Image.LANCZOS).save(os.path.join(iconset, name))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(root, "icon.icns")], check=True)


if __name__ == "__main__":
    main()
