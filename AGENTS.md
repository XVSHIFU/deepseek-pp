# DeepSeek++ Project Agent Instructions

## Scope

These instructions apply to the entire repository. `AGENTS.md` is the sole project-level agent instruction truth source for this project.

## Product Context

DeepSeek++ is a WXT/React/TypeScript MV3 browser extension that adds agentic memory, Skills, tools, automation, and related workflows to DeepSeek. Its core runtime model is:

- intercept DeepSeek Web requests and streams from the page runtime;
- augment prompts with memory, Skill, preset, project, and tool context;
- parse tool-call output and execute approved capabilities through extension-owned boundaries;
- persist user state in IndexedDB and browser storage;
- integrate optional MCP, Native Host, sync, sandbox, Side Panel, and floating-chat surfaces.

Chrome, Edge, and Firefox on desktop are the only supported product targets. Android, mobile WebView shells, and mobile packages are outside the current product scope.

## Truth Sources

- `AGENTS.md` — stable project rules, architecture invariants, and recurring engineering constraints.
- `docs/archives/deepseek-pp-reliability-compatibility-refactor/progress/MASTER.md` — completed core-refactor record, GitHub Issue/Milestone mapping, validation evidence, and final known gap.
- `docs/archives/deepseek-pp-reliability-compatibility-refactor/analysis/project-overview.md` — confirmed PC-only scope and compatibility boundary established by the completed refactor.
- `docs/archives/deepseek-pp-reliability-compatibility-refactor/analysis/module-inventory.md` and `docs/archives/deepseek-pp-reliability-compatibility-refactor/analysis/risk-assessment.md` — final architecture evidence and risk basis for that run.
- `docs/compatibility/README.md` and its linked registries — stable prompt, runtime, persistence, browser, integration, and historical-data contracts established by the completed refactor.
- `docs/decisions/web-harness-model-broker.md` — accepted Mode A architecture: local DeepSeek Harness owns the agent loop while DeepSeek++ brokers the logged-in web model.
- `docs/plan/` and `docs/progress/MASTER.md` — active `feature/web-harness` implementation plan and evidence-backed status. Planned behavior is not a released compatibility claim.
- `docs/archives/deepseek-pp-reliability-compatibility-refactor/plan/task-breakdown.md` and `docs/archives/deepseek-pp-reliability-compatibility-refactor/plan/dependency-graph.md` — archived task ownership, dependencies, and execution lanes.
- `package.json`, `wxt.config.ts`, and GitHub workflows — executable build, test, manifest, and release contracts.
- `docs/releases/<version>.md` — exact public release/update notes for that version.

When prose and executable behavior disagree, verify the code and tests, then update the stale document in the same task. Do not create a second source of truth to bridge the mismatch.

## Collaboration Rules

- Once the core scope is aligned, make routine technical decisions and proceed. Ask only when a new choice materially changes behavior, compatibility, risk, or authorization.
- Prefer root-cause structural fixes over symptom patches. Remove duplicate logic, obsolete gates, dead branches, and hidden fallbacks instead of layering another path beside them.
- Keep changes scoped to the active Issue. Preserve unrelated and pre-existing working-tree changes.

## Architecture and Compatibility Invariants

- Preserve prompt byte output, tool XML tags, inline-agent continuation/finalization semantics, and user-visible behavior unless an Issue explicitly authorizes a contract change.
- Preserve storage keys, IndexedDB names/tables/identity, supported schema versions, sync/export records, runtime message names, MAIN/content bridge records, MCP contracts, Native Host contracts, and Chrome/Edge/Firefox degradation semantics.
- Every schema change requires an explicit, deterministic, idempotent migration. Unknown future versions and corrupt data must fail visibly without overwriting the original state.
- Maintain one authoritative router, validator, policy, and persistence truth for each concept. Delete the superseded path as soon as its consumer migrates.
- Define contracts before implementations. Contract modules must not import concrete browser, DOM, provider, or entrypoint implementations.
- Introduce only narrow environment ports. A new port must gain a production consumer in the same task; otherwise remove it. Do not expand the existing broad platform abstraction without a real consumer.
- Cross-runtime and external-I/O contracts must be serializable and validated at the receiving trust boundary.
- Before privileged runtime, Port, MessagePort, or frame dispatch, derive authority only from browser-provided sender, tab, frame, document, WindowProxy, and receiver-owned correlation state, then run the direction-specific codec. Message-declared source, tab, frame, session, or request IDs are routing claims, not identity; MAIN-world payloads remain untrusted. Opaque sandbox `postMessage('*')` is allowed only with exact source/origin checks and strict request correlation.
- Every production tool execution must pass through the runtime authorization path before payload rehydration or provider execution. Page/model calls require a background-owned grant that binds the receiver-owned document/session, advertised descriptor security snapshot, canonical provider/mode/risk, request identity, and one-time call reservation; caller-supplied ToolCall metadata is never authorization evidence.
- Do not add an Android project, mobile WebView bridge, mobile platform kind, build job, test surface, documentation claim, or release path unless the user explicitly reopens that product scope.
- Sync uploads publish all six payloads and their checksum manifest before replacing `sync-current.json`. The current pointer is the only generation commit point: new uploads never dual-write legacy fixed files, and readers may use legacy fixed files only when the pointer is absent. A present but invalid generation must fail visibly.
- Every sync test/authorization/upload/download request carries the validated immutable target and expected config revision captured before click/confirmation. One Background FIFO owns sync-config CAS and complete actions; completion may patch `lastSyncAt` only for the same accepted revision, and upload snapshots are captured under the shared local-state lock. OAuth access-token caches must match a non-logged credential fingerprint as well as provider/client identity. Do not add a second revision key, action router, remote publisher, journal, or fallback.
- Sync downloads must validate and merge the complete remote snapshot before local mutation. Capture raw Memory rows (including numeric IDs and unknown fields) plus opaque present/value preimages for every affected local key before writing; a prepared recovery journal means the apply is uncommitted, and deleting it after all target writes is the only local commit point. Local-import merge, sync apply/recovery, and every ordinary mutation of those stores share one local-state lock; sync adapters use explicit already-locked primitives rather than re-entering it. Failed apply recovery runs before releasing that lock, and an incomplete recovery becomes a fail-closed lock precondition that must succeed before any queued mutation or retry can stage. Durable startup recovery must complete before runtime dispatch, stale-Memory archival, or automation scans, remains retryable after transient failure, and is not poisoned by post-recovery broadcast failure. Corrupt or future journals remain intact and fail closed.
- A non-sync whole-key store owns one independent, store-local serial operation queue shared by its reads, mutations, and clear operations. Every mutation re-reads and validates the latest value inside that queue; a failed operation must not poison later work. Do not route these stores through the sync-global lock, add a process-global queue, or invent revision/CAS fields unless the released schema and a real cross-realm writer require them.
- An automation run owns one persisted `running` lease and one in-process execution context containing its run ID, deadline, `AbortSignal`, attempt, and stable idempotency-key factory. Timeout or deletion aborts the context, but the lease is not released until the executor promise settles. Scheduled occurrences are claimed atomically and never replayed after restart; only failures explicitly marked `retrySafe: true` with `externalOutcome: not_started` may retry. Ambiguous completion or tool side effects fail terminally, and stale leases close as ambiguous without replay.
- Content capabilities own explicit, idempotent `start/stop` lifecycles and all listeners, observers, timers, DOM roots, and mutable state they create.
- Background entrypoints are composition/lifecycle roots; domain behavior belongs in typed handlers and services.
- Do not add broad catches, silent defaults, mock-success paths, or unlogged fallbacks to make failures disappear. Best-effort behavior must be explicit, bounded, and tested.

### pi-agent-core 集成（2026-08-05 起生效）

- **pi-agent-core 锁版策略**：`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 必须精确锁版（无 `^`/`~`），`overrides` 钉住传递依赖；升级必须走独立 PR 并按完整验证链重跑（定向测试 → compile → prompt:freeze → build:all → verify → ci:quality），由专门 Issue 授权。
- **pi 上下文不落持久化**：pi loop 的 context/messages 仅作当前回合工作内存；IndexedDB / localStorage / sync 的记忆与状态存储保持单一权威，pi 集成不得新增任何持久化键（`tests/pi-storage-boundary.test.ts` 守护）。
- **StreamFn 复用 stream-codec**：DS 网页协议（SSE 分帧/事件解析/PoW/认证）的唯一权威是 `core/deepseek/stream-codec.ts` 与 `active-client.ts`；任何新的模型后端适配（StreamFn）不得复制协议逻辑，只能薄封装现有客户端。
- **模型后端注册为 pi-ai provider（B1 起）**：deepseek-web 是 pi-ai 正式 provider（`core/inline-agent/pi/deepseek-web-provider.ts` 的 `createDeepSeekWebProvider`，`Provider<'deepseek-web'>`，自定义 `Api` 扩展点）；loop 经 `provider.stream` 消费，禁止退回自定义 StreamFn 独有路径；provider 是注册 + 委托对象，不持有页面/会话/授权状态（会话链 authority 仍在 loop-adapter 注入的 `DeepSeekSessionState`）；provider 注册形状受 `tests/deepseek-web-provider.test.ts` 契约测试保护；新增第二模型后端必须复用现有端口（如 `DeepSeekAutomationClient`）并单独 Issue 授权。
- **双模型后端单一选择 authority（B2 起）**：inline agent 后端选择只经 `InlineAgentStartPayload.modelBackend`（`'web'` 缺省 = 页面路径 golden 锁定；`'official-api'` = 官方 API，OpenAI 兼容消息 + reasoning，经 `core/inline-agent/pi/official-api-provider.ts` 的 `createDeepSeekApiProvider`）；未显式指定时由调用方按官方 API key 有无自动选择（与 sidepanel 聊天一致），禁止在 loop 内发明第二套选择逻辑。链 authority 按后端：web = 页面会话链（`DeepSeekSessionState.parentMessageId`），official-api = pi Context transcript（工具执行前 fail-closed 验证 Context 含 assistant 回合）。消息映射（`createDeepSeekApiMessageMapper`）受 `tests/deepseek-api-provider.test.ts` 契约保护：assistant toolCall 块重序列化为 XML wire 协议（官方 API 无原生 function calling）。
- **工具执行单一路径**：pi 桥接工具（`core/inline-agent/pi/tool-bridge.ts`）只通过注入的授权执行路径（background grant）向下调用；调用 source 必须携带与 grant 绑定的 requestId/chatSessionId；不得发明第二条执行路径。
- **AGENT_* 事件协议受契约测试保护**：`tests/inline-agent-event-protocol-golden.test.ts` 是 inline agent 页面协议的逐字节基线（含全量工具记录载荷）；任何 loop 引擎变更必须保持该测试全绿。
- **pi 生态技能只走现有导入管线（B3 起）**：pi/agentskills.io 生态的 SKILL.md 目录经既有 local-import 管线导入（`core/skill/local-importer.ts` 的 `parseSkillDoc` 是 SKILL.md 解析单一真源；`core/skill/pi-importer.ts` 是显式桥接面）；禁止 import `@earendil-works/*` harness（skill 加载器/prompt 格式化器零引用——pi 模板不得进入 wire，`tests/pi-skill-importer.test.ts` grep 断言）；技能内容只进现有 Skill 存储（无新持久化键）；`disable-model-invocation` 等 pi 字段仅 metadata 保留，启停语义归应用。

### DeepSeek Web Harness 集成

- Mode A 由本机 DeepSeek Harness 独占 agent loop、会话、工具、Skill、子 Agent 与取消生命周期；DeepSeek++ 仅代理当前已登录浏览器内的 DeepSeek 网页模型。既有浏览器内 Pi loop 是 Mode B，必须继续兼容，禁止用 Mode B 冒充 Mode A。
- 浏览器代理必须复用 `DeepSeekAutomationClient` 与 `stream-codec`，不得复制网页 SSE、PoW、认证或会话逻辑；Cookie、Authorization、PoW 输入输出和网页私有请求不得离开扩展。
- P0 传输固定为仅监听 `127.0.0.1` 的 authenticated WebSocket 和严格版本化、可关联、可取消、可恢复查询的流协议。不得改用 Cookie 抓取、CDP/UI 自动化、MCP wrapper、Native Messaging 或官方 API 回退来绕过该合同。
- DSH 集成优先使用其公开 `LlmAdapter`、插件和 profile 扩展点，在本仓库维护 out-of-tree adapter/bundle；不把 `deepseek-harness` 设为 submodule，不修改其 fork `master`，不复制 Harness 核心。
- 浏览器不可用时必须返回可恢复的 `waiting_for_browser`；结果不明的断线请求标为 ambiguous，不自动重放，不伪造完成。模式 A 的本地工具权限由 DSH 独占，Browser Broker 不新增 shell 或文件能力。
- 每个实现任务必须交付对应代码、合同/单元测试和实际执行证据。不要把通用审计、无关重构、提前发布包装或 PR #568 混入模型代理主线；PR #568 只在独立 integration lane 验证。

## Security Baseline

- Never hardcode secrets, API keys, credentials, or tokens.
- Validate and sanitize external input at page, runtime-message, native-host, sync, and network boundaries before privileged work.
- Keep public security Issues limited to repair goals and verifiable outcomes. Detailed trust-boundary or exploit evidence stays in local analysis until disclosure is appropriate.

## Testing and Validation

Behavior, data, security, schema, routing, permission, persistence, caching, and performance changes must add or update relevant automated tests. A pure documentation/config task may use the closest static validation but must record why runtime tests do not apply.

Run applicable validation in this order:

1. Targeted tests for changed behavior.
2. `npm run compile` and applicable static checks.
3. `npm run prompt:freeze` when prompt, tool, Skill, memory, project, or inline-agent behavior may be affected.
   Update prompt goldens only through `npm run prompt:freeze:update`, after the active Issue explicitly authorizes the byte change and the generated diff has been reviewed.
   Keep runtime, bridge, tool-record, and sandbox contract fixtures synchronized with every cross-runtime contract change. Label malformed behavior that is merely accepted today as a `current-gap` with its owning follow-up; never promote it to a legal fixture without an explicit compatibility decision.
   Keep historical IndexedDB, local-storage, and sync fixtures synchronized with every persistence contract change. Data-loss, silent-default, filtered-row, partial-commit, and future-version behavior must remain labeled migration gaps with an owning follow-up; never treat those paths as successful compatibility.
   Keep DeepSeek route/SSE, generated-manifest/capability, MCP/Native envelope, and Shell catalog/installer fixtures synchronized with every external-runtime contract change. Keep accepted-unknown and degraded behavior labeled with an owning follow-up.
4. Affected browser builds; use `npm run build:all` for cross-browser or closure tasks.
5. `npm run verify:manifest-policy` and `npm run verify:extension-utf8` when manifests, assets, permissions, or build output change.
6. The narrow smoke test for the changed runtime, followed by `npm run ci:quality` at compatibility/release closure.

Backend/unit tests use a hard 60-second timeout. After timeout or interruption, verify the process group exited and no orphaned Vitest/test child remains. Starting a server or host is not smoke evidence; exercise at least one real command or tool call.

## Spec-Driven Tracking

- The `core-refactor-2026-07` run used GitHub Issues + Milestones + PRs in `GITHUB_STANDARD` mode and is archived under `docs/archives/deepseek-pp-reliability-compatibility-refactor/`.
- Treat that archive and its `spec-driven` + `spec:core-refactor-2026-07` GitHub resources as historical evidence, not an active resume point.
- A future spec-driven run may create a fresh `docs/analysis/`, `docs/plan/`, and `docs/progress/MASTER.md`; archive it on completion instead of mutating the completed core-refactor record.
- Use Issues as acceptance checklists. Closely related Issues may share one isolated batch branch and one PR when the user authorizes batch execution; keep hotspot owner lanes and internal commits separable, record telemetry on every mapped Issue, and close them through the merged batch PR.
- Stable rules discovered during execution belong here. Transient findings, task notes, and progress do not.

## Public Documentation Style

README and other user-facing product documentation describe what users can do, not internal endpoints, wire formats, interception details, or architecture internals. Keep public copy natural and product-focused rather than template-heavy.

## Governance

- Do not create or restore a root `CLAUDE.md`; all shared project guidance belongs in `AGENTS.md`.
- Do not create a repo-local memory file. The repository has no approved memory fallback.
- `.claude/settings.local.json` is local command-permission configuration, not a project instruction or memory source.
- If another agent-specific rule surface appears, merge any durable shared guidance into `AGENTS.md` and remove duplication before treating it as authoritative.
