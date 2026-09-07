export const DEEPSEEK_WEB_REASONING_NAMESPACE = "deepseekWebReasoning" as const;

export type DeepSeekWebReasoningFrame =
  | { readonly phase: "start"; readonly sessionId: string; readonly requestId: string }
  | { readonly phase: "delta"; readonly sessionId: string; readonly requestId: string; readonly text: string }
  | { readonly phase: "end"; readonly sessionId: string; readonly requestId: string };

const FRAME_CODEC = Object.freeze({
  mode: "strict" as const,
  typeSymbol: "@deepseek-pp/dsh-deepseek-web-official-plugin/reasoning-contract#DeepSeekWebReasoningFrame",
  schema: Object.freeze({ parse: decodeReasoningFrame }),
});

export const DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze([Object.freeze({
    id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebReasoningRemote/follow",
    service: "deepseekWebReasoningRemote",
    namespace: DEEPSEEK_WEB_REASONING_NAMESPACE,
    method: "follow",
    mode: "stream" as const,
    invocation: Object.freeze({ kind: "direct" as const }),
    parameters: Object.freeze([]),
    cancellation: Object.freeze({ parameter: "signal" as const }),
    result: FRAME_CODEC,
  })]),
});

export function decodeReasoningFrame(value: unknown): DeepSeekWebReasoningFrame {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.requestId !== "string" ||
      value.sessionId.length === 0 || value.sessionId.length > 256 || value.requestId.length === 0 ||
      value.requestId.length > 256) throw new Error("Invalid DeepSeek Web reasoning frame");
  if (value.phase === "delta") {
    if (Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId", "text"].join("\0") ||
        typeof value.text !== "string" || value.text.length > 16_384) {
      throw new Error("Invalid DeepSeek Web reasoning frame");
    }
    return { phase: "delta", sessionId: value.sessionId, requestId: value.requestId, text: value.text };
  }
  if ((value.phase !== "start" && value.phase !== "end") ||
      Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId"].join("\0")) {
    throw new Error("Invalid DeepSeek Web reasoning frame");
  }
  return { phase: value.phase, sessionId: value.sessionId, requestId: value.requestId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
