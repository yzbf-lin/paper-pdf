# 纸上 · Paper PDF

本地 PDF 手写答题桌面工具。打开 PDF，或将 Word 转成 PDF，直接手写、擦除、撤销，再保存可编辑草稿或导出答卷。

[下载桌面版](https://github.com/yzbf-lin/paper-pdf/releases/latest)

## 桌面版

首版提供 macOS Apple Silicon（arm64）和 Windows x64：

- macOS：解压 `Paper-PDF-…-macOS-arm64.zip`，把 `Paper PDF.app` 放入“应用程序”后打开。
- Windows：解压 `Paper-PDF-…-Windows-x64.zip`，保持文件夹完整，运行 `Paper PDF.exe`。

桌面运行无需 Node.js、Python 或终端。macOS 包使用 ad-hoc 签名，尚未通过 Apple Developer ID 公证；若系统阻止打开，需要在系统“隐私与安全性”中确认。Windows 包尚未使用商业代码签名证书。

## Word 导入

点击 **导入 Word**，选择 `.doc` 或 `.docx`，工具在本机调用 [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/) 转成 PDF，随后即可手写编辑。

Word 转换需要另外安装 LibreOffice。工具自动查找常用安装位置；也可通过“帮助 → 配置 Word 转换程序”选择已有的 LibreOffice 应用或 `soffice` 程序。未安装时，导入界面会提供官方下载安装入口。开发环境可通过 `SOFFICE_PATH` 指定程序。

文档最大 50 MB，转换后的 PDF 最大 100 MB。转换使用独立临时配置，禁用宏和文档链接自动更新，完成或失败后清理临时文件，原 Word 不会被改写。复杂表格、分页、缺失字体可能影响转换排版，请检查生成的 PDF 后再答题。加密或损坏文档需先在 Word 中另存为未加密文档。

## 手写、保存与恢复

1. **打开 PDF** 或 **导入 Word**，选择页面。
2. 使用鼠标、触控或手写笔书写，调整颜色、线宽和缩放。
3. 橡皮只擦除本工具新增的整笔；支持撤销、重做与清空本页。
4. **保存草稿**保存 `.pdfink`，包含原始/转换后的 PDF 和可编辑向量笔迹。
5. **导出 PDF**得到带笔迹的答卷，可查看、打印和归档。

桌面版使用原生“另存为”窗口。取消保存时，未保存状态会保留。下次需修改或擦除笔迹，请选择 **打开草稿**；仅重新打开导出的 PDF，已合并的笔迹不能单独擦除。

工具不会改写原始 PDF，也不自动持久保存文档。关闭有未保存笔迹的窗口会提示。姓名笔迹属于页面标记，不是数字证书签名。目前不支持照片插入或原 PDF 文字编辑。

点击工具栏 **配色**，可用颜色选择器或 HEX / RGB 精确设置笔色，并查看笔迹预览。HEX 支持 3 位、6 位色值；RGB 每项为 0–255 的整数。确认应用后只影响新笔迹，取消不会改动当前设置。

颜色、粗细和“仅手写笔”选项会自动保存在本机，刷新页面或重新启动桌面版后恢复。桌面版与不同浏览器分别保存；清除浏览器站点数据会重置该浏览器的设置。此功能只记住工具设置，答题内容仍需保存草稿或导出 PDF。

快捷键：`P` 手写、`E` 整笔擦除、`H` 移动；按住空格临时移动；`⌘/Ctrl+Z` 撤销、`⌘/Ctrl+Shift+Z` 重做、`⌘/Ctrl+S` 保存草稿。左右方向键切换页面。“仅手写笔”会阻止鼠标和手指落笔；实体设备的压感和防误触体验需在具体设备上验证。

## 在线检测更新

桌面启动后检查更新，也可在侧栏或“帮助”菜单点击 **检查更新**。更新流程参照 [service-console](https://github.com/yzbf-lin/service-console)：

- 从本项目 GitHub Releases 读取更新清单；先用内置 Ed25519 公钥验证签名，再比较版本。
- 下载对应平台的 ZIP，核对大小和 SHA-256，通过后才保存为正式文件。
- 下载后显示文件位置；保存当前草稿、退出工具后手动安装新版。首版不自动替换应用。
- 断网或检查失败不会影响 PDF 编辑。文档、图片与笔迹不会随更新请求上传。

## 本地浏览器与开发

浏览器模式仍可使用：macOS 双击 `启动手写答题.command`（需要 Python 3），或运行 `python3 server.py` 后打开 <http://127.0.0.1:8766/>。浏览器模式支持 PDF 手写和草稿，不提供桌面专属的 Word 转换、原生保存和更新入口。

### 手机与局域网访问

电脑和手机连接同一个局域网后，在电脑上双击 `启动手机局域网访问.command`，或运行：

```sh
python3 server.py --lan --port 8767
```

终端会显示手机可访问的地址，例如 `http://192.168.1.10:8767/`。保持电脑和服务运行，在手机浏览器输入实际显示的地址，选择手机上的 PDF 或草稿即可开始答题。手指书写时请取消勾选“仅手写笔”；需要滚动纸面时选择“移动”。保存的草稿和 PDF 会下载到手机，文档不会上传至电脑。

默认本机模式仍只监听 `127.0.0.1:8766`；局域网启动脚本使用独立的 `8767` 端口，可同时运行。局域网服务仅提供编辑器所需的静态资源，不提供电脑文件浏览或上传接口。若手机无法连接，请检查是否在同一网络，以及电脑防火墙是否允许 Python 接收连接。

```sh
npm ci
node node_modules/electron/install.js
npm start
npm test
npm run test:desktop
npm run build
```

桌面烟雾测试可设置 `PAPER_PDF_SMOKE_WORD=/绝对路径/测试.docx` 和 `SOFFICE_PATH=/绝对路径/soffice`，验证 Word → PDF → 手写 → 原生保存。设置 `PAPER_PDF_EXECUTABLE` 可测试已打包的应用。测试产物只写入忽略的 `.cache/desktop-smoke/`。

`npm run build` 在当前系统构建：macOS arm64 或 Windows x64，产物在 `build/` 和 `release/`。构建先创建白名单暂存目录，用户文档、测试结果、缓存和发布私钥不会进入安装包。源码仓库同样不包含真实员工资料。

## 发布

GitHub Actions 在推送 `vX.Y.Z` 标签时运行两平台检查和构建。标签必须与 `package.json` 一致；两平台成功后生成校验值和签名清单，先上传到草稿 Release，再发布为 Latest。同一正式版本不能覆盖。

更新公钥：`desktop/update-public.pem`。发布私钥保存在仓库 Secret `PAPER_PDF_UPDATE_PRIVATE_KEY_B64`，其值为 PKCS#8 PEM 的 Base64。首次本地生成的私钥保存在忽略的 `.release-keys/update-private.pem`，请单独备份，不得提交或放进发布资产。更换公钥会影响旧客户端更新验证，不能随意重新生成。

## 来源与许可

基于 [ShizukuIchi/pdf-editor](https://github.com/ShizukuIchi/pdf-editor) 的本地处理方式重新实现直接在页面书写。上游原始源码、来源记录及 MIT 许可证保留在 `upstream/`；`src/pdf.js` 改编自其 PDF 导出模块，补充旋转和裁剪坐标处理。

PDF.js 2.3.200（Apache-2.0）和 PDF-lib 1.17.1（MIT）随 `vendor/` 分发，版本、来源和文件 SHA-256 见 `vendor/SOURCES.json`，署名见 `vendor/NOTICE.txt`。PDF.js 禁用动态表达式执行；桌面渲染进程启用沙箱、上下文隔离和本地资源白名单。项目采用 MIT 许可证。
