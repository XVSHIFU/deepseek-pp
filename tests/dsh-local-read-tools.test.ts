import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { LlmRuntime, type ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as FileTools from "@deepseek-ai/dsh-tool-fs";
import { ToolRuntime, type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import * as ReadonlyPolicy from "@deepseek-pp/dsh-web-agent-bundle/readonly-policy";
import { afterEach, describe, expect, it, vi } from "vitest";

const owned: Array<{ ctx: Context; root: string }> = [];

afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    await fixture.ctx.fiber.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// These are upstream behavior probes, NOT a passing workspace-isolation claim.
// T4.2 stays incomplete until a reviewed official or narrow policy composition
// rejects the observed escapes; no probe is mounted by the production profile.
describe("T4.2 current-gap: official DSH 0.1.2-rc.1 read-only is not workspace-contained", () => {
  it("registers the official read schema but also publishes write and edit", async () => {
    const { ctx } = await fixture();
    expect(ctx.fs.sandboxMode).toBe("read-only");
    expect(ctx.tools.schemas().map(({ name }) => name)).toEqual(["read", "write", "edit"]);
    expect(ctx.tools.get("read")?.parameters).toMatchObject({
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    });
    expect(Object.keys(FileTools.Config.dict ?? {}).sort()).toEqual([
      "readLimit", "readMaxBytes", "readMaxLineLength", "readStreamMinSize",
    ]);
  });

  it("executes bounded official reads within the configured Windows workspace", async () => {
    const { ctx } = await fixture();
    const result = await execute(ctx, "read", { file_path: "inside.txt", offset: 2, limit: 1 });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("2: inside second line");
    expect(textOf(result)).not.toContain("1: inside first line");
    const capped = await execute(ctx, "read", { file_path: "inside.txt", limit: 4 });
    expect(capped.isError).toBe(true);
  });

  it("current-gap: parent traversal and absolute paths read outside the workspace", async () => {
    const { ctx, workspace, outside } = await fixture();
    const workspaceTarget = await ctx.fs.resolve(workspace);
    const outsideTarget = await ctx.fs.resolve(outside);
    // The official provider can identify containment, but the official read
    // tool never asks for it. This is the narrow policy extension opportunity.
    expect(ctx.fs.contains(workspaceTarget, outsideTarget)).toBe(false);
    for (const file_path of ["../outside/outside.txt", outside]) {
      const result = await execute(ctx, "read", { file_path });
      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain("outside fixture marker");
      expect(textOf(result)).toContain("<path>");
    }
  });

  it("current-gap: an in-workspace Windows junction follows its outside target", async () => {
    const { ctx, workspace, outsideDir } = await fixture();
    await symlink(outsideDir, join(workspace, "outside-junction"), process.platform === "win32" ? "junction" : "dir");
    const result = await execute(ctx, "read", { file_path: "outside-junction/outside.txt" });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("outside fixture marker");
    expect(ctx.fs.contains(await ctx.fs.resolve(workspace), await ctx.fs.resolve("outside-junction/outside.txt"))).toBe(false);
  });

  it("read-only still denies official mutations, confirming what the mode protects", async () => {
    const { ctx, workspace } = await fixture();
    const result = await execute(ctx, "write", { file_path: "inside.txt", content: "must not replace" });
    expect(result.isError).toBe(true);
    expect(result).toMatchObject({ error: { info: { code: "FS_SANDBOX_DENIED" } } });
    expect(await readFile(join(workspace, "inside.txt"), "utf8")).toContain("inside first line");
  });
});

describe("DeepSeek Web fixture-only official read composition", () => {
  it("adds only the reviewed official dependencies and replaces the persona without exposing cwd", async () => {
    const bundle = resolve(process.cwd(), "packages/dsh-web-agent-bundle");
    const base = loadOverlayPatches("readonly-test", join(bundle, "cordis.patch.yml"));
    const readonly = loadOverlayPatches("readonly-test", join(bundle, "cordis.readonly.patch.yml"));
    const warnings: string[] = [];
    const baseRows = composeEntries([base]);
    const rows = composeEntries([base, readonly], (warning) => { warnings.push(warning); });
    expect(warnings).toEqual([]);
    expect(rows.filter((row) => !baseRows.some((original) => original.id === row.id)).map(({ id, name }) => [id, name])).toEqual([
      ["readonly-sandbox-policy", "@deepseek-ai/dsh-sandbox-policy"],
      ["readonly-fs-sandbox", "@deepseek-ai/dsh-fs-sandbox"],
      ["deepseek-web-readonly-policy", "@deepseek-pp/dsh-web-agent-bundle/readonly-policy"],
    ]);
    const prompt = rows.find((row) => row.id === "system-prompt");
    expect(prompt?.config).toEqual({
      includeHarnessIdentity: true,
      includeRuntimeContext: false,
      persona: "You are a local read-only agent powered by the DeepSeek web model. Use the available read tool to inspect the requested fixture file.",
    });
    expect(JSON.stringify(prompt)).not.toContain("{{cwd}}");
    expect(JSON.stringify(baseRows.find((row) => row.id === "system-prompt"))).toContain("{{cwd}}");
  });

  it("publishes only the unchanged official read definition and disposes it with its owner", async () => {
    const { ctx, policy } = await fixture(true);
    expect(ctx.tools.schemas().map(({ name }) => name)).toEqual(["read"]);
    expect(ctx.tools.get("read")?.parameters).toMatchObject({ required: ["file_path"] });
    for (const name of ["write", "edit", "read_image", "grep", "glob", "bash", "pwsh"]) {
      expect(ctx.tools.get(name)).toBeUndefined();
      expect((await execute(ctx, name, { file_path: "inside.txt", content: "must not write" })).isError).toBe(true);
    }
    await policy!.dispose();
    expect(ctx.tools.schemas()).toEqual([]);
    expect((await execute(ctx, "read", { file_path: "inside.txt" })).isError).toBe(true);
  });

  it("reads relative/absolute in-workspace files but rejects directories rather than inventing a list tool", async () => {
    const { ctx, workspace } = await fixture(true);
    const allowed = ["inside.txt", join(workspace, "inside.txt")];
    if (process.platform === "win32") allowed.push(join(workspace, "inside.txt").toUpperCase());
    for (const file_path of allowed) {
      const result = await execute(ctx, "read", { file_path });
      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain("inside first line");
    }
    const directory = await execute(ctx, "read", { file_path: "." });
    expect(directory).toMatchObject({ isError: true, error: { info: { code: "FS_NOT_REGULAR_FILE" } } });
  });

  it("denies traversal, outside absolute paths, Windows drive/case aliases and static junction escapes without leaking the outside marker", async () => {
    const { ctx, workspace, outside, outsideDir } = await fixture(true);
    await symlink(outsideDir, join(workspace, "outside-junction"), process.platform === "win32" ? "junction" : "dir");
    const denied = ["../outside/outside.txt", outside, "outside-junction/outside.txt"];
    if (process.platform === "win32") denied.push(outside.toUpperCase(), outside.replaceAll("\\", "/"));
    for (const file_path of denied) {
      const result = await execute(ctx, "read", { file_path });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("READONLY_WORKSPACE_ACCESS_DENIED");
      expect(textOf(result)).not.toContain("outside fixture marker");
      expect(textOf(result)).not.toContain(outsideDir);
    }
  });

  it("does not let an allowing pre-execute listener bypass the monotonic guard", async () => {
    const { ctx, outside } = await fixture(true);
    ctx.on("tools/pre-execute", async () => ({ kind: "allow" }));
    const denied = await execute(ctx, "read", { file_path: outside });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).not.toContain("outside fixture marker");
  });

  it("aligns agent session junction-cwd parent traversal with the official read resolver", async () => {
    const { ctx, workspace, outsideDir } = await fixture(true);
    await mkdir(join(outsideDir, "sub"));
    await writeFile(join(outsideDir, "sub", "outside.txt"), "outside fixture marker\n", "utf8");
    await writeFile(join(workspace, "outside.txt"), "inside decoy marker\n", "utf8");
    const sessionCwd = join(workspace, "junction-cwd");
    await symlink(join(outsideDir, "sub"), sessionCwd, process.platform === "win32" ? "junction" : "dir");
    await ctx.plugin(SessionStore);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    const handle = await ctx.agents.create({
      sessionId: SessionId("junction-cwd-regression"),
      meta: { cwd: sessionCwd },
    });
    try {
      const paths = ["../outside.txt"];
      if (process.platform === "win32") paths.push("..\\outside.txt", `${sessionCwd.slice(0, 2)}outside.txt`);
      for (const file_path of paths) {
        const result = await execute(ctx, "read", { file_path }, handle.agent);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("READONLY_WORKSPACE_ACCESS_DENIED");
        expect(textOf(result)).not.toContain("outside fixture marker");
        expect(textOf(result)).not.toContain("inside decoy marker");
      }
    } finally {
      await handle.dispose();
    }
  });

  it("denies a pending admission when its policy owner is stopped", async () => {
    const { ctx, policy } = await fixture(true);
    const original = ctx.fs.resolve.bind(ctx.fs);
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const spy = vi.spyOn(ctx.fs, "resolve").mockImplementationOnce(async (...args) => {
      started.resolve();
      await released.promise;
      return original(...args);
    });
    const pending = execute(ctx, "read", { file_path: "inside.txt" });
    await started.promise;
    await policy!.dispose();
    released.resolve();
    const result = await pending;
    spy.mockRestore();
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("inside first line");
    expect(ctx.tools.schemas()).toEqual([]);
  });

  it("keeps the configured official output window and abort behavior", async () => {
    const { ctx } = await fixture(true);
    const result = await execute(ctx, "read", { file_path: "inside.txt", offset: 2, limit: 1 });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("2: inside second line");
    expect(textOf(result)).not.toContain("1: inside first line");
    const controller = new AbortController();
    controller.abort();
    expect((await ctx.tools.execute({
      callId: "aborted-read" as ToolCallId,
      name: "read",
      arguments: { file_path: "inside.txt" },
      signal: controller.signal,
    })).isError).toBe(true);
  });
});

async function fixture(readonly = false) {
  const root = await mkdtemp(join(tmpdir(), "dsh-read-containment-probe-"));
  const workspace = join(root, "workspace");
  const outsideDir = join(root, "outside");
  const outside = join(outsideDir, "outside.txt");
  const ctx = new Context();
  owned.push({ ctx, root });
  await mkdir(workspace);
  await mkdir(outsideDir);
  await writeFile(join(workspace, "inside.txt"), "inside first line\ninside second line\ninside third line\n", "utf8");
  await writeFile(outside, "outside fixture marker\n", "utf8");
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SandboxPolicyService, { mode: "read-only", workspaceRoot: workspace });
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace });
  await ctx.plugin(ToolRuntime, { mode: "native" });
  const policy = readonly ? ctx.plugin(ReadonlyPolicy, { workspaceRoot: workspace, readLimit: 3 }) : undefined;
  if (policy) await policy;
  else await ctx.plugin(FileTools, { readLimit: 3 });
  return { ctx, root, workspace, outside, outsideDir, policy };
}

async function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    callId: "read-containment-probe" as ToolCallId,
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  });
}

function textOf(result: ToolExecutionResult) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
