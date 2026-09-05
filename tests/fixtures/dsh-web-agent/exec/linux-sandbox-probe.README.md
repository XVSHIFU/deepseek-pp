# Official Linux command probe (not a product entry point)

`linux-sandbox-probe.mjs` composes the pinned official DSH subprocess, sandbox,
Bash executor and tool registry. It requires Linux Node 24 and Linux-native
dependencies. Do not run `npm ci` over the Windows checkout's `node_modules`
to satisfy this requirement; use a separately authorized Linux installation.

Run only after the environment decision in `docs/plan/task-breakdown.md` T4.5,
under an independent Linux timeout and the project's 60-second supervisor.
It accepts no arguments, uses no browser/model, and is not wired into production.

The fixture creates one unique directory under the Linux user's home, with
workspace and sibling files, then removes only that generated directory.
It does not use `/tmp` as the outside-denial witness: the official backends
either mount a private `/tmp` or grant it write access. It checks normal output,
workspace write, sibling write denial, and official process-handle cleanup after
timeout/cancel. On WSL it also tries one fixed Windows `cmd.exe` echo; success
blocks product wiring even if the Linux backend reports `full` enforcement.

The claimed scope is filesystem **write** confinement, not restrictions on all
readable host files or network access. `product_acceptance` is always false.

On 2026-09-05, after authorized independent Linux dependency installation and
Ubuntu interop disable/restart, this full official DSH probe passed: bwrap/full,
workspace write, sibling denial, Windows echo exit 126, timeout/cancel process
exit and cleanup (six managed processes). The initial cancellation assertion
was corrected to compare the official exported `TOOL_ABORTED` value (`ABORTED`),
not its constant name. No executor or success criterion was substituted.
Earlier direct Bubblewrap tests had exposed still-enabled Windows interop;
those historical results are not the post-setup state. Exact setup/backup and
current validation evidence live in `docs/progress/MASTER.md`.

No installation or system change is performed by this script. Disabling Windows
process interop via `/etc/wsl.conf` affects the whole Ubuntu distribution and
requires an explicit operator decision plus a restart before retesting; see
[Microsoft's WSL configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
