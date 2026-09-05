# Windows → WSL loopback-only probe

This one-shot Windows Node script starts an in-memory TCP echo listener inside
the existing `Ubuntu` WSL distribution, bound only to `127.0.0.1` on an
automatically allocated port. Port `43123` is excluded. Windows sends a random
non-secret probe and checks the exact response.

```powershell
node tests/fixtures/dsh-web-agent/exec/wsl-loopback-probe.mjs
```

The Linux executable is the existing
`/home/worker/.nvm/versions/node/v24.18.0/bin/node`. The Linux program has a
20-second deadline and an independent `/usr/bin/timeout` limit of 30 seconds;
the Windows owner has a 45-second deadline. Run under the project's ordinary
60-second command supervisor when collecting verification evidence.

On success Linux closes the listener, rebinds its exact port to verify release,
closes that verifier, and exits. The script waits for the WSL child to close.
It also reports Windows-side rebind availability separately, since that can
differ from the Linux listener's lifetime.

Observed on 2026-09-05: Windows reached WSL `127.0.0.1:43498`, the random echo
matched, Linux rebind/release succeeded, and the child exited with code `0`.
Windows immediate rebind remained unavailable (`EADDRINUSE`); a scoped
`Get-NetTCPConnection -LocalPort 43498` lookup returned no row. The probe does
not identify or modify that Windows reservation, and does not claim the Windows
forwarding port was released. Its own Linux listener was independently proven
closed and reusable.

This establishes only the TCP direction needed by a Windows browser connecting
to a WSL-local Broker. It does not replace or alter the existing authenticated
WebSocket transport, test browser authentication, invoke a model, touch pairing
tokens, install software, alter WSL/firewall/network settings, or test reverse
WSL → Windows routing.
