# T4.5 official Windows PowerShell fixture evidence

This test fixture uses only the pinned official `0.1.2-rc.1` tool and execution
stack: `dsh-tool-pwsh`, `dsh-pwsh-sandbox`, `dsh-sandbox-local` (its Windows ACL
backend), `dsh-subprocess-local`, `dsh-sandbox-policy`, `dsh-shell-env`,
`dsh-tools`, and `dsh-user-approval`. It does not install a model provider or
substitute an unconfined runner, fake process, custom policy, or shell parser.

All filesystem targets are under one newly created temporary root. `TEMP` and
`TMP` are changed only in the test process to its owned `runner-temp` directory
and restored during cleanup. Any standing workspace ACEs are therefore on
temporary directories removed by the fixture, never on a user workspace or
system temp root. No installation, elevation, or manual ACL mutation is used.

Verified on the current Windows host:

- The official registry runs fixed harmless PowerShell commands under the ACL
  runner and reports `enforcement: partial`.
- Workspace fixture writes work and ordinary completed runners remove their
  private temp directories.
- An official idle Agent and open Session turn route a wider-mode request
  through approval `ask`; without an answerer it records `unavailable` and does
  not execute the command.
- Timeout and cancellation terminate the actual PowerShell PID before return;
  official provider/subprocess disposal and temporary-root cleanup complete.

**T4.5 shell containment is not accepted.** The required sibling-outside write
rejection failed twice: the official runner returned exit 0 and `denied: false`,
and the owned sibling file changed. The test named `T4.5 current-gap` records
this observed failure without claiming it is safe behavior. No additional
boundary probing or production shell composition was added.

The official backend documents unrestricted reads/network and partial write
enforcement (including Everyone and hard-link boundaries). Its tool also
advertises `workdir` and escalation arguments by default. Choosing a stronger
execution boundary or explicitly accepting the native Windows limitations is
a product decision outside this test fixture; a green behavior-probe suite
does not close that acceptance gate.
