# DeepSeek++ · DeepSeek 网页模型 × 本机 Harness

在本机 **DeepSeek Harness 网页**里聊天、读写项目文件、执行命令，模型使用浏览器中已经登录的 **DeepSeek 网页版**。

**不需要模型 API Key，不需要给 agent 配置其他模型。Windows 原生命令使用 PowerShell 7，不要求 WSL。**

日常流程：**首次安装并配对 → 运行 `dsh web` → 在 Harness 网页里使用。**

[首次安装](#首次安装) · [首次配对](#首次配对只做一次) · [日常使用](#日常使用) · [执行命令](#执行命令)

## 能力

本项目在 [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) 浏览器扩展的基础上，增加了与本机 Harness 的连接，并提供配套的 DSH 插件：

- **网页模型接入**：让 Harness 使用已登录的 DeepSeek 网页会话进行推理。
- **完整 Agent 工作流**：由 Harness 管理多轮对话、上下文、文件工具、Skills、子 Agent 和任务执行。
- **图形化配置**：在 Harness 设置中填写扩展 ID、配对、查看连接状态和设置命令权限。
- **会话保存与继续**：重新打开 Harness 后继续已有对话，也可导入已结束的独立 DeepSeek Web Agent 会话。
- **Windows / Linux 命令**：Windows 使用 PowerShell 7；Linux 使用官方 Bash 与沙箱机制。
- **保留原有环境**：与 Harness 的其他模型共存，也保留 DeepSeek++ 原有的浏览器内功能。

Harness 插件和浏览器扩展各有分工：Harness 负责本地任务与工具，DeepSeek++ 负责连接网页模型。浏览器内的记忆、MCP 等配置与 Harness 的插件配置分别管理。

## 首次安装

已完成安装和配对，可以直接看[日常使用](#日常使用)。

### 1. 准备环境

需要 **Node.js 24.x、DeepSeek Harness `0.1.2-rc.1`**，以及 Chrome、Edge 或 Firefox。Harness 和登录 DeepSeek 的浏览器须在同一台电脑运行。

以下命令安装本机运行环境；已有的软件可跳过。源码构建还需要 Git。

**Windows**

在终端中安装 Git、Node.js 24 和 PowerShell 7：

```powershell
winget install --id Git.Git --exact --source winget
winget install --id OpenJS.NodeJS.LTS --version 24.19.0 --exact --source winget
winget install --id Microsoft.PowerShell --exact --source winget
```

安装后重新打开 **PowerShell 7**，安装本机 Harness：

```powershell
npm install --global @deepseek-ai/dsh@0.1.2-rc.1
```

也可使用 [Node.js 安装程序](https://nodejs.org/en/download)选择 24.x，以及 [PowerShell 官方安装方法](https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows)。日常运行 Harness 不需要管理员权限。

**Linux（Ubuntu / Debian 示例）**

安装 Git、Bash 和 Bubblewrap 沙箱：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates bash bubblewrap
```

通过 [nvm](https://github.com/nvm-sh/nvm) 安装当前用户的 Node.js 24，再安装 Harness。已有 nvm 时可跳过第一行：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
npm install --global @deepseek-ai/dsh@0.1.2-rc.1
```

其他 Linux 发行版使用各自的软件包管理器安装 Bash 和 Bubblewrap；官方 Harness 也可使用可用的 Landlock 后端。Node/npm 和 Harness 使用普通用户运行。

### 2. 获取浏览器扩展和 Harness 插件

这两项是不同的软件：**浏览器扩展安装到浏览器，DSH 插件安装到本机 Harness。**

使用配套安装包时，解压到准备长期保留的目录。浏览器 ZIP 位于 `extensions/`，DSH 插件位于 `plugin/`，配套依赖位于 `vendor/`；无需执行下面的源码构建。

<details>
<summary>从源码构建：没有使用配套安装包时展开</summary>

Windows、Linux 均可执行：

```sh
git clone --branch feature/web-harness https://github.com/XVSHIFU/deepseek-pp.git
cd deepseek-pp
npm ci
```

**构建浏览器扩展：**

```sh
npm run build:chrome
```

Edge 改为 `npm run build:edge`，Firefox 改为 `npm run build:firefox`。输出分别位于 `dist/chrome-mv3`、`dist/edge-mv3`、`dist/firefox-mv3`。

**构建 Harness 插件：**

```sh
npm run build --workspace @deepseek-pp/dsh-deepseek-web-official-plugin
```

任一步出错时先停止，解决后再继续。

</details>

### 3. 安装 Harness 插件

插件通过官方 `dsh plugin --profile web add` 安装。安装一次后，配对和日常配置在 Harness 网页里完成。

**使用配套安装包：** 在解压后的目录打开终端，执行对应系统的命令。

Windows（PowerShell 7）：

```powershell
$vendor = @(Get-ChildItem -LiteralPath ./vendor -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
$plugin = @(Get-ChildItem -LiteralPath ./plugin -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
dsh plugin --profile web add $vendor $plugin --allow-build=koffi
```

Linux（Bash）：

```bash
dsh plugin --profile web add ./vendor/*.tgz ./plugin/*.tgz --allow-build=koffi
```

<details>
<summary>从源码构建后的安装命令</summary>

在仓库目录中执行。

Windows（PowerShell 7）：

```powershell
New-Item -ItemType Directory -Force .release/manual | Out-Null
npm pack --workspace @deepseek-pp/dsh-deepseek-web-official-plugin --ignore-scripts --pack-destination .release/manual
if ($LASTEXITCODE -ne 0) { throw '打包失败，请先解决错误' }
$vendor = @(Get-ChildItem -LiteralPath ./vendor/harness-request-budget -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
dsh plugin --profile web add $vendor ./.release/manual/deepseek-pp-dsh-deepseek-web-official-plugin-0.0.0-private.tgz --allow-build=koffi
```

Linux（Bash）：

```bash
mkdir -p .release/manual
npm pack --workspace @deepseek-pp/dsh-deepseek-web-official-plugin --ignore-scripts --pack-destination .release/manual &&
dsh plugin --profile web add ./vendor/harness-request-budget/*.tgz ./.release/manual/deepseek-pp-dsh-deepseek-web-official-plugin-0.0.0-private.tgz --allow-build=koffi
```

</details>

插件与三份配套依赖一起安装；`--allow-build=koffi` 允许所需的原生依赖完成安装。安装过程需要联网，不会移除已有的其他模型或会话。

### 4. 加载浏览器扩展

**Chrome / Edge：**

1. 解压安装包中对应浏览器的 ZIP；源码构建则使用 `dist/chrome-mv3` 或 `dist/edge-mv3`。
2. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。
4. 记下扩展卡片上的 **ID**，并确保只启用一份 DeepSeek++。

**Firefox：** 解压 Firefox ZIP，打开 `about:debugging#/runtime/this-firefox`，选择“临时载入附加组件”，打开扩展目录中的 `manifest.json`。配对时使用该扩展的 `moz-extension://…` 地址。临时加载在浏览器退出后失效；重载后的地址如有变化，需更新配对设置。

安装完成后，打开 [DeepSeek 网页](https://chat.deepseek.com)，登录并刷新页面。

## 首次配对（只做一次）

1. 在要处理的项目目录打开终端，运行：

   ```sh
   dsh web
   ```

   保持终端运行，在自动打开的 Harness 网页中继续配置。

2. 在 **设置 → 插件 → DeepSeek Web** 中选择浏览器，填写扩展 ID；Firefox 填完整 `moz-extension://…` 地址。端口保留 **43123**。
3. 勾选 **Set DeepSeek Web as the default for future new sessions**（新会话默认使用网页模型），点击 **Save settings**。
4. 点击 **Generate pairing token**，再点 **Copy**。
5. 打开 **DeepSeek++ → 设置 → 本机 Harness**：开启桥接，端口填 **43123**，粘贴令牌，点击“保存”。
6. 显示“**已连接**”后，在 Harness 中新建会话即可开始使用。

配对令牌只在生成时显示，请妥善保管。扩展 ID 和令牌会保存，不需要每天重新填写。

## 日常使用

保持 DeepSeek 网页登录并打开，在要处理的项目目录运行：

```sh
dsh web
```

启动时所在的目录是默认工作区。在 Harness 网页中新建会话或继续历史会话，例如：

- “读取 README.md，用中文说明这个项目是做什么的。”
- “阅读这个模块，解释各个文件的作用。”
- “修改 README 的项目说明，并告诉我改了什么。”

用完在终端按 `Ctrl+C` 停止服务，下次仍用 `dsh web` 打开。浏览器和 DeepSeek 网页需要保持可用，才能继续使用网页模型。

## 执行命令

### Windows：PowerShell 7

在 Harness 的 **DeepSeek Web** 设置中启用原生命令，选择 **Ask for every command**（逐条确认），确认 PowerShell 7 路径后保存，**再新建会话**。

例如发送“执行 `Get-Location`，告诉我当前目录”，检查网页中的命令批准请求后选择“允许一次”。

命令以运行 Harness 的当前 Windows 用户权限执行，不局限于项目目录。原生命令默认关闭，自动批准需要单独开启。

### Linux：Bash

使用官方 Harness 的 `workspace-write + ask` 默认设置：普通命令在工作区文件沙箱中执行，需要扩大文件权限时请求批准。

执行命令需要可用的 Bubblewrap 或 Landlock 后端。文件沙箱不等于网络隔离。

## 数据与权限

任务中读取的文件和工具结果会作为模型上下文送到 DeepSeek 网页。请选择允许模型处理的项目，避免提供密钥或无关的敏感文件，并在批准命令前检查其内容。

## 友情链接

- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — AI-friendly CLI for Office 文档处理
- [1flowbase](https://github.com/taichuy/1flowbase) — 开源虚拟模型网关，可将多模型工作流发布为 OpenAI / Claude 兼容端点
- [FrontAgent](https://github.com/FrontAgent/FrontAgent) — 面向前端工程的 AI Agent 平台，支持 RAG、Skills、SDD、MCP、CLI 和 VS Code 插件等能力
- [MuseAI](https://github.com/yejiming/MuseAI) — AI 角色与故事互动项目，可创建角色、进入故事世界并持续互动
- [Spec Driven Develop](https://github.com/zhu1090093659/spec_driven_develop) — 面向 AI 编程代理的规范驱动开发方法
- [Awesome-Prompts 角色扮演](https://github.com/dongshuyan/Awesome-Prompts/tree/master/%E8%A7%92%E8%89%B2%E6%89%AE%E6%BC%94) — 精选角色扮演 Prompt 合集
- [LINUX DO](https://linux.do) — 新一代开源技术社区

## 致谢与许可

基于 [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件机制构建。感谢上游作者和贡献者。

## License

本仓库遵循 Apache-2.0；配套 Harness 归档遵循 MIT，保留各自的许可文件。
