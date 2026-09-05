import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, type ToolCallId } from "@deepseek-ai/dsh-llm";
import { SandboxPwshExecutor } from "@deepseek-ai/dsh-pwsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { ShellEnvRegistry } from "@deepseek-ai/dsh-shell-env";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as PwshTools from "@deepseek-ai/dsh-tool-pwsh";
import { ToolRuntime, type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";

/** No replacement process runner, sandbox, permission guard or shell parser. */
export async function createOfficialPwshFixture(mode: "read-only" | "workspace-write" = "workspace-write") {
  const root = await mkdtemp(join(tmpdir(), "dsh-official-pwsh-fixture-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const privateTempRoot = join(root, "runner-temp");
  await Promise.all([workspace, outside, privateTempRoot].map((path) => mkdir(path)));
  await writeFile(join(workspace, "inside.txt"), "official shell fixture\n", "utf8");
  await writeFile(join(outside, "outside.txt"), "outside fixture must remain unchanged\n", "utf8");
  const ctx = new Context();
  // Keep the official runner's private temp directories inside this owned
  // test fixture. This modifies only this test process, never user settings.
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  process.env.TEMP = privateTempRoot;
  process.env.TMP = privateTempRoot;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await ctx.fiber.dispose();
    } finally {
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace });
    await ctx.plugin(LocalSandboxProvider);
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(SandboxPwshExecutor, {
      cwd: workspace, timeoutMs: 5_000, maxTimeoutMs: 5_000,
      maxOutputBytes: 8_192, maxSpillBytes: 16_384, graceMs: 100,
    });
    await ctx.plugin(ShellEnvRegistry, { dshHome: join(root, "dsh-home") });
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(ApprovalService, { policy: "ask" });
    await ctx.plugin(PwshTools, { enableRunInBackground: false });
    const createIdleAgent = async () => {
      await ctx.plugin(SessionStore);
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
      // No prompt, model adapter or provider is installed or invoked.
      return ctx.agents.create({ sessionId: SessionId(`exec-fixture-${randomUUID()}`), meta: { cwd: workspace } });
    };
    return { ctx, root, workspace, outside, privateTempRoot, dispose, createIdleAgent };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function executePwsh(
  ctx: Context,
  argumentsValue: Record<string, unknown>,
  signal = new AbortController().signal,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: "official-pwsh-fixture-call" as ToolCallId,
    name: "pwsh",
    arguments: argumentsValue,
    signal,
    ...(agent === undefined ? {} : { agent }),
  });
}

export function resultText(result: ToolExecutionResult): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
