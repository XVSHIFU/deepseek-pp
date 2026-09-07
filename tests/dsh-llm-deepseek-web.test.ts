import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import {
  LOCAL_REQUEST_BUDGET_EXCEEDED_CODE,
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  BrokerError,
  type BrokerCancelRequest,
  type BrokerCancelResult,
  type BrokerGenerateRequest,
  type BrokerQueryRequest,
  type BrokerQueryResult,
  type DeepSeekWebBroker,
} from "@deepseek-pp/dsh-web-model-transport";
import type { ModelEvent } from "@deepseek-pp/web-model-protocol";
import * as DeepSeekWebPlugin from "@deepseek-pp/dsh-llm-deepseek-web";
import {
  DEEPSEEK_WEB_MODEL,
  DEEPSEEK_WEB_PROVIDER,
  DeepSeekWebAdapter,
  registerDeepSeekWebAdapter,
  serializeGenerateRequest,
} from "@deepseek-pp/dsh-llm-deepseek-web";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DeepSeek Web DSH adapter", () => {
  it("advertises one browser-backed provider/model with no retries", async () => {
    const adapter = new DeepSeekWebAdapter({ broker: new FakeBroker([]) });

    expect(adapter.providerInfo(DEEPSEEK_WEB_PROVIDER)).toEqual({
      id: "deepseek-web",
      name: "DeepSeek Web",
    });
    expect(adapter.providerRetryPolicy(DEEPSEEK_WEB_PROVIDER)).toMatchObject({
      mode: "normal",
      maxRetries: 0,
    });
    await expect(adapter.listModels(DEEPSEEK_WEB_PROVIDER)).resolves.toEqual([
      expect.objectContaining({
        provider: "deepseek-web",
        id: "current-web-session",
        inputModalities: ["text"],
      }),
    ]);
    await expect(adapter.resolveModel(DEEPSEEK_WEB_PROVIDER, DEEPSEEK_WEB_MODEL)).resolves.toMatchObject({
      context: { contextWindow: 128_000 },
    });
    await expect(adapter.listModels("other")).rejects.toMatchObject({ code: "NO_ADAPTER" });
    await expect(adapter.resolveModel("other", DEEPSEEK_WEB_MODEL)).rejects.toMatchObject({ code: "NO_ADAPTER" });
    await expect(adapter.resolveModel(DEEPSEEK_WEB_PROVIDER, "local-model")).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
  });

  it("registers exactly the deepseek-web route through the public Cordis/LLM seam", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    ctx.provide("deepseekWebBroker", new FakeBroker([]));
    await ctx.plugin(DeepSeekWebPlugin);

    expect(ctx.llm.listProviders()).toEqual([
      { id: "deepseek-web", name: "DeepSeek Web" },
    ]);
    expect(ctx.llm.providerRetryPolicy(DEEPSEEK_WEB_PROVIDER)).toMatchObject({ mode: "normal", maxRetries: 0 });
  });

  it("serializes the DSH request and binds every semantic field into the digest", () => {
    const base = generateOptions({
      system: "Follow the Harness instructions.",
      tools: [{
        name: "read_file",
        description: "Read one workspace file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    });
    const serialize = (options: GenerateOptions) => serializeGenerateRequest(options, { requestId: "request-fixed" });
    const original = serialize(base);

    expect(original).toMatchObject({
      request_id: "request-fixed",
      session_id: "session-a",
      purpose: "agent",
      model: { provider: "deepseek-web", model_id: "current-web-session" },
      input: { messages: [
        { role: "system", content: [{ type: "text", text: "Follow the Harness instructions." }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ] },
      options: { thinking_enabled: false, search_enabled: false, model_type: "default" },
    });
    expect(original.request_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(original.request_digest).toBe("27233222afb1f2a722931b533fc200d72660ad2211303c08ed0b01280228c807");
    expect(serialize(base).request_digest).toBe(original.request_digest);

    const changed = [
      { ...base, sessionId: "session-b" as GenerateOptions["sessionId"] },
      { ...base, purpose: "compaction" as const },
      { ...base, system: "Different system." },
      { ...base, messages: [createUserMessage({ content: [{ type: "text", text: "changed" }], source: { kind: "user" } })] },
      { ...base, tools: [{ ...base.tools![0]!, description: "Different tool contract." }] },
    ];
    for (const candidate of changed) expect(serialize(candidate).request_digest).not.toBe(original.request_digest);

    const reordered = generateOptions({
      system: base.system,
      tools: [{
        parameters: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
        description: "Read one workspace file.",
        name: "read_file",
      }],
    });
    expect(serialize(reordered).request_digest).toBe(original.request_digest);
  });

  it("maps text, tool calls, usage, and one successful terminal chunk", async () => {
    const broker = new FakeBroker([
      { type: "text_delta", text: "Inspecting " },
      { type: "text_delta", text: "now." },
      { type: "reasoning_delta", text: "not durable", retention: "ephemeral" },
      { type: "tool_call", tool_call_id: "call-1", name: "read_file", arguments: { path: "README.md", z: 1 } },
      { type: "usage", input_tokens: 12, output_tokens: 7, cache_read_tokens: 3 },
      { type: "completed", finish_reason: "tool_calls" },
    ]);
    const adapter = new DeepSeekWebAdapter({ broker, createRequestId: () => "request-1" });

    const chunks = await collect(adapter.stream(generateOptions()));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "Inspecting " },
      { type: "text-delta", index: 0, text: "now." },
      { type: "block-end", index: 0, block: { type: "text", text: "Inspecting now." } },
      { type: "block-start", index: 1, blockType: "tool-call" },
      { type: "tool-call-delta", index: 1, id: "call-1", name: "read_file", argumentsDelta: "{\"path\":\"README.md\",\"z\":1}" },
      { type: "block-end", index: 1, block: { type: "tool-call", id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\",\"z\":1}" } },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3 } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
    expect(broker.requests).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toContain("not durable");
  });

  it("closes a pure text block before usage and the terminal finish", async () => {
    const broker = new FakeBroker([
      { type: "text_delta", text: "done" },
      { type: "usage", input_tokens: 3, output_tokens: 1 },
      { type: "completed", finish_reason: "stop" },
    ]);
    const chunks = await collect(new DeepSeekWebAdapter({ broker }).stream(generateOptions()));
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "block-start",
      "text-delta",
      "block-end",
      "usage",
      "finish",
    ]);
    expect(broker.cleanupCount).toBe(1);
  });

  it.each([
    [{ type: "failed", error: { code: "PAGE_FAILED", message: "private detail", retryable: false, external_outcome: "started" } } as const,
      { kind: "error", failure: { code: "PAGE_FAILED", message: "private detail" } }],
    [{ type: "ambiguous", reason: "browser_disconnected" } as const,
      { kind: "error", failure: { code: "WEB_MODEL_DISCONNECTED_AMBIGUOUS", message: "The browser connection was lost; the web outcome is unknown. Reconnect to query the original request." } }],
    [{ type: "ambiguous", reason: "generation_timeout" } as const,
      { kind: "error", failure: { code: "WEB_MODEL_TIMEOUT_AMBIGUOUS", message: "The web request timed out; its outcome is unknown. Do not replay automatically." } }],
    [{ type: "aborted", reason: "cancelled" } as const,
      { kind: "error", failure: { code: "WEB_MODEL_BROWSER_ABORTED", message: "The browser stopped the request before web generation was dispatched." } }],
  ])("maps %s to exactly one stable terminal finish", async (event, reason) => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    registerDeepSeekWebAdapter(ctx, new FakeBroker([event]));
    const chunks = await collect(ctx.llm.stream(generateOptions()));
    expect(chunks).toEqual([{ type: "finish", reason }]);
  });

  it("rejects a browser-reported local budget code without recovery or another generate", async () => {
    const ctx = new Context();
    const broker = new FakeBroker([{
      type: "failed",
      error: {
        code: LOCAL_REQUEST_BUDGET_EXCEEDED_CODE,
        message: "An external failure must not claim an unsent local request.",
        retryable: false,
        external_outcome: "started",
      },
    }]);
    try {
      await ctx.plugin(LlmRuntime);
      registerDeepSeekWebAdapter(ctx, broker);

      const chunks = await collect(ctx.llm.stream(generateOptions()));

      expect(chunks).toEqual([{
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: "WEB_MODEL_PROTOCOL",
            message: "The browser reported a reserved local failure code.",
          },
        },
      }]);
      expect(JSON.stringify(chunks)).not.toContain(LOCAL_REQUEST_BUDGET_EXCEEDED_CODE);
      expect(broker.requests.map((request) => request.purpose)).toEqual(["agent"]);
      expect(broker.cancelRequests).toHaveLength(0);
      expect(broker.cleanupCount).toBe(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("turns an empty completed response into one EMPTY_RESPONSE finish", async () => {
    const chunks = await collect(new DeepSeekWebAdapter({
      broker: new FakeBroker([{ type: "completed", finish_reason: "stop" }]),
    }).stream(generateOptions()));
    expect(chunks).toEqual([{
      type: "finish",
      reason: { kind: "error", failure: { code: "EMPTY_RESPONSE", message: "The DeepSeek Web model returned no content." } },
    }]);
  });

  it("fails closed on duplicate usage with one runtime protocol finish", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    registerDeepSeekWebAdapter(ctx, new FakeBroker([
      { type: "text_delta", text: "partial" },
      { type: "usage", input_tokens: 3, output_tokens: 1 },
      { type: "usage", input_tokens: 3, output_tokens: 1 },
      { type: "completed", finish_reason: "stop" },
    ]));
    const chunks = await collect(ctx.llm.stream(generateOptions()));
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([{
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          code: "WEB_MODEL_PROTOCOL",
          message: "The DeepSeek Web broker stream ended without one valid terminal event.",
        },
      },
    }]);
  });

  it.each([
    [[
      { type: "tool_call", tool_call_id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      { type: "completed", finish_reason: "stop" },
    ] as const],
    [[
      { type: "text_delta", text: "not a tool call" },
      { type: "completed", finish_reason: "tool_calls" },
    ] as const],
  ])("rejects a completed finish reason inconsistent with tool-call output", async (events) => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    registerDeepSeekWebAdapter(ctx, new FakeBroker(events));
    const chunks = await collect(ctx.llm.stream(generateOptions()));
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([expect.objectContaining({
      type: "finish",
      reason: expect.objectContaining({ kind: "error", failure: expect.objectContaining({ code: "WEB_MODEL_PROTOCOL" }) }),
    })]);
  });

  it("normalizes a pre-dispatch browser absence to one runtime terminal and never retries", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    const broker = new ThrowingBroker(new BrokerError("WAITING_FOR_BROWSER", "not_started"));
    registerDeepSeekWebAdapter(ctx, broker);

    const chunks = await collect(ctx.llm.stream(generateOptions()));

    expect(chunks).toEqual([{
      type: "finish",
      reason: {
        kind: "error",
        failure: { code: "WAITING_FOR_BROWSER", message: "Waiting for an authenticated DeepSeek++ browser broker." },
      },
    }]);
    expect(broker.generateCount).toBe(1);
    expect(broker.cancelRequests).toHaveLength(0);
  });

  it.each([
    "DEEPSEEK_AUTH_REQUIRED",
    "DEEPSEEK_PREPARATION_FAILED",
    "MODEL_PREPARATION_FAILED",
  ] as const)("reports %s through the official runtime without retrying", async (code) => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    const broker = new ThrowingBroker(new BrokerError(code, "not_started"));
    registerDeepSeekWebAdapter(ctx, broker);
    const chunks = await collect(ctx.llm.stream(generateOptions()));
    expect(chunks).toEqual([{
      type: "finish",
      reason: { kind: "error", failure: { code, message: expect.any(String) } },
    }]);
    expect(broker.generateCount).toBe(1);
    expect(broker.cancelRequests).toHaveLength(0);
  });

  it("keeps a remote failure with unknown outcome ambiguous", async () => {
    const broker = new ThrowingBroker(new BrokerError("DEEPSEEK_AUTH_REQUIRED", "unknown"));
    const adapter = new DeepSeekWebAdapter({ broker });
    await expect(collect(adapter.stream(generateOptions()))).rejects.toMatchObject({ code: "WEB_MODEL_AMBIGUOUS" });
    expect(broker.generateCount).toBe(1);
  });

  it("propagates AbortSignal through broker cancellation and emits one aborted finish", async () => {
    const broker = new AbortBroker();
    const controller = new AbortController();
    const adapter = new DeepSeekWebAdapter({ broker, createRequestId: () => "request-abort" });
    const consuming = collect(adapter.stream(generateOptions({ signal: controller.signal })));
    await broker.started;
    controller.abort("test cancellation");

    const chunks = await consuming;

    expect(broker.cancelRequests).toEqual([expect.objectContaining({
      request_id: "request-abort",
      reason: "caller_aborted",
    })]);
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([{
      type: "finish",
      reason: { kind: "aborted", failure: { code: "ABORTED", message: "DeepSeek Web request aborted by caller." } },
    }]);
    expect(broker.cleanupCount).toBe(1);
  });

  it("does not report success when cancellation races with content and completed", async () => {
    const broker = new AbortCompletedBroker();
    const controller = new AbortController();
    const adapter = new DeepSeekWebAdapter({ broker });
    const consuming = collect(adapter.stream(generateOptions({ signal: controller.signal })));
    await broker.started;
    controller.abort();

    const chunks = await consuming;

    expect(chunks).toEqual([{
      type: "finish",
      reason: { kind: "error", failure: {
        code: "WEB_MODEL_CANCEL_UNCONFIRMED",
        message: "Cancellation was requested, but the web result or cleanup could not be confirmed. Do not replay automatically.",
      } },
    }]);
    expect(chunks).not.toContainEqual(expect.objectContaining({ reason: { kind: "tool-calls" } }));
    expect(broker.cleanupCount).toBe(1);
  });

  it("returns ambiguous and blocks reuse when cancellation fails before cleanup", async () => {
    const broker = new CancelFailureBroker();
    const controller = new AbortController();
    const adapter = new DeepSeekWebAdapter({ broker, abortSettleTimeoutMs: 30 });
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter([DEEPSEEK_WEB_PROVIDER], adapter);
    const consuming = collect(ctx.llm.stream(generateOptions({ signal: controller.signal })));
    await broker.started;
    controller.abort();

    const chunks = await consuming;
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([{
      type: "finish",
      reason: { kind: "error", failure: {
        code: "WEB_MODEL_CANCEL_UNCONFIRMED",
        message: "Cancellation was requested, but the web result or cleanup could not be confirmed. Do not replay automatically.",
      } },
    }]);
    const blocked = await collect(ctx.llm.stream(generateOptions()));
    expect(blocked.at(-1)).toMatchObject({ reason: { failure: { code: "WEB_MODEL_AMBIGUOUS" } } });
    expect(broker.generateCount).toBe(1);
    broker.releaseTerminal();
    await waitFor(() => broker.cleanupCount === 1);
  });

  it("returns ambiguous when cancel acknowledgment exceeds the local settlement deadline", async () => {
    const broker = new CancelTimeoutBroker();
    const controller = new AbortController();
    const adapter = new DeepSeekWebAdapter({ broker, abortSettleTimeoutMs: 20 });
    const consuming = collect(adapter.stream(generateOptions({ signal: controller.signal })));
    await broker.started;
    controller.abort();

    const chunks = await consuming;
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      reason: { kind: "error", failure: {
        code: "WEB_MODEL_CANCEL_UNCONFIRMED",
        message: "Cancellation was requested, but the web result or cleanup could not be confirmed. Do not replay automatically.",
      } },
    });
    await waitFor(() => broker.cleanupCount === 1);
  });

  it("creates an ad-hoc session identity and rejects protocol-unsupported options/content", async () => {
    const base = generateOptions();
    const invalid: GenerateOptions[] = [
      { ...base, temperature: 0.2 },
      { ...base, maxTokens: 100 },
      { ...base, stop: ["stop"] },
      { ...base, reasoningEffort: "off" as GenerateOptions["reasoningEffort"] },
      { ...base, messages: [{ ...base.messages[0]!, content: [{ type: "reasoning", text: "stored thought" }] }] },
      { ...base, messages: [{ ...base.messages[0]!, content: [{
        type: "image",
        attachment: {} as never,
      }] }] },
    ];
    for (const options of invalid) {
      await expect(collect(new DeepSeekWebAdapter({ broker: new FakeBroker([]) }).stream(options)))
        .rejects.toMatchObject({
          code: options.temperature !== undefined
            || options.maxTokens !== undefined
            || options.stop !== undefined
            || options.reasoningEffort !== undefined
            ? "UNSUPPORTED_OPTION"
            : options.messages[0]?.content[0]?.type === "image"
              ? "UNSUPPORTED_CONTENT"
              : "INVALID_REQUEST",
        });
    }
    const adHoc = serializeGenerateRequest({ ...base, sessionId: undefined }, { requestId: "request-adhoc" });
    expect(adHoc.session_id).toMatch(/^session-[0-9a-f-]{36}$/);
    expect(adHoc.request_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts but does not serialize the official compaction engine's local max-token hint", () => {
    const request = serializeGenerateRequest({
      ...generateOptions(),
      purpose: "compaction",
      maxTokens: 4_096,
    }, { requestId: "request-official-compaction" });

    expect(request.purpose).toBe("compaction");
    expect(request.options).toEqual({
      thinking_enabled: false,
      search_enabled: false,
      model_type: "default",
    });
    expect(request).not.toHaveProperty("maxTokens");
  });

  it("loads without model credentials and uses no private Harness imports", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(() => new DeepSeekWebAdapter({ broker: new FakeBroker([]) })).not.toThrow();

    const sourceRoot = join(process.cwd(), "packages", "dsh-llm-deepseek-web", "src");
    const sources = await Promise.all(["adapter.ts", "constants.ts", "generation-scheduler.ts", "index.ts", "request.ts"]
      .map((file) => readFile(join(sourceRoot, file), "utf8")));
    const source = sources.join("\n");
    expect(source).not.toMatch(/@deepseek-ai\/[^"']+\/src\//);
    expect([...new Set([...source.matchAll(/@deepseek-ai\/[^"']+/g)].map((match) => match[0]))].sort())
      .toEqual(["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm"]);
    expect(source).not.toContain("DEEPSEEK_API_KEY");
  });
});

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: DEEPSEEK_WEB_PROVIDER,
    model: DEEPSEEK_WEB_MODEL,
    sessionId: "session-a" as GenerateOptions["sessionId"],
    messages: [createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } })],
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

class FakeBroker implements DeepSeekWebBroker {
  readonly requests: BrokerGenerateRequest[] = [];
  readonly cancelRequests: BrokerCancelRequest[] = [];
  cleanupCount = 0;

  constructor(private readonly events: readonly ModelEvent[]) {}

  async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    try {
      for (const event of this.events) yield event;
    } finally {
      this.cleanupCount += 1;
    }
  }

  cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.cancelRequests.push(request);
    return Promise.resolve(cancelResult(request));
  }

  query(request: BrokerQueryRequest): Promise<BrokerQueryResult> {
    return Promise.resolve({
      schema_version: 1,
      type: "model.status",
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: "unknown",
      last_sequence: 0,
    });
  }
}

class ThrowingBroker extends FakeBroker {
  generateCount = 0;

  constructor(private readonly failure: Error) {
    super([]);
  }

  override async *generate(_request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.generateCount += 1;
    throw this.failure;
  }
}

class AbortBroker extends FakeBroker {
  private releaseGeneration!: () => void;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super([]);
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }

  override async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    try {
      this.markStarted();
      await new Promise<void>((resolve) => { this.releaseGeneration = resolve; });
      yield { type: "aborted", reason: "cancelled" };
    } finally {
      this.cleanupCount += 1;
    }
  }

  override cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.cancelRequests.push(request);
    this.releaseGeneration();
    return Promise.resolve(cancelResult(request));
  }
}

class CancelFailureBroker extends FakeBroker {
  private releaseGeneration!: () => void;
  readonly started: Promise<void>;
  private markStarted!: () => void;
  generateCount = 0;

  constructor() {
    super([]);
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }

  override async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.generateCount += 1;
    this.requests.push(request);
    try {
      this.markStarted();
      await new Promise<void>((resolve) => { this.releaseGeneration = resolve; });
      yield { type: "ambiguous", reason: "cancel_outcome_unknown" };
    } finally {
      this.cleanupCount += 1;
    }
  }

  override cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.cancelRequests.push(request);
    return Promise.reject(new BrokerError("CONNECTION_LOST", "unknown"));
  }

  releaseTerminal(): void {
    this.releaseGeneration();
  }
}

class AbortCompletedBroker extends FakeBroker {
  private releaseGeneration!: () => void;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super([]);
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }

  override async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    try {
      this.markStarted();
      await new Promise<void>((resolve) => { this.releaseGeneration = resolve; });
      yield { type: "text_delta", text: "racing text" };
      yield { type: "tool_call", tool_call_id: "racing-call", name: "read_file", arguments: { path: "README.md" } };
      yield { type: "completed", finish_reason: "tool_calls" };
    } finally {
      this.cleanupCount += 1;
    }
  }

  override cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.cancelRequests.push(request);
    this.releaseGeneration();
    return Promise.resolve(cancelResult(request));
  }
}

class CancelTimeoutBroker extends FakeBroker {
  private releaseGeneration!: () => void;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super([]);
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }

  override async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    try {
      this.markStarted();
      await new Promise<void>((resolve) => { this.releaseGeneration = resolve; });
      yield { type: "aborted", reason: "cancelled" };
    } finally {
      this.cleanupCount += 1;
    }
  }

  override cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.cancelRequests.push(request);
    this.releaseGeneration();
    return new Promise(() => undefined);
  }
}

function cancelResult(request: BrokerCancelRequest): BrokerCancelResult {
  return {
    schema_version: 1,
    type: "model.cancelled",
    request_id: request.request_id,
    request_digest: request.request_digest,
    status: "cancel_requested",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
