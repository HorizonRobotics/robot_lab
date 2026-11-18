"""Refresh catalog.js after adding or removing video folders. Python 3 only."""

import json
from pathlib import Path
import re
import sys


def main():
    root = Path(__file__).resolve().parent
    scenes = []
    for folder in root.iterdir():
        match = re.fullmatch(r"video([0-9]+)", folder.name)
        if match and folder.is_dir():
            scenes.append((int(match.group(1)), folder))

    pairs = []
    for number, folder in sorted(scenes):
        input_video = folder / "input_view.mp4"
        if not input_video.is_file():
            input_video = folder / "input_video.mp4"
        point = folder / "point.mp4"
        if not input_video.is_file() or not point.is_file():
            print(f"Skipping {folder.name}: incomplete video pair", file=sys.stderr)
            continue
        pair = {
            "name": f"Video {number}",
            "input": f"data/videos/{folder.name}/{input_video.name}",
            "point": f"data/videos/{folder.name}/{point.name}",
        }
        for kind in ("input", "point"):
            poster = folder / f"{kind}-poster.jpg"
            if poster.is_file():
                pair[f"{kind}Poster"] = f"data/videos/{folder.name}/{poster.name}"
        pairs.append(pair)

    catalog = "window.loftVideoPairs = " + json.dumps(pairs, indent=2) + ";\n"
    (root / "catalog.js").write_text(catalog, encoding="utf-8")
    print(f"Indexed {len(pairs)} video pairs.")


if __name__ == "__main__":
    main()
