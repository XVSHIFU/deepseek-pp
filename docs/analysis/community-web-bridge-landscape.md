# 社区网页模型桥接方案简析

> 调研日期：2026-09-04
> 用途：为 Mode A 后续实现提供设计、测试和用户体验参考；本文不是依赖选型或引入授权。

## 结论

社区中确实存在“网页 AI + 本地工具”“浏览器自动化 + Agent”“网页接口 + OpenAI 兼容网关”等实现，但尚未发现可以直接替代本项目 Mode A 的成熟方案。

当前主线保持不变：

```text
本机 DeepSeek Harness
  -> DSH agent loop / session / tools / skills / subagent
  -> out-of-tree deepseek-web LlmAdapter
  -> authenticated loopback Web Model Protocol
  -> DeepSeek++ Browser Broker
  -> 当前浏览器中的 DeepSeek 网页登录会话
```

DSH 必须继续拥有 Harness 主权。DeepSeek++ 只提供网页模型回合，不执行 DSH 的本地工具，不导出 Cookie、Bearer 或页面凭证。

## 已核验的方案

| 类别 / 项目 | 实际架构 | 判断 |
|:--|:--|:--|
| [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) | 浏览器内拥有 Agent loop，并组合 Skills、MCP、本地工具和网页模型 | 已有 Mode B；保持兼容，不作为 Mode A 的实现捷径 |
| [DeepseekWeb-enhance](https://github.com/calendar0917/DeepseekWeb-enhance)、[deepseek-skills](https://github.com/lsqkk/deepseek-skills)、[GPTAdmin userscript](https://github.com/megamen32/gptadmin_opensource/blob/main/docs/INTEGRATIONS.md) | 用户脚本从网页流或 DOM 识别工具指令，再调用本地 MCP、文件或 Hub | 属于“给网页增加工具”，不是把网页模型接入本机 Harness；不引入第二套脚本/parser/本地工具服务 |
| [`deepseek-browser-agent` 的后继 Forge Agent](https://github.com/Omar-Azam/forge-agent) | Playwright 持久浏览器、DOM 轮询、独立 Profile，并自带 Agent loop、工具、记忆和恢复 | 与 DSH 双主控，且依赖浏览器自动化；不作为产品依赖 |
| [codex-deepseek-bridge](https://github.com/JetXu-LLM/codex-deepseek-bridge) | 把 Codex Responses 请求转换为 DeepSeek 官方 API 请求，Codex 保留 Harness 能力 | 需要 DeepSeek API Key，不是网页版模型通道；仅参考兼容层、安装和恢复体验 |
| [madderscientist/WebAI2API](https://github.com/madderscientist/WebAI2API) | 把 DeepSeek Web 包成 Chat Completions / Responses；通过 CDP/Playwright 获取并保存 Cookie、Bearer 和 UA | 模型接口方向可参考，但凭证越界、CDP 和网页私有接口直连违反当前安全边界，不集成代码 |
| [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API) | 多站点浏览器自动化、OpenAI 兼容服务、多实例/多账号和 Cookie 接口 | 范围过宽且依赖自动化与凭证能力；只参考队列和故障分类测试思想 |
| [AIXF666/deepseek-web-bridge](https://github.com/AIXF666/deepseek-web-bridge) | 本机 HTTP → WebSocket → Chrome MV3 扩展 → 已登录 DeepSeek 页面 | 传输拓扑最接近本项目，但协议、真流式、幂等和恢复语义不足；只读设计，不作为上游依赖 |
| [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge) | 通过 MCP 从 ChatGPT 控制 DSH session/goal，DSH 保留 sandbox 与 approval | 是控制桥，不会把网页订阅变成 DSH 模型 provider；可参考配对和 workspace 边界 |
| [官方 DSH LLM Adapter](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md) | `LlmAdapter.stream()` 把 provider-neutral `GenerateOptions` 转换成外部模型流 | 是 Mode A 的权威扩展点，继续作为 DSH 集成基础 |

`WebAI2API`、`deepseek-browser-agent` 和 `deepseek-web-bridge` 都存在重名或继承/改名情况。后续引用必须带完整 owner/repository URL，禁止只凭项目名称选型或复制代码。

## 允许吸收的增强

### 当前主线内

- P1-T3：参考配对向导、在线状态、登录失效提示和可撤销配置；令牌仍只存 browser local，地址仍只允许 `127.0.0.1`。
- P3/P5：增加登录过期、页面协议变化、空响应、响应迟到、重复工具调用、断连和旧响应晚到等故障用例。
- P6：参考 `doctor`、安装前检查、配置备份、幂等恢复和卸载体验，但不得写入模型 API Key 或修改其他 Agent 的全局配置。
- 测试可吸收社区项目暴露的 SSE 分片、DOM/selector 失效和模糊工具输出样本；生产实现继续复用 DeepSeek++ 的 `active-client`、`stream-codec` 和严格工具 parser。

### M4 验收后再评估

可新增独立的“OpenAI Responses 兼容入口”作为非 P0 增强，使支持自定义 provider 的 Pi、Codex 或其他 Harness 复用同一个网页 Broker：

```text
可选 Responses Adapter
  -> 现有 Web Model Protocol / Host transport
  -> DeepSeek++ Browser Broker
  -> DeepSeek Web
```

该入口只能调用现有 Broker，不得自行访问 DeepSeek、读取浏览器凭证、实现第二套 SSE/PoW/parser 或接管调用方的 Agent loop。它不能削弱 `ambiguous`、query、取消和不自动重放合同。是否实施需在 M4 真实 Harness 验收后另立任务和兼容性决策。

## 明确不引入

- Playwright、Puppeteer、CDP、自动化伪装参数或独立浏览器 Profile。
- Cookie、Authorization、Bearer、User-Agent 等网页凭证导出或本地落盘。
- Browser Broker 内的 Shell、文件、MCP 工具执行或第二套 Agent loop。
- 从自由文本猜测工具调用、宽松 JSON 修复、DOM 文本稳定即视为模型完成。
- dispatch 后自动重试、自动新建网页会话或把不确定结果推断为成功。
- 未核验许可证的源码复制，以及 GPL/AGPL 代码直接并入当前主体。

## 对当前计划的影响

本调研不改变 P1 → P2 → P3 → P4 的关键路径，也不新增当前批次依赖。近期唯一执行项仍是 P1-T3；完成 Browser Broker 组合后进入官方 DSH `LlmAdapter` 和 allowlist profile。标准 API 兼容层只记录为 M4 后候选增强。
