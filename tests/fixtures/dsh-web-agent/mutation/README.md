# Official filesystem mutation fixture

`runtime.ts` composes only pinned DSH `0.1.2-rc.1` public plugins and executes
the actual `str_replace_editor` registry definition with a real Agent/session.
It does not load a model provider, shell, browser, or user project.

The mutation-specific composition is:

- `dsh-sandbox-policy`: `mode: workspace-write`, trusted absolute `workspaceRoot`.
- `dsh-fs-sandbox`: `cwd` set to the same owned workspace.
- `dsh-fs-observation-policy`: official read-before-edit and stale-version checks.
- `dsh-user-approval`: `policy: ask`.
- `dsh-tool-str-replace-editor`: `maxOutputChars: 512` in this test.

Every package above uses the `@deepseek-ai/` prefix and exact version
`0.1.2-rc.1`. Existing system-prompt, tools, session, projections, Agent registry,
LLM runtime (no adapter), and agent-loop services supply the ordinary Harness.

The tool accepts an absolute `path` and `command` (`view`, `create`,
`str_replace`, `insert`), with command-specific `file_text`, `old_str`, `new_str`,
`insert_line`, or `view_range` values. The editor has no escalation capability.
Standing `workspace-write` grants ordinary edits without asking on every call;
`ask` does not by itself add a per-edit confirmation gate. `read-only` denies
mutation even if the model supplies invented escalation arguments.

Important official semantics: workspace-write includes platform temporary
directories, and editor `view` is not read-contained. Tests explicitly retain
these facts; they are not workspace-only product acceptance. The parent
composition must account for them before exposing the editor to a web model.

Tests create only owned directories under ignored `.tmp-deepseek-live/mutation-fixtures`
and one dedicated platform-temp fixture; disposal removes those exact directories.
The source fixture directory is never used as mutable test data.
