"""Refresh the paired-video catalog and its version in the page."""

import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


def video_pair(folder, name):
    base = f"data/videos/{name}"
    pair = {"name": f"Video {int(name[5:])}"}
    source_file = folder / "source.json"
    scene_id = None
    if source_file.is_file():
        source = json.loads(source_file.read_text(encoding="utf-8"))
        if not isinstance(source, dict):
            raise ValueError(f"{source_file}: expected a JSON object")
        enabled = source.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"{source_file}: enabled must be true or false")
        for kind in ("input", "point"):
            url = source.get(kind)
            parsed = urlsplit(url) if isinstance(url, str) else None
            if not parsed or parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError(f"{source_file}: {kind} requires an absolute HTTP(S) URL")
            pair[kind] = url
        if not enabled:
            return None
        scene_id = source.get("scene_id")
    else:
        input_video = folder / "input_view.mp4"
        if not input_video.is_file():
            input_video = folder / "input_video.mp4"
        point = folder / "point.mp4"
        if not input_video.is_file() or not point.is_file():
            print(f"Skipping {name}: incomplete video pair", file=sys.stderr)
            return None
        pair.update(input=f"{base}/{input_video.name}", point=f"{base}/{point.name}")

    for kind in ("input", "point"):
        poster = folder / f"{kind}-poster.jpg"
        if poster.is_file():
            url = f"{base}/{poster.name}"
            if scene_id:
                digest = hashlib.sha256(poster.read_bytes()).hexdigest()[:10]
                url += f"?v={digest}"
            pair[f"{kind}Poster"] = url
    return pair


def build_catalog(root, replacements=None):
    """Generate the catalog, reading staged video folders when supplied."""
    folders = {p.name: p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"video[0-9]+", p.name)}
    if replacements:
        folders.update(replacements)
    pairs = []
    for name in sorted(folders, key=lambda name: (int(name[5:]), name)):
        pair = video_pair(folders[name], name)
        if pair is not None:
            pairs.append(pair)
    return "window.loftVideoPairs = " + json.dumps(pairs, indent=2) + ";\n", len(pairs)


def versioned_index(html, catalog_text):
    version = hashlib.sha256(catalog_text.encode("utf-8")).hexdigest()[:10]
    script = r"""(<script\b[^>]*?\bsrc\s*=\s*["']data/videos/catalog\.js)(?:\?v=[^"']*)?(["'])"""
    result, count = re.subn(script, lambda m: f"{m[1]}?v={version}{m[2]}", html)
    if count != 1:
        raise ValueError("Expected one data/videos/catalog.js script in index.html")
    return result


def main():
    root = Path(__file__).resolve().parent
    catalog, count = build_catalog(root)
    index = root.parents[1] / "index.html"
    html = index.read_text(encoding="utf-8") if index.is_file() else None
    updated = versioned_index(html, catalog) if html is not None else None
    (root / "catalog.js").write_text(catalog, encoding="utf-8")
    if updated != html:
        index.write_text(updated, encoding="utf-8")
    print(f"Indexed {count} video pairs.")


if __name__ == "__main__":
    main()
