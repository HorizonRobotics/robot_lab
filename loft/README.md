# LoFT 项目页

本目录是可独立部署的静态网站。将目录内容上传到静态托管服务即可，资源路径均为相对路径。页面正文为英文。

## 本地预览

在仓库根目录使用支持 HTTP Range 请求的静态服务器预览，视频进度条可按时间跳转。安装 Node.js 后运行以下命令，打开 [本地预览](http://localhost:8000/)。

```sh
npx live-server loft --host=127.0.0.1 --port=8000 --no-browser
```

## 添加首页视频对

每组视频放在 `data/videos/video{n}/` 下。左侧读取 `input_view.mp4`（也支持 `input_video.mp4`），右侧读取 `point.mp4`。两段视频应从同一时刻开始，共用的时间轴以秒对齐，在较短的视频末尾停止。推荐使用 H.264 MP4。可选的首帧缩略图为 `input-poster.jpg`、`point-poster.jpg`。

添加或移除视频组后，从仓库根目录运行以下命令。将更新后的 `catalog.js` 和视频一起部署，页面按文件夹编号排序。多组视频通过左右箭头手动切换，到达首尾后可用箭头循环选择。切换后从首帧暂停，播放结束时停在当前组。

```sh
python3 loft/data/videos/update_catalog.py
```

## 更新论文插图

在 `assets/figures/` 同名替换 `teaser.webp`（首页视频之后、Abstract 上方）和 `method.webp`（Method 区）。完整插图建议用白底 PDF 导出为长边约 2400–2600 像素的 WebP。

## 添加点云

将同一场景的 PLY 帧放在 `data/demos/<场景名>/`，在 `data/demos/manifest.json` 中列出帧路径和播放帧率。完整示例见 [点云数据说明](data/demos/README.md)。空清单会保留窗口并显示 “Demo coming soon”。

## 开放资源链接

Paper、Code、Hugging Face 集中在 `index.html` 的 `.resource-row` 中，共用一个 Coming soon 标签。开放资源时，把对应名称改为链接，并将 Coming soon 标签留给仍待发布的条目。全部开放后即可移除状态标签，并将分组的 `aria-labelledby` 改成 `aria-label="Project resources"`。
