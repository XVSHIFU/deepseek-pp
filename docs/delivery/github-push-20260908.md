# 2026-09-08 推送准备清单

状态：本地准备，等待用户确认。代码保留在当前仓库，不复制另一份开发仓库；安装附件集中在 `.release/deepseek-web-harness-20260908/`。

## 目标与边界

- 仓库：`https://github.com/XVSHIFU/deepseek-pp`。
- 分支：`feature/web-harness`，普通追加推送，不 force、不合并或修改 main，不向上游仓库提交 PR。
- 本轮已 fetch 核对远端 `6652cc20913acfa180a1388caae7a7da7d22e905`；准备前本地领先 17 个提交，无远端独有提交。正式推送前再次核对。
- 本轮不执行 push、PR、tag、发布或上传。

## Git 推送内容

包括扩展 Harness 桥接修补与名称标识、官方插件中文/折叠 UI、模型及思考控制、必要的已跟踪 lib 产物、回归测试和验收脚本、README、计划与复核记录。三份锁定 vendor 依赖已在仓库中，本次没有替换。以下是相对远端基线的完整文件清单（含本轮准备文档）：

```text
README.md
README_EN.md
core/harness-bridge/client.ts
core/harness-bridge/deepseek-turn-adapter.ts
core/harness-bridge/session-map.ts
core/i18n/resources/en/manifest.ts
core/i18n/resources/zh-CN/manifest.ts
docs/delivery/github-push-20260908.md
docs/delivery/github-release-20260908.md
docs/delivery/t8-review-and-files.md
docs/plan/t8-web-model-controls-and-reliability.md
docs/progress/MASTER.md
entrypoints/sidepanel/components/settings/AboutSubPage.tsx
entrypoints/sidepanel/index.html
package.json
packages/dsh-deepseek-web-official-plugin/lib/client.d.ts
packages/dsh-deepseek-web-official-plugin/lib/client.js
packages/dsh-deepseek-web-official-plugin/lib/index.js
packages/dsh-deepseek-web-official-plugin/scripts/build-client.mjs
packages/dsh-deepseek-web-official-plugin/src/client.ts
packages/dsh-deepseek-web-official-plugin/src/config.ts
packages/dsh-deepseek-web-official-plugin/src/connection-contract.ts
packages/dsh-deepseek-web-official-plugin/src/index.ts
packages/dsh-deepseek-web-official-plugin/src/reasoning-contract.ts
packages/dsh-deepseek-web-official-plugin/src/reasoning-remote.ts
packages/dsh-llm-deepseek-web/src/adapter.ts
packages/dsh-llm-deepseek-web/src/constants.ts
packages/dsh-llm-deepseek-web/src/request.ts
packages/dsh-web-model-transport/src/host.ts
public/_locales/en/messages.json
public/_locales/zh_CN/messages.json
scripts/dsh-official-web-real-acceptance.mjs
scripts/dsh-web-command-acceptance.mjs
scripts/dsh-web-file-edit-acceptance.mjs
scripts/dsh-web-readonly-acceptance.mjs
scripts/dsh-web-real-smoke.mjs
tests/dsh-llm-deepseek-web.test.ts
tests/dsh-official-web-plugin-settings-ui.test.ts
tests/dsh-official-web-plugin-settings.test.ts
tests/dsh-official-web-plugin.test.ts
tests/dsh-official-web-profile-e2e.test.ts
tests/dsh-web-agent-fake-e2e.test.ts
tests/dsh-web-model-transport.test.ts
tests/harness-bridge-client.test.ts
tests/harness-browser-composition.test.ts
tests/harness-deepseek-turn-adapter.test.ts
tests/harness-tool-wire.test.ts
tests/i18n.test.ts
tests/real/dsh-official-web-real-acceptance.test.ts
```

## 单独上传的安装附件（不放进 Git 源码历史）

- `deepseek-web-harness-20260908.zip`：完整安装包，含双语 README、Chrome/Edge/Firefox 扩展 ZIP、一个 Harness 插件 TGZ、三份配套依赖 TGZ、Apache-2.0/MIT 许可、清单与校验值。
- `deepseek-web-harness-20260908.zip.sha256`：整包外部校验值。
- Release 文案来源：`docs/delivery/github-release-20260908.md`。建议新建预发布 `web-harness-preview-20260908`，不覆盖旧的 `web-harness-preview-20260907`。
- 完整包采用平铺目录，解压后 README 与 extensions/plugin/vendor 同级。新电脑无需安装旧包后再找浏览器补丁。

README 下载说明指向新附件名；正式对外时需要同时准备对应 Release 附件。单独 git push 不会上传 `.release` 中的文件，因此不能在仅推送源码后宣称新安装包已可下载。若用户仅批准 git push，应先明确附件仍待发布。

## 不推送或上传的内容

`.release/`、`.tmp/`、`参考/`、node_modules、dist、真实测试会话/截图、用户桌面测试文件、配对令牌、浏览器数据、DSH home 和临时构建目录。它们不属于本次 Git 差异；安装包只选取明确的组件，不整目录压缩工作仓库。旧候选和旧整包不删除、不覆盖。

## 来源与验证边界

- Harness 插件/三个依赖沿用 `d8e3c80515d29816046ef04087747bd2198f8925` 候选；浏览器扩展来自 `2f4f289fccf8d5f5535285d1a24f107d128cd6d8`，包含 `657019e` 工具纠正修补。来源逐项列在新的分发 manifest；不是改写旧候选。
- 已有四种网页模式/read/追问/editor/PowerShell 单次审批证据通过；最后两项浏览器纠正修补有 120/120 回归、compile、prompt freeze 7/7、三端构建和 fake-browser 实际官方 read 联调，不冒称重新完成真实网页矩阵或 Linux 新机实测。
- 本轮只调整文档和分发组织，不重建相同二进制；检查 README 命令语法、所有选取文件 SHA-256、最终 ZIP 条目与来源内容。运行时门禁沿用上述对应提交记录。
- 当前未宣称全仓 `ci:quality` 或稳定发行通过，既有完整门禁记录见 MASTER。
