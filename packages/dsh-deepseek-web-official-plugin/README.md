# DeepSeek Web official DSH plugin

This package is the incremental plugin for the official DeepSeek Harness `web` profile. It adds the `deepseek-web/current-web-session` model route and a settings card while leaving the official loop, sessions, tools, approval services, other models, and defaults in place.

Development install into an isolated Harness home:

```powershell
dsh plugin --profile web add C:\path\to\dsh-deepseek-web-official-plugin
dsh web
```

An unpaired deployment remains startable. The settings card owns the browser connection, protected pairing credential, status/reconnect actions, and the Windows command defaults used for newly created sessions.

On Windows, the official profile's global `dsh-pwsh-sandbox` composition remains unchanged for other model providers. Immediately before a DeepSeek Web step, this plugin uses Cordis service isolation plus the Agent-scoped tool registry to mount the official `dsh-pwsh-local` executor and `dsh-tool-pwsh` for that Agent only. The scoped schema is foreground-only: it does not advertise `run_in_background` or sandbox escalation. Commands are disabled by default; enabled sessions ask through the official approval service unless the user explicitly selects automatic execution. Approved commands run with the Harness process's current Windows-user authority, and their `cwd` is not a sandbox boundary. PowerShell 7 is required and Windows PowerShell 5.1 is never used as fallback.
