# LoFT 项目页

本目录包含静态网站和用于制作 Demo 的源数据。在仓库根目录运行以下命令生成 `loft-pages.zip`，将解压后的内容放到 GitHub Pages 的发布目录。脚本按播放清单收集场景文件，并报告每个场景和整个网站的部署体积。

```sh
python3 loft/export_site.py
```

## 本地预览

在仓库根目录使用支持 HTTP Range 请求的静态服务器预览，视频进度条可按时间跳转。安装 Node.js 后运行以下命令，打开 [本地预览](http://localhost:8000/)。

```sh
npx live-server loft --host=127.0.0.1 --port=8000 --no-browser
```

## 导入服务器返回的场景

从仓库根目录运行。`receipt.json` 使用服务器返回的 `scene_id`、`video_index`、`revision`、`input_url`、`point_url` 和 `frames_url` 六个字段。三个地址都应是 `Svithjod/loft_demo` 同一提交下的公开 `resolve/<40位SHA>/…` 链接。导入需要 Python 3、FFmpeg 和 ffprobe，在 macOS 或 Linux 上运行，无需 HF 写入令牌。

```sh
python3 loft/import_scene.py receipt.json
```

也支持 JSON 数组、每行一条回执的 JSONL，以及标准输入。服务器每输出一行完整 JSON 就可以导入一个场景；标准输出如含运行日志，应先将回执行单独保存。

```sh
python3 loft/import_scene.py receipts.jsonl
python3 loft/import_scene.py - < receipt.json
```

导入会更新 `data/videos/videoN/source.json`、视频清单及其页面缓存版本，以及 `data/demos/manifest.json`。两段视频各自的首帧会保存为 720 像素宽的本地 JPEG，MP4 仅在提取封面或读取时长时临时下载。已有版本和封面可直接复用。下载或截帧失败时，本条回执可以原样重试。

场景按 `scene_id` 识别。重复导入会更新原条目，保留展示顺序、标题、帧率、置信度阈值、点尺寸和跟随视角设置。已绑定场景即使服务器更换视频编号，也沿用原本地展示位置。首次导入旧场景时，脚本可从 `frames.json` 路径识别场景，并按回执中的视频路径绑定原视频对。编号与其他场景冲突时会报告具体目录。

新场景的默认置信度阈值是 `3.0`，点尺寸是 `2.0`。可在服务器回执中附加 `fps` 或 `sampling_fps`。缺省时先读取帧索引内的采样率，再按帧数除以重建视频时长推算。若本机对 HF 下载域名有单独的代理分流规则，请给命令行配置相应的 `NO_PROXY`。导入后可直接刷新从 `loft/` 启动的本地预览；使用发布包时重新运行 `python3 loft/export_site.py` 并部署新包。

## 添加首页视频对

每组视频放在 `data/videos/video{n}/` 下。左侧读取 `input_view.mp4`（也支持 `input_video.mp4`），右侧读取 `point.mp4`。两段视频应从同一时刻开始，共用的时间轴以秒对齐，在较短的视频末尾停止。推荐使用 H.264 MP4。可选的首帧缩略图为 `input-poster.jpg`、`point-poster.jpg`。

添加或移除视频组后，从仓库根目录运行以下命令。将更新后的 `catalog.js` 和视频一起部署，页面按文件夹编号排序。多组视频通过左右箭头手动切换，到达首尾后可用箭头循环选择。切换后从首帧暂停，播放结束时停在当前组。

```sh
python3 loft/data/videos/update_catalog.py
```

当前首页展示 Video 1–4，点云 Demo 包含七个场景。配对视频和场景数据均来自 Hugging Face Dataset `Svithjod/loft_demo`。每个 `data/videos/video{n}/source.json` 指向该组两个 MP4 的固定版本，封面保存在同一目录。要隐藏一组视频，在其 `source.json` 中加入 `"enabled": false`。设为 `true` 或删除该字段即可恢复展示。修改后运行上面的命令刷新清单。重复导入同一场景会保留该设置。

点云场景在 `data/demos/manifest.json` 中分别引用固定版本的 `frames.json`。更新场景后，修改对应的 `source`。最后运行 `python3 loft/export_site.py` 生成发布包。

## 更新论文插图

在 `assets/figures/` 同名替换 `teaser.webp`（首页视频之后、Abstract 上方）和 `method.webp`（Method 区）。完整插图建议用白底 PDF 导出为长边约 2400–2600 像素的 WebP。

## 添加点云

场景数据放在 `data/demos/<场景名>/`。访客滚动到 Demo 后，主播放器才开始加载。当前场景按帧传输原始深度、置信度和掩码，浏览器结合相机内外参还原点的位置，并用同帧 RGB 图像着色。点击 **Global point cloud** 才加载独立的整场点云。在 `data/demos/manifest.json` 中配置场景、帧率、置信度阈值和点大小。详见[点云数据说明](data/demos/README.md)。

## 开放资源链接

Paper、Code、Hugging Face 集中在 `index.html` 的 `.resource-row` 中，共用一个 Coming soon 标签。开放资源时，把对应名称改为链接，并将 Coming soon 标签留给仍待发布的条目。全部开放后即可移除状态标签，并将分组的 `aria-labelledby` 改成 `aria-label="Project resources"`。
