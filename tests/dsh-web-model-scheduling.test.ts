import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import { DeepSeekWebAdapter, registerDeepSeekWebAdapter } from "@deepseek-pp/dsh-llm-deepseek-web";
import type { BrokerGenerateRequest, DeepSeekWebBroker } from "@deepseek-pp/dsh-web-model-transport";
import type { ModelEvent } from "@deepseek-pp/web-model-protocol";
import { describe, expect, it, vi } from "vitest";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "deepseek-web", model: "current-web-session",
    messages: [createUserMessage({ content: [{ type: "text", text: "task" }], source: { kind: "user" } })],
    ...overrides,
  };
}

async function collect(chunks: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

function heldBroker() {
  const started = deferred();
  const release = deferred();
  const cleanup = deferred();
  const cleanupStarted = deferred();
  const requests: BrokerGenerateRequest[] = [];
  let active = 0;
  let maximumActive = 0;
  const broker: DeepSeekWebBroker = {
    async *generate(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      active += 1;
      maximumActive = Math.max(active, maximumActive);
      const first = requests.length === 1;
      try {
        if (first) { started.resolve(); await release.promise; }
        yield { type: "text_delta", text: "done" };
        yield { type: "completed", finish_reason: "stop" };
      } finally {
        if (first) { cleanupStarted.resolve(); await cleanup.promise; }
        active -= 1;
      }
    },
    cancel: vi.fn(async (request) => ({ schema_version: 1, type: "model.cancelled", ...request, status: "cancel_requested" })),
    query: vi.fn(async (request) => ({ schema_version: 1, type: "model.status", ...request, status: "unknown", last_sequence: 0 })),
  };
  return { broker, started, release, cleanup, cleanupStarted, requests, maximum: () => maximumActive };
}

describe("shared DeepSeek Web model scheduling", () => {
  it("serializes main, compaction and child streams through confirmed iterator cleanup", async () => {
    const fixture = heldBroker();
    const adapter = new DeepSeekWebAdapter({ broker: fixture.broker });
    const main = collect(adapter.stream(options({ sessionId: SessionId("parent") })));
    await fixture.started.promise;
    const compact = collect(adapter.stream(options({ sessionId: SessionId("parent"), purpose: "compaction" })));
    const child = collect(adapter.stream(options({ sessionId: SessionId("child") })));
    await Promise.resolve();
    expect(fixture.requests).toHaveLength(1);
    fixture.release.resolve();
    await fixture.cleanupStarted.promise;
    expect(fixture.requests).toHaveLength(1);
    fixture.cleanup.resolve();
    await Promise.all([main, compact, child]);
    expect(fixture.requests.map((request) => [request.session_id, request.purpose])).toEqual([
      ["parent", "agent"], ["parent", "compaction"], ["child", "agent"],
    ]);
    expect(fixture.maximum()).toBe(1);
  });

  it("removes an aborted queued request without creating or cancelling a browser request", async () => {
    const fixture = heldBroker();
    const createRequestId = vi.fn(() => `request-${createRequestId.mock.calls.length}`);
    const adapter = new DeepSeekWebAdapter({ broker: fixture.broker, createRequestId });
    const main = collect(adapter.stream(options()));
    await fixture.started.promise;
    const abort = new AbortController();
    const queued = collect(adapter.stream(options({ signal: abort.signal })));
    abort.abort();
    await expect(queued).resolves.toEqual([expect.objectContaining({ type: "finish", reason: expect.objectContaining({ kind: "aborted" }) })]);
    expect(createRequestId).toHaveBeenCalledTimes(1);
    expect(fixture.broker.cancel).not.toHaveBeenCalled();
    const next = collect(adapter.stream(options()));
    fixture.release.resolve(); fixture.cleanup.resolve();
    await Promise.all([main, next]);
    expect(fixture.requests).toHaveLength(2);
  });

  it("bounds pending calls and leaves admitted requests intact on overflow", async () => {
    const fixture = heldBroker();
    const adapter = new DeepSeekWebAdapter({ broker: fixture.broker });
    const main = collect(adapter.stream(options()));
    await fixture.started.promise;
    const pending = Array.from({ length: 16 }, () => collect(adapter.stream(options())));
    const overflow = collect(adapter.stream(options()));
    const assertion = expect(overflow).rejects.toMatchObject({ code: "BROKER_BUSY" });
    fixture.release.resolve(); fixture.cleanup.resolve();
    await assertion;
    await Promise.all([main, ...pending]);
    expect(fixture.requests).toHaveLength(17);
    expect(fixture.maximum()).toBe(1);
  });

  it("does not release queued work into a transport with unconfirmed cleanup", async () => {
    const fixture = heldBroker();
    const adapter = new DeepSeekWebAdapter({ broker: fixture.broker, abortSettleTimeoutMs: 20 });
    const main = collect(adapter.stream(options()));
    await fixture.started.promise;
    const mainFailure = expect(main).rejects.toMatchObject({ code: "WEB_MODEL_AMBIGUOUS" });
    const queued = collect(adapter.stream(options()));
    const queuedFailure = expect(queued).rejects.toMatchObject({ code: "WEB_MODEL_AMBIGUOUS" });
    fixture.release.resolve();
    await Promise.all([mainFailure, queuedFailure]);
    expect(fixture.requests).toHaveLength(1);
    fixture.cleanup.resolve();
  });

  it("preserves child session identity and explicit auxiliary purpose on the shared LLM runtime", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    const fixture = heldBroker();
    fixture.release.resolve(); fixture.cleanup.resolve();
    try {
      const child = ctx.sessions.create(undefined, { meta: { cwd: process.cwd(), origin: "subagent" } });
      const parent = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } });
      const adapter = registerDeepSeekWebAdapter(ctx, fixture.broker);
      await collect(adapter.stream(options({ sessionId: child.id })));
      await collect(adapter.stream(options({ sessionId: child.id, purpose: "compaction" })));
      await collect(adapter.stream(options({ sessionId: parent.id })));
      expect(fixture.requests.map((request) => [request.session_id, request.purpose])).toEqual([
        [child.id, "agent"], [child.id, "compaction"], [parent.id, "agent"],
      ]);
    } finally { await ctx.fiber.dispose(); }
  });
});
