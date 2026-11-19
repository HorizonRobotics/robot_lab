"""Build a LoFT scene preview with synchronized point cloud, RGB, depth and cameras."""

import argparse
import json
import os
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image


DEFAULT_MAX_POINTS = 1_500_000
PLY_VERTEX = np.dtype([("xyz", "<f4", 3), ("rgb", "u1", 3)])
PLY_CONFIDENT_VERTEX = np.dtype(PLY_VERTEX.descr + [("confidence", "<f4")])


def open_array(scene, filename):
    return np.load(scene / filename, mmap_mode="r", allow_pickle=False)


def load_clouds(scene, count):
    indexed = {}
    directory = scene / "pointcloud"
    if not directory.is_dir():
        return []
    for path in directory.iterdir():
        if not (path.is_file() and path.suffix.lower() in {".npz", ".ply"} and path.stem.isdecimal()):
            continue
        index = int(path.stem)
        if index >= count or index in indexed:
            raise ValueError(f"Point cloud {path.name} has an out-of-range or duplicate frame index.")
        indexed[index] = path
    return sorted(indexed.items())


def depth_range(depth, frame_indices):
    # Sample valid pixels across all displayed frames. One fixed scale keeps
    # brightness comparable when the visible depth distribution changes.
    samples = []
    for index in frame_indices:
        frame = depth[index]
        values = frame[np.isfinite(frame) & (frame > 0)]
        if values.size:
            samples.append(values[::max(1, (values.size + 2047) // 2048)])
    if not samples:
        return 0.0, 0.0
    low, high = np.percentile(np.concatenate(samples), [2, 98])
    return float(low), float(high)


def grayscale_depth(frame, low, high):
    valid = np.isfinite(frame) & (frame > 0)
    pixels = np.zeros(frame.shape, dtype=np.uint8)
    if low > 0 and high > low:
        values = np.clip(frame[valid], low, high).astype(np.float64)
        brightness = (np.log(values) - np.log(low)) / (np.log(high) - np.log(low))
        pixels[valid] = np.rint(255 * np.clip(brightness, 0, 1)).astype(np.uint8)
    else:
        pixels[valid] = 128
    return pixels


def save_image(pixels, path, image_format, **options):
    # HTTP readers should always see a complete JPEG/PNG during a rebuild.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
    try:
        Image.fromarray(pixels).save(tmp, format=image_format, **options)
        tmp.chmod(0o644)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def valid_world_points(xyz, depth):
    return np.isfinite(xyz).all(axis=-1) & np.isfinite(depth) & (depth > 0)


def sample_voxels(xyz, indices, origin, voxel_size):
    # The initial grid has at most 2^20 cells on each axis. One int64
    # therefore uniquely identifies a voxel, even after enlarging voxels.
    cells = np.floor((xyz.astype(np.float64) - origin) / voxel_size).astype(np.int64)
    keys = (cells[:, 0] << 42) | (cells[:, 1] << 21) | cells[:, 2]
    _, first = np.unique(keys, return_index=True)
    return xyz[first], indices[first]


def write_vertices(file, xyz, rgb, confidence=None):
    records = np.empty(len(xyz), dtype=PLY_VERTEX if confidence is None else PLY_CONFIDENT_VERTEX)
    records["xyz"], records["rgb"] = xyz, rgb
    if confidence is not None:
        records["confidence"] = confidence
    records.tofile(file)


def save_compressed(path, **arrays):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
    try:
        with tmp.open("wb") as f:
            np.savez_compressed(f, **arrays)
        tmp.chmod(0o644)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def save_frame_confidence(cloud, confidence, output):
    if cloud.suffix.lower() != ".npz":
        return None
    with np.load(cloud, allow_pickle=False) as archive:
        # Embedded scores are already delivered with the coordinates. For
        # other exports, only a pixel-aligned boolean mask identifies the
        # original image sample associated with each coordinate row.
        if "mask" not in archive.files:
            return None
        mask = archive["mask"]
        if mask.dtype != np.bool_ or mask.shape != confidence.shape:
            return None
        key = next((name for name in ("xyz", "points", "point_cloud_points") if name in archive.files), None)
        count = np.count_nonzero(mask)
        if key is None or archive[key].shape != (count, 3):
            return None
        for name in ("confidence", "depth_confidence"):
            if name in archive.files:
                scores = archive[name]
                if scores.dtype.kind in "fiu" and scores.shape in {(count,), (count, 1)}:
                    return None

    relative = Path("confidence") / f"{cloud.stem}.npz"
    save_compressed(output / relative, confidence=np.asarray(confidence[mask], dtype="<f4"))
    return relative.as_posix()


def camera_unprojection(intrinsics, extrinsics):
    k = intrinsics.astype(np.float64)
    rotation = extrinsics[:3, :3].astype(np.float64)
    if (not np.allclose(k[2], [0, 0, 1], rtol=0, atol=1e-8)
            or not np.allclose(rotation @ rotation.T, np.eye(3), rtol=0, atol=1e-5)
            or np.linalg.det(rotation) <= 0):
        return None
    try:
        return np.linalg.inv(k), rotation, extrinsics[:3, 3].astype(np.float64)
    except np.linalg.LinAlgError:
        return None


def matches_geometry(mask, distances, xyz, camera, scale):
    # Integer OpenCV pixels and camera-Z depth, in the same order as the
    # original mask. Check every vertex so sparse edits or jitter survive.
    y, x = np.nonzero(mask)
    if xyz.shape != (len(x), 3) or not len(x) or xyz.dtype.kind not in "fiu":
        return False
    inverse_k, rotation, translation = camera
    pixels = np.column_stack((x, y, np.ones(len(x))))
    camera_points = (pixels @ inverse_k.T) * distances[:, None]
    model_points = (camera_points - translation) @ rotation
    error = np.max(np.abs(xyz.astype(np.float64) / scale - model_points), axis=1)
    # Allow float32 rounding in either projection, including cancellation
    # when an axis of a world-space point is near zero.
    tolerance = 2e-6 * np.maximum(1, distances + np.max(np.abs(translation)))
    return bool(np.all(error <= tolerance))


def depth_mask(depth, points=None):
    if points is not None:
        return valid_world_points(points, depth)
    return np.isfinite(depth) & (depth > 0)


def rgbd_from_cloud(path, rgb, depth, confidence, camera, scale):
    if path.suffix.lower() != ".npz" or camera is None:
        return None
    with np.load(path, allow_pickle=False) as archive:
        xyz_key = next((k for k in ("xyz", "points", "point_cloud_points") if k in archive.files), None)
        rgb_key = next((k for k in ("rgb", "colors", "point_cloud_colors") if k in archive.files), None)
        if not xyz_key or not rgb_key or "mask" not in archive.files:
            return None
        mask = archive["mask"]
        if mask.dtype != np.bool_ or mask.shape != depth.shape:
            return None
        distances = np.asarray(depth[mask], dtype="<f4")
        if not np.all(np.isfinite(distances) & (distances > 0)):
            return None
        if not matches_geometry(mask, distances, archive[xyz_key], camera, scale):
            return None
        # The web viewer samples its RGB preview at each pixel. Preserve
        # legacy clouds that use a separate color source or custom grading.
        colors = archive[rgb_key]
        if colors.shape not in {(len(distances), 3), (len(distances), 4)} or colors.dtype.kind not in "fiu":
            return None
        colors = colors[:, :3]
        image_colors = rgb[mask]
        if colors.dtype.kind == "f" and np.max(colors) <= 1:
            image_colors = image_colors.astype(np.float32) / 255
        if not np.allclose(colors, image_colors, rtol=0, atol=2e-7):
            return None
        scores = None
        for key in ("confidence", "depth_confidence"):
            if key in archive.files:
                embedded = archive[key]
                if embedded.shape in {(len(distances),), (len(distances), 1)} and embedded.dtype.kind in "fiu":
                    scores = embedded.reshape(-1)
                    break
        if scores is None and confidence is not None:
            scores = confidence[mask]
        return mask, distances, scores


def save_rgbd(output, stem, mask, distances, scores):
    relative = Path("geometry") / f"{stem}.npz"
    arrays = {"mask": np.packbits(mask.ravel(), bitorder="little"), "depth": np.asarray(distances, dtype="<f4")}
    if scores is not None:
        arrays["confidence"] = np.asarray(scores, dtype="<f4")
    save_compressed(output / relative, **arrays)
    return relative.as_posix()


def world_preview_indices(points, depth, lower, upper, count, max_points):
    # Reserve space for sparsely observed surfaces. Doubling the grid
    # spacing merges whole voxels, preserving coverage of earlier frames.
    spatial_budget = max(1, max_points // 2)
    voxel_size = ((upper - lower).max() or 1.0) / (2**20 - 1)
    xyz = np.empty((0, 3), dtype=points.dtype)
    indices = np.empty(0, dtype=np.int64)
    pixels_per_frame = depth.shape[1] * depth.shape[2]
    for i, (frame, distances) in enumerate(zip(points, depth)):
        valid = valid_world_points(frame, distances)
        xyz = np.concatenate((xyz, frame[valid]))
        indices = np.concatenate((indices, i * pixels_per_frame + np.flatnonzero(valid)))
        xyz, indices = sample_voxels(xyz, indices, lower, voxel_size)
        while len(indices) > spatial_budget:
            voxel_size *= 2
            xyz, indices = sample_voxels(xyz, indices, lower, voxel_size)

    # Spend the remaining budget on observations throughout the image sequence.
    # Nearby surfaces occupy more pixels per world-space voxel and otherwise
    # look sparse when the viewer follows the original camera trajectory.
    indices.sort()
    remaining = max_points - len(indices)
    available = count - len(indices)
    rng = np.random.default_rng(0)
    for i, (frame, distances) in enumerate(zip(points, depth)):
        start = i * pixels_per_frame
        left, right = np.searchsorted(indices, [start, start + pixels_per_frame])
        spatial = indices[left:right] - start
        valid = valid_world_points(frame, distances).ravel()
        valid[spatial] = False
        other = np.flatnonzero(valid)
        take = remaining * len(other) // available if available else 0
        if take:
            # Distinct intervals guarantee a pixel is selected at most once.
            edges = np.arange(take + 1, dtype=np.int64) * len(other) // take
            ranks = rng.integers(edges[:-1], edges[1:])
            spatial = np.concatenate((spatial, other[ranks]))
        remaining -= take
        available -= len(other)
        yield spatial


def save_world_cloud(points, rgb, depth, path, max_points, confidence=None):
    lower = np.full(3, np.inf)
    upper = np.full(3, -np.inf)
    count = 0
    for frame, distances in zip(points, depth):
        xyz = frame[valid_world_points(frame, distances)]
        if xyz.size:
            lower = np.minimum(lower, xyz.min(axis=0))
            upper = np.maximum(upper, xyz.max(axis=0))
            count += len(xyz)
    if not count:
        raise ValueError("points_world.npy has no finite XYZ samples with a positive, finite depth.")
    if np.abs([lower, upper]).max() > np.finfo(np.float32).max:
        raise ValueError("World coordinates exceed the float32 range used by the viewer.")

    size = min(count, max_points) if max_points else count
    if size < count:
        selections = world_preview_indices(points, depth, lower, upper, count, size)
    else:
        selections = (np.flatnonzero(valid_world_points(frame, distances)) for frame, distances in zip(points, depth))
    header = (f"ply\nformat binary_little_endian 1.0\nelement vertex {size}\n"
              "property float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\n")
    if confidence is not None:
        header += "property float confidence\n"
    header += "end_header\n"
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
    try:
        with tmp.open("wb") as f:
            f.write(header.encode("ascii"))
            for index, selected in enumerate(selections):
                xyz = points[index].reshape(-1, 3)[selected]
                colors = rgb[index].reshape(-1, 3)[selected]
                scores = confidence[index].ravel()[selected] if confidence is not None else None
                write_vertices(f, xyz, colors, scores)
        tmp.chmod(0o644)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    print(f"Wrote {size:,} of {count:,} valid world points to {path}.")


def prepare(scene, output, cloud_mode="auto", max_points=DEFAULT_MAX_POINTS):
    rgb = open_array(scene, "rgb.npy")
    depth = open_array(scene, "depth.npy")
    intrinsics = open_array(scene, "intrinsics.npy")
    extrinsics = open_array(scene, "extrinsics.npy")
    if rgb.dtype != np.uint8 or rgb.ndim != 4 or rgb.shape[-1] != 3:
        raise ValueError("rgb.npy must contain uint8 RGB frames with shape (N, H, W, 3).")
    count, height, width, _ = rgb.shape
    if depth.shape == (count, height, width, 1):
        depth = depth[..., 0]
    if depth.shape != (count, height, width) or depth.dtype.kind not in "fiu":
        raise ValueError("depth.npy must match the RGB frames and contain scalar depths.")
    confidence = None
    if (scene / "depth_confidence.npy").is_file():
        confidence = open_array(scene, "depth_confidence.npy")
        if confidence.shape == (count, height, width, 1):
            confidence = confidence[..., 0]
        if confidence.shape != depth.shape or confidence.dtype.kind not in "fiu":
            raise ValueError("depth_confidence.npy must match depth.npy and contain scalar confidence scores.")
    if intrinsics.shape != (count, 3, 3) or extrinsics.shape not in {(count, 3, 4), (count, 4, 4)}:
        raise ValueError("Expected one 3×3 intrinsic matrix and 3×4 or 4×4 world-to-camera matrix per RGB frame.")
    if not (np.all(np.isfinite(intrinsics)) and np.all(np.isfinite(extrinsics))):
        raise ValueError("Camera matrices must contain finite values.")

    if max_points < 0:
        raise ValueError("--max-points must be at least zero.")
    if cloud_mode not in {"auto", "frames", "world"}:
        raise ValueError(f"Unknown cloud mode: {cloud_mode}")
    clouds = load_clouds(scene, count) if cloud_mode != "world" else []
    use_world = cloud_mode == "world" or (cloud_mode == "auto" and (scene / "points_world.npy").is_file())
    if cloud_mode == "frames" and not clouds:
        raise ValueError("Expected numerically named .npz or .ply frames in pointcloud/.")

    (output / "rgb").mkdir(parents=True, exist_ok=True)
    (output / "depth").mkdir(parents=True, exist_ok=True)
    metadata = {}
    if clouds:
        meta_path = scene / "metadata.json"
        metadata = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
        scale = float(metadata.get("coordinate_scale", 1))
        if not np.isfinite(scale) or scale <= 0:
            raise ValueError("metadata.json coordinate_scale must be finite and positive.")
    else:
        scale = 1
    points = None
    if use_world:
        # The global viewer reads raw world units independently of the
        # playback scale, which may be different for exported frame clouds.
        points = open_array(scene, "points_world.npy")
        if points.shape != rgb.shape or points.dtype.kind not in "fiu":
            raise ValueError("points_world.npy must contain XYZ coordinates with shape (N, H, W, 3) matching rgb.npy.")
        save_world_cloud(points, rgb, depth, output / "world.ply", max_points, confidence)

    cameras = [camera_unprojection(k, e) for k, e in zip(intrinsics, extrinsics)] if cloud_mode == "auto" else []
    # Without individual clouds there is no per-frame fallback. Keep the
    # shared-world clip if any frame cannot be reconstructed from its depth.
    raw_rgbd = cloud_mode == "auto" and not clouds
    if raw_rgbd:
        for i, camera in enumerate(cameras):
            mask = depth_mask(depth[i], points[i] if points is not None else None)
            distances = np.asarray(depth[i][mask], dtype="<f4")
            if (camera is None or not len(distances) or not np.all(np.isfinite(distances) & (distances > 0))
                    or (points is not None and not matches_geometry(mask, distances, points[i][mask], camera, 1))):
                raw_rgbd = False
                break
        if not raw_rgbd and not use_world:
            raise ValueError("RGB-D playback requires valid camera calibration and positive finite depths for each frame.")
    world_field = "globalCloud" if clouds or raw_rgbd else "cloud"
    # Explicitly jittered exports should retain those coordinates even if
    # a particular jitter happens to fall within the float rounding tolerance.
    settings = metadata.get("settings")
    cloud_settings = settings.get("cloud") if isinstance(settings, dict) else None
    jittered = isinstance(cloud_settings, dict) and cloud_settings.get("pixel_jitter")
    convert_frames = bool(clouds) and cloud_mode == "auto" and not jittered
    if not clouds:
        clouds = [(index, None) for index in range(count)]
    low, high = depth_range(depth, (index for index, _ in clouds))

    frames = []
    for index, path in clouds:
        stem = path.stem if path else f"{index:04d}"
        rgb_path = f"rgb/{stem}.jpg"
        depth_path = f"depth/{stem}.png"
        save_image(rgb[index], output / rgb_path, "JPEG", quality=89, subsampling=0)
        save_image(grayscale_depth(depth[index], low, high), output / depth_path, "PNG", compress_level=4)
        frames.append({
            "rgb": rgb_path,
            "depth": depth_path + "?scale=near-black",
            "intrinsics": intrinsics[index].ravel().tolist(),
            "extrinsics": extrinsics[index, :3, :4].ravel().tolist(),
        })
        scores = confidence[index] if confidence is not None else None
        geometry = None
        if raw_rgbd:
            mask = depth_mask(depth[index], points[index] if points is not None else None)
            geometry = mask, depth[index][mask], scores[mask] if scores is not None else None
        elif convert_frames:
            geometry = rgbd_from_cloud(path, rgb[index], depth[index], scores, cameras[index], scale)
        if geometry is not None:
            frames[-1]["rgbd"] = save_rgbd(output, stem, *geometry)
        elif path:
            frames[-1]["cloud"] = f"../pointcloud/{path.name}"
            if confidence is not None:
                sidecar = save_frame_confidence(path, confidence[index], output)
                if sidecar:
                    frames[-1]["confidence"] = sidecar

    clip = {"width": width, "height": height, "coordinateScale": scale, "depthRange": [low, high], "frames": frames}
    if use_world:
        clip[world_field] = "world.ply"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output, delete=False) as f:
        tmp = Path(f.name)
        json.dump(clip, f, allow_nan=False, separators=(",", ":"))
        f.write("\n")
    tmp.chmod(0o644)
    os.replace(tmp, output / "frames.json")
    print(f"Wrote {len(frames)} frames at {width}×{height} to {output}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path, help="Scene with RGB, depth, cameras and points_world.npy or pointcloud/.")
    parser.add_argument("--output", type=Path, help="Stage the preview elsewhere; deploy it as SCENE/preview/.")
    parser.add_argument("--cloud-mode", choices=("auto", "world", "frames"), default="auto",
                        help="Auto exports calibrated RGB-D frames where possible and a separate world view if available. "
                             "Frames and world select only the named source.")
    parser.add_argument("--max-points", type=int, default=DEFAULT_MAX_POINTS,
                        help="Maximum points exported from points_world.npy (default: %(default)s). Use 0 for all valid points.")
    args = parser.parse_args()
    prepare(args.scene, args.output or args.scene / "preview", args.cloud_mode, args.max_points)


if __name__ == "__main__":
    main()
