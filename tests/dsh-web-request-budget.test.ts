import { createMessage, createUserMessage, ToolCallId, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { DeepSeekWebBroker } from "@deepseek-pp/dsh-web-model-transport";
import {
  DeepSeekWebAdapter,
  deepSeekWebRequestBudget,
  serializeGenerateRequest,
} from "@deepseek-pp/dsh-llm-deepseek-web";
import {
  MAX_CONTENT_BLOCKS, MAX_FRAME_BYTES, MAX_ID_LENGTH, MAX_MESSAGES, MAX_TEXT_LENGTH, MAX_TOOLS,
  encodeWebModelFrame,
} from "@deepseek-pp/web-model-protocol";
import { describe, expect, it, vi } from "vitest";

function user(text = "fixture") {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: "deepseek-web", model: "current-web-session", messages: [user()], ...overrides };
}
function reservedFrame(value: GenerateOptions, custom = false) {
  return {
    jsonrpc: "2.0", id: `rpc-${"0".repeat(32)}`, method: "model.generate",
    params: { schema_version: 1, ...serializeGenerateRequest({
      ...value, sessionId: value.sessionId ?? SessionId(`session-${"0".repeat(36)}`),
    }, { requestId: custom ? "r".repeat(MAX_ID_LENGTH) : `request-${"0".repeat(36)}` }) },
  };
}
function frameBytes(value: GenerateOptions, custom = false) {
  return Buffer.byteLength(JSON.stringify(reservedFrame(value, custom)), "utf8");
}
function exactFrame(target: number, custom = false): GenerateOptions {
  const build = (padding: number) => options({
    system: "Preserve fixture constraints.",
    tools: [{ name: "fixture", description: "Read fixture", parameters: { type: "object" } }],
    messages: [createUserMessage({ content: [
      { type: "text", text: "\u0001".repeat(20_000) + "汉".repeat(20_000) + "🙂".repeat(10_000) },
      ...Array.from({ length: 3 }, () => ({ type: "text" as const, text: "x".repeat(240_000) })),
      { type: "text", text: "x" + "x".repeat(padding) },
    ], source: { kind: "user" } })],
  });
  const base = build(0);
  const value = build(target - frameBytes(base, custom));
  expect(frameBytes(value, custom)).toBe(target);
  return value;
}

describe("DeepSeek Web local request-budget measurement", () => {
  it.each([128, 129, 257])("counts all %i serialized messages without changing the 128-message protocol cap", (count) => {
    const value = options({ messages: Array.from({ length: count }, () => user()) });
    expect(deepSeekWebRequestBudget(value)).toEqual(count <= MAX_MESSAGES
      ? undefined : { dimension: "messages", actual: count, limit: MAX_MESSAGES });
  });

  it("counts the actual system slot, including the exact 127+1 and 128+1 boundaries", () => {
    const messages = Array.from({ length: 127 }, () => user());
    expect(deepSeekWebRequestBudget(options({ system: "system", messages }))).toBeUndefined();
    expect(deepSeekWebRequestBudget(options({ system: "system", messages: [...messages, user()] })))
      .toEqual({ dimension: "messages", actual: 129, limit: 128 });
    expect(() => deepSeekWebRequestBudget(options({ system: "", messages })))
      .toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("measures escaped UTF-8 plus system, tools, ids and RPC overhead at exactly 1 MiB and +1 byte", () => {
    const exact = exactFrame(MAX_FRAME_BYTES);
    expect(Buffer.byteLength(encodeWebModelFrame(reservedFrame(exact)), "utf8")).toBe(MAX_FRAME_BYTES);
    expect(JSON.stringify(reservedFrame(exact))).toContain("\\u0001");
    expect(deepSeekWebRequestBudget(exact)).toBeUndefined();
    const oversized = exactFrame(MAX_FRAME_BYTES + 1);
    expect(deepSeekWebRequestBudget(oversized)).toEqual({ dimension: "bytes", actual: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES });
    expect(() => encodeWebModelFrame(reservedFrame(oversized))).toThrowError(/FRAME_TOO_LARGE/);
  });

  it("reserves the 128-character custom request id without allocating ids or touching the broker", () => {
    const untouched = vi.fn((): never => { throw new Error("Budget checks must not call the broker."); });
    const broker: DeepSeekWebBroker = { generate: untouched, cancel: untouched, query: untouched };
    const createRequestId = vi.fn(() => "short-custom-id");
    const adapter = new DeepSeekWebAdapter({ broker, createRequestId });
    const exact = exactFrame(MAX_FRAME_BYTES, true);
    expect(adapter.requestBudget(exact)).toBeUndefined();
    expect(adapter.requestBudget(exact)).toBeUndefined();
    expect(adapter.requestBudget(exactFrame(MAX_FRAME_BYTES + 1, true)))
      .toEqual({ dimension: "bytes", actual: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES });
    const normalExact = exactFrame(MAX_FRAME_BYTES);
    expect(adapter.requestBudget(normalExact)).toEqual({
      dimension: "bytes", actual: MAX_FRAME_BYTES + MAX_ID_LENGTH - "request-".length - 36, limit: MAX_FRAME_BYTES,
    });
    expect(createRequestId).not.toHaveBeenCalled();
    expect(untouched).not.toHaveBeenCalled();
  });

  it("includes an explicitly longer session id in the full wire measurement", () => {
    const exact = exactFrame(MAX_FRAME_BYTES);
    const withSession = { ...exact, sessionId: SessionId("s".repeat(MAX_ID_LENGTH)) };
    expect(deepSeekWebRequestBudget(withSession)).toEqual({
      dimension: "bytes", actual: MAX_FRAME_BYTES + MAX_ID_LENGTH - "session-".length - 36, limit: MAX_FRAME_BYTES,
    });
  });

  it.each([
    { temperature: 0 }, { maxTokens: 1 }, { stop: [] }, { reasoningEffort: "high" },
  ])("keeps unsupported generation controls distinct from a compactable budget (%j)", (override) => {
    expect(() => deepSeekWebRequestBudget(options(override as Partial<GenerateOptions>)))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED_OPTION" }));
  });

  it.each([
    ["provider", { provider: "other" }, "NO_ADAPTER"],
    ["model", { model: "other" }, "UNKNOWN_MODEL"],
    ["empty messages", { messages: [] }, "INVALID_REQUEST"],
    ["unicode", { messages: [user("\ud800")] }, "INVALID_UNICODE"],
    ["individual text", { messages: [user("x".repeat(MAX_TEXT_LENGTH + 1))] }, "OUT_OF_RANGE"],
    ["too many tools", { tools: Array.from({ length: MAX_TOOLS + 1 }, (_, index) => ({ name: `tool${index}`, description: "fixture", parameters: { type: "object" } })) }, "ARRAY_TOO_LONG"],
    ["too many blocks", { messages: [createUserMessage({ content: Array.from({ length: MAX_CONTENT_BLOCKS + 1 }, () => ({ type: "text" as const, text: "x" })), source: { kind: "user" } })] }, "ARRAY_TOO_LONG"],
    ["invalid tool arguments", { messages: [createMessage({ role: "assistant", source: { kind: "model", provider: "deepseek-web", model: "current-web-session" }, content: [{ type: "tool-call", id: ToolCallId("invalid-args"), name: "fixture", arguments: "[]" }] })] }, "INVALID_REQUEST"],
  ] as const)("preserves %s validation instead of returning a budget refusal", (_label, override, code) => {
    expect(() => deepSeekWebRequestBudget(options(override as Partial<GenerateOptions>)))
      .toThrow(expect.objectContaining({ code }));
  });

  it("does not hide malformed schema structure behind an independently excessive message count", () => {
    const parameters = { nested: {} as Record<string, unknown> };
    let cursor = parameters.nested;
    for (let index = 0; index < 40; index++) {
      const nested: Record<string, unknown> = {};
      cursor.next = nested;
      cursor = nested;
    }
    expect(() => deepSeekWebRequestBudget(options({
      messages: Array.from({ length: MAX_MESSAGES + 1 }, () => user()),
      tools: [{ name: "invalid", description: "fixture", parameters }],
    }))).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
