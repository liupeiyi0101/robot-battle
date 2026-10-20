from __future__ import annotations

import shutil
from pathlib import Path

from create_generated_attack_cards import ART_DIR, ROOT, draw_card, load_cards


GENERATED_ART = {
    "053": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd2de927c81919ecbe9c28f5a257e.png",
    "054": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd36199a4819192afc787c1b963d3.png",
    "055": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd3cd6db481919bbe9d8c60bc65a8.png",
    "056": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd442a9a0819180d009abb2478c40.png",
    "057": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd4c1443c8191b1bdbb0de47b7796.png",
    "058": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd577a4a08191885023cc9b6cb2dc.png",
    "059": r"C:\Users\admin\.codex\generated_images\019e7999-8c26-7001-86a6-5a1559e80a7c\ig_025c3d13f606c4bd016a2cd6fe31e881919dfc5863cdaeea18.png",
}


def main() -> None:
    cards = load_cards()
    ART_DIR.mkdir(parents=True, exist_ok=True)

    for card_id, source in GENERATED_ART.items():
        card = cards[card_id]
        source_path = Path(source)
        art_copy = ART_DIR / f"attack_{card_id}_special_art.png"
        shutil.copy2(source_path, art_copy)

        output = ROOT / str(card["card_picture"]).replace("\\", "/")
        draw_card(card, art_copy, output)
        print(f"{card_id}: {card['name']} -> {output}")


if __name__ == "__main__":
    main()
