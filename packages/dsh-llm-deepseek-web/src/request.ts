import { createHash, randomUUID } from "node:crypto";

import { LlmError, type ContentBlock, type GenerateOptions, type Message } from "@deepseek-ai/dsh-llm";
import type { BrokerGenerateRequest } from "@deepseek-pp/dsh-web-model-transport";
import {
  assertJsonStructure,
  type JsonObject,
  type JsonValue,
  type MessageContent,
} from "@deepseek-pp/web-model-protocol";

import { DEEPSEEK_WEB_MODEL, DEEPSEEK_WEB_PROVIDER } from "./constants.ts";

export interface RequestIdentityFactory {
  (): string;
}

export interface SerializeGenerateOptions {
  readonly requestId?: string;
  readonly createRequestId?: RequestIdentityFactory;
}

export function serializeGenerateRequest(
  options: GenerateOptions,
  serialization: SerializeGenerateOptions = {},
): BrokerGenerateRequest {
  assertRoute(options);
  assertSupportedGenerationOptions(options);

  const requestId = serialization.requestId ?? serialization.createRequestId?.() ?? `request-${randomUUID()}`;
  const sessionId = options.sessionId === undefined
    ? `session-${randomUUID()}`
    : String(options.sessionId);
  const purpose: BrokerGenerateRequest["purpose"] = options.purpose ?? "agent";
  const messages = [
    ...(options.system === undefined
      ? []
      : [{ role: "system" as const, content: textOnly(options.system, "system") }]),
    ...options.messages.map(serializeMessage),
  ];
  if (messages.length === 0) {
    throw invalidRequest("DeepSeek Web requests require at least one message.");
  }

  const tools = (options.tools ?? []).map((tool) => {
    const inputSchema = cloneJsonObject(tool.parameters, `tool ${JSON.stringify(tool.name)} parameters`);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema,
    };
  });
  const body = {
    session_id: sessionId,
    purpose,
    model: { provider: DEEPSEEK_WEB_PROVIDER, model_id: DEEPSEEK_WEB_MODEL },
    input: { messages },
    tools,
    options: {
      thinking_enabled: false,
      search_enabled: false,
      model_type: "default" as const,
    },
  };
  assertJsonStructure(body);
  const requestDigest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { request_id: requestId, request_digest: requestDigest, ...body };
}

function assertRoute(options: GenerateOptions): void {
  if (options.provider !== DEEPSEEK_WEB_PROVIDER) {
    throw new LlmError("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER");
  }
  if (options.model !== DEEPSEEK_WEB_MODEL) {
    throw new LlmError("The DeepSeek Web adapter only exposes the current browser session.", "UNKNOWN_MODEL");
  }
}

function assertSupportedGenerationOptions(options: GenerateOptions): void {
  // The official preset's BasicCompactionEngine always supplies its local
  // summary cap. Protocol v1 cannot enforce that cap in the browser, but the
  // engine still rejects a checkpoint unless it is smaller than the history it
  // replaces. Accept and deliberately omit only that compaction-local hint so
  // the stock preset can use the web route without pretending it was sent.
  const unsupportedMaxTokens = options.maxTokens !== undefined && options.purpose !== "compaction";
  if (options.temperature !== undefined || unsupportedMaxTokens || options.stop !== undefined) {
    throw unsupportedOption("DeepSeek Web Protocol v1 does not support per-request generation controls.");
  }
  if (options.reasoningEffort !== undefined) {
    throw unsupportedOption("DeepSeek Web Protocol v1 does not accept a reasoning effort.");
  }
}

function serializeMessage(message: Message): {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent[];
} {
  const isToolMessage = message.source.kind === "tool";
  const role = isToolMessage ? "tool" as const : message.role;
  const content = message.content.map((block) => serializeContent(block, role));
  if (content.length === 0) throw invalidRequest("DeepSeek Web messages cannot have empty content.");
  return { role, content };
}

function serializeContent(
  block: ContentBlock,
  role: "system" | "user" | "assistant" | "tool",
): MessageContent {
  switch (block.type) {
    case "text":
      if (role === "tool") throw invalidRequest("Tool messages must contain tool results.");
      return textOnly(block.text, "message")[0];
    case "tool-call":
      if (role !== "assistant") throw invalidRequest("Tool calls require an assistant message.");
      return {
        type: "tool_call",
        tool_call_id: String(block.id),
        name: block.name,
        arguments: parseArguments(block.arguments),
      };
    case "tool-result": {
      if (role !== "tool") throw invalidRequest("Tool results require a tool message.");
      const content = block.content.map((item) => {
        if (item.type !== "text" || item.text.length === 0) {
          throw invalidRequest("Protocol v1 tool results support non-empty text blocks only.");
        }
        return { type: "text" as const, text: item.text };
      });
      return {
        type: "tool_result",
        tool_call_id: String(block.toolCallId),
        content,
        is_error: block.isError ?? false,
      };
    }
    case "reasoning":
      throw invalidRequest("Persisted reasoning is not accepted by the DeepSeek Web adapter.");
    case "image":
      throw new LlmError("The current DeepSeek Web session is text-only.", "UNSUPPORTED_CONTENT");
    default:
      throw new LlmError("The DeepSeek Web request contains unsupported content.", "UNSUPPORTED_CONTENT");
  }
}

function textOnly(text: string, label: string): [{ type: "text"; text: string }] {
  if (text.length === 0) throw invalidRequest(`DeepSeek Web ${label} text cannot be empty.`);
  return [{ type: "text", text }];
}

function parseArguments(raw: string): JsonObject {
  try {
    return cloneJsonObject(JSON.parse(raw), "tool-call arguments");
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw invalidRequest("Tool-call arguments must be a JSON object.", error);
  }
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  try {
    assertJsonStructure(value);
  } catch (error) {
    throw invalidRequest(`${label} must be bounded JSON.`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest(`${label} must be a JSON object.`);
  }
  return structuredClone(value) as JsonObject;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`
  )).join(",")}}`;
}

function invalidRequest(message: string, cause?: unknown): LlmError {
  return new LlmError(message, "INVALID_REQUEST", cause === undefined ? undefined : { cause });
}

function unsupportedOption(message: string): LlmError {
  return new LlmError(message, "UNSUPPORTED_OPTION");
}
