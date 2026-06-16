"""Generate square Chrome extension icons with center crop (no stretch)."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = ROOT / "extension" / "icons"
DEFAULT_SOURCE = ICONS_DIR / "icon-source.png"
SIZES = (16, 32, 48, 128)


def cover_square(image: Image.Image, size: int) -> Image.Image:
    image = image.convert("RGBA")
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    cropped = image.crop((left, top, left + side, top + side))
    return cropped.resize((size, size), Image.Resampling.LANCZOS)


def write_icons(source: Path) -> None:
    image = Image.open(source)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        cover_square(image, size).save(ICONS_DIR / f"icon{size}.png")


def main() -> int:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.is_file():
        print(f"Source image not found: {source}", file=sys.stderr)
        return 1
    write_icons(source)
    print(f"Wrote icons to {ICONS_DIR} from {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
