# DeepSeek Web Harness Task Breakdown

## 1. 交付目标

本计划采用唯一主线 **Mode A：本机 DSH 控制，DeepSeek++ Browser Broker 提供唯一网页模型**。DeepSeek++ 是主产品仓库，未修改的 DeepSeek Harness 是精确锁版的上游运行时。最终控制流必须是：

```text
dsh 本机入口
  -> DeepSeek Harness 本地 Agent loop/session/context
  -> out-of-tree deepseek-web LlmAdapter
  -> 127.0.0.1 WebSocket + JSON-RPC Broker
  -> DeepSeek++ 浏览器扩展
  -> 当前已登录的 DeepSeek 官方网页模型
  -> 结构化模型输出/工具调用
  -> Harness 本地工具
  -> 网页模型继续推理并给出终答
```

DeepSeek 网页模型是唯一推理核心。本机不得配置或调用模型、模型 API、Pi provider、DeepSeek API Key 或其他云模型凭证。DeepSeek Harness 负责真正的 Harness 能力；这不是把若干本地工具包装成 MCP 后交给网页自由调用。

## 2. 已冻结的技术决策

社区网页桥、用户脚本、浏览器自动化和 OpenAI 兼容网关的核验结论见 [`docs/analysis/community-web-bridge-landscape.md`](../analysis/community-web-bridge-landscape.md)。这些方案只提供测试、配对、安装和兼容层参考，不改变下列冻结决策；尤其不得据此引入 Cookie/Bearer 导出、CDP/Playwright、第二套 Agent loop 或 Browser 侧本地工具执行。

- 主开发仓库是 `XVSHIFU/deepseek-pp`；产品代码只进入本仓库的 `core/`、`entrypoints/`、`packages/`、`tests/` 和发布脚本。
- `XVSHIFU/deepseek-harness` 的 `master` 保持上游 fast-forward 同步。产品运行时锁定经审核的 Harness tag/commit；禁止依赖浮动 `master`。
- Harness core 不做产品私有修改。模型接入必须使用公开的 `@deepseek-ai/dsh-llm` `LlmAdapter`、Cordis plugin 和 profile/bundle 扩展面。
- P0 传输固定为浏览器主动连接本机 `127.0.0.1` 的 WebSocket，消息固定为严格 JSON-RPC 2.0。协议替换必须先有新的架构决策，普通实现任务无权改成 HTTP 轮询、MCP tool wrapper、Native Messaging、MCP Sampling、CDP、Cookie 抓取或网页私有凭证转发。
- Browser Broker 只能复用 DeepSeek++ 已有、受测试保护的页面授权和 `DeepSeekAutomationClient`/stream codec 路径；禁止新增 Cookie 读取、把 Authorization/网页 Token 发送给 Host、让 Host 直接请求 DeepSeek 网页/API、或把网页登录态转换成本地 provider credential。
- Host 是 Harness session/context 的持久事实源；浏览器会话只是一条模型执行通道。任何网页 conversation/message 映射都必须由 request/session identity 关联并可验证，不能在崩溃后猜测成功或自动重放不确定请求。
- reasoning 是否跨 Broker 传输由 Protocol v1 capability 明确协商，默认关闭；即使未来启用也只能作为有界临时流，禁止进入日志、持久 session、恢复 journal、错误、测试 evidence 或发布产物。普通任务无权把它永久删除或默认开启。
- P0 只允许一个已认证浏览器 peer 和一个在途网页模型请求。subagent、compaction、session-title 等额外模型请求先串行排队；并发网页会话不是 P0 能力。
- Native Messaging 与 MCP Sampling 只记为 P0 之后的替代传输研究项，不能进入 P0 关键路径，也不能作为失败时的隐式 fallback。

## 3. 任务包与 Subagent 完成标准

每个任务应交给一个能够在其文件范围内交付至少 95% 实现和测试的 Subagent。任务交付不是分析报告，必须同时包含可运行代码、定向测试和必要的最小文档/fixture；根编排 Agent 只负责评审、合并、跨任务门禁和极少量冲突修复。

每个任务统一遵守：

1. 先读任务涉及的现有合同、调用方和测试；只修改列出的文件范围。
2. 先落失败的合同测试或 fixture，再实现最小代码；禁止只留接口、TODO、mock-success 或未接线代码。
3. 使用严格运行时 Schema；未知字段、未来版本、重复终态和关联 ID 不匹配必须显式失败。
4. 每项只运行列出的定向测试。`npm run compile`、`npm test`、浏览器全构建、全仓审计和发行只在批次门禁或最终收尾运行，禁止每个任务重复执行。
5. 若定向测试暴露任务范围外缺陷，记录为对拥有该文件任务的回流，不得顺手扩大文件范围。
6. 交付说明必须列出实际运行命令、结果、未运行项和风险；未执行的真实网页测试不得声称通过。

## 4. Batch A：P0 合同、假 Broker 与 DSH 假模型闭环

### T0.1 冻结 Web Model Protocol v1

- **文件范围**：`packages/web-model-protocol/package.json`、`packages/web-model-protocol/tsconfig.json`、`packages/web-model-protocol/src/**`、`tests/web-model-protocol.test.ts`、`tests/fixtures/harness-bridge/protocol-v1/**`；仅为登记 workspace 允许最小修改根 `package.json` 与 `package-lock.json`。
- **前置**：无。
- **实现技术**：定义浏览器安全、无 Node/Cordis/Pi 依赖的 JSON-RPC 2.0 codec；冻结 `bridge.hello`、`model.generate`、`model.event`、`model.cancel`、`model.query`、heartbeat 和标准 error envelope。ID、协议版本、frame byte limit、事件序号、request digest、session ID、purpose、终态和能力协商均须有严格 Schema。`model.event` 至少覆盖 text、structured tool-call、usage、completed、aborted、failed、ambiguous；reasoning 只作为默认关闭的可选 capability/ephemeral event 定义。
- **明确禁止**：不得实现网络连接；不得出现 MCP method、Cookie、Authorization、CDP target、DeepSeek endpoint 或模型 API Key 字段；不得导入浏览器具体实现或 Harness 类型。
- **验收**：golden fixture 能逐字节固定一条完整成功序列；缺字段、未知字段、超界字段、乱序事件、重复终态、错误 request ID 和未来协议版本全部拒绝；协议能表达单轮、工具轮、取消和结果查询；未协商 reasoning capability 时 reasoning event 必须拒绝，协商后的 reasoning event 可被 codec 明确识别为禁止持久化的 ephemeral 类别，实际 projection 由 T1.2/T2.1 测试守护。
- **定向测试**：`npx vitest run tests/web-model-protocol.test.ts`。

### T0.2 实现回环 WebSocket/JSON-RPC Host Transport

- **文件范围**：`packages/dsh-web-model-transport/**`、`tests/dsh-web-model-transport.test.ts`，以及该包新增依赖对应的 `package-lock.json` 条目。
- **前置**：T0.1。
- **实现技术**：实现仅绑定 `127.0.0.1` 的 WebSocket server 和 `DeepSeekWebBroker` port。浏览器 WebSocket 建连后必须在短时限内通过首个 `bridge.hello` 发送高熵配对令牌；令牌不得进入 URL，比较使用常量时间；校验 Host/Origin/extension identity、frame 大小、单 peer lease、heartbeat、事件序号和 request correlation。提供 fake peer test kit；Host 发起 JSON-RPC `model.generate`，浏览器返回 ack 并用事件流汇报结果。
- **明确禁止**：不得监听 `0.0.0.0`、LAN 或未验证的 `::1`；不得使用 query-string token、通配 Origin、完整父进程环境、Cookie、CDP、Native Messaging 或 MCP transport；不得自动重发已 ack 的模型请求。
- **验收**：合法 fake peer 可完成一轮流式响应；未认证 peer 不能收到请求；第二 peer、错误 token/origin、超大 frame、错序/晚到/重复事件均有稳定错误；断开后在途请求标为 uncertain/ambiguous 而非成功。
- **定向测试**：`npx vitest run tests/dsh-web-model-transport.test.ts`。

### T0.3 假 Broker 垂直闭环

- **文件范围**：`tests/fixtures/harness-bridge/fake-peer/**`、`tests/harness-bridge-fake-e2e.test.ts`、`scripts/harness-bridge-fake-smoke.mjs`；仅为登记命令允许修改根 `package.json`。
- **前置**：T0.2。
- **实现技术**：用真实 loopback WebSocket 和协议 codec 启动 Host transport 与独立 fake browser peer；fake peer 接收 prompt，发送多段 text 和明确终态。测试必须经过实际 socket，而不是直接调用 broker 内部方法。
- **明确禁止**：不得连接 DeepSeek、不得读取真实浏览器存储或凭证、不得把测试实现混入 production package、不得用 MCP 模拟 WebSocket。
- **验收**：单命令完成 `Host request -> authenticated fake browser -> streamed model events -> final result`；测试结束后端口、timer 和 socket 全部释放，无 orphan 进程。
- **定向测试**：`npx vitest run tests/harness-bridge-fake-e2e.test.ts`；`node scripts/harness-bridge-fake-smoke.mjs`。

## 5. Batch A：P1 浏览器 Broker

### T1.1 浏览器连接状态机

- **文件范围**：`core/harness-bridge/client.ts`、`core/harness-bridge/state.ts`、`core/harness-bridge/errors.ts`、`core/harness-bridge/index.ts`、`tests/harness-bridge-client.test.ts`。
- **前置**：T0.3。
- **实现技术**：实现 MV3 service-worker 可重建的 WebSocket client；连接仅允许 `ws://127.0.0.1:<configured-port>`，完成 hello/capability negotiation、单连接代际、heartbeat、bounded backoff、在线/离线/需配对状态。所有入站 frame 在处理前经过 T0.1 codec，旧 generation 回调不得修改新连接状态。
- **明确禁止**：不得读取 Cookie；不得使用 CDP、页面 DOM 自动化、MCP 或 Native Messaging 代替 WebSocket；不得无限重连、吞掉 codec 错误或把 token 写日志。
- **验收**：service-worker suspend/restart 模拟下可重连；同一时间只有一个 active socket；错误协议/令牌/host 明确失败；状态可被后续 UI 和模型 dispatcher 订阅。
- **定向测试**：`npx vitest run tests/harness-bridge-client.test.ts`。

### T1.2 网页模型 Turn Adapter

- **文件范围**：`core/harness-bridge/model-turn-port.ts`、`core/harness-bridge/deepseek-turn-adapter.ts`、`core/harness-bridge/session-map.ts`、`tests/harness-deepseek-turn-adapter.test.ts`。除修复经测试证明的单一权威缺口外，不修改 `core/deepseek/active-client.ts`、`stream-codec.ts` 或 `core/interceptor/*`。
- **前置**：T0.3。
- **实现技术**：Mode A 直接在现有 `DeepSeekAutomationClient` 之上定义不依赖 Pi 的 provider-neutral `WebModelTurnPort`；新 Browser Broker 薄适配该端口，现有 Pi 路径保持原样且不在 Mode A 控制流中。复用 PoW、stream codec 与 tool parser。Browser 保留页面认证，Host 只传模型上下文和工具描述。建立 Harness `sessionId/requestId` 到网页 chat/message 的有界映射，完整 FINISHED 才发 completed；中断流发 failed/ambiguous。reasoning 仅在 T0.1 capability 已协商时作为有界临时事件发送，默认关闭且绝不进入日志或持久状态。
- **明确禁止**：不得复制 DeepSeek SSE/PoW/工具 XML parser；不得新建第二套网页 endpoint/client；不得把现有 Pi `StreamFn` 类型放入跨进程合同；不得把页面 Token、Authorization 或完整请求头发给 Host。
- **验收**：fixture stream 可转换为 text/tool/terminal 事件；未收到 FINISHED、缺 response message ID、链不连续、重复 request ID 均 fail closed；Host 可见日志、journal 和持久对象不含 credential/reasoning；reasoning capability 的未协商拒绝和协商后临时传输均有测试。
- **定向测试**：`npx vitest run tests/harness-deepseek-turn-adapter.test.ts tests/stream-fn-port.test.ts tests/stream-fn-event-mapping.test.ts tests/stream-fn-adapter.test.ts tests/deepseek-web-provider.test.ts`。

### T1.3 Browser Broker 组合、配置与可见状态

- **文件范围**：`core/harness-bridge/settings.ts`、`core/messaging/deepseek-runtime-contracts.ts`、`entrypoints/background.ts`、`entrypoints/sidepanel/pages/SettingsPage.tsx`、相关 `core/i18n/resources/{en,zh-CN}/**`、`tests/harness-bridge-settings.test.ts`、`tests/background-runtime-handlers.test.ts`、`tests/sidepanel-interactions.test.ts`。
- **前置**：T1.1、T1.2。
- **实现技术**：把 client 与 turn adapter 组合到 Background 生命周期；增加显式启用、loopback port、配对令牌、连接状态和断开控制。新持久字段必须有版本 codec、默认关闭和确定性迁移；令牌只存 browser local，不进入 sync/export/log。UI 只显示可操作状态，不展示网页凭证。
- **明确禁止**：不得默认开启；不得改变现有 inline-agent、MCP、automation 或 sidepanel chat 的后端选择；不得把新配置复用为 MCP server；不得加入远程 host 或任意 URL 输入。
- **验收**：用户可配对、启停和查看连接；Background 重启后在授权范围内恢复；配置损坏/未来版本可见失败且不覆盖原数据；现有 DeepSeek++ 功能合同保持通过。
- **定向测试**：`npx vitest run tests/harness-bridge-settings.test.ts tests/background-runtime-handlers.test.ts tests/sidepanel-interactions.test.ts`。

## 6. Batch A：P2 out-of-tree DSH Adapter 与 Profile

### T2.1 实现 `deepseek-web` LlmAdapter

- **文件范围**：`packages/dsh-llm-deepseek-web/**`、`tests/dsh-llm-deepseek-web.test.ts`，以及精确依赖对应的根 `package.json`、`package-lock.json`。
- **前置**：T1.3。
- **实现技术**：只从 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/cordis` 正式 exports 导入；继承 `LlmAdapter`，注册唯一 provider `deepseek-web`，实现 provider/model metadata、保守 context 配置、`GenerateOptions` 序列化、broker event 到 `StreamChunk` 映射、AbortSignal 和稳定错误。`sessionId`、`purpose`、system/messages/tools 必须进入 request digest。provider retry policy 固定 `normal/maxRetries: 0`。reasoning event 依 T0.1 capability/policy 映射或丢弃，默认不进入 DSH stream；若未来允许进入临时消费面，必须另有不持久化证明。
- **明确禁止**：不得 import `@deepseek-ai/*/src/*`、修改 Harness core、注册直接 DeepSeek API adapter、读取 provider/API credential、默认开启或持久化 reasoning、自动重试 ambiguous request。
- **验收**：纯文本 fixture 可完成一次 DSH stream；错误/取消恰好一个 terminal finish；model list 可用但不暗示本地模型；测试证明环境不存在 `DEEPSEEK_API_KEY` 仍可加载 adapter。
- **定向测试**：`npx vitest run tests/dsh-llm-deepseek-web.test.ts`；该 workspace package 的 `npm run build --if-present`。

### T2.2 建立 allowlist 式独立 Harness Bundle/Profile

- **文件范围**：`packages/dsh-web-agent-bundle/**`、`tests/dsh-web-agent-bundle.test.ts`、Harness 精确版本锁对应的根 `package.json`、`package-lock.json`。
- **前置**：T2.1。
- **实现技术**：通过 `dsh.bundle.patch` 交付完整、独立 Cordis tree；本阶段只显式装配单轮闭环必需的 agent-loop、session/persistence、system-prompt、空 tools registry、checkpoint 和 T2.1 adapter。默认模型为 `deepseek-web/current-web-session`，模型请求串行。锁定审核过的 Harness 版本/commit 并在包内记录兼容范围；skills、compaction、subagent 和本地工具分别留给 T4.2/T4.5/T4.6 按 allowlist 增加。
- **明确禁止**：不得直接叠加官方 `dsh-base` 后再靠黑名单禁用；不得装配 `dsh-llm-deepseek`、`dsh-llm-pi-ai`、credential/model settings provider、telemetry、web-search provider、未审计 raw local shell；不得依赖 Harness `master`。
- **验收**：静态 composition fixture 只包含 allowlist；解析出的 provider 只有 `deepseek-web`；缺 Browser peer 时明确报告 unavailable，而不是回退其他模型；包可通过 `dsh plugin --profile deepseek-web-agent add <local-package>` 安装。
- **定向测试**：`npx vitest run tests/dsh-web-agent-bundle.test.ts`；该 workspace package 的 `npm run build --if-present`。

### T2.3 DSH 假模型单轮闭环

- **文件范围**：`tests/fixtures/dsh-web-agent/**`、`tests/dsh-web-agent-fake-e2e.test.ts`、`scripts/dsh-web-agent-fake-smoke.mjs`；仅为登记命令允许最小修改根 `package.json`。
- **前置**：T0.3、T2.2。
- **实现技术**：从实际 `dsh` 本机入口启动临时 profile，连接独立 fake browser peer，提交任务并等待 session durable flush；校验最终 assistant text 和持久 session 事件。进程启动必须使用固定 executable/args 与 `shell:false`。
- **明确禁止**：不得直接调用 adapter 绕过 dsh；不得使用真实网页、API Key 或网络；不得把测试 profile 写入用户真实 DSH_HOME。
- **验收**：一条命令完成 `dsh -> agent loop -> LlmAdapter -> socket -> fake peer -> final answer`；退出后临时 profile、进程和端口均可控释放；session 中无 reasoning/credential。
- **定向测试**：`npx vitest run tests/dsh-web-agent-fake-e2e.test.ts`；`node scripts/dsh-web-agent-fake-smoke.mjs`。

### Batch A 完整门禁

T0.1 至 T2.3 合并后只执行一次：

```text
npm run compile
npm test
```

门禁失败回流到拥有对应文件的任务，不在门禁任务中进行全仓重构或发行。

## 7. Batch B：P3 真实网页模型单轮

### T3.1 真实网页模型 opt-in 冒烟

- **文件范围**：`scripts/dsh-web-real-smoke.mjs`、`tests/real/dsh-web-single-turn.md`、`tests/real/fixtures/**`；仅为登记命令允许修改根 `package.json`。
- **前置**：T1.3、T2.3、Batch A 门禁。
- **实现技术**：提供不会进入默认 CI 的交互式 runner，预检当前登录页、Browser Broker 配对状态、Harness 精确版本、空模型/API 环境；从实际 dsh 入口提交一个不使用工具的稳定短任务，记录 request/session correlation 和最终文本哈希，不记录 prompt 全文、Cookie、Token 或 reasoning。
- **明确禁止**：不得为通过冒烟自动写入 API Key/provider；不得抓 Cookie、启动 CDP、调用官方 API、使用 MCP 模型工具或修改真实会话历史来伪造成功；不得把失败吞成 skip。
- **验收**：在人工明确 opt-in 时，网页模型返回可辨识终答，Host 端无模型配置且无 API Key；断言实际 provider 为 `deepseek-web`。这是工程联通证据，不是首个产品验收。
- **定向测试**：runner 的离线 preflight 单测；人工执行 `node scripts/dsh-web-real-smoke.mjs --confirm-real-web` 并保留脱敏结果。

## 8. Batch B：P4 工具多轮与真正 Harness 能力

### T4.1 冻结工具描述与 structured tool-call 映射

- **文件范围**：既有 `core/harness-bridge/deepseek-turn-adapter.ts`、`core/interceptor/streaming-tool-call-parser.ts`、`core/tool/xml-tags.ts` 与 `tests/harness-tool-wire.test.ts`；已有 schema/消息映射足够时不另建 adapter/parser。共享 parser 的严格检查必须默认关闭，只由模式 A 显式启用。
- **前置**：T3.1、T1.2、T2.1。
- **实现技术**：把 DSH tool schema 转为 DeepSeek++ 既有模型可见工具协议，复用现有 streaming XML/tool parser，并把结果映射成 DSH `tool-call` chunks。工具 ID 在 request 内稳定；未知工具、非法 JSON、重复调用 ID、半截 XML 和 parser overflow 显式失败。工具结果由 DSH 下一次模型请求提供，Browser 不执行本地工具。
- **明确禁止**：不得复制现有 tool parser；不得让 Browser 直接调用 MCP/Native tool 代替 Harness；不得在 parser 失败时把疑似工具文本静默当普通成功终答；不得改变现有 inline-agent prompt golden，除非独立兼容决策批准。
- **验收**：golden 覆盖一条模型 tool call、DSH tool result 和下一轮文本；分片边界任意变化不改变结构化结果；现有 DeepSeek++ tool parser 测试不回归。
- **定向测试**：`npx vitest run tests/harness-tool-wire.test.ts tests/tool-parser.test.ts tests/streaming-tool-call-parser.test.ts`。

### T4.2 装配官方 workspace-scoped 只读 DSH 工具

- **文件范围**：`packages/dsh-web-agent-bundle/cordis.readonly.patch.yml`、`src/readonly-policy.ts`、该 bundle 的 `package.json`/README 和 composition fixture、`tests/dsh-local-read-tools.test.ts`、官方工具精确依赖对应的 `package-lock.json` 条目；不改变已通过单轮的基础 patch，不创建 `packages/dsh-local-tools`。
- **前置**：T3.1、T2.2。
- **实现技术（2026-09-05 窄调整）**：锁定 `0.1.2-rc.1`。已由可复现 current-gap 测试确认：官方 fs-sandbox 的 read-only 模式只限制写入，不约束读取路径；官方 fs 工具一次注册 read/write/edit。首验只需官方 `read`，不加载需要子进程的搜索工具。编排层允许 bundle 内一个组合插件：官方私有 scope 装配原工具，仅把原生 read 定义发布到正式 registry；用官方 `tools/pre-execute` + 单调 `tools.guard` 执行准入，路径解析/包含判断全部复用官方 `canonicalPath`、`fs.resolve/contains`。可信 launcher 注入唯一临时 workspace。
- **明确禁止**：不得复制 FS 工具或路径算法，不得新增另一工具执行链；不得直接暴露 DeepSeek++ 的 local_file_read/MCP/Shell Host；不发布 mutation/shell/network 工具。新增官方缺口仍先回报编排，不自行扩大策略。此组合不是抵御恶意本机进程并发替换路径的 OS 沙箱。
- **验收**：registry 只有官方 read；临时文件可读，目录由官方工具拒绝；越界、静态 junction（含 session cwd 为 junction）、Windows 大小写/drive 变体均覆盖。工具输出保留官方格式，包含临时 fixture 的绝对路径；不得声称已隐藏所有路径。仅在生成的临时目录验收，不以真实用户项目作为安全测试目录。
- **定向测试**：`npx vitest run tests/dsh-local-read-tools.test.ts tests/dsh-web-agent-bundle.test.ts`；`npm run build --workspace packages/dsh-web-agent-bundle --if-present`。

### T4.3 假模型工具多轮 E2E

- **文件范围**：`tests/fixtures/dsh-web-agent/tool-loop/**`、`tests/dsh-web-agent-tool-loop.test.ts`、`scripts/dsh-web-agent-tool-smoke.mjs`。
- **前置**：T4.1、T4.2、T2.3。
- **实现技术**：fake peer 第一轮必须请求 T4.2 profile 实际发布的官方 DSH read 工具，Harness 执行并持久化 tool call/result，第二轮 fake peer 根据真实文件内容给出终答。断言模型请求次数、事件顺序、session log、tool evidence 和最终文本。
- **明确禁止**：不得在 fake peer 内直接读取 fixture 文件；不得跳过 Harness tool registry；不得根据 assistant 文本推断工具通过。
- **验收**：可证明本地 Agent loop 而非网页/MCP wrapper 执行了工具；未执行工具时测试必然失败；工具错误可被送回模型进行下一轮处理。
- **定向测试**：`npx vitest run tests/dsh-web-agent-tool-loop.test.ts`；`node scripts/dsh-web-agent-tool-smoke.mjs`。

### T4.4 首个真实产品验收

- **文件范围**：`scripts/dsh-web-readonly-acceptance.mjs`、`tests/real/dsh-web-readonly-acceptance.md`、`tests/real/fixtures/readonly-workspace/**`；允许把脱敏结论写入 `docs/progress/MASTER.md`，不得修改实现文件。
- **前置**：T3.1、T4.3。
- **实现技术**：runner 创建临时只读 fixture 和独立 profile，从真实 dsh 本机入口发任务，要求网页模型读取随机 nonce 文件并解释内容；收集 adapter route、模型请求、tool call/result、第二次模型请求和 session final 的相关 ID。
- **明确禁止**：不得人工把 nonce 贴给网页模型；不得调用任何本地/云模型或 API；不得预置包含答案的 prompt；不得以“网页回答了”代替本地工具执行证据。
- **验收**：必须完整证明 `dsh 本机入口 -> 网页 DeepSeek 模型 -> Harness 本地只读工具 -> 网页模型终答`，同时进程环境和 profile 中不存在模型 provider/API Key。该任务通过前，项目不得宣称达到用户目标。
- **定向测试**：离线 preflight；人工执行 `node scripts/dsh-web-readonly-acceptance.mjs --confirm-real-web`，保存脱敏 JSON evidence 和用户可读摘要。

### T4.5 装配官方受控写入、编辑与 PowerShell 工具

- **文件范围**：`packages/dsh-web-agent-bundle/cordis.patch.yml`、该 bundle 的 `package.json`/README/composition fixture、`tests/dsh-local-mutation-tools.test.ts`、`tests/dsh-local-exec-tools.test.ts`、官方工具精确依赖对应的 `package-lock.json` 条目。只有经失败测试和编排层确认上游扩展缺口后，才允许另行分派一个窄 `packages/dsh-web-policy-adapter/**`；本任务不得预设或创建它。
- **前置**：T4.4。
- **实现技术**：在 T4.2 的同一 profile 中装配审核锁版的官方 `@deepseek-ai/dsh-tool-str-replace-editor`、Windows `@deepseek-ai/dsh-tool-pwsh`、`@deepseek-ai/dsh-pwsh-local`/`@deepseek-ai/dsh-pwsh-sandbox`、`@deepseek-ai/dsh-fs-sandbox`、`@deepseek-ai/dsh-sandbox-local`、`@deepseek-ai/dsh-user-approval` 和相应 permission/sandbox-policy 服务。使用官方 effect boundary、workspace-write sandbox 与 ask approval；以 composition/golden 固定工具目录、权限和平台条件。若包名或依赖在锁版源码中不同，以锁版正式 package 名为准并在测试 fixture 中冻结。
- **明确禁止**：不得实现自有 FS/shell/process/policy；不得暴露 raw 宿主 shell、任意绝对 cwd/env、`danger-full-access`、未隔离 exec、模型可控提权或自动重放写入/命令；不得复制官方路径 guard。只有可复现测试证明官方扩展面缺少产品必要的策略 hook，才可回编排层批准窄 policy adapter，且不得实现工具本身。
- **验收**：实际 registry、sandbox mode 和 approval policy 与 allowlist fixture 完全一致；允许的 fixture 编辑/命令可验证，越界和未批准操作拒绝；超时/取消后官方 runner 的 owned process tree 退出；不确定副作用不会被 Agent 自动重放。
- **定向测试**：`npx vitest run tests/dsh-local-mutation-tools.test.ts tests/dsh-local-exec-tools.test.ts`。

### T4.6 启用 session、skills、compaction 与 subagent 合同

- **文件范围**：`packages/dsh-web-agent-bundle/cordis.patch.yml`、该包配置/README、`tests/dsh-web-harness-features.test.ts`、`tests/fixtures/dsh-web-agent/harness-features/**`。
- **前置**：T4.5。
- **实现技术**：启用审核过的 DSH session persistence/checkpoint、skill progressive load、tool result prune/compaction、in-process subagent。所有网页模型请求共用 broker scheduler 串行执行，并保留 `purpose` 和 child session identity；compaction/session-title 是显式辅助请求，不能伪装成主 turn。
- **明确禁止**：不得启动 Pi AgentSession；不得让 subagent 使用本地/云 fallback 模型；不得声称 P0 并发 subagent；不得在 Browser 离线时静默跳过 compaction 或伪造摘要。
- **验收**：fake peer fixture 覆盖 session resume、skill load、一次 compaction purpose 和一个串行 child agent；各 child 有独立 DSH session，所有模型调用 route 都是 `deepseek-web`。
- **定向测试**：`npx vitest run tests/dsh-web-harness-features.test.ts`。

### Batch B 完整门禁

T3.1 至 T4.6 合并后只执行一次：

```text
npm run compile
npm test
npm run prompt:freeze
npm run build:all
```

真实网页验收是独立 opt-in 证据，不得由默认测试假装替代。

## 9. Batch C：P5 断线、取消与恢复

### T5.1 Host 请求 Journal 与恢复状态机

- **文件范围**：`packages/dsh-web-model-transport/src/journal*.ts`、`src/request-state*.ts`、该包配置/exports、`tests/dsh-web-model-journal.test.ts`。
- **前置**：Batch B 门禁。
- **实现技术**：实现纯状态机 `planned -> dispatched -> accepted -> streaming -> completed|failed|aborted|ambiguous`；所有外部发送前持久化 planned，事件按 generation/sequence CAS 接受。恢复时只有明确 `not_started` 可重新调度；accepted 后失联必须 query 同 request ID，不能创建新请求。
- **明确禁止**：不得根据已有文本片段推断 completed；不得清除未来/损坏 journal；不得自动重放 ambiguous 请求；不得把 prompt、工具结果或凭证全文写日志。
- **验收**：每条转换有 unit test；非法倒退、双终态、错 generation 拒绝；进程在每个状态点崩溃的 fixture 可确定恢复或进入 ambiguous。
- **定向测试**：`npx vitest run tests/dsh-web-model-journal.test.ts`。

### T5.2 Browser 结果缓存、重连查询与会话核验

- **文件范围**：`core/harness-bridge/result-cache.ts`、`core/harness-bridge/recovery.ts`、`core/harness-bridge/session-map.ts`、`tests/harness-bridge-recovery.test.ts`。
- **前置**：T1.3、T5.1。
- **实现技术**：Browser 对已 accepted request 保存有界、版本化结果索引；重连后处理 `model.query`，返回 not_started/in_progress/completed/ambiguous。网页消息链推进与结果落盘采用明确 commit point；缓存 eviction 不得把已接受未知请求降级成 not_started。
- **明确禁止**：不得把完整 prompt/reasoning/credential 持久化；不得重新提交已 accepted request；不得用当前活动网页文本猜 request 所属关系。
- **验收**：断线前/ack 后/首 chunk 后/终态后四类重连 fixture 均得到稳定结果；旧 generation 晚到事件不能污染新请求；损坏缓存保留并 fail closed。
- **定向测试**：`npx vitest run tests/harness-bridge-recovery.test.ts`。

### T5.3 端到端取消、超时与晚到结果

- **文件范围**：`packages/web-model-protocol/src/cancel*.ts`、`packages/dsh-web-model-transport/src/cancel*.ts`、`packages/dsh-llm-deepseek-web/src/cancel*.ts`、`core/harness-bridge/cancel*.ts`、`tests/harness-bridge-cancel-e2e.test.ts`。
- **前置**：T5.1、T5.2。
- **实现技术**：AbortSignal 从 DSH adapter 传播到 Host transport 和 Browser turn；取消先持久化 requested，再发 `model.cancel`，等待 bounded acknowledgment。晚到 terminal 只能作为审计事实，不能把已取消 DSH turn 改回成功。timeout、user cancel、disconnect 和 browser abort 使用不同稳定错误。
- **明确禁止**：不得声称撤销已发送的网页请求或已写文件；不得无限等待浏览器 ack；不得把所有失败折叠为 transport error。
- **验收**：取消在 planned/accepted/streaming/terminal 后均幂等；socket、timer 和网页 turn 资源释放；late frame 不产生第二终态。
- **定向测试**：`npx vitest run tests/harness-bridge-cancel-e2e.test.ts`。

### T5.4 崩溃/断线综合恢复 E2E

- **文件范围**：`tests/fixtures/harness-bridge/recovery/**`、`tests/dsh-web-agent-recovery-e2e.test.ts`、`scripts/dsh-web-agent-recovery-smoke.mjs`。
- **前置**：T5.3、T4.6。
- **实现技术**：用子进程 kill、socket drop 和 service-worker restart fixture 覆盖主 turn、工具前后、compaction 和 child turn；重启同一临时 profile 后由 journal/query 决定继续、失败或 ambiguous。
- **明确禁止**：不得 mock 状态机内部返回值；不得在 fixture 中删除 journal 以制造成功；不得对有副作用工具做自动 replay。
- **验收**：所有场景只有一个可见终态；completed 有完整证据，ambiguous 明确要求人工检查；无 orphan dsh、shell、worker、socket 或端口。
- **定向测试**：`npx vitest run tests/dsh-web-agent-recovery-e2e.test.ts`；`node scripts/dsh-web-agent-recovery-smoke.mjs`。

### Batch C 完整门禁

T5.1 至 T5.4 合并后执行一次 `npm run compile && npm test`，并重跑 T4.4 的真实只读验收。此处不打包、不发布。

## 10. 独立 Integration Lane：PR #568

### I568.1 独立吸收和验证 PR #568

- **文件范围**：仅 PR #568 原始 diff 涉及的文件、其已有测试，以及必要时新增的 `tests/pr-568-integration.test.ts`；冲突解决不得修改 `packages/web-model-protocol/**`、`packages/dsh-web-model-transport/**`、`core/harness-bridge/**` 或 DSH adapter/profile，除非先回到编排层重新分派所有权。
- **前置**：可与 T0.1 至 T5.4 并行；若 PR 触及共享外部合同，则先读取 T0.1 golden，但不成为核心 Broker 的前置。
- **实现技术**：在独立 branch/worktree 复现 PR 自带验证，记录基线 commit，进行最小 rebase/cherry-pick 和兼容适配；只处理 PR 自身能力。
- **明确禁止**：不得以等待 PR #568 为理由阻塞 Broker、Adapter、真实验收或恢复；不得借该 lane 重写协议/transport；不得在此任务运行发行流程或全仓整改。
- **验收**：PR 自带定向测试和受影响现有测试通过，冲突和兼容结论可单独合并/撤回；若 PR 尚不可用，核心里程碑仍可继续并明确记录 deferred。
- **定向测试**：PR #568 声明的原始定向测试，加上 `npx vitest run tests/pr-568-integration.test.ts`（仅在确有集成合同需要时创建）。

## 11. Batch D：P6 安装、打包与发布

### T6.1 一键安装、Profile 初始化与安全配对

- **文件范围**：`scripts/install-dsh-web-agent.mjs`、`scripts/uninstall-dsh-web-agent.mjs`、`packages/dsh-web-agent-bundle/bin/**`、`packages/dsh-web-agent-bundle/README.md`、`tests/dsh-web-agent-installer.test.ts`；仅为登记命令允许修改根 `package.json`。
- **前置**：T5.4。
- **实现技术**：安装固定 Harness 版本与本仓库 out-of-tree packages，创建独立 profile 和高熵配对令牌，以显式用户步骤把令牌录入扩展；安装前后校验 package SHA/version/Node 版本。卸载只移除本产品拥有的 profile/package 链接，不碰用户其他 DSH profile 或浏览器数据。
- **明确禁止**：不得安装浮动 master/latest；不得自动读取浏览器 Cookie/Token；不得修改全局 provider/model/API 配置；不得递归删除宽泛目录。
- **验收**：全新临时 home 中可安装、doctor、启动、升级同版本和幂等卸载；错误 Node/Harness/package hash 立即停止且不留半安装 profile。
- **定向测试**：`npx vitest run tests/dsh-web-agent-installer.test.ts`；在临时 home 执行 installer dry-run/smoke。

### T6.2 安全与“无模型/API”发布断言

- **文件范围**：`tests/security/harness-bridge-security.test.ts`、`tests/security/harness-profile-no-provider.test.ts`、`tests/fixtures/harness-bridge/security/**`、`scripts/harness-release-policy-check.mjs`。
- **前置**：T6.1。
- **实现技术**：静态和动态断言 profile 不含 API/provider/telemetry fallback；检查监听地址、Origin/token、日志脱敏、绝对路径泄漏、frame/body limits、credential 环境注入、symlink/junction escape 和未授权 tool mutation。
- **明确禁止**：不得进行无边界全仓“顺便审计”；发现实现缺陷必须回流对应拥有任务；不得把警告降级为成功。
- **验收**：在设置伪 `DEEPSEEK_API_KEY`/provider credential 时仍不被读取；移除网页 peer 后明确失败；扫描发布包不含 token、Cookie、真实 home path、测试数据库或 session。
- **定向测试**：`npx vitest run tests/security/harness-bridge-security.test.ts tests/security/harness-profile-no-provider.test.ts`；`node scripts/harness-release-policy-check.mjs`。

### T6.3 候选包与真实安装验收

- **文件范围**：`scripts/package-harness-integration.mjs`、`scripts/release-assets-check.mjs`、`.github/workflows/release.yml`、`docs/releases/<version>.md`、`tests/dsh-web-agent-package.test.ts`。
- **前置**：T6.2、Batch C 门禁；I568.1 若未合并须明确标记 deferred，但不阻塞候选包。
- **实现技术**：产出扩展包、Host/adapter/profile 包、manifest、SBOM 和 SHA256；从候选包而非工作树安装到干净临时环境，执行 doctor、fake E2E 和 T4.4 真实只读验收。
- **明确禁止**：不得从工作树通过后宣称候选包通过；不得把真实 session/evidence secret 打入产物；不得在验收失败时继续发布。
- **验收**：候选包身份与源码 commit 一致；干净环境首个真实验收通过；卸载后没有产品拥有的后台进程或 profile 残留。
- **定向测试**：`npx vitest run tests/dsh-web-agent-package.test.ts`；候选包安装/卸载 smoke；真实 opt-in acceptance。

### T6.4 最终文档与完整门禁

- **文件范围**：`README.md`、`README_EN.md`、`docs/verification/**`、`docs/releases/<version>.md`、`docs/progress/MASTER.md`；只允许为门禁修复回流到原任务文件，不在本任务直接扩大代码范围。
- **前置**：T6.3。
- **实现技术**：写清 Node/浏览器/DeepSeek 登录/本机回环/安装测试环境，区分默认自动测试与真实 opt-in；公开文档只描述用户行为，不披露私有 endpoint、token 或内部攻击细节。
- **明确禁止**：不得宣称未执行测试通过；不得把 Native/MCP Sampling 写成当前能力；不得在收尾阶段新增协议或功能。
- **验收**：文档、manifest、版本、SHA 和实际命令一致；progress 中每个任务有 pass/fail/deferred 证据；最终门禁全部通过后才允许发布。
- **定向测试/最终完整门禁**：`npm run ci:quality`，所有新增 workspace package 的 build/test，候选包 policy check、fake E2E、恢复 smoke，以及人工 opt-in 的 T4.4 候选包验收。

## 12. 非 P0 备选，不进入当前依赖图

- **Native Messaging 模型 transport**：仅当 WebSocket 因浏览器平台政策不可维护时另立 ADR；不得与当前 transport 双写。
- **MCP Sampling**：仅当 DeepSeek++ 成为可验证的 Sampling client，且其 session/cancel/recovery 语义满足本计划后评估；不能退化为把本地工具交给网页。
- **多网页会话并发**：需要独立 conversation lease、调度、公平性和 rate-limit 证据；P0 subagent 只串行。
- **Harness core 上游增强**：只有公开扩展面确实无法表达需求时，才在 `XVSHIFU/deepseek-harness` topic branch 提交最小上游 PR；产品不得长期维护 core fork。
