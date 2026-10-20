import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_OUT = ROOT / "map_images"
PUBLIC_OUT = ROOT / "public" / "assets" / "maps"
MAP_JSON = ROOT / "public" / "data" / "maps" / "map_002_generated.json"

LIGHT_NAME = "map_002_terrain_light.png"
DARK_NAME = "map_002_terrain_dark.png"
COORD_NAME = "map_002_with_coords.png"

HEX_SIZE = 42
MARGIN = 72
SIDE_A = 6
SIDE_B = 6
SIDE_C = 8
DIRECTIONS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]


def coord_key(coord):
    return f"{coord[0]},{coord[1]}"


def axial_distance(a, b):
    aq, ar = a
    bq, br = b
    return max(abs(aq - bq), abs(ar - br), abs(aq + ar - bq - br))


def hex_vertices(side_a=SIDE_A, side_b=SIDE_B, side_c=SIDE_C):
    a = side_a - 1
    b = side_b - 1
    c = side_c - 1
    return [(-a, 0), (-a, b), (0, b), (c, b - c), (c, -c), (c - a, -c)]


def build_cells(vertices):
    q_min, q_max = min(q for q, _ in vertices), max(q for q, _ in vertices)
    r_min, r_max = min(r for _, r in vertices), max(r for _, r in vertices)
    s_min, s_max = min(q + r for q, r in vertices), max(q + r for q, r in vertices)
    return [
        (q, r)
        for q in range(q_min, q_max + 1)
        for r in range(r_min, r_max + 1)
        if s_min <= q + r <= s_max
    ]


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


def draw_floor(draw, coord, cx, cy, rng):
    base_colors = ["#e7d18c", "#dec57c", "#efd99a", "#d7bb71", "#ead59b", "#d2b46a"]
    base = rng.choice(base_colors)
    pts = hex_points(cx, cy)
    draw.polygon(pts, fill=base, outline="#7e6839")
    draw.polygon(inner_points(cx, cy, 0.88), outline=adjust_color(base, 0.16), width=1)
    draw.polygon(inner_points(cx, cy, 0.62), outline=adjust_color(base, -0.08), width=1)

    if (coord[0] - coord[1]) % 4 == 0:
        draw.line((pts[0][0], pts[0][1], pts[3][0], pts[3][1]), fill="#f6e7b3", width=1)
    if (coord[0] + coord[1]) % 6 == 0:
        draw.arc((cx - 22, cy - 15, cx + 25, cy + 18), 205, 338, fill="#c5a65d", width=1)

    sand_points = inner_points(cx, cy, 0.75)
    for px, py in sand_points:
        jitter_x = rng.uniform(-4.5, 4.5)
        jitter_y = rng.uniform(-3.5, 3.5)
        radius = rng.choice([0.8, 1.0, 1.2])
        color = rng.choice(["#b89a56", "#f5e7b7", "#c9ac67", "#a98844"])
        draw.ellipse((px + jitter_x - radius, py + jitter_y - radius, px + jitter_x + radius, py + jitter_y + radius), fill=color)


def render_light(cells):
    width, height, shifted = layout(cells)
    image = Image.new("RGB", (width, height), "#dcbf75")
    draw = ImageDraw.Draw(image)
    rng = random.Random(2002)

    for y in range(height):
        t = y / max(1, height)
        r = int(225 + 16 * (1 - t))
        g = int(198 + 18 * (1 - t))
        b = int(124 + 20 * (1 - t))
        draw.line((0, y, width, y), fill=(r, g, b))

    for coord in sorted(cells):
        draw_floor(draw, coord, *shifted(coord), rng)

    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    for coord in sorted(cells):
        if (coord[0] + 2 * coord[1]) % 8 == 0:
            cx, cy = shifted(coord)
            g.ellipse((cx - 48, cy - 42, cx + 48, cy + 42), fill=(255, 246, 190, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(16))
    return Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")


def render_dark(light):
    image = ImageEnhance.Brightness(light).enhance(0.58)
    image = ImageEnhance.Color(image).enhance(0.7)
    image = ImageEnhance.Contrast(image).enhance(0.9)
    overlay = Image.new("RGBA", image.size, (61, 45, 27, 62))
    image = Image.alpha_composite(image.convert("RGBA"), overlay)
    haze = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(haze)
    width, height = image.size
    for y in range(0, height, 18):
        alpha = 5 + int(8 * y / height)
        draw.line((0, y, width, y), fill=(126, 96, 48, alpha), width=1)
    return Image.alpha_composite(image, haze).convert("RGB")


def render_coord_reference(light, cells):
    image = light.convert("RGBA")
    draw = ImageDraw.Draw(image)
    _, _, shifted = layout(cells)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 12)
        small_font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 14)
    except Exception:
        font = None
        small_font = None
    for coord in sorted(cells):
        cx, cy = shifted(coord)
        text = f"{coord[0]},{coord[1]}"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.rounded_rectangle((cx - tw / 2 - 4, cy - th / 2 - 3, cx + tw / 2 + 4, cy + th / 2 + 3), radius=3, fill=(35, 26, 13, 150))
        draw.text((cx - tw / 2, cy - th / 2 - 1), text, fill=(255, 246, 208, 255), font=font)
    label = "Map 002 developer coordinate reference"
    draw.rounded_rectangle((20, 18, 332, 52), radius=6, fill=(40, 29, 12, 170))
    draw.text((34, 27), label, fill=(255, 241, 196, 255), font=small_font)
    return image.convert("RGB")


def build_payload(cells, vertices):
    base_i = (-4, 4)
    base_ii = (6, -6)
    features = {coord: {"type": "floor", "blocking": False} for coord in cells}
    payload = {
        "map_ID": "002",
        "name": "单挑战场",
        "description": "浅黄色沙滩地面的六边形单挑战场，三组对边长度为 6、6、8。",
        "mission": {"type": "duel", "objective": "击坠对方机甲"},
        "source_files": {"map_xlsx": "map_data.xlsx", "worksheet": "Solo Field"},
        "vertex_coordinates": [list(coord) for coord in vertices],
        "side_lengths": [SIDE_A, SIDE_B, SIDE_C],
        "coordinate_system": "axial pointy-top (q,r)",
        "cell_count": len(cells),
        "radius_of_view": 7,
        "special_tiles": {
            "flame": {
                "name": "烈焰格子",
                "description": "站在其上面的机甲，每轮结算开始时会减少400HP",
                "damage_per_turn": 400,
            }
        },
        "special_rules": {
            "flame_ring": {
                "name": "烈焰包围",
                "description": "每隔三回合，地图最外面一圈普通格子就会变成烈焰格子。地图会慢慢地从外到内被烈焰格子覆盖。",
                "first_round": 3,
                "interval_rounds": 3,
                "damage_per_turn": 400,
                "convert_tile_types": ["floor", "ground", "spawn"],
            }
        },
        "terrain_images": {
            "player_light": f"assets/maps/{LIGHT_NAME}",
            "player_dark": f"assets/maps/{DARK_NAME}",
        },
        "team_bases": {},
        "spawn_tiles": {
            "Team I": [list(base_i)] if base_i in cells else [list(cells[0])],
            "Team II": [list(base_ii)] if base_ii in cells else [list(cells[-1])],
        },
        "respawn_tiles": {
            "Team I": [list(base_i)] if base_i in cells else [list(cells[0])],
            "Team II": [list(base_ii)] if base_ii in cells else [list(cells[-1])],
        },
        "respawn_rounds": {"Team I": 3, "Team II": 3},
        "bunkers": [],
        "obstacles": [],
        "wall_segments": [],
        "treasure_chests": {},
        "tiles": [dict({"coord": list(coord)}, **features[coord]) for coord in sorted(cells)],
    }
    return payload


def main():
    vertices = hex_vertices()
    cells = build_cells(vertices)
    light = render_light(cells)
    dark = render_dark(light)
    coord_reference = render_coord_reference(light, cells)

    REFERENCE_OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    for out_dir in (REFERENCE_OUT, PUBLIC_OUT):
        light.save(out_dir / LIGHT_NAME)
        dark.save(out_dir / DARK_NAME)
    coord_reference.save(REFERENCE_OUT / COORD_NAME)

    payload = build_payload(cells, vertices)
    MAP_JSON.parent.mkdir(parents=True, exist_ok=True)
    MAP_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"vertices={vertices}")
    print(f"cells={len(cells)}")
    print(REFERENCE_OUT / LIGHT_NAME)
    print(REFERENCE_OUT / DARK_NAME)
    print(REFERENCE_OUT / COORD_NAME)
    print(PUBLIC_OUT / LIGHT_NAME)
    print(PUBLIC_OUT / DARK_NAME)
    print(MAP_JSON)


if __name__ == "__main__":
    main()
