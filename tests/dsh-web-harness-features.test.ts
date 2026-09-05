import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import type {} from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createFeatureRuntime, FEATURE_ROWS, FEATURES_PATCH, featureRows } from "./fixtures/dsh-web-agent/harness-features/runtime.ts";
import { WEB_CHECKPOINT_INSTRUCTION } from "../packages/dsh-web-agent-bundle/src/web-compaction.ts";

const fixtures: Awaited<ReturnType<typeof createFeatureRuntime>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function setup(body?: string) {
  const fixture = await createFeatureRuntime(body);
  fixtures.push(fixture);
  return fixture;
}
function plain(request: ModelGenerateRequest["params"]) {
  return request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function toolResults(request: ModelGenerateRequest["params"]) {
  return request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result");
}
function final(text: string) {
  return { events: [{ type: "text_delta" as const, text }, { type: "completed" as const, finish_reason: "stop" as const }] };
}
function summaryEvents(events: readonly SessionEvent[]) { return events.filter((event) => event.type === "compaction/summary"); }

describe("opt-in official Harness features over the web-only model", () => {
  it("adds only the fixed official capability composition and leaves existing profiles opt-in", async () => {
    const rows = featureRows();
    expect(rows.map((row) => [row.id, row.name])).toEqual(FEATURE_ROWS);
    expect(rows.find((row) => row.id === "harness-workspace-skills")?.config).toMatchObject({ includeDefaultRoots: false, watch: false });
    expect(rows.find((row) => row.id === "harness-web-compaction")?.config).toEqual({
      auto: true, thresholdRatio: 0.35, retainRatio: 0.08,
      summarizationProvider: "deepseek-web", summarizationModel: "current-web-session", compactionRetries: 0, maxOverflowRetries: 0,
    });
    expect(rows.find((row) => row.id === "harness-tools-policy")?.config).toMatchObject({ maxOutputChars: 16000 });
    const base = loadOverlayPatches("features-base-test", resolve("packages/dsh-web-agent-bundle/cordis.patch.yml"));
    const workspace = loadOverlayPatches("features-workspace-test", resolve("packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml"));
    const combined = composeEntries([base, workspace, loadOverlayPatches("features-opt-in-test", FEATURES_PATCH)]);
    expect(combined.find((row) => row.id === "deepseek-web-workspace-files-policy")?.disabled).toBe(true);
    expect(combined.filter((row) => row.name === "@deepseek-ai/dsh-fs-sandbox")).toHaveLength(1);
    expect(combined.filter((row) => row.name?.startsWith("@deepseek-pp/dsh-llm-"))).toHaveLength(1);
    expect(combined.some((row) => /dsh-llm-(deepseek$|pi-ai)|tool-(bash|pwsh)|telemetry|model-selection-settings/.test(row.name ?? ""))).toBe(false);
    expect(composeEntries([base]).some((row) => row.id === "harness-tools-policy")).toBe(false);
    const manifest = JSON.parse(await readFile(resolve("packages/dsh-web-agent-bundle/package.json"), "utf8"));
    expect(manifest.exports["./cordis.harness-features.patch.yml"]).toBe("./cordis.harness-features.patch.yml");
  });

  it("progressively loads a disk Skill, delegates a foreground child, and resumes the actual persisted session", async () => {
    const nonce = randomBytes(12).toString("hex");
    const fixture = await setup(`Fixture secret: ${nonce}. Pass this identifier to the child for a short confirmation.`);
    const handle = await fixture.create();
    let wireNonce = "";
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(plain(request)).toContain("fixture-guide");
      expect(JSON.stringify(request)).not.toContain(nonce);
      expect(request.tools.map((tool) => tool.name).sort()).toEqual(["skill", "str_replace_editor", "subagent"]);
      return { events: [
        { type: "tool_call", tool_call_id: "features-skill-load", name: "skill", arguments: { name: "fixture-guide" } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    });
    fixture.peer.enqueueGeneration((request) => {
      const [loaded] = toolResults(request);
      expect(loaded?.is_error).toBe(false);
      expect(loaded?.tool_call_id).toBe("features-skill-load");
      const text = loaded!.content.map((block) => block.text).join("");
      wireNonce = /Fixture secret: ([a-f0-9]{24})/.exec(text)?.[1] ?? "";
      expect(wireNonce).toHaveLength(24);
      return { events: [
        { type: "tool_call", tool_call_id: "features-delegate", name: "subagent", arguments: { description: "Confirm fixture identifier", prompt: `Return CHILD_CONFIRMED=${wireNonce}` } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    });
    fixture.peer.enqueueGeneration((request) => {
      // Protocol v1 calls both parent and child inference "agent". The actual
      // official session metadata, not a new purpose label, proves child origin.
      expect(request.purpose).toBe("agent");
      expect(request.session_id).not.toBe(handle.agent.session.id);
      expect(plain(request)).toContain(`CHILD_CONFIRMED=${wireNonce}`);
      expect(request.tools.map((tool) => tool.name).sort()).toEqual(["skill", "str_replace_editor"]);
      expect(toolResults(request)).toEqual([]);
      return final(`CHILD_CONFIRMED=${wireNonce}`);
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(request.session_id).toBe(handle.agent.session.id);
      const results = toolResults(request);
      expect(results).toHaveLength(2);
      expect(results[1]?.is_error).toBe(false);
      expect(JSON.stringify(results[1])).toContain(`CHILD_CONFIRMED=${wireNonce}`);
      const pathJson = /EDIT_TARGET_JSON=("(?:[^"\\]|\\.)*")/.exec(plain(request))?.[1];
      expect(pathJson).toBeDefined();
      return { events: [
        { type: "tool_call", tool_call_id: "features-editor-create", name: "str_replace_editor", arguments: {
          command: "create", path: JSON.parse(pathJson!), file_text: `PARENT_CONFIRMED=${wireNonce}\n`,
        } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    });
    fixture.peer.enqueueGeneration((request) => {
      const results = toolResults(request);
      expect(results).toHaveLength(3);
      expect(results[2]?.tool_call_id).toBe("features-editor-create");
      expect(results[2]?.is_error).toBe(false);
      return final(`PARENT_CONFIRMED=${wireNonce}`);
    });
    const target = join(fixture.workspace, "confirmation.txt");
    await fixture.turn(handle, `Load fixture-guide, delegate its identifier to one child, write its confirmation to this file, then report its answer. ROOT_ONLY_CONTEXT\nEDIT_TARGET_JSON=${JSON.stringify(target)}`);
    expect(wireNonce).toBe(nonce);
    expect(await readFile(target, "utf8")).toBe(`PARENT_CONFIRMED=${nonce}\n`);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(5);
    expect(fixture.ctx.agents.list().map((agent) => agent.session.id)).toEqual([handle.agent.session.id]);
    const child = fixture.createdSessions.find((header) => header.origin === "subagent");
    expect(child).toMatchObject({ parentSession: handle.agent.session.id, cwd: fixture.workspace, delegationDepth: 1 });
    expect(child?.id).toBe(fixture.peer.observedGenerateRequests[2]?.session_id);
    const childDisk = await fixture.ctx.sessionPersistence.readRaw(child!.id);
    expect(childDisk?.content).toContain(`CHILD_CONFIRMED=${nonce}`);
    expect(childDisk?.content).not.toContain("ROOT_ONLY_CONTEXT");
    const id = handle.agent.session.id;
    const parentDisk = await fixture.ctx.sessionPersistence.readRaw(id);
    expect(parentDisk?.content).toContain(`PARENT_CONFIRMED=${nonce}`);
    await fixture.disposeHandle(handle);
    expect(fixture.ctx.sessions.get(id)).toBeUndefined();
    const resumed = await fixture.resume(id);
    fixture.peer.enqueueGeneration((request) => {
      expect(request.session_id).toBe(id);
      expect(JSON.stringify(request)).toContain(`PARENT_CONFIRMED=${nonce}`);
      expect(plain(request)).toContain("Continue the saved task");
      return final("RESUME_CONFIRMED");
    });
    await fixture.turn(resumed, "Continue the saved task and confirm its previous result.");
    expect((await fixture.ctx.sessionPersistence.readRaw(id))?.content).toContain("RESUME_CONFIRMED");
    for (const request of fixture.peer.observedGenerateRequests) {
      expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
    }
    expect(new Set(fixture.peer.observedGenerateRequests.map((request) => request.request_id)).size).toBe(6);
  }, 30_000);

  it("uses the official compaction transaction with one explicit web-purpose request and resumes its checkpoint", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    fixture.peer.enqueueGeneration(final("Detailed completed work. ".repeat(350)));
    await fixture.turn(handle, "Preserve the useful result for later. ".repeat(200));
    const before = [...handle.agent.session.surface.nodes];
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("compaction");
      expect(request.session_id).toBe(handle.agent.session.id);
      expect(plain(request)).toContain(WEB_CHECKPOINT_INSTRUCTION);
      expect(plain(request)).toContain("Preserve the useful result for later.");
      expect(request.options).not.toHaveProperty("maxTokens");
      return final("CHECKPOINT: Work complete. Verify the saved result next.");
    });
    const result = await fixture.ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(10_000)).catch((error: unknown) => { fixture.peer.throwIfFailed(); throw error; });
    expect(result).not.toBeNull();
    const events = handle.agent.session.snapshotEvents();
    const summaries = summaryEvents(events);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.data).toMatchObject({ provider: "deepseek-web", model: "current-web-session", llmStreamCall: true });
    expect(summaries[0]?.data).not.toHaveProperty("maxTokens");
    expect(handle.agent.session.surface.nodes).not.toEqual(before);
    expect(fixture.peer.observedGenerateRequests.map((request) => request.purpose)).toEqual(["agent", "compaction"]);
    const id = handle.agent.session.id;
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(id);
    fixture.peer.enqueueGeneration((request) => {
      expect(plain(request)).toContain("CHECKPOINT: Work complete.");
      expect(plain(request)).not.toContain("Preserve the useful result for later. ".repeat(2));
      return final("CHECKPOINT_RESUME_CONFIRMED");
    });
    await fixture.turn(resumed, "Continue after the checkpoint.");
  }, 30_000);

  it("records a failed compaction without a forged checkpoint or automatic retry", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    fixture.peer.enqueueGeneration(final("Previously finished details. ".repeat(200)));
    await fixture.turn(handle, "Preserve this task. ".repeat(250));
    const before = [...handle.agent.session.surface.nodes];
    fixture.peer.enqueueGeneration({ events: [{ type: "failed", error: { code: "BROWSER_UNAVAILABLE", message: "Fixture browser unavailable", retryable: false, external_outcome: "started" } }] });
    await expect(fixture.ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(10_000))).rejects.toThrow();
    expect(summaryEvents(handle.agent.session.snapshotEvents())).toEqual([]);
    expect(handle.agent.session.surface.nodes).toEqual(before);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(2);
    expect(handle.agent.session.snapshotEvents().filter((event) => event.type === "compaction/end")).toHaveLength(1);
  }, 30_000);

  it.each(["empty", "truncated", "tool-call"] as const)("rejects a %s checkpoint without executing tools or replacing history", async (kind) => {
    const fixture = await setup();
    const handle = await fixture.create();
    fixture.peer.enqueueGeneration(final("Completed context. ".repeat(200)));
    await fixture.turn(handle, "Keep this earlier task context. ".repeat(250));
    const before = [...handle.agent.session.surface.nodes];
    const forbiddenPath = join(fixture.workspace, "checkpoint-must-not-write.txt");
    fixture.peer.enqueueGeneration(kind === "tool-call" ? { events: [
      { type: "tool_call", tool_call_id: "checkpoint-tool-forbidden", name: "str_replace_editor", arguments: { command: "create", path: forbiddenPath, file_text: "must not execute" } },
      { type: "completed", finish_reason: "tool_calls" },
    ] } : kind === "truncated" ? { events: [
      { type: "text_delta", text: "Incomplete checkpoint" }, { type: "completed", finish_reason: "length" },
    ] } : { events: [{ type: "completed", finish_reason: "stop" }] });
    await expect(fixture.ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(10_000))).rejects.toThrow();
    fixture.peer.throwIfFailed();
    expect(summaryEvents(handle.agent.session.snapshotEvents())).toEqual([]);
    expect(handle.agent.session.surface.nodes).toEqual(before);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(2);
    expect(handle.agent.session.snapshotEvents().filter((event) => event.type === "tool/call")).toEqual([]);
    await expect(readFile(forbiddenPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("prunes a real oversized Skill result with the official replay-safe pruner, without a model call", async () => {
    const body = `HEAD_KEEP\n${"Fixture details for progressive loading. ".repeat(400)}\nTAIL_KEEP`;
    const fixture = await setup(body);
    const handle = await fixture.create();
    fixture.peer.enqueueGeneration({ events: [
      { type: "tool_call", tool_call_id: "prune-skill-result", name: "skill", arguments: { name: "fixture-guide" } },
      { type: "completed", finish_reason: "tool_calls" },
    ] });
    fixture.peer.enqueueGeneration((request) => {
      expect(JSON.stringify(toolResults(request))).toContain(body.replaceAll("\n", "\\n"));
      return final("Skill loaded; preserve a bounded result for the next turn.");
    });
    await fixture.turn(handle, "Load fixture-guide now.");
    const before = [...handle.agent.session.surface.nodes];
    const result = fixture.ctx.toolResultPruner.pruneSession(handle.agent.session);
    expect(result.pruned).toHaveLength(1);
    expect(result.charsRemoved).toBeGreaterThan(8_000);
    expect(handle.agent.session.surface.nodes).not.toEqual(before);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(2);
    await fixture.ctx.sessions.flush(handle.agent.session);
    const id = handle.agent.session.id;
    const disk = await fixture.ctx.sessionPersistence.readRaw(id);
    expect(disk?.content).toContain("compaction/prune");
    expect(disk?.content).toContain("Fixture details for progressive loading. ".repeat(100));
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(id);
    fixture.peer.enqueueGeneration((request) => {
      const text = toolResults(request)[0]?.content.map((block) => block.text).join("") ?? "";
      expect(text).toContain("HEAD_KEEP");
      expect(text).toContain("TAIL_KEEP");
      expect(text.length).toBeLessThan(8_192);
      return final("PRUNED_RESULT_RESUME_CONFIRMED");
    });
    await fixture.turn(resumed, "Continue using the bounded tool result.");
  }, 30_000);

  it("keeps model selection and background delegation unavailable at the original tool boundary", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    const tool = fixture.ctx.tools.schemas().find((entry) => entry.name === "subagent")!;
    expect(tool.parameters.properties).not.toHaveProperty("provider");
    expect(tool.parameters.properties).not.toHaveProperty("model");
    expect(tool.parameters.properties).not.toHaveProperty("run_in_background");
    for (const forbidden of [{ provider: "other", model: "other" }, { run_in_background: true }]) {
      const result = await fixture.ctx.tools.execute({
        callId: ToolCallId(`invalid-${randomBytes(5).toString("hex")}`), name: "subagent",
        arguments: { description: "Forbidden selection", prompt: "Never run", ...forbidden },
        agent: handle.agent, signal: AbortSignal.timeout(5_000),
      });
      expect(result.isError).toBe(true);
    }
    expect(fixture.peer.observedGenerateRequests).toEqual([]);
    expect(fixture.createdSessions.filter((header) => header.origin === "subagent")).toEqual([]);
  }, 15_000);
});
