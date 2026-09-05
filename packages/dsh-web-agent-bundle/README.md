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

## Controlled read-only acceptance profile

The opt-in `cordis.readonly.patch.yml` adds the official `read` tool to the same
base composition. The acceptance launcher supplies an owned temporary fixture
directory through `DSH_WEB_WORKSPACE_ROOT`; it must not use a real user project
as this initial test's root. The ordinary one-turn profile above is unchanged.

Only `read` is published. It accepts `file_path`, with optional positive `offset`
and `limit`; it reads UTF-8 files, not directories. Write, edit, image, search,
shell, and network tools are not published. The official output includes the
absolute temporary fixture path; the added persona does not include a project
working directory.

The pinned upstream `read-only` filesystem mode blocks mutations but does not
restrict reads to a workspace. The small `readonly-policy` composition therefore
uses the upstream registry and canonical filesystem `resolve`/`contains` methods
to admit only reads inside the configured fixture. Traversal, outside absolute
paths, and static junction escapes are denied. This is a model-path permission
check, not OS isolation against a malicious local process concurrently changing
paths between that check and the upstream read. No upstream filesystem, tool
implementation, or path-containment algorithm is copied.

## Controlled file-editing increment

`cordis.workspace-files.patch.yml` is an explicit alternative to the read-only
patch, over the same web-only base profile. It requires a trusted absolute
`DSH_WEB_WORKSPACE_ROOT` matching the intended task workspace. Do not combine
the two increments. The base and the accepted read-only profile are unchanged.

The only model tool is the original official `str_replace_editor`: ordinary-file
view, create, string replacement and line insertion. Absolute paths are required;
directory listing is currently unavailable. Shared path admission confines tool
targets to that workspace, including reads and the upstream temporary-directory
exception. Official `fs-observation-policy` supplies read-before-edit, freshness
and no-clobber protection; neither filesystem operations nor path algorithms are
reimplemented here.

Workspace-write is a standing permission inside the selected root, not a prompt
before each edit. Approval remains `ask`; an actual ask without an official
answerer is rejected. No elevation, arbitrary environment, shell or networking
tool is published. In particular, native Windows command execution is not
included: the pinned ACL backend did not satisfy the out-of-workspace-write
acceptance on this host. Stronger command isolation remains a separate decision.

This file-editing increment is not a release or a complete interactive Harness
UI. Its fake model/real DSH integration evidence does not claim a new real-web
write test. The successful real-web read-only acceptance remains valid.
