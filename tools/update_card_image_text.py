from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "public" / "data" / "game-data.json"

CARD_W = 300
CARD_H = 400
TOP_LEFT_BOX = (10, 13, 80, 39)
TOP_RIGHT_BOX = (220, 13, 290, 39)
TITLE_CLEAR_BOX = (16, 43, 284, 78)
TEXT_BOX = (18, 328, 282, 386)

TYPE_COLORS = {
    "attack": "#ff4040",
    "defense": "#4aa6ff",
    "utility": "#49e58a",
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


FONT_TOP = font(17, True)
FONT_TITLE = font(25, True)


def text_size(draw: ImageDraw.ImageDraw, text: str, text_font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=text_font)
    return box[2] - box[0], box[3] - box[1]


def format_value(value: Any, default: str = "0") -> str:
    if value in ("", None):
        return default
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def format_percent(value: Any) -> str:
    number = float(value)
    percent = number * 100
    if abs(percent - round(percent)) < 0.001:
        return f"{int(round(percent))}%"
    return f"{percent:.0f}%"


def ratio_text(card: dict[str, Any]) -> str:
    ratios = []
    for item in str(card.get("damage ratio") or "1.0").split("/"):
        item = item.strip()
        if not item:
            continue
        try:
            ratios.append(format_percent(item))
        except ValueError:
            ratios.append(item)
    return "/".join(ratios) if ratios else "100%"


def range_text(card: dict[str, Any]) -> str:
    min_range = format_value(card.get("min_range"), "-")
    max_range = format_value(card.get("max_range"), "-")
    if min_range == max_range:
        return f"射程{min_range}"
    return f"射程{min_range}-{max_range}"


def attack_lines(card: dict[str, Any]) -> list[str]:
    damage = format_value(card.get("damage"), "-")
    aoe = card.get("AOE_radius")
    aoe_value = int(float(aoe)) if aoe not in ("", None) else 0
    if aoe_value <= 0:
        return [f"{range_text(card)}  威力{damage}  无AOE"]
    return [f"{range_text(card)}  威力{damage}  AOE{aoe_value}", f"分层{ratio_text(card)}"]


def text_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isascii() and (char.isalnum() or char in ".+-/%*×()"):
            start = index
            index += 1
            while index < len(text) and text[index].isascii() and (text[index].isalnum() or text[index] in ".+-/%*×()"):
                index += 1
            tokens.append(text[start:index])
        else:
            tokens.append(char)
            index += 1
    return tokens


def wrap_chars(draw: ImageDraw.ImageDraw, text: str, text_font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for token in text_tokens(text):
        candidate = current + token
        if current and text_size(draw, candidate, text_font)[0] > max_width:
            lines.append(current)
            current = token
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def fit_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    max_width: int,
    max_lines: int = 2,
    preferred: int = 20,
    minimum: int = 13,
) -> tuple[ImageFont.ImageFont, list[str]]:
    normalized = " ".join(str(text or "").split())
    for size in range(preferred, minimum - 1, -1):
        candidate_font = font(size)
        lines = wrap_chars(draw, normalized, candidate_font, max_width)
        if len(lines) <= max_lines:
            return candidate_font, lines

    candidate_font = font(minimum)
    lines = wrap_chars(draw, normalized, candidate_font, max_width)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        ellipsis = "..."
        while lines[-1] and text_size(draw, lines[-1] + ellipsis, candidate_font)[0] > max_width:
            lines[-1] = lines[-1][:-1]
        lines[-1] += ellipsis
    return candidate_font, lines


def fit_text(draw: ImageDraw.ImageDraw, text: str, max_width: int, preferred: int, minimum: int) -> ImageFont.ImageFont:
    for size in range(preferred, minimum - 1, -1):
        candidate = font(size, True)
        if text_size(draw, text, candidate)[0] <= max_width:
            return candidate
    return font(minimum, True)


def centered_text(
    draw: ImageDraw.ImageDraw,
    y: int,
    text: str,
    text_font: ImageFont.ImageFont,
    fill: str,
    x0: int = 0,
    x1: int = CARD_W,
) -> None:
    width, _ = text_size(draw, text, text_font)
    draw.text(((x0 + x1 - width) / 2, y), text, font=text_font, fill=fill)


def card_path(card: dict[str, Any]) -> Path | None:
    raw = str(card.get("card_picture") or "").replace("\\", "/")
    if not raw:
        return None
    path = ROOT / raw
    return path if path.exists() else None


def clear_and_draw_common(draw: ImageDraw.ImageDraw, card: dict[str, Any], card_type: str) -> None:
    color = TYPE_COLORS[card_type]
    draw.rounded_rectangle(TOP_LEFT_BOX, radius=5, fill="#15191f", outline=color, width=1)
    draw.rounded_rectangle(TOP_RIGHT_BOX, radius=5, fill="#15191f", outline=color, width=1)
    draw.text((24, 19), f"EN  {format_value(card.get('EN_cost'))}", font=FONT_TOP, fill="#f4f7f9")
    draw.text((236, 19), f"CD  {format_value(card.get('CD'))}", font=FONT_TOP, fill="#f4f7f9")

    draw.rectangle(TITLE_CLEAR_BOX, fill="#11141b")
    title = str(card.get("name") or "")
    title_font = fit_text(draw, title, 232, 25, 18)
    centered_text(draw, 50, title, title_font, "#f4f7f9")

    draw.rectangle((14, 318, 286, 390), fill="#11141b")
    draw.rounded_rectangle(TEXT_BOX, radius=6, fill="#edf4f8", outline=color, width=2)


def draw_attack_text(draw: ImageDraw.ImageDraw, card: dict[str, Any]) -> None:
    mr = str(card.get("M/R") or "").strip().lower() or "-"
    centered_text(draw, 19, mr, FONT_TOP, "#d8f4ff", x0=82, x1=218)

    lines = attack_lines(card)
    max_width = TEXT_BOX[2] - TEXT_BOX[0] - 24
    first_font, first_lines = fit_lines(draw, lines[0], max_width, max_lines=1, preferred=20, minimum=14)
    if len(lines) == 1:
      y = TEXT_BOX[1] + 18
      draw.text((TEXT_BOX[0] + 12, y), first_lines[0], font=first_font, fill="#15202a")
      return

    draw.text((TEXT_BOX[0] + 12, TEXT_BOX[1] + 9), first_lines[0], font=first_font, fill="#15202a")
    second_font, second_lines = fit_lines(draw, lines[1], max_width, max_lines=1, preferred=19, minimum=13)
    draw.text((TEXT_BOX[0] + 12, TEXT_BOX[1] + 33), second_lines[0], font=second_font, fill="#15202a")


def draw_description_text(draw: ImageDraw.ImageDraw, card: dict[str, Any]) -> None:
    text = str(card.get("description") or card.get("effect") or "")
    max_width = TEXT_BOX[2] - TEXT_BOX[0] - 24
    text_font, lines = fit_lines(draw, text, max_width, max_lines=2, preferred=17, minimum=12)
    line_height = max(20, text_size(draw, "国", text_font)[1] + 7)
    block_height = line_height * len(lines)
    y = TEXT_BOX[1] + max(12, (TEXT_BOX[3] - TEXT_BOX[1] - block_height) // 2 + 3)
    for line in lines:
        draw.text((TEXT_BOX[0] + 12, y), line, font=text_font, fill="#15202a")
        y += line_height


def update_card(card: dict[str, Any], card_type: str) -> Path | None:
    path = card_path(card)
    if not path:
        return None
    image = Image.open(path).convert("RGBA")
    draw = ImageDraw.Draw(image)
    clear_and_draw_common(draw, card, card_type)
    if card_type == "attack":
        draw_attack_text(draw, card)
    else:
        draw_description_text(draw, card)
    image.save(path)
    return path


def load_game_data() -> dict[str, Any]:
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def main() -> None:
    data = load_game_data()["unit_data.xlsx"]
    groups = [
        ("attack", data.get("Attack_card_list", [])),
        ("defense", data.get("Defense_card_list", [])),
        ("utility", data.get("Utility_card_list", [])),
    ]
    written = []
    for card_type, cards in groups:
        for card in cards:
            if not card.get("name"):
                continue
            path = update_card(card, card_type)
            if path:
                written.append(path.relative_to(ROOT))

    print(f"updated {len(written)} card images")
    for path in written:
        print(path)


if __name__ == "__main__":
    main()
