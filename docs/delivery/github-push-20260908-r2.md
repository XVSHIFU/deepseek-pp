# 2026-09-08 r2 推送准备

状态：仅本地准备，等待用户批准推送和发布。目标为 `XVSHIFU/deepseek-pp` 的 `feature/web-harness`；不改 main，不 force push，不向上游提 PR。

## 本次内容

- 模型生成使用独立的默认五分钟预算，保留 RPC 十秒时限及显式请求超时。
- 工具调用之后等待真实结果，不向 Harness 转发同次生成中未经工具结果支持的后续正文；保留已有完整流验证和不自动重放规则。
- 对应回归测试、必要的已跟踪 Harness 插件构建产物、验证记录。
- 中英文 README：完整包安装、两层解压定位、首次配对、模型选择、Windows 原生命令、Linux / WSL 分工、原位升级。README 只写能力和使用方法。

## 待推送的 Git 差异

2026-09-08 fetch 后远端基线为 `e2874b30b86495ad6e96083552de9486d81405cb`，准备开始时本地领先 3 个提交，远端无独有提交。正式推送前再次核对。

```text
README.md
README_EN.md
core/harness-bridge/deepseek-turn-adapter.ts
core/interceptor/streaming-tool-text.ts
docs/delivery/github-push-20260908-r2.md
docs/delivery/github-release-20260908-r2.md
docs/progress/MASTER.md
docs/verification/20260908-超时修复包使用.md
packages/dsh-deepseek-web-official-plugin/lib/index.js
packages/dsh-web-model-transport/src/host.ts
tests/dsh-web-model-transport.test.ts
tests/harness-deepseek-turn-adapter.test.ts
tests/harness-tool-wire.test.ts
tests/streaming-tool-text.test.ts
```

继续使用当前仓库，无需复制第二个源码目录。原始用户日志、截图、配对令牌、浏览器配置、DSH home、临时脚本、node_modules、dist、参考仓库以及 `.release` 不纳入 Git 差异。

## 待发布的独立附件

- `.release/deepseek-web-harness-20260908-r2.zip`
- `.release/deepseek-web-harness-20260908-r2.zip.sha256`

完整包解压后 README 与 extensions/plugin/vendor 同级，含 Chrome、Edge、Firefox 扩展 ZIP、一个 Harness 插件 TGZ、三份配套 vendor TGZ、双语 README、Apache-2.0 / MIT 许可、manifest 和 SHA256SUMS。新电脑无需旧包或增量补丁。

浏览器与 Harness 插件复用已核验的 `a636469` 修复包；vendor 复用原完整包并逐项核对散列；README 使用本轮提交。组件来源分开记录，不重建或改写旧产物，不把旧包的整体校验值当作新包校验值。

建议另建预发布 `web-harness-preview-20260908-r2`，保留旧 Release。README 已指向 r2 附件，因此正式对外需要同时发布附件；仅 git push 不会上传安装包。发布文案见同目录 `github-release-20260908-r2.md`。

## 验证范围

- 运行时修复已有定向 171/171、compile、prompt freeze 7/7、官方插件和三浏览器构建等证据，见 MASTER。
- Windows 真实 Chrome + 官方 Harness：3 次文件工具调用及结果、中文终答、连续追问和 31.08 秒长回答完成；人工样本文件未改变。
- 本轮整理不改变运行时代码；验证文档命令语法、整包文件清单、来源散列及压缩后内容。不冒称重新执行 Linux 新机、完整模式矩阵或全仓 ci:quality。
- 原始测试日志留在本机隔离目录，不进入源码和分发包。
