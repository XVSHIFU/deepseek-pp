# Web Harness 模块清单与集成边界

状态：实现前模块清单

基线：`feature/web-harness@0a02c72b135bf2936e11aa78fd6136931ed65908`

本清单区分三类内容：DeepSeek++ 已有且应复用的模块、DeepSeek Harness 已公开的扩展 seam，以及模式 A 必须新增的最小模块。标记为“planned”的内容在当前基线不存在。

## 1. 基线与锁定输入

| 输入 | 锁定 | 证据/说明 |
|---|---|---|
| DeepSeek++ | `1.14.0` / `0a02c72b135bf2936e11aa78fd6136931ed65908` | [`package.json`](../../package.json#L2-L9) |
| DeepSeek++ package manager/build | npm workspaces，WXT，TypeScript `^7.0.2` | [`package.json`](../../package.json#L8-L15)、[`package.json`](../../package.json#L60-L73) |
| DeepSeek Harness | `0.1.2-rc.1` / `76fda729799fe9b3848dbe2c211d4b231032b81e` | [固定 commit 的 `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/package.json#L2-L17)；正式依赖还必须记录 tarball integrity |
| DSH package manager/runtime | pnpm `11.7.0`；Node `^22.19.0 || >=24.0.0` | [固定 commit 的 `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/package.json#L7-L17)；本项目选 Node 24 LTS |
| DSH build/peer | TypeScript `6.0.3` 系列；Cordis `4.0.2`；Schemastery `3.18.2` | [DSH root manifest](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/package.json)、[Cordis manifest](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/vendor/cordis/package.json#L1-L5)、[Schemastery manifest](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/vendor/schemastery/package.json#L1-L5)；adapter 若直接声明 peer 必须精确匹配 |
| 模式 B Pi | `@earendil-works/pi-agent-core` 和 `pi-ai` `0.83.0` | [`package.json`](../../package.json#L52-L79)；只属于模式 B |
| Broker schema | `schema_version: 1` | 双端精确协商；未知版本拒绝 |

本轮本机取证 archive 的 SHA-256 为 `BECAD3BBDD28288F1481FBCCA93AD0FA32A840B490FB6C96A086F77A9A006929`。它只证明分析输入；上述固定 commit 的 GitHub blob 才是提交后可复核的源码引用。发布依赖必须使用该 commit、预构建 npm 包或带 integrity 的 `.tgz`，不能依赖一个名为 `master.zip` 的浮动文件。

## 2. DeepSeek++ 已有模块

### 2.1 模式 A 必须复用

| 模块 | 当前责任与证据 | 模式 A 用法 | 禁止做法 |
|---|---|---|---|
| `core/deepseek/active-client.ts` | `createClientHeaders` 在浏览器读取/构造认证头（[`active-client.ts`](../../core/deepseek/active-client.ts#L230-L247)）；`createPowHeaders*` 生成路径绑定 PoW（[`active-client.ts`](../../core/deepseek/active-client.ts#L177-L215)）；`submitPromptStreaming` 是单次网页生成入口（[`active-client.ts`](../../core/deepseek/active-client.ts#L419-L447)）。 | 经一个窄 `WebModelTurnPort` 调用；Browser Broker 不重新实现 HTTP。 | 把 header、Token、PoW 答案发到本机；复制 private API client。 |
| `core/deepseek/stream-codec.ts` | 流 summary 区分 text/reasoning/message IDs/finished（[`stream-codec.ts`](../../core/deepseek/stream-codec.ts#L13-L29)），提供增量 byte/text/frame decoder（[`stream-codec.ts`](../../core/deepseek/stream-codec.ts#L31-L89)）和统一消费器（[`stream-codec.ts`](../../core/deepseek/stream-codec.ts#L129-L163)）。 | 作为网页 SSE 的唯一 decoder；Browser Broker 只发送规范化事件。 | 将原始 SSE 或私有 patch JSON直接变成公共 Broker 合同。 |
| `core/interceptor/streaming-tool-call-parser.ts` | 增量解析 direct XML tool tag，区分 started/completed/failed/streamed（[`streaming-tool-call-parser.ts`](../../core/interceptor/streaming-tool-call-parser.ts#L15-L36)），限制大 payload 并 fail closed（[`streaming-tool-call-parser.ts`](../../core/interceptor/streaming-tool-call-parser.ts#L180-L288)）。 | 可在适配 DSH tool schema 后解析模型输出；它只产生 tool call，不执行工具。 | 复用扩展 ToolRuntime 去执行模式 A 工具；允许 parser 的 DeepSeek++ 类型泄漏到公共协议。 |
| `core/prompt/augmentation.ts` | 已定义 DeepSeek 网页认可的 direct tool-name XML tag 与 JSON payload 格式（[`augmentation.ts`](../../core/prompt/augmentation.ts#L168-L184)）。 | 作为 adapter 的格式事实与 golden fixture 来源；抽取最小 provider-neutral renderer 时保持单一权威。 | 在 Node adapter 和浏览器分别维护不同 prompt/tool grammar。 |
| `entrypoints/background.ts` | 已将 headers、PoW、web submitter 注入 background chat runtime（[`background.ts`](../../entrypoints/background.ts#L315-L340)）。 | 只新增 Browser Broker 的组合、生命周期和 port 注入。 | 把协议状态机、认证校验或业务重试写进入口文件。 |

`active-client.ts` 当前在完成流里调用 `stream-codec`（[`active-client.ts`](../../core/deepseek/active-client.ts#L529-L584)），所以 Mode A 不需要另一套 SSE parser。网页 Token 的来源和存储只存在于浏览器代码（[`active-client.ts`](../../core/deepseek/active-client.ts#L250-L287)、[`active-client.ts`](../../core/deepseek/active-client.ts#L596-L615)）。公共协议的网页凭证 denylist 应覆盖这些字段名及大小写变体，但不得把合法的 hello `pairing_token` 当作网页 Token 拒绝。

### 2.2 模式 B 保留但不向模式 A 扩展

| 模块 | 当前责任 | 处理 |
|---|---|---|
| `core/inline-agent/pi/loop-adapter.ts` | Pi `runAgentLoop`、step/nudge、`AGENT_*` 事件、工具桥；证据见 [`loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L1-L27)、[`loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L287-L403)、[`loop-adapter.ts`](../../core/inline-agent/pi/loop-adapter.ts#L542-L556)。 | 模式 B 完全保留；模式 A 不调用。 |
| `core/inline-agent/pi/deepseek-web-provider.ts` | 将 web StreamFn 注册为 Pi provider，且明确不拥有 page/session/auth state（[`deepseek-web-provider.ts`](../../core/inline-agent/pi/deepseek-web-provider.ts#L1-L28)）。 | 参考模型 ID 与事件映射；不得成为 DSH adapter 的运行依赖。 |
| `core/inline-agent/pi/deepseek-stream-fn.ts` | 将网页流映射为 Pi events、解析工具、推进 page parent ID，并有模式 B retry（[`deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L105-L227)、[`deepseek-stream-fn.ts`](../../core/inline-agent/pi/deepseek-stream-fn.ts#L263-L319)）。 | 提取/复用 provider-neutral 小组件；不从模式 A 调用整个 StreamFn，尤其不继承其 retry authority。 |
| `core/inline-agent/pi/tool-bridge.ts` | 把现有扩展授权执行路径包装成 Pi AgentTool（[`tool-bridge.ts`](../../core/inline-agent/pi/tool-bridge.ts#L1-L19)、[`tool-bridge.ts`](../../core/inline-agent/pi/tool-bridge.ts#L113-L145)）。 | 模式 B only；模式 A 工具由 DSH `ctx.tools` 执行。 |
| `core/inline-agent/trace-store.ts` | 有界保存 UI trace（[`trace-store.ts`](../../core/inline-agent/trace-store.ts#L10-L57)）。 | 不用作模式 A durable session 或请求恢复日志。 |

模式选择必须是显式配置，且一次请求只能有一个 owner。模式 A Broker 禁止调用 `runInlineAgentLoop`、`runAgentLoop`、扩展 ToolRuntime 或 `executeToolCall`。

### 2.3 明确不适合作为模式 A 通道

| 候选 | 源码事实 | 结论 |
|---|---|---|
| MCP Sampling | 初始化发送 `capabilities: {}` 并注明 sampling 尚未实现（[`core/mcp/client.ts`](../../core/mcp/client.ts#L65-L82)）；client interface 只有 initialize/list/call（[`core/mcp/types.ts`](../../core/mcp/types.ts#L206-L241)）。 | 不可用。 |
| Streamable HTTP/SSE server request | transport 遇到含 `method` 的 server message 后返回 `null`（[`core/mcp/transports/common.ts`](../../core/mcp/transports/common.ts#L349-L369)），测试以 `sampling/createMessage` 固定跳过行为（[`tests/mcp-transport-common.test.ts`](../../tests/mcp-transport-common.test.ts#L202-L219)）。 | 不可用，且不应为本项目改变既有 MCP 合同。 |
| Native Messaging | port 只解决 pending request ID（[`core/mcp/transports/native.ts`](../../core/mcp/transports/native.ts#L43-L74)），envelope 只包装 MCP request/notification（[`core/mcp/native-contract.ts`](../../core/mcp/native-contract.ts#L6-L19)）。 | 不是双向模型入口；P0 不扩展。 |
| 浏览器 runtime messaging | `CHAT_SUBMIT_PROMPT` 是内部命令（[`core/messaging/deepseek-runtime-contracts.ts`](../../core/messaging/deepseek-runtime-contracts.ts#L88-L91)），runtime boundary 要求同一 extension ID 并限制 DeepSeek content surface（[`core/messaging/runtime-boundary.ts`](../../core/messaging/runtime-boundary.ts#L117-L182)）。 | 本地进程无法调用；继续保持内部。 |
| external extension messaging | 当前 manifest 只有内部权限/host permissions，未声明 `externally_connectable`（[`wxt.config.ts`](../../wxt.config.ts#L54-L94)）。 | 不新增；WebSocket 由扩展主动连本机。 |

## 3. DeepSeek Harness 可用 seam

| DSH seam | 源码证据 | 本项目用法 |
|---|---|---|
| `LlmAdapter` | `stream(options)` 是唯一必需方法；`prepareCall` 将模型解析和一次调用绑定在同一 adapter generation。[DSH `index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L180-L275) | 实现 `DeepSeekWebBrokerAdapter`，provider route 固定为 `deepseek-web`。 |
| `LlmRuntime.registerAdapter` | effect-based、provider route 唯一且可卸载。[DSH `index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/index.ts#L322-L396) | plugin `apply()` 注册唯一网页 provider；重复 provider fail closed。 |
| `GenerateOptions` / `StreamChunk` | messages/system/tools/signal/sessionId 与流事件合同。[DSH `types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm/src/types.ts#L356-L425) | Broker request 和返回流只做有损最小化前的明确映射；不透传 DSH class/object。 |
| 完整 Agent turn | DSH 自己从 session log 派生历史，调用 llm，执行 tools，再继续 step。[DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L74-L107) | 证明模式 A 不需要 fork loop。 |
| profile/bundle | profile 保存 out-of-tree dependencies；bundle/patch 按层组合。[DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/architecture.md#L15-L29)、[profile implementation](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/boot/app-boot/src/profile.ts#L1-L22) | 将 adapter 作为独立 package 安装到专用 profile。 |
| plugin installer | `dsh plugin --profile` 管理依赖和 bundle；[DSH publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/user/develop/basic/publish.md#L66-L128) | 安装预构建 `.tgz` 或精确 npm 版本，不使用 submodule。 |

DSH 默认 base bundle 把默认模型指向 `deepseek-official/deepseek-v4-flash`，并挂载 dormant `llm-pi-ai` 与 official adapter，见 [base bundle 默认模型与 pi-ai](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/bundle/base/cordis.patch.yml#L73-L109) 和 [official adapter row](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/bundle/base/cordis.patch.yml#L493-L498)。专用 profile 必须显式覆盖默认 provider 并禁用其他模型 adapter，启动时断言可选 model route 只有 `deepseek-web`；否则“网页模型是唯一推理核心”并不成立。

## 4. Planned 最小包和文件边界

### 4.1 `packages/dsh-broker-protocol`

纯 TypeScript、纯数据合同，不依赖 DOM、WXT、Node、WebSocket 实现、Pi 或 DSH。

应包含：

- JSON-RPC 2.0 envelope、`schema_version: 1`、request/correlation/connection lease ID。
- hello/auth、capabilities、generate、dispatch state、stream event、terminal result、cancel、status。
- 严格 runtime codec；未知字段/版本拒绝。
- 单调 event sequence、唯一终态和有界资源常量。
- 网页凭证 denylist 与测试 fixture；普通请求和日志中不允许 Authorization/Cookie/网页 Token/API key/header map。`pairing_token` 是 hello/auth 消息的合法字段，只允许出现在该边界且永不记录。

不应包含：DeepSeek 私有路径、SSE patch、DSH `GenerateOptions`、Pi types、Chrome API 或实际凭证。

### 4.2 `packages/dsh-browser-broker`

浏览器-only 服务，由 WXT background composition 挂载。它依赖 protocol package 和一个窄 `WebModelTurnPort`，不依赖 DSH/Node builtin。

应包含：

- 主动连接 `ws://127.0.0.1:<configured-port>`、首消息认证、心跳和指数退避。
- 每连接 lease、每请求状态机、AbortController、event sequence/backpressure、bounded terminal journal。
- 将已校验的 generate 映射到 `WebModelTurnPort`；将 text/reasoning/tool call/finish 映射回 protocol。
- 断线后拒绝迟到事件；状态查询只返回已确定事实。
- 浏览器/登录页 readiness 检测，未就绪返回 `waiting_for_browser`。

`WebModelTurnPort` 的具体 adapter 放在 `core/deepseek/`，内部复用 `active-client.ts`、`stream-codec.ts`、现有工具流 parser。它不能暴露 Authorization 或原始 `Response`。`entrypoints/background.ts` 只创建 service、注入 port、处理启动/关闭。

### 4.3 `packages/dsh-llm-deepseek-web`

Node-only、out-of-tree DSH Cordis plugin。它是 DeepSeek++ 仓库中的独立发布单元，但相对 DSH 安装仍是 out-of-tree；DSH `master` 无修改。

应包含：

- `DeepSeekWebBrokerAdapter extends LlmAdapter`，注册 provider `deepseek-web`。
- 只监听 `127.0.0.1` 的 authenticated WebSocket server/runtime。
- `GenerateOptions` -> Broker request 与 Broker stream -> `StreamChunk` 的单一 mapper。
- `AbortSignal` -> 幂等 cancel；断线/超时 -> 稳定 `LlmError`/terminal finish。
- opaque replay state 和 request-status reconciliation；不存网页 Token、Cookie 或 headers。
- DSH bundle/profile patch：选择 `deepseek-web`，禁用 official/pi-ai 模型 route。
- fake-browser contract tests 和一个显式 opt-in 真实网页 E2E。

这个包可以内部划分 `adapter/`、`broker-server/` 与 `profile/`，但 P0 不需要第四个运行时进程。WebSocket server 是 adapter plugin 的本机服务；浏览器是唯一连接它的 peer。

## 5. 单一权威与依赖方向

```text
dsh-broker-protocol
  <- dsh-browser-broker <- WebModelTurnPort <- active-client / stream-codec
  <- dsh-llm-deepseek-web <- @deepseek-ai/dsh-llm

模式 B：inline-agent/pi/* -> existing tool runtime
模式 A：DSH agent-loop -> DSH tools
```

约束：

- 公共 protocol 不得 import 任一运行时实现。
- Browser package 不得 import `@deepseek-ai/dsh-*`、Node builtin 或 Pi Agent loop。
- Node adapter 不得 import WXT、Chrome APIs、`core/deepseek/active-client.ts` 或扩展源码；它只能通过 protocol 看见模型。
- `active-client` 是网页请求唯一权威，DSH 是 Agent/tool/session 唯一权威。
- tool prompt grammar 与 parser 只能有一组 golden fixture。允许通过窄 renderer/codec 抽取复用，不允许复制两份以后各自演进。
- 模式 A 不调用 `core/tool/runtime.ts`；模式 B 不调用 DSH adapter。

## 6. 构建、打包和安装隔离

DeepSeek++ 与 DSH 的编译图不同：DeepSeek++ 当前使用 WXT/TypeScript 7（[`package.json`](../../package.json#L60-L73)）；DSH 将 Host/Client 分成两个 aggregate，按 Host tsc/tsdown、Client tsc/tsdown、Web build 顺序构建，见 [DSH development guide](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/development.md#L44-L80)。不要合并这两个工程的 tsconfig/project-reference 图。

推荐三条构建 lane：

1. **Protocol lane**：在双方支持的 TypeScript/ECMAScript 子集下独立 typecheck、codec/golden test、pack。
2. **Extension lane**：npm/WXT 只编译 protocol + browser broker；依赖图检查 Node/DSH 包未进入 Chrome/Edge/Firefox chunk。
3. **Adapter lane**：Node 24 + DSH `0.1.2-rc.1` 的独立 fixture/profile，用该 DSH 版本兼容的 TypeScript 构建、测试和 `pnpm pack`。

发布物分别带 version、Git commit、lockfile 和 SHA-256；握手上报 extension version、adapter version、DSH version、protocol version 与 capabilities。任何不支持的组合在握手阶段失败，不靠鸭子类型继续运行。

### 为什么不使用 git submodule

- DSH 官方 profile 本来就为 out-of-tree plugins 设计（[profile implementation](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/boot/app-boot/src/profile.ts#L5-L22)）。
- submodule 会把整个快速变化的 DSH 源码、构建图和开发依赖引入 DeepSeek++，却没有解决 runtime 版本匹配。
- npm/prebuilt `.tgz` 能记录精确版本和 integrity；DSH 官方文档也指出 Git dependency 会执行受控的 `prepare`，而 npm/tarball 可避免安装时构建，见 [DSH publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/user/develop/basic/publish.md#L153-L178)。

因此：不开 submodule，不改 DSH `master`，不让 DeepSeek++ root build 构建 DSH。若开发期使用 Git dependency，必须 pin 完整 commit 并显式审查 `allowBuilds`；交付优先预构建 `.tgz`。

## 7. PR #568 模块边界

[PR #568](https://github.com/zhu1090093659/deepseek-pp/pull/568) 的 base 是 `0a02c72`，head 是 `24c713abced265ad60bb69af0149b90c19d7a49f`，截至 2026-09-04 open、未合并。它改进 Windows Shell 与本地文件工具，并触及 `core/mcp/client.ts`、shell contracts/host/provider/tests。

- Planned Broker 走新的 protocol/browser/adapter 包和 `core/deepseek` 窄 port，不需要改 `core/mcp/client.ts`。
- 模式 A 工具由 DSH 提供，PR #568 不属于其依赖图。
- 模式 B 若以后采纳，必须在独立 integration 分支做选择性评估；不得把 PR head 作为本分支版本锁。

## 8. 模块级完成标准

| 模块 | 最低完成证据 |
|---|---|
| Protocol | 双端相同 golden；未知字段/版本、乱序、重复终态、超限、secret 字段全部拒绝。 |
| Browser Broker | fake port 覆盖 connect/auth/generate/cancel/status/reconnect；active-client 单次请求集成；无 raw secret 输出。 |
| DSH adapter | DSH adapter contract、StreamChunk 顺序、AbortSignal、ambiguous、不支持选项、唯一 provider inventory。 |
| Profile | `dsh --profile <name> --dump-config` 只选 `deepseek-web`，未配置 API key 也能启动，其他模型 route 不可被隐式选择。 |
| 模式隔离 | 运行时测试证明一个 request 只到一个 owner；模式 A 不执行扩展工具，模式 B 不连接 DSH adapter。 |
| 真实闭环 | DSH -> 网页模型 -> DSH 只读工具 -> 网页模型 -> 同一 DSH session 最终结果。 |
