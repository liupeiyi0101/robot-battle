import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "public" / "data" / "game-data.json"
CARD_DIR = ROOT / "card_images"
ART_DIR = CARD_DIR / "generated_art"

CARD_W = 300
CARD_H = 400
ART_BOX = (20, 78, 280, 316)
TEXT_BOX = (18, 328, 282, 386)


def font(size, bold=False):
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
FONT_LABEL = font(18, True)
FONT_BODY = font(20, False)
FONT_BODY_SMALL = font(18, False)


def load_cards():
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return data["unit_data.xlsx"]["Attack_card_list"]


def text_size(draw, text, text_font):
    box = draw.textbbox((0, 0), text, font=text_font)
    return box[2] - box[0], box[3] - box[1]


def centered_text(draw, y, text, text_font, fill, x0=0, x1=CARD_W):
    width, _ = text_size(draw, text, text_font)
    draw.text(((x0 + x1 - width) / 2, y), text, font=text_font, fill=fill)


def fit_text(draw, text, max_width, preferred, minimum=14):
    for size in range(preferred, minimum - 1, -1):
        candidate = font(size, False)
        if text_size(draw, text, candidate)[0] <= max_width:
            return candidate
    return font(minimum, False)


def rounded_box(draw, box, radius, fill, outline, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def art_candidates(card_id):
    return [
        ART_DIR / f"attack_{card_id}_special_mecha.png",
        ART_DIR / f"attack_{card_id}_weapon_only.png",
        ART_DIR / f"attack_{card_id}_anime.png",
        ART_DIR / f"attack_{card_id}_art.png",
    ]


def cover_image(source, size):
    target_w, target_h = size
    image = source.convert("RGB")
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def synthetic_missile_art(size):
    width, height = size
    image = Image.new("RGB", size, "#10131b")
    draw = ImageDraw.Draw(image)
    for y in range(height):
        r = int(14 + 42 * y / height)
        g = int(18 + 20 * y / height)
        b = int(28 + 8 * y / height)
        draw.line((0, y, width, y), fill=(r, g, b))
    for offset in range(-80, width + 80, 24):
        draw.line((offset, height, offset + 120, 0), fill=(255, 120, 32), width=1)
    for radius, alpha_color in [(82, "#452015"), (58, "#7c2b10"), (34, "#ff7a22"), (18, "#ffe681")]:
        draw.ellipse((width - 52 - radius, height // 2 - radius, width - 52 + radius, height // 2 + radius), outline=alpha_color, width=5)

    body = [(32, height // 2 - 22), (146, height // 2 - 38), (216, height // 2), (146, height // 2 + 38), (32, height // 2 + 22)]
    draw.polygon(body, fill="#2c323a", outline="#d7dee8")
    draw.polygon([(170, height // 2 - 26), (216, height // 2), (170, height // 2 + 26)], fill="#111820", outline="#f2c46c")
    draw.polygon([(66, height // 2 - 22), (36, height // 2 - 62), (98, height // 2 - 30)], fill="#4a5662", outline="#d7dee8")
    draw.polygon([(66, height // 2 + 22), (36, height // 2 + 62), (98, height // 2 + 30)], fill="#4a5662", outline="#d7dee8")
    draw.line((58, height // 2 - 4, 178, height // 2 - 18), fill="#9099a3", width=3)
    draw.line((58, height // 2 + 4, 178, height // 2 + 18), fill="#161a20", width=3)
    draw.ellipse((20, height // 2 - 28, 72, height // 2 + 28), fill="#0c1016", outline="#89939e", width=3)
    draw.ellipse((24, height // 2 - 16, 58, height // 2 + 16), fill="#ff7a22")
    draw.ellipse((30, height // 2 - 8, 50, height // 2 + 8), fill="#ffe681")
    return image


def is_blank_art(image):
    grayscale = image.convert("L")
    stat = grayscale.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    return stat < 24


def load_art(card_id, current_card_path):
    for path in art_candidates(card_id):
        if path.exists():
            return cover_image(Image.open(path), (ART_BOX[2] - ART_BOX[0], ART_BOX[3] - ART_BOX[1]))
    current = Image.open(current_card_path).convert("RGB")
    crop = current.crop(ART_BOX)
    if is_blank_art(crop):
        return synthetic_missile_art((ART_BOX[2] - ART_BOX[0], ART_BOX[3] - ART_BOX[1]))
    return crop


def format_percent(value):
    number = float(value)
    percent = number * 100
    if abs(percent - round(percent)) < 0.001:
        return f"{int(round(percent))}%"
    return f"{percent:.0f}%"


def ratio_text(card):
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


def range_text(card):
    min_range = card.get("min_range") or "-"
    max_range = card.get("max_range") or "-"
    if str(min_range) == str(max_range):
        return f"射程{min_range}"
    return f"射程{min_range}-{max_range}"


def card_lines(card):
    damage = card.get("damage") or "-"
    aoe = card.get("AOE_radius")
    aoe_value = int(float(aoe)) if aoe not in ("", None) else 0
    if aoe_value <= 0:
        return [f"{range_text(card)}  威力{damage}  无AOE"]
    return [f"{range_text(card)}  威力{damage}  AOE{aoe_value}", f"分层{ratio_text(card)}"]


def draw_frame(draw, card):
    rounded_box(draw, (6, 7, 294, 393), 12, "#11141b", "#ff4040", 2)
    rounded_box(draw, (10, 13, 80, 39), 5, "#15191f", "#ff4040", 1)
    rounded_box(draw, (220, 13, 290, 39), 5, "#15191f", "#ff4040", 1)
    draw.text((24, 19), f"EN  {card.get('EN_cost') or 0}", font=FONT_TOP, fill="#f4f7f9")
    draw.text((236, 19), f"CD  {card.get('CD') or 0}", font=FONT_TOP, fill="#f4f7f9")

    draw.rounded_rectangle(ART_BOX, radius=8, fill="#0a0d12")
    rounded_box(draw, TEXT_BOX, 6, "#edf4f8", "#ff4040", 2)


def draw_art_frame(draw, card):
    special = str(card.get("If_special") or "").lower() == "yes"
    art_outline = "#f3da58" if special else "#e8f0f8"
    draw.rounded_rectangle(ART_BOX, radius=8, outline=art_outline, width=2)
    for inset, color in [(3, "#0c1119"), (5, "#e8f0f8")]:
        box = (ART_BOX[0] + inset, ART_BOX[1] + inset, ART_BOX[2] - inset, ART_BOX[3] - inset)
        draw.rounded_rectangle(box, radius=6, outline=color, width=1)


def draw_card(card):
    card_id = str(card.get("A_card_ID") or "").zfill(3)
    output_rel = str(card.get("card_picture") or "").replace("\\", "/")
    if not output_rel:
        return None
    output = ROOT / output_rel
    if not output.exists():
        return None

    image = Image.new("RGBA", (CARD_W, CARD_H), "#0b0d12")
    draw = ImageDraw.Draw(image)
    draw_frame(draw, card)

    art = load_art(card_id, output).convert("RGBA")
    image.alpha_composite(art, (ART_BOX[0], ART_BOX[1]))

    draw = ImageDraw.Draw(image)
    draw_art_frame(draw, card)
    mr = str(card.get("M/R") or "").strip().lower() or "-"
    centered_text(draw, 19, mr, FONT_TOP, "#d8f4ff", x0=82, x1=218)

    title = str(card.get("name") or card_id)
    title_font = fit_text(draw, title, 232, 25, 18)
    centered_text(draw, 50, title, title_font, "#f4f7f9")

    lines = card_lines(card)
    max_width = TEXT_BOX[2] - TEXT_BOX[0] - 24
    first_font = fit_text(draw, lines[0], max_width, 20, 15)
    y = TEXT_BOX[1] + (18 if len(lines) == 1 else 9)
    draw.text((TEXT_BOX[0] + 12, y), lines[0], font=first_font, fill="#15202a")
    if len(lines) > 1:
        second_font = fit_text(draw, lines[1], max_width, 19, 14)
        draw.text((TEXT_BOX[0] + 12, TEXT_BOX[1] + 33), lines[1], font=second_font, fill="#15202a")

    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    return output


def main():
    written = []
    for card in load_cards():
        output = draw_card(card)
        if output:
            written.append(output)
    print(f"generated {len(written)} attack card images")
    for output in written:
        print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
