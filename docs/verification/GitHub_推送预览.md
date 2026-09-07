# GitHub 推送预览

## 先看结论

直接使用当前 `deepseek+++++` 仓库，**不另建一份代码文件夹**。本地构建包、临时文件和参考源码已被 Git 排除，不会因为放在仓库目录里就上传。

**已获用户确认并推送。** `feature/web-harness` 首次推送提交为 `3186c9d`，main 未改。另按确认的安装包方向提供 [GitHub 预发布附件](https://github.com/XVSHIFU/deepseek-pp/releases/tag/web-harness-preview-20260907)，供另一台电脑下载试用。安装包作为 Release 附件上传，不进入源码 Git 树。下文保留推送前的范围预览。

- 目标仓库：[XVSHIFU/deepseek-pp](https://github.com/XVSHIFU/deepseek-pp)
- 目标分支：`feature/web-harness`，不是 `main`。
- 远端核对基线：`main = 0a02c72b135bf2936e11aa78fd6136931ed65908`；核对时远端尚无 `feature/web-harness`。
- 已开发部分：截至 `18ff243`，比远端 main 多 **80 个提交**；再加本次 README / 文档 / 忽略规则整理。
- 与远端 main 相比，准备交付的最终树共有 **264 个新增或修改文件**，完整名单见文末。
- 推送会带上这条分支的开发提交历史，**不是只上传最后一次文档修改，也不是只上传最终安装包**。

## 会包含什么

| 内容 | 相对 main 的文件数 | 用途 |
| --- | ---: | --- |
| 根目录文件 | 6 | README、英文说明、AGENTS、依赖清单和锁文件、忽略规则 |
| `core/` | 22 | 浏览器连接、网页模型复用、协议和相关本地化 |
| `entrypoints/` | 5 | 扩展后台接入及“本机 Harness”设置页 |
| `packages/` | 77 | 官方 DSH 插件、网页模型适配、连接协议和已有独立入口支持 |
| `scripts/` | 17 | 构建、打包、安装和测试辅助脚本 |
| `tests/` | 111 | 自动化测试、人工测试方法及合成测试夹具 |
| `docs/` | 18 | 方案、进度、兼容性说明、验收与本推送预览 |
| `vendor/` | 5 | 三份固定版本的 Harness 依赖归档及其 README、MIT 许可 |
| `.github/` | 3 | 已有 CI / 发布流程的本分支适配 |

原有 DeepSeek++ 代码、资源、许可和历史文档也保留在分支中；它们已经存在于 main，因此不重复列在这份差异清单里。

### 两类看似“生成文件”，但需要保留

- `packages/dsh-deepseek-web-official-plugin/lib/`：已纳入版本管理的插件构建入口，与源码一起保留。
- `vendor/harness-request-budget/*.tgz`：安装所需的三份锁定依赖，不是临时交付包。来源和许可见[依赖说明](../../vendor/harness-request-budget/README.md)。

早期 `packages/dsh-web-agent-bundle/`、P5/P6 脚本和文档也会保留。它们属于本轮 Harness 开发，并非被归档的旧 Local Agent Gateway；当前 T7 打包脚本仍复用其中的安装辅助代码，不能仅凭名称就删除。新用户只按[根 README](../../README.md)操作。

## 不会包含什么

- `.release/`：所有本地验收候选和 ZIP / 安装包，包括最终 `deepseek-web-official-395cf37`。
- `.tmp/`、`参考/`、`node_modules/`、`dist/`、`.output/`、`.wxt/`、日志、已忽略的环境配置。
- 本机 Harness 安装目录、配对令牌、登录凭据和实际会话数据；它们不属于本分支源代码。
- 旧 Local Agent Gateway 的归档分支、legacy 分支和归档 tag。
- 单独的 `XVSHIFU/deepseek-harness` 仓库及其源码补丁分支；不会改它的 `master`。
- 上游 PR #568；它尚未合并到本分支。

这里只是在说明本次 Git 的提交范围，不会删除这些本地文件。最终候选不改写，manifest SHA-256 仍为：

`3ae99a51a32eb25445e94996738710158659661ddfd1fbef2086ce70f4595c95`

## 推送不等于发布安装包

这次拟执行的是普通分支推送，不更新 main，不使用 force / mirror / all / tags，不创建 PR、Release，也不上传浏览器商店。

当前工作流中，CI 的自动分支触发仅为 main（另有 PR / 手动触发）；发布工作流需要版本 tag 或手动触发，商店上传仅手动触发。**单独推送 feature/web-harness 不会触发这些发布动作，也不代表远端 CI 已通过。**

配套安装包可以作为 GitHub Release 附件提供，让用户跳过源码构建。建议附件包括浏览器 ZIP，以及同时包含 `plugin/` 与 `vendor/` 的 Harness 插件安装包，或保留 `extensions/`、`plugin/`、`vendor/` 的统一整包。已有匹配的本地包无需重新构建浏览器；README 已写明安装包和源码两种路径。用户检查仓库后再确定上传范围与 Release 标识；本次没有创建远端 Release 或上传附件。

## 你需要检查的地方

1. [README](../../README.md)：安装是否容易照做，Windows / Linux 的差异是否清楚。
2. 本页的推送范围：是否接受保留开发提交历史、测试、计划文档和配套依赖。
3. 当前完整真实验收是 Windows + Chrome；Linux 官方插件全流程还未真实验收。按用户要求，开发状态仅保留在本页与 MASTER，不放进面向使用者的 README；移除 README 中的状态描述并不改变该验收范围。

文档整理只使用静态检查，不重新进行网页模型或命令测试，也不改变之前的产品验收结论。

本次检查已通过：新增说明的本地链接、PowerShell 安装块语法、Git 空白检查及共享忽略规则。现有 80 个开发提交从 main 线性延伸，没有合并旧项目历史；定向检查未发现真实凭据、实际会话转储或超过 GitHub 大文件限制的对象。这不是对代码绝对安全的保证。

## 完整差异文件名单

`A` = 新增，`M` = 修改；相对远端 main 基线，不是整个仓库的所有文件。

<details>
<summary>展开 264 个文件</summary>

```text
M	.github/workflows/chrome-web-store.yml
M	.github/workflows/ci.yml
M	.github/workflows/release.yml
M	.gitignore
M	AGENTS.md
M	core/deepseek/active-client.ts
M	core/deepseek/automation-client-port.ts
A	core/harness-bridge/client.ts
A	core/harness-bridge/contracts.ts
A	core/harness-bridge/coordinator.ts
A	core/harness-bridge/deepseek-turn-adapter.ts
A	core/harness-bridge/errors.ts
A	core/harness-bridge/index.ts
A	core/harness-bridge/model-turn-port.ts
A	core/harness-bridge/reconnect-wake.ts
A	core/harness-bridge/result-cache.ts
A	core/harness-bridge/session-map.ts
A	core/harness-bridge/settings.ts
A	core/harness-bridge/state.ts
M	core/i18n/resources/en/sidepanel.ts
M	core/i18n/resources/zh-CN/sidepanel.ts
M	core/interceptor/streaming-tool-call-parser.ts
M	core/messaging/deepseek-runtime-contracts.ts
M	core/messaging/deepseek-runtime-request-codec.ts
M	core/messaging/runtime-command-contracts.ts
M	core/tool/xml-tags.ts
M	core/types.ts
A	docs/analysis/community-web-bridge-landscape.md
A	docs/analysis/web-harness-module-inventory.md
A	docs/analysis/web-harness-project-overview.md
A	docs/analysis/web-harness-risk-assessment.md
M	docs/compatibility/persistence-and-sync.md
M	docs/compatibility/runtime-command-inventory.md
A	docs/decisions/web-harness-model-broker.md
A	docs/plan/dependency-graph.md
A	docs/plan/milestones.md
A	docs/plan/t7-official-plugin.md
A	docs/plan/task-breakdown.md
A	docs/progress/MASTER.md
A	docs/verification/GitHub_推送预览.md
A	docs/verification/P5_简短测试.md
A	docs/verification/P6_本机使用.md
A	docs/verification/P6_首次安装.md
A	docs/verification/T7_官方插件使用.md
A	docs/verification/T7_快速上手.md
M	entrypoints/background.ts
M	entrypoints/background/deepseek-runtime-handlers.ts
A	entrypoints/background/harness-bridge-handlers.ts
A	entrypoints/sidepanel/components/settings/HarnessBridgeSubPage.tsx
M	entrypoints/sidepanel/pages/SettingsPage.tsx
M	package-lock.json
M	package.json
A	packages/dsh-deepseek-web-official-plugin/cordis.patch.yml
A	packages/dsh-deepseek-web-official-plugin/lib/client.d.ts
A	packages/dsh-deepseek-web-official-plugin/lib/client.js
A	packages/dsh-deepseek-web-official-plugin/lib/index.d.ts
A	packages/dsh-deepseek-web-official-plugin/lib/index.js
A	packages/dsh-deepseek-web-official-plugin/lib/session-persistence.d.ts
A	packages/dsh-deepseek-web-official-plugin/lib/session-persistence.js
A	packages/dsh-deepseek-web-official-plugin/package.json
A	packages/dsh-deepseek-web-official-plugin/README.md
A	packages/dsh-deepseek-web-official-plugin/scripts/build-client.mjs
A	packages/dsh-deepseek-web-official-plugin/src/client.ts
A	packages/dsh-deepseek-web-official-plugin/src/config.ts
A	packages/dsh-deepseek-web-official-plugin/src/connection-contract.ts
A	packages/dsh-deepseek-web-official-plugin/src/connection-controller.ts
A	packages/dsh-deepseek-web-official-plugin/src/connection-remote.ts
A	packages/dsh-deepseek-web-official-plugin/src/index.ts
A	packages/dsh-deepseek-web-official-plugin/src/managed-broker.ts
A	packages/dsh-deepseek-web-official-plugin/src/session-import-contract.ts
A	packages/dsh-deepseek-web-official-plugin/src/session-import-remote.ts
A	packages/dsh-deepseek-web-official-plugin/src/session-import.ts
A	packages/dsh-deepseek-web-official-plugin/src/session-persistence.ts
A	packages/dsh-deepseek-web-official-plugin/src/windows-powershell.ts
A	packages/dsh-deepseek-web-official-plugin/tsconfig.json
A	packages/dsh-llm-deepseek-web/package.json
A	packages/dsh-llm-deepseek-web/src/adapter.ts
A	packages/dsh-llm-deepseek-web/src/constants.ts
A	packages/dsh-llm-deepseek-web/src/generation-scheduler.ts
A	packages/dsh-llm-deepseek-web/src/index.ts
A	packages/dsh-llm-deepseek-web/src/request-budget.ts
A	packages/dsh-llm-deepseek-web/src/request.ts
A	packages/dsh-llm-deepseek-web/tsconfig.json
A	packages/dsh-web-agent-bundle/bin/browser-ready.mjs
A	packages/dsh-web-agent-bundle/bin/browser-ready.patch.yml
A	packages/dsh-web-agent-bundle/bin/dsh-web-agent.mjs
A	packages/dsh-web-agent-bundle/bin/install-runtime.mjs
A	packages/dsh-web-agent-bundle/bin/model-credentials.mjs
A	packages/dsh-web-agent-bundle/bin/profile-validation.mjs
A	packages/dsh-web-agent-bundle/bin/terminal-app.mjs
A	packages/dsh-web-agent-bundle/bin/terminal-app.patch.yml
A	packages/dsh-web-agent-bundle/bin/terminal-options.mjs
A	packages/dsh-web-agent-bundle/bin/web-app-policy.mjs
A	packages/dsh-web-agent-bundle/bin/web-app.patch.yml
A	packages/dsh-web-agent-bundle/bin/web-options.mjs
A	packages/dsh-web-agent-bundle/cordis.harness-features.patch.yml
A	packages/dsh-web-agent-bundle/cordis.linux-commands.patch.yml
A	packages/dsh-web-agent-bundle/cordis.patch.yml
A	packages/dsh-web-agent-bundle/cordis.readonly.patch.yml
A	packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml
A	packages/dsh-web-agent-bundle/package.json
A	packages/dsh-web-agent-bundle/README.md
A	packages/dsh-web-agent-bundle/scripts/seed-profile.mjs
A	packages/dsh-web-agent-bundle/src/file-access-policy.ts
A	packages/dsh-web-agent-bundle/src/harness-tools-policy.ts
A	packages/dsh-web-agent-bundle/src/host.ts
A	packages/dsh-web-agent-bundle/src/index.ts
A	packages/dsh-web-agent-bundle/src/linux-command-policy.ts
A	packages/dsh-web-agent-bundle/src/readonly-policy.ts
A	packages/dsh-web-agent-bundle/src/web-compaction.ts
A	packages/dsh-web-agent-bundle/src/workspace-files-policy.ts
A	packages/dsh-web-agent-bundle/tsconfig.json
A	packages/dsh-web-model-transport/package.json
A	packages/dsh-web-model-transport/src/async-queue.ts
A	packages/dsh-web-model-transport/src/broker.ts
A	packages/dsh-web-model-transport/src/host.ts
A	packages/dsh-web-model-transport/src/index.ts
A	packages/dsh-web-model-transport/src/journal.ts
A	packages/dsh-web-model-transport/src/request-state.ts
A	packages/dsh-web-model-transport/src/security.ts
A	packages/dsh-web-model-transport/tsconfig.json
A	packages/web-model-protocol/package.json
A	packages/web-model-protocol/src/codec.ts
A	packages/web-model-protocol/src/constants.ts
A	packages/web-model-protocol/src/index.ts
A	packages/web-model-protocol/src/sequence-validator.ts
A	packages/web-model-protocol/src/types.ts
A	packages/web-model-protocol/src/validation.ts
A	packages/web-model-protocol/tsconfig.json
M	README_EN.md
M	README.md
A	scripts/dsh-web-agent-fake-smoke.mjs
A	scripts/dsh-web-agent-recovery-smoke.mjs
A	scripts/dsh-web-agent-tool-smoke.mjs
A	scripts/dsh-web-command-acceptance.mjs
A	scripts/dsh-web-file-edit-acceptance.mjs
A	scripts/dsh-web-readonly-acceptance.mjs
A	scripts/dsh-web-real-smoke.mjs
A	scripts/harness-bridge-fake-smoke.mjs
A	scripts/harness-release-policy-check.mjs
M	scripts/i18n-coverage-audit.mjs
A	scripts/install-dsh-web-agent.mjs
A	scripts/package-dsh-official-plugin.mjs
A	scripts/package-harness-integration.mjs
A	scripts/prepare-dsh-web-agent-distribution.mjs
M	scripts/sidepanel-chunk-budget.mjs
A	scripts/start-dsh-web-smoke.ps1
A	scripts/uninstall-dsh-web-agent.mjs
M	tests/automation-runner-execution.test.ts
M	tests/automation-runner-pow.test.ts
M	tests/background-deepseek-runtime-handlers.test.ts
M	tests/deepseek-adapter-stream.test.ts
A	tests/dsh-harness-tools-policy.test.ts
A	tests/dsh-linux-command-policy.test.ts
A	tests/dsh-llm-deepseek-web.test.ts
A	tests/dsh-local-exec-tools.test.ts
A	tests/dsh-local-mutation-tools.test.ts
A	tests/dsh-local-read-tools.test.ts
A	tests/dsh-official-web-package.test.ts
A	tests/dsh-official-web-plugin-settings.test.ts
A	tests/dsh-official-web-plugin.test.ts
A	tests/dsh-official-web-powershell.test.ts
A	tests/dsh-official-web-profile-e2e.test.ts
A	tests/dsh-official-web-session-import.test.ts
A	tests/dsh-official-web-windows-native-profile.test.ts
A	tests/dsh-web-agent-bundle.test.ts
A	tests/dsh-web-agent-distribution.test.ts
A	tests/dsh-web-agent-fake-e2e.test.ts
A	tests/dsh-web-agent-file-edit-loop.test.ts
A	tests/dsh-web-agent-installer.test.ts
A	tests/dsh-web-agent-package.test.ts
A	tests/dsh-web-agent-recovery-e2e.test.ts
A	tests/dsh-web-agent-tool-loop.test.ts
A	tests/dsh-web-context-budget.test.ts
A	tests/dsh-web-entry.test.ts
A	tests/dsh-web-harness-features.test.ts
A	tests/dsh-web-harness-profile-e2e.test.ts
A	tests/dsh-web-linux-commands-e2e.test.ts
A	tests/dsh-web-model-journal.test.ts
A	tests/dsh-web-model-scheduling.test.ts
A	tests/dsh-web-model-transport.test.ts
A	tests/dsh-web-request-budget.test.ts
A	tests/dsh-web-runtime-recovery.test.ts
A	tests/dsh-web-startup-feedback.test.ts
A	tests/dsh-web-surface.test.ts
A	tests/dsh-web-terminal-app.test.ts
A	tests/dsh-workspace-files-policy.test.ts
A	tests/fixtures/dsh-web-agent/exec/linux-command-loop.ts
A	tests/fixtures/dsh-web-agent/exec/linux-sandbox-probe.mjs
A	tests/fixtures/dsh-web-agent/exec/linux-sandbox-probe.README.md
A	tests/fixtures/dsh-web-agent/exec/official-pwsh-fixture.ts
A	tests/fixtures/dsh-web-agent/exec/README.md
A	tests/fixtures/dsh-web-agent/exec/wsl-loopback-probe.mjs
A	tests/fixtures/dsh-web-agent/exec/wsl-loopback-probe.README.md
A	tests/fixtures/dsh-web-agent/harness-features/README.md
A	tests/fixtures/dsh-web-agent/harness-features/runtime.ts
A	tests/fixtures/dsh-web-agent/mutation/file-edit-loop.ts
A	tests/fixtures/dsh-web-agent/mutation/README.md
A	tests/fixtures/dsh-web-agent/mutation/runtime.ts
A	tests/fixtures/dsh-web-agent/run-fake-headless.ts
A	tests/fixtures/dsh-web-agent/startup-barrier.mjs
A	tests/fixtures/dsh-web-agent/startup-barrier.patch.yml
A	tests/fixtures/dsh-web-agent/tool-loop/README.md
A	tests/fixtures/dsh-web-agent/tool-loop/request-script.ts
A	tests/fixtures/dsh-web-agent/tool-loop/run-tool-loop.ts
A	tests/fixtures/harness-bridge/bundle-probe.mjs
A	tests/fixtures/harness-bridge/fake-peer/fake-browser-peer.ts
A	tests/fixtures/harness-bridge/fake-peer/index.ts
A	tests/fixtures/harness-bridge/installation/acceptance.mjs
A	tests/fixtures/harness-bridge/installation/terminal-control-pty.mjs
A	tests/fixtures/harness-bridge/installation/terminal-pty.mjs
A	tests/fixtures/harness-bridge/installation/terminal-signal.mjs
A	tests/fixtures/harness-bridge/protocol-v1/frames.ts
A	tests/fixtures/harness-bridge/protocol-v1/success-sequence.jsonl
A	tests/fixtures/harness-bridge/recovery/browser.ts
A	tests/fixtures/harness-bridge/recovery/model.ts
A	tests/fixtures/harness-bridge/recovery/run-cli-recovery.ts
A	tests/fixtures/harness-bridge/recovery/socket.ts
A	tests/fixtures/harness-bridge/security/host.ts
A	tests/fixtures/harness-bridge/startup-feedback.mjs
A	tests/fixtures/harness-bridge/startup-parent-cancel.mjs
M	tests/fixtures/runtime-contract/runtime.ts
A	tests/fixtures/t7-official-profile/runtime.ts
A	tests/fixtures/t7-powershell/official-runtime.ts
A	tests/harness-bridge-cancel-e2e.test.ts
A	tests/harness-bridge-client.test.ts
A	tests/harness-bridge-fake-e2e.test.ts
A	tests/harness-bridge-reconnect-wake.test.ts
A	tests/harness-bridge-recovery.test.ts
A	tests/harness-bridge-settings.test.ts
A	tests/harness-browser-composition.test.ts
A	tests/harness-deepseek-turn-adapter.test.ts
A	tests/harness-tool-wire.test.ts
M	tests/persistence-burst-budget.test.ts
A	tests/real/dsh-web-command-acceptance.md
A	tests/real/dsh-web-command-acceptance.test.ts
A	tests/real/dsh-web-file-edit-acceptance.md
A	tests/real/dsh-web-file-edit-acceptance.test.ts
A	tests/real/dsh-web-readonly-acceptance.md
A	tests/real/dsh-web-readonly-acceptance.test.ts
A	tests/real/dsh-web-real-smoke-preflight.test.ts
A	tests/real/dsh-web-single-turn.md
A	tests/real/fixtures/dsh-web-real-smoke/browser-ready-barrier.mjs
A	tests/real/fixtures/dsh-web-real-smoke/browser-ready-barrier.patch.yml
A	tests/real/fixtures/dsh-web-real-smoke/hanging-child.mjs
A	tests/real/fixtures/dsh-web-real-smoke/profile-dump.yml
A	tests/real/start-dsh-web-linux-commands.test.ps1
A	tests/real/start-dsh-web-smoke.test.ps1
M	tests/runtime-command-contract.test.ts
M	tests/runtime-command-registry.test.ts
A	tests/security/harness-bridge-security.test.ts
A	tests/security/harness-profile-no-provider.test.ts
M	tests/shell-host-local-skill-preview.test.ts
M	tests/shell-host-runtime-modules.test.ts
M	tests/sidepanel-interactions.test.ts
M	tests/sidepanel-navigation.test.ts
M	tests/sidepanel-runtime-transport-contract.test.ts
M	tests/tool-provider-import-boundary.test.ts
A	tests/web-model-protocol.test.ts
A	vendor/harness-request-budget/deepseek-ai-dsh-compaction-basic-0.1.2-rc.1-44f8a92cd699.tgz
A	vendor/harness-request-budget/deepseek-ai-dsh-llm-0.1.2-rc.1-494a4a63fb46.tgz
A	vendor/harness-request-budget/deepseek-ai-dsh-llm-retry-0.1.2-rc.1-aa44c61be81b.tgz
A	vendor/harness-request-budget/LICENSE
A	vendor/harness-request-budget/README.md
```

</details>
