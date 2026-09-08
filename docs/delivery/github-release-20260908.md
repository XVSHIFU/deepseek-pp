# DeepSeek++ Harness — 网页模型与本机 Agent

在本机 DeepSeek Harness 网页中聊天、读取和编辑项目文件、执行命令，使用已登录的 DeepSeek 网页作为模型，无需模型 API Key。

- 默认模式、专家模式与独立思考开关，支持新会话默认值和会话内选择。
- 跟随 Harness 语言的中英文设置，折叠分组与浅色/深色主题。
- Windows PowerShell 7 原生命令与网页审批，无需 WSL；Linux 沿用 Harness Bash 与文件沙箱。
- 保存与继续会话、导入已完成的独立 DeepSeek Web Agent 会话。
- 工具格式纠正支持带参数的方括号意图；模型也可选择正常回答，取消或结果不明时不会自动重放。

## 下载与安装

下载附件 **`deepseek-web-harness-20260908.zip`**，解压后从里面的 **README.md** 开始。整包已包含 Chrome、Edge、Firefox 扩展和 Harness 插件，无需另装扩展补丁。请勿选择 GitHub 自动生成的 Source code。

运行环境：Node.js 24.x、DeepSeek Harness `0.1.2-rc.1`、同机桌面浏览器。Windows 命令需要 PowerShell 7；Linux 命令需要可用的 Bubblewrap 或 Landlock 后端。Firefox 使用临时加载方式。

已安装用户查看 README 的“升级”。保持 Chrome/Edge 原扩展目录并重新加载，可以沿用扩展 ID 和配对；刷新已登录的 DeepSeek 网页即可继续连接。

## 使用边界

这是预发布试用包。支持文字与本地工具任务，不提供图片上传或识图。文件内容及工具结果会送至 DeepSeek 网页，请仅选择允许模型处理的项目，并在批准命令前核对内容。

四种模式、读写及 Windows 审批执行有既有真实网页证据；随包扩展的最后两项纠正修补通过自动回归和构建，未重跑真实网页矩阵。本次未完成 Linux 新机真实验收。
