# Web Model Broker × Local DSH — Active Progress

> 本页是本轮工作的唯一活动进度真源；历史项目记录继续保留在 `docs/archives/`，不得把历史完成状态当作本轮已完成状态。
>
> **Tracking mode**: `LOCAL_ONLY`（尚未创建 GitHub Issue、Milestone 或 PR）
>
> **Started / last updated**: 2026-09-04
>
> **Active repository**: `XVSHIFU/deepseek-pp`
>
> **Active branch**: `feature/web-harness`
>
> **Active direction**: 模式 A（本机 DeepSeek Harness + DeepSeek++ 网页模型 Broker）唯一主开发线

## 目标

- 让本机 DeepSeek Harness（首选官方 DSH）拥有 Agent loop、session、tools、Skills、subagent 与任务生命周期，并使用 DeepSeek 网页当前登录会话作为模型后端。
- DeepSeek++ 只作为浏览器网页模型 Broker：网页认证、PoW、页面会话链和网页专有协议始终留在浏览器可信边界内。
- 通过仅监听 `127.0.0.1` 的 authenticated WebSocket 与带 `schema_version` 的 JSON-RPC 2.0 风格流协议连接本机 DSH 和浏览器 Broker。
- 首个真实验收必须完成“本机 DSH → 网页模型 → DSH 本地只读工具 → 下一网页模型回合 → 同一 DSH 会话最终结果”，全程不配置 DeepSeek API key 或其他模型 provider。
- 浏览器未就绪时显式进入可恢复的 `waiting_for_browser`；结果不明的请求进入 `ambiguous`，不得自动重放。
- 保持 DeepSeek++ 已发布的 prompt、工具 XML、`AGENT_*`、存储、MCP、Native Host 和多浏览器兼容合同不变，除非后续任务明确授权合同变更。

## 非目标

- 本轮不发布版本，不制作提前 release，不更新商店或发布说明。
- 不 fork 或改写 DeepSeek Web 协议；继续复用 `core/deepseek/active-client.ts`、`stream-codec.ts` 和现有 `deepseek-web` provider 权威路径。
- 不把官方 API、OpenAI 兼容代理、模式 B 的网页内 Pi provider 或本地第二模型伪装成模式 A 的“网页 DeepSeek 模型”。
- 不把登录凭据、浏览器存储、完整网页请求头或页面 Cookie 发送给本地 Agent。
- 不扩大到 Android、移动 WebView、无关 UI、存储迁移、同步、自动化或发行工程。
- 不修改或重做已完成的模式 B；它只保持兼容，不是模式 A 的实现捷径，也不安排新 PoC。
- 不在模型 Broker 任务中顺带移植 PR #568，不新增第二套 Shell、文件、授权、sandbox 或工具执行路径。
- 未经维护者明确授权，不创建 GitHub Issue、Milestone、PR 或远端分支。

## 基线与仓库状态

以下 SHA 于 2026-09-04 通过本地 Git 和 GitHub 公开 API 核验。外部 Harness 仓库目前不是本工作树的 Git remote，只作为模式 A 的固定外部基线记录。

| 名称 | URL / remote | 默认分支 | 基线 SHA | 状态 |
|:--|:--|:--|:--|:--|
| DeepSeek++ fork | `origin` → `https://github.com/XVSHIFU/deepseek-pp.git` | `main` | `0a02c72b135bf2936e11aa78fd6136931ed65908` | 与上游一致 |
| DeepSeek++ upstream | `upstream` → `https://github.com/zhu1090093659/deepseek-pp.git` | `main` | `0a02c72b135bf2936e11aa78fd6136931ed65908` | 当前实现基线 |
| Harness fork | `https://github.com/XVSHIFU/deepseek-harness.git` | `master` | `76fda729799fe9b3848dbe2c211d4b231032b81e` | 与官方上游一致；仅一个公开分支 |
| Harness upstream | `https://github.com/deepseek-ai/deepseek-harness.git` | `master` | `76fda729799fe9b3848dbe2c211d4b231032b81e` | 模式 A 外部基线 |
| DeepSeek++ PR #568 | `xiaolu219/deepseek-pp:personal/windows-java-agent` | PR base: `main` | base `0a02c72b...`; head `24c713abced265ad60bb69af0149b90c19d7a49f` | open、未合并、比 main 多 2 个提交 |

当前工作分支 `feature/web-harness` 从 DeepSeek++ 基线 `0a02c72b...` 开始。本分支只承载网页模型 × 本地 harness 工作，不承载 PR #568 或其他功能合并。

被替换的 Local Agent Gateway 工作树没有删除：其最终提交 `2041cf362a692645fa401977444c44c9f39e1cc0` 同时由本地分支 `archive/local-agent-gateway-v0.2`、`legacy/local-agent-gateway-v0.2` 和 annotated tag `archive-local-agent-gateway-v0.2-2041cf3` 固定。后续只按当前任务选择性迁移可验证的协议、状态机、安全或测试思想，不把旧产品代码混入新基线。

## 模式定义

### 模式 A：本机 DeepSeek Harness + DeepSeek++ 网页模型 Broker

- 这是本次唯一主开发线。
- 本机 DSH（首选官方实现）拥有 Agent loop、上下文、session、tools、Skills、subagent、取消与最终结果；本地工具权限和审计也完全属于 DSH。
- DeepSeek++ 只拥有网页登录态、Authorization/Cookie、PoW、DeepSeek 网页会话链和模型流代理；这些敏感值不得穿过 Broker 协议。
- DSH 通过新建的 `deepseek-web` LLM adapter 选择网页模型，不允许隐式回退官方 API、Pi 内置模型或其他 provider。
- 传输固定为 authenticated loopback WebSocket；应用协议是带版本、请求关联 ID、单调事件序号、唯一终态、幂等取消和状态查询的 JSON-RPC 2.0 风格流协议。

### 模式 B：DeepSeek++ 浏览器内 Pi loop + 本地工具

- 这是 DeepSeek++ 已开发完成的现有能力：浏览器内 Pi loop 拥有 Agent authority，并调用扩展已有的本地/MCP 工具。
- 模式 B 只保持兼容，不安排新 PoC，也不得暗中接管模式 A 的 DSH 会话或 Agent loop。
- 两种模式只复用现有 `DeepSeekAutomationClient`、`stream-codec` 等网页客户端能力；模式 A 的 Node/DSH 依赖不得进入模式 B 浏览器 chunk。

## 里程碑状态

状态只允许 `not_started`、`in_progress`、`blocked`、`verified`。只有对应验证证据存在时才能写 `verified`。

| Milestone | 结果 | 状态 | 退出条件 |
|:--|:--|:--|:--|
| M0 Protocol + fake Broker | 纯 TypeScript 版本化协议、严格 codec、fake browser/fake Broker 纵切片 | `not_started` | 握手/认证、生成、增量、唯一终态、幂等取消、状态查询、预算和未知字段拒绝均有自动化测试 |
| M1 Browser Broker | DeepSeek++ 建立 authenticated loopback WebSocket，并委托现有网页客户端 | `not_started` | 只连 `127.0.0.1`；凭据不越界；模式 B 行为/chunk 不变 |
| M2 DSH adapter + profile | out-of-tree `deepseek-web` LLM adapter、profile 与最小安装 bundle | `not_started` | DSH 可显式选择 `provider=deepseek-web`；无隐式 provider fallback；不修改 DSH `master` |
| M3 Real one-turn | 本机 DSH 经已登录浏览器完成一次真实网页模型回合 | `not_started` | 无 DeepSeek API key/其他 provider；流正常结束；最终文本进入同一 DSH session |
| M4 Local-tool multi-turn | 网页模型请求 DSH 本地只读搜索/读取工具，结果进入下一模型回合并返回最终结果 | `not_started` | 首个完整 P0 验收通过；工具只执行一次且可审计，DSH 始终拥有 loop authority |
| M5 Disconnect/cancel/recovery | 浏览器离线、取消、断连、重连查询和不明结果处理 | `not_started` | 离线=`waiting_for_browser`；取消幂等；`ambiguous` 不自动重放；唯一终态可重复查询 |
| M6 Install/release readiness | 本机 Broker、DSH adapter/profile 的安装升级、文档、供应链和发布门禁 | `not_started` | 仅在 M0–M5 验证完成且获得明确 release 授权后执行完整门禁 |

## Task / Batch 映射

当前不创建远端跟踪项。Issue、PR、Agent 和提交字段先保留占位；维护者授权远端协作后再填写真实链接，禁止为了填表先创建资源。

| Batch | Task | 任务范围 | Issue | PR | Agent/owner | 状态 |
|:--|:--|:--|:--|:--|:--|:--|
| G0 | G0-T1 | 创建并维护活动进度真源 | `—` | `—` | orchestration | `in_progress` |
| P0 | P0-T1 | 共享协议类型、严格 codec、版本与消息预算 | `TBD` | `TBD` | `TBD` | `not_started` |
| P0 | P0-T2 | authenticated loopback WebSocket fake Broker | `TBD` | `TBD` | `TBD` | `not_started` |
| P0 | P0-T3 | fake browser 纵切片：流顺序、取消、状态查询、离线与 `ambiguous` | `TBD` | `TBD` | `TBD` | `not_started` |
| P1 | P1-T1 | DeepSeek++ Browser Broker 连接、配对与生命周期 | `TBD` | `TBD` | `TBD` | `not_started` |
| P1 | P1-T2 | Broker 委托 `DeepSeekAutomationClient`/`stream-codec`，并隔离模式 B chunk | `TBD` | `TBD` | `TBD` | `not_started` |
| P2 | P2-T1 | out-of-tree DSH `deepseek-web` LLM adapter | `TBD` | `TBD` | `TBD` | `not_started` |
| P2 | P2-T2 | DSH profile、显式 provider 选择与最小安装 bundle | `TBD` | `TBD` | `TBD` | `not_started` |
| P3 | P3-T1 | 无 API key 的真实网页单回合 E2E | `TBD` | `TBD` | `TBD` | `not_started` |
| P4 | P4-T1 | DSH 本地只读工具多回合与最终结果 E2E | `TBD` | `TBD` | `TBD` | `not_started` |
| P5 | P5-T1 | disconnect/cancel/recovery、`waiting_for_browser` 与不重放 | `TBD` | `TBD` | `TBD` | `not_started` |
| P6 | P6-T1 | 安装、升级、文档和 release readiness | `TBD` | `TBD` | `TBD` | `not_started` |
| S1 | S1-T1 | PR #568 独立评估；只服务模式 B 兼容，不作为模式 A 前置 | `TBD` | `TBD` | `TBD` | `not_started` |

## PR #568 独立分支策略

- PR #568 当前 open 且未进入 DeepSeek++ `main`；`XVSHIFU/deepseek-pp:main` 也不包含它。
- `feature/web-harness` 不 merge、rebase 或 cherry-pick PR #568 head；模型桥接成果必须能独立于该 PR 构建和验证。
- 若后续明确授权评估，使用独立分支 `integration/windows-shell-568` 从已记录的 DeepSeek++ 基线开始；不在本页操作中创建该分支或远端 PR。
- 优先复用测试场景与设计事实，例如 PowerShell 7 探测、文件 SHA 快照、分页和文件变化 fail-closed；不得直接复制其接受绝对路径/home-relative 路径的模型可见合同。
- 任何采纳必须经过当前 DeepSeek++ 单一工具执行、授权、MCP/Native 合同与 workspace/path 安全边界；不得新增旁路。
- 若复制具体代码，先完成许可证、出处、当前 main 演进和重复能力核对；最终改动以独立任务、独立测试和独立提交交付。
- 该 PR 只可能改善已完成的模式 B 本地 Shell/文件工具，不解决模式 A 的模型 Broker、DSH adapter 或首个纵切片，因此不是 M0–M5 的前置依赖。

## 验证层级

| Level | 名称 | 最低证据 | 允许声称的结论 |
|:--|:--|:--|:--|
| L0 | 静态卫生 | `git diff --check`、范围/敏感信息检查 | 文本/差异无已发现的静态问题 |
| L1 | 定向单测/合同测试 | 与改动一一对应的自动化用例实际通过 | 指定合同或行为通过 |
| L2 | 编译与静态门禁 | `npm run compile` 及适用 lint/生成物检查 | 当前代码可编译且静态合同成立 |
| L3 | DeepSeek++ 协议保护 | 适用的 `AGENT_*` golden、provider、prompt freeze、MCP/Native 测试 | 已发布网页/工具合同未被意外改变 |
| L4 | 构建 | 受影响浏览器构建；跨浏览器改动用 `npm run build:all` | 指定浏览器产物可构建 |
| L5 | 本地 fake 集成 | fake browser + fake Broker + DSH adapter 的确定性纵切片：流、取消、断连、恢复查询、重复和超限 | 跨进程控制面闭环成立；不证明真实网页可用 |
| L6 | 真实网页 E2E | 显式 opt-in；本机 DSH 发起；已登录 DeepSeek 页面；无 API Key/其他 provider；只读工具结果进入下一模型回合并产生最终答案 | 模式 A 的完整 P0 真实闭环成立 |
| L7 | 完整质量/发布 | `npm run ci:quality` 及获授权的发布门禁 | 仅证明候选具备进入发布评审的条件，不等于已发布 |

验证记录必须写明命令、结果、日期和环境。`not_run`、`blocked`、`failed` 与 `passed` 不得互相替代。启动进程或打开页面不是 E2E 证据，必须实际完成对应模型/工具调用。

## Agent 工作纪律

1. 只做分配任务写明的范围和文件；发现相邻问题先记录并交回编排者，不顺手扩大实现。
2. 行为变更坚持代码与测试优先：先读取权威合同、调用方和既有测试，先增加能失败的定向测试，再做最小实现；纯治理文档任务除外。
3. 每个 Agent 任务必须给出明确目标、允许修改的文件、验收条件、验证命令和停止条件；Agent 不得跨越文件所有权抢改他人热点。
4. 已由源码、测试或 GitHub API确定的事实，在基线没有变化时禁止重复审计；不要用新一轮泛化审计替代实现和验证。
5. 禁止无关重构、依赖升级、格式化全仓、复制第二套 router/validator/policy/provider/tool path，或为未来需求提前增加接口。
6. 禁止在 PoC、未验收功能或工作树不明时提前 release、打标签、更新商店、上传资产或宣称 release-ready。
7. 禁止声称未实际运行的测试通过。未运行写 `not_run`；环境缺失写 `blocked` 并说明风险；失败必须保留真实失败事实。
8. 保留用户和其他 Agent 的未提交修改；禁止 destructive reset、覆盖式 checkout 或删除不属于当前任务的文件。
9. 实现完成后按 L1 → L2 → L3/L4 → L5/L6 的适用顺序验证；失败先定位本任务回归，不以弱断言、静默 fallback 或 mock success 绕过。
10. 编排者只在代码、测试和证据都收口后更新任务状态；提交应目的单一、可独立审阅，未获授权不得创建 GitHub Issue/PR。

## 当前状态与下一步

**当前状态**：架构决策 `docs/decisions/web-harness-model-broker.md` 已接受，模式 A 是唯一主开发线；本页已按该决策纠正。功能代码尚未开始，因此 M0–M6 均不得标记完成。模式 B 已有能力只保持兼容，当前分支没有 release 授权。

**立即下一步**：

1. 启动 P0-T1：定义纯 TypeScript、无 DOM/WXT/Node/DSH 依赖的版本化协议与严格 codec，覆盖认证握手、`generate`、接受、增量、唯一终态、失败、幂等取消和状态查询。
2. 在协议中锁定请求关联 ID、单调事件序号、消息/流字节上限、截止时间、凭据禁传和错误分类；浏览器不可用映射为 `waiting_for_browser`，结果不明映射为 `ambiguous` 且不可自动重放。
3. 启动 P0-T2/P0-T3：以 authenticated `127.0.0.1` WebSocket fake Broker 和 fake browser 完成默认离线纵切片测试；服务端按 remote address、Host、Origin、协议版本、认证、消息大小、Schema 顺序失败关闭。
4. 只有 P0 的 L1/L2 证据收口后才进入 Browser Broker；随后严格按 M1 → M2 → M3 → M4 推进首个真实闭环。PR #568 与 release 工作继续隔离。

## 活动验证记录

| Date | Scope | Command | Result | Notes |
|:--|:--|:--|:--|:--|
| 2026-09-04 | G0-T1 | `git remote -v`; `git branch --show-current`; `git rev-parse HEAD` | `passed` | 核实本地 DeepSeek++ remote、活动分支与基线 SHA |
| 2026-09-04 | G0-T1 | GitHub API repo/branch/compare/PR 查询 | `passed` | 核实两个 fork、两个 upstream 和 PR #568 状态；只读 |
| 2026-09-04 | G0-T1 | Runtime/compile/test/build | `not_run` | 本任务只新增治理文档，不改变运行时代码 |
