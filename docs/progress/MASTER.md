# Web Model Broker × Local DSH — Active Progress

> 本页是本轮工作的唯一活动进度真源；历史项目记录继续保留在 `docs/archives/`，不得把历史完成状态当作本轮已完成状态。
>
> **Tracking mode**: `LOCAL_ONLY`（尚未创建 GitHub Issue、Milestone 或 PR）
>
> **Started / last updated**: 2026-09-04 / 2026-09-06
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
| M4 Local-tool multi-turn | 网页模型请求 DSH 本地只读工具，结果进入下一模型回合并返回最终结果 | `verified` | 2026-09-05 操作者真实网页两轮：2 model steps、1 read、1 result、同一 session completed；本地只读复验与终答哈希一致 |
| M5 Disconnect/cancel/recovery | 浏览器离线、取消、断连、重连查询和不明结果处理 | `in_progress` | 离线=`waiting_for_browser`；取消幂等；`ambiguous` 不自动重放；唯一终态可重复查询 |
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
| P4 | P4-T1 | DSH 本地只读工具多回合与最终结果 E2E（T4.1–T4.4） | `—` | `—` | `harness_tool_mapping`, `dsh_readonly_tools`, `dsh_tool_loop_e2e`; integration: orchestration | `verified` |
| P4 | T4.5 | 官方受控写入、编辑与 Linux 命令 | `—` | `—` | `file_write_acceptance`, `windows_command_route`; integration: orchestration | `verified` |
| P4 | T4.6 | 官方 Skills/剪枝/压缩/串行子 Agent/会话恢复增量 | `—` | `—` | `harness_features`, `windows_command_route`, `file_write_acceptance`; integration: orchestration | `verified` |
| P5 | T5.1–T5.4 | Host journal、Browser 结果索引、取消与原 CLI 崩溃恢复 | `—` | `—` | `harness_features`, `windows_command_route`, `file_write_acceptance`; integration: orchestration | `in_progress` |
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

**当前状态**：M0–M4、T4.5–T4.6 已验证。P5 断线、取消和崩溃恢复已实现，实际 CLI、真实工具及运行时定向回归通过；全量 252 个测试文件共 2280 项通过、0 失败、6 项既有平台跳过，三端扩展构建通过。真实网页已作为本机 DSH 模型完成读取、写入、执行短测试及最终回答；P5 新扩展尚需真实只读复验，P6 尚未开始，因此仍不是完整交付版。

M4/T4.1–T4.4 的真实只读运行保持有效。T4.5 的文件编辑及 Linux 命令组合均已通过实际 DSH/fake browser 闭环，工作区写入/越界拒绝/取消清理已实测；本次操作者真实网页运行 `command-0469b0dc-bf30-44fb-ac29-ddbc1e8bcf36` 又完成 2 model steps、1 Bash call/result、文件和短测试验证、同一 session completed。原始 Linux session 与文件哈希只读复验一致，新增网页请求为零。独立 editor 专用真实网页检查未执行，不能以本次 Bash 验收冒充。

T4.6 已补齐可压缩历史的消息数／编码字节保护：fork 独立分支的真实发送前预算检查复用原恢复及压缩事务，两项旧 `current-gap` 已从安全拒绝改为自动摘要后继续成功。最终候选在独立 checkout 离线安装，4 份定向测试 61/61 通过；包含实际 65 轮、当次输入跨界、摘要合法前缀、工具对保留、失败不提交、持久化恢复及外部保留码拒绝。它不承诺固定系统／工具包络或不可分单元总能容纳。P5 尚待新扩展真实验收，P6 安装交付尚未开始，不是完整交付版。

T4.2 的明确调整与边界见计划：官方 read-only 本身不约束读取，故窄组合复用官方 scope/guard/canonicalPath/resolve/contains，只有原生 read 可见；不复制文件工具，不声称是 OS 沙箱。首验只读取生成的临时文件，不接触真实用户项目。原单轮 profile 保持不变。

**立即下一步**：

1. P5 新扩展待一次真实只读验收：[三步测试说明](../verification/P5_简短测试.md)。Windows 即可，不需要 Ubuntu，也不需要操作者手动制造失败。未操作已安装扩展或重新调用真实网页。
2. T4.6 的三份固定摘要归档已接入开发 checkout；[来源与重建](../../vendor/harness-request-budget/README.md)。Harness fork 只修改独立 `codex/web-request-budget` 分支，master 保持 `76fda729...`；本轮 P5 不修改它，也没有推送远端。
3. P5 恢复仅查询原 request ID：`unknown` 不是 `not_started`，completed 状态索引不等于恢复了终答／工具内容。只有新的真实只读验收通过后才能关闭 M5/Batch C，随后进入 P6 安装交付；PR #568、无关整改和发布保持隔离。已有真实 Linux 命令证据及两份 Ubuntu stash 保留不变。

已安装的旧开发版仍在 `C:\temp\deepseek-pp-build-e4dcc34\dist\chrome-mv3`，本轮未覆盖。P5 新构建为 `C:\temp\deepseek-pp-p5-5e9e641\dist\chrome-mv3`，Chrome/Edge/Firefox 均已验证；需禁用旧版并加载新目录，使用新扩展 ID 配对。构建来源 `5e9e641`，后续 `08e651e` 仅测试/smoke、`4fa7ac7` 仅真实验收校验与 fixture、`6ccffae` 仅测试时序，浏览器生产代码未变。不打 ZIP、不安装到浏览器、不发布。

**T4.5 Linux 环境已准备**：Ubuntu 26.04 LTS / WSL2，Linux Node 24.18.0、Bubblewrap 0.11.1。源码从 Windows 当前分支本地 clone 到 `/home/worker/deepseek-web-harness`，Linux `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定的 1024 包，包含可用 Linux Koffi 原生模块，WXT prepare 通过；Windows `node_modules` 未动。官方 Windows ACL current-gap 仍保留，但不再阻断这条显式 Linux 路线。

按用户授权，原 `/etc/wsl.conf` 完整备份为 `/etc/wsl.conf.deepseek-web-harness-20260905-aa55ec6.bak`（SHA-256 `8be4902d610d03ab57e68cba53da412d00fa5186728e452712b9ba5b7b9ab6bf`）。保留原 boot/user 配置，新增 `[interop] enabled=false`、`appendWindowsPath=false`，现配置 SHA-256 `43b76b671c4938b19b442b6c8ab9a50cf22b164b80feb41af6ab83dfd23331e2`，仅 `wsl --terminate Ubuntu` 后重启。实测 binfmt 接口可读且 WSLInterop 项不存在，绝对路径 Windows cmd 固定 echo 返回 126；Ubuntu 内仍可正常运行 Linux 沙箱。未删除发行版或其文件、未改其他发行版、未改 Windows 网络/防火墙；此设置影响整个 Ubuntu 启动 Windows 程序，恢复原配置再重启可撤回，但恢复后命令 profile 将拒绝启动（[Microsoft 配置说明](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)）。

Windows 启动器只临时用 `WSLENV` 的 `/u` 标记传递固定配对配置，并在退出/异常时恢复原 WSLENV；令牌不进入 argv/文件。实际非秘密方向探测通过，Windows→WSL `127.0.0.1` 在重启后仍可连接（[Microsoft WSLENV 说明](https://learn.microsoft.com/en-us/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv)）。Linux 命令限制是文件写入边界，并非全部读取/网络/恶意本机管理员隔离。

## 活动验证记录

| Date | Scope | Command | Result | Notes |
|:--|:--|:--|:--|:--|
| 2026-09-06 | P5 real readonly / auth diagnosis | 操作者两次运行；原 `decodeSessionLog` 只读解析两份 session，读取 journal 的状态字段 | `failed before model dispatch` | `readonly-ee82aebe-2b5e-4f3e-82c1-530590692f22`、`readonly-443003f9-3006-4166-9db7-b677cce0e97a` 均 `DEEPSEEK_AUTH_REQUIRED`，journal=`failed/not_started/sequence0`，无工具调用。源码确认是扩展缓存及页面刷新未获得非空 Authorization，不是已发模型请求后的服务端拒绝。日志不能区分页面未注入、不同浏览器/用户配置或页面 token 不可读；未读取真实凭据或擅自改认证协议。测试说明补充同一 Chrome 配置中新开页面并完成普通网页对话，复用现有 HEADERS_CAPTURED 路径。仅文档修改，`git diff --check`；未重跑自动测试或真实网页，M5 保持待验收 |
| 2026-09-05 | P5 full automated regression | Ubuntu / Node 24.18.0：原 Vitest `run --shard=N/4 --maxWorkers=4 --reporter=json`，每组 `timeout --kill-after=2s 55s` | `passed` | 全部 252 文件，无遗漏、重复或额外文件；2280 passed / 0 failed / 6 既有平台 skip（共 2286）。报告保留于 Linux `.tmp/p5-full-4fa7ac7/`：2–4 组为 `4fa7ac7`；第 1 组最终为 `6ccffae` 的 `shard-1-after-barrier-fix.json`。首次第 1 组旧 buffer-overflow 测试未等待消费／socket 关闭导致 1 项失败，`6ccffae` 仅补明确观察屏障，无生产变更；原失败报告保留。Windows 该文件 34/34；Windows/Linux compile 通过。不是新的真实网页证据，不据此关闭 M5 |
| 2026-09-05 | P5 original CLI and side effects | Windows `node scripts/dsh-web-agent-recovery-smoke.mjs`；实际 editor/runtime 原Vitest | `passed` | smoke 9/9，32.45s，55s上限；4个实际CLI阶段kill/restart均在持久状态确认后执行，同profile/原journal/同ID查询、0新generate，远端completed仍本地ambiguous。取消5项：预取消零发送、accepted/streaming重入、丢ack超时、终态后幂等，单终态和进程/端口/临时目录清理。editor前/后与runtime/fake联合17/17：半工具流不执行，已创建文件恢复后bytes/inode/mtimeNs/ctimeNs不变，真实summary不造checkpoint、真实child独立Session可恢复 |
| 2026-09-05 | P5 independent browser build | owned clone `5e9e641`：离线ci、prepare、compile、prompt、3端build和静态检查 | `passed` | Node24.18；1019包26.653s；prepare6.649s、compile2.934s；prompt7/7；Chrome/Edge/Firefox8.732/8.952/8.360s；manifest、177文件UTF8、3端chunks全过。lock SHA4440b0e2b669ddfef9416ed25d74827ada9277ea5071b39e036f377cf6526e90不变，clone干净，background SHA8639ea10cd99098c4c4e822eb46b6bc43ca5edf66e5d57dd674a2371bd469c6c；仅既有Pyodide externalization及依赖弃用警告，无ZIP/浏览器安装 |
| 2026-09-05 | P5 real preflight regression | 全仓首轮后修复；4份真实入口离线原Vitest | `passed targeted` | 首轮2283项中2272pass/5fail/6既有skip；5例均因旧Host配置白名单遗漏新增journalPath。4fa7ac7严格绑定原profile自有路径并更新唯一dump fixture，新增缺失/任意路径/其他profile拒绝回归，Windows74/74、7.81s；Windows/Linux compile通过。未放宽校验或删除失败用例 |
| 2026-09-05 | P5 production integration targeted | Windows Node24.18：11份协议/journal/cache/settings/真实socket/adapter/bundle/scheduler/真实runtime/cancel/real-preflight 原Vitest；compile | `passed targeted` | 167/167，8.23s，外层55s watchdog；compile exit0。覆盖metadata-only快照、损坏/未来保存、单owner、存盘后响应、自动同ID查询、真实adapter取消、实际自动摘要失败无checkpoint、真实child独立session恢复。原CLI profile导入时发现新增参数属性不兼容Node strip-only，已改显式字段后原bundle通过。不等于P5完整门禁：实际CLI kill/restart矩阵仍在完成，全仓及新的真实只读验收未跑 |
| 2026-09-05 | T4.6 actual Windows/Linux checkout delivery | Windows compile及原CLI/Profile安装；Ubuntu原生离线安装、61项定向及CLI/bundle7项 | `passed` | 实现提交412826959e3a8156a4d0c7cffedf7390d54b571f；Windows compile exit0，实际profile/CLI/bundle解析同一份patched包、CLI1/1和安装6/6通过。Ubuntu worker ff-only更新、Linux Node24.18.0、npm ci --offline 1024包24s、wxt prepare3.783s；两批各timeout55s：61/61（5.81s）、7/7（2.82s）。三补丁包路径／SHA跨锚点一致，锁SHA4440b0e2b669ddfef9416ed25d74827ada9277ea5071b39e036f377cf6526e90未变。两份stash、ignored真实证据保留，无Node/DSH/Vitest遗留，不改Ubuntu配置、不调用真实网页 |
| 2026-09-05 | T4.6 fixed dependency integration | 独立 `C:\temp\deepseek-web-budget-integration`：最终归档 `npm ci --ignore-scripts --offline`；context/helper/features/adapter 四份原 Vitest 定向 | `passed` | 61/61，8.57s，hard60。128消息／1MiB不增限；65轮自动摘要后继续、新输入字节越界恢复、完整最新工具对、失败／不缩小摘要保留历史及恢复会话通过。外部 Browser 冒用本地预算码转 WEB_MODEL_PROTOCOL，只有本地未发送请求可进入此恢复。1172条锁记录、全部依赖版本不变，只固定3包的路径和integrity；7个消费者解析同一LLM实例 |
| 2026-09-05 | T4.6 Harness fork verification | fork 原包级 Vitest、leaf tsc、真实 Loader；原 headless snapshot 入口 | `passed targeted` | LLM 247/247、compaction 141/141、retry 40/40、replay 108/108；真实CLI keyless replay 1/1，快照metadata 2/2。取消微任务窗口已确认修前失败、最终precommit检查修后通过。fork提交34d57aed2e；master未改。README/Agent Note成对更新、type-equiv400块通过、配置及Cordis目录按原生成器更新。未执行全仓doc-sync/网站构建或完整上游发布门禁；test:docs聚合因旧接口文档漂移失败且剩余中断，相关漂移已修后单项通过，不将其记为全量绿色 |
| 2026-09-05 | T4.6 final static/browser closure | 独立最终候选：compile、prompt、Chrome/Edge/Firefox、manifest/UTF8/chunks | `passed` | compile2.707s；prompt7/7；三构建9.641/8.922/9.208s；manifest、177文件UTF8、三端chunks通过。仅既有Pyodide node模块externalization warnings；不修改已安装扩展、不重复真实网页调用。最新代码仅做定向回归，不冒称重跑下面历史全仓2183项 |
| 2026-09-05 | Batch B final full test | 冻结代码后原生 Vitest `--shard=1/4` 至 `4/4`，每项 Linux timeout55s/killafter2s，独立完整 JSON | `passed` | 4次 exit0；2183 passed、0 failed、6既有平台skip，共2189 tests。246份报告文件与 `rg --files tests -g '*.test.ts'` 精确对应，遗漏/重复/额外文件均0，不排除失败测试。四批外层25.654/38.419/23.687/28.425s。全仓绿色不等于current-gap功能完成，不替代真实网页证据；Windows全仓历史路径/EPERM问题不在本次Linux通过结论内 |
| 2026-09-05 | Batch B regression repairs | 四分片完整初跑后回流对应文件；各修复定向测试及最终 compile/prompt/build | `passed targeted` | 初跑 2189 tests：2179 passed、4 failed、6原有平台skip。修复：①本分支新增设置标签的严格导航fixture遗漏，5/5；②本分支 types→coordinator 引入的18节点静态环，迁移唯一纯DTO合同并保留旧exports，no-SCC通过；③旧bundle CLI fixture补与生产一致的offline/workspace-root，Linux6/6；④仅Shell Host测试适配实测npm keyed JSON，保留单包身份/落地验证，Linux7/7。不改Shell Host生产/扫描规则/golden/依赖，无关Windows EPERM/路径基线未声称修复 |
| 2026-09-05 | Batch B final static/build | 最终冻结代码：Linux compile、prompt:freeze、Chrome/Edge/Firefox build、manifest/UTF-8/chunk | `passed` | compile exit0 18.223s（并行负载）；prompt 7/7；三端build exit0，8.760/7.646/8.151s；manifest、177文件UTF-8、三端chunk通过。initialShell raw384043/gzip117312、Harness子块raw9348/gzip3194；只含既有Pyodide externalization warnings，不更新已安装扩展 |
| 2026-09-05 | Batch B static/build | Linux `npm run compile`、`prompt:freeze`、三个 `build:all` 子命令、manifest/UTF-8/sidepanel chunk 检查 | `passed` | 最终编译含新增 context-budget 测试，exit0，3.51s；prompt 7/7；Chrome/Edge/Firefox 均 exit0，7.57/7.28/6.77s；manifest、177 个文本文件 UTF-8 和 chunk 预算均通过。新测试首次编译的 9 个类型错误已由官方 SessionId/模块类型声明修复，无 any 绕过。仅有既有 Pyodide node:* externalization warnings，无依赖/预算修改，不更新用户安装扩展 |
| 2026-09-05 | Batch B monolithic test attempt | Linux `timeout --kill-after=2s 55s vitest run --maxWorkers=8`，第二次加 JSON reporter | `incomplete / exit1` | 两次均未产出最终总结/完整 JSON，不能计通过或按普通 timeout 解释。只读诊断发现 WSL poweroff 记录、无已发现 OOM 证据，但未证实与两次运行的精确关联/发起者；同路径 sleep 窄探针的正常 timeout 返回124。未改系统配置，改用原生 Vitest 四分片，各自硬上限55s并必须生成完整报告，不排除任何测试 |
| 2026-09-05 | T4.5 real web Linux command | 操作者 `start-dsh-web-smoke.ps1 -ConfirmRealWeb -LinuxCommands`；唯一运行原 JSONL/输出文件只读复验 | `passed` | run `command-0469b0dc-bf30-44fb-ac29-ddbc1e8bcf36`，session `session-40f1d883-9aae-4849-99e8-603baa78936b`；2 model steps、1 tool call/result、completed，command/file/test verified 全 true。final 56 bytes，SHA-256 `75101450fd6ee9c422ea9a0988bf37d7ec87076bf5c56134ffcd2ff4528de69a`；file SHA-256 `87cffb6059a2ee244a2244613a8b963213218e87a056e0f0e4e15a720557d2c9`；原 session SHA-256 `f8885f05e069cc052a8fb1de68d69c575a962e16ceb324769ca28d48afa7fcb3` 复验前后不变。实际 verifier 及 nonce 派生命令一致，未读取历史配对秘密，新增网页请求=0 |
| 2026-09-05 | T4.6 long-context limits | hard60：`vitest run tests/dsh-web-context-budget.test.ts tests/dsh-web-harness-features.test.ts`（实现 lane） | `passed tests; current-gap remains` | 14/14，5.09s；新增 5 项覆盖精确消息/字节限额、正常 token 自动摘要、64 短轮后拒绝第 65 轮、提前 compactNow/持久恢复、转义新输入超帧。越界后摘要也可能越界且不造 checkpoint；安全失败不等于自动边界修复。没有修改 Harness core、token 定价、协议限额或生产算法 |
| 2026-09-05 | T4.5 Windows launcher | 两个 PowerShell 入口测试（每项hard60）；精确lock离线同步；git diff --check | `passed` | 原3模式保留，新Linux模式无opt-in零作用，缺环境在配对前拒绝，配对不进argv，固定WSLENV传递与异常/确认中断后6项变量及cwd恢复，含空格路径。未把mock launcher当真实网页；无升级版本、无浏览器改动 |
| 2026-09-05 | T4.5 Linux final integration | Linux内 timeout55s：Linux guard + 实际CLI + 真实入口离线三文件联合 Vitest | `passed` | 45/45，4.77s；在独立Linux安装下重新验证最终生产组合/工具执行/原JSONL验收器，不只是Windows单测模拟平台。没有新增网页请求 |
| 2026-09-05 | T4.5 Linux production CLI | 独立 Linux timeout + Windows hard60：`vitest run tests/dsh-web-linux-commands-e2e.test.ts` | `passed` | 5/5，4.54s；官方 Loader 三增量、4工具目录、Bash读未知nonce/建文件/检查、tool result进入第2模型轮、实际diskbytes与原JSONL双重验证、CLI/port/temp清理。原JSONL也通过新的真实验收verifier；fake脚本与真实runner共用固定命令，不宣称真实网页通过。修复profile install显式 --workspace-root，以及Cordis自装服务的第二阶段inject，不绕过guard |
| 2026-09-05 | T4.5 Windows integration | owned-process hard60：13个policy/profile/新旧CLI/三个真实入口离线测试文件；root和bundle tsc；prompt:freeze | `passed` | 冻结最终代码后132 passed/1 Linux专用skip，15.12s；两处编译exit0，prompt 7/7。早一轮撞到未完成的named-import测试版本6例失败，最终os/fs对象成员mock版全过；无golden修改、无浏览器构建/全仓/发布 |
| 2026-09-05 | T4.5 authorized Ubuntu setup | 配置 hash/备份/install；仅 terminate Ubuntu；独立 Linux clone + npm ci ignore-scripts；WXT prepare | `passed` | 原配置备份与新 hash 见上；Linux 依赖独立于 Windows；Windows cmd 实际 exit126，bwrap true exit0。没有重装 Ubuntu、删除用户数据、修改网络或浏览器 |
| 2026-09-05 | T4.5 actual Linux tool chain | Linux 内 timeout55s + kill-after2s：`node tests/fixtures/dsh-web-agent/exec/linux-sandbox-probe.mjs` | `passed` | 官方实际 registry→Bash→sandbox→subprocess，bwrap/full，6 个 managed processes；工作区写入、同级文件 unchanged/denied、interop126、timeout/cancel实际PID退出、fixture cleanup全部通过。首轮仅fixture错误把官方常量名当字符串值，改用导出的 TOOL_ABORTED（值ABORTED）后通过；不冒充产品/真实网页验收 |
| 2026-09-05 | T4.5 post-restart connectivity | 有界 `wsl-loopback-probe.mjs`；WSLENV固定非秘密值测试 | `passed direction` | Linux 127.0.0.1:44200，Windows echo一致、Linux原端口重绑、child关闭；Windows即时重绑仍不可用，未宣称Windows转发保留已释放。WSLENV /u传递验证成功，没有配对值或网页凭据输出 |
| 2026-09-05 | T4.5/T4.6 final integration | owned-process hard 60s：14 个 adapter/scheduler/bundle/只读/编辑/三工具/Harness features/CLI/真实入口离线测试文件联合 Vitest | `passed` | 144/144，16.72s。实际 DSH CLI + 两个生产增量加载并由官方 editor 创建文件；实际官方 loop + authenticated fake peer 验证 Skill→独立 child→parent 编辑落盘→JSONL resume；一次 compaction 与 checkpoint resume、pruner 重写/恢复、失败不造摘要和非法摘要拒绝。全部本机 Windows，无真实网页请求、无 Ubuntu 操作 |
| 2026-09-05 | T4.5/T4.6 compile and compatibility | hard 60s：root/adapter/bundle tsc；prompt:freeze；离线 package-lock-only（ignore-scripts）；`git diff --check` | `passed` | 最终三处编译通过，prompt 7/7。修正测试的官方事件一参签名、pruner type import 和 accepted 后失败 external_outcome 后根编译复跑通过；修正内部 driver 精确包名后离线 lock 成功，未升级版本。未重建浏览器、未跑全仓/发布门禁 |
| 2026-09-05 | T4.5 FileEdit operator entry | lane hard 60s：新旧真实入口离线 Vitest；PowerShell 三模式入口测试 | `passed offline; real web not_run` | 38/38，9.42s，PS 通过；新增 `-FileEdit` 复用既有准备/启动/清理，验证 view→唯一修改→终答及磁盘精确字节，临时证据保留。实现提交 `886d2b4`；操作者尚未回传新网页结果，不把 fake 通过当真网页成功 |
| 2026-09-05 | T4.6 shared model admission | hard 60s：scheduler + adapter 定向 Vitest | `passed` | 28/28；新增 FIFO 最多 16 个待执行请求，取消排队不创建/取消 Browser 请求，溢出不损伤已接受项，cleanup 未确认不发送后继。沿用 Protocol v1：主/子均 agent purpose，以独立 session 区分；没有第二 request journal/终态账本。源码复核确认官方 child scopes 共用原 LLM runtime/adapter |
| 2026-09-05 | T4.6 exact official tool composition | lane hard 60s：harness-tools policy + workspace-files policy | `passed` | 30/30，3.21s；新组合只捕获自己安装的原官方 editor/skill/subagent 定义，拒绝同名 scoped shadow、改名拷贝、后置替换、短路放行和取消/卸载。普通 editor/readonly 仍不准其它工具；Skill 来源是可信项目指令，不声称上游 Skill 发现对符号链接提供 OS 读取隔离 |
| 2026-09-05 | T4.5 Windows route decision | 锁版 sandbox-local/windows-acl 已安装源码与已有失败 fixture 只读核对 | `no in-scope native alternative` | Windows chain 仅 windows-acl/partial；runnerCommand 只是外部 runner override，不是已存在第二沙箱。没有重复越界写探测、系统安装或配置更改；Linux 依赖及 interop 决策仍待另行确认，不妨碍无 shell 增量 |
| 2026-09-05 | T4.5 authorized WSL environment | `wsl -d Ubuntu --exec` 下有界版本、程序路径和 `/etc/wsl.conf` 只读检查 | `passed inventory` | Ubuntu 26.04 LTS，WSL2 kernel 6.18.33.2；uid 1000；已有 Linux Node 24.18.0、bwrap 0.11.1。配置只有 boot/systemd 和 default user，无 interop 设置；未安装、改配置、提权或重启 |
| 2026-09-05 | T4.5 Linux official imports | Windows owned-process hard 60s + Linux `timeout 30s`；实际 Linux Node 从项目导入锁版官方包 | `blocked native dependency` | cordis/bash-sandbox 可导入；subprocess-local/sandbox-local 缺少 Linux Koffi native module。未把 Windows 依赖替换成 Linux 版本，也未安装依赖；完整 DSH Linux 工具探测未执行 |
| 2026-09-05 | T4.5 direct Bubblewrap prerequisites | 独立有界 `/usr/bin/bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`，分别运行 `/usr/bin/true` 和固定 Windows echo | `current-gap: Windows interop available` | 两次 exit 0，后者返回固定 `DSH_WSL_INTEROP_PROBE`。只验证直接 Bubblewrap，不是实际 DSH 工具链；没有 Windows 写入/配置变更。官方后端不屏蔽 WSL 互操作，也不提供完整读取/网络隔离，不接生产 shell |
| 2026-09-05 | T4.5 Windows → WSL loopback | hard 60s：`node tests/fixtures/dsh-web-agent/exec/wsl-loopback-probe.mjs`；Linux 内部独立 timeout | `passed TCP direction` | Linux 仅绑定 127.0.0.1:43498，Windows 随机 echo 精确匹配，Linux 原端口重新绑定确认释放，owned child 已退出。Windows 即时重绑定仍 EADDRINUSE，未声称 Windows 转发端口释放；未改防火墙/网络、未开放 0.0.0.0、未连接浏览器或模型 |
| 2026-09-05 | T4.5 reusable Linux diagnostic | `node --check` 两个独立 probe；`git diff --check` | `passed static; Linux DSH probe not_run` | 保存实际官方工具组合的 Linux fixture（正常命令、workspace 写入、兄弟目录拒绝、超时/取消、Windows interop）。动态导入前检查 Linux/Node 24；只操作唯一自建根并清理，不在 /tmp 制造隔离假阳性。未因语法通过而声称 runtime/产品通过；没有浏览器代码变化，不重建扩展 |
| 2026-09-05 | T4.5 production file integration | owned-process hard 60s：9 个旧只读/新增编辑/bundle/单双三轮/real-preflight Vitest 文件联合运行 | `passed` | 82/82，13.47s；共享单一路径准入保留只读行为；官方 Editor 四操作、先读/CAS、temp例外/外部路径/junction/目录 view 拒绝、生命周期均覆盖。实际 DSH CLI + 正式 workspace-files patch 经 fake 模型完成 view→一次 str_replace→第三轮终答，清理前独立读取确认真实落盘，nonce 不从 prompt 或外部 getter 传入模型 |
| 2026-09-05 | T4.5 compile and compatibility | owned-process hard 60s：root tsc、bundle tsc、prompt:freeze；两处测试类型修正后精确复跑相关用例 | `passed` | 根与 bundle 编译通过；prompt 7/7。改用官方 public snapshotEvents（不用私有 session.log）并修正 nonce fixture 类型后，两项选中用例通过，5 项未选中明确 skip；没有重跑已确认的原生越界演示。无浏览器代码改变，不重建扩展，不运行无关全仓/发布门禁 |
| 2026-09-05 | T4.5 real web write / command production | 新增真实网页写入调用、生产命令接线 | `not_run` | 本轮未请求浏览器、未写用户项目；只读 M4 的实际成功记录不变。文件编辑的新三轮是实际 DSH + fake 模型证据，不冒充网页写入验收；命令隔离路线需要操作者选择 |
| 2026-09-05 | T4.5 official editor | hard 60s：`vitest run tests/dsh-local-mutation-tools.test.ts`（实现 lane） | `passed` | 9/9，2.47s；官方实际 Agent/registry 的 view/create/str_replace/insert、noclobber、先读/CAS、只读和越界/junction拒绝、取消/卸载。另将官方系统 temp 写入例外记为 current-gap，不能当 workspace-only 产品合同 |
| 2026-09-05 | T4.5 native Windows command boundary | hard 60s：`vitest run tests/dsh-local-exec-tools.test.ts`（实现 lane） | `failed containment; behavior probes recorded` | 6/6 行为记录，8.19s；其中 1 项明确 current-gap：官方 partial ACL 未拒绝 fixture 兄弟目录写入，安全验收不通过。正向命令/工作目录写入、ask 无答复拒绝和 timeout/cancel 实际 PID 退出分别通过。仅自建临时根及专用 TEMP/TMP，清理完毕；无生产 shell、提权、安装或用户目录 ACL 变更 |
| 2026-09-05 | T4.5 alternate environment inventory | `Get-Command wsl.exe,docker.exe`；`wsl --list --verbose` | `read-only check` | 已有 Ubuntu，WSL2，Stopped；PATH 未发现 docker.exe。只列清单，未启动/配置 Ubuntu；下一路线需操作者选择 |
| 2026-09-05 | T4.4 real product acceptance | 操作者运行 `start-dsh-web-smoke.ps1 -ConfirmRealWeb -ReadOnlyTools`；编排只读 `verifyReadOnlySession` 复验 | `passed` | run `readonly-9347d1d1-2330-4a5c-9571-c19f4c5ee36c`；session `session-09bb262e-f89f-40eb-9ea0-d18db3f3988f`；2 model steps/1 tool call/1 result；final SHA-256=`1b66c8e8d20c808b3232c0b05d527a8dbaea7c8f0238b9cfcaee5a001bdbc4ed`，49 bytes；原始 session SHA-256=`3589ab84781fd323727455404e5087c7c32247d4b21383406877a8b254f031ce`。复验新增模型请求=0，不读取旧配对秘密；原 runner 成功已含当次精确敏感值检查 |
| 2026-09-05 | T4 browser build | 无特殊字符 detached worktree `C:\temp\deepseek-pp-build-tools-20260905`，提交 `5f110ba`：`npm run build:all`；manifest/UTF-8/chunk 检查 | `passed` | Chrome/Edge/Firefox MV3 构建通过；manifest 通过，177 个文本资源编码通过，三端 Side Panel chunk 预算通过。沿用既有 Pyodide externalization warnings，不修改依赖或预算 |
| 2026-09-05 | T4 installed artifact refresh | 原位文件备份/复制；300 个构建文件逐个 SHA-256 比对 | `passed` | 仅 9 个 background/content/main-world JS 变更；原文件备份在 `C:\temp\deepseek-pp-build-e4dcc34\readonly-backup-before-5f110ba`，没有删除文件。安装 dist 与新构建 300/300 相同；Chrome background SHA-256=`f1fb83388476c5be831d7a6d62c883e2ef12e03e54ce29965f347c8b7f797944`。扩展 ID/用户设置不变；未宣称运行中 worker 已刷新 |
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
