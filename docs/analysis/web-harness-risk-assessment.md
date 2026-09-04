# Web Model Broker × 本机 DSH：风险评估

状态：P0 实现前风险基线

适用基线：`feature/web-harness@0a02c72b135bf2936e11aa78fd6136931ed65908`

日期：2026-09-04

## 风险结论

方案在工程上可行，主要风险不是“DSH 有没有 Agent loop”，而是跨浏览器进程模型 turn 的真实性、唯一性和恢复语义。DSH 已经提供完整 loop/session/tools 与公开 `LlmAdapter` seam；DeepSeek++ 已经提供可工作的网页请求、PoW 和流 codec。缺口是一个不泄露网页凭证、不会重放不确定请求、且能在 MV3 生命周期下稳定工作的本机双向 Broker。

P0 不应以“请求偶尔成功”为验收标准。以下四项任一未证实时，模式 A 必须保持未完成：

1. DSH 是唯一 Agent/tool/session owner，模式 B 不会暗中接管。
2. 网页 Token/Cookie/Authorization 不跨浏览器边界。
3. 浏览器中断后的请求能区分 `not_started`、确定终态和 `ambiguous`，不自动重放结果未知的生成。
4. DSH profile 中不存在 official API、Pi provider 或本地 LLM 的隐式 fallback。

## 信任边界和资产

```text
[本地用户 / DSH]
  session、workspace、tool policy、tool result、pairing secret
        |
        | 127.0.0.1 authenticated WebSocket
        | 允许：模型输入、规范化流、opaque correlation
        | 禁止：Cookie、Authorization、网页 Token、完整 headers
        v
[DeepSeek++ extension]
  browser auth、PoW、page chain、private protocol decoder
        |
        | HTTPS to chat.deepseek.com
        v
[DeepSeek Web]
```

需要保护的资产：

- 浏览器登录凭证、Cookie、Authorization、捕获 headers 和 PoW 中间信息。
- 配对密钥和本机 Broker 控制权。
- DSH workspace 内容、工具结果、session history 与操作授权。
- 网页会话链一致性、一次生成只提交一次的约束。
- DSH durable session 和本地工具副作用的真实状态。

本地文件内容或工具输出一旦被 DSH 选择进入模型上下文，就会发送给 DeepSeek Web。这是模式 A 的产品数据流，不是“只在本地运行”。UI/profile 必须明确显示 provider 目的地，并继续受 DSH workspace/approval 策略约束。

## 浏览器关闭和请求状态

跨进程协议必须在任何副作用前持久化 planned 状态，并把“Broker 接收请求”与“已开始向 DeepSeek Web dispatch”分开。仅凭 WebSocket response/chunk 缺失，不能证明请求未提交。

| 本机记录 | 浏览器事实 | 关闭/断线后的终态 | 允许动作 |
|---|---|---|---|
| `planned`，未见 dispatch marker | 扩展未开始网页请求或无法连接 | `not_started` / `waiting_for_browser` | DSH 可有界重试 |
| `dispatch_started` | 网页请求可能已被服务端接受 | `ambiguous` | 禁止自动重放；重连查询或用户显式重试 |
| 有部分 text/reasoning/tool delta，无终态 | 网页请求已产生输出 | `ambiguous`，保留部分结果但不能当 assistant completion | 禁止重放；不得执行未完整确认的 tool call |
| Broker journal 有唯一 terminal | 成功、失败或已确认取消 | 对账后恢复该终态 | 不重放，只补交遗漏事件/终态 |
| DSH 已请求 cancel | 远端可能仍已提交/产生内容 | `cancel_requested`，最终为 confirmed 或 ambiguous | cancel 幂等；不宣称远端回滚 |

浏览器完全关闭后：

- 新请求进入 `waiting_for_browser`，不能切 official API、本地模型或模式 B。
- 本机 DSH 进程、durable session 和已经在 DSH 执行的工具不被浏览器生命周期杀死。
- 活动模型 turn 按上述状态收口；没有确证终态就标 `ambiguous`。
- 浏览器重启后必须重新认证并取得新 connection lease；旧 request 的迟到事件按 lease + request ID + sequence 拒绝。
- Broker 只可重放有界 journal 中的**事件记录**，不可重新提交模型生成。

现有模式 B 已把“断流但没有 DeepSeek FINISHED patch”当错误，而不是正常完成（[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L199-L215)），并在已有流内容时拒绝 retry（[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L263-L319)）。模式 A 要保留此原则，但必须更保守：`dispatch_started` 以后即使尚无 chunk，也可能已经产生外部结果。

## 风险登记表

评分：影响/概率使用高、中、低；“门禁”是关闭风险所需的可执行证据，不是文档声明。

| ID | 风险 | 影响 | 概率 | 控制 | P0 门禁 |
|---|---|---:|---:|---|---|
| R1 | **双 loop / 双工具 owner**：同一输入同时进入 DSH 与浏览器 Pi loop，产生重复模型 turn 或工具副作用。 | 高 | 中 | 显式 Mode A/B 配置；每 request 带 mode/owner/lease；Mode A 禁止调用 `runAgentLoop` 和扩展 ToolRuntime；无自动 fallback。现有 Pi owner 位于 [`core/inline-agent/pi/loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L287-L403)。 | 集成测试证明一次输入只有一条 model/tool trace；Mode A 的扩展工具执行计数恒为 0。 |
| R2 | **网页登录凭证外传**：把 Authorization、Cookie、网页 Token、API key、header map 或 localStorage 数据带进普通 RPC、日志、错误。 | 高 | 中 | Browser-side `WebModelTurnPort` 返回 allowlist DTO；协议 codec 对**网页凭证**做 field/value denylist；日志结构化脱敏。hello 的 `pairing_token` 是合法协议密钥，只允许出现在认证消息且永不记录，不能被网页凭证 denylist 误拒。网页 Token 来源见 [`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L230-L264)、[`active-client.ts`](../../core/deepseek/active-client.ts#L596-L615)。 | 属性/fixture 测试对大小写、嵌套、错误 cause、trace 全量扫描；正向测试确认正确 `pairing_token` 可完成 hello，真实 E2E 抓取其后模型帧确认无任何凭证。 |
| R3 | **本机 Broker 被其他网页或进程调用**。回环地址不等于认证。 | 高 | 中 | 仅绑定 `127.0.0.1`；拒绝 `0.0.0.0`/`::`；校验 remote/Host/Origin；高熵配对密钥首消息认证、常量时间比较、短握手超时、连接/消息限流；token 不进 URL。 | attack tests：恶意 Origin、缺 Token、错 Token、DNS/Host 变体、超限、慢认证全部失败且无模型 dispatch。 |
| R4 | **生成重复提交或 page chain fork**，尤其在 WS 断线、超时、MV3 suspend 时。 | 高 | 中 | planned-before-dispatch；独立 `dispatch_started`；请求 ID + connection lease；唯一 terminal；post-dispatch 默认 ambiguous；禁止自动 replay。 | fault injection 覆盖每个 await/事件边界，统计 `submitPromptStreaming` 每 request 最多一次。 |
| R5 | **把部分输出当完成**，导致 DSH 执行不完整工具调用或错误停止。 | 高 | 中 | 只有 DeepSeek `finished` + protocol terminal 才映射 DSH finish；partial tool call 不产生 executable `block-end`；断流归 ambiguous/error。现有 fail-closed 事实见 [`deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L201-L217)。 | 截断每个 SSE/XML/WS frame；断言无成功 finish、无工具执行。 |
| R6 | **乱序、重复、迟到流事件**破坏 DSH `StreamChunk` 结构。 | 高 | 中 | 每 request 单调 sequence、block index state machine、唯一 terminal、finish 后拒绝；重连更换 lease。DSH stream 约束见 [DSH `types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/types.ts#L356-L376)。 | golden/property tests 覆盖 duplicate、gap、reorder、finish-after-finish、delta-before-start。 |
| R7 | **DSH 默认 provider 泄漏**：base profile 仍可选 official/pi-ai，环境中恰有 key 时静默改走 API。 | 高 | 高 | 专用 profile 覆盖 `agent-default-model` 并禁用其他 adapter；启动时断言 provider inventory 只有 `deepseek-web`；不读取 API env。默认路径见 [base bundle lines 73–109](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/bundle/base/cordis.patch.yml#L73-L109) 和 [lines 493–498](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/bundle/base/cordis.patch.yml#L493-L498)。 | 无 API key 和伪造 API key 两种环境启动；两者都只能出现/调用 `deepseek-web`，任何 fallback 直接失败。 |
| R8 | **MV3 service worker/WebSocket 生命周期不稳定**：background suspend、浏览器升级或后台节流断开长流。 | 高 | 中 | WebSocket 心跳与明确 idle timeout；按支持浏览器验证；活动请求期间保活必须基于浏览器支持的事件，不使用无界 busy timer；断线遵循 ambiguous 语义。当前 background 已在组合 web submitter，见 [`entrypoints/background.ts`](../../entrypoints/background.ts#L315-L340)。 | Chrome/Edge/Firefox 构建 + 真实长流/最小化/锁屏/worker restart 场景；未验证浏览器不得标 supported。 |
| R9 | **网页私有协议、PoW 或模型 ID变化**。 | 高 | 高 | 只复用 active-client/stream-codec；Broker 公共协议不暴露私有 patch；启动 capability handshake；网页 smoke canary 与显式版本兼容矩阵。 | fixture replay + 真实无工具 E2E；未知 model/capability fail closed。 |
| R10 | **DSH developer-preview API 漂移**破坏 adapter/profile。 | 高 | 高 | 锁 DSH `0.1.2-rc.1` + commit + tarball SHA；adapter 仅依赖公开 `@deepseek-ai/dsh-llm`/Cordis seam；升级单独任务。DSH 自身警告兼容性破坏：[README lines 11–15](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/README.md#L11-L15)。 | 针对每个受支持精确版本跑 adapter contract、profile dump、mock bridge 和 L6 E2E。 |
| R11 | **工具 schema/调用格式不匹配**：DSH 原生 tool schema 与 DeepSeek++ direct XML grammar 不一致。 | 高 | 中 | 一个 provider-neutral renderer + streaming parser；名字映射可逆；raw JSON arguments 保留；禁止 Node/browser 两份 grammar。格式事实见 [`core/prompt/augmentation.ts`](../../core/prompt/augmentation.ts#L168-L184) 与 [`core/interceptor/streaming-tool-call-parser.ts`](../../core/interceptor/streaming-tool-call-parser.ts#L200-L288)。 | golden 覆盖特殊字符、Windows 路径、空对象、超大/残缺 JSON、同名冲突、多 tool call、tool result 续轮。 |
| R12 | **网页 chain 与 DSH session 双重真源**，恢复后上下文重复或分叉。 | 高 | 中 | DSH session log 是唯一 model-visible history；网页 ID 仅为 opaque adapter replay state；adapter generation/model/connection 不匹配时拒绝 replay。DSH session 真源见 [architecture lines 103–107](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L103-L107)。 | 崩溃恢复、fork、新 session、模型变更测试；相同 DSH log 可重建同一 broker request。 |
| R13 | **backpressure/内存耗尽**：网页、WS、adapter 任一方生产快于消费，或消息过大。 | 高 | 中 | 帧/请求/累计 stream/tool arguments/terminal journal 全部有硬上限；bounded queue + high-water mark；慢消费者中止且 post-dispatch ambiguous；不缓存完整 raw SSE。 | 超大 reasoning/text/tool payload 和慢 reader 压测；内存上界与稳定错误码可观测。 |
| R14 | **取消语义虚假**：本地报告 canceled，但网页请求或本地工具仍在执行。 | 高 | 中 | DSH 记录 cancel intent；AbortSignal 贯穿 adapter/WS/active-client；浏览器只报告 confirmed/ambiguous；工具取消完全归 DSH。`submitPromptStreaming` 接受 signal：[`active-client.ts`](../../core/deepseek/active-client.ts#L419-L447)。 | cancel-before-dispatch、during-PoW、during-stream、during-DSH-tool、late-terminal 全部 fault test。 |
| R15 | **本地敏感数据被模型发送到云端**，用户误以为“本地 Agent”等于“数据不出机”。 | 高 | 中 | UI/profile 明示 DeepSeek Web 是远程推理端；沿用 DSH workspace/approval/ignore；工具结果按最小必要性入模；审计发送摘要而非 secret。 | 首次启用确认、敏感 fixture、拒绝工作区外读取；用户可检查每个 model-visible event。 |
| R16 | **浏览器 chunk 被 Node/DSH 依赖污染**，导致构建体积、CSP 或运行时失败。 | 中 | 中 | protocol 纯数据；browser package 禁止 Node/DSH imports；adapter 独立 build/pack；依赖图预算。DPP 使用 TS7/WXT，而 DSH 有 [Host/Client 分离构建](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/development.md#L44-L80)。 | bundle analyzer/forbidden-import test + Chrome/Edge/Firefox build。 |
| R17 | **配对密钥生命周期失控**：日志泄漏、永不过期、多个扩展共享。 | 高 | 中 | OS 用户范围随机 secret；显示一次、可轮换/撤销；不随 profile export；认证后绑定 extension install identity/capability；日志只记 key id/hash prefix（非 secret）。 | rotate/revoke/reconnect tests；磁盘与日志 secret scan。 |
| R18 | **状态 journal 自身包含 prompt/credential 或无限增长**。 | 高 | 中 | journal 只保存 request ID、phase、sequence、terminal、opaque chain handle 和必要 hash；有 TTL/数量/字节上限；不保存 raw request/header。 | storage schema/golden + quota/eviction/restart tests。 |
| R19 | **网页模型不原生支持 DSH option**，adapter 静默忽略 temperature/stop/images 等字段。 | 中 | 高 | capability handshake；无法忠实支持的 `GenerateOptions` 按 DSH 规范抛 `UNSUPPORTED_OPTION`，不降级。规范见 [DSH LLM adapter cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/cookbook/adding-an-llm-adapter.md#L25-L40)。 | 每个 option 的 supported/unsupported contract；无 silent drop。 |
| R20 | **观测数据泄露 chain-of-thought 或完整 workspace path**。 | 高 | 中 | reasoning 只按产品策略进入当前 DSH stream，不写普通日志；日志使用 correlation ID、相对/哈希路径和稳定错误码；关闭 raw frame debug。 | log snapshot secret/path/reasoning scan；production build 断言 debug frame recorder 不存在。 |

## 关键实现风险的具体处理

### 1. 不复用模式 B 的 retry owner

模式 B 的 `submitWithRetry` 在“尚未收到 chunk”时允许一次 retry（[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L263-L319)）。跨进程模式 A 中，WebSocket 断线可能发生在网页请求已提交、首个 chunk 尚未传回本机的窗口。直接复用该 retry 会重复提交。

模式 A Browser Broker 应调用单次 `submitPromptStreaming`，通过自己的 planned/dispatch/terminal state machine报告事实；是否重试由 DSH adapter 根据明确的 `external_outcome=not_started` 决定。`dispatch_started` 后默认 ambiguous。

### 2. Tool call 只是模型输出，不是浏览器工具执行

DeepSeek Web 不提供与 DSH 相同的原生 function-calling wire。现有 DeepSeek++ 用 direct XML tag 指导模型，并通过 streaming parser 恢复工具调用（[`core/prompt/augmentation.ts`](../../core/prompt/augmentation.ts#L168-L184)、[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L117-L176)）。模式 A 可以复用这套 grammar/parser，但 browser event 到 DSH `tool-call-delta` 的转换必须严格测试。

浏览器端到此为止。它不得调用 [`core/inline-agent/pi/tool-bridge.ts`](../../core/inline-agent/pi/tool-bridge.ts#L113-L145) 或扩展 ToolRuntime；DSH 收到完成且合法的 tool call 后才执行本地工具。

### 3. 回环 WebSocket 的浏览器差异

当前 manifest 包含 Native Messaging、tabs/debugger 等权限和通用 optional HTTP(S) host permissions，但没有本项目特定的 loopback WebSocket 声明（[`wxt.config.ts`](../../wxt.config.ts#L54-L94)）。不能只凭 Chrome 开发模式成功就推断 Edge/Firefox 一致。

实现前 spike 必须回答：

- 三个目标浏览器是否允许 extension background 连接 `ws://127.0.0.1:<port>`，需要何种 host/CSP 配置。
- 活动模型 stream 时 service worker 是否会 suspend；心跳周期是否满足平台约束。
- 企业策略、代理/VPN、IPv6 优先或安全软件是否会改写/拦截回环连接。
- unpacked/商店安装时 Origin/extension ID 如何稳定绑定，而不使用通配 Origin。

结论写入 capability matrix；未通过的浏览器不进入 P0 supported 列表。P0 服务仍只监听 IPv4 `127.0.0.1`，不得为兼容性改成 `0.0.0.0`。

### 4. DSH 版本和 profile

DSH 的公开 seam 足以避免 core fork：[`LlmAdapter.stream()`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L187-L275) 是必需方法，[`ctx.llm.registerAdapter`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L372-L396) 是 provider 注册点，[profile](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/boot/app-boot/src/profile.ts#L1-L22) 支持 out-of-tree dependencies。

真正风险是默认 base profile 已注册 official/pi-ai 路径。专用 bundle 必须覆盖默认模型并禁用这些 adapter；启动自检失败时应拒绝运行，而不是发警告继续。安装使用精确 npm/`.tgz` + integrity；不引入 submodule，不改 DSH `master`。

## PR #568 风险边界

[DeepSeek++ PR #568](https://github.com/zhu1090093659/deepseek-pp/pull/568) 截至 2026-09-04 仍 open、未合并，base 为 `0a02c72`，head 为 `24c713abced265ad60bb69af0149b90c19d7a49f`。它聚焦 Windows Shell 和本地文件工具，并触及 `core/mcp/client.ts`；它没有实现模型 Broker 或 DSH adapter。

风险控制：

- 不把 PR #568 merge/cherry-pick 到首个 Mode A 纵向闭环。
- 新 Broker 不改 `core/mcp/client.ts`，避免无关热点和误把 MCP 当模型通道。
- 若模式 B 后续需要其 PowerShell 7、文件快照/分页思想，使用独立 integration 分支、独立测试和独立提交。
- 不复制 PR 中允许绝对路径或 home-relative 路径的模型可见合同到 DSH 工具层；模式 A 服从 DSH 自己的 workspace/sandbox policy。

## 非目标和风险接受边界

以下能力不在 P0；不得用它们规避上表风险：

- 公网、LAN、`0.0.0.0` 或尚未完整验证的 `::1` Broker。
- MCP Sampling、Native Messaging、external extension messaging、CDP 或 UI 自动化替代 WebSocket。
- Cookie/Token 导出、OpenAI-compatible 假接口或网页登录转 API key。
- 浏览器关闭时切换官方 API、本地 LLM、Pi provider 或模式 B。
- DSH core fork、git submodule、复制 Agent loop/session/tool registry。
- Mode A 在扩展端执行本地工具，或 Mode B 通过 DSH adapter 绕道执行。
- 自动重试 `dispatch_started`/ambiguous 模型 turn。
- 远程多用户、移动浏览器、发布商店和 PR #568 集成。

## 风险关闭顺序

1. 先冻结 protocol codec、网页凭证 denylist（明确允许 hello `pairing_token`）、request state machine 与 fake-peer fault tests。
2. 再证明三浏览器至少一个目标环境可稳定建立认证回环 WebSocket，并完成单次无工具流。
3. 再接 DSH `LlmAdapter`，验证唯一 provider、StreamChunk 顺序、取消和 browser-close 语义。
4. 再接一个只读 DSH 工具回合，证明工具只执行一次且结果进入下一模型 step。
5. 最后才扩展浏览器矩阵、tool grammar 边界和恢复窗口。

若步骤 2 证明目标浏览器无法在可接受权限/生命周期下稳定维持回环 WebSocket，应停止实现并提交新的 ADR；不得静默改成凭证导出、CDP 或公网服务。
