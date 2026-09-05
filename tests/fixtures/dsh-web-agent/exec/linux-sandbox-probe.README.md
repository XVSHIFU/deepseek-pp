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

As of 2026-09-05 this full DSH probe has **not run**: Linux imports of the current
Windows dependency tree fail for missing native Koffi. Separate bounded direct
Bubblewrap tests ran `/usr/bin/true` and the fixed Windows echo successfully.
Those tests demonstrate working Bubblewrap and still-available Windows interop,
not successful DSH command isolation. The Windows-to-WSL loopback result is
recorded separately in `wsl-loopback-probe.README.md`.

No installation or system change is performed by this script. Disabling Windows
process interop via `/etc/wsl.conf` affects the whole Ubuntu distribution and
requires an explicit operator decision plus a restart before retesting; see
[Microsoft's WSL configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
