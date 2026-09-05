import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellProcess, type ShellRunResult } from "@deepseek-ai/dsh-shell";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import * as BashTool from "@deepseek-ai/dsh-tool-bash";
import type { ToolDefinition, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFileAccessPolicy } from "../packages/dsh-web-agent-bundle/src/file-access-policy.ts";
import { assertLinuxCommandHost, installLinuxCommandToolGuard } from "../packages/dsh-web-agent-bundle/src/linux-command-policy.ts";
import { createMutationFixture } from "./fixtures/dsh-web-agent/mutation/runtime.ts";

const fixtures: Awaited<ReturnType<typeof createMutationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function host(platform = "linux", uid = 1000, kernel = "6.18.33.2-microsoft-standard-WSL2") {
  const runtime = Object.create(process);
  Object.defineProperties(runtime, { platform: { value: platform }, getuid: { value: () => uid } });
  vi.stubGlobal("process", runtime);
  vi.spyOn(os, "release").mockReturnValue(kernel);
  syncBuiltinESMExports();
}
function readableBinfmt() {
  vi.spyOn(fs, "stat").mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>);
  const read = vi.spyOn(fs, "readFile").mockResolvedValueOnce("enabled\n");
  syncBuiltinESMExports();
  return read;
}

describe("Linux command host prerequisite facts (no process execution)", () => {
  it.each(["win32", "darwin"])("rejects %s before native providers or filesystem probes", async (platform) => {
    host(platform);
    const stat = vi.spyOn(fs, "stat");
    syncBuiltinESMExports();
    await expect(assertLinuxCommandHost()).rejects.toThrow("LINUX_COMMAND_REQUIRES_LINUX");
    expect(stat).not.toHaveBeenCalled();
  });
  it("rejects a privileged Linux runtime", async () => {
    host("linux", 0);
    await expect(assertLinuxCommandHost()).rejects.toThrow("LINUX_COMMAND_UNPRIVILEGED_USER_REQUIRED");
  });
  it("does not impose WSL proc requirements on native Linux", async () => {
    host("linux", 1000, "6.8.0-generic");
    const stat = vi.spyOn(fs, "stat");
    syncBuiltinESMExports();
    await expect(assertLinuxCommandHost()).resolves.toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
  });
  it("accepts no WSL handler only after the binfmt interface is known readable", async () => {
    host();
    const read = readableBinfmt().mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
    await expect(assertLinuxCommandHost()).resolves.toBeUndefined();
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      "/proc/sys/fs/binfmt_misc/status", "/proc/sys/fs/binfmt_misc/WSLInterop",
    ]);
  });
  it("accepts an explicitly disabled WSL handler", async () => {
    host(); readableBinfmt().mockResolvedValueOnce("disabled\ninterpreter /init\n");
    await expect(assertLinuxCommandHost()).resolves.toBeUndefined();
  });
  it("rejects an enabled handler, regardless of environment variables", async () => {
    host(); readableBinfmt().mockResolvedValueOnce("enabled\ninterpreter /init\n");
    await expect(assertLinuxCommandHost()).rejects.toThrow("LINUX_COMMAND_WSL_INTEROP_ENABLED");
  });
  it.each(["ENOENT", "EACCES"])("does not confuse %s on the binfmt root with a disabled handler", async (code) => {
    host();
    vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("unavailable"), { code }));
    syncBuiltinESMExports();
    await expect(assertLinuxCommandHost()).rejects.toThrow("LINUX_COMMAND_WSL_INTEROP_STATUS_UNAVAILABLE");
  });
  it.each(["unknown", "unreadable"])("fails a %s handler status closed", async (state) => {
    host();
    const read = readableBinfmt();
    if (state === "unknown") read.mockResolvedValueOnce("mystery\n");
    else read.mockRejectedValueOnce(Object.assign(new Error("unreadable"), { code: "EACCES" }));
    await expect(assertLinuxCommandHost()).rejects.toThrow("LINUX_COMMAND_WSL_INTEROP_STATUS_UNAVAILABLE");
  });
});

/** Unit-only capability: proves admission reached the unchanged official Bash
 * tool without spawning anything. Actual Linux execution has its own CLI E2E. */
class GuardOnlyShell extends ShellExecutor {
  readonly calls: ShellExecSpec[] = [];
  constructor(ctx: Context, readonly fixtureConfig: { cwd: string }) { super(ctx); }
  get sandboxMode() { return "workspace-write" as const; }
  resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...request, workdir: request.workdir ?? this.fixtureConfig.cwd, timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: 16_384, sandboxPolicy: request.sandboxPolicy };
  }
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.calls.push(spec);
    throw new Error("UNIT_ONLY_NO_PROCESS_EXECUTED");
  }
  start(): ShellProcess { throw new Error("UNIT_ONLY_BACKGROUND_MUST_NOT_RUN"); }
}

async function setupGuard() {
  const fixture = await createMutationFixture();
  fixtures.push(fixture);
  await fixture.editor.dispose();
  const definitions = new Map<string, ToolDefinition>();
  await installFileAccessPolicy(fixture.ctx, { workspaceRoot: fixture.workspace, tool: "str_replace_editor", toolDefinitions: definitions });
  await fixture.ctx.plugin(GuardOnlyShell, { cwd: fixture.workspace });
  await fixture.ctx.plugin(ShellEnv);
  await fixture.ctx.plugin(BashTool, { enableRunInBackground: false });
  const bash = fixture.ctx.tools.get("bash")!;
  definitions.set("bash", bash);
  installLinuxCommandToolGuard(fixture.ctx, fixture.workspace, bash);
  return {
    ...fixture, bash,
    shell: fixture.ctx.shell as GuardOnlyShell,
    call: (args: unknown, agent = fixture.agent) => fixture.ctx.tools.execute({
      callId: ToolCallId(`linux-guard-${randomUUID()}`), name: "bash", arguments: args, agent, signal: new AbortController().signal,
    }),
  };
}
const SAFE = { command: "printf fixture", description: "Check a fixed fixture marker", timeoutMs: 5_000 };
function textOf(result: ToolExecutionResult) {
  return result.content.flatMap((block) => block.type === "text" ? block.text : []).join("\n");
}

describe("exact original Bash definition and fixed workspace command policy", () => {
  it("passes only a bounded foreground request to the unchanged official Bash tool", async () => {
    const fixture = await setupGuard();
    expect(textOf(await fixture.call(SAFE))).toContain("UNIT_ONLY_NO_PROCESS_EXECUTED");
    expect(fixture.shell.calls).toHaveLength(1);
    expect(fixture.shell.calls[0]).toMatchObject({ command: SAFE.command, workdir: fixture.workspace, timeoutMs: 5_000,
      sandboxPolicy: { mode: "workspace-write", workspaceRoot: fixture.workspace } });
  });
  it.each(["workdir", "cwd", "env", "sandbox_permissions", "justification", "run_in_background"])(
    "rejects model-owned %s before the executor", async (field) => {
      const fixture = await setupGuard();
      const result = await fixture.call({ ...SAFE, [field]: field === "env" ? {} : "danger-full-access" });
      expect(textOf(result)).toContain("LINUX_COMMAND_WORKSPACE_ACCESS_DENIED");
      expect(fixture.shell.calls).toEqual([]);
    },
  );
  it.each([0, -1, 60_001, null])("rejects invalid timeout %s before the executor", async (timeoutMs) => {
    const fixture = await setupGuard();
    expect(textOf(await fixture.call({ ...SAFE, timeoutMs }))).toContain("LINUX_COMMAND_WORKSPACE_ACCESS_DENIED");
    expect(fixture.shell.calls).toEqual([]);
  });
  it("rejects same-name agent-scoped replacement before its body", async () => {
    const fixture = await setupGuard();
    const replacement = vi.fn(async () => { throw new Error("must not run"); });
    fixture.agent.ctx.tools.register({ ...fixture.bash, execute: replacement });
    expect((await fixture.call(SAFE)).isError).toBe(true);
    expect(replacement).not.toHaveBeenCalled();
    expect(fixture.shell.calls).toEqual([]);
  });
  it.each(["read-only", "danger-full-access"] as const)("rejects a session policy change to %s", async (mode) => {
    const fixture = await setupGuard();
    setSandboxMode(fixture.agent.session, mode);
    expect(textOf(await fixture.call(SAFE))).toContain("LINUX_COMMAND_WORKSPACE_ACCESS_DENIED");
    expect(fixture.shell.calls).toEqual([]);
  });
  it("applies the same guard to another agent with an outside cwd", async () => {
    const fixture = await setupGuard();
    const child = await fixture.ctx.agents.create({ sessionId: SessionId(`outside-${randomUUID()}`), meta: { cwd: fixture.outsideDir } });
    try {
      expect(textOf(await fixture.call(SAFE, child.agent))).toContain("LINUX_COMMAND_WORKSPACE_ACCESS_DENIED");
      expect(fixture.shell.calls).toEqual([]);
    } finally { await child.dispose(); }
  });
});

it("the Linux overlay replaces only the tool owner and corrects its persona", () => {
  const rows = composeEntries(["cordis.patch.yml", "cordis.workspace-files.patch.yml", "cordis.harness-features.patch.yml", "cordis.linux-commands.patch.yml"]
    .map((name) => loadOverlayPatches("linux-policy-test", resolve("packages/dsh-web-agent-bundle", name))));
  expect(rows.find((row) => row.id === "harness-tools-policy")?.disabled).toBe(true);
  expect(rows.find((row) => row.id === "deepseek-web-workspace-files-policy")?.disabled).toBe(true);
  expect(rows.find((row) => row.id === "linux-command-policy")?.name).toBe("@deepseek-pp/dsh-web-agent-bundle/linux-command-policy");
  const persona = String(rows.find((row) => row.id === "system-prompt")?.config?.persona);
  expect(persona).toContain("Bash commands run");
  expect(persona).not.toContain("shell commands and permission escalation are unavailable");
});
