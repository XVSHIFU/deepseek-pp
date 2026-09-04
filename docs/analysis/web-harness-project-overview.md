# Web Model Broker × 本机 DeepSeek Harness：项目总览

状态：方案事实基线，尚未实现

适用基线：`feature/web-harness@0a02c72b135bf2936e11aa78fd6136931ed65908`

日期：2026-09-04

## 结论

本项目可以实现“本机 DeepSeek Harness（DSH）是完整 Agent，DeepSeek 网页是它唯一的模型层”，但 `0a02c72` 当前还没有这条跨进程模型通道。实现必须新增两个窄适配面：DeepSeek++ 中的浏览器模型 Broker，以及 DSH 的 out-of-tree `LlmAdapter`。DSH 的 loop、session、context、tools、Skill、subagent、恢复和取消机制保持主控；DeepSeek++ 只执行必须留在浏览器内的登录态、PoW、网页会话和流解码。

这一定义对应两种明确隔离的运行模式：

- **模式 A（新主线）**：本机 DSH 拥有 Agent authority；DeepSeek++ 只提供网页模型 Broker。
- **模式 B（现有兼容能力）**：DeepSeek++ 在浏览器内运行 Pi loop，并调用扩展现有工具。

模式 A 不是“给网页 DeepSeek 暴露几个本机工具”，也不是从本地遥控模式 B。模式 A 的工具选择、执行、结果持久化和下一步决策全部发生在 DSH；浏览器只完成一个个模型 turn。

## 源码确认的当前事实

| 事实 | 证据 | 对方案的约束 |
|---|---|---|
| DeepSeek++ 当前版本为 `1.14.0`，工作区接受 `packages/*`。 | [`package.json`](../../package.json#L2-L9) | 可在当前主仓库维护独立集成包，不需要把 DSH 源码嵌入仓库。 |
| 现有模式 B 已由 Pi `runAgentLoop` 驱动，并将模型流、工具调用和 `AGENT_*` 事件连成循环。 | [`core/inline-agent/pi/loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L1-L32)、[`core/inline-agent/pi/loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L405-L556) | 这是浏览器拥有 loop 的兼容能力，不能当作模式 A 的本地 Harness。 |
| `deepseek-web` Pi provider 是无状态注册/委托对象，真实网页行为委托给既有 StreamFn。 | [`core/inline-agent/pi/deepseek-web-provider.ts`](../../core/inline-agent/pi/deepseek-web-provider.ts#L1-L28)、[`core/inline-agent/pi/deepseek-web-provider.ts`](../../core/inline-agent/pi/deepseek-web-provider.ts#L41-L108) | 可参考其模型目录与事件映射，但模式 A 不导入或启动 Pi loop。 |
| 网页请求已经有唯一实现：浏览器内读取登录态、生成 PoW、提交请求并用统一 codec 解码 SSE。 | [`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L177-L247)、[`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L419-L447)、[`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L533-L584)、[`core/deepseek/stream-codec.ts`](../../core/deepseek/stream-codec.ts#L53-L89) | Broker 必须注入并复用这条权威路径；不得复制私有 HTTP、PoW、Token 或 SSE 代码。 |
| 登录 Token 来自网页 `localStorage`，捕获的 Authorization 也只在扩展存储内使用。 | [`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L250-L287)、[`core/deepseek/active-client.ts`](../../core/deepseek/active-client.ts#L596-L615) | Broker 协议严禁传输 Cookie、Authorization、Token、完整请求头或浏览器存储。 |
| 当前 MCP client 不声明 sampling 等客户端能力，只实现 initialize/list/call。 | [`core/mcp/client.ts`](../../core/mcp/client.ts#L65-L82)、[`core/mcp/client.ts`](../../core/mcp/client.ts#L134-L193)、[`core/mcp/types.ts`](../../core/mcp/types.ts#L206-L241) | 不能用现有 MCP Sampling 让本地 Harness 主动请求网页模型。 |
| MCP transport 会校验但丢弃 server request；测试明确用 `sampling/createMessage` 固定了该行为。 | [`core/mcp/transports/common.ts`](../../core/mcp/transports/common.ts#L349-L369)、[`tests/mcp-transport-common.test.ts`](../../tests/mcp-transport-common.test.ts#L202-L219) | 模式 A 不复用或偷偷扩大现有 MCP client。 |
| Native Messaging transport 只将本扩展发起的 request 关联到 pending response，未匹配的 host 消息不会成为模型请求。 | [`core/mcp/transports/native.ts`](../../core/mcp/transports/native.ts#L43-L74)、[`core/mcp/transports/native.ts`](../../core/mcp/transports/native.ts#L96-L139) | 当前 Native Host 不是双向模型 Broker；P0 也不把它改造成一个。 |
| 浏览器内部 runtime message 只信任同一扩展和 DeepSeek 顶层 content document。 | [`core/messaging/runtime-boundary.ts`](../../core/messaging/runtime-boundary.ts#L117-L182)、[`core/messaging/runtime-boundary.ts`](../../core/messaging/runtime-boundary.ts#L236-L243) | 内部 `CHAT_SUBMIT_PROMPT` 不是本地进程 API，不能对外声称已有模型入口。 |
| 模式 B 的持久化是 trace 恢复，不是 Agent loop 恢复；重载时 `running` 被转为停止/错误显示。 | [`core/inline-agent/trace-store.ts`](../../core/inline-agent/trace-store.ts#L10-L57)、[`entrypoints/content.ts`](../../entrypoints/content.ts#L6462-L6508) | 真正 durable session/recovery 必须由模式 A 的 DSH 提供。 |

因此，未修改的 DeepSeek++ **不能**让本机 DSH 主动把网页 DeepSeek 当作 `LlmAdapter` 调用；它当前能提供的是模式 B。模式 A 需要新增 Broker，但不需要改 DSH core。

## 目标所有权

| 能力 | 模式 A 的唯一 owner | DeepSeek++ Broker 的职责 |
|---|---|---|
| Agent loop、步进与停止条件 | DSH | 无 |
| 上下文构造、压缩和系统提示 | DSH | 接收一次已组装的模型请求，不另建 Agent 上下文 |
| durable session、恢复、fork | DSH | 只保留有界的请求关联、网页链映射和确定终态 |
| 工具目录、授权、执行、结果 | DSH | 不执行 DSH 工具；只把网页模型输出规范化为文本、reasoning 和 tool-call 流 |
| Skill、subagent、工作流 | DSH | 无 |
| 网页登录态、网页 Token/Cookie | 浏览器 | 本地永远不可见 |
| DeepSeek PoW、私有请求、SSE 解码 | DeepSeek++ | 复用 `active-client.ts` 与 `stream-codec.ts` |
| 跨进程请求关联、流、取消、状态查询 | 共享协议 | 两端都做严格 Schema、版本和状态校验 |

模式 B 继续由 [`core/inline-agent/pi/loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L192-L303) 和 [`core/inline-agent/pi/tool-bridge.ts`](../../core/inline-agent/pi/tool-bridge.ts#L39-L63) 拥有浏览器内 Pi loop/工具适配。模式 A 与模式 B 不得同时拥有同一 turn、共享可写 session 状态或相互静默回退。

## 模式 A 的固定控制流

```text
DSH session / agent loop / tools
  -> out-of-tree deepseek-web LlmAdapter
  -> 本机 WebSocket 服务（只监听 127.0.0.1）
  <- DeepSeek++ background 主动建立并认证连接
  -> JSON-RPC 2.0 generate request
  -> DeepSeek++ WebModelTurnPort
  -> active-client（headers + PoW + request）
  -> stream-codec（SSE -> text/reasoning/finished/message ids）
  -> 有序 JSON-RPC 流事件
  -> LlmAdapter StreamChunk
  -> DSH 记录 assistant/tool call，执行本地工具并进入下一 step
```

WebSocket 是一条双向连接：本机进程是仅回环监听端，扩展是建连端；认证后，本机端可以在同一连接上向扩展发起 `generate`/`cancel`/`status` 请求，扩展返回有请求 ID 和单调序号的流事件。应用层为严格 JSON-RPC 2.0；协议版本独立于软件版本，P0 从 `schema_version: 1` 开始。

首条应用消息完成认证。高熵配对密钥不放在 URL、query string、WebSocket 子协议或日志中。服务端按 remote address、Host、Origin、协议版本、认证、消息大小和 Schema 逐层拒绝。任何未知字段、未知版本、乱序事件、重复终态或过期 connection lease 都失败关闭。

### 一个 DSH step

1. DSH 从 durable session 派生 `GenerateOptions`，其中包含 messages、system、tool schemas、`sessionId` 和 `AbortSignal`。契约见 [DSH `types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/types.ts#L356-L417)。
2. out-of-tree adapter 将该请求映射成网页模型可接受的文本/工具调用格式，发送不含浏览器凭证的 Broker request。
3. 扩展在写入 planned/accepted 状态后调用既有 `submitPromptStreaming`。它直接复用单次请求路径，而不复用模式 B 的整个 Pi loop。
4. 扩展流式返回 reasoning、文本、tool-call 和终态。现有 XML 工具解析器可作为浏览器端规范化组件复用；它只解析调用，不执行工具（[`core/interceptor/streaming-tool-call-parser.ts`](../../core/interceptor/streaming-tool-call-parser.ts#L20-L36)、[`core/interceptor/streaming-tool-call-parser.ts`](../../core/interceptor/streaming-tool-call-parser.ts#L200-L288)）。
5. adapter 映射为 DSH `StreamChunk`。`usage` 必须先于唯一 `finish`，`finish` 后不得再发事件；具体约束见 [DSH `types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/types.ts#L356-L376)。
6. 若有工具调用，DSH 自己授权并执行工具、持久化结果，再由 DSH loop 发起下一次模型请求。

网页链 ID 不是 DSH session 真源。它只能作为 adapter 的 opaque replay state/浏览器侧关联存在；DSH 的模型可见历史必须仍可从其 session log 重建。DSH 已为 provider-native replay metadata 提供 `finish.replayState`，其要求见 [DSH LLM adapter cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/cookbook/adding-an-llm-adapter.md#L25-L40)。

## 为什么不改 DSH master

DSH 的公开架构已经覆盖所需扩展点：模型 adapter、tool registry、session log 和 agent loop 都是可替换插件；profile 可安装 out-of-tree plugin。证据见：

- [DSH architecture lines 9–29](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L9-L29)：everything-is-a-plugin、profile 和 bundle。
- [DSH architecture lines 49–62](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L49-L62)：session、system prompt、tools、agent、agent-loop、llm 的责任。
- [DSH architecture lines 74–107](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L74-L107)：模型请求、工具执行与 durable session log 的完整 turn flow。
- [DSH architecture lines 119–143](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L119-L143)：新增 provider 的正式机制是注册 `ctx.llm` adapter。
- [DSH `LlmAdapter`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L187-L274)：公共类与唯一必需的 `stream()` 方法。
- [DSH `registerAdapter()`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L372-L396)：公开 provider 注册点。
- [DSH profile implementation](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/boot/app-boot/src/profile.ts#L1-L22)：profile 原生支持 out-of-tree plugin dependency。

因此 adapter 作为 DeepSeek++ 仓库中的独立可打包模块交付，再通过 DSH profile 安装。DSH fork 的 `master` 保持精确镜像上游；不添加 git submodule，不复制 DSH loop/session/tools 源码。只有实际 PoC 证明公共 seam 缺失，才另开 DSH feature branch 提交最小、可上游补丁。

## 浏览器关闭与断线语义

P0 的模型可用前提是：浏览器、DeepSeek++ 扩展和至少一个已登录且就绪的 DeepSeek 页面均存活。浏览器最小化或转到后台可以继续；浏览器完全关闭后没有模型 fallback。

| 断点 | DSH 所见结果 | 是否可自动重试 |
|---|---|---|
| 尚未发出远端 dispatch marker | `waiting_for_browser` 或 `browser_unavailable`，外部结果为 `not_started` | 可以按 DSH 有界策略重试 |
| 已标记 dispatch started，但尚无可靠终态 | `ambiguous`；保留 DSH session 与部分流，等待重连/人工决定 | 不可以 |
| 扩展已持久记录唯一成功/失败终态 | 重连后 `status` 可恢复确定终态 | 不重放，只补收终态 |
| 用户取消 | DSH 先记录取消，再发 best-effort cancel；远端已提交内容不宣称回滚 | 取消本身幂等；生成不自动重放 |

浏览器关闭不得终止本机 DSH 进程、删除 DSH session 或伪造 `finish`。已经由 DSH 启动的本地工具仍由 DSH 的正常取消/完成规则处理。重连必须重新握手并取得新 connection lease；旧连接的迟到事件一律拒绝。

模式 B 当前的流处理已经证明“有输出后断流不能当完成”，并避免在已收到流后重放网页 turn（[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L199-L215)、[`core/inline-agent/pi/deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L263-L319)）。模式 A 将这一安全原则提升为跨进程显式状态，但不直接复用模式 B 的 `submitWithRetry`，因为 Mode A 的 retry authority 属于 DSH。

## 版本锁与交付边界

| 项目 | P0 锁定值 |
|---|---|
| DeepSeek++ | `1.14.0`，起点 commit `0a02c72b135bf2936e11aa78fd6136931ed65908` |
| DeepSeek Harness | `0.1.2-rc.1`，上游/fork commit `76fda729799fe9b3848dbe2c211d4b231032b81e` |
| Node.js | 24 LTS；[DSH `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/package.json#L7-L10) 声明 `^22.19.0 || >=24.0.0` |
| 模式 B Pi | `@earendil-works/pi-agent-core` / `pi-ai` `0.83.0`（[`package.json`](../../package.json#L52-L79)）；模式 A 不依赖它们 |
| Broker 协议 | `schema_version: 1`，双方握手精确协商 |
| DSH 直接 peer（如使用） | `@deepseek-ai/cordis` `4.0.2`、`@deepseek-ai/schemastery` `3.18.2`；优先由精确锁定的 DSH 安装提供 |
| 协议关键依赖 | 精确版本和 lockfile/tarball SHA；禁止 `^`/`~` 漂移 |

DSH 自身注明处于 developer preview 且可能发生兼容性破坏，见 [DSH README](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/README.md#L11-L15)。每次升级必须单独完成 adapter API、stream vocabulary、profile loading 和真实网页 E2E 的兼容矩阵，不得随 DeepSeek++ 普通依赖更新一起漂移。

### PR #568 边界

[DeepSeek++ PR #568](https://github.com/zhu1090093659/deepseek-pp/pull/568) 在 2026-09-04 为 open、未合并，base 是本项目基线 `0a02c72`，head 为 `24c713abced265ad60bb69af0149b90c19d7a49f`。其范围是 Windows Shell 与本地文件工具改进，包括 `core/mcp/client.ts` 等文件；它不提供 WebSocket 模型 Broker、DSH adapter、网页登录代理或 session/loop 集成。

- 模式 A 的本地工具由 DSH 拥有，所以 PR #568 不是依赖，不 merge/cherry-pick 到首个闭环。
- 它与 `core/mcp/client.ts` 有热点重叠；固定的 WebSocket 方案应避开该文件。
- 模式 B 日后可以在独立分支评估其 PowerShell/文件改进，但必须独立测试和提交。

## 首个可验证产品闭环

只有以下全过程真实完成，才能声称模式 A 已实现：

1. 本机 DSH 以唯一 provider `deepseek-web` 启动，环境中没有 DeepSeek API key、Pi provider 或本地 LLM fallback。
2. 用户从 DSH 会话输入仓库任务。
3. 第一次模型请求经本机认证 WebSocket、DeepSeek++ 和已登录网页返回。
4. 网页模型产生一个 DSH tool call；DSH 只执行一次最小只读工具并持久化结果。
5. DSH 发起下一模型 step，工具结果进入同一 DSH session，最终答案返回 DSH。
6. 默认离线测试覆盖握手、Schema、流排序、取消、重连、浏览器离线、ambiguous、凭证禁传和重复终态；真实网页 E2E 必须显式 opt-in。

## 非目标

- 不把 DeepSeek 网页伪装成 OpenAI/官方 DeepSeek API。
- 不导出 Cookie、Token、Authorization、完整请求头或浏览器 profile。
- 不用 CDP、Playwright、页面点击脚本、MCP Sampling 或 Native Messaging 作为 P0 模型传输。
- 不让 DeepSeek++ 执行模式 A 的本地工具，也不建立第二套工具授权/sandbox。
- 不启动模式 A 的 Pi `AgentSession`，不读取 Pi provider/model 配置。
- 不修改 DSH `master`，不引入 DSH git submodule，不复制其 harness 核心。
- 不做公网/局域网监听、多用户远程 Broker、移动端或无浏览器离线模型。
- 不把 PR #568、发布包装或无关重构塞进首个纵向闭环。
