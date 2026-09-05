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

## Optional Harness capabilities (Windows, no shell)

Apply `cordis.harness-features.patch.yml` **after** the workspace-files patch to
use the original editor, workspace Skills, and one foreground child Agent in
the same session. The increment replaces the editor-only gate with one gate
bound to the exact official tool definitions; it does not add a second file
executor. The base and editor-only profiles keep their previous behavior.

Skills come only from `<workspace>/.agents/skills`, with the official catalog
and on-demand loader. Global user Skill directories are not scanned. Each child
has an independent persisted DSH session, inherits the same workspace and web
model, and cannot delegate again or choose another model. Parent and child
requests both retain protocol `purpose=agent`; session IDs and official session
lineage distinguish them. This is serialized delegation, not parallel web models.

Workspace Skills are trusted operator-supplied instructions. The upstream
filesystem Skill provider can follow existing links; selecting a project Skill
directory is not a claim that every Skill read is OS-isolated to that directory.
The model selects registered Skill names, not arbitrary Skill paths.

All calls share the one registered adapter's FIFO (at most 16 waiting calls).
Cancelling while queued sends no browser request. The next call is admitted only
after the previous stream finishes cleanup; unresolved cleanup remains an error.

The official token meter, tool-result pruner and compaction engine retain their
session algorithms. A small subclass overrides only the public summarizer hook
to make one explicit `purpose=compaction` web request with a short checkpoint
instruction. The web route cannot set `maxTokens`; no token cap is silently
ignored or falsely recorded. Failed summaries do not become checkpoints and are
not automatically retried. Token counts are estimates; protocol limits still
apply (including 1 MiB per frame and 128 messages). Long-session boundary and
crash/reconnect acceptance are not complete.

The configured compaction threshold is 35% of the adapter's conservative context
capacity, retaining 8% verbatim. This starts earlier than the upstream default
but does not guarantee that every message-count or encoded-byte limit is avoided.

After the checkout installation and pairing setup above, run from the selected
workspace, with `DSH_WEB_WORKSPACE_ROOT` set to that same absolute directory:

```powershell
$harnessRepo = 'C:\Users\worker\Documents\deepseek+++++'
dsh --profile deepseek-web-agent --patch "$harnessRepo\packages\dsh-web-agent-bundle\cordis.workspace-files.patch.yml" --patch "$harnessRepo\packages\dsh-web-agent-bundle\cordis.harness-features.patch.yml" 'Your task'
```

This remains a development, one-task/headless entry, not the planned interactive
installation experience. It grants file editing within the chosen root; no
PowerShell/Bash command execution is available. Official session resume and
checkpoint behavior are exercised in the feature integration tests, not claimed
as a finished user-facing resume command. The combined features' integration
uses a scripted browser peer; it is not new real-web acceptance evidence.

For the next real-web **file-edit-only** check, use
`scripts/start-dsh-web-smoke.ps1 -ConfirmRealWeb -FileEdit`. It creates its own
fixture and never selects a user project for the test. The short instructions
are in `tests/real/dsh-web-file-edit-acceptance.md`; the passed read-only check
does not need repeating.
