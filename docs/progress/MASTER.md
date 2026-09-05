# Web Model Broker × Local DSH — Active Progress

> 本页是本轮工作的唯一活动进度真源；历史项目记录继续保留在 `docs/archives/`，不得把历史完成状态当作本轮已完成状态。
>
> **Tracking mode**: `LOCAL_ONLY`（尚未创建 GitHub Issue、Milestone 或 PR）
>
> **Started / last updated**: 2026-09-04 / 2026-09-05
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
| M0 Protocol + fake Broker | 纯 TypeScript 版本化协议、严格 codec、fake browser/fake Broker 纵切片 | `verified` | 握手/认证、生成、增量、唯一终态、幂等取消、状态查询、预算和未知字段拒绝均有自动化测试 |
| M1 Browser Broker | DeepSeek++ 建立 authenticated loopback WebSocket，并委托现有网页客户端 | `verified` | 只连 `127.0.0.1`；凭据不越界；模式 B 行为/chunk 不变 |
| M2 DSH adapter + profile | out-of-tree `deepseek-web` LLM adapter、profile 与最小安装 bundle | `verified` | DSH 可显式选择 `provider=deepseek-web`；无隐式 provider fallback；不修改 DSH `master` |
| M3 Real one-turn | 本机 DSH 经已登录浏览器完成一次真实网页模型回合 | `verified` | 无 DeepSeek API key/其他 provider；流正常结束；最终文本进入同一 DSH session |
| M4 Local-tool multi-turn | 网页模型请求 DSH 本地只读工具，结果进入下一模型回合并返回最终结果 | `in_progress` | 官方 read 与实际 DSH 两轮 fake 已通过；真实网页工具验收待操作者运行，不能提前标为 verified |
| M5 Disconnect/cancel/recovery | 浏览器离线、取消、断连、重连查询和不明结果处理 | `not_started` | 离线=`waiting_for_browser`；取消幂等；`ambiguous` 不自动重放；唯一终态可重复查询 |
| M6 Install/release readiness | 本机 Broker、DSH adapter/profile 的安装升级、文档、供应链和发布门禁 | `not_started` | 仅在 M0–M5 验证完成且获得明确 release 授权后执行完整门禁 |

## Task / Batch 映射

当前不创建远端跟踪项。Issue、PR、Agent 和提交字段先保留占位；维护者授权远端协作后再填写真实链接，禁止为了填表先创建资源。

| Batch | Task | 任务范围 | Issue | PR | Agent/owner | 状态 |
|:--|:--|:--|:--|:--|:--|:--|
| G0 | G0-T1 | 创建并维护活动进度真源 | `—` | `—` | orchestration | `in_progress` |
| P0 | P0-T1 | 共享协议类型、严格 codec、版本与消息预算 | `—` | `—` | `release_gap_audit`; review: `protocol_v1_review` | `verified` |
| P0 | P0-T2 | authenticated loopback WebSocket fake Broker | `—` | `—` | `release_gap_audit`; review: `protocol_v1_review` | `verified` |
| P0 | P0-T3 | fake browser 纵切片：流顺序、取消、状态查询、离线与 `ambiguous` | `—` | `—` | `release_gap_audit`; review: `protocol_v1_review` | `verified` |
| P1 | P1-T1 | DeepSeek++ Browser Broker 连接、配对与生命周期 | `—` | `—` | `release_gap_audit`; review: orchestration | `verified` |
| P1 | P1-T2 | Broker 委托 `DeepSeekAutomationClient`/`stream-codec`，并隔离模式 B chunk | `—` | `—` | `deepseek_sampling_audit`, `release_gap_audit`; review: `protocol_v1_review` | `verified` |
| P1 | P1-T3 | Browser Broker 组合、配置与可见状态 | `—` | `—` | `release_gap_audit`; review: `protocol_v1_review`, `p1_t3_final_review` | `verified` |
| P2 | P2-T1 | out-of-tree DSH `deepseek-web` LLM adapter | `—` | `—` | `dsh_adapter_implement`; review: `dsh_api_surface` | `verified` |
| P2 | P2-T2 | DSH profile、显式 provider 选择与最小安装 bundle | `—` | `—` | `dsh_bundle_implement`; review: `dsh_api_surface`, `dsh_adapter_implement` | `verified` |
| P2 | P2-T3 | 实际 `dsh` 入口到 fake browser peer 的单轮闭环 | `—` | `—` | `dsh_fake_e2e_implement`; review: `dsh_fake_e2e_audit`, orchestration | `verified` |
| P3 | P3-T1 | 无 API key 的真实网页单回合 E2E | `—` | `—` | `dsh_real_smoke_implement`; review: `dsh_adapter_implement`, orchestration | `verified` |
| P4 | P4-T1 | DSH 本地只读工具多回合与最终结果 E2E | `—` | `—` | `harness_tool_mapping`, `dsh_readonly_tools`, `dsh_tool_loop_e2e`; integration: orchestration | `in_progress` |
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

**当前状态**：M0–M3 已验证。操作者最新运行单轮脚本返回 `ok=true/status=completed`：request `web-smoke-0ed11068b66d5ff9f4b8cb4ea423e959`，session `session-f0c01d68-1607-4450-93bd-f246ca73639c`。此前存储行误读的误报已修复，不再要求重复单轮测试。

M4 已实施 T4.1–T4.3：模式 A 复用原 parser 的显式严格模式，官方 read 工具由本机 DSH 执行；actual DSH CLI + fake peer 已验证读取随机文件、结果进入第二次模型请求并完成，也验证读失败能反馈模型。T4.4 真实验收入口与离线测试已实现，真实网页工具结果尚未获取。T4.5 写入/编辑/PowerShell、T4.6 Skills/subagent 尚未开始，不能声称完整开发完成。

T4.2 的明确调整与边界见计划：官方 read-only 本身不约束读取，故窄组合复用官方 scope/guard/canonicalPath/resolve/contains，只有原生 read 可见；不复制文件工具，不声称是 OS 沙箱。首验只读取生成的临时文件，不接触真实用户项目。原单轮 profile 保持不变。

**立即下一步**：

1. 编排负责合并代码、自动回归、构建和更新本机开发版产物，不再把这些步骤交给操作者。
2. 操作者只需重新加载已安装的开发版，按 [本地工具两轮测试](../../tests/real/dsh-web-readonly-acceptance.md) 运行带 `-ReadOnlyTools` 的一个命令；新的配对令牌仍只在本机剪贴板与浏览器中传递。
3. 收到真实两轮成功后继续 T4.5 受控写入/编辑/PowerShell，再做 T4.6；不重复单轮。PR #568、既有全仓失败和 release 工作继续隔离。

## 活动验证记录

| Date | Scope | Command | Result | Notes |
|:--|:--|:--|:--|:--|
| 2026-09-05 | P3-T1 user-confirmed new run | 操作者运行 `start-dsh-web-smoke.ps1 -ConfirmRealWeb` 并回传 JSON | `passed` | `ok=true/status=completed`；request `web-smoke-0ed11068b66d5ff9f4b8cb4ea423e959`；session `session-f0c01d68-1607-4450-93bd-f246ca73639c`；final SHA-256 `94585b3ee9edca4169b98cc00b65664f4ce371e4d20143ffeb3507c7bf22a3f8`，53 bytes。不要求再次单轮测试 |
| 2026-09-05 | T4.1–T4.4 offline | owned-process hard 60s：14 个 parser/Mode-B/Harness/bundle/tool-loop/real-preflight 文件联合 Vitest | `passed` | 145/145，16.69s。T4.1 复用原 parser；模式 B 默认行为不变。T4.2 官方读取缺口保留 current-gap 证据；静态 junction cwd 语义回归先失败后修复 |
| 2026-09-05 | T4 final integration | owned-process hard 60s：6 个 readonly/bundle/单双轮/新旧 real-preflight 文件；`node scripts/dsh-web-agent-tool-smoke.mjs` | `passed` | 最后代码 54/54，10.14s；真实 CLI 的 fake 两轮正常/错误均通过，modelRequests=2、durable/cleanup=true。新验收测试共 17 条，包括实际 DSH 离线安装/配置解析到模型启动前、真实 fake session 原文验证、相同文件相对/绝对写法；没有调用网页 |
| 2026-09-05 | T4 static and compatibility | hard 60s：root `tsc --noEmit`、bundle `tsc -p`、`prompt:freeze`、PowerShell 双入口测试；脚本 `node --check`、`git diff --check` | `passed` | 修复 Cordis dispose API 和独立编译类型后通过；prompt 7/7，无 golden 更新；新旧 PS 入口无 opt-in 零交互/模型副作用，配对值不打印。精确复用已安装的官方包并离线同步 lock，无版本升级 |
| 2026-09-05 | T4.4 real / release | `start-dsh-web-smoke.ps1 -ConfirmRealWeb -ReadOnlyTools`；完整 release 门禁 | `not_run` | 真实两轮待操作者加载更新产物后本机配对执行；不转交秘密，不把 fake 通过当 M4 完成。未做无关全仓审计、PR #568 或发布 |
| 2026-09-05 | P3-T1 real one-turn / historical evidence | 操作者 15:07:37、15:08:10 的两次真实运行；修复后的 `readNewSessionEvidence` 只读复验原始日志 | `passed` | 两次均精确随机终答、唯一逻辑回合和 `turn/end(completed)`；原外层失败为存储行误读。session `af26141f-5c07-4beb-87f7-a0f0d2cf3b2a` SHA-256=`73f98cd76b88c07013acd2680d11979410b3684b95ea48b5377b624a0d22468a`；session `13b1dc75-8880-4b9a-afe1-a87d7417f834` SHA-256=`1a6087c4d00d5282b0f1cafb6013a2096e4eaabf331ddda0859e2090f4607c60`。复验前后哈希一致，新增模型请求=0；未读取历史配对令牌或将日志纳入 Git |
| 2026-09-05 | P3-T1 packed JSONL regression | owned-process hard 60s：`vitest run tests/real/dsh-web-real-smoke-preflight.test.ts` | `passed` | 先在旧实现复现 13/15、2 项预期失败；修复后 15/15。fixture 使用官方 `packChunkRuns` / `encodeSeqRanges`，覆盖打包成功、损坏行、解码序号缺口、非法来源范围及部分流输出后失败的安全 cause_code；窄复核无发现 |
| 2026-09-05 | P3-T1 packed JSONL checks | `tsc --noEmit`（hard 60s）；`node --check scripts/dsh-web-real-smoke.mjs`；`git diff --check`；`npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` | `passed` | 复用已安装的 `@deepseek-ai/dsh-session@0.1.2-rc.1`，补 root 精确直接开发依赖声明，无版本升级。未修改生产扩展、prompt、模型/工具协议或 profile，不重建浏览器产物，不把历史日志复验说成新真实网页运行 |
| 2026-09-04 | G0-T1 | `git remote -v`; `git branch --show-current`; `git rev-parse HEAD` | `passed` | 核实本地 DeepSeek++ remote、活动分支与基线 SHA |
| 2026-09-04 | G0-T1 | GitHub API repo/branch/compare/PR 查询 | `passed` | 核实两个 fork、两个 upstream 和 PR #568 状态；只读 |
| 2026-09-04 | G0-T1 | Runtime/compile/test/build | `not_run` | 本任务只新增治理文档，不改变运行时代码 |
| 2026-09-04 | P0-T1 | `npx vitest run tests/web-model-protocol.test.ts` | `passed` | 22/22；包含逐字节 JSONL golden、错误输入、方向、协商、连续序号、终态、恢复与 reasoning ephemeral 合同 |
| 2026-09-04 | P0-T1 | `npx tsc -p packages/web-model-protocol/tsconfig.json --noEmit` | `passed` | 协议包独立 strict TypeScript 通过 |
| 2026-09-04 | P0-T1 | `npm run compile` | `passed` | DeepSeek++ 根编译通过 |
| 2026-09-04 | P0-T1 | `git diff --check` | `passed` | 静态差异检查通过；独立 reviewer 未发现 blocker/high |
| 2026-09-04 | P0-T2 | `npx vitest run tests/dsh-web-model-transport.test.ts` | `passed` | 29/29；真实回环 socket 覆盖认证、流、拒绝矩阵、断连、取消、查询、checkpoint、late frame、超时和端口释放；实现 Agent 另连续运行三轮均通过 |
| 2026-09-04 | P0-T2 | `npx vitest run tests/web-model-protocol.test.ts tests/dsh-web-model-transport.test.ts` | `passed` | 根复验 52/52；Protocol checkpoint 增量与 Host transport 联合通过 |
| 2026-09-04 | P0-T2 | 两个包级 `tsc --noEmit`; `npm run compile`; `git diff --check` | `passed` | 精确锁定 `ws@8.21.0`、`@types/ws@8.18.1`；独立 reviewer 未发现 blocker/high |
| 2026-09-04 | P0-T3 | `npx vitest run tests/harness-bridge-fake-e2e.test.ts` | `passed` | 4/4；独立 fake browser 仅经公开 API 和真实 loopback socket 完成生成、查询、幂等取消、断连与端口释放 |
| 2026-09-04 | P0-T3 | `node scripts/harness-bridge-fake-smoke.mjs` | `passed` | 单行 JSON：route=`host->fake-browser->host`，terminal=`completed`；未输出配对令牌 |
| 2026-09-04 | P0-T3 | Node 24 import probe; Protocol/Transport/Fake 联合测试; `npm run compile`; `git diff --check` | `passed` | 根复验 56/56；Node 24 原生 workspace TypeScript 入口可用；独立 reviewer 未发现 blocker/high |
| 2026-09-04 | Environment | `npm ci` | `failed` | WXT 0.20.26 的 prepare 在含 `+` 的工作目录生成非法正则；依赖下载本身完成 |
| 2026-09-04 | Environment | `npm ci --ignore-scripts`; `npx wxt prepare`（经本机安全 junction） | `passed` | 生成 `.wxt` 后，定向测试和根编译均在实际工作树通过；此为开发路径兼容措施，不是产品能力 |
| 2026-09-04 | P1-T1 | `npx vitest run tests/dsh-web-model-transport.test.ts tests/harness-bridge-client.test.ts tests/web-model-protocol.test.ts tests/harness-bridge-fake-e2e.test.ts` | `passed` | 71/71；固定 loopback、配对、capability、heartbeat、有界重连、generation fencing 与 restart checkpoint 通过；提交 `4d111e6` |
| 2026-09-04 | P1-T1 | `npm run compile`; `git diff --check` | `passed` | 根编译与静态差异检查通过；最终复核无 blocker/high |
| 2026-09-04 | P1-T2 | `npx vitest run`（Turn Adapter、DeepSeek stream、automation typed fake、既有 StreamFn/provider 定向集合） | `passed` | 根复验 88/88；覆盖真实 dispatch authority、回调重入取消、post-dispatch ambiguous/quarantine、完整 parent→request→assistant 链、reasoning ephemeral 与 UTF-8/event/frame budgets；提交 `ac87871` |
| 2026-09-04 | P1-T2 | `npm run compile`; `git diff --cached --check` | `passed` | 根编译与精确暂存差异检查通过；独立 reviewer 确认无 blocker/high |
| 2026-09-04 | Repository gate | `npm test` | `failed` | 1911/1918；7 个失败均在未修改的既有测试路径。单线程复跑后 3 个波动项通过，仍有 4 个基线/Windows 问题：5 秒 persistence timeout、Node 24 `npm.cmd` spawn EINVAL、Windows path separator 断言、旧 `.release` 目录扫描 EPERM；未据此否定已通过的 P1 定向证据，也未宣称全仓通过 |
| 2026-09-04 | P1-T3 | P1-T3/Client/Adapter/runtime/UI/manifest/Mode-B golden 联合 `npx vitest run` | `passed` | 根复验 14 files / 198 tests；覆盖 browser-local 配置、严格状态 DTO、runtime authority、单在途、断线权威终态、authority epoch、显式重连、UI 竞态/校验、manifest 与既有 StreamFn/provider/`AGENT_*` 合同 |
| 2026-09-04 | P1-T3 | `npm run compile`; `git diff --check` | `passed` | TypeScript 与静态差异检查通过；两轮独立 reviewer 最终确认无 blocker/high |
| 2026-09-04 | P1-T3 build | 工作目录直接 `npm run build:all` | `failed` | WXT 0.20.26 将含 `+++++` 的真实 cwd 未转义地写入正则/HTML chunk path；属于已知本地路径工具缺陷，未修改依赖或掩盖失败 |
| 2026-09-04 | P1-T3 build | 提交 `e4dcc34` 的无特殊字符 detached worktree：`npm run build:all` | `passed` | Chrome MV3、Edge MV3、Firefox MV3 全部构建成功；复用同一锁定依赖，无产品代码差异 |
| 2026-09-04 | P1-T3 build | `npm run verify:manifest-policy`; `npm run verify:extension-utf8`; `npm run verify:sidepanel-chunks` | `passed` | 三端 manifest、177 个构建文件编码和全部 Side Panel chunk 通过；Harness 设置独立 lazy chunk 为 9348 raw / 3194 gzip |
| 2026-09-04 | Repository gate | `npm test` | `not_run` | P1-T3 按任务定向验证；Batch A 全仓门禁按计划在 P2-T3 合并后统一执行，上一条已记录的 4 个 Windows/基线问题仍未声称修复 |
| 2026-09-04 | P2-T1 | `npx vitest run tests/dsh-llm-deepseek-web.test.ts` | `passed` | 根复验 1 file / 19 tests；覆盖正式 Cordis/LLM 注册、metadata、零重试、完整 digest golden、流块顺序、reasoning 丢弃、唯一 usage/terminal、工具终态一致性、Browser 权威取消终态、cleanup gate、无 API key 与禁止 deep import |
| 2026-09-04 | P2-T1 | `npm run build --workspace @deepseek-pp/dsh-llm-deepseek-web --if-present`; `npm run compile`; `git diff --check` | `passed` | 精确锁定 `@deepseek-ai/dsh-llm@0.1.2-rc.1` 与 `@deepseek-ai/cordis@4.0.2`，lock 含 registry integrity；独立 reviewer 复核无 blocker/high/medium。生产 Host service、profile 和外部安装闭环按计划归 P2-T2 |
| 2026-09-04 | P2-T2 | `npx vitest run tests/dsh-llm-deepseek-web.test.ts tests/dsh-web-agent-bundle.test.ts` | `passed` | 根复验 2 files / 25 tests；实际官方 profile composer、Cordis Host lifecycle、异步 service teardown、唯一网页 provider、空 tools、checkpoint、无 Browser `WAITING_FOR_BROWSER` 和无 API/Pi fallback 均通过 |
| 2026-09-04 | P2-T2 | 临时 `DSH_HOME` seed；`dsh plugin --profile deepseek-web-agent add <local-package>`；Node import；`dsh --dump-default-config`；无 Browser headless task | `passed` | 最终 bundle 列表仅含本包、无 `dsh-base`；配置可由官方 DSH `0.1.2-rc.1` 解析，CLI 缺 Browser 明确失败且未回退。只证明当前 checkout link，非独立 tarball/registry 发布闭包 |
| 2026-09-04 | P2-T2 | `npm run build --workspace @deepseek-pp/dsh-web-agent-bundle --if-present`; `npm run compile`; `git diff --check` | `passed` | 根复验通过；独立 reviewer 的 Host 异步 unprovide/stop 与 pairing-token secret metadata 问题已修复；完整发行打包留 P6 |
| 2026-09-04 | P2-T3 | `npx vitest run tests/dsh-web-agent-fake-e2e.test.ts` | `passed` | 1/1；实际 `dsh` CLI、临时 profile、官方 Agent loop、T2.1 adapter、认证回环 WebSocket、独立 fake browser 和唯一 JSONL session durable flush 全部经过；无直接 adapter 调用 |
| 2026-09-04 | P2-T3 | `node scripts/dsh-web-agent-fake-smoke.mjs` | `passed` | 单行脱敏 JSON；终答、唯一模型请求、持久 assistant/message、最终 turn/end(completed)、端口和临时目录释放均通过 |
| 2026-09-04 | P2-T3 | DSH adapter/bundle/fake E2E 联合 `npx vitest run`; `npm run compile`; `git diff --check` | `passed` | 3 files / 26 tests；独立 reviewer 提出的连接错误 fail-loud、headless 环境 allowlist 和 Windows 子进程树清理问题已修复，最终无 blocker/high/medium |
| 2026-09-04 | Batch A gate | `npm run compile` | `passed` | 根 TypeScript 编译通过 |
| 2026-09-04 | Batch A gate | `npm test` | `failed (60s timeout)` | 按硬上限终止；终止前出现 7 个非 Harness 路径失败：Side Panel runtime/navigation、tool-provider import、persistence budget、3 个 Shell Host 测试。新增 DSH 定向集合另行 26/26 通过；终止后未发现本轮新启的残留 Node 测试进程，未把全仓门禁记为通过 |
| 2026-09-04 | P3-T1 offline | `npx vitest run tests/real/dsh-web-real-smoke-preflight.test.ts` | `passed` | 1 file / 10 tests；默认零子进程/网页副作用、显式确认、Node/Harness/profile/provider、Broker 输入、ambient 与两层 `.env` 模型凭证、完整 14-row YAML allowlist、durable 单轮顺序/敏感值和 owned process-tree cleanup 均通过 |
| 2026-09-04 | P3-T1 offline | `npm run smoke:dsh-web-agent:real`（不带 opt-in） | `passed (expected refusal)` | 稳定输出 `REAL_WEB_CONFIRMATION_REQUIRED` 并返回非零；未启动 DSH、未连接网页 |
| 2026-09-04 | P3-T1 offline | `node --check scripts/dsh-web-real-smoke.mjs`; `npm run compile`; `git diff --check`; `npm install --package-lock-only --ignore-scripts --offline` | `passed` | runner 语法、根 TypeScript、差异与 `js-yaml@4.3.2` 直接精确依赖锁均通过；独立 reviewer 最终高/中风险项已全部回流修复 |
| 2026-09-04 | P3-T1 real web | `npm run smoke:dsh-web-agent:real -- --confirm-real-web` | `not_run` | 需要操作者明确准备已登录页面、扩展 Broker、配对值与隔离 DSH_HOME；未把离线测试冒充真实网页证据 |
| 2026-09-05 | P3-T1 real web | `npm run smoke:dsh-web-agent:real -- --confirm-real-web` | `blocked at preflight` | 用户已明确 opt-in，但编排进程未继承 `DSH_HOME`/Broker 五项临时环境变量；runner 以 `REAL_WEB_BROWSER_ATTESTATION_REQUIRED` 在读取 profile、启动 DSH 或请求网页前停止。需从配置这些变量的同一 PowerShell 执行，不能把本地配对令牌经聊天转交 |
| 2026-09-05 | P3-T1 first-run setup | seed + `dsh plugin --profile deepseek-web-agent add --offline <local-bundle>`；实际 `--dump-config` 经 `validateProfileDump` | `passed` | Node 24.18.0 / DSH 0.1.2-rc.1；已准备项目忽略目录中的隔离 home，实际解析为唯一 `deepseek-web` profile；无网页请求 |
| 2026-09-05 | P3-T1 first-run UX | `.\tests\real\start-dsh-web-smoke.test.ps1`; PowerShell parser; `git diff --check` | `passed` | 新入口自动设置五项测试参数、交互配对后调用既有 runner；离线测试验证无 opt-in 无副作用、配置一致、令牌不打印、cwd 恢复。仅脚本/文档改动，未改变 TS/模型/网页协议；未重跑全仓或浏览器构建。用户同样报错表明先前引导缺少首次配置，真实网页证据仍待执行 |
| 2026-09-05 | P3-T1 real web | 操作者运行 `.\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb`；检查该次唯一新增 session | `failed` | 外层 `REAL_WEB_DSH_FAILED`；durable `turn/end` 为 `error`，code=`WEB_MODEL_PROTOCOL`，无最终 assistant/message。已进入请求阶段；后台漏接既有认证缓存/刷新流程是本轮确认并修复的代码缺陷，不把此次失败记为通过 |
| 2026-09-05 | P3-T1 auth repair | Node owned-process runner（硬 60s）执行 9 份 Harness/Transport/DSH/real-preflight/Mode-B 定向测试 | `passed` | 191/191；含无网页 localStorage 的真实缓存读取函数、缺认证零派发、异步取消与迟到结果零派发、已知安全错误透传、未知错误不外泄、唯一关联失败 session 的 cause_code；独立窄复核无阻断 |
| 2026-09-05 | P3-T1 auth repair | `npm run compile`; `npm run prompt:freeze` | `passed` | 根编译通过；7/7 prompt golden 通过，未更新任何 prompt golden；修复后的真实网页请求未由本轮 agent 执行 |
| 2026-09-05 | P3-T1 auth repair build | 无特殊字符 detached worktree `C:\temp\deepseek-pp-build-authfix-20260905`（`a5b9380`）：`npm run build:all`; manifest/UTF-8/sidepanel chunk 验证 | `passed` | Chrome、Edge、Firefox MV3 均构建成功；manifest 通过、177 个文本资源编码通过、三端 chunk 预算通过。构建沿用既有 Pyodide browser-externalization warnings，未修改依赖 |
| 2026-09-05 | P3-T1 repaired local integration | Node owned-process runner（硬 60s）：`node scripts/dsh-web-agent-fake-smoke.mjs` | `passed` | 真 DSH CLI/Agent loop → adapter → 认证回环 → fake browser：唯一 modelRequests=1、terminal=completed、durable=true；不是实际 DeepSeek 网页证明 |
| 2026-09-05 | P3-T1 installed build refresh | 比较新旧构建文件 SHA-256；备份并原位更新三个 `background.js`；完整再次比较 | `passed` | 安装目录 `C:\temp\deepseek-pp-build-e4dcc34\dist` 下 300 个文件与 `a5b9380` 新构建逐文件一致；原三文件保存在同级 `authfix-backup-a5b9380`。未删除旧 worktree 的源文件/未提交修改，未变更用户扩展数据或 ID；需操作者点重新加载 |
| 2026-09-05 | P3-T1 repaired real web / full gate | 更新后的真实网页复测；`npm run ci:quality` | `not_run` | 本轮未读取/转交操作者的配对秘密；真实复测继续由原 PowerShell 启动。未执行发布闭环或重跑全仓既有失败，M3 未宣布完成 |
| 2026-09-05 | P3-T1 real retry | 操作者两次运行配对脚本；读取 13:09/13:11 新增 session 的稳定终态字段 | `failed` | 两次均 `MODEL_PREPARATION_FAILED`，无最终 assistant/message。测试子进程退出会关闭本地 Broker，扩展经历有限重连后离线；该离线不是独立模型失败。磁盘 Chrome background SHA-256 仍为 `696d25b16a352cafdd2e6c2c4e4100cb2e2dbc999c3b568157ed014439453719`，实际浏览器运行版本尚待详情截图确认 |
| 2026-09-05 | P3-T1 composition diagnostic | 硬 60s：`vitest run tests/harness-browser-composition.test.ts`; `npm run compile`; `git diff --check` | `passed` | 新增实际 Host + 实际浏览器 WebSocket Client + 实际 Coordinator + 实际 Turn Adapter 纵切片（仅 DeepSeek 外部 I/O 用本地 fixture）：2/2，空工具正常回合 completed、缺认证精确 AUTH_REQUIRED 且零派发。编译通过；不将此证据当作真实网页通过，未修改生产代码或要求用户重复相同测试 |
| 2026-09-05 | P3-T1 installed artifact diagnosis | 操作者扩展详情截图；`node tests/fixtures/harness-bridge/bundle-probe.mjs <installed-background.js> [cached/missing/sync]`（owned-process 硬 60s）；`node --check` | `passed` | 13:23 截图确认正确 `e4dcc34/dist/chrome-mv3` 目录。SHA 固定的真实 minified artifact 在离线 VM 中跳过后台启动，仅使用 fixture I/O：cached=completed，missing=AUTH_REQUIRED，sync=PREPARATION_FAILED；三类均无 generic。没有访问实际浏览器存储或网络，没有修改生产代码/产物；实际 worker 是否已重新激活仍需操作者侧验证，M3仍未通过 |
