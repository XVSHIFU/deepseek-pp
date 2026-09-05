import fs from "node:fs/promises";
import os from "node:os";
import { isAbsolute } from "node:path";

import { symbols, type Context } from "@deepseek-ai/cordis";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-subprocess";
import type { ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";

import { installFileAccessPolicy } from "./file-access-policy.ts";
import { mountHarnessToolDefinitions } from "./harness-tools-policy.ts";
import { Config } from "./workspace-files-policy.ts";

export { Config };
export const name = "deepseek-web-linux-command-policy";
export const inject = ["tools", "fs", "agents", "skills", "subagents", "systemPrompt", "sessionProjections", "sandboxPolicy"];

const BINFMT_ROOT = "/proc/sys/fs/binfmt_misc";
const COMMAND_FIELDS = new Set(["command", "description", "timeoutMs"]);
const COMMAND_DENIED = "LINUX_COMMAND_WORKSPACE_ACCESS_DENIED";

/** Check the running host, not an operator-supplied success flag or env hint. */
export async function assertLinuxCommandHost(): Promise<void> {
  if (process.platform !== "linux") throw new Error("LINUX_COMMAND_REQUIRES_LINUX");
  if (process.getuid?.() === undefined || process.getuid() === 0) {
    throw new Error("LINUX_COMMAND_UNPRIVILEGED_USER_REQUIRED");
  }
  if (!/microsoft/i.test(os.release())) return;
  try {
    if (!(await fs.stat(BINFMT_ROOT)).isDirectory()) throw new Error("binfmt unavailable");
    const status = (await fs.readFile(`${BINFMT_ROOT}/status`, "utf8")).trim();
    if (status !== "enabled" && status !== "disabled") throw new Error("binfmt unknown");
  } catch {
    throw new Error("LINUX_COMMAND_WSL_INTEROP_STATUS_UNAVAILABLE");
  }
  let interop: string;
  try {
    interop = await fs.readFile(`${BINFMT_ROOT}/WSLInterop`, "utf8");
  } catch (error) {
    // An absent handler on the readable, mounted binfmt interface is disabled.
    // Missing/unreadable interface is rejected above, not mistaken for absence.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("LINUX_COMMAND_WSL_INTEROP_STATUS_UNAVAILABLE");
  }
  const state = interop.split(/\r?\n/, 1)[0]?.trim();
  if (state === "disabled") return;
  if (state === "enabled") throw new Error("LINUX_COMMAND_WSL_INTEROP_ENABLED");
  throw new Error("LINUX_COMMAND_WSL_INTEROP_STATUS_UNAVAILABLE");
}

/** Extra command admission over the same exact-definition file/tool fence. */
export function installLinuxCommandToolGuard(ctx: Context, workspaceRoot: string, definition: ToolDefinition): void {
  const root = canonicalPath(workspaceRoot);
  const shell = ctx.shell;
  const sandbox = ctx.sandbox;
  const subprocess = ctx.subprocess;
  const sandboxPolicy = ctx.sandboxPolicy;
  // Cordis returns a fresh caller-context proxy on each service lookup. Its
  // public original symbol identifies the owned service, not those proxies.
  const owned = [shell, sandbox, subprocess, sandboxPolicy].map(serviceIdentity);
  ctx.tools.guard((exec) => {
    if (exec.name !== "bash") return undefined;
    if (ctx.tools.get(exec.name, exec.agent) !== definition || !validCommandArguments(exec)
      || [ctx.shell, ctx.sandbox, ctx.subprocess, ctx.sandboxPolicy].some((service, index) => serviceIdentity(service) !== owned[index])
      || shell.sandboxMode !== "workspace-write") return COMMAND_DENIED;
    const policy = sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
    const sessionCwd = exec.agent?.session.header.cwd;
    return policy.mode === "workspace-write" && canonicalPath(policy.workspaceRoot) === root
      && (sessionCwd === undefined || canonicalPath(sessionCwd) === root)
      ? undefined : COMMAND_DENIED;
  });
}

function serviceIdentity(value: unknown): unknown {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? Reflect.get(value, symbols.original) ?? value : value;
}

function validCommandArguments(exec: Readonly<ToolExecution>): boolean {
  const args = exec.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args) || exec.signal.aborted) return false;
  const fields = args as Record<string, unknown>;
  return Object.keys(fields).every((field) => COMMAND_FIELDS.has(field))
    && typeof fields.command === "string" && typeof fields.description === "string"
    && (fields.timeoutMs === undefined || (typeof fields.timeoutMs === "number"
      && Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0 && fields.timeoutMs <= 60_000));
}

/**
 * Fixed, original Linux providers and tools; never an argv wrapper or a raw
 * local executor fallback. The OS probe/CLI acceptance remains independent
 * evidence: the backend's "full" report alone is not isolation acceptance.
 */
export async function apply(ctx: Context, config: Config) {
  await assertLinuxCommandHost();
  if (!isAbsolute(config.workspaceRoot)) throw new Error("LINUX_COMMAND_WORKSPACE_REQUIRED");
  const root = canonicalPath(config.workspaceRoot);
  const policy = ctx.sandboxPolicy.resolve();
  if (policy.mode !== "workspace-write" || canonicalPath(policy.workspaceRoot) !== root) {
    throw new Error("LINUX_COMMAND_WORKSPACE_REQUIRED");
  }
  if (["shell", "subprocess", "sandbox", "shellEnv", "settings"].some((service) => ctx.get(service) !== undefined)) {
    throw new Error("LINUX_COMMAND_EMPTY_EXECUTION_SERVICES_REQUIRED");
  }
  const definitions = new Map<string, ToolDefinition>();
  await installFileAccessPolicy(ctx, { workspaceRoot: root, tool: "str_replace_editor", toolDefinitions: definitions });
  // Native packages load only after host prerequisites. No runnerCommand,
  // fake platform/probe, configurable provider or ambient shell settings.
  const [Subprocess, Sandbox, Bash, ShellEnv, BashTool] = await Promise.all([
    import("@deepseek-ai/dsh-subprocess-local"),
    import("@deepseek-ai/dsh-sandbox-local"),
    import("@deepseek-ai/dsh-bash-sandbox"),
    import("@deepseek-ai/dsh-shell-env"),
    import("@deepseek-ai/dsh-tool-bash"),
  ]);
  await ctx.plugin(Subprocess.LocalSubprocessRuntime);
  await ctx.plugin(Sandbox.LocalSandboxProvider, { probeTimeoutMs: 3_000 });
  await ctx.plugin(Bash.SandboxBashExecutor, {
    cwd: root, timeoutMs: 30_000, maxTimeoutMs: 60_000,
    maxOutputBytes: 16_384, maxSpillBytes: 65_536, graceMs: 200,
  });
  await ctx.plugin(ShellEnv);
  // These services are owned above, so requesting them in the outer inject
  // list would deadlock their creation. Cordis owns this second-phase scope.
  await ctx.inject([...inject, "sandbox", "subprocess", "shell", "shellEnv"], async (execution) => {
    // Official selection/probing, not a custom runner or a claimed test pass.
    if (execution.sandbox.confine(["/usr/bin/true"], { mode: "workspace-write", workspaceRoot: root }).enforcement !== "full") {
      throw new Error("LINUX_COMMAND_FULL_WRITE_CONFINEMENT_REQUIRED");
    }
    await mountHarnessToolDefinitions(execution, { ...config, workspaceRoot: root }, definitions);
    await execution.plugin(BashTool, { enableRunInBackground: false });
    const bash = execution.tools.get("bash");
    if (bash === undefined
      || execution.tools.schemas().map((tool) => tool.name).sort().join(",") !== "bash,skill,str_replace_editor,subagent") {
      throw new Error("LINUX_COMMAND_OFFICIAL_COMPOSITION_CHANGED");
    }
    definitions.set("bash", bash);
    installLinuxCommandToolGuard(execution, root, bash);
    execution.systemPrompt.section({
      name: "deepseek-web:linux-command-boundary", order: 50,
      text: "The bash tool is limited to the selected workspace in the local Linux environment. Supply only command, description, and optionally timeoutMs (at most 60000). Do not supply workdir, environment, permission escalation, justification, or background fields. Commands and child agents use the same workspace-write boundary; no shell escalation is available.",
    });
  });
}
