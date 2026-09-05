import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-token-meter";
import {
  DEEPSEEK_WEB_CONTEXT_WINDOW,
  serializeGenerateRequest,
} from "@deepseek-pp/dsh-llm-deepseek-web";
import {
  MAX_FRAME_BYTES,
  MAX_MESSAGES,
  encodeWebModelFrame,
  type ModelGenerateRequest,
} from "@deepseek-pp/web-model-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createFeatureRuntime } from "./fixtures/dsh-web-agent/harness-features/runtime.ts";

const fixtures: Awaited<ReturnType<typeof createFeatureRuntime>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function setup() {
  const fixture = await createFeatureRuntime();
  fixtures.push(fixture);
  return fixture;
}
function final(text: string) {
  return { events: [{ type: "text_delta" as const, text }, { type: "completed" as const, finish_reason: "stop" as const }] };
}
function frame(params: Omit<ModelGenerateRequest["params"], "schema_version">): ModelGenerateRequest {
  return { jsonrpc: "2.0", id: "context-budget-probe", method: "model.generate", params: { schema_version: 1, ...params } };
}
function prospectiveRequest(session: Session, text: string) {
  const header = session.requestHeader();
  if (header === undefined) throw new Error("A real routed request header is required.");
  return serializeGenerateRequest({
    ...header.config,
    ...(header.system === undefined ? {} : { system: header.system }),
    ...(header.tools === undefined ? {} : { tools: [...header.tools] }),
    sessionId: session.id,
    messages: [...session.deriveMessages(), createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })],
  }, { requestId: "context-budget-probe" });
}
function summaries(session: Session) { return session.snapshotEvents().filter((event) => event.type === "compaction/summary"); }
function allWebRequests(fixture: Awaited<ReturnType<typeof setup>>) {
  for (const request of fixture.peer.observedGenerateRequests) {
    expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
    expect(request.input.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(Buffer.byteLength(encodeWebModelFrame(frame(request)), "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  }
}
async function shortHistory(fixture: Awaited<ReturnType<typeof setup>>, handle: AgentHandle, turns: number) {
  for (let index = 0; index < turns; index++) {
    fixture.peer.enqueueGeneration(final(`Completed bounded item ${index}.`));
    await fixture.turn(handle, `Keep fixture goal and item ${index}; no tools.`);
  }
}

describe("web context hard limits over the official Harness composition", () => {
  it("keeps the exact 128-message and 1 MiB codec boundaries without increasing either budget", () => {
    const message = createUserMessage({ content: [{ type: "text", text: "x" }], source: { kind: "user" } });
    const options = { provider: "deepseek-web", model: "current-web-session", sessionId: SessionId("budget"), messages: Array.from({ length: MAX_MESSAGES }, () => message) };
    expect(() => encodeWebModelFrame(frame(serializeGenerateRequest(options)))).not.toThrow();
    expect(() => encodeWebModelFrame(frame(serializeGenerateRequest({ ...options, messages: [...options.messages, message] })))).toThrow();

    const request = frame(serializeGenerateRequest({ ...options, messages: [createUserMessage({
      content: Array.from({ length: 4 }, () => ({ type: "text" as const, text: "x".repeat(250_000) })), source: { kind: "user" },
    })] }));
    // Five blocks keep every individual text below its unchanged character cap.
    const block = { type: "text" as const, text: "x" };
    request.params.input.messages[0]!.content.push(block);
    const difference = MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8");
    block.text += "x".repeat(difference);
    expect(Buffer.byteLength(encodeWebModelFrame(request), "utf8")).toBe(MAX_FRAME_BYTES);
    block.text += "x";
    expect(() => encodeWebModelFrame(request)).toThrowError(/FRAME_TOO_LARGE/);
  });

  it("automatically compacts token-priced history on the same web route before normal wire exhaustion", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    for (let index = 0; index < 4; index++) {
      fixture.peer.enqueueGeneration(final(`Finished large fixture item ${index}.`));
      await fixture.turn(handle, `Fixture goal: preserve result ${index}. ` + "a".repeat(45_000));
    }
    expect(fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens).toBeGreaterThanOrEqual(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("compaction");
      expect(request.session_id).toBe(handle.agent.session.id);
      return final("Fixture goal: preserve completed results 0, 1 and 2; finish result 3 next.");
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(JSON.stringify(request)).toContain("preserve completed results 0, 1 and 2");
      return final("All fixture results preserved.");
    });
    await fixture.turn(handle, "Continue the bounded fixture goal.");
    expect(summaries(handle.agent.session)).toHaveLength(1);
    expect(fixture.peer.observedGenerateRequests.map((request) => request.purpose)).toEqual(["agent", "agent", "agent", "agent", "compaction", "agent"]);
    allWebRequests(fixture);
  }, 30_000);

  it("current-gap: many short turns reach the message cap below automatic token pressure, without losing or replaying history", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    await shortHistory(fixture, handle, 64);
    const next = prospectiveRequest(handle.agent.session, "Boundary turn must remain in the durable log.");
    expect(next.input.messages.length).toBeGreaterThan(MAX_MESSAGES);
    expect(fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens).toBeLessThan(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    const before = [...handle.agent.session.surface.nodes];
    await expect(fixture.turn(handle, "Boundary turn must remain in the durable log.")).rejects.toThrow();
    expect(fixture.peer.observedGenerateRequests).toHaveLength(64);
    expect(fixture.peer.cancelRequestCount).toBe(0);
    expect(summaries(handle.agent.session)).toEqual([]);
    expect(handle.agent.session.surface.nodes.slice(0, before.length)).toEqual(before);
    const events = handle.agent.session.snapshotEvents();
    expect(events.at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "error" } } });
    // Waiting until *after* overflow is not a reliable recovery: the official
    // maximal summary input can itself exceed the same unchanged message cap.
    const afterFailure = [...handle.agent.session.surface.nodes];
    await expect(fixture.ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(10_000))).rejects.toThrow();
    expect(handle.agent.session.surface.nodes).toEqual(afterFailure);
    expect(summaries(handle.agent.session)).toEqual([]);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(64);
    expect(handle.agent.session.snapshotEvents().filter((event) => event.type === "compaction/end")).toHaveLength(1);
    const id = handle.agent.session.id;
    expect((await fixture.ctx.sessionPersistence.readRaw(id))?.content).toContain("Boundary turn must remain in the durable log.");
    const beforeResume = handle.agent.session.deriveMessages();
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(id);
    expect(resumed.agent.session.deriveMessages()).toEqual(beforeResume);
    allWebRequests(fixture);
  }, 30_000);

  it("can explicitly checkpoint short history before the message cap and resume using that real durable checkpoint", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    await shortHistory(fixture, handle, 60);
    expect(fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens).toBeLessThan(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("compaction");
      return final("Fixture goal preserved: bounded items 0 through 59 completed; continue at item 60.");
    });
    const result = await fixture.ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(10_000));
    expect(result).not.toBeNull();
    const id = handle.agent.session.id;
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(id);
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(JSON.stringify(request)).toContain("items 0 through 59 completed");
      expect(request.input.messages.length).toBeLessThan(10);
      return final("Resumed at item 60.");
    });
    await fixture.turn(resumed, "Continue the saved fixture.");
    expect(summaries(resumed.agent.session)).toHaveLength(1);
    allWebRequests(fixture);
  }, 30_000);

  it("current-gap: a newly admitted escaped input exceeds the frame cap after the automatic check priced only earlier history", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    for (let index = 0; index < 5; index++) {
      fixture.peer.enqueueGeneration(final(`Recorded escaped fixture ${index}.`));
      await fixture.turn(handle, `Escaped fixture ${index}:` + "\u0001".repeat(29_000));
    }
    const nextText = "Escaped boundary fixture:" + "\u0001".repeat(29_000);
    const next = prospectiveRequest(handle.agent.session, nextText);
    expect(next.input.messages.length).toBeLessThan(MAX_MESSAGES);
    expect(Buffer.byteLength(JSON.stringify(frame(next)), "utf8")).toBeGreaterThan(MAX_FRAME_BYTES);
    // The official pre-step hook prices durable history before this input is
    // appended. Its newly crossed token threshold therefore cannot prevent
    // this first oversized frame; this is not a claim that CJK always overflows.
    expect(fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens).toBeLessThan(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    const price = fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens + fixture.ctx.tokenMeter.estimateMessage(createUserMessage({ content: [{ type: "text", text: nextText }], source: { kind: "user" } }));
    expect(price).toBeGreaterThanOrEqual(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    const before = [...handle.agent.session.surface.nodes];
    await expect(fixture.turn(handle, nextText)).rejects.toThrow();
    expect(fixture.peer.observedGenerateRequests).toHaveLength(5);
    expect(fixture.peer.cancelRequestCount).toBe(0);
    expect(summaries(handle.agent.session)).toEqual([]);
    expect(handle.agent.session.surface.nodes.slice(0, before.length)).toEqual(before);
    expect(handle.agent.session.snapshotEvents().at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "error" } } });
    allWebRequests(fixture);
  }, 30_000);
});
