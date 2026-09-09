# DeepSeek++ Harness · 2026-09-09

让本机 DeepSeek Harness 使用已登录的 DeepSeek 网页模型，支持多轮任务、项目文件读写和命令执行，无需模型 API Key。

## 本次更新

- 网页模型请求默认间隔 5 秒，可在浏览器扩展的 **设置 → 本机 Harness → 模型请求最小间隔（秒）** 调整为 5–30 秒。同一扩展连接的 Harness 会话统一排队，减少连续工具任务的密集请求。
- 遇到网页限流时显示明确的中文原因并暂停；连续限流的冷却逐步延长至 30 / 60 / 120 秒，等待期间可以取消。
- 保留已完成的工具结果，不自动重放结果不明的请求。核对进度后可在 Harness 新建或分支会话继续。
- 改进工具调用格式纠正，以及中断原因的显示。

5 秒是默认节奏，不是 DeepSeek 官方保证的限额；网页限流仍可能发生。节流不覆盖手动网页聊天或其他浏览器中的请求。

## 下载与升级

下载附件 **`deepseek-web-harness-20260909.zip`**，不要选择 GitHub 自动生成的 Source code。完整包包含 Chrome / Edge / Firefox 扩展、Harness 插件、配套依赖和带图说明。

首次安装请阅读整包中的 **README.md**（中文）或 **README_EN.md**（English）。运行环境：Node.js 24.x、pnpm 11.7.0、DeepSeek Harness 0.1.2-rc.1。Windows 原生命令使用 PowerShell 7，无需 WSL；Linux 使用 Bash 与可用的 Bubblewrap / Landlock 沙箱。

已有用户按 README 的“升级”操作：

1. 停止 `dsh web`，保留旧组件和扩展配置备份。
2. 从新安装包目录更新 Harness 插件及配套依赖。
3. 解压对应浏览器扩展 ZIP，将内容覆盖到原加载目录，点击“重新加载”，刷新 DeepSeek 页面。
4. 重新运行 `dsh web`。保持原路径和扩展 ID 时，配对及已有会话保留，不需卸载重装。

本次需要同时更新浏览器扩展与 Harness 插件。旧设置自动补足 5 秒间隔；回退时恢复备份配置与配套组件，不将新配置直接交给旧扩展。

附件提供 `.zip.sha256` 校验文件。Harness 不依赖浏览器的 MCP → Shell Local。读取的文件和工具结果会送到 DeepSeek 网页，请只选择允许模型处理的项目。
