# DeepSeek Web Agent Harness bundle

This private workspace package supplies the standalone `deepseek-web-agent` profile used while Mode A is under development. The local DeepSeek Harness owns the Agent loop, session log, checkpoints, and empty tool registry. The only model route is `deepseek-web/current-web-session`, served by the paired DeepSeek++ browser extension.

The profile deliberately excludes `dsh-base`, the official DeepSeek API and Pi adapters, settings and credential providers, telemetry, search, Skills, subagents, and local tools. Those capabilities may be added only by their planned allowlist tasks.

## Install from this checkout

Use Node.js 24 and DeepSeek Harness `0.1.2-rc.1`. Seed the empty standalone profile before using `dsh plugin`; an unknown profile would otherwise inherit the upstream `dsh-base` default.

```powershell
$env:DSH_HOME = 'C:\path\to\isolated-dsh-home'
node .\packages\dsh-web-agent-bundle\scripts\seed-profile.mjs --home $env:DSH_HOME
dsh plugin --profile deepseek-web-agent add .\packages\dsh-web-agent-bundle
```

Set the local Broker configuration in the process environment before launch. `DSH_WEB_PAIRING_TOKEN` is the same high-entropy token configured in DeepSeek++; `DSH_WEB_ALLOWED_EXTENSION_ORIGINS` is a comma-separated exact allowlist such as `chrome-extension://<extension-id>`. The port defaults to `43123` and can be changed with `DSH_WEB_BROKER_PORT`.

```powershell
$env:DSH_WEB_PAIRING_TOKEN = '<pairing-token>'
$env:DSH_WEB_ALLOWED_EXTENSION_ORIGINS = 'chrome-extension://<extension-id>'
dsh --profile deepseek-web-agent 'Reply with a short acknowledgement.'
```

With no authenticated browser peer, the turn fails visibly as `WAITING_FOR_BROWSER`. There is no provider fallback. The Host listens only on `127.0.0.1`, accepts one model generation at a time, and stops with the owning Cordis plugin.

This P2 package is installable as a local link from the current checkout. It is not a release artifact: the private adapter, transport, and protocol workspaces do not yet form a self-contained tarball dependency closure.
