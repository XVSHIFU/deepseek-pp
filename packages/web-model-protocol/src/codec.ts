import {
  JSON_RPC_VERSION,
  MAX_ARRAY_LENGTH,
  MAX_CONTENT_BLOCKS,
  MAX_DESCRIPTION_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_FRAME_BYTES,
  MAX_MESSAGES,
  MAX_NAME_LENGTH,
  MAX_REASON_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_TOOLS,
  MAX_VERSION_LENGTH,
  PROTOCOL_VERSION,
} from "./constants";
import type {
  BridgeCapabilities,
  ModelEvent,
  ModelTerminalEvent,
  WebModelFrame,
} from "./types";
import {
  ProtocolValidationError,
  arrayValue,
  assertJsonStructure,
  bool,
  exactKeys,
  fail,
  identifier,
  integer,
  jsonObject,
  literal,
  oneOf,
  record,
  stringValue,
  utf8ByteLength,
} from "./validation";

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function decodeWebModelFrame(serialized: string): WebModelFrame {
  if (typeof serialized !== "string") fail("INVALID_TYPE", "$frame");
  if (utf8ByteLength(serialized) > MAX_FRAME_BYTES) fail("FRAME_TOO_LARGE", "$frame");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("INVALID_JSON", "$frame");
  }
  return validateWebModelFrame(value);
}

export function encodeWebModelFrame(value: unknown): string {
  const frame = validateWebModelFrame(value);
  const serialized = JSON.stringify(frame);
  if (utf8ByteLength(serialized) > MAX_FRAME_BYTES) fail("FRAME_TOO_LARGE", "$frame");
  return serialized;
}

export function encodeWebModelJsonLines(frames: readonly unknown[]): string {
  if (!Array.isArray(frames)) fail("INVALID_TYPE", "$frames");
  if (frames.length === 0) fail("OUT_OF_RANGE", "$frames");
  if (frames.length > MAX_ARRAY_LENGTH) fail("ARRAY_TOO_LONG", "$frames");
  return `${frames.map((frame) => encodeWebModelFrame(frame)).join("\n")}\n`;
}

export function validateWebModelFrame(value: unknown): WebModelFrame {
  assertJsonStructure(value);
  const frame = record(value, "$frame");
  literal(frame.jsonrpc, JSON_RPC_VERSION, "$frame.jsonrpc");

  if (hasOwn(frame, "method")) validateMethodFrame(frame);
  else if (hasOwn(frame, "error")) validateErrorResponse(frame);
  else if (hasOwn(frame, "result")) validateResultResponse(frame);
  else fail("INVALID_VALUE", "$frame");

  return value as unknown as WebModelFrame;
}

function validateMethodFrame(frame: Record<string, unknown>): void {
  const method = frame.method;
  oneOf(method, ["bridge.hello", "model.generate", "model.cancel", "model.query", "model.event", "bridge.heartbeat"] as const, "$frame.method");
  const isNotification = method === "model.event" || method === "bridge.heartbeat";
  exactKeys(frame, isNotification ? ["jsonrpc", "method", "params"] : ["jsonrpc", "id", "method", "params"], [], "$frame");
  if (!isNotification) identifier(frame.id, "$frame.id");

  switch (method) {
    case "bridge.hello": validateHelloParams(frame.params); break;
    case "model.generate": validateGenerateParams(frame.params); break;
    case "model.cancel": validateCancelParams(frame.params); break;
    case "model.query": validateQueryParams(frame.params); break;
    case "model.event": validateEventParams(frame.params); break;
    case "bridge.heartbeat": validateHeartbeatParams(frame.params); break;
  }
}

function schemaVersion(value: Record<string, unknown>, path: string): void {
  literal(value.schema_version, PROTOCOL_VERSION, `${path}.schema_version`);
}

function requestDigest(value: unknown, path: string): asserts value is string {
  stringValue(value, 64, 64, path);
  if (!/^[a-f0-9]{64}$/.test(value)) fail("INVALID_VALUE", path);
}

function validateHelloParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "pairing_token", "browser_instance_id", "client", "capabilities"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  stringValue(params.pairing_token, 43, 128, "$frame.params.pairing_token");
  if (!/^[A-Za-z0-9_-]+$/.test(params.pairing_token as string)) fail("INVALID_VALUE", "$frame.params.pairing_token");
  identifier(params.browser_instance_id, "$frame.params.browser_instance_id");

  const client = record(params.client, "$frame.params.client");
  exactKeys(client, ["name", "version"], [], "$frame.params.client");
  literal(client.name, "DeepSeek++", "$frame.params.client.name");
  stringValue(client.version, 1, MAX_VERSION_LENGTH, "$frame.params.client.version");

  validateCapabilities(params.capabilities, "$frame.params.capabilities");
}

function validateCapabilities(value: unknown, path: string): asserts value is BridgeCapabilities {
  const capabilities = record(value, path);
  exactKeys(capabilities, ["structured_tool_calls", "cancel", "query"], ["text", "reasoning", "usage"], path);
  literal(capabilities.structured_tool_calls, true, `${path}.structured_tool_calls`);
  literal(capabilities.cancel, true, `${path}.cancel`);
  literal(capabilities.query, true, `${path}.query`);
  for (const key of ["text", "reasoning", "usage"] as const) {
    if (hasOwn(capabilities, key)) literal(capabilities[key], true, `${path}.${key}`);
  }
}

function validateGenerateParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(
    params,
    ["schema_version", "request_id", "session_id", "request_digest", "purpose", "model", "input", "tools", "options"],
    [],
    "$frame.params",
  );
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  identifier(params.session_id, "$frame.params.session_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
  oneOf(params.purpose, ["agent", "session-title", "compaction"] as const, "$frame.params.purpose");

  const model = record(params.model, "$frame.params.model");
  exactKeys(model, ["provider", "model_id"], [], "$frame.params.model");
  literal(model.provider, "deepseek-web", "$frame.params.model.provider");
  literal(model.model_id, "current-web-session", "$frame.params.model.model_id");

  validateInput(params.input);
  validateTools(params.tools);
  validateOptions(params.options);
}

function validateInput(value: unknown): void {
  const input = record(value, "$frame.params.input");
  exactKeys(input, ["messages"], [], "$frame.params.input");
  const messages = arrayValue(input.messages, MAX_MESSAGES, "$frame.params.input.messages");
  if (messages.length === 0) fail("OUT_OF_RANGE", "$frame.params.input.messages");
  messages.forEach((item, index) => validateMessage(item, `$frame.params.input.messages[${index}]`));
}

function validateMessage(value: unknown, path: string): void {
  const message = record(value, path);
  exactKeys(message, ["role", "content"], [], path);
  oneOf(message.role, ["system", "user", "assistant", "tool"] as const, `${path}.role`);
  const content = arrayValue(message.content, MAX_CONTENT_BLOCKS, `${path}.content`);
  if (content.length === 0) fail("OUT_OF_RANGE", `${path}.content`);
  content.forEach((block, index) => validateContentBlock(block, message.role as string, `${path}.content[${index}]`));
}

function validateContentBlock(value: unknown, role: string, path: string): void {
  const block = record(value, path);
  oneOf(block.type, ["text", "tool_call", "tool_result"] as const, `${path}.type`);
  switch (block.type) {
    case "text":
      exactKeys(block, ["type", "text"], [], path);
      stringValue(block.text, 1, MAX_TEXT_LENGTH, `${path}.text`);
      if (role === "tool") fail("INVALID_VALUE", path);
      break;
    case "tool_call":
      exactKeys(block, ["type", "tool_call_id", "name", "arguments"], [], path);
      identifier(block.tool_call_id, `${path}.tool_call_id`);
      stringValue(block.name, 1, MAX_NAME_LENGTH, `${path}.name`);
      jsonObject(block.arguments, `${path}.arguments`);
      if (role !== "assistant") fail("INVALID_VALUE", path);
      break;
    case "tool_result": {
      exactKeys(block, ["type", "tool_call_id", "content", "is_error"], [], path);
      identifier(block.tool_call_id, `${path}.tool_call_id`);
      bool(block.is_error, `${path}.is_error`);
      if (role !== "tool") fail("INVALID_VALUE", path);
      const results = arrayValue(block.content, MAX_CONTENT_BLOCKS, `${path}.content`);
      results.forEach((result, index) => {
        const text = record(result, `${path}.content[${index}]`);
        exactKeys(text, ["type", "text"], [], `${path}.content[${index}]`);
        literal(text.type, "text", `${path}.content[${index}].type`);
        stringValue(text.text, 1, MAX_TEXT_LENGTH, `${path}.content[${index}].text`);
      });
      break;
    }
  }
}

function validateTools(value: unknown): void {
  const tools = arrayValue(value, MAX_TOOLS, "$frame.params.tools");
  const names = new Set<string>();
  tools.forEach((item, index) => {
    const path = `$frame.params.tools[${index}]`;
    const tool = record(item, path);
    exactKeys(tool, ["name", "description", "input_schema"], [], path);
    stringValue(tool.name, 1, MAX_NAME_LENGTH, `${path}.name`);
    if (names.has(tool.name as string)) fail("INVALID_VALUE", `${path}.name`);
    names.add(tool.name as string);
    stringValue(tool.description, 1, MAX_DESCRIPTION_LENGTH, `${path}.description`);
    jsonObject(tool.input_schema, `${path}.input_schema`);
  });
}

function validateOptions(value: unknown): void {
  const options = record(value, "$frame.params.options");
  exactKeys(
    options,
    ["thinking_enabled", "search_enabled", "model_type"],
    ["timeout_ms"],
    "$frame.params.options",
  );
  bool(options.thinking_enabled, "$frame.params.options.thinking_enabled");
  bool(options.search_enabled, "$frame.params.options.search_enabled");
  oneOf(options.model_type, ["default", "expert", "vision"] as const, "$frame.params.options.model_type");
  if (hasOwn(options, "timeout_ms")) integer(options.timeout_ms, 1, MAX_TIMEOUT_MS, "$frame.params.options.timeout_ms");
}

function validateCancelParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "request_digest"], ["reason"], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
  if (hasOwn(params, "reason")) stringValue(params.reason, 1, MAX_REASON_LENGTH, "$frame.params.reason");
}

function validateQueryParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "request_digest"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
}

function validateEventParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "sequence", "event"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  integer(params.sequence, 1, Number.MAX_SAFE_INTEGER, "$frame.params.sequence");
  validateModelEvent(params.event, "$frame.params.event");
}

export function validateModelEvent(value: unknown, path: string): asserts value is ModelEvent {
  const event = record(value, path);
  oneOf(
    event.type,
    ["text_delta", "reasoning_delta", "tool_call", "usage", "completed", "aborted", "failed", "ambiguous"] as const,
    `${path}.type`,
  );
  switch (event.type) {
    case "text_delta":
      exactKeys(event, ["type", "text"], [], path);
      stringValue(event.text, 1, MAX_TEXT_LENGTH, `${path}.text`);
      break;
    case "reasoning_delta":
      exactKeys(event, ["type", "text", "retention"], [], path);
      stringValue(event.text, 1, MAX_TEXT_LENGTH, `${path}.text`);
      literal(event.retention, "ephemeral", `${path}.retention`);
      break;
    case "tool_call":
      exactKeys(event, ["type", "tool_call_id", "name", "arguments"], [], path);
      identifier(event.tool_call_id, `${path}.tool_call_id`);
      stringValue(event.name, 1, MAX_NAME_LENGTH, `${path}.name`);
      jsonObject(event.arguments, `${path}.arguments`);
      break;
    case "usage":
      exactKeys(event, ["type", "input_tokens", "output_tokens"], ["cache_read_tokens", "cache_write_tokens"], path);
      integer(event.input_tokens, 0, Number.MAX_SAFE_INTEGER, `${path}.input_tokens`);
      integer(event.output_tokens, 0, Number.MAX_SAFE_INTEGER, `${path}.output_tokens`);
      if (hasOwn(event, "cache_read_tokens")) integer(event.cache_read_tokens, 0, Number.MAX_SAFE_INTEGER, `${path}.cache_read_tokens`);
      if (hasOwn(event, "cache_write_tokens")) integer(event.cache_write_tokens, 0, Number.MAX_SAFE_INTEGER, `${path}.cache_write_tokens`);
      break;
    case "completed":
      exactKeys(event, ["type", "finish_reason"], [], path);
      oneOf(event.finish_reason, ["stop", "length", "tool_calls"] as const, `${path}.finish_reason`);
      break;
    case "aborted":
    case "ambiguous":
      exactKeys(event, ["type", "reason"], [], path);
      stringValue(event.reason, 1, MAX_REASON_LENGTH, `${path}.reason`);
      break;
    case "failed": {
      exactKeys(event, ["type", "error"], [], path);
      const error = record(event.error, `${path}.error`);
      exactKeys(error, ["code", "message", "retryable", "external_outcome"], [], `${path}.error`);
      stringValue(error.code, 1, MAX_NAME_LENGTH, `${path}.error.code`);
      stringValue(error.message, 1, MAX_ERROR_MESSAGE_LENGTH, `${path}.error.message`);
      literal(error.retryable, false, `${path}.error.retryable`);
      oneOf(error.external_outcome, ["started", "unknown"] as const, `${path}.error.external_outcome`);
      break;
    }
  }
}

export function isTerminalEvent(event: ModelEvent): event is ModelTerminalEvent {
  return event.type === "completed" || event.type === "aborted" || event.type === "failed" || event.type === "ambiguous";
}

/** Reasoning deltas may be displayed live but must not be persisted as transcript content. */
export function isEphemeralModelEvent(event: ModelEvent): boolean {
  return event.type === "reasoning_delta";
}

function validateHeartbeatParams(value: unknown): void {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "connection_id", "nonce", "sent_at_ms"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.connection_id, "$frame.params.connection_id");
  identifier(params.nonce, "$frame.params.nonce");
  integer(params.sent_at_ms, 0, Number.MAX_SAFE_INTEGER, "$frame.params.sent_at_ms");
}

function validateResultResponse(frame: Record<string, unknown>): void {
  exactKeys(frame, ["jsonrpc", "id", "result"], [], "$frame");
  identifier(frame.id, "$frame.id");
  const result = record(frame.result, "$frame.result");
  oneOf(result.type, ["bridge.hello", "model.accepted", "model.cancelled", "model.status"] as const, "$frame.result.type");
  switch (result.type) {
    case "bridge.hello":
      exactKeys(result, ["schema_version", "type", "connection_id", "status", "capabilities"], [], "$frame.result");
      schemaVersion(result, "$frame.result");
      identifier(result.connection_id, "$frame.result.connection_id");
      literal(result.status, "ready", "$frame.result.status");
      validateCapabilities(result.capabilities, "$frame.result.capabilities");
      break;
    case "model.accepted":
      exactKeys(result, ["schema_version", "type", "request_id", "request_digest", "status"], [], "$frame.result");
      schemaVersion(result, "$frame.result");
      identifier(result.request_id, "$frame.result.request_id");
      requestDigest(result.request_digest, "$frame.result.request_digest");
      literal(result.status, "accepted", "$frame.result.status");
      break;
    case "model.cancelled":
      exactKeys(result, ["schema_version", "type", "request_id", "request_digest", "status"], [], "$frame.result");
      schemaVersion(result, "$frame.result");
      identifier(result.request_id, "$frame.result.request_id");
      requestDigest(result.request_digest, "$frame.result.request_digest");
      oneOf(result.status, ["cancel_requested", "already_terminal", "not_found"] as const, "$frame.result.status");
      break;
    case "model.status":
      validateStatusResult(result);
      break;
  }
}

function validateStatusResult(result: Record<string, unknown>): void {
  exactKeys(result, ["schema_version", "type", "request_id", "request_digest", "status", "last_sequence"], ["terminal"], "$frame.result");
  schemaVersion(result, "$frame.result");
  identifier(result.request_id, "$frame.result.request_id");
  requestDigest(result.request_digest, "$frame.result.request_digest");
  oneOf(result.status, ["unknown", "accepted", "streaming", "completed", "aborted", "failed", "ambiguous"] as const, "$frame.result.status");
  integer(result.last_sequence, 0, Number.MAX_SAFE_INTEGER, "$frame.result.last_sequence");
  const terminalStatus = result.status === "completed" || result.status === "aborted" || result.status === "failed" || result.status === "ambiguous";
  if (terminalStatus !== hasOwn(result, "terminal")) fail("INVALID_VALUE", "$frame.result.terminal");
  if ((result.status === "unknown" || result.status === "accepted") && result.last_sequence !== 0) {
    fail("INVALID_VALUE", "$frame.result.last_sequence");
  }
  if ((result.status === "streaming" || terminalStatus) && result.last_sequence === 0) {
    fail("INVALID_VALUE", "$frame.result.last_sequence");
  }
  if (terminalStatus) {
    validateModelEvent(result.terminal, "$frame.result.terminal");
    if (!isTerminalEvent(result.terminal as ModelEvent) || (result.terminal as ModelTerminalEvent).type !== result.status) {
      fail("INVALID_VALUE", "$frame.result.terminal");
    }
  }
}

function validateErrorResponse(frame: Record<string, unknown>): void {
  exactKeys(frame, ["jsonrpc", "id", "error"], [], "$frame");
  if (frame.id !== null) identifier(frame.id, "$frame.id");
  const error = record(frame.error, "$frame.error");
  exactKeys(error, ["code", "message", "data"], [], "$frame.error");
  integer(error.code, -32_768, -1, "$frame.error.code");
  stringValue(error.message, 1, MAX_ERROR_MESSAGE_LENGTH, "$frame.error.message");
  {
    const data = record(error.data, "$frame.error.data");
    exactKeys(data, ["schema_version", "error_code", "retryable", "external_outcome"], ["request_id", "request_digest"], "$frame.error.data");
    schemaVersion(data, "$frame.error.data");
    stringValue(data.error_code, 1, MAX_NAME_LENGTH, "$frame.error.data.error_code");
    bool(data.retryable, "$frame.error.data.retryable");
    oneOf(data.external_outcome, ["not_started", "started", "unknown"] as const, "$frame.error.data.external_outcome");
    if (data.retryable === true && data.external_outcome !== "not_started") {
      fail("INVALID_VALUE", "$frame.error.data.retryable");
    }
    if (hasOwn(data, "request_id")) identifier(data.request_id, "$frame.error.data.request_id");
    if (hasOwn(data, "request_digest")) requestDigest(data.request_digest, "$frame.error.data.request_digest");
    if (hasOwn(data, "request_id") !== hasOwn(data, "request_digest")) fail("INVALID_VALUE", "$frame.error.data");
  }
}

export { ProtocolValidationError };
