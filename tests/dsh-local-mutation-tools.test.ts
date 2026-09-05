import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMutationFixture, MUTATION_PLUGIN_ALLOWLIST, MUTATION_TOOL_NAME } from "./fixtures/dsh-web-agent/mutation/runtime";

const fixtures: Awaited<ReturnType<typeof createMutationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe("T4.5 official filesystem mutation composition", () => {
  it("publishes only the official editor and freezes workspace-write plus ask without a shell", async () => {
    const fixture = await setup();
    expect(fixture.ctx.tools.schemas().map((tool) => tool.name)).toEqual([MUTATION_TOOL_NAME]);
    expect(fixture.ctx.tools.get(MUTATION_TOOL_NAME)?.parameters).toMatchObject({
      type: "object",
      required: ["command", "path"],
      properties: {
        command: { type: "string", enum: ["view", "create", "str_replace", "insert"] },
        path: { type: "string" },
      },
    });
    expect(fixture.ctx.fs.sandboxMode).toBe("workspace-write");
    expect(fixture.ctx.sandboxPolicy.resolve({ session: fixture.agent.session })).toMatchObject({
      mode: "workspace-write", workspaceRoot: fixture.workspace,
    });
    expect(fixture.ctx.approval.config).toEqual({ policy: "ask" });
    expect(MUTATION_PLUGIN_ALLOWLIST.some((name) => /(?:shell|bash|pwsh|llm-deepseek|llm-pi)/.test(name))).toBe(false);
  });

  it("creates, reads, replaces and inserts through the real official registry and agent session", async () => {
    const fixture = await setup();
    const file = join(fixture.workspace, "proof.txt");
    expect((await fixture.execute("create", file, { file_text: "first line\nsecond line\n" })).isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("first line\nsecond line\n");
    expect(textOf(await fixture.execute("view", file))).toContain("first line");
    expect((await fixture.execute("str_replace", file, { old_str: "first line", new_str: "changed first line" })).isError).toBe(false);
    expect((await fixture.execute("insert", file, { insert_line: 1, new_str: "inserted line" })).isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("changed first line\ninserted line\nsecond line\n");
  });

  it("does not clobber an existing file via create or edit before observing it", async () => {
    const fixture = await setup();
    const file = join(fixture.workspace, "existing.txt");
    await writeFile(file, "original fixture content\n", "utf8");
    expect((await fixture.execute("create", file, { file_text: "replacement" })).isError).toBe(true);
    expect(await fixture.execute("str_replace", file, { old_str: "original", new_str: "changed" })).toMatchObject({
      isError: true, error: { info: { code: "FS_NOT_OBSERVED" } },
    });
    expect(await readFile(file, "utf8")).toBe("original fixture content\n");
  });

  it("fails the upstream compare-and-swap guard after a previously viewed fixture changed", async () => {
    const fixture = await setup();
    const file = join(fixture.workspace, "stale.txt");
    await writeFile(file, "original fixture content\n", "utf8");
    expect((await fixture.execute("view", file)).isError).toBe(false);
    await writeFile(file, "original fixture content changed by fixture owner\n", "utf8");
    expect(await fixture.execute("str_replace", file, { old_str: "original", new_str: "must not replace" })).toMatchObject({
      isError: true, error: { info: { code: "FS_STALE_VERSION" } },
    });
    expect(await readFile(file, "utf8")).toBe("original fixture content changed by fixture owner\n");
  });

  it("denies ungranted mutations under read-only even when ask is mounted or model fields demand escalation", async () => {
    const fixture = await setup("read-only");
    const file = join(fixture.workspace, "readonly.txt");
    await writeFile(file, "original fixture content\n", "utf8");
    await fixture.execute("view", file);
    const requestApproval = vi.spyOn(fixture.ctx.approval, "request");
    const deniedCreate = await fixture.execute("create", join(fixture.workspace, "denied.txt"), {
      file_text: "must not create", sandbox_permissions: "danger-full-access", justification: "model demand is not a grant",
    });
    const deniedEdit = await fixture.execute("str_replace", file, { old_str: "original", new_str: "must not replace" });
    for (const result of [deniedCreate, deniedEdit]) {
      expect(result).toMatchObject({ isError: true, error: { info: { code: "FS_SANDBOX_DENIED" } } });
    }
    expect(requestApproval).not.toHaveBeenCalled();
    requestApproval.mockRestore();
    await expect(readFile(join(fixture.workspace, "denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file, "utf8")).toBe("original fixture content\n");
  });

  it("denies writes and edits outside the workspace, including a Windows junction target", async () => {
    const fixture = await setup();
    const link = join(fixture.workspace, "outside-junction");
    await symlink(fixture.outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    const creations = [join(fixture.outsideDir, "new.txt"), join(link, "via-junction.txt")];
    for (const file of creations) {
      expect(await fixture.execute("create", file, { file_text: "must not create" })).toMatchObject({
        isError: true, error: { info: { code: "FS_SANDBOX_DENIED" } },
      });
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    // The upstream view itself is not contained; this is only the mutation fence.
    expect((await fixture.execute("view", fixture.outside)).isError).toBe(false);
    expect(await fixture.execute("str_replace", join(link, "outside.txt"), { old_str: "outside", new_str: "must not edit" })).toMatchObject({
      isError: true, error: { info: { code: "FS_SANDBOX_DENIED" } },
    });
    expect(await readFile(fixture.outside, "utf8")).toBe("outside fixture content\n");
  });

  it("retains the official standing-workspace permission: ask is not a per-edit confirmation gate", async () => {
    const fixture = await setup();
    const requestApproval = vi.spyOn(fixture.ctx.approval, "request");
    const file = join(fixture.workspace, "standing-permission.txt");
    expect((await fixture.execute("create", file, { file_text: "standing permission fixture\n" })).isError).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
    requestApproval.mockRestore();
    expect(await readFile(file, "utf8")).toBe("standing permission fixture\n");
  });

  it("current-gap for workspace-only: the official workspace-write mode also grants platform temporary directories", async () => {
    const fixture = await setup();
    const outsideTemp = await mkdtemp(join(tmpdir(), "dsh-mutation-temp-grant-"));
    try {
      const file = join(outsideTemp, "outside-workspace.txt");
      expect(fixture.ctx.fs.contains(await fixture.ctx.fs.resolve(fixture.workspace), await fixture.ctx.fs.resolve(file))).toBe(false);
      expect((await fixture.execute("create", file, { file_text: "official temporary-root grant\n" })).isError).toBe(false);
      expect(await readFile(file, "utf8")).toBe("official temporary-root grant\n");
    } finally {
      await rm(outsideTemp, { recursive: true, force: true });
    }
  });

  it("cancels before mutation dispatch and removes the tool on owner disposal", async () => {
    const fixture = await setup();
    const file = join(fixture.workspace, "cancelled.txt");
    const controller = new AbortController();
    controller.abort();
    expect((await fixture.execute("create", file, { file_text: "must not create" }, controller.signal)).isError).toBe(true);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await fixture.editor.dispose();
    expect(fixture.ctx.tools.schemas()).toEqual([]);
    expect((await fixture.execute("create", file, { file_text: "must not create" })).isError).toBe(true);
  });
});

async function setup(mode: "read-only" | "workspace-write" = "workspace-write") {
  const fixture = await createMutationFixture(mode);
  fixtures.push(fixture);
  return fixture;
}

function textOf(result: ToolExecutionResult) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
