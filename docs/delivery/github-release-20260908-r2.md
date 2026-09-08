# DeepSeek++ Harness · 网页模型与本机 Agent

在本机 DeepSeek Harness 网页中使用已登录的 DeepSeek 网页模型，完成多轮对话、项目文件读写和命令任务，无需模型 API Key。

- 默认 / 专家模式与深度思考独立选择。
- 支持持续长回答，工具结果返回后再继续生成回答。
- Windows 使用 PowerShell 7，无需 WSL；Linux 使用 Harness 的 Bash 与沙箱机制。
- 在 Harness 网页设置中完成配对、连接管理和命令权限配置。

## 下载与安装

下载附件 **`deepseek-web-harness-20260908-r2.zip`**，不要下载 GitHub 自动生成的 Source code。整包包含浏览器扩展、Harness 插件及配套依赖。

解压整包后阅读 **README.md**（中文）或 **README_EN.md**（English），按 Windows / Linux 对应步骤操作。浏览器扩展 ZIP 还需单独解压，加载的是内层扩展文件夹，不是整包目录。

需要 Node.js 24.x、pnpm 11.7.0、DeepSeek Harness 0.1.2-rc.1。Windows 命令需要 PowerShell 7；Linux 命令需要可用的 Bubblewrap 或 Landlock。环境安装命令已写入 README。

已有用户按 README 的“升级”操作：更新 Harness 插件及依赖、原位替换浏览器扩展文件并重新加载，然后刷新 DeepSeek 页面。保留原扩展路径、配对及会话，无需卸载重装。

浏览器 MCP → Shell Local 不是 Harness 的运行前提。WSL 用户在 Ubuntu 运行 Harness，在 Windows 浏览器安装扩展。

附件同时提供 `.zip.sha256` 校验文件。任务中读取的文件和工具结果会发送给 DeepSeek 网页模型，请只选择允许其处理的项目。
