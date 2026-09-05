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
import { WEB_CHECKPOINT_INSTRUCTION } from "../packages/dsh-web-agent-bundle/src/web-compaction.ts";

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
function text(request: ModelGenerateRequest["params"]) {
  return request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function summaryEnvelope(request: ModelGenerateRequest["params"], session: Session) {
  expect(request.purpose).toBe("compaction");
  expect(request.session_id).toBe(session.id);
  expect(request.input.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: WEB_CHECKPOINT_INSTRUCTION }] });
  const header = session.requestHeader()!;
  if (header.system !== undefined) {
    expect(request.input.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: header.system }] });
  }
  expect(request.tools).toEqual(prospectiveRequest(session, "envelope comparison").tools);
  expect(request.tools.map((tool) => tool.name).sort()).toEqual(["skill", "str_replace_editor", "subagent"]);
  expect(request.options).not.toHaveProperty("maxTokens");
}
async function durableCheckpoint(fixture: Awaited<ReturnType<typeof setup>>, handle: AgentHandle, checkpoint: string) {
  const session = handle.agent.session;
  const [summary] = summaries(session);
  expect(summaries(session)).toHaveLength(1);
  expect(summary?.data).toMatchObject({ provider: "deepseek-web", model: "current-web-session", llmStreamCall: true });
  expect(summary?.data.shadowedSeqs.length).toBeGreaterThan(0);
  expect(summary?.data).not.toHaveProperty("maxTokens");
  await fixture.ctx.sessions.flush(session);
  const raw = (await fixture.ctx.sessionPersistence.readRaw(session.id))?.content;
  expect(raw).toContain("compaction/summary");
  expect(raw).toContain(checkpoint);
  expect(session.snapshotEvents().at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "completed" } } });
}
function allWebRequests(fixture: Awaited<ReturnType<typeof setup>>) {
  const requests = fixture.peer.observedGenerateRequests;
  expect(new Set(requests.map((request) => request.request_id)).size).toBe(requests.length);
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

  it("recovers the short-history message cap with a bounded summary and a real persisted continuation", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    await shortHistory(fixture, handle, 64);
    const next = prospectiveRequest(handle.agent.session, "Boundary turn must remain in the durable log.");
    expect(next.input.messages.length).toBeGreaterThan(MAX_MESSAGES);
    expect(fixture.ctx.tokenMeter.measure(handle.agent.session).totalTokens).toBeLessThan(DEEPSEEK_WEB_CONTEXT_WINDOW * 0.35);
    const before = [...handle.agent.session.surface.nodes];
    const checkpoint = "SHORT_HISTORY_CHECKPOINT: items 0 through 62 complete; continue the boundary task.";
    fixture.peer.enqueueGeneration((request) => {
      summaryEnvelope(request, handle.agent.session);
      // The unbounded prefix plus system and final instruction would be 130
      // messages. The official selector must shorten its balanced prefix.
      expect(request.input.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
      expect(request.input.messages.length).toBeGreaterThanOrEqual(MAX_MESSAGES - 2);
      expect(text(request)).toContain("bounded item 0");
      return final(checkpoint);
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(text(request)).toContain(checkpoint);
      expect(text(request)).toContain("Boundary turn must remain in the durable log.");
      expect(request.input.messages.length).toBeLessThan(12);
      return final("SHORT_HISTORY_CONTINUED");
    });
    await fixture.turn(handle, "Boundary turn must remain in the durable log.");
    expect(fixture.peer.observedGenerateRequests).toHaveLength(66);
    expect(fixture.peer.observedGenerateRequests.slice(64).map((request) => request.purpose)).toEqual(["compaction", "agent"]);
    expect(fixture.peer.cancelRequestCount).toBe(0);
    const summary = summaries(handle.agent.session)[0]!;
    expect(summary.data.shadowedSeqs).toEqual(before.slice(0, summary.data.shadowedSeqs.length));
    expect(summary.data.shadowedSeqs.length).toBeLessThan(before.length);
    await durableCheckpoint(fixture, handle, checkpoint);
    const id = handle.agent.session.id;
    expect((await fixture.ctx.sessionPersistence.readRaw(id))?.content).toContain("Boundary turn must remain in the durable log.");
    const beforeResume = handle.agent.session.deriveMessages();
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(id);
    expect(resumed.agent.session.deriveMessages()).toEqual(beforeResume);
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(text(request)).toContain(checkpoint);
      expect(text(request)).toContain("SHORT_HISTORY_CONTINUED");
      return final("RESUMED_SHORT_CHECKPOINT");
    });
    await fixture.turn(resumed, "Continue after reloading the durable checkpoint.");
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

  it("recovers a newly admitted escaped frame overflow before sending the original oversized request", async () => {
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
    const checkpoint = "ESCAPED_HISTORY_CHECKPOINT: preserve the five completed fixture results; continue the boundary input.";
    fixture.peer.enqueueGeneration((request) => {
      summaryEnvelope(request, handle.agent.session);
      expect(Buffer.byteLength(JSON.stringify(frame(request)), "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      return final(checkpoint);
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(text(request)).toContain(checkpoint);
      expect(text(request)).toContain(nextText);
      return final("ESCAPED_BOUNDARY_CONTINUED");
    });
    await fixture.turn(handle, nextText);
    expect(fixture.peer.observedGenerateRequests.slice(5).map((request) => request.purpose)).toEqual(["compaction", "agent"]);
    expect(fixture.peer.cancelRequestCount).toBe(0);
    expect(summaries(handle.agent.session)[0]?.data.shadowedSeqs).toEqual(before);
    await durableCheckpoint(fixture, handle, checkpoint);
    allWebRequests(fixture);
  }, 30_000);

  it("keeps the latest real tool call/result pair outside the budget-selected summary and continues with its result", async () => {
    const fixture = await setup();
    const handle = await fixture.create();
    await shortHistory(fixture, handle, 63);
    const callId = "budget-latest-skill";
    const checkpoint = "LATEST_TOOL_CHECKPOINT: completed the earlier fixture items; use the newly loaded guide.";
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(request.input.messages.length).toBe(MAX_MESSAGES);
      return { events: [
        { type: "tool_call", tool_call_id: callId, name: "skill", arguments: { name: "fixture-guide" } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    });
    fixture.peer.enqueueGeneration((request) => {
      summaryEnvelope(request, handle.agent.session);
      expect(JSON.stringify(request)).not.toContain(callId);
      return final(checkpoint);
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(request.purpose).toBe("agent");
      expect(text(request)).toContain(checkpoint);
      const blocks = request.input.messages.flatMap((message) => message.content);
      const calls = blocks.filter((block) => block.type === "tool_call");
      const results = blocks.filter((block) => block.type === "tool_result");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.tool_call_id).toBe(callId);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ tool_call_id: callId, is_error: false });
      expect(JSON.stringify(results[0])).toContain("Use the provided fixture identifier.");
      return final("LATEST_TOOL_RESULT_CONSUMED");
    });
    await fixture.turn(handle, "Load fixture-guide and use its instructions to continue.");
    expect(fixture.peer.observedGenerateRequests.slice(63).map((request) => request.purpose)).toEqual(["agent", "compaction", "agent"]);
    const events = handle.agent.session.snapshotEvents();
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool/result")).toHaveLength(1);
    await durableCheckpoint(fixture, handle, checkpoint);
    const raw = (await fixture.ctx.sessionPersistence.readRaw(handle.agent.session.id))?.content;
    expect(raw).toContain(callId);
    expect(raw).toContain("LATEST_TOOL_RESULT_CONSUMED");
    allWebRequests(fixture);
  }, 30_000);

  it.each(["failed", "not-smaller"] as const)("preserves durable history and does not replay the request when its budget summary is %s", async (kind) => {
    const fixture = await setup();
    const handle = await fixture.create();
    await shortHistory(fixture, handle, 64);
    const session = handle.agent.session;
    const before = [...session.surface.nodes];
    const generation = session.surface.replaceGeneration;
    const boundary = `Preserve this unsent boundary after ${kind} summary.`;
    fixture.peer.enqueueGeneration((request) => {
      summaryEnvelope(request, session);
      return kind === "failed"
        ? { events: [{ type: "failed", error: { code: "BROWSER_UNAVAILABLE", message: "Fixture summary unavailable", retryable: false, external_outcome: "started" } }] }
        : final("This checkpoint is deliberately larger than its selected history. ".repeat(500));
    });
    await expect(fixture.turn(handle, boundary)).rejects.toThrow();
    fixture.peer.throwIfFailed();
    expect(session.surface.replaceGeneration).toBe(generation);
    expect(session.surface.nodes.slice(0, before.length)).toEqual(before);
    expect(summaries(session)).toEqual([]);
    expect(fixture.peer.observedGenerateRequests.slice(64).map((request) => request.purpose)).toEqual(["compaction"]);
    expect(session.snapshotEvents().filter((event) => event.type === "compaction/end")).toHaveLength(1);
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "error" } } });
    await fixture.ctx.sessions.flush(session);
    const raw = (await fixture.ctx.sessionPersistence.readRaw(session.id))?.content;
    expect(raw).toContain(boundary);
    expect(raw).toContain("LOCAL_REQUEST_BUDGET_EXCEEDED");
    expect(raw).not.toContain("compaction/summary");
    const messages = session.deriveMessages();
    await fixture.disposeHandle(handle);
    const resumed = await fixture.resume(session.id);
    expect(resumed.agent.session.deriveMessages()).toEqual(messages);
    expect(fixture.peer.observedGenerateRequests).toHaveLength(65);
    allWebRequests(fixture);
  }, 30_000);
});
