# Harness feature contract fixture

This fixture mounts the pinned official Cordis Agent loop, JSONL persistence,
checkpoint policy, workspace-write filesystem and observation/approval services.
It consumes `cordis.harness-features.patch.yml` and the actual out-of-tree tool
policy and web adapter. The only fake is the authenticated browser/model peer;
requests and results cross a real `127.0.0.1` WebSocket. It does not invoke the
real DeepSeek website, a model API, a shell, or a second Agent implementation.

`tests/dsh-web-harness-features.test.ts` covers:

- Skill catalog first contains only a description; the original `skill` tool
  loads an unknown identifier from an owned disk `SKILL.md`.
- The original `subagent` tool runs one foreground in-process child, with an
  independent persisted session and no inherited parent transcript. Parent and
  child both use Protocol v1 purpose `agent`; official session `origin`,
  `parentSession` and `delegationDepth` establish the child's identity.
- The parent receives the child result, creates a real file through the original
  editor, and resumes its saved session after its live handle is disposed.
- The official compaction transaction performs one `compaction` model request,
  commits a smaller checkpoint, and resumes the checkpoint. An unsuccessful
  request leaves no fabricated summary and causes no automatic retry.
- The official model-free pruner rewrites one oversized actual tool result;
  the original remains in JSONL while the resumed model surface is smaller.
- Model-selected fallback routes and background delegation stay unavailable.

`WebCompactionEngine` overrides only the official `BasicCompactionEngine`
summarizer hook. It uses an explicit, project-owned short checkpoint instruction
and the official `BlockAssembler`. It neither copies the upstream private
summarizer nor replaces the range selection, retention, shrinking, pruning,
durability or resume algorithms. Web Protocol v1 cannot enforce `maxTokens`, so
the hook does not send or record that setting. Incomplete, failed or non-text
checkpoints are rejected.

The product uses conservative official pressure ratios (0.35 threshold, 0.08
retention). These token estimates do not guarantee that every message-count or
wire-byte limit is avoided; this is not evidence of unlimited conversations.
Skills are operator-supplied trusted project instructions under
`<workspace>/.agents/skills`; user/global discovery and filesystem watchers are
not enabled by this patch.

Run the single named test file with the repository's hard 60-second backend
command deadline. Each fixture owns and removes its temporary directory, closes
the fake peer, disposes Agent handles and the Cordis Host listener. No child
process is needed for this in-process contract. This is automated contract
evidence, not real-web acceptance or proof that T4.5/T4.6 as a whole is complete.
