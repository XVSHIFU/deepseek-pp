# Official read-tool loop with a fake browser model

`run-tool-loop.ts` reuses the actual DSH CLI, loopback fake peer, profile startup,
session decoder and cleanup from the existing single-turn process fixture. The
setup writes a random nonce to an owned temporary workspace. `request-script.ts`
has no filesystem access or nonce input: it must request the official `read`
tool, then obtain the nonce only from the second model request's `tool_result`.
A second scenario reads a missing fixture and requires the real tool error to
return to the model before completion.

The test applies `packages/dsh-web-agent-bundle/cordis.readonly.patch.yml`
over the existing standalone profile, with `DSH_WEB_WORKSPACE_ROOT` bound by the
runner to its owned temporary workspace. Model-visible schemas must contain
only the original official `read` tool. The same profile's separately tested
policy owns containment; this fixture does not implement filesystem tools or
path guards.

This is T4.3 fake-model evidence, **not T4.4 real-web product acceptance**. A
scripted model cannot prove the real webpage model will reliably invoke tools.
