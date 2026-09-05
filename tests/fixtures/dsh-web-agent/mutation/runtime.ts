import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import * as ObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { LlmRuntime, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as Editor from "@deepseek-ai/dsh-tool-str-replace-editor";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";

export const MUTATION_TOOL_NAME = "str_replace_editor";
export const MUTATION_OFFICIAL_VERSION = "0.1.2-rc.1";
export const MUTATION_PLUGIN_ALLOWLIST = [
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-fs-sandbox",
  "@deepseek-ai/dsh-fs-observation-policy",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-tool-str-replace-editor",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-agent-loop",
] as const;

/**
 * Owned test fixtures live under the ignored checkout scratch directory rather
 * than os.tmpdir(): the official
 * workspace-write policy deliberately grants platform temporary directories,
 * so a sibling in TEMP would not exercise its out-of-workspace denial.
 * No user files or browser/model calls are involved.
 */
export async function createMutationFixture(mode: "read-only" | "workspace-write" = "workspace-write") {
  const fixtureParent = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..", ".tmp-deepseek-live", "mutation-fixtures");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "owned-"));
  const workspace = join(root, "workspace");
  const outsideDir = join(root, "outside");
  const outside = join(outsideDir, "outside.txt");
  const ctx = new Context();
  const disposeFiles = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(workspace);
    await mkdir(outsideDir);
    await writeFile(outside, "outside fixture content\n", "utf8");
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace });
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace });
    await ctx.plugin(ObservationPolicy);
    await ctx.plugin(ApprovalService, { policy: "ask" });
    const editor = ctx.plugin(Editor, { maxOutputChars: 512 });
    await editor;
    await ctx.plugin(SessionStore);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    const handle = await ctx.agents.create({
      sessionId: SessionId(`mutation-fixture-${randomUUID()}`),
      meta: { cwd: workspace },
    });
    return {
      ctx,
      root,
      workspace,
      outsideDir,
      outside,
      editor,
      agent: handle.agent,
      execute: (command: "view" | "create" | "str_replace" | "insert", path: string,
        args: Record<string, unknown> = {}, signal = new AbortController().signal) => ctx.tools.execute({
        callId: ToolCallId(`mutation-${randomUUID()}`),
        name: MUTATION_TOOL_NAME,
        arguments: { command, path, ...args },
        agent: handle.agent,
        signal,
      }),
      async dispose() {
        try {
          await handle.dispose();
        } finally {
          await ctx.fiber.dispose();
          await disposeFiles();
        }
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    await disposeFiles();
    throw error;
  }
}
