import os
import cv2
import numpy as np
import argparse
from collections import defaultdict

def split_rows(frame, num_rows):
    h, w = frame.shape[:2]
    row_h = h // num_rows
    return [frame[i * row_h:(i + 1) * row_h, :] for i in range(num_rows)]

def process_video_triplet(video_paths, output_path, num_rows=5):
    caps = [cv2.VideoCapture(path) for path in video_paths]
    fps = int(caps[0].get(cv2.CAP_PROP_FPS))
    width = int(caps[0].get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(caps[0].get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(min(cap.get(cv2.CAP_PROP_FRAME_COUNT) for cap in caps))

    row_height = height // num_rows
    left_height = 3 * row_height
    right_height = row_height * 3
    final_height = max(left_height, right_height)
    final_width = width * 2

    out = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*'mp4v'), fps, (final_width, final_height))

    for _ in range(total_frames):
        left_part, right_rows = None, []

        for i, cap in enumerate(caps):
            ret, frame = cap.read()
            if not ret:
                return
            rows = split_rows(frame, num_rows)
            if i == 0:
                left_part = np.concatenate(rows[:3], axis=0)
            right_rows.append(rows[3])

        right_stack = np.concatenate(right_rows, axis=0)
        if right_stack.shape[0] < final_height:
            right_stack = np.vstack((right_stack, np.zeros((final_height - right_stack.shape[0], width, 3), dtype=np.uint8)))
        if left_part.shape[0] < final_height:
            left_part = np.vstack((left_part, np.zeros((final_height - left_part.shape[0], width, 3), dtype=np.uint8)))

        combined = np.hstack((left_part, right_stack))
        out.write(combined)

    for cap in caps:
        cap.release()
    out.release()
    print(f"✅ Saved: {output_path}")

def find_video_triplets(root):
    triplet_groups = defaultdict(dict)

    for dirpath, _, filenames in os.walk(root):
        for f in filenames:
            if not f.endswith(".mp4"):
                continue
            full_path = os.path.join(dirpath, f)
            if any(f.endswith(f"_{i}.mp4") for i in range(3)):
                base = f.rsplit("_", 1)[0]
                index_str = f.rsplit("_", 1)[1].replace(".mp4", "")
                try:
                    index = int(index_str)
                    triplet_groups[(dirpath, base)][index] = full_path
                except ValueError:
                    continue

    # 保留完整组
    complete_groups = {
        (path, base): group for (path, base), group in triplet_groups.items()
        if all(i in group for i in [0, 1, 2] 
               )
    }
    return complete_groups

def main():
    parser = argparse.ArgumentParser(description="Process grouped videos from directory")
    parser.add_argument('--root', type=str, default='/home/users/nemo.liu/code/robot_lab/robotransfer/static/videos/Real2Real-background', help='Root directory to search for videos')
    args = parser.parse_args()

    video_groups = find_video_triplets(args.root)
    print(f"📦 Found {len(video_groups)} complete triplet groups")

    for (path, base), paths_dict in video_groups.items():
        triplet = [paths_dict[i] for i in [0, 1, 2]]
        output_path = os.path.join(path, f"{base}_cat.mp4")
        process_video_triplet(triplet, output_path)

if __name__ == "__main__":
    main()
