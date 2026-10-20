import json
import math
import random
import re
from collections import deque
from pathlib import Path

import openpyxl
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_MAP = ROOT / "public" / "data" / "maps" / "map_001_generated.json"
REFERENCE_MAP = ROOT / "map_images" / "map_001_generated_tiles.json"
LIGHT_IMAGE = ROOT / "map_images" / "map_001_training_arena_light.png"
DARK_IMAGE = ROOT / "map_images" / "map_001_training_arena_dark.png"

SEED = 20260517
OBSTACLE_TARGET = 38
WALL_LENGTHS = [5, 5, 4, 4, 4]
DIRECTIONS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]


def parse_coords(text):
    return [(int(a), int(b)) for a, b in re.findall(r"\((-?\d+)\s*,\s*(-?\d+)\)", str(text))]


def load_map_fields():
    wb = openpyxl.load_workbook(ROOT / "map_data.xlsx", data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    return ws.title, {str(k).strip(): v for k, v in rows[1:] if k}


def hex_distance(a, b):
    aq, ar = a
    bq, br = b
    return int((abs(aq - bq) + abs(ar - br) + abs((aq + ar) - (bq + br))) / 2)


def neighbors(coord, cell_set):
    q, r = coord
    return [(q + dq, r + dr) for dq, dr in DIRECTIONS if (q + dq, r + dr) in cell_set]


def connected_without_choke_points(cells, blocking):
    passable = set(cells) - set(blocking)
    if not passable:
        return False

    def reachable(skip=None):
        starts = passable - ({skip} if skip else set())
        if not starts:
            return set()
        start = next(iter(starts))
        seen = {start}
        queue = deque([start])
        while queue:
            current = queue.popleft()
            for nxt in neighbors(current, set(cells)):
                if nxt == skip or nxt in blocking or nxt in seen:
                    continue
                seen.add(nxt)
                queue.append(nxt)
        return seen

    if reachable() != passable:
        return False

    # No single open tile should be the only bridge between two regions.
    for tile in passable:
        if len(reachable(skip=tile)) != len(passable) - 1:
            return False
    return True


def build_cells(vertices):
    q_min, q_max = min(q for q, r in vertices), max(q for q, r in vertices)
    r_min, r_max = min(r for q, r in vertices), max(r for q, r in vertices)
    s_min, s_max = min(q + r for q, r in vertices), max(q + r for q, r in vertices)
    return [
        (q, r)
        for q in range(q_min, q_max + 1)
        for r in range(r_min, r_max + 1)
        if s_min <= q + r <= s_max
    ]


def generate_obstacles(cells, bases, spawns, bunkers):
    rng = random.Random(SEED)
    cell_set = set(cells)
    protected = set(bases) | set(spawns) | set(bunkers)
    wall_cells = set()
    wall_segments = []

    def too_close_to_protected(tile):
        return (
            any(hex_distance(tile, base) <= 2 for base in bases)
            or any(hex_distance(tile, spawn) <= 1 for spawn in spawns)
            or any(hex_distance(tile, bunker) <= 1 for bunker in bunkers)
        )

    def segment_is_valid(segment):
        if len(segment) != len(set(segment)):
            return False
        if any(tile not in cell_set or tile in protected or tile in wall_cells for tile in segment):
            return False
        if any(too_close_to_protected(tile) for tile in segment):
            return False
        if wall_cells and min(hex_distance(a, b) for a in segment for b in wall_cells) < 3:
            return False
        next_blocking = set(bases) | wall_cells | set(segment)
        return connected_without_choke_points(cells, next_blocking)

    for idx, length in enumerate(WALL_LENGTHS, 1):
        segment = []
        for _ in range(800):
            start = rng.choice(cells)
            direction = rng.choice(DIRECTIONS)
            candidate = [(start[0] + direction[0] * step, start[1] + direction[1] * step) for step in range(length)]
            if segment_is_valid(candidate):
                segment = candidate
                break
        wall_cells.update(segment)
        wall_segments.append({"id": f"wall_{idx}", "tiles": segment})

    obstacles = set(wall_cells)

    def scatter_is_valid(tile):
        if tile in protected or tile in obstacles or too_close_to_protected(tile):
            return False
        if obstacles and min(hex_distance(tile, other) for other in obstacles) < 2:
            return False
        next_blocking = set(bases) | obstacles | {tile}
        return connected_without_choke_points(cells, next_blocking)

    candidates = cells[:]
    rng.shuffle(candidates)
    for tile in candidates:
        if len(obstacles) >= OBSTACLE_TARGET:
            break
        if scatter_is_valid(tile):
            obstacles.add(tile)

    if len(obstacles) < OBSTACLE_TARGET:
        relaxed = cells[:]
        rng.shuffle(relaxed)
        for tile in relaxed:
            if len(obstacles) >= OBSTACLE_TARGET:
                break
            if tile in protected or tile in obstacles or too_close_to_protected(tile):
                continue
            if connected_without_choke_points(cells, set(bases) | obstacles | {tile}):
                obstacles.add(tile)

    return obstacles, wall_segments


def render_images(payload, features):
    cells = [tuple(tile["coord"]) for tile in payload["tiles"]]
    size = 32
    margin = 86
    header = 96
    centers = {c: (size * math.sqrt(3) * (c[0] + c[1] / 2), size * 1.5 * c[1]) for c in cells}
    min_x = min(p[0] for p in centers.values())
    max_x = max(p[0] for p in centers.values())
    min_y = min(p[1] for p in centers.values())
    max_y = max(p[1] for p in centers.values())
    width = int(max_x - min_x + size * math.sqrt(3) + margin * 2)
    height = int(max_y - min_y + size * 2 + margin * 2 + header)

    def shifted(c):
        x, y = centers[c]
        return (x - min_x + margin + size * math.sqrt(3) / 2, y - min_y + margin + header + size)

    def hex_points(cx, cy):
        return [
            (cx + size * math.cos(math.radians(60 * i - 30)), cy + size * math.sin(math.radians(60 * i - 30)))
            for i in range(6)
        ]

    font_regular = "C:/Windows/Fonts/arial.ttf"
    font_bold = "C:/Windows/Fonts/arialbd.ttf"
    title_font = ImageFont.truetype(font_bold, 28)
    subtitle_font = ImageFont.truetype(font_regular, 15)
    label_font = ImageFont.truetype(font_regular, 9)
    small_font = ImageFont.truetype(font_regular, 11)
    legend_font = ImageFont.truetype(font_bold, 12)

    palettes = {
        "light": {
            "bg": "#f4f8fd",
            "floor": "#dbeaf7",
            "axis": "#c9e3f8",
            "grid": "#6a7f9a",
            "text": "#142033",
            "muted": "#5b6c80",
            "obstacle": "#3d4652",
            "bunker": "#f1c65b",
            "base_i": "#4d96ff",
            "base_ii": "#f06464",
            "spawn_i": "#b9dcff",
            "spawn_ii": "#ffd0d0",
            "panel": "#ffffff",
        },
        "dark": {
            "bg": "#080d14",
            "floor": "#101b28",
            "axis": "#15283b",
            "grid": "#2c425b",
            "text": "#e7f0fb",
            "muted": "#8fa4bb",
            "obstacle": "#27313d",
            "bunker": "#8d6b24",
            "base_i": "#1f5fa8",
            "base_ii": "#98363e",
            "spawn_i": "#163657",
            "spawn_ii": "#4b2227",
            "panel": "#101923",
        },
    }

    def draw_map(mode):
        p = palettes[mode]
        image = Image.new("RGB", (width, height), p["bg"])
        draw = ImageDraw.Draw(image)
        draw.text((margin, 26), f"Training Arena 001 - {mode.capitalize()} Map", fill=p["text"], font=title_font)
        draw.text(
            (margin, 61),
            f"Shorter, wider-spaced walls | {len(cells)} cells | view radius {payload['radius_of_view']}",
            fill=p["muted"],
            font=subtitle_font,
        )

        for c in cells:
            f = features[c]
            fill = p["floor"]
            if c[0] == 0 or c[1] == 0 or c[0] + c[1] == 0:
                fill = p["axis"]
            if f["type"] == "spawn":
                fill = p["spawn_i"] if f.get("team") == "Team I" else p["spawn_ii"]
            elif f["type"] == "bunker":
                fill = p["bunker"]
            elif f["type"] == "obstacle":
                fill = p["obstacle"]
            elif f["type"] == "base":
                fill = p["base_i"] if f.get("team") == "Team I" else p["base_ii"]
            draw.polygon(hex_points(*shifted(c)), fill=fill, outline=p["grid"])

        for c in cells:
            cx, cy = shifted(c)
            f = features[c]
            label_color = "#ffffff" if f["type"] in ("obstacle", "base") else p["text"]
            text = f"{c[0]},{c[1]}"
            box = draw.textbbox((0, 0), text, font=label_font)
            draw.text((cx - (box[2] - box[0]) / 2, cy - 2), text, fill=label_color, font=label_font)
            symbol = ""
            if f["type"] == "base":
                symbol = "BASE"
            elif f["type"] == "bunker":
                symbol = "+300"
            elif f["type"] == "obstacle":
                symbol = "X"
            if symbol:
                sbox = draw.textbbox((0, 0), symbol, font=small_font)
                draw.text((cx - (sbox[2] - sbox[0]) / 2, cy + 9), symbol, fill=label_color, font=small_font)

        lx, ly = width - 292, 26
        draw.rounded_rectangle((lx, ly, width - margin, ly + 130), radius=8, fill=p["panel"], outline=p["grid"])
        legend = [
            ("Team I Base", p["base_i"]),
            ("Team II Base", p["base_ii"]),
            ("Spawn/Respawn", p["spawn_i"]),
            ("Bunker armor +300", p["bunker"]),
            ("Blocking obstacle", p["obstacle"]),
        ]
        draw.text((lx + 14, ly + 12), "Legend", fill=p["text"], font=legend_font)
        for idx, (label, color) in enumerate(legend):
            y = ly + 34 + idx * 18
            draw.rectangle((lx + 14, y + 2, lx + 26, y + 14), fill=color, outline=p["grid"])
            draw.text((lx + 34, y), label, fill=p["muted"], font=small_font)
        return image

    draw_map("light").save(LIGHT_IMAGE)
    draw_map("dark").save(DARK_IMAGE)


def main():
    worksheet, fields = load_map_fields()
    existing = json.loads(PUBLIC_MAP.read_text(encoding="utf-8")) if PUBLIC_MAP.exists() else {}
    vertices = parse_coords(fields["vertex_coordinates"])
    cells = build_cells(vertices)
    cell_set = set(cells)
    base_i = parse_coords(fields["special_tiles_1"])[0]
    base_ii = parse_coords(fields["special_tiles_2"])[0]
    spawn_i = neighbors(base_i, cell_set)
    spawn_ii = neighbors(base_ii, cell_set)
    bases = [base_i, base_ii]
    spawns = spawn_i + spawn_ii
    old_bunkers = [tuple(item["coord"]) for item in existing.get("bunkers", [])]
    bunkers = old_bunkers if len(old_bunkers) == 15 else []

    if not bunkers:
        rng = random.Random(1001)
        candidates = [c for c in cells if c not in set(bases + spawns) and all(hex_distance(c, b) > 2 for b in bases)]
        rng.shuffle(candidates)
        for c in candidates:
            if all(hex_distance(c, b) >= 3 for b in bunkers):
                bunkers.append(c)
            if len(bunkers) == 15:
                break

    obstacles, wall_segments = generate_obstacles(cells, bases, spawns, bunkers)

    features = {c: {"type": "floor", "blocking": False} for c in cells}
    for c in obstacles:
        features[c] = {"type": "obstacle", "blocking": True, "description": "short wall/scatter obstacle"}
    for c in bunkers:
        features[c] = {
            "type": "bunker",
            "blocking": False,
            "armor_bonus": 300,
            "description": "bunker: unit armor +300 while standing here",
        }
    features[base_i] = {
        "type": "base",
        "team": "Team I",
        "blocking": True,
        "max_HP": 10000,
        "armor": 1500,
        "defeat_condition": "Team I loses when destroyed",
    }
    features[base_ii] = {
        "type": "base",
        "team": "Team II",
        "blocking": True,
        "max_HP": 10000,
        "armor": 1500,
        "defeat_condition": "Team II loses when destroyed",
    }
    for c in spawn_i:
        if features[c]["type"] == "floor":
            features[c] = {"type": "spawn", "team": "Team I", "blocking": False, "also_respawn": True}
    for c in spawn_ii:
        if features[c]["type"] == "floor":
            features[c] = {"type": "spawn", "team": "Team II", "blocking": False, "also_respawn": True}

    mission = existing.get(
        "mission",
        {
            "type": "destroy_enemy_base",
            "objective": "摧毁对方主基地",
            "summary": fields.get("description", ""),
        },
    )
    victory_conditions = existing.get(
        "victory_conditions",
        {
            "Team I": [{"type": "destroy_base", "target_team": "Team II", "target_coord": list(base_ii)}],
            "Team II": [{"type": "destroy_base", "target_team": "Team I", "target_coord": list(base_i)}],
        },
    )
    defeat_conditions = existing.get(
        "defeat_conditions",
        {
            "Team I": [{"type": "own_base_destroyed", "base_coord": list(base_i)}],
            "Team II": [{"type": "own_base_destroyed", "base_coord": list(base_ii)}],
        },
    )

    payload = {
        "map_ID": str(fields.get("map_ID", "001")).zfill(3),
        "name": str(fields.get("name", "Training Arena")),
        "description": str(fields.get("description", "")),
        "mission": mission,
        "victory_conditions": victory_conditions,
        "defeat_conditions": defeat_conditions,
        "source_files": {"main_docx": "main.docx", "map_xlsx": "map_data.xlsx", "worksheet": worksheet},
        "vertex_coordinates": vertices,
        "terrain_prompt": str(fields.get("terrain_prompt", "")),
        "coordinate_system": "axial pointy-top (q,r)",
        "cell_count": len(cells),
        "radius_of_view": int(fields.get("radius of view", 5)),
        "generation": {
            "seed": SEED,
            "bunker_count": len(bunkers),
            "obstacle_count": len(obstacles),
            "obstacle_target": OBSTACLE_TARGET,
            "wall_lengths": WALL_LENGTHS,
            "wall_spacing_min_distance": 3,
            "passage_rule": "open-tile graph remains connected with no single-tile articulation choke points",
        },
        "team_bases": {
            "Team I": {"coord": list(base_i), "max_HP": 10000, "armor": 1500},
            "Team II": {"coord": list(base_ii), "max_HP": 10000, "armor": 1500},
        },
        "spawn_tiles": {"Team I": [list(c) for c in spawn_i], "Team II": [list(c) for c in spawn_ii]},
        "respawn_tiles": {"Team I": [list(c) for c in spawn_i], "Team II": [list(c) for c in spawn_ii]},
        "respawn_rounds": {
            "Team I": int(fields.get("Team_I_respawn_round", 3)),
            "Team II": int(fields.get("Team_II_respawn_round", 3)),
        },
        "bunkers": [{"coord": list(c), "armor_bonus": 300} for c in sorted(bunkers)],
        "obstacles": [{"coord": list(c), "blocking": True} for c in sorted(obstacles)],
        "wall_segments": [{"id": item["id"], "tiles": [list(c) for c in item["tiles"]]} for item in wall_segments],
        "treasure_chests": existing.get("treasure_chests", {}),
        "tiles": [dict({"coord": list(c)}, **features[c]) for c in sorted(cells)],
    }

    PUBLIC_MAP.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_MAP.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    REFERENCE_MAP.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    render_images(payload, features)
    print(f"cells={len(cells)} bunkers={len(bunkers)} obstacles={len(obstacles)}")
    print(f"walls={[len(item['tiles']) for item in wall_segments]}")


if __name__ == "__main__":
    main()
