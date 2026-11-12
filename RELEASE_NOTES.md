纸上 · Paper PDF v0.1.1

修复书写时刚显示的笔迹消失的问题。

- 指针捕获丢失、输入取消、窗口失焦或页面重绘时，保留当前已经写出的笔迹。
- 中断后的笔迹仍可撤销、重做，并随草稿和 PDF 保存；后续抬笔不会重复提交。
- 打开另一份文件前，先收好当前一笔，再提示未保存的修改。

已增加连续快速短笔、点按及输入中断后的保存恢复回归验证。

支持 macOS Apple Silicon 与 Windows x64。Word 转换仍需另外安装 LibreOffice。macOS 应用为 ad-hoc 签名、未经 Apple 公证，Windows 程序暂无商业签名。

macOS 解压后将 Paper PDF.app 放入应用程序；Windows 解压完整文件夹后运行 Paper PDF.exe。安装新版前请保存草稿并退出旧版本。
