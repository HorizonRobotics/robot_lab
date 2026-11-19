"""Package the LoFT static site and the media referenced by its catalogs."""

import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    site = Path(__file__).resolve().parent
    files = {site / "index.html"}
    files.update(p for p in (site / "assets").rglob("*") if p.is_file() and not p.name.startswith("."))

    def local_asset(base, url):
        if not url:
            return None
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc:
            return None  # The deployed page will fetch remote media directly.
        path = (base / unquote(parsed.path)).resolve()
        if not path.is_relative_to(site) or not path.is_file():
            raise ValueError(f"Missing or non-local site asset: {url}")
        return path

    videos = site / "data/videos/catalog.js"
    files.add(videos)
    # Hiding a video with whole-line JS comments can leave a trailing array comma.
    catalog = "\n".join(line for line in videos.read_text().splitlines()
                        if not line.lstrip().startswith("//"))
    array = catalog.split("=", 1)[1].strip().removesuffix(";")
    pairs = json.loads(re.sub(r",\s*\]\s*$", "]", array))
    for pair in pairs:
        for key in ("input", "point", "inputPoster", "pointPoster"):
            path = local_asset(site, pair.get(key))
            if path:
                files.add(path)

    manifest = site / "data/demos/manifest.json"
    files.add(manifest)
    for entry in json.loads(manifest.read_text())["sequences"]:
        scene = set()
        if entry.get("source"):
            index = local_asset(manifest.parent, entry["source"])
            if index:
                scene.add(index)
                clip = json.loads(index.read_text())
                urls = [clip.get("cloud"), clip.get("globalCloud")]
                urls.extend(frame.get(key) for frame in clip["frames"]
                            for key in ("rgbd", "cloud", "rgb", "depth", "confidence"))
                scene.update(path for url in urls if (path := local_asset(index.parent, url)))
        else:
            urls = [*entry["frames"], entry.get("globalCloud")]
            scene.update(path for url in urls if (path := local_asset(manifest.parent, url)))
        size = sum(path.stat().st_size for path in scene)
        print(f"{entry.get('title') or entry.get('source') or 'Scene'}: {size:,} local bytes")
        files.update(scene)

    output = site.with_name("loft-pages.zip")
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as f:
        temp = Path(f.name)
    try:
        with ZipFile(temp, "w", compression=ZIP_DEFLATED, compresslevel=1) as archive:
            for path in sorted(files):
                archive.write(path, path.relative_to(site))
        os.replace(temp, output)
    finally:
        temp.unlink(missing_ok=True)
    size = sum(path.stat().st_size for path in files)
    print(f"{output}: {len(files)} files, {size:,} bytes unpacked, {output.stat().st_size:,} bytes zipped")


if __name__ == "__main__":
    main()
