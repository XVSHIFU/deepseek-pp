# 从 GitHub 恢复开发环境

本说明用于开发、修复和重新打包；产品安装和日常使用见[README](../../README.md)。不依赖原电脑的 `C:\temp`、`.tmp`、`.release`、浏览器配置或旧安装包。

## 1. 获取主项目

准备 Git、Node.js **24.x** 和 npm。Windows 使用 PowerShell 7；Linux 使用 Bash。安装和构建以普通用户运行。

以下命令在 Windows、Linux 通用：

```sh
git clone --branch feature/web-harness https://github.com/XVSHIFU/deepseek-pp.git
cd deepseek-pp
npm ci
npm run compile
npm run build --workspace @deepseek-pp/dsh-deepseek-web-official-plugin
npm run build:chrome
```

不要用旧目录的 `node_modules`，不要删除锁文件或用 `npm update` 替代 `npm ci`。安装需要能访问 npm registry；GitHub 保存源码和锁定的三份补丁包，不是所有第三方依赖的离线镜像。

源码目录建议直接使用克隆默认名 `deepseek-pp`。当前 WXT 构建器会把路径当作正则处理，不要把源码放在带 `+` 等正则特殊字符的目录中（例如 `deepseek+++++`）；遇到该错误时，用普通名称的新克隆构建，不需要修改依赖。

Chrome 构建输出为 `dist/chrome-mv3`；Edge、Firefox 分别使用 `npm run build:edge`、`npm run build:firefox`。Harness 插件输出在 `packages/dsh-deepseek-web-official-plugin/lib`。该目录已纳入版本管理，修改插件后须一起检查生成文件差异。

普通插件开发无需克隆 Harness：`vendor/harness-request-budget/*.tgz` 和 `package-lock.json` 已固定所需补丁。

## 2. 代码入口与验证

先读根 `AGENTS.md`，再看 `docs/decisions/web-harness-model-broker.md`、`docs/plan/`、`docs/progress/MASTER.md`。历史日志中的临时绝对路径仅是当时的证据位置，不是开发依赖。

| 修改范围 | 入口 |
|---|---|
| 官方 Harness 插件、设置 UI、Windows 命令 | `packages/dsh-deepseek-web-official-plugin/src/` |
| 网页模型适配、上下文预算、工具调用解析 | `packages/dsh-llm-deepseek-web/src/` |
| 本地连接与协议 | `packages/dsh-web-model-transport/`、`packages/web-model-protocol/` |
| 浏览器功能 | `core/`、`entrypoints/` |
| 测试与发布工具 | `tests/`、`scripts/` |

修改后先跑相关测试，每批后端/单元测试最多 60 秒；超时应停止并检查子进程，不要继续无限等待。示例：

```sh
npm test -- tests/package-web-harness.test.ts tests/dsh-official-web-package.test.ts
npm test -- tests/dsh-web-request-budget.test.ts tests/dsh-web-context-budget.test.ts
npm run compile
npm run prompt:freeze
git diff --check
```

发布前按 `AGENTS.md` 跑对应构建、检查和真实网页验证。`npm run ci:quality` 还要求 PATH 中有 `actionlint`；其版本和安装方法见 `.github/workflows/ci.yml`。该工作流当前自动触发 `main` push / PR，也可手动触发，不能把推送 feature 分支等同于 CI 已通过。

实际运行需另装 README 指定的 pnpm `11.7.0`、Harness `0.1.2-rc.1`。Windows 命令使用 PowerShell 7；Linux 命令使用官方 Bash/沙箱环境。登录、扩展 ID 和配对在新电脑重新配置，不上传凭据或用户会话。

## 3. 从源码生成完整安装包

先提交已检查的改动，保证工作树干净。以下是 Windows、Linux 通用命令：

```sh
npm run package:web-harness -- --output ../deepseek-web-harness-build --name deepseek-web-harness-local
```

输出目录必须不存在、位于源码仓库之外，而且父目录已经存在。重复执行请换一个新目录名；脚本不覆盖旧包，也不自动删除失败现场。

如果交付专项复测包，可以加 `--instructions docs/verification/某份说明.md`，将已提交的说明一并放入包内 `复测说明.md`。

此命令复用现有构建与组件校验器，依次重新构建插件和 Chrome/Edge/Firefox 扩展，再生成：

```text
deepseek-web-harness-build/
  build-chrome/、build-edge/、build-firefox/  # 本次浏览器构建
  components/                              # 本次组件校验记录
  deepseek-web-harness-local/               # 可分发目录
    README.md、README_EN.md、LICENSE
    assets/、docs/images/                   # README 引用的图片
    extensions/、plugin/、vendor/
    manifest.json、SHA256SUMS
  deepseek-web-harness-local.zip
  deepseek-web-harness-local.zip.sha256
```

整包只使用当前源码、当前构建结果和入库的 vendor 文件；不复用旧 Release。包内 README 的安装包名称会调整为本次名称，根 README 不改写。打包会记录源码提交并重新读取 ZIP 校验文件内容，但**不会代替测试、声称真实网页验收通过、推送或发布**。

生成字节受构建环境和 ZIP 时间戳影响，不保证与以前发布包逐字节相同。取回历史正式版本应下载 GitHub Release；修复后的新构建使用新名称及新校验值。

确认验收结果后，可以按 GitHub 官方方式发布上传（以下命令会修改远端，须明确获得发布授权；替换全部尖括号参数）：

```sh
gh release create <新标签> <完整安装包.zip> <完整安装包.zip.sha256> --repo XVSHIFU/deepseek-pp --target <已推送且通过验收的完整提交ID> --title <版本名称> --notes-file <发布说明.md>
```

日常恢复开发不需要执行发布命令。本次补齐开发恢复流程不会改写已有正式 Release。

## 4. 修改 Harness 补丁时

源码在另一个公开仓库的独立分支，`master` 与原基线保持不变：

```sh
git clone --branch codex/web-request-budget https://github.com/XVSHIFU/deepseek-harness.git
cd deepseek-harness
git checkout 34d57aed2e386af0b61874390c86fc5915c51b1a
git switch -c fix/my-budget-change
```

三份配套归档对应上述固定提交，不能随意用分支最新提交或上游 latest 替代。按 Harness 仓库自身的开发规则修改；原打包环境为 Node `24.18.0`、pnpm `11.7.0`，使用其 `pnpm-lock.yaml`：

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b packages/llm/llm packages/llm/llm-retry packages/compaction/compaction-basic packages/typert/generator
pnpm exec tsdown --env.DSH_BUILD_FACE host --workspace 'packages/{llm/llm,llm/llm-retry,compaction/compaction-basic}' --filter @deepseek-ai/dsh-llm --filter @deepseek-ai/dsh-llm-retry --filter @deepseek-ai/dsh-compaction-basic
pnpm --filter @deepseek-ai/dsh-llm pack --pack-destination ../../../budget-packages
pnpm --filter @deepseek-ai/dsh-llm-retry pack --pack-destination ../../../budget-packages
pnpm --filter @deepseek-ai/dsh-compaction-basic pack --pack-destination ../../../budget-packages
```

修改后的补丁需执行 Harness 自身相关测试，再将新归档 SHA-256 写入文件名，并同步主项目的 vendor 来源说明、`package.json`、锁文件及依赖归档校验常量。位置可通过 `rg VENDOR_HASHES packages scripts` 和旧文件名查找；不能仅替换 tgz 内容。MIT 许可随源码和归档保留。

## 5. 删除旧本地目录前

- 检查 `git status`，确认工作分支 HEAD 与 `git ls-remote origin refs/heads/feature/web-harness` 一致。
- 如果改过 Harness 补丁，也检查相应提交已在其远端分支。
- `.release` 的旧测试记录、`.backups`、旧项目本地分支不属于当前构建依赖；需要留作历史档案时单独备份，GitHub 主分支不会恢复它们。
- 依赖缓存、`node_modules`、`dist`、`.wxt` 可重建；配对、登录态和用户会话是运行数据，不是源码备份。
- 不依赖聊天记录继续开发：以仓库内文档、源码、锁文件和测试为准。
