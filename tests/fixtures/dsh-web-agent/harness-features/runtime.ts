import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type AgentHandle } from "@deepseek-ai/dsh-agent";
import DefaultModel from "@deepseek-ai/dsh-agent-default-model";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import * as ObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId, SessionStore, type SessionHeader } from "@deepseek-ai/dsh-session";
import * as CheckpointPolicy from "@deepseek-ai/dsh-session-checkpoint-policy";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as Adapter from "@deepseek-pp/dsh-llm-deepseek-web";
import * as Host from "@deepseek-pp/dsh-web-agent-bundle/host";
import { createPairingToken, type DeepSeekWebModelHost } from "@deepseek-pp/dsh-web-model-transport";

import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "../../harness-bridge/fake-peer/index.ts";
import WebCompactionEngine from "../../../../packages/dsh-web-agent-bundle/src/web-compaction.ts";

export const FEATURES_PATCH = resolve(process.cwd(), "packages/dsh-web-agent-bundle/cordis.harness-features.patch.yml");
export const FEATURE_ROWS = [
  ["harness-skills", "@deepseek-ai/dsh-skill"],
  ["harness-workspace-skills", "@deepseek-ai/dsh-skill-filesystem"],
  ["harness-token-meter", "@deepseek-ai/dsh-token-meter"],
  ["harness-tool-result-pruner", "@deepseek-ai/dsh-compaction-tool-result-pruner"],
  ["harness-web-compaction", "@deepseek-pp/dsh-web-agent-bundle/web-compaction"],
  ["harness-subagents", "@deepseek-ai/dsh-subagent"],
  ["harness-subagent-spawn", "@deepseek-ai/dsh-subagent-spawn-in-process"],
  ["harness-tools-policy", "@deepseek-pp/dsh-web-agent-bundle/harness-tools-policy"],
] as const;

export function featureRows() {
  return composeEntries([loadOverlayPatches("harness-features-test", FEATURES_PATCH)]).filter((row) => !row.disabled);
}

/** Real upstream runtime/services plus the production web adapter and socket.
 * Only the remote browser/model is scripted. No Harness/core monkey patches.
 */
export async function createFeatureRuntime(skillBody = "Use the provided fixture identifier.", options: { persistentJournal?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-harness-features-"));
  const workspace = join(root, "workspace");
  const skillRoot = join(workspace, ".agents", "skills");
  const skillDirectory = join(skillRoot, "fixture-guide");
  const ctx = new Context();
  const handles = new Set<AgentHandle>();
  const createdSessions: SessionHeader[] = [];
  const agentErrors: unknown[] = [];
  let peer: FakeBrowserPeer | undefined;
  try {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: fixture-guide\ndescription: Load the local fixture guide when requested.\n---\n${skillBody}\n`, { flag: "wx" });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(DefaultModel, { provider: "deepseek-web", model: "current-web-session" });
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, "sessions"), compression: "none", packChunks: false });
    await ctx.plugin(CheckpointPolicy);
    await ctx.plugin(SandboxPolicyService, { mode: "workspace-write", workspaceRoot: workspace });
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace });
    await ctx.plugin(ObservationPolicy);
    await ctx.plugin(ApprovalService, { policy: "ask" });
    const pairingToken = createPairingToken();
    await ctx.plugin(Host, { pairingToken, allowedExtensionOrigins: [FAKE_EXTENSION_ORIGIN], port: await reservePort(),
      ...(options.persistentJournal ? { journalPath: join(root, "journal") } : {}) });
    await ctx.plugin(Adapter);
    peer = await FakeBrowserPeer.connect({ address: (ctx.deepseekWebBroker as DeepSeekWebModelHost).address, pairingToken });
    // Consume the real composition/config. Only the operator-selected root's
    // !!js expression is substituted with this fixture's owned absolute root.
    for (const row of featureRows()) {
      const plugin = row.id === "harness-web-compaction" ? WebCompactionEngine : await import(row.name!);
      const config = row.id === "harness-workspace-skills"
        ? { ...row.config, customSkillDirs: [skillRoot] }
        : row.id === "harness-tools-policy" ? { ...row.config, workspaceRoot: workspace } : row.config;
      await ctx.plugin(plugin.default ?? plugin, config);
    }
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    ctx.on("session/created", (session) => { createdSessions.push(session.header); });
    ctx.on("agent/error", (detail) => { agentErrors.push(detail.error); });
    return {
      ctx, peer, workspace, root, createdSessions,
      async create() {
        const handle = await ctx.agents.create({ sessionId: SessionId(`features-${randomUUID()}`), meta: { cwd: workspace }, agentOptions: ctx.agentDefaultModel.currentSelection() });
        handles.add(handle);
        return handle;
      },
      async resume(id: SessionId) {
        const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: ctx.agentDefaultModel.currentSelection() });
        handles.add(handle);
        return handle;
      },
      async disposeHandle(handle: AgentHandle) {
        await handle.dispose();
        handles.delete(handle);
      },
      async turn(handle: AgentHandle, text: string) {
        handle.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
        await handle.agent.whenIdle();
        peer!.throwIfFailed();
        await ctx.sessions.flush(handle.agent.session);
        if (agentErrors.length > 0) throw new AggregateError(agentErrors.splice(0), "FEATURES_AGENT_TURN_FAILED");
        const last = handle.agent.session.snapshotEvents().at(-1);
        if (last?.type !== "turn/end" || last.data.reason.kind !== "completed") {
          throw new Error(`FEATURES_TURN_NOT_COMPLETED: ${JSON.stringify(last)}`);
        }
      },
      async dispose() {
        try {
          for (const handle of handles) await handle.dispose();
        } finally {
          try { await peer!.close(); } finally {
            try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
          }
        }
      },
    };
  } catch (error) {
    try { await peer?.close(); } finally {
      try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
    }
    throw error;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen({ host: "127.0.0.1", port: 0 }, done); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("FEATURES_TCP_ADDRESS_REQUIRED");
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}
