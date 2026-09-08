# T8 简短复核与交付清单

复核日期：2026-09-08。源码基线 `1019d24`，运行候选 `d8e3c80515d29816046ef04087747bd2198f8925`。本轮只更新使用文档和组织交付文件，不改产品运行代码、不重新配对、不 push 或发布。

## 结论

原复核结论：已验证的模式、读写文件和 PowerShell 路径可继续使用，但工具可靠性存在下述两项待补。**2026-09-08 用户授权后，两项已在 `657019e` / `2f4f289` 修复并通过自动回归。** 原 `d8e3c80` 候选及 ZIP 不改写；新扩展更新包为 `.release/deepseek-web-tool-correction-2f4f289/`，配套 Harness 插件不变。本次修补未重新进行浏览器实测或 Linux 新机安装验收。

## 复核结果

- 五个测试文件共 **95/95** 通过：`dsh-official-web-plugin-settings-ui`、`dsh-official-web-plugin-settings`、`dsh-llm-deepseek-web`、`harness-deepseek-turn-adapter`、`real/dsh-official-web-real-acceptance`。使用既有隐藏子进程 runner，55 秒 watchdog，实际 Vitest 4.83 秒。
- 根 TypeScript `tsc --noEmit` 通过。
- `node scripts/dsh-official-web-real-acceptance.mjs --manifest C:/temp/deepseek-t8-real-d8e3c80/evidence/acceptance-manifest.json` 返回 `verified`：四个独立会话的默认/专家 × 思考开关、read 与追问、精确 editor 修改、一次审批 PowerShell 执行均有既有持久记录和文件依据。
- 原候选的严格 package verify 通过，11 个清单条目及完整文件集合一致。Manifest SHA-256：`d7b5eb594115a7d3b8173b6c10d3969c8017a4dcaa1e1bae5bd23d3fde6a51ac`。
- `d8e3c80..1019d24` 只涉及验收器、其测试和进度文档，没有运行时差异；因此本轮文档更新不重建已验收二进制。
- 未发现端口 50301 的监听。没有启动 Harness 服务或浏览器请求。
- 上一次全仓并行失败、已有 sidepanel raw 预算超限及本轮未重新运行 Linux 实测，不因本次定向通过而被改记为通过。

## 原待补项（P2，后续已修复）

1. **带参数的方括号工具意图仍可能正常结束而未执行。** `core/harness-bridge/deepseek-turn-adapter.ts` 的 `isStandaloneMalformedToolMarker` 要求每个非空行完全等于 `[调用 工具名]`。只读提取实际函数并运行：`[调用 read]` 返回 true；`[调用 read] {"path":"README.md"}` 和下一行 JSON 参数的形式均返回 false。此类无 XML 正式调用的回复没有触发纠正，随后仍走 `completed/stop`。当前测试只覆盖无参数单独标签，未覆盖用户此前报告的带参数形态。
2. **纠正提示强制要求调用，偏离已批准的正常回答出口。** `serializeToolCorrectionPrompt` 要求 exactly one XML tool tag，而纠正结束 `!emittedToolCall` 一律报 `TOOL_CALL_INVALID`。计划要求“需要工具则正确调用，否则正常回答”。应补充不需要工具时的正常终答路径，继续禁止将原文直接执行，也不得重放已经发出的调用。

后续修补仅扩展纯方括号标签及可选 JSON 对象参数的识别；参数不会被转换为执行载荷，正式调用仍由原 XML parser 发出。纠正后可正常回答；第二次畸形或空回复明确失败，正常终答仍须验证网页历史链。已发出的工具调用、取消和 ambiguous 不重放。新增回归含同行/换行/嵌套 JSON、多标签、跨 chunk、正文/围栏/缩进代码/引用、正常终答、历史验证和取消。

修补验证：五个相关测试文件 **120/120**，根 compile、Mode B prompt freeze **7/7** 通过；三浏览器 zip/build、manifest policy 与 177 个文本产物 UTF-8/ASCII 校验通过。新测试起初遗漏完整能力协商 fixture，已补齐并最终通过编译与回归，不修改生产能力要求。构建快照为 `C:\temp\deepseek-tool-correction-20260908`，与提交源码一致；沿用原依赖及已有 Pyodide externalization 提示，未更换依赖。

实际 DSH CLI 的 fake-browser readonly tool smoke（`node scripts/dsh-web-agent-tool-smoke.mjs`）通过 read/read-error 两场景：每场景两次模型请求、实际官方 read 工具、持久化与清理成功；这不是 DeepSeek 真实网页实测。新更新整包 SHA-256：`250e3062a92e9122dd9aa72689d15e9d8b506f70596586db36d7146103f94a85`。内层三浏览器 ZIP 与实际构建文件逐项一致，外层 ZIP 六个文件逐项一致；未发现本轮 Vitest/tool-smoke Node 残留。更新仅需替换原路径浏览器文件并重载、刷新，详见更新包的 `更新说明.md`。

## 文件整理

- 用户说明统一维护于根 `README.md` / `README_EN.md`：Windows/Linux 首次安装、两次解压、实际中文设置入口、配对、模式与思考、命令权限、升级。README 不混入测试记录或开发事故解释。
- 便携交付目录：`.release/deepseek-web-harness-t8-d8e3c80/`，附开始使用说明、双语 README、Apache-2.0 LICENSE。
- 运行文件完整保留在交付目录的 `packages/deepseek-web-official-d8e3c80/`，内含三浏览器 ZIP、一个 Harness 插件、三份配套依赖及原 manifest/checksums/说明。与原候选逐文件核对，不覆盖原候选，不改原 pending/release_eligible 标记。
- 压缩包使用同名 `.zip`；外层清单校验所有随包文件。外层整理不等于重新构建或公开发布。
- 整包包含 18 个文件，ZIP 中每项均与来源文件 SHA-256 一致；整包 SHA-256：`c0855da4fa7cde4c5bb33309e9568823e9bd267d4dee698c67c28ad9536f728d`，同目录附 `.zip.sha256`。六段 README PowerShell 命令语法检查通过；未实际安装或升级用户环境。测试结束后未发现 Vitest Node 残留。
- 不随包发送用户测试文档、真实会话、截图、配对令牌、DSH home、node_modules、源码参考目录或历史 release。

GitHub 当前已有旧包与本地 T8 包不是同一份。没有上传新附件前，不把旧 Release 宣称为包含本轮功能。源代码仍在当前仓库管理，无需额外复制一份开发仓库。
