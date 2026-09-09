# T9：长会话诊断、上下文传递与恢复

状态：实施中。T9.1 诊断版两轮通过后，用户续测已复现首次失败：HTTP 200、311 字节、3 个 SSE 事件，未识别 FINISHED 或数字错误码；尚缺事件内容。T9.4 隔离拒绝分类小切片已实现并通过定向回归，尚未部署，不代表首次故障已修复。

## 授权与边界

- 用户于 2026-09-09 授权按 T9 方向先诊断、后研究修复，可使用最多三位并发子 agent，并可交接独立 Codex 任务实现。
- 当前两位子 agent：流处理审查（5.6 sol / high）、上下文与恢复审查（5.6 terra / high）；主 agent 负责真实测试、汇总和最终决定。
- 仍以本机 Harness 为唯一 loop/历史/工具执行权威，浏览器扩展只提供网页模型。复用现有 DeepSeek 客户端、SSE 解析、官方 compaction 和插件扩展点。
- 不修改 Harness fork 的 master，不引入第二套 loop，不自动重放 ambiguous 请求，不删除旧请求/会话记录，不自动放开工具权限。没有本轮 push 或发布授权。

## 已有证据及尚未确认的部分

1. 用户会话在工具结果和 todo 更新成功后，下一模型步于约 249ms 报 `deepseek_stream_incomplete`；随后新请求约 22ms 报笼统 unknown。任务清单完成不是程序已测试的证明。
2. 主 agent 于 2026-09-08 在 Windows 正式 r2、Default / Thinking off、仅可查看模式实测：短输入连续 10 次 glob 成功；同一会话加入 42,952 字符合成文本后，在工具执行前失败；新会话相同输入连续 8 次 glob 成功；原失败会话再发一句短消息仍失败。合成数据不包含用户文件内容。
3. 代码确认每一模型步重新序列化完整 Harness messages 和工具 schema，再续接同一网页 parent。这是重复上下文的确定来源；目前不能把它直接等同于此次服务端上下文超限。
4. 客户端对 HTTP 200 / 有 body 的 completion 按 SSE 读取，即使 body 是 JSON 业务错误；EOF 不等于模型成功完成，缺少受识别 FINISHED 时会统一成为 stream_incomplete。现有日志不能区分 JSON 业务拒绝、空流、SSE error 或完成格式遗漏。
5. dispatched/streaming 后结果不明会隔离 session-map；持久 result-cache 也会在下一次 reserve 时按逻辑 sessionId 拒绝新请求。coordinator 将 SESSION_QUARANTINED 投影为 unknown，Host 又丢弃具体安全原因。这解释了后续快速失败的代码路径。
6. 侧边栏支持 DOM 和控制台日志读取，本次控制台 error/warn 为空；没有可用的 F12 Network 工具。Chrome 扩展管理页被工具安全策略禁止访问，必须由用户手动更新/重新加载，不能用其他控制方式绕过。
7. 2026-09-09 用户原位重新加载诊断扩展，加载来源目录的 100 个产物散列与诊断构建一致。更新 Harness 插件并重启后，同一新会话先后完成短输入 10 次 glob、42,952 字符合成输入 8 次 glob，共 20 个模型步，均有持久化 completed。这次成功不能推翻旧故障，也不能证明上下文阈值或首次原因；诊断代码没有改变完成判定。
8. 同日用户继续该诊断会话，第三轮前 5 次 glob 调用/结果全部成功，第 6 个模型步骤以 `deepseek_stream_incomplete.v1:h200:sse:b311:e3:cn:bizn` 在 263ms 失败（请求散列 `8f3559785a3dc6b3`）。说明首次失败已经复现，且本次不是空响应或被现有探测器识别的 JSON/SSE error；仍不能排除未识别的 SSE 业务错误、完成格式变化或早结束。需读取真实三事件内容，不能以任意 EOF 作为完成修复。

## T9.1：最小取证与原因传递（当前）

### 代码合同

- 仅 Mode A 显式请求 completionDiagnostics，复用同一次 response reader 和原 SSE decoder。
- ModelTurn 可附带安全摘要：HTTP status、contentKind（empty/json_error/json/sse_error/sse/other）、bodyBytes、SSE 事件数、数字 code / bizCode；不包含正文、header、URL、Cookie、Authorization、PoW 或自由格式错误信息。
- 使用现有协议 reason 编码固定版本、枚举和受限数值，并在浏览器持久化及 Host 显示处通过同一严格校验器。没有新 wire 字段或存储 schema。
- 保持 finished、工具提交、隔离和重试判定不变。HTTP 200 JSON 业务错误只能被更准确地描述，不能被当成 completed。
- Host 对 unknown outcome 保留已经允许的固定 remoteCode，并补齐原有内部 reason；任意上游文本仍不透传。

### 退出条件

1. 模拟 HTTP 200 JSON 业务拒绝、SSE error、空流、缺 FINISHED 和正常流的定向测试通过，Mode B 返回形状及回调行为不变。
2. 真实失败得到数字错误码/响应类型；如果仅得到无完成标记的 SSE，则继续补针对性、脱敏的事件形状取证，不猜测错误码含义。
3. 必须区分真实证据和 mock 测试。没有真实首因证据时，不宣布 T9 首因诊断完成或整体修复成功。

## T9.2：首次失败的针对性修复

根据 T9.1 实测选择，而非同时堆叠所有补丁：

- 上游明确业务拒绝：在原客户端中正确分类并向上呈现，不把“HTTP成功”当“模型开始/完成”的证据；仅在合同足以证明时声明本次未启动。
- 完成事件格式遗漏：使用真实脱敏事件样本补原 stream-codec，保持 Mode B 兼容，不用任意 EOF 或 [DONE] 冒充成功。
- 流提前断开：保持 ambiguous，进入有界查询/显式恢复，禁止增加盲重试。
- 上下文相关拒绝：配合下面的同步/预算修复，不增加时间预算来掩盖即时拒绝。

## T9.3：上下文同步与正常轮换

最终方向是首次全量、已证明连续时增量、失配时重建；分阶段实施，避免一次改造全部状态机。

1. 先建立真实预算统计：单次 prompt UTF-8 字节、同网页链累计发送字节、网页往返次数。传输字节上限不是模型 token 上限，不能把字符数直接作为准确 token。
2. 正常轮换只在前一个请求 completed 且无在途请求的边界创建新网页 chat，用当前 Harness canonical snapshot 建立新基线。可先在扩展内 binding 维护轮换元数据，不必为了正常轮换升级全部持久记录。
3. 不默认每一步新建网页聊天；阈值由真实测试决定。不使用“旧 chat + parent=null”当作分支：当前没有支持这一语义的证据。
4. 增量实现前定义 canonical prefix、工具集合摘要、模型/系统约束摘要和校验提交点。网页原始 assistant(XML/prose)与 Harness 工具调用结构并不相同，必须有明确映射，不能只凭消息数拼接。
5. compaction/历史编辑/分支、关键工具或模型配置变化、投影不一致时重建；纠正回合必须纳入投影或重建，不能漏掉额外网页轮次。
6. 同步位置仅在响应完成且链验证通过后提交。失败/取消/重启不得提前推进。Harness 自身历史仍过大时复用官方 compaction，不静默截断。

## T9.4：明确错误与可用恢复

- 当前已实现切片：仅修正已证明未派发的新请求被 SESSION_QUARANTINED 拒绝时的分类和提示；不等同于实现同会话恢复、上下文同步或自动轮换。与尚待取证的 T9.2 分开验收。
- 分类由具体阶段限定：cache reserve 拒绝必须 `!turnInvoked && !reserved`；adapter session-map reserve 拒绝必须尚未 accepted。同码若出现在较晚阶段仍保持 unknown。Host 记录本请求 not_started，LLM 给中文说明与官方新建/分支建议；不新增恢复按钮，不自动创建会话，旧请求仍可查询为 ambiguous。provider 的固定 maxRetries=0 保持不变。
- 代码回归：四文件 170/170、compile、prompt freeze 7/7、插件 build、diff-check；当前运行诊断版仍为 89fce7b，未覆盖它，不将该小切片记为真实部署验收。
- 首先区分原请求状态与新请求的 admission：只有可证明被旧 session 隔离、且本次未发送的全新请求，才返回 not_started + retryable:false。DUPLICATE_REQUEST / REQUEST_IDENTITY_MISMATCH 不得一概改为 not_started。
- 保留原 ambiguous 请求和旧链的隔离记录，禁止清除标记后重新发送原请求。
- 恢复须先确认旧请求已停止，再核对 Harness 已提交工具结果。已成功工具不自动重跑；执行结果未知的副作用需要用户核实。
- 优先评估官方“从已确认进度创建/分支会话”公开入口；若要在同一 Harness session 内重建网页上下文，必须设计显式 recovery epoch 与持久化身份/迁移合同，不能仅替换内存 parent 绕过 result-cache。
- 用户界面中文说明：为什么暂停、已完成操作是否保留、可采取的恢复动作。诊断细节可展开，复制信息不含凭据。

## 验收与交接

- 自动化：增量不漏/重复消息、完成流与各错误分类、正常轮换、历史压缩、工具/模型变化、重启、取消、旧请求查询、不可重放。
- 真实网页：重跑 10 次短工具 + 42,952 字符 + 8 次工具的旧/新会话对照；达到至少一次预算切换；临时样本目录验证已完成文件修改后的响应失败/恢复；Default/Expert 和思考开关回归。
- Windows 本机先验，Linux 相关回归单独报告；不要求重新安装 WSL。单元/后端测试每批硬限 60 秒，超时清理子进程。
- 诊断直接原因与方案收敛后，交接独立任务实施后续阶段；交接须给准确源码提交、实际运行组件、证据、已完成/待完成项、测试和禁止事项。主 agent 审查验收。不能将 T9.1 诊断包描述为 T9 完成版本。
- 配对和用户数据保留；组件原位更新由用户操作浏览器管理页。新的正式包在完整验收与发布授权后再生成/上传。
