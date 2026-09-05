import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as WorkspaceFiles from "../packages/dsh-web-agent-bundle/src/workspace-files-policy";
import { createMutationFixture } from "./fixtures/dsh-web-agent/mutation/runtime";

const fixtures: Awaited<ReturnType<typeof createMutationFixture>>[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  // Reuse the existing real DSH fixture, including fs-observation-policy and
  // a real Agent. Replace only its direct editor mount with our composition.
  const fixture = await createMutationFixture();
  fixtures.push(fixture);
  const official = fixture.ctx.tools.get("str_replace_editor")!;
  await fixture.editor.dispose();
  const policy = fixture.ctx.plugin(WorkspaceFiles, { workspaceRoot: fixture.workspace, maxOutputChars: 512 });
  await policy;
  return { ...fixture, policy, official };
}

function textOf(result: ToolExecutionResult): string {
  return result.content.flatMap((block) => block.type === "text" ? block.text : []).join("\n");
}

function denied(result: ToolExecutionResult): void {
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("WORKSPACE_FILES_WORKSPACE_ACCESS_DENIED");
  expect(textOf(result)).not.toContain("outside fixture content");
}

describe("workspace-only official file editor composition", () => {
  it("publishes the unchanged official editor only and removes it with the owner", async () => {
    const fixture = await setup();
    expect(fixture.ctx.fs.sandboxMode).toBe("workspace-write");
    expect(fixture.ctx.tools.schemas().map((tool) => tool.name)).toEqual(["str_replace_editor"]);
    expect(fixture.ctx.tools.get("str_replace_editor")?.parameters).toEqual(fixture.official.parameters);
    expect(fixture.ctx.tools.get("str_replace_editor")?.description).toEqual(fixture.official.description);
    for (const name of ["read", "write", "edit", "pwsh", "bash", "web_search", "glob", "grep"]) {
      expect(fixture.ctx.tools.get(name)).toBeUndefined();
      denied(await fixture.ctx.tools.execute({
        callId: ToolCallId(`unknown-${name}`), name,
        arguments: { path: join(fixture.workspace, "never-created.txt"), file_text: "forbidden" },
        agent: fixture.agent, signal: new AbortController().signal,
      }));
    }
    await fixture.policy.dispose();
    expect(fixture.ctx.tools.schemas()).toEqual([]);
    expect((await fixture.execute("create", join(fixture.workspace, "never-created.txt"), { file_text: "no" })).isError).toBe(true);
    await expect(readFile(join(fixture.workspace, "never-created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports official create, file view, str_replace and insert through the real registry", async () => {
    const fixture = await setup();
    const path = join(fixture.workspace, "note.txt");
    expect((await fixture.execute("create", path, { file_text: "first line\nlast line\n" })).isError).toBe(false);
    const viewed = await fixture.execute("view", path, { view_range: [1, 1] });
    expect(viewed.isError).toBe(false);
    expect(textOf(viewed)).toContain("first line");
    expect((await fixture.execute("str_replace", path, { old_str: "first line", new_str: "changed line" })).isError).toBe(false);
    expect((await fixture.execute("insert", path, { insert_line: 1, new_str: "inserted line" })).isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("changed line\ninserted line\nlast line\n");
  });

  it("keeps the official read-before-edit and stale-version guards", async () => {
    const fixture = await setup();
    const path = join(fixture.workspace, "existing.txt");
    await writeFile(path, "original text\n", "utf8");
    const unread = await fixture.execute("str_replace", path, { old_str: "original", new_str: "modified" });
    expect(unread).toMatchObject({ isError: true, error: { info: { code: "FS_NOT_OBSERVED" } } });
    expect((await fixture.execute("view", path)).isError).toBe(false);
    await writeFile(path, "externally changed text\n", "utf8");
    const stale = await fixture.execute("str_replace", path, { old_str: "changed", new_str: "modified" });
    expect(stale).toMatchObject({ isError: true, error: { info: { code: "FS_STALE_VERSION" } } });
    expect(await readFile(path, "utf8")).toBe("externally changed text\n");
  });

  it("rejects outside paths and static junction escapes for every command", async () => {
    const fixture = await setup();
    const link = join(fixture.workspace, "outside-junction");
    await symlink(fixture.outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    const paths = [fixture.outside, join(link, "outside.txt"), join(fixture.workspace, "..", "outside", "outside.txt")];
    if (process.platform === "win32") paths.push(fixture.outside.toUpperCase(), fixture.outside.replaceAll("\\", "/"));
    for (const path of paths) {
      denied(await fixture.execute("view", path));
      denied(await fixture.execute("create", path + ".new", { file_text: "must not create" }));
      denied(await fixture.execute("str_replace", path, { old_str: "outside", new_str: "changed" }));
      denied(await fixture.execute("insert", path, { insert_line: 0, new_str: "must not insert" }));
      await expect(readFile(path + ".new")).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(fixture.outside, "utf8")).toBe("outside fixture content\n");
  });

  it("does not inherit the upstream workspace-write allowance for unrelated TEMP files", async () => {
    const fixture = await setup();
    const temp = await mkdtemp(join(tmpdir(), "dsh-workspace-only-denied-"));
    temporaryRoots.push(temp);
    const path = join(temp, "not-in-workspace.txt");
    denied(await fixture.execute("create", path, { file_text: "must not create" }));
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses directory views so the official recursive viewer cannot follow child junctions", async () => {
    const fixture = await setup();
    await symlink(fixture.outsideDir, join(fixture.workspace, "outside-junction"), process.platform === "win32" ? "junction" : "dir");
    denied(await fixture.execute("view", fixture.workspace));
    denied(await fixture.execute("view", join(fixture.workspace, "outside-junction")));
  });

  it.each(["sandbox_permissions", "justification", "env", "cwd", "workdir", "run_in_background"])(
    "rejects unadvertised model field %s before any mutation", async (field) => {
      const fixture = await setup();
      const path = join(fixture.workspace, "blocked-field.txt");
      denied(await fixture.execute("create", path, { file_text: "no", [field]: "danger-full-access" }));
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects relative editor paths, malformed arguments and unknown editor commands", async () => {
    const fixture = await setup();
    const path = join(fixture.workspace, "blocked.txt");
    denied(await fixture.execute("create", "blocked.txt", { file_text: "no" }));
    for (const args of [null, [], { command: "undo_edit", path }, { command: "create", path: 12, file_text: "no" }]) {
      denied(await fixture.ctx.tools.execute({
        callId: ToolCallId("invalid-editor"), name: "str_replace_editor", arguments: args,
        agent: fixture.agent, signal: new AbortController().signal,
      }));
    }
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies a short-circuiting pre-execute allow that skipped admission", async () => {
    const fixture = await setup();
    fixture.ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), { prepend: true });
    const path = join(fixture.workspace, "skipped-admission.txt");
    denied(await fixture.execute("create", path, { file_text: "no" }));
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates admission if a later listener replaces the checked arguments", async () => {
    const fixture = await setup();
    fixture.ctx.on("tools/pre-execute", async (exec, next) => {
      (exec as { arguments: unknown }).arguments = { command: "create", path: fixture.outside + ".new", file_text: "no" };
      return next();
    });
    denied(await fixture.execute("create", join(fixture.workspace, "safe.txt"), { file_text: "no" }));
    await expect(readFile(fixture.outside + ".new")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["cancel", "dispose"])("fails a pending admission closed on %s", async (action) => {
    const fixture = await setup();
    const path = join(fixture.workspace, "pending.txt");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resolve = fixture.ctx.fs.resolve.bind(fixture.ctx.fs);
    vi.spyOn(fixture.ctx.fs, "resolve").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return resolve(...args);
    });
    const controller = new AbortController();
    const pending = fixture.execute("create", path, { file_text: "no" }, controller.signal);
    await entered.promise;
    if (action === "dispose") await fixture.policy.dispose();
    else controller.abort();
    release.resolve();
    expect((await pending).isError).toBe(true);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a trusted absolute root, an empty registry and workspace-write mode", async () => {
    const fixture = await setup();
    await expect(WorkspaceFiles.apply(fixture.ctx, { workspaceRoot: fixture.workspace }))
      .rejects.toThrow("WORKSPACE_FILES_EMPTY_REGISTRY_REQUIRED");
    await fixture.policy.dispose();
    await expect(WorkspaceFiles.apply(fixture.ctx, { workspaceRoot: "relative" }))
      .rejects.toThrow("WORKSPACE_FILES_WORKSPACE_REQUIRED");
    await expect(WorkspaceFiles.apply(fixture.ctx, { workspaceRoot: join(fixture.workspace, "missing-root") }))
      .rejects.toThrow("WORKSPACE_FILES_WORKSPACE_REQUIRED");
    const readonly = await createMutationFixture("read-only");
    fixtures.push(readonly);
    await readonly.editor.dispose();
    await expect(WorkspaceFiles.apply(readonly.ctx, { workspaceRoot: readonly.workspace }))
      .rejects.toThrow("WORKSPACE_FILES_FILESYSTEM_REQUIRED");
  });
});
