# T8 网页模型控制、工具可靠性与设置体验计划

状态：`in_progress_visual_alignment_and_real_acceptance`（2026-09-07 启动；2026-09-08 增加官方视觉一致性任务；基线 `89ab502bc637f79cea51d48d55c6d4b552b786d9`）

T8 在已完成的官方 DeepSeek++ Harness 增量插件上继续，保留 `89ab502` 的品牌与 README 安装说明。阶段范围只包括官方设置卡片体验、Mode A 工具调用可靠性、网页默认/专家模式与独立深度思考、定向验证及新的本地候选。不得修改 Harness 核心、引入 API fallback、重构 Koffi/WinAPI 安装事务、覆盖 `.release/deepseek-web-official-395cf37`，也不包含图片输入、上传或引用链。

## 1. 设置界面统一

- 插件卡片采用官方风格的本地薄实现，不深度导入官方私有 `PluginCard.tsx`：初始折叠，标题按钮带箭头、连接状态和未保存标记，可展开/折叠。
- 折叠不销毁控制器或草稿；保存只在服务端 revision-fenced mutation 确认成功后折叠，失败和冲突保持展开。
- 新生成的配对令牌保存在卡片持有的临时状态中，折叠后仍可复制；不把令牌写入普通 settings、日志或可回读快照，不改变重新配对合同。
- 跟随 Harness 当前 locale 提供 `zh-CN` 与 `en` 文案，覆盖字段、按钮、连接/权限/错误/导入状态，不增加独立语言选择器。
- 继续复用公开 slots、settings scope、Remote、credential 与图标/样式能力，保留配对、连接、revision 冲突和 Windows 命令授权语义。

### 1.1 官方视觉一致性增量（2026-09-08 新增）

- 用户实机截图确认现有卡片已具备功能和折叠行为，但展开态仍混用浏览器原生 input/select/checkbox/button 外观，标签与复选框分离、操作按钮缺少主次层级、长表单缺少清晰分组，与 Harness 自带的“终端 / Agent 循环 / Subagent”卡片明显不一致。浏览器扩展自身的设置页是独立产品表面，只作功能参照；官方 Harness 插件卡片才是本任务的视觉目标。
- 先从已安装的固定 Harness `0.1.2-rc.1` 提取公开可复用的设置布局、设计 token、控件状态和焦点规则；继续禁止深度导入私有 `PluginCard.tsx` 或复制一套会随上游漂移的框架。公开原语不足时，只在插件内实现一层薄样式适配。
- 外层卡片对齐官方圆角、边框、内边距、标题/说明/折叠箭头和展开动画；展开内容按“连接、网页模型、Windows 命令、配对、旧会话导入”分组，使用一致的标题、辅助说明和分隔线，避免一整页无层级的字段堆叠。
- 文本框、数字框、下拉框、复选框和开关统一高度、圆角、边框、禁用态、hover 与键盘 focus-visible；复选框/开关必须与标签同行并扩大可点击区域。按钮分为主操作（保存）、次操作（放弃/重连/复制）和需要谨慎的操作（重新配对），对齐官方尺寸与右侧操作区，不再呈现浏览器默认按钮。
- 一次性令牌使用可横向收缩的等宽只读容器和独立复制按钮；长令牌不得挤压布局、溢出或进入日志/持久状态。窄窗口、100%/125%/150% 缩放、中英文长文案、浅色/深色主题均不得横向溢出，底部操作在长内容中保持可发现。
- 自动验收增加语义结构、公开 token 使用、focus/disabled/error/dirty 状态、折叠草稿及令牌非持久化测试；真实验收保存浅色/深色与中英文截图，并与同页官方卡片在边框、间距、控件和操作层级上逐项对照。功能正确不再单独算作视觉任务完成。

## 2. 工具调用可靠性

- `C:\Users\worker\Desktop\测试.md` 只作为只读诊断输入。先以当前源码、既有会话和脱敏测试样例比较工具 schema 提示、模型文本、流式 parser 事件和 Harness 工具事件；截图中的 `[调用 glob]` / `[调用 read]` 只证明没有正式调用，不能单独确定丢失层，也不能把 disabled 命令后的 read 当成命令成功。
- 保持 `renderToolSchemas`、`createStreamingToolCallParser`、`DeepSeekAutomationClient` 与官方 Harness tool runtime 为唯一链路。Mode A prompt 明确区分“描述调用”和实际 XML 调用，且只有工具结果可作为执行成功依据；不改变 Mode B prompt 字节。
- 合法 XML 必须覆盖跨 chunk、转义和结束处理。普通说明、教程、代码块、引用或命令文本绝不转换成工具执行。
- 仅当完整响应结束、没有发出正式 tool call、且输出可明确识别为畸形工具意图时，由 Harness adapter 在原任务 deadline/取消信号内追加一次纠正请求：“需要工具则按正确协议调用，否则正常回答”。不得直接把原文重写为可执行调用。
- 已有正式调用、断线、取消、ambiguous/unknown 外部结果均禁止纠正或重放。第二次仍畸形时返回明确的未发起工具调用错误和重试建议，不得宣称完成；普通无工具回答仍按 `stop` 完成。
- 若证据显示合法 XML 在 parser 或结束边界丢失，则以真实脱敏样例修复既有 parser，不另造解析器。诊断若必须新增，只允许显式启用、最小化和脱敏，不记录 Cookie、token、认证、私有请求或完整用户内容。

## 3. 网页模式与深度思考

- 全局设置新增 `webModelMode: "default" | "expert"` 与 `thinkingEnabled: boolean`，旧配置缺失时确定性解释为 `default` / `false`；不改写历史消息。
- 每个会话保存自己的覆盖选择；会话设置只影响下一轮，生成期间禁止修改，恢复后保留，其他会话不受影响。每轮开始冻结选项快照，工具续轮、一次有界纠正和 compaction 沿用同一快照。
- 移除 `packages/dsh-llm-deepseek-web/src/request.ts` 的模式/思考硬编码，端到端贯通官方设置 → 会话 → DSH generate options → protocol request digest → Browser client 的既有 `model_type`、`thinking_enabled`。搜索保持 `false` 且不增加 UI 开关；只有一个 `deepseek-web/current-web-session` route，无静默回退。
- 将现有 `reasoning_delta` 转成官方可消费的临时 reasoning stream block，用实时可折叠思考 UI 展示；它与最终文本、工具 parser 分离，不进入持久消息、诊断日志或下一轮上下文。
- 当前不展示图片入口。

## 4. 任务顺序与提交边界

| Task | 内容 | 退出条件 |
|:--|:--|:--|
| T8.1 | 中英文折叠设置卡片 | zh/en、初始折叠、草稿/令牌保留、成功/失败折叠合同通过 |
| T8.1b | 官方插件视觉一致性 | 对齐同页官方卡片；表单控件、分组、操作层级、主题、缩放与无障碍矩阵通过 |
| T8.2 | 工具可靠性诊断与修复 | 根因有事件级证据；合法/畸形/普通文本/副作用防重放矩阵通过 |
| T8.3 | 默认/专家与思考贯通 | 四组合、会话隔离/恢复、digest/browser 贯通、reasoning 非持久化通过 |
| T8.4 | 集成验证与本地候选 | 定向门禁、三浏览器构建/校验、新不可变候选与短升级说明完成 |
| T8.5 | 明确授权的真实网页验收 | 官方 UI、四组合 read/追问、临时 editor、批准命令均有真实事件和文件证据 |

实现可按 UI、工具可靠性、模式三个目的单一的本地提交收口；产品代码、测试、文档和证据保持同步。若确认必须改 Harness 核心或安装事务，先停止并提出范围变更。

## 5. 验证与交付

- UI：`zh-CN` / `en`、浅色 / 深色、100% / 125% / 150% 缩放、窄窗口、键盘 focus、disabled/error/dirty 状态；折叠草稿、成功折叠、失败保持展开、配对令牌保留、旧设置默认值；与同页官方卡片做截图和语义结构对照。
- 工具：合法 XML 与跨 chunk、畸形输出的一次纠正、第二次失败、普通命令说明/代码引用零执行、已调用/断线/取消/ambiguous 零重放。
- 模式：默认/专家 × 思考开关四组合；全局默认、会话覆盖/隔离/恢复、每轮冻结、请求 digest 和 Browser client 接收值；reasoning 不进工具、持久化或下一轮。
- 按 `AGENTS.md` 顺序运行定向测试、root/plugin compile、必要 prompt freeze、受影响浏览器 `build:all`、manifest/UTF-8 等适用门禁。每个后端测试批次使用 55 秒 watchdog，Windows 子进程隐藏启动，结束后检查进程树和自有临时目录。
- 自动化通过后才集中进行真实网页验收；只使用自有临时 workspace，不修改用户项目、既有安装或配对。PowerShell 7 与 Linux sandbox 分开记录，没有实际证据不标通过。
- 新候选继续命名 DeepSeek++ Harness，保留旧候选和配对兼容，短升级说明区分外层分发清单与真正需要加载的浏览器扩展目录。不得 push、PR、tag、Release、商店上传或替换现有 GitHub Release。

最终交付包括：本地提交列表、计划逐项结果、工具问题的证实根因与修复机制、实际测试命令/结果、新候选/安装路径、真实网页验收完成情况与任何剩余缺口。

## 6. 实施记录（2026-09-07）

- T8.1 功能合同已完成：设置卡片使用公开 locale、slot、settings scope 与 Remote，支持中英文、初始折叠、草稿跨折叠保留、保存成功后折叠、失败保持展开；一次性令牌在本次页面内可复制，保存后的明文不能回读。T8.1b 视觉一致性尚未完成，不再把“功能可用”表述为 UI 整体完成。
- T8.2 已完成自动验证：事件级证据确认截图中的方括号调用只是模型文本，既有流式 XML parser 没有收到完整正式标签。Mode A prompt 现明确只有完整 XML 标签执行；仅在首轮完成、历史链已验证、没有正式调用且文本是明确畸形意图时，在同一 deadline、取消信号、页面链与冻结选项下追加一次纠正。纠正仍畸形返回 `TOOL_CALL_INVALID`；已调用、断线、取消、超时、ambiguous 或历史未验证均不重放。普通说明、围栏代码、未知工具标记继续只作为文本。
- T8.3 已完成自动验证：默认/专家模式和独立思考通过官方 model route / reasoning effort 进入已有 `model_type` 与 `thinking_enabled` 字段；旧设置确定性回落为默认模式且关闭思考。全局设置只在明确选择“设为新会话默认”或当前默认已是本 provider 时更新默认模型，不覆盖其他 provider。思考内容经有界 Remote 流进入浏览器内存中的会话 dock，释放时清空，不写 session event、settings、日志或下一轮上下文。
- 定向验证通过：根 compile、prompt freeze、设置 UI、插件/配置、adapter/digest、Harness bridge/tool-wire、fake e2e 及 readonly/file-edit/command acceptance。全量测试共 2537 项，首次并行运行 2503 passed、1 skipped、33 failed；其中行为预期已按新合同修正并逐项通过，其余四组为并行资源争用，单文件复跑全部通过。
- Chrome、Edge、Firefox 在不含连续 `+` 的临时源码快照中构建通过；Manifest policy 与 177 个文本产物 UTF-8/ASCII 检查通过。WXT 0.20.26 会把原仓库绝对路径中的 `+++++` 当成正则而拒绝直接构建。sidepanel raw 门槛报告 384075/384043（超 32 字节），但同一环境对未包含 T8.2/T8.3 工作区改动的 `HEAD` 快照得到完全相同结果，证明不是本阶段增量；gzip 117316/117568 仍在预算内，因此不在 T8 中放宽或改写既有预算。
- `2123443` 候选在首次官方 UI 打开时暴露 locale service 方法失去 receiver 的运行时问题，已由 `6e48dd475ac7b894584faa56eb6fc0cf8af51316` 修复并增加官方调用形态的回归测试，因此 `.release/deepseek-web-official-2123443` 明确被取代，不再作为最终候选。
- 当前连接验证候选 `.release/deepseek-web-official-6e48dd4` 来源 `6e48dd475ac7b894584faa56eb6fc0cf8af51316`，raw `manifest.json` SHA-256=`18328ccf10753428c4d5800a2c25674afeb60a206ff68beb1809ec5fa389859c`；Chrome / Edge / Firefox ZIP SHA-256 分别为 `8946f06140e83329eb9610517c544ccbbd9c9a9d0b69e161ae77878a6b769321`、`897789d291ddc06f158754824e634a885372316bfd84e3451272e95a9708761f`、`509278eca91d1e28203728a66645adf969db235a9ebd24669fadeb94a30e687d`。package/verify 与隔离官方 `web` profile 首装通过。
- 2026-09-08，隔离 home `C:\temp\deepseek-t8-live-6e48dd4\dsh-home` 已配置用户新加载扩展 ID `hadnmeeaihlddmdpameekgadofgjbmno`；用户完成新令牌生成和扩展保存后，本机 `127.0.0.1:43123` 有一个 listener 与一个 established loopback 连接，且未记录令牌明文。配对连接可标通过；T8.5 的四组合 read/追问、临时 editor、批准命令及 T8.1b 视觉验收仍未完成。视觉改造完成后必须再生成新的不可变候选，`6e48dd4` 只保留为连接验证基线。
