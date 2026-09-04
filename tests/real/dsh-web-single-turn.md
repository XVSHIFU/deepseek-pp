# DSH 网页模型单轮冒烟

这项测试验证本机 `dsh` 的一次无工具请求确实由当前已登录的 DeepSeek 网页会话回答。它只验证真实模型链路，不代表本地工具多轮或完整 P0 已完成，也不会进入默认 CI。

## 运行前

1. 使用 Node.js 24，并确认独立的 `deepseek-web-agent` profile 已按 `packages/dsh-web-agent-bundle/README.md` 安装在一个明确的 `DSH_HOME` 中。
2. 在桌面 Chrome、Edge 或 Firefox 中打开并登录 DeepSeek 官方网页，加载当前工作树构建的 DeepSeek++。
3. 在 DeepSeek++ 设置的 Browser Broker 页面配置同一端口和配对令牌，启用连接；不要把 Cookie、Authorization 或网页 Token 复制到本机。
4. 清除进程环境、任务目录 `.env` 和 `DSH_HOME/.env` 中的所有模型/API 凭证。runner 会拒绝常见 DeepSeek、OpenAI、Anthropic、Gemini、Azure OpenAI、AWS/Bedrock、DashScope、xAI、Together、Fireworks、Moonshot、Mistral、Cohere、Groq、OpenRouter、Ollama 以及通用/自定义 `*_API_KEY` 凭证。

PowerShell 示例（值由你自己的隔离环境提供）：

```powershell
$env:DSH_HOME = 'C:\path\to\isolated-dsh-home'
$env:DSH_WEB_BROKER_PORT = '43123'
$env:DSH_WEB_PAIRING_TOKEN = '<与扩展中一致的高熵配对令牌>'
$env:DSH_WEB_ALLOWED_EXTENSION_ORIGINS = 'chrome-extension://<extension-id>'
$env:DSH_WEB_REAL_BROWSER_ATTESTATION = 'logged-in-and-broker-enabled'
node .\scripts\dsh-web-real-smoke.mjs --confirm-real-web
```

必须逐字提供 `--confirm-real-web`；缺少确认时 runner 在启动 DSH 前失败。`DSH_WEB_REAL_BROWSER_ATTESTATION` 是操作者对“网页登录有效且扩展 Broker 已启用”的明确确认；启动屏障随后还会直接等待 Host 观察到经过认证的扩展连接，未就绪会失败而不是跳过。

成功时只输出一行脱敏 JSON：provider/model、runner 请求关联值、DSH session ID、最终文本的 SHA-256 与 UTF-8 字节数、`completed` 状态。不会输出任务全文、最终文本、reasoning、配对令牌、Cookie 或本机绝对路径。失败输出稳定错误码并返回非零退出码；不要把失败记录为通过。

runner 在超时、输出超限、`Ctrl+C` 或终止信号时只清理自己启动的 DSH 进程树；不会操作其他 DSH profile 或浏览器进程。

本文件没有执行真实网页冒烟。真实证据只能来自操作者显式运行上述命令后的脱敏输出。
