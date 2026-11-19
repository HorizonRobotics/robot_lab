# 添加点云 Demo

将每个场景放在本目录下的独立子目录中。当前演示逐帧播放点云，同步显示相机视角、RGB 和深度。点击 **Global point cloud** 可打开独立的全局视图。只部署点云时，也可在清单中直接列出逐帧 PLY 或 NPZ，播放器按第一帧边界取景，支持自由旋转和缩放。

例如，保存 `courtyard/000.npz` 和 `courtyard/001.ply` 后，将本目录的 `manifest.json` 改为：

```json
{
  "sequences": [
    {
      "title": "Courtyard",
      "fps": 8,
      "frames": ["courtyard/000.npz", "courtyard/001.ply"]
    }
  ]
}
```

- 路径相对于本目录。帧按数组顺序循环播放。`fps` 可省略，默认每秒 8 帧，有效范围为 1–60。
- 添加多个场景即可显示场景选择器。单帧场景可旋转和缩放。
- 支持 ASCII 和小端二进制 PLY，首个元素为 `vertex`，每个顶点需要标量 `x`、`y`、`z`。可选的 `red`、`green`、`blue` 为 0–255。VFT 训练仓库中 `src/training/train_utils/pointcloud_export.py` 导出的 PLY 可直接使用。播放器只绘制顶点。
- 首次加载建议每帧使用约 10 万点的小端二进制 PLY。保留 `{"sequences": []}` 即显示空窗口。
- 在 `loft` 目录运行 `python3 -m http.server 8000`，访问 <http://localhost:8000/> 预览。点云与数据清单通过 HTTP 读取。

## 同步相机、RGB 与深度

将以下数组放在场景目录，帧序保持一致。如果已有逐帧点云，保存在 `pointcloud/` 子目录中，以对应帧的数字编号命名，例如 `0000.npz`。

| 文件 | 内容 |
| --- | --- |
| `points_world.npy`（可选） | 全局视图使用的 T×H×W×3 逐像素 XYZ，使用原始世界坐标 |
| `rgb.npy` | T×H×W×3，uint8，与 XYZ 逐像素对齐 |
| `depth.npy` | T×H×W，当前相机坐标系中的 Z 深度 |
| `depth_confidence.npy`（可选） | T×H×W 或 T×H×W×1，与深度图逐像素对齐的原始置信度 |
| `intrinsics.npy` | T×3×3，对应预处理后 RGB 分辨率的像素内参 |
| `extrinsics.npy` | T×3×4 或 T×4×4，世界到相机，X 向右、Y 向下、Z 向前 |

在仓库根目录使用安装有 NumPy 和 Pillow 的 Python 生成网页预览：

```sh
python3 loft/data/demos/prepare_scene.py loft/data/demos/<场景目录>
```

默认导出 `preview/frames.json`、逐帧 RGB JPEG、灰度深度 PNG 及帧索引引用的几何数据。可由深度还原的帧在索引中使用 `rgbd` 字段，指向 `geometry/` 下的压缩 NPZ。每帧包保存按像素掩码顺序排列的 float32 相机 Z 深度、按行打包的掩码及可用的 float32 置信度。浏览器使用整数像素坐标、相机内外参和 `coordinateScale` 恢复 XYZ，从同帧 JPEG 取色。旁边的灰度 PNG 只用于深度展示，按全场景第 2 至 98 百分位在对数尺度上映射为近黑远白。

对于已有的逐帧 NPZ，脚本检查像素掩码、相机反投影和源点云是否匹配。含抖动或无法验证对应关系的点云可通过索引的 `cloud` 字段保留原始文件。逐帧坐标若经过整体缩放，应在 `metadata.json` 中提供相同的 `coordinate_scale`，默认值为 1。使用仓库根目录的 `python3 loft/export_site.py` 打包，清单引用的 RGB-D 帧、原始点云或全局点云会自动纳入部署包。

若同时提供 `points_world.npy`，脚本会将所有帧合成 `preview/world.ply`，供独立全局窗口按需加载。默认最多保留 150 万点，`--max-points 0` 可保留所有深度为正且 XYZ 和深度均为有限值的点。需要显式使用原逐帧点云时可用 `--cloud-mode frames`。

在 `manifest.json` 的 `sequences` 中添加一项：

```json
{
  "title": "Courtyard",
  "fps": 5,
  "source": "courtyard/preview/frames.json",
  "confidence_thresh": 3.0,
  "point_size": 0.5,
  "follow_setback_ratio": 0.10,
  "follow_tilt_degrees": 5
}
```

播放或拖动时间轴时，点云视角沿逐帧相机轨迹移动，旁边显示同帧 RGB 和深度。跟随视角的偏移随相机转动，在同一场景中保持固定距离。拖动、缩放或键盘操作可接管视角。连续 4 秒无视角操作会平滑回到该场景设定的跟随视角，复位按钮、双击或 R 键可立即恢复跟随。

打开全局窗口会暂停主播放器。全局窗口从稍远处显示整个场景，可自由旋转和缩放，**Reset view** 可恢复总览视角。关闭窗口或按 Esc 可返回原来的帧；如果打开前正在播放，会自动继续。

## 修改配置后如何更新

- **播放速度**由本目录 `manifest.json` 中每个场景的 `fps` 控制。保存后刷新网页即可。
- **置信度过滤**由同一场景的 `confidence_thresh` 控制。主播放器和全局窗口都只绘制置信度有限且大于或等于阈值的点。分数使用模型的原始尺度，省略该字段或填 `null` 可显示全部点。更改阈值后刷新页面即可。
- **点尺寸**由同一场景的 `point_size` 控制，单位为 CSS 像素，支持正小数，实际显示受设备支持的最小点宽限制。保存后刷新即可同时更新两个窗口。省略时，主窗口使用 2.2，全局窗口使用 1.5。
- **跟随后退比例**由 `follow_setback_ratio` 控制，取非负数。默认 `0.10`，即后退首个有效帧可见点中位深度的 10%。
- **跟随俯视角度**由 `follow_tilt_degrees` 控制，默认 `5` 度。正值抬高视点并向下看，负值降低视点并向上看，角度须大于 −90° 且小于 90°。两项都设为 `0` 即使用原始相机视角。保存清单并刷新直接从 `loft/` 启动的预览即可生效。
- **逐帧坐标尺度**取自场景 `metadata.json` 的 `coordinate_scale`。这个数值应等于导出逐帧点云时使用的比例。修正它或替换相机、RGB、深度源数组后，重新运行上面的 `prepare_scene.py` 命令并刷新页面。
- **网页背景色**由 `assets/point-cloud.js` 的 `gl.clearColor` 控制。
- **离线导出设置**记录在 `metadata.json` 的 `settings` 中。要调整点云筛选或采样，在原导出流程修改配置、重新导出对应文件，再生成网页预览。主窗口跟随 `intrinsics.npy` 和 `extrinsics.npy` 中的相机；离线视频的平滑相机、轨迹叠加和编码设置仅用于相应的离线产物。

## NPZ 帧

播放器可直接读取 `numpy.savez` 或 `numpy.savez_compressed` 保存的帧，在同一播放清单里可混用 `.npz` 和 `.ply`。

- **坐标**使用 `xyz`、`points` 或 `point_cloud_points`，形状为 `(N, 3)`。支持 float16/32/64 和 8/16/32 位整数。非有限坐标会被跳过。
- **颜色**可用 `rgb`、`colors` 或 `point_cloud_colors`，与点逐行对应。支持 RGB 或 RGBA，显示前三个通道。整数按 0–255 读取；浮点颜色默认按 0–1 读取，有通道大于 1 时整帧按 0–255 读取。省略颜色会显示灰色。
- **置信度**可以直接存入 NPZ 的 `confidence` 或 `depth_confidence`（N 或 N×1），也可以存入 PLY 的标量顶点属性 `confidence`。如果原始分数在 `depth_confidence.npy` 中，运行 `prepare_scene.py` 会按逐帧 NPZ 的布尔 `mask` 生成 `preview/confidence/`，并将全局采样点的分数写入 `world.ply`。NPZ 坐标行须与掩码中为真的像素按行优先顺序一一对应。更换源分数、掩码或点云后重新生成预览，再部署更新的资产。旧场景没有逐点置信度时应省略 `confidence_thresh`。

例如，`xyz`、`rgb` 均为 `(N, 3)` 数组时，可以直接导出一帧：

```python
import numpy as np

np.savez_compressed("000.npz", xyz=xyz, rgb=rgb)
```
