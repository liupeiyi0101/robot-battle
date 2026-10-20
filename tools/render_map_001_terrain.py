import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
MAP_JSON = ROOT / "public" / "data" / "maps" / "map_001_generated.json"
PUBLIC_OUT = ROOT / "public" / "assets" / "maps"
REFERENCE_OUT = ROOT / "map_images"

LIGHT_NAME = "map_001_terrain_light.png"
DARK_NAME = "map_001_terrain_dark.png"

HEX_SIZE = 34
MARGIN = 72
DIRECTIONS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]


def load_map():
    return json.loads(MAP_JSON.read_text(encoding="utf-8"))


def hex_points(cx, cy, size=HEX_SIZE):
    return [
        (cx + size * math.cos(math.radians(60 * i - 30)), cy + size * math.sin(math.radians(60 * i - 30)))
        for i in range(6)
    ]


def inner_points(cx, cy, scale):
    return [(cx + (x - cx) * scale, cy + (y - cy) * scale) for x, y in hex_points(cx, cy)]


def layout(cells):
    centers = {c: (HEX_SIZE * math.sqrt(3) * (c[0] + c[1] / 2), HEX_SIZE * 1.5 * c[1]) for c in cells}
    min_x = min(p[0] for p in centers.values())
    max_x = max(p[0] for p in centers.values())
    min_y = min(p[1] for p in centers.values())
    max_y = max(p[1] for p in centers.values())
    width = int(max_x - min_x + HEX_SIZE * math.sqrt(3) + MARGIN * 2)
    height = int(max_y - min_y + HEX_SIZE * 2 + MARGIN * 2)

    def shifted(c):
        x, y = centers[c]
        return (x - min_x + MARGIN + HEX_SIZE * math.sqrt(3) / 2, y - min_y + MARGIN + HEX_SIZE)

    return width, height, shifted


def adjust_color(hex_color, amount):
    rgb = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    out = []
    for value in rgb:
        if amount >= 0:
            out.append(int(value + (255 - value) * amount))
        else:
            out.append(int(value * (1 + amount)))
    return tuple(max(0, min(255, v)) for v in out)


def draw_floor(draw, c, cx, cy, rng):
    base_colors = ["#244f76", "#2b5b83", "#285678", "#1f4568", "#32628b"]
    base = rng.choice(base_colors)
    pts = hex_points(cx, cy)
    draw.polygon(pts, fill=base, outline="#101b2b")
    draw.polygon(inner_points(cx, cy, 0.86), outline=adjust_color(base, 0.2), width=1)

    # Comic-style metal panel facets and blue light strips.
    if (c[0] - c[1]) % 5 == 0:
        p1, p2 = pts[0], pts[3]
        draw.line((p1[0], p1[1], p2[0], p2[1]), fill="#3b7fab", width=1)
    if (c[0] + c[1]) % 7 == 0:
        p1, p2 = pts[1], pts[4]
        draw.line((p1[0], p1[1], p2[0], p2[1]), fill="#7bd5ff", width=2)

    for px, py in inner_points(cx, cy, 0.72)[::2]:
        draw.ellipse((px - 1.4, py - 1.4, px + 1.4, py + 1.4), fill="#173755")


def draw_obstacle(draw, cx, cy, rng):
    pts = inner_points(cx, cy, 0.78)
    draw.polygon(pts, fill="#2b3342", outline="#070b12")
    draw.polygon(inner_points(cx - 2, cy - 3, 0.54), fill="#4a5668", outline="#111923")
    draw.line((cx - 18, cy - 6, cx + 14, cy + 10), fill="#121923", width=3)
    draw.line((cx - 10, cy + 12, cx + 18, cy - 8), fill="#5c697b", width=2)


def draw_bunker(draw, cx, cy):
    draw.polygon(inner_points(cx, cy, 0.82), fill="#b2872d", outline="#2a1f08")
    draw.polygon(inner_points(cx, cy - 2, 0.58), fill="#e2c062", outline="#543d12")
    draw.rectangle((cx - 16, cy - 8, cx + 16, cy + 5), fill="#7b683f", outline="#251a0b")
    draw.rectangle((cx - 7, cy - 17, cx + 7, cy + 3), fill="#c8a34a", outline="#39280e")
    draw.line((cx - 20, cy + 13, cx + 20, cy + 13), fill="#4a3715", width=3)


def draw_base(draw, cx, cy, team):
    if team == "Team I":
        base, glow, trim = "#2e8cff", "#86d8ff", "#0a2e66"
    else:
        base, glow, trim = "#ee5d66", "#ffc1c1", "#661b24"
    draw.polygon(hex_points(cx, cy, HEX_SIZE * 0.93), fill=adjust_color(base, -0.18), outline="#08101b")
    draw.polygon(inner_points(cx, cy, 0.68), fill=base, outline=trim)
    draw.rectangle((cx - 18, cy - 15, cx + 18, cy + 19), fill=adjust_color(base, -0.08), outline=trim)
    draw.rectangle((cx - 10, cy - 25, cx + 10, cy - 4), fill=adjust_color(base, 0.12), outline=trim)
    draw.line((cx - 22, cy + 23, cx + 22, cy + 23), fill=glow, width=3)
    draw.ellipse((cx - 5, cy - 4, cx + 5, cy + 6), fill=glow)


def draw_spawn_overlay(draw, cx, cy, team):
    color = "#7cc8ff" if team == "Team I" else "#ff9fa7"
    draw.polygon(inner_points(cx, cy, 0.62), outline=color, width=2)


def render_light(payload):
    tiles = payload["tiles"]
    cells = [tuple(tile["coord"]) for tile in tiles]
    features = {tuple(tile["coord"]): tile for tile in tiles}
    width, height, shifted = layout(cells)
    image = Image.new("RGB", (width, height), "#101b2c")
    draw = ImageDraw.Draw(image)
    rng = random.Random(77)

    # Soft indoor vignette and floor field.
    for y in range(height):
        shade = int(18 + 18 * (y / height))
        draw.line((0, y, width, y), fill=(8, shade, 34 + shade // 2))

    for c in sorted(cells):
        cx, cy = shifted(c)
        draw_floor(draw, c, cx, cy, rng)

    # Draw spawn rings below major structures but above floor.
    for c in sorted(cells):
        f = features[c]
        if f["type"] == "spawn":
            draw_spawn_overlay(draw, *shifted(c), f.get("team"))

    # Draw objects in vertical order for a small top-down depth cue.
    for c in sorted(cells, key=lambda item: shifted(item)[1]):
        f = features[c]
        cx, cy = shifted(c)
        if f["type"] == "bunker":
            draw_bunker(draw, cx, cy)
        elif f["type"] == "obstacle":
            draw_obstacle(draw, cx, cy, rng)
        elif f["type"] == "base":
            draw_base(draw, cx, cy, f.get("team"))

    # Faint blue overhead glow, like indoor sci-fi lighting.
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    for c in sorted(cells):
        if (c[0] + 2 * c[1]) % 11 == 0:
            cx, cy = shifted(c)
            g.ellipse((cx - 40, cy - 40, cx + 40, cy + 40), fill=(84, 185, 255, 18))
    glow = glow.filter(ImageFilter.GaussianBlur(18))
    return Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")


def render_dark(light):
    # Slight fog-of-war dimming: darker, cooler, and less saturated, but still readable.
    image = ImageEnhance.Brightness(light).enhance(0.82)
    image = ImageEnhance.Color(image).enhance(0.88)
    image = ImageEnhance.Contrast(image).enhance(0.96)
    overlay = Image.new("RGBA", image.size, (13, 32, 58, 26))
    image = Image.alpha_composite(image.convert("RGBA"), overlay)
    haze = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(haze)
    width, height = image.size
    for y in range(0, height, 18):
        alpha = 5 + int(7 * y / height)
        draw.line((0, y, width, y), fill=(74, 126, 170, alpha), width=1)
    return Image.alpha_composite(image, haze).convert("RGB")


def save_and_update_json(payload):
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    REFERENCE_OUT.mkdir(parents=True, exist_ok=True)
    light = render_light(payload)
    dark = render_dark(light)

    for out_dir in (PUBLIC_OUT, REFERENCE_OUT):
        light.save(out_dir / LIGHT_NAME)
        dark.save(out_dir / DARK_NAME)

    payload["terrain_images"] = {
        "debug_light_with_coords": "map_images/map_001_training_arena_light.png",
        "player_light": f"assets/maps/{LIGHT_NAME}",
        "player_dark": f"assets/maps/{DARK_NAME}",
    }
    MAP_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (REFERENCE_OUT / "map_001_generated_tiles.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    save_and_update_json(load_map())
    print(PUBLIC_OUT / LIGHT_NAME)
    print(PUBLIC_OUT / DARK_NAME)
    print(REFERENCE_OUT / LIGHT_NAME)
    print(REFERENCE_OUT / DARK_NAME)


if __name__ == "__main__":
    main()
