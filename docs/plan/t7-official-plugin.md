# T7 官方 DSH 插件化接入与 Windows 原生命令计划

状态：`verified / local_delivery_complete`（2026-09-07 启动并完成；T7.1–T7.6 的自动包验收与明确授权的真实已登录浏览器验收均已验证）

本计划是已完成 standalone 交付之后的独立增量阶段。旧计划、验收记录、用户安装和 `.release/deepseek-web-harness-e09baf0` 均保持原样；本页只约束新的官方 DSH 增量插件。除非本页明确说明，旧 standalone profile、启动器和受限网页合同不得被放宽。

## 1. 目标与交付形态

目标用户路径固定为：安装 DeepSeek++ 浏览器扩展和 DSH 插件 → 通过官方方式启动 Harness → 在官方网页完成首次配置 → 日常使用 `dsh web`。

- 沿用官方安装、Web UI、session、workspace、tools、Skills、subagent、压缩和恢复能力，不制作额外安装器、管理命令、聊天前端或插件商店。
- 首次使用官方 `web` profile 安装插件；之后直接运行 `dsh web`。
- 浏览器 ID、配对、连接状态和命令策略在官方设置页管理，不要求手写环境变量或 YAML。
- 推理只使用当前已登录的 DeepSeek 网页会话，不要求 API，也不允许其他模型 provider 隐式 fallback。
- Windows 原生命令使用 PowerShell 7。命令默认关闭；启用后默认逐条在官方网页确认，自动执行必须另行显式开启。
- 提供显式导入旧已完成会话；保留源安装与原始记录，冲突时不覆盖。

## 2. 架构与接口

### 2.1 官方增量插件

新增独立官方插件包，复用既有 adapter、authenticated loopback transport 与 Browser Broker。插件只增量注册自身能力：

- Host：网页连接、配置、状态与 `deepseek-web/current-web-session` 模型；
- Client：官方设置页卡片，通过 `dsh.client.platform=web`、`exports["./client"]` 和预构建 `lib/client.js` 动态加载；
- 可选 Windows 组合：复用官方 `pwsh-local`、`tool-pwsh`、subprocess 和 approval。

不得把现有 `packages/dsh-web-agent-bundle/cordis.patch.yml` 的完整 standalone tree 原样叠加到官方 `web` profile，不重复注册 loop/session/tools/approval，不修改官方 Harness 核心或重建官方前端。客户端遵守官方共享模块/external 机制，不把根 React 19 打入官方 React 18 运行时。

### 2.2 模型与默认选择

- 注册 `deepseek-web/current-web-session`，使其可通过官方模型选择使用。
- 首次设置明确询问是否将其设为后续新会话默认；不覆盖既有默认。
- 其他 provider 可共存，但选中网页模型时不得读取或调用其他模型凭据，也不得 fallback。
- 旧 standalone 的“整个 profile 零其他 provider”断言继续只适用于旧交付；新插件改以所选路由独立性为合同。
- workspace、session 和 tools 由官方 Harness 管理，不要求外围启动参数固定工作区。工具调用格式继续复用现有 adapter。

### 2.3 设置与秘密

官方设置页提供：

- 浏览器类型；Chrome/Edge 扩展 ID 或 Firefox 扩展地址；
- 回环端口（默认 `43123`）；
- 生成并复制配对 token；
- 连接状态、重连和明确重新配对；
- Windows 命令启用、默认审批策略和 PowerShell 7 可执行文件；
- 旧会话导入入口。

非秘密配置使用独立 settings namespace；token 存入受保护 credential storage，普通 settings 读取不得回传明文。Host 与 Client 必须注册同一 settings key，确保官方插件设置卡可见。

### 2.4 配对与连接

- 首次配对在 DSH 设置中填写扩展身份并生成 token，再在浏览器扩展中粘贴一次；不做自动发现或免确认。
- 未配置时官方 Web 仍可启动；推理显示未配对或 `waiting_for_browser`。
- 连接配置变化在空闲后生效，或明确提示先结束当前任务；不得中断运行中的请求，也不得重放结果未知请求。
- 继续使用 authenticated `127.0.0.1` WebSocket，不改变网页登录、SSE、PoW 或认证链，不导出 Cookie。

## 3. Windows 执行与兼容边界

- 只复用锁版官方 `pwsh-local`、`tool-pwsh`、subprocess 和 approval；不自建 executor。
- 启用前探测 PowerShell 7；缺失时在设置页提示并允许用户选择可执行文件，不静默回退 Windows PowerShell 5.1、Git Bash 或 WSL。
- 命令默认关闭。启用前明确使用当前 Windows 用户权限；启用后由窄 `tools/pre-execute` 准入返回 `ask`，进入官方审批 UI。审批前零执行，拒绝零副作用，一次确认只执行一次。
- 用户可显式选择自动执行，复用官方审批策略，不新增“记住规则”数据库。默认策略变化只影响新会话，不在后台扩大既有会话权限。
- 仅支持前台命令，保留官方超时、输出上限和取消；测试确认进程树清理。
- `cwd` 不是沙箱；原生命令不承诺工作区隔离。`dsh-permission-presets` 只有在真实满足 `ctx.shell.sandboxMode` 合同时才可组合，不能伪造 sandbox 能力。
- Linux/WSL 路线保持既有行为：整个 Harness 在 Linux 运行并使用原写边界；不包装 `wsl.exe` 冒充 Linux 沙箱，不改 WSL 配置，不自动切换后端。
- 保留 read/edit、多轮工具、Skills、串行 subagent、压缩/请求预算、历史恢复、取消和断连处理。继续锁定已验证的三份请求预算归档，并在官方 profile 中验证实际解析身份。

## 4. 旧会话导入合同

导入只能由用户在设置页明确发起并选择旧安装目录与会话：

1. 只接受兼容版本、`completed` 且未被运行进程占用的根会话；必要的 completed 子会话作为同一组校验，缺依赖则整组拒绝。
2. 复用官方 session 读取和校验，不改写消息、顺序或完成状态。
3. 同 ID 同内容幂等；同 ID 不同内容拒绝覆盖。
4. 先暂存、校验，再原子提交；失败不破坏源或目标。
5. 不导入正在执行、未完成、结果不明或 ambiguous 恢复请求，不自动继续任务。
6. 导入不授予 Windows 原生命令权限，不复制 Cookie、API 配置或整个旧安装。

## 5. 任务、依赖与文件所有权

| Task | 范围 | 前置 | 状态 |
|:--|:--|:--|:--|
| T7.1 | 官方插件纵切片：独立包、官方安装、动态设置页、模型注册；未配对的普通 `dsh web` 可启动 | 已完成旧交付；冻结本页公共接口 | `verified` |
| T7.2 | 网页配置与连接：持久化、credential 配对、状态、重启恢复、空闲变更 | T7.1 | `verified` |
| T7.3 | PowerShell 7：官方执行器、逐条审批、自动执行 opt-in、取消与权限 | T7.1 | `verified` |
| T7.4 | 官方 tools/Skills/subagent/压缩/恢复兼容与无模型 fallback 证据 | T7.1；汇合 T7.2/T7.3 | `verified` |
| T7.5 | 显式旧会话导入：预检、冲突、事务、保留源、导入后查看/继续 completed 会话 | T7.1 | `verified` |
| T7.6 | DSH 插件包 + 浏览器包 + 简短说明；从包安装并完成官方真实验收 | T7.2–T7.5 | `verified` |

关键路径：`T7.1 → (T7.2 || T7.3 || T7.5) → T7.4 → T7.6`。

T7.5 最初因锁版官方 `SessionPersistence` 没有根/子多会话 CAS 而阻塞；最终采用插件自有的官方 JSONL persistence 子类，在 backend 层用 prepared/committed durable journal、同卷 hard-link 提交、源安装互斥锁、提交前后双 revision 校验和恢复扫描补齐组事务。导入提交同时产生永久 Windows deny tombstone，因而不会从同 ID 旧记录恢复原生命令权限；任一步失败均保持源字节不变，并回滚或在下次启动确定性恢复。该方案不修改官方 Harness 核心，也不把内存 target 当作落盘证据。

T7.6 已完成：最终候选从精确干净提交组装并校验，独立临时官方 home 完成在线依赖解析、插件首装、认证 Web 启动、以 `--config.offline=true --force` 从前一同版本本地候选升级，以及以相同离线/强制参数只移除插件的安全卸载；base/web、三项 vendor override、credential、workspace settings 与 session history 均按合同保留。随后从候选安装到隔离 official `web` profile，复用用户明确指定且已登录的 Chrome/DeepSeek 页面完成配对、真实 read/追问、editor、逐条批准 PowerShell 7 和冷重启历史恢复。候选 manifest 仍保持 `acceptance.*=pending`、`release_eligible=false`：验收证据记录在版本化文档中，未改写不可变候选，也不据此发布。

T7.1 冻结 Host/Client settings namespace、credential key、model identity、增量 patch 边界和测试夹具。冻结后可按文件所有权并行：T7.2 只写配置/连接，T7.3 只写 Windows composition/approval，T7.5 只写 importer/session fixture；编排 owner 负责共享依赖、官方 profile 组合与集成测试。不得把整阶段交给一个宽泛任务。

## 6. 自动验证

所有测试命令硬上限 60 秒，沿用 `runProcess` 外层 55 秒 watchdog；超时后确认进程树已清理。整套允许明确分片覆盖，但未成功退出的单条 `ci:quality` 不得记为通过，也不得拿旧 262 files / 2467 passed + 1 skip 作为新代码证据。

- 干净临时官方 home：安装、启动、升级、卸载均不依赖 checkout，且保留既有官方 profile 的其他插件、模型和 defaults。
- 未配对启动、设置保存与重启、错误 ID/token、离线、任务中配置变化。
- PowerShell 7：中文、空格路径、Git、Node、nonzero、输出上限、timeout、cancel 和进程树清理。
- 审批：审批前零执行、拒绝零副作用、确认一次执行；自动执行必须显式开启。
- 导入：兼容 completed 会话、重复、冲突、源变化、unfinished/ambiguous 拒绝、恢复和源目录不变。
- Mode B、网页协议、必要 Harness 功能与请求预算回归；验证官方 profile 实际解析到锁版兼容实现。
- 开发中运行定向测试，收口时再运行一次适用完整门禁；不要求用户重复每项 smoke。

## 7. 真实验收与交付

真实验收从新插件包安装到独立临时官方 home，在自有临时 workspace 中通过官方 Web 完成：

1. 明确授权且已登录的浏览器完成一次配对；
2. read + 追问；
3. editor 修改并核对；
4. 网页逐条批准一条 PowerShell 7 命令，完成文件或短测试；
5. 重启后无需重新填写 ID/token，历史仍可用。

2026-09-07 的真实验收在隔离 `DSH_HOME=C:\temp\t7-real-fbcd-home`、自有 workspace `C:\temp\t7-real-fbcd-workspace` 完成，最终 session 为 `session-3e9650a3-00e6-477f-a620-d2deda3bdff9`：

- read 实际返回 `T7-READ-NONCE-20260907-3BCB38C`，无工具追问只依据本会话返回 `FILE=acceptance-read.txt; NONCE=T7-READ-NONCE-20260907-3BCB38C`；
- editor 将唯一目标改为 `editor_state=T7-EDITOR-AFTER`，落盘文件 SHA-256=`B8A7F35EB18EA092E1DBA793FA7C16E74B7BA648C9FB7D485DC3C5E7E931C3E9`；
- 官方审批 UI 展示完整命令，选择“允许一次”后 PowerShell 输出 `T7-PWSH-APPROVED-20260907-395CF37`，落盘文件 SHA-256=`9C4E018803A50D9F691BCEFA4C6638AD94A56E61CD4E4042FF834657177DCD9C`；
- 冷停/重启后 pairing、模型设置、workspace 和同一 session 自动恢复；无工具追问正确返回 `EDIT=editor_state=T7-EDITOR-AFTER; PWSH=T7-PWSH-APPROVED-20260907-395CF37`。五轮 session 存档 SHA-256=`CB7981B4166C614C25FEF859E687979548C7E8CF2A1BCB12BAF3B673305FA418`。

真实链路依次暴露四个不能由 fake 自动验收发现的集成问题，并分别由 `afd22883`（session import Remote 参数 codec）、`e242adb6`（Remote descriptor 重复挂载）、`3bcb38cd`（settings client 子服务依赖作用域）和 `395cf370`（官方 host singleton 包身份）修复。最终候选 `.release/deepseek-web-official-395cf37` 来源 `395cf370382d52f108e4060dabc71c12ecf3991f`，raw `manifest.json` SHA-256=`3ae99a51a32eb25445e94996738710158659661ddfd1fbef2086ce70f4595c95`，管理 11 个文件；package verify、17/17 定向回归、插件 build 与根 compile 均通过。

拒绝与取消优先由自动矩阵证明；fake 证据不得冒充 real。若当前任务不能控制已授权浏览器，先完成全部开发和自动验收，最终只请求一次必要操作，不重复旧 smoke。

交付继续位于 `feature/web-harness`，锁定 Node 24 与 DSH `0.1.2-rc.1`。旧用户安装 `%LOCALAPPDATA%\DeepSeekWebAgent`（当前 `0a66c3a`）和旧交付 `.release/deepseek-web-harness-e09baf0` 均不自动升级、不修改配对、不覆盖。不得 push、建 PR、发布、打 tag、上传商店或修改官方 Harness `master`。

## 8. 明确不做

- 无关审计、依赖升级、PR #568、Git Bash、双击启动器、自制聊天网页、插件商店或安装向导。
- 修改 WSL 配置、用户项目或旧 `.tmp` 归档/junction；不得运行宽泛递归扫描或重复既有越界探针。
- 多浏览器并发、新 transport、API fallback、Cookie 导出、登录/验证码绕过。
