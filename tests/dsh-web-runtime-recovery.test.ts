import fs from "node:fs";
import { join } from "node:path";
import type {} from "@deepseek-ai/dsh-token-meter";
import { DEEPSEEK_WEB_CONTEXT_WINDOW } from "@deepseek-pp/dsh-llm-deepseek-web";
import { afterEach, describe, expect, it } from "vitest";
import { createFeatureRuntime } from "./fixtures/dsh-web-agent/harness-features/runtime.ts";

const fixtures: Awaited<ReturnType<typeof createFeatureRuntime>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function setup() {
  const fixture = await createFeatureRuntime(undefined, { persistentJournal: true });
  fixtures.push(fixture);
  return fixture;
}
function final(text: string) {
  return { events: [{ type: "text_delta" as const, text }, { type: "completed" as const, finish_reason: "stop" as const }] };
}
function journal(fixture: Awaited<ReturnType<typeof setup>>) {
  return JSON.parse(fs.readFileSync(join(fixture.root, "journal", "journal.json"), "utf8"));
}

describe("real Harness compaction and child turns with interrupted web transport", () => {
  it("fails an actual automatic compaction on socket drop without a checkpoint or request replay, and resumes original durable history", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    for (let index = 0; index < 4; index++) {
      fixture.peer.enqueueGeneration(final(`Durable result ${index}.`));
      await fixture.turn(handle, `Preserve work ${index}. ` + "a".repeat(45_000));
    }
    const session = handle.agent.session;
    const original = [...session.surface.nodes];
    expect(fixture.ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    fixture.peer.enqueueGeneration(request => {
      expect(request.purpose).toBe("compaction");
      expect(request.session_id).toBe(session.id);
      return { disconnectAfterAccepted: true };
    });
    await expect(fixture.turn(handle, "Continue after preserving the existing work.")).rejects.toThrow();
    const events = session.snapshotEvents();
    expect(events.filter(event => event.type === "compaction/start")).toHaveLength(1);
    expect(events.filter(event => event.type === "compaction/end")).toHaveLength(1);
    expect(events.filter(event => event.type === "compaction/summary")).toEqual([]);
    expect(session.surface.replaceGeneration).toBe(0);
    expect(original.every(seq => session.surface.nodes.includes(seq))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "error" } } });
    const requests = fixture.peer.observedGenerateRequests;
    expect(requests.map(request => request.purpose)).toEqual(["agent", "agent", "agent", "agent", "compaction"]);
    expect(new Set(requests.map(request => request.request_id)).size).toBe(5);
    expect(journal(fixture).records.at(-1)).toMatchObject({ requestId: requests[4]!.request_id, state: "ambiguous" });
    const raw = (await fixture.ctx.sessionPersistence.readRaw(session.id))!.content;
    for (let index = 0; index < 4; index++) expect(raw).toContain(`Durable result ${index}.`);
    expect(raw).not.toContain('"type":"compaction/summary"');
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(session.id);
    expect(resumed.agent.session.id).toBe(session.id);
    expect(resumed.agent.session.surface.replaceGeneration).toBe(0);
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === "compaction/summary")).toEqual([]);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(5);
  }, 20_000);

  it("persists independent real parent and child sessions after child disconnect, without replaying delegation or inventing completion", async () => {
    const fixture = await setup();
    const parent = await fixture.create();
    fixture.peer.enqueueGeneration({ events: [
      { type: "tool_call", tool_call_id: "recovery-child", name: "subagent", arguments: {
        description: "Inspect isolated child context", prompt: "Explain the child task without using tools. CHILD_ONLY_RECOVERY_CONTEXT",
      } },
      { type: "completed", finish_reason: "tool_calls" },
    ] });
    fixture.peer.enqueueGeneration(request => {
      expect(request.session_id).not.toBe(parent.agent.session.id);
      expect(request.tools.map(tool => tool.name).sort()).toEqual(["skill", "str_replace_editor"]);
      return { disconnectAfterAccepted: true };
    });
    await expect(fixture.turn(parent, "Delegate once; report only a confirmed result. ROOT_ONLY_RECOVERY_CONTEXT")).rejects.toThrow();
    const requests = fixture.peer.observedGenerateRequests;
    expect(requests).toHaveLength(2);
    const childHeader = fixture.createdSessions.find(header => header.origin === "subagent");
    expect(childHeader).toMatchObject({ id: requests[1]!.session_id, parentSession: parent.agent.session.id, delegationDepth: 1 });
    expect(childHeader!.id).not.toBe(parent.agent.session.id);
    const parentEvents = parent.agent.session.snapshotEvents();
    expect(parentEvents.filter(event => event.type === "tool/call")).toHaveLength(1);
    expect(parentEvents.at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "error" } } });
    const childRaw = (await fixture.ctx.sessionPersistence.readRaw(childHeader!.id))!.content;
    const parentRaw = (await fixture.ctx.sessionPersistence.readRaw(parent.agent.session.id))!.content;
    expect(childRaw).toContain("CHILD_ONLY_RECOVERY_CONTEXT");
    expect(childRaw).not.toContain("ROOT_ONLY_RECOVERY_CONTEXT");
    expect(parentRaw).toContain("ROOT_ONLY_RECOVERY_CONTEXT");
    expect(journal(fixture).records.at(-1)).toMatchObject({ requestId: requests[1]!.request_id, sessionId: childHeader!.id, state: "ambiguous" });
    const restoredChild = await fixture.resume(childHeader!.id);
    const childEvents = restoredChild.agent.session.snapshotEvents();
    expect(childEvents.filter(event => event.type === "tool/call")).toEqual([]);
    expect(childEvents.filter(event => event.type === "assistant/message")).toEqual([]);
    const childTurns = childEvents.filter(event => event.type === "turn/end");
    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]).toMatchObject({ data: { reason: { kind: "error" } } });
    const parentId = parent.agent.session.id;
    await fixture.disposeHandle(parent);
    const restoredParent = await fixture.resume(parentId);
    expect(restoredParent.agent.session.snapshotEvents().filter(event => event.type === "tool/call")).toHaveLength(1);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(2);
  }, 20_000);

  it.each(["before", "after"] as const)("does not replay an official editor write when the socket drops %s tool execution", async boundary => {
    const fixture = await setup();
    const handle = await fixture.create();
    const target = join(fixture.workspace, "created-once.txt");
    const content = "ONE_CONFIRMED_EDITOR_WRITE\n";
    const callId = "recovery-editor-create";
    fixture.peer.enqueueGeneration({
      events: [
        { type: "tool_call", tool_call_id: callId, name: "str_replace_editor", arguments: { command: "create", path: target, file_text: content } },
        { type: "completed", finish_reason: "tool_calls" },
      ],
      ...(boundary === "before" ? { disconnectAfterEvent: 1 } : {}),
    });
    if (boundary === "after") fixture.peer.enqueueGeneration(request => {
      // Only the real official editor can supply this result and these bytes.
      const results = request.input.messages.flatMap(message => message.content).filter(block => block.type === "tool_result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ tool_call_id: callId, is_error: false });
      expect(fs.readFileSync(target, "utf8")).toBe(content);
      return { disconnectAfterAccepted: true };
    });
    await expect(fixture.turn(handle, `Create this file exactly once with the editor, then report the confirmed result: ${target}`)).rejects.toThrow();
    const sessionId = handle.agent.session.id;
    const before = handle.agent.session.snapshotEvents();
    const count = boundary === "before" ? 0 : 1;
    expect(before.filter(event => event.type === "tool/call")).toHaveLength(count);
    expect(before.filter(event => event.type === "tool/result")).toHaveLength(count);
    expect(before.filter(event => event.type === "turn/end")).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: expect.objectContaining({ kind: "error" }) }) })]);
    const requests = fixture.peer.observedGenerateRequests;
    expect(requests).toHaveLength(count + 1);
    expect(journal(fixture).records.at(-1)).toMatchObject({ state: "ambiguous", requestId: requests.at(-1)!.request_id });
    const originalStat = boundary === "after" ? fs.statSync(target, { bigint: true }) : undefined;
    if (boundary === "before") expect(fs.existsSync(target)).toBe(false);
    else expect(fs.readFileSync(target, "utf8")).toBe(content);
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(sessionId);
    const restored = resumed.agent.session.snapshotEvents();
    expect(restored.filter(event => event.type === "tool/call")).toHaveLength(count);
    expect(restored.filter(event => event.type === "tool/result")).toHaveLength(count);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(count + 1);
    if (boundary === "before") expect(fs.existsSync(target)).toBe(false);
    else {
      expect(fs.readFileSync(target, "utf8")).toBe(content);
      const unchanged = fs.statSync(target, { bigint: true });
      expect(unchanged.ino).toBe(originalStat!.ino);
      expect(unchanged.mtimeNs).toBe(originalStat!.mtimeNs);
      expect(unchanged.ctimeNs).toBe(originalStat!.ctimeNs);
    }
  }, 20_000);
});
