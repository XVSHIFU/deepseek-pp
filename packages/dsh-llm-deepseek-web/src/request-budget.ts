import type { GenerateOptions, LlmRequestBudgetExceeded } from "@deepseek-ai/dsh-llm";
import {
  MAX_FRAME_BYTES,
  MAX_ID_LENGTH,
  MAX_MESSAGES,
  ProtocolValidationError,
  encodeWebModelFrame,
} from "@deepseek-pp/web-model-protocol";

import { serializeGenerateRequest } from "./request.ts";

// Match the production UUID and transport RPC identity lengths without
// consuming request identities, touching the broker, or reading browser state.
const REQUEST_ID = `request-${"0".repeat(36)}`;
const SESSION_ID = `session-${"0".repeat(36)}` as NonNullable<GenerateOptions["sessionId"]>;
const RPC_ID = `rpc-${"0".repeat(32)}`;

/**
 * Measure the real v1 wire envelope using its authoritative serializer/codec.
 * Custom request-id factories are not invoked: reserve the protocol maximum
 * instead. Only message-count and complete-frame limits are compactable;
 * malformed input and unsupported generation settings keep their own errors.
 */
export function deepSeekWebRequestBudget(
  options: GenerateOptions,
  customRequestId = false,
): LlmRequestBudgetExceeded | undefined {
  let frame: unknown;
  try {
    const request = serializeGenerateRequest({
      ...options,
      sessionId: options.sessionId ?? SESSION_ID,
    }, { requestId: customRequestId ? "r".repeat(MAX_ID_LENGTH) : REQUEST_ID });
    frame = {
      jsonrpc: "2.0",
      id: RPC_ID,
      method: "model.generate",
      params: { schema_version: 1, ...request },
    };
    encodeWebModelFrame(frame);
    return undefined;
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      if (error.code === "ARRAY_TOO_LONG" && (
        error.path === "$.input.messages" || error.path === "$frame.params.input.messages"
      )) {
        return { dimension: "messages", actual: options.messages.length + Number(options.system !== undefined), limit: MAX_MESSAGES };
      }
      if (error.code === "FRAME_TOO_LARGE" && error.path === "$frame") {
        return { dimension: "bytes", actual: Buffer.byteLength(JSON.stringify(frame), "utf8"), limit: MAX_FRAME_BYTES };
      }
    }
    throw error;
  }
}
