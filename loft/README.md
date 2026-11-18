# LoFT 项目页

本目录是可独立部署的静态网站。将目录内容上传到静态托管服务即可，资源路径均为相对路径。页面正文为英文。

## 本地预览

在仓库根目录运行以下命令，打开 [本地预览](http://localhost:8000/)。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory loft
```

## 更新论文插图

在 `assets/figures/` 替换同名的 WebP 文件，页面将自动使用新版。

| 文件 | 网页位置 |
| --- | --- |
| `teaser.webp` | 首页 Full teaser 和 Results 区的完整对比图 |
| `method.webp` | Method 区的模型架构图 |
| `reconstruction.webp` | 首页默认显示的街景重建静态图 |
| `frame-0.webp`、`frame-18.webp`、`frame-36.webp`、`frame-54.webp` | 首页可切换的 RGB 输入帧 |

完整插图建议用白底 PDF 导出为长边约 2400–2600 像素的 WebP。首页街景和输入帧为独立文件，可以单独更新。更换示例场景或采样时间时，同步更新 `index.html` 中的图片说明、时间按钮及 `assets/page.js` 中的放大图说明。

## 添加点云

将同一场景的 PLY 帧放在 `data/demos/<场景名>/`，在 `data/demos/manifest.json` 中列出帧路径和播放帧率。完整示例见 [点云数据说明](data/demos/README.md)。空清单会保留窗口并显示 “Demo coming soon”。

## 开放资源链接

Paper、Code、Hugging Face 的入口在 `index.html` 的 `.resource-row` 中。开放资源时，将对应的 `<div class="resource">` 改为带有目标地址的 `<a class="resource" href="…">`，对应的闭合标签改成 `</a>`，并移除其中的 `<small>Coming soon</small>`。
