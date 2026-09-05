import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as HarnessTools from "../packages/dsh-web-agent-bundle/src/harness-tools-policy.ts";
import { createMutationFixture } from "./fixtures/dsh-web-agent/mutation/runtime.ts";

const fixtures: Awaited<ReturnType<typeof createMutationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function setup() {
  const fixture = await createMutationFixture();
  fixtures.push(fixture);
  await fixture.editor.dispose();
  await fixture.ctx.plugin(SkillRegistry);
  await fixture.ctx.plugin(SubagentRuntime);
  await fixture.ctx.plugin(SpawnInProcess, { providerName: "spawn" });
  fixture.ctx.skills.register({
    name: "fixture-guide", description: "Explain the owned fixture.",
    content: "Use only the owned fixture.", source: "runtime",
  });
  const policy = fixture.ctx.plugin(HarnessTools, { workspaceRoot: fixture.workspace, maxOutputChars: 512 });
  await policy;
  let call = 0;
  return {
    ...fixture, policy,
    call: (name: string, args: unknown, signal = new AbortController().signal) => fixture.ctx.tools.execute({
      callId: ToolCallId(`harness-policy-${++call}`), name, arguments: args, agent: fixture.agent, signal,
    }),
  };
}

function textOf(result: ToolExecutionResult): string {
  return result.content.flatMap((block) => block.type === "text" ? block.text : []).join("\n");
}
function denied(result: ToolExecutionResult) {
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("WORKSPACE_FILES_WORKSPACE_ACCESS_DENIED");
}

describe("opt-in official Harness tool identity admission", () => {
  it("publishes only the official editor, skill and foreground fixed-route subagent schemas", async () => {
    const fixture = await setup();
    expect(fixture.ctx.tools.schemas().map((tool) => tool.name)).toEqual(["str_replace_editor", "skill", "subagent"]);
    expect(Object.keys(fixture.ctx.tools.get("skill")!.parameters.properties ?? {})).toEqual(["name"]);
    expect(Object.keys(fixture.ctx.tools.get("subagent")!.parameters.properties ?? {}).sort()).toEqual(["description", "prompt"]);
    for (const name of ["read", "write", "pwsh", "bash", "list_models", "job_output", "run_code"]) {
      denied(await fixture.call(name, {}));
    }
    await fixture.policy.dispose();
    expect(fixture.ctx.tools.schemas()).toEqual([]);
  });

  it("executes the original skill loader alongside the original guarded editor", async () => {
    const fixture = await setup();
    const skill = await fixture.call("skill", { name: "fixture-guide" });
    expect(skill.isError, textOf(skill)).toBe(false);
    expect(skill.value).toMatchObject({ name: "fixture-guide", content: "Use only the owned fixture." });
    const path = join(fixture.workspace, "skill-result.txt");
    expect((await fixture.execute("create", path, { file_text: "created by the original editor\n" })).isError).toBe(false);
    expect((await fixture.execute("view", path)).isError).toBe(false);
    expect((await fixture.execute("str_replace", path, { old_str: "original", new_str: "official" })).isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("created by the official editor\n");
    denied(await fixture.execute("view", fixture.outside));
  });

  it("passes child requests to the official validation, without enabling background or model selection", async () => {
    const fixture = await setup();
    for (const fields of [{ run_in_background: true }, { provider: "other", model: "other" }]) {
      const result = await fixture.call("subagent", { description: "A bounded fixture task", prompt: "Do not run.", ...fields });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain("WORKSPACE_FILES_WORKSPACE_ACCESS_DENIED");
    }
    expect(fixture.ctx.agents).toBeDefined();
  });

  it.each(["str_replace_editor", "skill", "subagent"])("rejects an agent-scoped same-name %s replacement", async (name) => {
    const fixture = await setup();
    const original = fixture.ctx.tools.get(name)!;
    const replacement = vi.fn(async () => { throw new Error("replacement must not run"); });
    fixture.agent.ctx.tools.register({ ...original, execute: replacement });
    denied(await fixture.call(name, name === "skill" ? { name: "fixture-guide" } : {
      command: "create", path: join(fixture.workspace, "never-created.txt"), file_text: "no",
      description: "A bounded fixture task", prompt: "No call.",
    }));
    expect(replacement).not.toHaveBeenCalled();
  });

  it("does not admit a copied official definition under a new name", async () => {
    const fixture = await setup();
    fixture.ctx.tools.register({ ...fixture.ctx.tools.get("skill")!, name: "renamed_skill" });
    denied(await fixture.call("renamed_skill", { name: "fixture-guide" }));
  });

  it("requires one-shot admission even when a prepended listener short-circuits with allow", async () => {
    const fixture = await setup();
    fixture.ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), { prepend: true });
    denied(await fixture.call("skill", { name: "fixture-guide" }));
  });

  it("rechecks the resolved tool identity after later pre-execute listeners", async () => {
    const fixture = await setup();
    const original = fixture.ctx.tools.get("skill")!;
    const replacement = vi.fn(async () => { throw new Error("replacement must not run"); });
    fixture.ctx.on("tools/pre-execute", async (_exec, next) => {
      fixture.agent.ctx.tools.register({ ...original, execute: replacement });
      return next();
    });
    denied(await fixture.call("skill", { name: "fixture-guide" }));
    expect(replacement).not.toHaveBeenCalled();
  });

  it("binds extra-tool admission to the exact frozen arguments", async () => {
    const fixture = await setup();
    fixture.ctx.on("tools/pre-execute", async (exec, next) => {
      (exec as { arguments: unknown }).arguments = { name: "fixture-guide" };
      return next();
    });
    denied(await fixture.call("skill", { name: "fixture-guide" }));
  });

  it.each(["cancel", "dispose"])("does not let pending extra-tool admission outlive %s", async (action) => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.ctx.on("tools/pre-execute", async (_exec, next) => {
      entered.resolve();
      await release.promise;
      return next();
    });
    const abort = new AbortController();
    const pending = fixture.call("skill", { name: "fixture-guide" }, abort.signal);
    await entered.promise;
    if (action === "cancel") abort.abort();
    else await fixture.policy.dispose();
    release.resolve();
    expect((await pending).isError).toBe(true);
  });
});
