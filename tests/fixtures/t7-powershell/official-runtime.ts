import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, ToolCallId } from "@deepseek-ai/dsh-llm";
import { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local";
import { SessionId, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { ShellEnvRegistry } from "@deepseek-ai/dsh-shell-env";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as PwshTools from "@deepseek-ai/dsh-tool-pwsh";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";

import {
  JsonWindowsSessionPolicyStore,
  installWindowsPowerShellPolicy,
  type WindowsPowerShellConfig,
  type WindowsSessionPolicyStore,
} from "../../../packages/dsh-deepseek-web-official-plugin/src/windows-powershell.ts";

interface OfficialPowerShellRuntimeOptions {
  readonly pwshPath?: string;
  readonly policyStore?: WindowsSessionPolicyStore;
  readonly policyStorePath?: string;
  readonly sessionId?: string;
  readonly seed?: readonly SessionEvent[];
  readonly readConfig?: () => WindowsPowerShellConfig;
  readonly persistenceRoot?: string;
  readonly resumeSessionId?: string;
  readonly isImportedSessionDenied?: (sessionId: string) => boolean;
}

export async function createOfficialPowerShellRuntime(
  config: WindowsPowerShellConfig,
  options: OfficialPowerShellRuntimeOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-t7-powershell-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(PwshLocalExecutor, {
      cwd: workspace,
      pwshPath: options.pwshPath ?? "pwsh",
      timeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxOutputBytes: 4_096,
      maxSpillBytes: 8_192,
      graceMs: 100,
    });
    await ctx.plugin(ShellEnvRegistry, { dshHome: join(root, "dsh-home") });
    await ctx.plugin(ToolRuntime, { mode: "native" });
    await ctx.plugin(ApprovalService, { policy: "ask" });
    await ctx.plugin(PwshTools, { enableRunInBackground: false });
    const policyStorePath = options.policyStorePath ?? join(root, "windows-session-policies.json");
    const policyStore = options.policyStore ?? new JsonWindowsSessionPolicyStore(policyStorePath);
    const policy = await installWindowsPowerShellPolicy(
      ctx,
      config,
      policyStore,
      options.readConfig,
      undefined,
      options.isImportedSessionDenied,
    );
    await ctx.plugin(SessionStore);
    if (options.persistenceRoot !== undefined) {
      await ctx.plugin(JsonlSessionPersistence, { root: options.persistenceRoot, compression: "none" });
    }
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    const handles: Awaited<ReturnType<typeof ctx.agents.create>>[] = [];
    const createAgent = async (
      seed?: readonly SessionEvent[],
      sessionId = `t7-powershell-${randomUUID()}`,
      provider = "deepseek-web",
    ) => {
      const handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: workspace },
        ...(seed === undefined ? {} : { seed }),
        agentOptions: { provider, model: provider === "deepseek-web" ? "current-web-session" : "fixture-model" },
      });
      handles.push(handle);
      return handle;
    };
    const handle = options.resumeSessionId === undefined
      ? await createAgent(options.seed, options.sessionId)
      : await ctx.agents.resume({
        resumeSessionId: SessionId(options.resumeSessionId),
        agentOptions: { provider: "deepseek-web", model: "current-web-session" },
      });
    if (options.resumeSessionId !== undefined) handles.push(handle);
    return {
      ctx,
      root,
      workspace,
      policy,
      policyStore,
      policyStorePath,
      agent: handle.agent,
      createAgent,
      execute(
        argumentsValue: Record<string, unknown>,
        signal = new AbortController().signal,
        agent = handle.agent,
      ) {
        return ctx.tools.execute({
          callId: ToolCallId(`t7-powershell-${randomUUID()}`),
          name: "pwsh",
          arguments: argumentsValue,
          agent,
          signal,
        });
      },
      async dispose() {
        try {
          for (let index = handles.length - 1; index >= 0; index -= 1) {
            await handles[index]!.dispose();
          }
        } finally {
          await ctx.fiber.dispose();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []).join("\n");
}
