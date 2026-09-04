# DeepSeek Web Harness Milestones

所有里程碑均属于 Mode A：本机 DSH 控制，DeepSeek++ Browser Broker 提供唯一网页模型。任何替代 transport/provider 都不共享这些完成状态。

## 1. 里程碑定义

| Milestone | 覆盖任务 | 可观察结果 | 必须证据 | 明确不代表 | 状态 |
|:--|:--|:--|:--|:--|:--|
| M0 Protocol Frozen | T0.1 | WebSocket/JSON-RPC v1 的完整请求、事件、取消、恢复合同被冻结 | protocol golden 与 reject cases | 尚无网络或模型 | Pending |
| M1 Fake Broker Connected | T0.2-T0.3 | 真实 loopback socket 上 Host 与 fake browser 能流式完成一轮 | fake E2E、资源释放、鉴权/错序测试 | 尚未接浏览器或 DSH | Pending |
| M2 Browser and DSH Seams Ready | T1.1-T2.3、Batch A Gate | DeepSeek++ Browser Broker 与 out-of-tree DSH Adapter/Profile 分别完成，dsh 可走 fake peer 单轮 | compile/test、composition allowlist、DSH fake session evidence | 尚未证明真实网页模型 | Pending |
| M3 Real Web Model Reachable | T3.1 | 实际 dsh 请求经 Browser Broker 到当前登录网页模型并得到纯文本终答 | opt-in 脱敏 correlation、无 API Key/provider 预检 | 只是传输冒烟，不是产品目标达成 | Pending |
| M4 First True Harness Acceptance | T4.1-T4.4 | dsh 本机入口→网页模型→本地只读工具→网页模型终答 | 随机 nonce、真实 tool call/result、两次模型请求、durable session、无 API Key/provider | 未完成恢复前仍不是发布候选 | Pending |
| M5 Harness Capabilities and Recovery | T4.5-T5.4、Batch B/C Gate | 官方 DSH write/editor/PowerShell/sandbox/approval composition、skills、session、compaction、串行 subagent、取消和崩溃恢复可验证 | composition allowlist、fake feature fixtures、恢复矩阵、重跑 M4 | 尚未证明候选包可安装 | Pending |
| M6 Installable Release Candidate | T6.1-T6.3 | 从候选包在干净环境安装、配对、验收、卸载 | manifest/SBOM/SHA、package identity、候选包 M4 验收 | 未过最终质量门前不可发布 | Pending |
| M7 Release Ready | T6.4 | 文档和全部自动/真实验收一致，完整质量门通过 | `npm run ci:quality`、workspace gates、fake/real/recovery evidence | 不包含 Native/MCP Sampling/并发网页会话 | Pending |

## 2. 首个真实验收的固定判定

M4 是第一个允许对用户说“已实现目标”的节点，M3 不能提前替代它。一次合格的 M4 必须同时满足：

1. 命令从候选的 `dsh` 本机入口发起，不是直接调用 adapter、Browser 方法或测试 helper。
2. Harness provider route 明确为 `deepseek-web`，本机没有可用的本地/云模型 provider。
3. 启动环境、profile、credential store 均无 DeepSeek API Key 或其他模型 API credential。
4. 网页模型第一轮主动生成结构化调用，目标是 T4.2 profile 实际发布的官方 DSH read/list/grep 类工具之一。
5. 工具由 DSH 本地 Agent loop 执行，结果来自随机生成的只读 fixture；网页和 fake peer 预先不知道 nonce。
6. 工具结果作为下一轮 Harness context 送回同一网页模型执行通道，由网页模型给出包含 nonce 含义的终答。
7. DSH durable session 中存在有序的 user、assistant tool-call、tool-result、assistant final 事件；不得含 Cookie、Authorization、API Key、reasoning 或真实 workspace root。
8. 若 socket/网页响应在提交后结果未知，验收必须失败为 ambiguous，不能手工补写成功。

## 3. 里程碑放行门

### M0-M2：Batch A

- 只使用 fake peer，无真实网页依赖。
- T0.1-T2.3 各自定向测试完成后，合并批次只运行一次 `npm run compile` 和 `npm test`。
- DSH profile 的静态 allowlist 必须证明不存在 API adapter、Pi provider、telemetry 或模型 credential fallback。

### M3-M4：Batch B 前半

- 真实测试必须用户明确 opt-in，并在当前登录的 DeepSeek 官方网页执行。
- 失败保持失败；验证码、限流、页面不兼容、Browser 离线和未配对分别记录，不能改走 API/CDP/MCP。
- M4 前所有 tool-loop 都先由 fake peer 自动化覆盖，真实验收只验证不可伪造的端到端路径。

### M5：Batch B/C

- 官方 mutation/editor/PowerShell/sandbox/approval 插件只能在 M4 只读闭环通过后进入；不得为这些能力新造本地工具包。
- Batch B 合并后一次性执行 compile、test、prompt freeze 和 browser builds。
- Batch C 合并后一次性执行 compile/test，并重跑 M4；取消和恢复测试必须核对 orphan process/socket。

### M6-M7：Batch D

- 验收对象必须是候选包，不是工作树。
- 安装器只能修改产品拥有的 profile/package 链接，并支持幂等卸载。
- 最终只运行一次完整 `npm run ci:quality`，加新增 workspace package build/test、候选包 policy/fake/recovery/real acceptance。
- 任一 required 检查未运行或失败，状态保持 Pending/Blocked，不得改为 Complete。

## 4. PR #568 Integration Lane

PR #568 不属于 M0-M5 的关键路径，也不阻塞 Broker、Adapter、工具闭环或恢复：

- 独立 branch/worktree 执行 I568.1；只修改 PR 原始 diff 和其测试范围。
- 能及时通过则在 M6 候选锁定前标记 `Included`。
- 尚未可用或存在冲突则标记 `Deferred`；M0-M7 仍可继续。
- 不得用 PR #568 引入另一套 transport、模型 provider 或 Harness core fork。

## 5. 非当前里程碑

以下能力必须新开决策与计划，不计入 M7：

- Native Messaging 模型 transport。
- MCP Sampling 模型 transport。
- 通过 MCP 工具包装模拟 Harness。
- CDP/浏览器自动化控制网页作为模型 provider。
- Cookie/网页登录态导出到 Host。
- 多网页会话并发 subagent。
- DeepSeek Harness core 产品私有 fork。
