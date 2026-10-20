from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from update_card_image_text import clear_and_draw_common, draw_attack_text


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "public" / "data" / "game-data.json"
ART_DIR = ROOT / "temp" / "generated_card_art"

CARD_W = 300
CARD_H = 400
ART_BOX = (20, 79, 280, 307)
ART_INNER = (23, 82, 277, 304)
ATTACK_RED = "#ff4040"


GENERATED_ART = {
    "020": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b4189d7ec81919c7d864042adc38a.png",
    "021": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b41f041008191a9ad874e5338ccc3.png",
    "022": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b4236edb881919f444e818683665f.png",
    "023": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b429010008191a0bf89a818162a01.png",
    "024": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b42c8f6bc8191821fdb85f72a7646.png",
    "025": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2b435b76508191a7f3276911a23728.png",
}


def load_cards() -> dict[str, dict[str, Any]]:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    rows = data["unit_data.xlsx"]["Attack_card_list"]
    return {str(card.get("A_card_ID")).zfill(3): card for card in rows}


def fit_cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    source_w, source_h = image.size
    scale = max(target_w / source_w, target_h / source_h)
    resized = image.resize((round(source_w * scale), round(source_h * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def draw_card(card: dict[str, Any], art_path: Path, out_path: Path) -> None:
    image = Image.new("RGBA", (CARD_W, CARD_H), "#0c1118")
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((4, 5, 296, 397), radius=13, fill="#0f141c", outline=ATTACK_RED, width=2)
    draw.rounded_rectangle((8, 9, 292, 393), radius=9, outline=ATTACK_RED, width=1)

    art = Image.open(art_path).convert("RGBA")
    art = fit_cover(art, (ART_INNER[2] - ART_INNER[0], ART_INNER[3] - ART_INNER[1]))
    image.alpha_composite(art, ART_INNER[:2])

    draw.rounded_rectangle(ART_BOX, radius=6, outline="#f4f7f9", width=2)
    draw.rounded_rectangle((ART_BOX[0] + 2, ART_BOX[1] + 2, ART_BOX[2] - 2, ART_BOX[3] - 2), radius=4, outline="#3a4550", width=1)

    clear_and_draw_common(draw, card, "attack")
    draw_attack_text(draw, card)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(out_path)


def main() -> None:
    cards = load_cards()
    ART_DIR.mkdir(parents=True, exist_ok=True)

    for card_id, source in GENERATED_ART.items():
        card = cards[card_id]
        source_path = Path(source)
        art_copy = ART_DIR / f"attack_{card_id}_art.png"
        shutil.copy2(source_path, art_copy)

        output = ROOT / str(card["card_picture"]).replace("\\", "/")
        draw_card(card, art_copy, output)
        print(f"{card_id}: {card['name']} -> {output}")


if __name__ == "__main__":
    main()
