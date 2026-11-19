"""Import LoFT server receipts and generate the matching local video posters."""

import argparse
from contextlib import nullcontext
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit
import urllib.request

from data.videos.update_catalog import build_catalog, versioned_index


SITE = Path(__file__).resolve().parent
HUB = "https://huggingface.co/datasets/Svithjod/loft_demo/resolve/"
VIDEOS = {"input": "input_video.mp4", "point": "point.mp4"}


def read_receipts(stream):
    lines = (line for line in stream if line.strip())
    first = next(lines, None)
    if first is None:
        raise ValueError("Empty receipt file.")
    try:
        first_value = json.loads(first)
    except json.JSONDecodeError:
        # A formatted object or array can span the whole file.
        first_value = json.loads(first + stream.read())
    values = first_value if isinstance(first_value, list) else [first_value]
    if not values or not all(isinstance(row, dict) for row in values):
        raise ValueError("Expected a receipt object, a JSON array, or one object per line.")
    yield from values
    for line in lines:
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("Each JSONL line must contain a receipt object.")
        yield row

def validated_urls(row):
    scene = row["scene_id"]
    if not isinstance(scene, str) or not scene.strip() or scene in (".", "..") or re.search(r"[/\\\x00-\x1f]", scene):
        raise ValueError("scene_id must be a single non-empty directory name.")
    index = re.fullmatch(r"(?:video)?([1-9][0-9]*)", str(row["video_index"]))
    revision = row["revision"]
    if not index or not isinstance(revision, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        raise ValueError("Expected a positive video_index and a full 40-character commit SHA.")
    name = "video" + index[1]
    base = HUB + revision.lower() + "/"
    paths = {key + "_url": f"videos/{name}/{filename}" for key, filename in VIDEOS.items()}
    paths["frames_url"] = f"demos/{quote(scene, safe='')}/preview/frames.json"
    urls = {}
    for key, path in paths.items():
        if not isinstance(row[key], str):
            raise ValueError(f"{key} must be a URL string.")
        actual = urlsplit(row[key])
        expected = urlsplit(base + path)
        if (actual.scheme, actual.netloc, unquote(actual.path)) != (
            expected.scheme, expected.netloc, unquote(expected.path)
        ):
            raise ValueError(f"{key} does not match scene_id, video_index and revision: expected {base + path}")
        urls[key] = base + path
    return name, urls


def video_slot(root, scene, incoming):
    sources = {p.parent.name: json.loads(p.read_text(encoding="utf-8"))
               for p in root.glob("video[0-9]*/source.json") if re.fullmatch(r"video[0-9]+", p.parent.name)}
    if any(not isinstance(source, dict) for source in sources.values()):
        raise ValueError("Video source.json must contain a JSON object.")
    owner = [name for name, source in sources.items() if source.get("scene_id") == scene]
    if len(owner) > 1:
        raise ValueError(f"{scene} is already bound to multiple video folders: {owner}")
    slot = owner[0] if owner else incoming
    # Existing folders from before scene IDs were recorded can be adopted when
    # both URLs identify the very same HF pair, even at a newer revision.
    for name, source in sources.items():
        same_remote = all(re.fullmatch(re.escape(HUB) + r"[^/]+/videos/" + incoming + "/" + re.escape(file),
                                       str(source.get(kind, ""))) for kind, file in VIDEOS.items())
        if same_remote and name != slot:
            raise ValueError(f"{incoming} is already referenced by local {name}.")
        if name == slot and not owner and (source.get("scene_id") or not same_remote):
            raise ValueError(f"{slot} already belongs to another scene or video pair.")
    if (root / slot).is_dir() and slot not in sources and any((root / slot).glob("*.mp4")):
        raise ValueError(f"{slot} contains an existing local video pair with no remote binding.")
    return slot, sources.get(slot, {})


def find_entry(entries, scene):
    matches = []
    for entry in entries:
        identifier = entry.get("scene_id")
        if identifier is None:
            path = unquote(urlsplit(entry.get("source", "")).path).split("/")
            identifier = path[-3] if len(path) >= 3 and path[-2:] == ["preview", "frames.json"] else entry.get("title")
        if identifier == scene:
            matches.append(entry)
    if len(matches) > 1:
        raise ValueError(f"Multiple entries for {scene} in manifest.json.")
    return matches[0] if matches else None


def video_duration(path):
    output = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=duration:format=duration", "-of", "json", str(path)
    ], text=True)
    info = json.loads(output)
    for track in [*info.get("streams", []), info.get("format", {})]:
        try:
            seconds = float(track.get("duration", ""))
        except (TypeError, ValueError):
            continue
        if math.isfinite(seconds) and seconds > 0:
            return seconds
    raise ValueError("Missing reconstruction video duration. Supply fps in the receipt.")


def make_poster(video, poster):
    subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(video),
        "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3",
        str(poster)
    ], check=True)
    if not poster.is_file() or not poster.stat().st_size:
        raise ValueError(f"No first frame could be decoded from {video.name}.")


def json_file(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def publish_files(changes, folder, temp):
    # All downloads and catalog validation finish before any live file changes.
    changed = [(src, dst) for src, dst in changes if not dst.exists() or src.read_bytes() != dst.read_bytes()]
    backups = {}
    for _, dst in changed:
        if dst.exists():
            backup = temp / f"backup-{len(backups)}"
            shutil.copy2(dst, backup)
            backups[dst] = backup
    new_folder = not folder.exists()
    applied = []
    try:
        folder.mkdir(exist_ok=True)
        for src, dst in changed:
            os.replace(src, dst)
            applied.append(dst)
    except BaseException:
        for dst in reversed(applied):
            if dst in backups:
                os.replace(backups[dst], dst)
            else:
                dst.unlink()
        if new_folder and folder.is_dir():
            folder.rmdir()
        raise
    return bool(changed)


def import_one(site, row, temp):
    incoming, urls = validated_urls(row)
    scene = row["scene_id"]
    videos = site / "data/videos"
    slot, old_source = video_slot(videos, scene, incoming)
    folder = videos / slot
    staged = temp / slot
    staged.mkdir()
    manifest_path = site / "data/demos/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = find_entry(manifest["sequences"], scene)
    if entry is None:
        entry = {"title": scene, "confidence_thresh": 3.0, "point_size": 2.0}
        manifest["sequences"].append(entry)
    entry.setdefault("follow_setback_ratio", 0.10)
    entry.setdefault("follow_tilt_degrees", 5)

    # Keep the playback rate chosen on the page when a scene is republished.
    fps = entry.get("fps", row.get("fps", row.get("sampling_fps")))
    if entry.get("source") != urls["frames_url"] or fps is None:
        with urllib.request.urlopen(urls["frames_url"], timeout=60) as response:
            clip = json.load(response)
        if not isinstance(clip, dict) or not isinstance(clip.get("frames"), list) or not clip["frames"]:
            raise ValueError("The remote frames.json has no frames.")
        frame_count = len(clip["frames"])
        if fps is None:
            fps = clip.get("fps", clip.get("sampling_fps"))

    source = {**old_source, "scene_id": scene}
    for kind, filename in VIDEOS.items():
        url = urls[kind + "_url"]
        source[kind] = url
        poster = staged / f"{kind}-poster.jpg"
        old_poster = folder / poster.name
        needs_cover = old_source.get(kind) != url or not old_poster.is_file() or old_poster.stat().st_size == 0
        needs_duration = kind == "point" and fps is None
        if needs_cover or needs_duration:
            video = temp / filename
            with urllib.request.urlopen(url, timeout=60) as response, video.open("wb") as stream:
                shutil.copyfileobj(response, stream)
            if needs_duration:
                fps = round(frame_count / video_duration(video), 6)
            if needs_cover:
                make_poster(video, poster)
        if not needs_cover:
            shutil.copyfile(old_poster, poster)

    if isinstance(fps, bool) or not 1 <= float(fps) <= 60:
        raise ValueError(f"Unsupported viewer FPS {fps}. Expected a value from 1 to 60.")
    entry.update(scene_id=scene, source=urls["frames_url"], fps=float(fps) if not isinstance(fps, int) else fps)
    json_file(staged / "source.json", source)
    json_file(temp / "manifest.json", manifest)
    catalog, _ = build_catalog(videos, {slot: staged})
    (temp / "catalog.js").write_text(catalog, encoding="utf-8")
    index = site / "index.html"
    (temp / "index.html").write_text(versioned_index(index.read_text(encoding="utf-8"), catalog), encoding="utf-8")

    changes = [(staged / name, folder / name) for name in ("input-poster.jpg", "point-poster.jpg", "source.json")]
    changes += [(temp / "catalog.js", videos / "catalog.js"), (temp / "manifest.json", manifest_path),
                (temp / "index.html", index)]
    changed = publish_files(changes, folder, temp)
    print(f"{'Imported' if changed else 'Already current'}: {scene} -> {slot} ({entry['fps']:g} fps)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", nargs="?", default="-", help="JSON or JSONL file; use - for standard input.")
    args = parser.parse_args()
    stream = nullcontext(sys.stdin) if args.receipt == "-" else open(args.receipt, encoding="utf-8")

    # Lock the existing directory, so parallel importers cannot lose one another's edits.
    with stream as receipts:
        lock = os.open(SITE / "data/videos", os.O_RDONLY)
        try:
            for row in read_receipts(receipts):
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    with tempfile.TemporaryDirectory(prefix=".loft-import-", dir=SITE) as temp:
                        import_one(SITE, row, Path(temp))
                except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as exc:
                    raise SystemExit(f"Could not import {row.get('scene_id', '(unknown scene)')}: {exc}") from exc
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
