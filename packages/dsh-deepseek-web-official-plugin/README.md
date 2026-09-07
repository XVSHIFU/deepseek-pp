# DeepSeek Web official DSH plugin

This package is the incremental plugin for the official DeepSeek Harness `web` profile. It adds the `deepseek-web/current-web-session` model route and a settings card while leaving the official loop, sessions, tools, approval services, models, and defaults in place.

Development install into an isolated Harness home:

```powershell
dsh plugin --profile web add C:\path\to\dsh-deepseek-web-official-plugin
dsh web
```

The T7.1 slice intentionally keeps an unpaired deployment startable. Pairing persistence, connection actions, PowerShell 7 approval wiring, and completed-session import are delivered by the later T7 tasks described in `docs/plan/t7-official-plugin.md`.
