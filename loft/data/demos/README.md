# 添加点云 Demo

将每个场景放在本目录下的独立子目录中。每个 PLY 文件是一帧点云，所有帧应使用同一个世界坐标系。播放器默认按相机坐标系显示，x 向右、y 向下、z 向前。第一帧的边界确定初始取景，播放时保持同一视角。

例如，保存 `courtyard/000.ply` 和 `courtyard/001.ply` 后，将本目录的 `manifest.json` 改为：

```json
{
  "sequences": [
    {
      "title": "Courtyard",
      "fps": 8,
      "frames": ["courtyard/000.ply", "courtyard/001.ply"]
    }
  ]
}
```

- 路径相对于本目录。帧按数组顺序循环播放。`fps` 可省略，默认每秒 8 帧，有效范围为 1–60。
- 添加多个场景即可显示场景选择器。单帧场景可旋转和缩放。
- 支持 ASCII 和小端二进制 PLY，首个元素为 `vertex`，每个顶点需要标量 `x`、`y`、`z`。可选的 `red`、`green`、`blue` 为 0–255。VFT 训练仓库中 `src/training/train_utils/pointcloud_export.py` 导出的 PLY 可直接使用。播放器只绘制顶点。
- 首次加载建议每帧使用约 10 万点的小端二进制 PLY。保留 `{"sequences": []}` 即显示空窗口。
- 在 `loft` 目录运行 `python3 -m http.server 8000`，访问 <http://localhost:8000/> 预览。点云与数据清单通过 HTTP 读取。
