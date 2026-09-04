# Web Harness 模型代理架构决策

状态：已接受，适用于 `feature/web-harness`

日期：2026-09-04

## 目标

让本机 DeepSeek Harness（DSH）拥有完整的 Agent 循环、会话、工具、Skill、子 Agent 与任务生命周期，同时把 DeepSeek 网页当前登录会话作为模型后端。最终体验是：用户从本机 DSH 入口发起仓库任务，本机工具执行结果继续送回同一网页模型链，直到 DSH 得到最终结果；全程不要求 DeepSeek API key。

这不是给网页模型附加几项本地工具，也不是把既有 DeepSeek++ 网页内 Pi loop 换一个入口。它是一个真正的 Harness 架构：本机 DSH 是控制平面，DeepSeek++ 仅代理浏览器内才有权完成的模型推理。

## 决策

### 两种模式并存

- 模式 A（本次主线）：本机 DSH 拥有 Agent loop、上下文、会话、工具调用与取消；DeepSeek++ 是浏览器模型代理。
- 模式 B（已有能力）：DeepSeek++ 在浏览器内运行 Pi loop，并调用扩展已有工具。模式 B 保持兼容，但不作为模式 A 的实现捷径。

两种模式可复用 DeepSeek 网页客户端和流解码能力，但不得共享 Agent loop authority，也不得让一个模式暗中接管另一个模式的会话状态。

### 控制流

```text
本机 DSH 会话
  -> deepseek-web LlmAdapter
  -> 本机 Broker（127.0.0.1）
  -> 已配对的 DeepSeek++ 扩展
  -> 既有 DeepSeekAutomationClient / stream-codec
  -> DeepSeek 网页当前登录会话
  -> 流式模型事件按原请求返回 DSH
  -> DSH 解析并执行本机工具
  -> 下一模型回合
```

DSH 必须能够在自己的会话入口明确选择 `provider=deepseek-web` 与网页会话模型。官方 API adapter、Pi 内置模型后端和网页内 Pi provider 都不能成为隐式回退。

### 传输与协议

P0 使用仅监听 `127.0.0.1` 的 authenticated WebSocket。应用协议采用带 `schema_version`、请求关联 ID 和严格运行时校验的 JSON-RPC 2.0 流协议。

最小协议包含：握手/配对、开始生成、请求已接受、增量事件、成功结束、失败、取消，以及连接恢复后的请求状态查询。生成请求必须有唯一 ID；事件序号必须单调；终态必须唯一且可重复查询；取消必须幂等。重连不能自动重放结果未知的生成请求。

选择 WebSocket 是因为浏览器扩展可直接连接本机服务，且同一连接可承载双向控制和流式结果。MCP Sampling、Native Messaging、CDP、页面 UI 自动化与 Cookie 导出均不是 P0 传输。

协议类型和 codec 放在纯 TypeScript 共享包中，不依赖 DOM、WXT、Node 或 DSH。浏览器端与本机端都必须在接收边界校验，未知字段和未知协议版本失败关闭。

### 浏览器与会话语义

DeepSeek 网页登录态、Authorization、Cookie、PoW 计算及网页私有请求只存在于浏览器扩展侧。任何这些值都不得穿过本机 Broker 协议。

浏览器或已登录 DeepSeek 页面未就绪时，本机 DSH 显示可恢复的 `waiting_for_browser` 状态；不得伪造模型、回退官方 API 或把等待报告为成功。浏览器可以最小化或在后台运行，但完全关闭时不能进行新的网页推理。

模式 A 使用 DSH 会话作为 Agent 上下文真源；网页侧只保存完成一次模型请求所需的最小关联状态。连接中断后，仅可查询已持久确定的状态；结果不明的请求必须显式标为 ambiguous，由用户决定是否重试。

### DeepSeek++ 边界

浏览器端必须复用 `core/deepseek/active-client.ts` 的 `DeepSeekAutomationClient` 与 `core/deepseek/stream-codec.ts`。不得复制 SSE、PoW、认证、会话或私有路由逻辑。Background entrypoint 只负责组合与生命周期，Broker 行为放在独立的 typed service 中。

模式 B 的 `core/inline-agent/pi/` 合同、事件与默认行为保持不变。模式 A 的新增依赖不得进入模式 B 的浏览器 chunk，Node-only 依赖不得进入扩展产物。

### DeepSeek Harness 集成边界

优先使用 DSH 已公开的 `LlmAdapter.stream(...)`、插件与 profile 扩展点，在 DeepSeek++ 仓库中维护 out-of-tree `deepseek-web` adapter 和安装 bundle。用户的 `deepseek-harness` fork 的 `master` 继续镜像上游；不把 Harness 仓库作为 submodule，也不直接修改其 `master`。

本地文件、搜索、编辑、PowerShell、sandbox 与审批直接组合精确锁版的官方 DSH 插件；本项目不重写一套本地工具或工具权限系统。只有失败的合同测试证明正式扩展点无法满足必要产品语义时，才另行决策一个窄适配器。

只有证明确有上游扩展点缺口时，才在 Harness fork 的独立 feature 分支做最小改动，并优先形成可上游的提交。不得复制或 fork DSH 的 loop、session、tool registry、compaction、Skill 或 subagent 实现。

基线精确锁定为 DeepSeek++ `1.14.0`（起点 `0a02c72`）、DeepSeek Harness `0.1.2-rc.1`、`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` `0.83.0` 与 Node.js 24 LTS。升级走独立任务并重跑兼容性验证。

### 本机安全边界

Broker 只监听 IPv4 回环地址。配对凭证使用高熵随机值，放在 WebSocket 建连后的首条认证消息中，不放 URL、query string 或日志。服务端按 remote address、Host、Origin、协议版本、认证、消息大小与 Schema 顺序校验；凭证比较使用常量时间实现。

本机 Broker 只代理模型生成和控制事件，不暴露 raw shell、任意文件 API、扩展存储、浏览器 Cookie 或可由模型调用的提权接口。本地工具权限完全属于 DSH，网页模型只能通过 DSH 已批准并记录的工具合同间接使用它们。

## 仓库与交付策略

- 活动产品仓库是用户 fork `XVSHIFU/deepseek-pp`；`main` 跟踪 fork/upstream 基线，开发在 `feature/web-harness`。
- 旧 Local Agent Gateway 通过 archive/legacy Git refs 保留，仅选择性迁移可验证的协议、状态机、安全或测试思想，不继续维护旧产品形态。
- 上游 PR #568 的 Windows Shell/本地文件改进放入独立 `integration/windows-shell-568` 评估线。它有助于模式 B，但不是模式 A 的前置依赖，不得与首个模型代理纵切片混合。
- 计划、依赖关系与里程碑分别维护在 `docs/plan/`；当前可验证状态维护在 `docs/progress/MASTER.md`。这些文档描述尚未实现的目标时必须明确标为 planned。

## P0 验收

首个真实闭环必须从本机 DSH 输入开始，经 DeepSeek++ 和已登录 DeepSeek 网页获得模型响应；模型请求一个由 DSH 执行的本机只读搜索/读取工具；工具结果进入下一网页模型回合；最终答案回到同一 DSH 会话。验收环境不得配置 DeepSeek API key，也不得使用其他模型 provider。

此外必须用自动化合同测试覆盖协议握手、流顺序、Schema 拒绝、取消幂等、浏览器离线、断线结果不明、敏感值不越界和 fake browser 纵切片。真实网页 E2E 显式 opt-in，不能替代默认离线测试。

## 明确不做

- 不把网页请求伪装成 OpenAI/DeepSeek 官方 API。
- 不导出或抓取浏览器凭证给本机进程。
- 不用 CDP、Playwright 或页面点击脚本充当模型协议。
- 不重写 DSH 或 Pi 的 Harness 核心。
- 不为未来的其他 Agent/浏览器/远程访问预先抽象通用平台。
- 不把审计、发布包装、PR #568 或无关重构放进首个可运行闭环。
