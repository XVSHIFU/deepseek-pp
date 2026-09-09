// src/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { ReasoningEffortId as ReasoningEffortId2 } from "@deepseek-ai/dsh-llm";

// ../dsh-llm-deepseek-web/src/adapter.ts
import {
  LlmAdapter,
  LlmError as LlmError3,
  LOCAL_REQUEST_BUDGET_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
  resolveRetryPolicy
} from "@deepseek-ai/dsh-llm";

// ../dsh-web-model-transport/src/broker.ts
var BrokerError = class extends Error {
  code;
  externalOutcome;
  remoteCode;
  constructor(code, externalOutcome, remoteCode) {
    super(code);
    this.name = "BrokerError";
    this.code = code;
    this.externalOutcome = externalOutcome;
    if (remoteCode && [
      "DEEPSEEK_AUTH_REQUIRED",
      "DEEPSEEK_PREPARATION_FAILED",
      "MODEL_PREPARATION_FAILED",
      "BROKER_BUSY",
      "SESSION_QUARANTINED",
      "SESSION_BUSY",
      "CAPACITY_EXCEEDED",
      "REQUEST_CAPACITY_EXCEEDED",
      "DUPLICATE_REQUEST",
      "REQUEST_IDENTITY_MISMATCH",
      "REASONING_NOT_NEGOTIATED",
      "REASONING_CALLBACK_REQUIRED",
      "REQUEST_ABORTED"
    ].includes(remoteCode)) this.remoteCode = remoteCode;
  }
};

// ../dsh-web-model-transport/src/host.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { createServer } from "node:http";
import { TextDecoder } from "node:util";

// ../web-model-protocol/src/constants.ts
var PROTOCOL_VERSION = 1;
var JSON_RPC_VERSION = "2.0";
var MAX_FRAME_BYTES = 1024 * 1024;
var MAX_STRUCTURE_DEPTH = 32;
var MAX_STRUCTURE_NODES = 65536;
var MAX_OBJECT_PROPERTIES = 256;
var MAX_ARRAY_LENGTH = 256;
var MAX_ID_LENGTH = 128;
var MAX_NAME_LENGTH = 128;
var MAX_VERSION_LENGTH = 128;
var MAX_REASON_LENGTH = 4096;
var MAX_DESCRIPTION_LENGTH = 16384;
var MAX_TEXT_LENGTH = 262144;
var MAX_ERROR_MESSAGE_LENGTH = 4096;
var MAX_MESSAGES = 128;
var MAX_CONTENT_BLOCKS = 128;
var MAX_TOOLS = 128;
var MAX_TIMEOUT_MS = 30 * 60 * 1e3;

// ../web-model-protocol/src/validation.ts
var ProtocolValidationError = class extends Error {
  code;
  path;
  constructor(code, path2 = "$") {
    super(`${code} at ${path2}`);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path2;
  }
};
function fail(code, path2) {
  throw new ProtocolValidationError(code, path2);
}
function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function record(value, path2) {
  if (!isRecord(value)) fail("INVALID_TYPE", path2);
  return value;
}
function exactKeys(value, required, optional, path2) {
  const allowedCount = required.length + optional.length;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > allowedCount) fail("UNKNOWN_FIELD", path2);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  for (const key of keys) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `${path2}.${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail("INVALID_VALUE", `${path2}.${key}`);
  }
}
function literal(value, expected, path2) {
  if (value !== expected) {
    if (path2.endsWith("schema_version") && typeof value === "number") fail("UNSUPPORTED_VERSION", path2);
    fail("INVALID_VALUE", path2);
  }
}
function oneOf(value, allowed, path2) {
  if (typeof value !== "string" || !allowed.includes(value)) fail("INVALID_VALUE", path2);
}
function bool(value, path2) {
  if (typeof value !== "boolean") fail("INVALID_TYPE", path2);
}
function integer(value, minimum, maximum, path2) {
  if (!Number.isSafeInteger(value)) fail("INVALID_TYPE", path2);
  if (value < minimum || value > maximum) fail("OUT_OF_RANGE", path2);
}
function stringValue(value, minimumLength, maximumLength, path2) {
  if (typeof value !== "string") fail("INVALID_TYPE", path2);
  if (value.length < minimumLength || value.length > maximumLength) fail("OUT_OF_RANGE", path2);
  assertWellFormedUnicode(value, path2);
}
function identifier(value, path2) {
  stringValue(value, 1, MAX_ID_LENGTH, path2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail("INVALID_VALUE", path2);
}
function arrayValue(value, maximum, path2) {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path2);
  if (value.length > Math.min(maximum, MAX_ARRAY_LENGTH)) fail("ARRAY_TOO_LONG", path2);
  return value;
}
function assertWellFormedUnicode(value, path2) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343)) fail("INVALID_UNICODE", path2);
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) {
      fail("INVALID_UNICODE", path2);
    }
  }
}
function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 127) bytes += 1;
    else if (unit <= 2047) bytes += 2;
    else if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343)) fail("INVALID_UNICODE", "$frame");
      bytes += 4;
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) {
      fail("INVALID_UNICODE", "$frame");
    } else bytes += 3;
  }
  return bytes;
}
function assertJsonStructure(value) {
  const queue = [{ value, depth: 0, path: "$" }];
  let cursor = 0;
  let nodes = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES) fail("STRUCTURE_TOO_LARGE", current.path);
    if (current.depth > MAX_STRUCTURE_DEPTH) fail("STRUCTURE_TOO_DEEP", current.path);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("INVALID_TYPE", current.path);
      continue;
    }
    if (typeof item === "string") {
      assertWellFormedUnicode(item, current.path);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length > MAX_ARRAY_LENGTH) fail("ARRAY_TOO_LONG", current.path);
      for (let index = 0; index < item.length; index += 1) {
        queue.push({ value: item[index], depth: current.depth + 1, path: `${current.path}[${index}]` });
      }
      continue;
    }
    if (!isRecord(item)) fail("INVALID_TYPE", current.path);
    const entries = Object.entries(item);
    if (entries.length > MAX_OBJECT_PROPERTIES) fail("STRUCTURE_TOO_LARGE", current.path);
    for (const [key, child] of entries) {
      assertWellFormedUnicode(key, current.path);
      queue.push({ value: child, depth: current.depth + 1, path: `${current.path}.${key}` });
    }
  }
}
function jsonObject(value, path2) {
  if (!isRecord(value)) fail("INVALID_TYPE", path2);
}

// ../web-model-protocol/src/codec.ts
var hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function decodeWebModelFrame(serialized) {
  if (typeof serialized !== "string") fail("INVALID_TYPE", "$frame");
  if (utf8ByteLength(serialized) > MAX_FRAME_BYTES) fail("FRAME_TOO_LARGE", "$frame");
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("INVALID_JSON", "$frame");
  }
  return validateWebModelFrame(value);
}
function encodeWebModelFrame(value) {
  const frame = validateWebModelFrame(value);
  const serialized = JSON.stringify(frame);
  if (utf8ByteLength(serialized) > MAX_FRAME_BYTES) fail("FRAME_TOO_LARGE", "$frame");
  return serialized;
}
function validateWebModelFrame(value) {
  assertJsonStructure(value);
  const frame = record(value, "$frame");
  literal(frame.jsonrpc, JSON_RPC_VERSION, "$frame.jsonrpc");
  if (hasOwn(frame, "method")) validateMethodFrame(frame);
  else if (hasOwn(frame, "error")) validateErrorResponse(frame);
  else if (hasOwn(frame, "result")) validateResultResponse(frame);
  else fail("INVALID_VALUE", "$frame");
  return value;
}
function validateMethodFrame(frame) {
  const method = frame.method;
  oneOf(method, ["bridge.hello", "model.generate", "model.cancel", "model.query", "model.event", "bridge.heartbeat"], "$frame.method");
  const isNotification = method === "model.event" || method === "bridge.heartbeat";
  exactKeys(frame, isNotification ? ["jsonrpc", "method", "params"] : ["jsonrpc", "id", "method", "params"], [], "$frame");
  if (!isNotification) identifier(frame.id, "$frame.id");
  switch (method) {
    case "bridge.hello":
      validateHelloParams(frame.params);
      break;
    case "model.generate":
      validateGenerateParams(frame.params);
      break;
    case "model.cancel":
      validateCancelParams(frame.params);
      break;
    case "model.query":
      validateQueryParams(frame.params);
      break;
    case "model.event":
      validateEventParams(frame.params);
      break;
    case "bridge.heartbeat":
      validateHeartbeatParams(frame.params);
      break;
  }
}
function schemaVersion(value, path2) {
  literal(value.schema_version, PROTOCOL_VERSION, `${path2}.schema_version`);
}
function requestDigest(value, path2) {
  stringValue(value, 64, 64, path2);
  if (!/^[a-f0-9]{64}$/.test(value)) fail("INVALID_VALUE", path2);
}
function validateHelloParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "pairing_token", "browser_instance_id", "client", "capabilities"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  stringValue(params.pairing_token, 43, 128, "$frame.params.pairing_token");
  if (!/^[A-Za-z0-9_-]+$/.test(params.pairing_token)) fail("INVALID_VALUE", "$frame.params.pairing_token");
  identifier(params.browser_instance_id, "$frame.params.browser_instance_id");
  const client = record(params.client, "$frame.params.client");
  exactKeys(client, ["name", "version"], [], "$frame.params.client");
  literal(client.name, "DeepSeek++", "$frame.params.client.name");
  stringValue(client.version, 1, MAX_VERSION_LENGTH, "$frame.params.client.version");
  validateCapabilities(params.capabilities, "$frame.params.capabilities");
}
function validateCapabilities(value, path2) {
  const capabilities = record(value, path2);
  exactKeys(capabilities, ["structured_tool_calls", "cancel", "query"], ["text", "reasoning", "usage"], path2);
  literal(capabilities.structured_tool_calls, true, `${path2}.structured_tool_calls`);
  literal(capabilities.cancel, true, `${path2}.cancel`);
  literal(capabilities.query, true, `${path2}.query`);
  for (const key of ["text", "reasoning", "usage"]) {
    if (hasOwn(capabilities, key)) literal(capabilities[key], true, `${path2}.${key}`);
  }
}
function validateGenerateParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(
    params,
    ["schema_version", "request_id", "session_id", "request_digest", "purpose", "model", "input", "tools", "options"],
    [],
    "$frame.params"
  );
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  identifier(params.session_id, "$frame.params.session_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
  oneOf(params.purpose, ["agent", "session-title", "compaction"], "$frame.params.purpose");
  const model = record(params.model, "$frame.params.model");
  exactKeys(model, ["provider", "model_id"], [], "$frame.params.model");
  literal(model.provider, "deepseek-web", "$frame.params.model.provider");
  literal(model.model_id, "current-web-session", "$frame.params.model.model_id");
  validateInput(params.input);
  validateTools(params.tools);
  validateOptions(params.options);
}
function validateInput(value) {
  const input = record(value, "$frame.params.input");
  exactKeys(input, ["messages"], [], "$frame.params.input");
  const messages = arrayValue(input.messages, MAX_MESSAGES, "$frame.params.input.messages");
  if (messages.length === 0) fail("OUT_OF_RANGE", "$frame.params.input.messages");
  messages.forEach((item, index) => validateMessage(item, `$frame.params.input.messages[${index}]`));
}
function validateMessage(value, path2) {
  const message = record(value, path2);
  exactKeys(message, ["role", "content"], [], path2);
  oneOf(message.role, ["system", "user", "assistant", "tool"], `${path2}.role`);
  const content = arrayValue(message.content, MAX_CONTENT_BLOCKS, `${path2}.content`);
  if (content.length === 0) fail("OUT_OF_RANGE", `${path2}.content`);
  content.forEach((block, index) => validateContentBlock(block, message.role, `${path2}.content[${index}]`));
}
function validateContentBlock(value, role, path2) {
  const block = record(value, path2);
  oneOf(block.type, ["text", "tool_call", "tool_result"], `${path2}.type`);
  switch (block.type) {
    case "text":
      exactKeys(block, ["type", "text"], [], path2);
      stringValue(block.text, 1, MAX_TEXT_LENGTH, `${path2}.text`);
      if (role === "tool") fail("INVALID_VALUE", path2);
      break;
    case "tool_call":
      exactKeys(block, ["type", "tool_call_id", "name", "arguments"], [], path2);
      identifier(block.tool_call_id, `${path2}.tool_call_id`);
      stringValue(block.name, 1, MAX_NAME_LENGTH, `${path2}.name`);
      jsonObject(block.arguments, `${path2}.arguments`);
      if (role !== "assistant") fail("INVALID_VALUE", path2);
      break;
    case "tool_result": {
      exactKeys(block, ["type", "tool_call_id", "content", "is_error"], [], path2);
      identifier(block.tool_call_id, `${path2}.tool_call_id`);
      bool(block.is_error, `${path2}.is_error`);
      if (role !== "tool") fail("INVALID_VALUE", path2);
      const results = arrayValue(block.content, MAX_CONTENT_BLOCKS, `${path2}.content`);
      results.forEach((result, index) => {
        const text = record(result, `${path2}.content[${index}]`);
        exactKeys(text, ["type", "text"], [], `${path2}.content[${index}]`);
        literal(text.type, "text", `${path2}.content[${index}].type`);
        stringValue(text.text, 1, MAX_TEXT_LENGTH, `${path2}.content[${index}].text`);
      });
      break;
    }
  }
}
function validateTools(value) {
  const tools = arrayValue(value, MAX_TOOLS, "$frame.params.tools");
  const names = /* @__PURE__ */ new Set();
  tools.forEach((item, index) => {
    const path2 = `$frame.params.tools[${index}]`;
    const tool = record(item, path2);
    exactKeys(tool, ["name", "description", "input_schema"], [], path2);
    stringValue(tool.name, 1, MAX_NAME_LENGTH, `${path2}.name`);
    if (names.has(tool.name)) fail("INVALID_VALUE", `${path2}.name`);
    names.add(tool.name);
    stringValue(tool.description, 1, MAX_DESCRIPTION_LENGTH, `${path2}.description`);
    jsonObject(tool.input_schema, `${path2}.input_schema`);
  });
}
function validateOptions(value) {
  const options = record(value, "$frame.params.options");
  exactKeys(
    options,
    ["thinking_enabled", "search_enabled", "model_type"],
    ["timeout_ms"],
    "$frame.params.options"
  );
  bool(options.thinking_enabled, "$frame.params.options.thinking_enabled");
  bool(options.search_enabled, "$frame.params.options.search_enabled");
  oneOf(options.model_type, ["default", "expert", "vision"], "$frame.params.options.model_type");
  if (hasOwn(options, "timeout_ms")) integer(options.timeout_ms, 1, MAX_TIMEOUT_MS, "$frame.params.options.timeout_ms");
}
function validateCancelParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "request_digest"], ["reason"], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
  if (hasOwn(params, "reason")) stringValue(params.reason, 1, MAX_REASON_LENGTH, "$frame.params.reason");
}
function validateQueryParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "request_digest"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  requestDigest(params.request_digest, "$frame.params.request_digest");
}
function validateEventParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "request_id", "sequence", "event"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.request_id, "$frame.params.request_id");
  integer(params.sequence, 1, Number.MAX_SAFE_INTEGER, "$frame.params.sequence");
  validateModelEvent(params.event, "$frame.params.event");
}
function validateModelEvent(value, path2) {
  const event = record(value, path2);
  oneOf(
    event.type,
    ["text_delta", "reasoning_delta", "tool_call", "usage", "completed", "aborted", "failed", "ambiguous"],
    `${path2}.type`
  );
  switch (event.type) {
    case "text_delta":
      exactKeys(event, ["type", "text"], [], path2);
      stringValue(event.text, 1, MAX_TEXT_LENGTH, `${path2}.text`);
      break;
    case "reasoning_delta":
      exactKeys(event, ["type", "text", "retention"], [], path2);
      stringValue(event.text, 1, MAX_TEXT_LENGTH, `${path2}.text`);
      literal(event.retention, "ephemeral", `${path2}.retention`);
      break;
    case "tool_call":
      exactKeys(event, ["type", "tool_call_id", "name", "arguments"], [], path2);
      identifier(event.tool_call_id, `${path2}.tool_call_id`);
      stringValue(event.name, 1, MAX_NAME_LENGTH, `${path2}.name`);
      jsonObject(event.arguments, `${path2}.arguments`);
      break;
    case "usage":
      exactKeys(event, ["type", "input_tokens", "output_tokens"], ["cache_read_tokens", "cache_write_tokens"], path2);
      integer(event.input_tokens, 0, Number.MAX_SAFE_INTEGER, `${path2}.input_tokens`);
      integer(event.output_tokens, 0, Number.MAX_SAFE_INTEGER, `${path2}.output_tokens`);
      if (hasOwn(event, "cache_read_tokens")) integer(event.cache_read_tokens, 0, Number.MAX_SAFE_INTEGER, `${path2}.cache_read_tokens`);
      if (hasOwn(event, "cache_write_tokens")) integer(event.cache_write_tokens, 0, Number.MAX_SAFE_INTEGER, `${path2}.cache_write_tokens`);
      break;
    case "completed":
      exactKeys(event, ["type", "finish_reason"], [], path2);
      oneOf(event.finish_reason, ["stop", "length", "tool_calls"], `${path2}.finish_reason`);
      break;
    case "aborted":
    case "ambiguous":
      exactKeys(event, ["type", "reason"], [], path2);
      stringValue(event.reason, 1, MAX_REASON_LENGTH, `${path2}.reason`);
      break;
    case "failed": {
      exactKeys(event, ["type", "error"], [], path2);
      const error = record(event.error, `${path2}.error`);
      exactKeys(error, ["code", "message", "retryable", "external_outcome"], [], `${path2}.error`);
      stringValue(error.code, 1, MAX_NAME_LENGTH, `${path2}.error.code`);
      stringValue(error.message, 1, MAX_ERROR_MESSAGE_LENGTH, `${path2}.error.message`);
      literal(error.retryable, false, `${path2}.error.retryable`);
      oneOf(error.external_outcome, ["started", "unknown"], `${path2}.error.external_outcome`);
      break;
    }
  }
}
function isTerminalEvent(event) {
  return event.type === "completed" || event.type === "aborted" || event.type === "failed" || event.type === "ambiguous";
}
function validateHeartbeatParams(value) {
  const params = record(value, "$frame.params");
  exactKeys(params, ["schema_version", "connection_id", "nonce", "sent_at_ms"], [], "$frame.params");
  schemaVersion(params, "$frame.params");
  identifier(params.connection_id, "$frame.params.connection_id");
  identifier(params.nonce, "$frame.params.nonce");
  integer(params.sent_at_ms, 0, Number.MAX_SAFE_INTEGER, "$frame.params.sent_at_ms");
}
function validateResultResponse(frame) {
  exactKeys(frame, ["jsonrpc", "id", "result"], [], "$frame");
  identifier(frame.id, "$frame.id");
  const result = record(frame.result, "$frame.result");
  oneOf(result.type, ["bridge.hello", "model.accepted", "model.cancelled", "model.status"], "$frame.result.type");
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
      oneOf(result.status, ["cancel_requested", "already_terminal", "not_found"], "$frame.result.status");
      break;
    case "model.status":
      validateStatusResult(result);
      break;
  }
}
function validateStatusResult(result) {
  exactKeys(result, ["schema_version", "type", "request_id", "request_digest", "status", "last_sequence"], ["terminal"], "$frame.result");
  schemaVersion(result, "$frame.result");
  identifier(result.request_id, "$frame.result.request_id");
  requestDigest(result.request_digest, "$frame.result.request_digest");
  oneOf(result.status, ["unknown", "accepted", "streaming", "completed", "aborted", "failed", "ambiguous"], "$frame.result.status");
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
    if (!isTerminalEvent(result.terminal) || result.terminal.type !== result.status) {
      fail("INVALID_VALUE", "$frame.result.terminal");
    }
  }
}
function validateErrorResponse(frame) {
  exactKeys(frame, ["jsonrpc", "id", "error"], [], "$frame");
  if (frame.id !== null) identifier(frame.id, "$frame.id");
  const error = record(frame.error, "$frame.error");
  exactKeys(error, ["code", "message", "data"], [], "$frame.error");
  integer(error.code, -32768, -1, "$frame.error.code");
  stringValue(error.message, 1, MAX_ERROR_MESSAGE_LENGTH, "$frame.error.message");
  {
    const data = record(error.data, "$frame.error.data");
    exactKeys(data, ["schema_version", "error_code", "retryable", "external_outcome"], ["request_id", "request_digest"], "$frame.error.data");
    schemaVersion(data, "$frame.error.data");
    stringValue(data.error_code, 1, MAX_NAME_LENGTH, "$frame.error.data.error_code");
    bool(data.retryable, "$frame.error.data.retryable");
    oneOf(data.external_outcome, ["not_started", "started", "unknown"], "$frame.error.data.external_outcome");
    if (data.retryable === true && data.external_outcome !== "not_started") {
      fail("INVALID_VALUE", "$frame.error.data.retryable");
    }
    if (hasOwn(data, "request_id")) identifier(data.request_id, "$frame.error.data.request_id");
    if (hasOwn(data, "request_digest")) requestDigest(data.request_digest, "$frame.error.data.request_digest");
    if (hasOwn(data, "request_id") !== hasOwn(data, "request_digest")) fail("INVALID_VALUE", "$frame.error.data");
  }
}

// ../web-model-protocol/src/sequence-validator.ts
var ProtocolSequenceError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "ProtocolSequenceError";
    this.code = code;
  }
};
var WebModelSequenceValidator = class {
  pending = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  retryableGenerateDigests = /* @__PURE__ */ new Map();
  firstFrameSeen = false;
  ready = false;
  helloId;
  offeredCapabilities;
  negotiatedCapabilities;
  connectionId;
  accept(input, sender) {
    if (sender !== "browser" && sender !== "host") throw new ProtocolSequenceError("DIRECTION_MISMATCH");
    const frame = validateWebModelFrame(input);
    if (!this.firstFrameSeen) {
      if (!("method" in frame) || frame.method !== "bridge.hello") {
        throw new ProtocolSequenceError("FIRST_FRAME_MUST_BE_HELLO");
      }
      if (sender !== "browser") throw new ProtocolSequenceError("DIRECTION_MISMATCH");
    }
    this.assertDirection(frame, sender);
    this.firstFrameSeen = true;
    if ("method" in frame) {
      if ("id" in frame) this.acceptRequest(frame, sender);
      else this.acceptNotification(frame);
    } else {
      this.acceptResponse(frame);
    }
    return frame;
  }
  decodeAndAccept(serialized, sender) {
    return this.accept(decodeWebModelFrame(serialized), sender);
  }
  /** Restores only a fully observed remote checkpoint after a new handshake. */
  hydrateRequestCheckpoint(input) {
    this.assertReady();
    const envelope = validateWebModelFrame({
      jsonrpc: "2.0",
      id: "checkpoint-hydration",
      result: { schema_version: 1, type: "model.status", ...input }
    });
    const checkpoint = envelope.result;
    if (checkpoint.status === "unknown") throw new ProtocolSequenceError("SEQUENCE_GAP");
    const current = this.requests.get(checkpoint.request_id);
    if (current) {
      if (current.requestDigest !== checkpoint.request_digest) {
        throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
      }
      if (current.status !== checkpoint.status || current.lastSequence !== checkpoint.last_sequence || !sameOptionalTerminal(current.terminal, checkpoint.terminal)) {
        throw new ProtocolSequenceError(current.terminal ? "TERMINAL_MISMATCH" : "SEQUENCE_GAP");
      }
      current.accepted = true;
      return;
    }
    this.requests.set(checkpoint.request_id, {
      requestDigest: checkpoint.request_digest,
      accepted: true,
      status: checkpoint.status,
      lastSequence: checkpoint.last_sequence,
      ...checkpoint.terminal === void 0 ? {} : { terminal: checkpoint.terminal }
    });
  }
  /**
   * Receiver-owned recovery fence, not a wire capability. A journal owner may
   * query an interrupted request across missing frames, but cannot consume
   * model.event or resubmit that identity on this connection afterwards.
   */
  allowStatusSnapshot(requestId, requestDigest2) {
    this.assertReady();
    validateWebModelFrame({
      jsonrpc: "2.0",
      id: "status-snapshot-validation",
      method: "model.query",
      params: { schema_version: 1, request_id: requestId, request_digest: requestDigest2 }
    });
    const current = this.requests.get(requestId);
    if (current && current.requestDigest !== requestDigest2) {
      throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
    }
    if (current) current.statusOnly = true;
    else this.requests.set(requestId, {
      requestDigest: requestDigest2,
      accepted: false,
      status: "accepted",
      lastSequence: 0,
      statusOnly: true
    });
  }
  assertDirection(frame, sender) {
    if ("method" in frame) {
      const expected2 = frame.method === "bridge.hello" || frame.method === "model.event" || frame.method === "bridge.heartbeat" ? "browser" : "host";
      if (sender !== expected2) throw new ProtocolSequenceError("DIRECTION_MISMATCH");
      return;
    }
    if (frame.id === null) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    const expected = pending.sender === "browser" ? "host" : "browser";
    if (sender !== expected) throw new ProtocolSequenceError("DIRECTION_MISMATCH");
  }
  acceptRequest(frame, sender) {
    if (this.pending.has(frame.id)) throw new ProtocolSequenceError("DUPLICATE_REQUEST");
    if (frame.method === "bridge.hello") {
      if (this.helloId !== void 0 || this.ready) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
      this.helloId = frame.id;
      this.offeredCapabilities = frame.params.capabilities;
      this.pending.set(frame.id, { method: "bridge.hello", sender });
      return;
    }
    this.assertReady();
    const current = this.requests.get(frame.params.request_id);
    if (frame.method === "model.generate") {
      if (current) throw new ProtocolSequenceError("DUPLICATE_REQUEST");
      const retryableDigest = this.retryableGenerateDigests.get(frame.params.request_id);
      if (retryableDigest !== void 0 && retryableDigest !== frame.params.request_digest) {
        throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
      }
      this.retryableGenerateDigests.delete(frame.params.request_id);
      this.requests.set(frame.params.request_id, {
        requestDigest: frame.params.request_digest,
        accepted: false,
        status: "accepted",
        lastSequence: 0
      });
    } else if (current && current.requestDigest !== frame.params.request_digest) {
      throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
    }
    this.pending.set(frame.id, {
      method: frame.method,
      sender,
      requestId: frame.params.request_id,
      requestDigest: frame.params.request_digest
    });
  }
  acceptNotification(frame) {
    this.assertReady();
    if (frame.method === "bridge.heartbeat") {
      if (frame.params.connection_id !== this.connectionId) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
      return;
    }
    if (frame.method !== "model.event") throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    const state = this.requests.get(frame.params.request_id);
    if (state?.statusOnly) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    if (!state || !state.accepted) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
    if (state.terminal !== void 0) throw new ProtocolSequenceError("EVENT_AFTER_TERMINAL");
    if (frame.params.sequence <= state.lastSequence) throw new ProtocolSequenceError("NON_MONOTONIC_SEQUENCE");
    if (frame.params.sequence !== state.lastSequence + 1) throw new ProtocolSequenceError("SEQUENCE_GAP");
    this.assertEventCapability(frame.params.event);
    state.lastSequence = frame.params.sequence;
    if (isTerminalEvent(frame.params.event)) {
      state.terminal = frame.params.event;
      state.status = frame.params.event.type;
    } else {
      state.status = "streaming";
    }
  }
  acceptResponse(frame) {
    if (frame.id === null) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
    const pending = this.pending.get(frame.id);
    if (!pending) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
    if ("error" in frame) {
      const data = frame.error.data;
      if (pending.method === "bridge.hello") {
        if (data.request_id !== void 0 || data.request_digest !== void 0) {
          throw new ProtocolSequenceError("UNEXPECTED_FRAME");
        }
      } else {
        if (data.request_id !== pending.requestId) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
        if (data.request_digest !== pending.requestDigest) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
        if (pending.method === "model.generate" && pending.requestId !== void 0 && pending.requestDigest !== void 0) {
          if (data.external_outcome === "not_started") {
            this.requests.delete(pending.requestId);
            this.retryableGenerateDigests.set(pending.requestId, pending.requestDigest);
          }
        }
      }
      this.pending.delete(frame.id);
      return;
    }
    const expectedType = {
      "bridge.hello": "bridge.hello",
      "model.generate": "model.accepted",
      "model.cancel": "model.cancelled",
      "model.query": "model.status"
    }[pending.method];
    if (frame.result.type !== expectedType) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    if (pending.method === "bridge.hello" && frame.result.type === "bridge.hello") {
      if (frame.id !== this.helloId) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
      this.assertNegotiatedSubset(frame.result.capabilities);
      this.negotiatedCapabilities = frame.result.capabilities;
      this.connectionId = frame.result.connection_id;
      this.ready = true;
    } else if (pending.method === "model.generate" && frame.result.type === "model.accepted") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
      const state = this.requests.get(frame.result.request_id);
      if (!state) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
      state.accepted = true;
    } else if (pending.method === "model.cancel" && frame.result.type === "model.cancelled") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
    } else if (pending.method === "model.query" && frame.result.type === "model.status") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
      this.observeQueryResult(
        frame.result.request_id,
        frame.result.request_digest,
        frame.result.status,
        frame.result.last_sequence,
        frame.result.terminal
      );
    } else {
      throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    }
    this.pending.delete(frame.id);
  }
  assertRequestIdentity(requestId, requestDigest2, pending) {
    if (requestId !== pending.requestId) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
    if (requestDigest2 !== pending.requestDigest) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
  }
  observeQueryResult(requestId, requestDigest2, status, lastSequence, terminal) {
    const current = this.requests.get(requestId);
    if (current && current.requestDigest !== requestDigest2) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
    if (current?.terminal) {
      if (status !== current.status || lastSequence !== current.lastSequence || terminal === void 0 || !sameTerminal(current.terminal, terminal)) {
        throw new ProtocolSequenceError("TERMINAL_MISMATCH");
      }
      return;
    }
    if (current?.statusOnly) {
      if (status === "unknown") return;
      if (lastSequence < current.lastSequence) {
        throw new ProtocolSequenceError("NON_MONOTONIC_SEQUENCE");
      }
      if (current.status === "streaming" && status === "accepted" || terminal !== void 0 && lastSequence <= current.lastSequence) {
        throw new ProtocolSequenceError("SEQUENCE_GAP");
      }
      current.accepted = true;
      current.status = status;
      current.lastSequence = lastSequence;
      if (terminal !== void 0) current.terminal = terminal;
      return;
    }
    if (!current) {
      if (status === "unknown") return;
      if (status !== "accepted" || lastSequence !== 0 || terminal !== void 0) {
        throw new ProtocolSequenceError("SEQUENCE_GAP");
      }
      this.requests.set(requestId, {
        requestDigest: requestDigest2,
        accepted: true,
        status: "accepted",
        lastSequence: 0
      });
      return;
    }
    if (status === current.status && lastSequence === current.lastSequence && terminal === void 0) {
      current.accepted = true;
      return;
    }
    if (terminal !== void 0 && lastSequence === current.lastSequence + 1 && status === terminal.type) {
      current.accepted = true;
      current.status = status;
      current.lastSequence = lastSequence;
      current.terminal = terminal;
      return;
    }
    throw new ProtocolSequenceError("SEQUENCE_GAP");
  }
  assertNegotiatedSubset(negotiated) {
    const offered = this.offeredCapabilities;
    if (!offered) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
    for (const capability of ["text", "reasoning", "structured_tool_calls", "usage", "cancel", "query"]) {
      if (negotiated[capability] === true && offered[capability] !== true) {
        throw new ProtocolSequenceError("CAPABILITY_NOT_OFFERED");
      }
    }
  }
  assertReady() {
    if (!this.ready) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
  }
  assertEventCapability(event) {
    const supported = this.negotiatedCapabilities;
    if (!supported) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
    if (event.type === "text_delta" && supported.text !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "reasoning_delta" && supported.reasoning !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "usage" && supported.usage !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "tool_call" && supported.structured_tool_calls !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
  }
};
function sameTerminal(left, right) {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "completed":
      return right.type === "completed" && left.finish_reason === right.finish_reason;
    case "aborted":
    case "ambiguous":
      return right.type === left.type && left.reason === right.reason;
    case "failed":
      return right.type === "failed" && left.error.code === right.error.code && left.error.message === right.error.message && left.error.retryable === right.error.retryable && left.error.external_outcome === right.error.external_outcome;
  }
}
function sameOptionalTerminal(left, right) {
  if (left === void 0 || right === void 0) return left === right;
  return sameTerminal(left, right);
}

// ../web-model-protocol/src/completion-diagnostic.ts
var PREFIX = "deepseek_stream_incomplete";
var KINDS = /* @__PURE__ */ new Set(["empty", "json_error", "json", "sse_error", "sse", "other"]);
var FIELDS = ["bodyBytes", "bizCode", "code", "contentKind", "httpStatus", "sseEvents"].sort().join(",");
var V2_FIELDS = [...FIELDS.split(","), "sseJsonEvents", "sseEventKindMask", "sseShapeMask"].sort().join(",");
var boundedInteger = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function completionDiagnosticReason(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return PREFIX;
  const record2 = value;
  const keys = Object.keys(record2).sort().join(",");
  const isV2 = keys === V2_FIELDS;
  if (keys !== FIELDS && !isV2 || !boundedInteger(record2.httpStatus, 100, 599) || typeof record2.contentKind !== "string" || !KINDS.has(record2.contentKind) || !boundedInteger(record2.bodyBytes, 0, 4 * 1024 * 1024) || !boundedInteger(record2.sseEvents, 0, 4 * 1024 * 1024) || record2.code !== null && !boundedInteger(record2.code, 0, 999999) || record2.bizCode !== null && !boundedInteger(record2.bizCode, 0, 999999)) return PREFIX;
  if (isV2 && (!boundedInteger(record2.sseJsonEvents, 0, record2.sseEvents) || !boundedInteger(record2.sseEventKindMask, 0, 255) || !boundedInteger(record2.sseShapeMask, 0, 65535))) return PREFIX;
  const base = `${PREFIX}.v${isV2 ? 2 : 1}:h${record2.httpStatus}:${record2.contentKind}:b${record2.bodyBytes}:e${record2.sseEvents}:c${record2.code ?? "n"}:biz${record2.bizCode ?? "n"}`;
  return isV2 ? `${base}:j${record2.sseJsonEvents}:k${record2.sseEventKindMask}:s${record2.sseShapeMask}` : base;
}
function isCompletionDiagnosticReason(value) {
  if (typeof value !== "string" || value.length > 220) return false;
  const match = /^deepseek_stream_incomplete\.v([12]):h([0-9]{3}):(empty|json_error|json|sse_error|sse|other):b([0-9]{1,7}):e([0-9]{1,7}):c(n|[0-9]{1,6}):biz(n|[0-9]{1,6})(?::j([0-9]{1,7}):k([0-9]{1,3}):s([0-9]{1,5}))?$/.exec(value);
  if (!match) return false;
  if (match[1] === "2" !== (match[8] !== void 0)) return false;
  return completionDiagnosticReason({
    httpStatus: Number(match[2]),
    contentKind: match[3],
    bodyBytes: Number(match[4]),
    sseEvents: Number(match[5]),
    code: match[6] === "n" ? null : Number(match[6]),
    bizCode: match[7] === "n" ? null : Number(match[7]),
    ...match[1] === "2" ? {
      sseJsonEvents: Number(match[8]),
      sseEventKindMask: Number(match[9]),
      sseShapeMask: Number(match[10])
    } : {}
  }) === value;
}

// ../dsh-web-model-transport/src/host.ts
import WebSocket, { WebSocketServer } from "ws";

// ../dsh-web-model-transport/src/async-queue.ts
var AsyncQueue = class {
  values = [];
  waiters = [];
  maximumBufferedValues;
  closed = false;
  constructor(maximumBufferedValues) {
    this.maximumBufferedValues = maximumBufferedValues;
  }
  push(value) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (this.values.length >= this.maximumBufferedValues) return false;
    this.values.push(value);
    return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: void 0 });
  }
  finishWith(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      this.values.push(value);
    }
    this.close();
  }
  async next() {
    const value = this.values.shift();
    if (value !== void 0) return { done: false, value };
    if (this.closed) return { done: true, value: void 0 };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
};
function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

// ../dsh-web-model-transport/src/journal.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ../dsh-web-model-transport/src/request-state.ts
import { createHash } from "node:crypto";
function terminalDigest(event) {
  const fields = event.type === "completed" ? [event.type, event.finish_reason] : event.type === "failed" ? [event.type, event.error.code, event.error.message, event.error.retryable, event.error.external_outcome] : [event.type, event.reason];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
function isFinalRecord(record2) {
  return ["completed", "failed", "aborted"].includes(record2.state);
}
function transitionRequest(record2, generation, revision, action) {
  if (record2.generation !== generation || record2.revision !== revision) throw new Error("JOURNAL_CAS_MISMATCH");
  const next = { ...record2, revision: revision + 1 };
  switch (action.type) {
    case "dispatch":
      if (record2.state !== "planned") break;
      return { ...next, state: "dispatched", outcome: "unknown" };
    case "accept":
      if (record2.state !== "dispatched") break;
      return { ...next, state: "accepted", outcome: "started", remoteStatus: "accepted" };
    case "not_started":
      if (record2.state !== "dispatched") break;
      return { ...next, state: "failed", outcome: "not_started" };
    case "disconnect":
      if (isFinalRecord(record2) || record2.state === "ambiguous") return record2;
      return { ...next, state: "ambiguous", outcome: "unknown" };
    case "cancel":
      if (record2.cancelRequested) return record2;
      return { ...next, cancelRequested: true };
    case "cancel_ack":
      if (!record2.cancelRequested) break;
      return { ...next, cancelStatus: action.status };
    case "event": {
      if (record2.state !== "accepted" && record2.state !== "streaming") break;
      if (action.sequence !== record2.sequence + 1) throw new Error("JOURNAL_SEQUENCE_MISMATCH");
      const terminal = isTerminalEvent(action.event);
      return {
        ...next,
        state: terminal ? action.event.type : "streaming",
        outcome: "started",
        sequence: action.sequence,
        remoteStatus: terminal ? action.event.type : "streaming",
        ...terminal ? { terminalDigest: terminalDigest(action.event) } : {}
      };
    }
    case "query": {
      const result = action.result;
      if (result.request_id !== record2.requestId || result.request_digest !== record2.requestDigest) break;
      if (result.status === "unknown") return record2;
      if (result.last_sequence < record2.sequence) throw new Error("JOURNAL_SEQUENCE_MISMATCH");
      if (record2.terminalDigest && (!result.terminal || terminalDigest(result.terminal) !== record2.terminalDigest || result.last_sequence !== record2.sequence)) break;
      const lostStream = !isFinalRecord(record2) && record2.state !== "ambiguous" && (result.status !== record2.remoteStatus || result.last_sequence !== record2.sequence);
      return {
        ...next,
        ...lostStream ? { state: "ambiguous", outcome: "unknown" } : {},
        remoteStatus: result.status,
        sequence: result.last_sequence,
        ...result.terminal ? { terminalDigest: terminalDigest(result.terminal) } : {}
      };
    }
  }
  throw new Error("JOURNAL_INVALID_TRANSITION");
}

// ../dsh-web-model-transport/src/journal.ts
var MAX_BYTES = 2 * 1024 * 1024;
var RECORD_KEYS = /* @__PURE__ */ new Set(["requestId", "requestDigest", "sessionId", "generation", "revision", "state", "outcome", "sequence", "remoteStatus", "terminalDigest", "cancelRequested", "cancelStatus"]);
var PHASES = ["planned", "dispatched", "accepted", "streaming", "completed", "failed", "aborted", "ambiguous"];
var RequestJournal = class {
  records = /* @__PURE__ */ new Map();
  directory;
  owner;
  ownerIdentity;
  poisoned = false;
  opened = false;
  journalPath;
  maximum;
  constructor(journalPath, maximum = 1024) {
    this.journalPath = journalPath;
    this.maximum = maximum;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024) throw new Error("INVALID_JOURNAL_LIMIT");
    if (journalPath !== void 0 && !path.isAbsolute(journalPath)) throw new Error("JOURNAL_PATH_REQUIRED");
  }
  get size() {
    return this.records.size;
  }
  get(requestId) {
    return this.records.get(requestId);
  }
  recoverable() {
    return [...this.records.values()].filter((record2) => record2.state === "ambiguous");
  }
  async open() {
    if (this.opened) throw new Error("JOURNAL_ALREADY_OPEN");
    if (this.journalPath !== void 0) {
      fs.mkdirSync(this.journalPath, { recursive: true, mode: 448 });
      if (fs.lstatSync(this.journalPath).isSymbolicLink()) throw new Error("JOURNAL_SYMLINK");
      this.directory = fs.realpathSync(this.journalPath);
      try {
        this.acquireOwner();
        const filename = path.join(this.directory, "journal.json");
        if (fs.existsSync(filename)) {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("JOURNAL_INVALID");
          this.records = decodeJournal(fs.readFileSync(filename, "utf8"), this.maximum);
        }
      } catch (error) {
        await this.close();
        throw new Error(error instanceof Error && error.message.startsWith("JOURNAL_") ? error.message : "JOURNAL_UNAVAILABLE");
      }
    }
    this.opened = true;
    const recovered = new Map(this.records);
    for (const [id, record2] of recovered) recovered.set(id, transitionRequest(record2, record2.generation, record2.revision, { type: "disconnect" }));
    this.commit(recovered);
  }
  plan(requestId, requestDigest2, sessionId) {
    this.assertReady();
    const previous = this.records.get(requestId);
    if (previous && (previous.requestDigest !== requestDigest2 || previous.sessionId !== sessionId)) throw new Error("JOURNAL_IDENTITY_MISMATCH");
    if (previous && (previous.state !== "failed" || previous.outcome !== "not_started")) throw new Error("JOURNAL_REQUEST_EXISTS");
    if (!previous && this.records.size >= this.maximum) throw new Error("JOURNAL_FULL");
    const record2 = {
      requestId,
      requestDigest: requestDigest2,
      sessionId,
      generation: (previous?.generation ?? 0) + 1,
      revision: 0,
      state: "planned",
      outcome: "not_started",
      sequence: 0,
      cancelRequested: false
    };
    validateRecord(record2);
    const next = new Map(this.records);
    next.set(requestId, Object.freeze(record2));
    this.commit(next);
    return this.records.get(requestId);
  }
  apply(requestId, generation, revision, action) {
    this.assertReady();
    const current = this.records.get(requestId);
    if (!current) throw new Error("JOURNAL_UNKNOWN_REQUEST");
    const updated = transitionRequest(current, generation, revision, action);
    if (updated === current) return current;
    const next = new Map(this.records);
    next.set(requestId, Object.freeze(updated));
    this.commit(next);
    return this.records.get(requestId);
  }
  async close() {
    if (this.owner !== void 0) {
      fs.closeSync(this.owner);
      this.owner = void 0;
      this.withOwnerGuard(() => {
        const filename = path.join(this.directory, "owner.lock");
        if (fs.readFileSync(filename, "utf8") !== this.ownerIdentity) throw new Error("JOURNAL_OWNER_CHANGED");
        fs.unlinkSync(filename);
      });
    }
    this.opened = false;
  }
  withOwnerGuard(action) {
    const guardPath = path.join(this.directory, "owner-reclaim.guard");
    let guard;
    try {
      guard = fs.openSync(guardPath, "wx", 384);
    } catch {
      throw new Error("JOURNAL_OWNER_GUARD_UNAVAILABLE");
    }
    try {
      action();
    } finally {
      fs.closeSync(guard);
      fs.unlinkSync(guardPath);
    }
  }
  acquireOwner() {
    this.withOwnerGuard(() => {
      const filename = path.join(this.directory, "owner.lock");
      if (fs.existsSync(filename)) {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("JOURNAL_OWNER_INVALID");
        const before = fs.readFileSync(filename, "utf8");
        const owner = JSON.parse(before);
        if (!owner || typeof owner !== "object" || !("pid" in owner) || !("nonce" in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(owner.nonce)) throw new Error("JOURNAL_OWNER_INVALID");
        let dead = false;
        try {
          process.kill(Number(owner.pid), 0);
        } catch (error) {
          dead = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
        if (!dead) throw new Error("JOURNAL_OWNED");
        if (fs.readFileSync(filename, "utf8") !== before) throw new Error("JOURNAL_OWNER_CHANGED");
        fs.unlinkSync(filename);
      }
      this.owner = fs.openSync(filename, "wx", 384);
      this.ownerIdentity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
      fs.writeFileSync(this.owner, this.ownerIdentity);
      fs.fsyncSync(this.owner);
    });
  }
  assertReady() {
    if (!this.opened || this.poisoned) throw new Error("JOURNAL_UNAVAILABLE");
  }
  commit(records) {
    this.assertReady();
    if (this.directory) {
      const payload = { schema_version: 1, records: [...records.values()] };
      const encoded = JSON.stringify({ ...payload, checksum: digest(JSON.stringify(payload)) });
      if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw new Error("JOURNAL_FULL");
      const temporary = path.join(this.directory, `journal-${randomUUID()}.tmp`);
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, "wx", 384);
        fs.writeFileSync(descriptor, encoded, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = void 0;
        fs.renameSync(temporary, path.join(this.directory, "journal.json"));
        if (process.platform !== "win32") {
          const directory = fs.openSync(this.directory, "r");
          try {
            fs.fsyncSync(directory);
          } finally {
            fs.closeSync(directory);
          }
        }
      } catch (error) {
        this.poisoned = true;
        throw error;
      } finally {
        if (descriptor !== void 0) fs.closeSync(descriptor);
      }
    }
    this.records = records;
  }
};
function digest(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOURNAL_INVALID");
  const record2 = value;
  if (Object.keys(record2).some((key) => !RECORD_KEYS.has(key))) throw new Error("JOURNAL_INVALID");
  for (const key of ["requestId", "sessionId"]) if (typeof record2[key] !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(record2[key])) throw new Error("JOURNAL_INVALID");
  if (typeof record2.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record2.requestDigest)) throw new Error("JOURNAL_INVALID");
  for (const key of ["generation", "revision", "sequence"]) if (!Number.isSafeInteger(record2[key]) || Number(record2[key]) < (key === "generation" ? 1 : 0)) throw new Error("JOURNAL_INVALID");
  if (!PHASES.includes(String(record2.state)) || !["not_started", "started", "unknown"].includes(String(record2.outcome)) || typeof record2.cancelRequested !== "boolean") throw new Error("JOURNAL_INVALID");
  if (record2.remoteStatus !== void 0 && !PHASES.slice(2).includes(String(record2.remoteStatus))) throw new Error("JOURNAL_INVALID");
  if (record2.terminalDigest !== void 0 && (typeof record2.terminalDigest !== "string" || !/^[a-f0-9]{64}$/.test(record2.terminalDigest))) throw new Error("JOURNAL_INVALID");
  if (record2.cancelStatus !== void 0 && !["cancel_requested", "already_terminal", "not_found"].includes(String(record2.cancelStatus))) throw new Error("JOURNAL_INVALID");
  if (record2.cancelStatus !== void 0 && !record2.cancelRequested) throw new Error("JOURNAL_INVALID");
  if (record2.state === "planned" && (record2.outcome !== "not_started" || record2.sequence !== 0 || record2.remoteStatus !== void 0)) throw new Error("JOURNAL_INVALID");
  if (record2.state === "dispatched" && (record2.outcome !== "unknown" || record2.sequence !== 0 || record2.remoteStatus !== void 0)) throw new Error("JOURNAL_INVALID");
  if (record2.state === "accepted" && (record2.outcome !== "started" || record2.sequence !== 0 || record2.remoteStatus !== "accepted")) throw new Error("JOURNAL_INVALID");
  if (record2.state === "streaming" && (record2.outcome !== "started" || Number(record2.sequence) < 1 || record2.remoteStatus !== "streaming")) throw new Error("JOURNAL_INVALID");
  if (record2.outcome === "not_started" && record2.state !== "planned" && (record2.state !== "failed" || record2.sequence !== 0 || record2.remoteStatus !== void 0)) throw new Error("JOURNAL_INVALID");
  if (["completed", "failed", "aborted"].includes(String(record2.state)) && record2.outcome !== "not_started" && (record2.outcome !== "started" || record2.remoteStatus !== record2.state || record2.terminalDigest === void 0 || Number(record2.sequence) < 1)) throw new Error("JOURNAL_INVALID");
  if (record2.remoteStatus === "accepted" && record2.sequence !== 0) throw new Error("JOURNAL_INVALID");
  if (record2.remoteStatus === "streaming" && Number(record2.sequence) < 1) throw new Error("JOURNAL_INVALID");
  if (["completed", "failed", "aborted", "ambiguous"].includes(String(record2.remoteStatus)) && (record2.terminalDigest === void 0 || Number(record2.sequence) < 1)) throw new Error("JOURNAL_INVALID");
}
function decodeJournal(encoded, maximum) {
  const value = JSON.parse(encoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOURNAL_INVALID");
  const envelope = value;
  if (envelope.schema_version !== 1) throw new Error("JOURNAL_UNSUPPORTED_VERSION");
  if (Object.keys(envelope).sort().join() !== "checksum,records,schema_version" || !Array.isArray(envelope.records) || envelope.records.length > maximum) throw new Error("JOURNAL_INVALID");
  if (envelope.checksum !== digest(JSON.stringify({ schema_version: 1, records: envelope.records }))) throw new Error("JOURNAL_CHECKSUM_MISMATCH");
  const records = /* @__PURE__ */ new Map();
  for (const entry of envelope.records) {
    validateRecord(entry);
    if (records.has(entry.requestId)) throw new Error("JOURNAL_INVALID");
    records.set(entry.requestId, Object.freeze(entry));
  }
  return records;
}

// ../dsh-web-model-transport/src/security.ts
import { createHash as createHash3, randomBytes, timingSafeEqual } from "node:crypto";
var LOOPBACK_HOST = "127.0.0.1";
var WEB_MODEL_PATH = "/web-model/v1";
var WEB_MODEL_SUBPROTOCOL = "deepseek-web-model.v1";
var MINIMUM_TOKEN_BYTES = 32;
var BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
var EXTENSION_ORIGIN_PATTERN = /^(?:chrome|moz)-extension:\/\/[A-Za-z0-9_-]+$/u;
function assertPairingToken(token) {
  if (!BASE64URL_PATTERN.test(token)) throw new Error("INVALID_PAIRING_TOKEN");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength < MINIMUM_TOKEN_BYTES || decoded.toString("base64url") !== token) {
    throw new Error("INVALID_PAIRING_TOKEN");
  }
}
function pairingTokenMatches(provided, expected) {
  const providedDigest = createHash3("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash3("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
function assertAllowedOrigins(origins) {
  if (origins.length === 0) throw new Error("INVALID_ORIGIN_ALLOWLIST");
  const result = /* @__PURE__ */ new Set();
  for (const origin of origins) {
    if (!EXTENSION_ORIGIN_PATTERN.test(origin) || origin.includes("*") || result.has(origin)) {
      throw new Error("INVALID_ORIGIN_ALLOWLIST");
    }
    result.add(origin);
  }
  return result;
}
function hasSingleHeader(request, name2) {
  const expected = name2.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expected) count += 1;
  }
  return count === 1;
}
function validateUpgradeRequest(request, policy) {
  if (request.socket.remoteAddress !== LOOPBACK_HOST) return "REMOTE";
  if (!hasSingleHeader(request, "host") || request.headers.host !== `${LOOPBACK_HOST}:${policy.port}`) return "HOST";
  if (!hasSingleHeader(request, "origin") || typeof request.headers.origin !== "string" || !policy.allowedOrigins.has(request.headers.origin)) return "ORIGIN";
  if (request.method !== "GET") return "METHOD";
  if (request.url !== WEB_MODEL_PATH) return "PATH";
  if (!hasSingleHeader(request, "sec-websocket-protocol") || request.headers["sec-websocket-protocol"] !== WEB_MODEL_SUBPROTOCOL) return "SUBPROTOCOL";
  return null;
}

// ../dsh-web-model-transport/src/host.ts
var DEFAULT_AUTH_TIMEOUT_MS = 2e3;
var DEFAULT_HEARTBEAT_TIMEOUT_MS = 3e4;
var DEFAULT_RPC_TIMEOUT_MS = 1e4;
var DEFAULT_GENERATION_TIMEOUT_MS = 5 * 6e4;
var DEFAULT_MAX_BUFFERED_EVENTS = 128;
var DEFAULT_MAX_EVENTS = 4096;
var DeepSeekWebModelHost = class {
  pairingToken;
  allowedOrigins;
  configuredPort;
  authenticationTimeoutMs;
  heartbeatTimeoutMs;
  rpcTimeoutMs;
  maxBufferedEvents;
  maxEventsPerGeneration;
  webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true
  });
  operations = /* @__PURE__ */ new Map();
  cancelResults = /* @__PURE__ */ new Map();
  cancelInFlight = /* @__PURE__ */ new Map();
  journal;
  durableJournal;
  journalFailed = false;
  recovering = false;
  stopPromise;
  httpServer;
  addressValue;
  connection;
  activeGeneration;
  stopping = false;
  started = false;
  constructor(options) {
    assertPairingToken(options.pairingToken);
    this.pairingToken = options.pairingToken;
    this.allowedOrigins = assertAllowedOrigins(options.allowedOrigins);
    this.configuredPort = boundedInteger2(options.port ?? 0, 0, 65535, "INVALID_PORT");
    this.authenticationTimeoutMs = boundedInteger2(options.authenticationTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, 10, 6e5, "INVALID_TIMEOUT");
    this.heartbeatTimeoutMs = boundedInteger2(options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS, 10, 6e5, "INVALID_TIMEOUT");
    this.rpcTimeoutMs = boundedInteger2(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, 10, 6e5, "INVALID_TIMEOUT");
    this.maxBufferedEvents = boundedInteger2(options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS, 1, 4096, "INVALID_LIMIT");
    this.maxEventsPerGeneration = boundedInteger2(options.maxEventsPerGeneration ?? DEFAULT_MAX_EVENTS, 1, 65536, "INVALID_LIMIT");
    this.journal = new RequestJournal(options.journalPath, options.maxJournalRecords);
    this.durableJournal = options.journalPath !== void 0;
  }
  get address() {
    if (!this.addressValue) throw new BrokerError(this.stopping ? "BROKER_STOPPED" : "WAITING_FOR_BROWSER", "not_started");
    return this.addressValue;
  }
  get hasAuthenticatedPeer() {
    return !this.recovering && !this.journalFailed && this.connection?.authenticated === true && this.connection.socket.readyState === WebSocket.OPEN;
  }
  async start() {
    if (this.started || this.stopping) throw new BrokerError("BROKER_STOPPED", "not_started");
    this.started = true;
    try {
      await this.journal.open();
    } catch (error) {
      await this.journal.close();
      throw error;
    }
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-length": "0" });
      response.end();
    });
    this.httpServer = server;
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    await listen(server, this.configuredPort);
    const actual = server.address();
    if (actual === null || typeof actual === "string" || actual.address !== LOOPBACK_HOST) {
      await closeHttpServer(server);
      throw new Error("LOOPBACK_BIND_FAILED");
    }
    this.addressValue = Object.freeze({
      host: LOOPBACK_HOST,
      port: actual.port,
      path: WEB_MODEL_PATH,
      subprotocol: WEB_MODEL_SUBPROTOCOL,
      url: `ws://${LOOPBACK_HOST}:${actual.port}${WEB_MODEL_PATH}`
    });
    return this.addressValue;
  }
  stop() {
    return this.stopPromise ??= this.stopHost();
  }
  async stopHost() {
    this.stopping = true;
    const connection = this.connection;
    if (connection) {
      this.settleGenerationAmbiguous("host_stopped");
      connection.closing = true;
      this.clearPeerTimers(connection);
      connection.socket.terminate();
      this.connection = void 0;
    }
    for (const operation of this.operations.values()) {
      clearTimeout(operation.timer);
      if (operation.kind !== "generate") operation.deferred.reject(new BrokerError("BROKER_STOPPED", "unknown"));
    }
    this.operations.clear();
    await closeWebSocketServer(this.webSocketServer);
    if (this.httpServer) await closeHttpServer(this.httpServer);
    this.httpServer = void 0;
    this.addressValue = void 0;
    await this.journal.close();
  }
  async *generate(request) {
    if (this.hasCancelInFlight(request.request_id)) {
      throw new BrokerError("BROKER_BUSY", "not_started");
    }
    const existing = this.journal.get(request.request_id);
    if (existing && existing.outcome !== "not_started") {
      if (existing.requestDigest !== request.request_digest) {
        throw new BrokerError("REQUEST_DIGEST_MISMATCH", "not_started");
      }
      throw new BrokerError("REQUEST_ALREADY_EXISTS", isFinalRecord(existing) ? "started" : "unknown");
    }
    this.assertLedgerIdentity(request);
    const peer = this.requirePeer();
    if (this.activeGeneration) throw new BrokerError("BROKER_BUSY", "not_started");
    let planned;
    const rpcId = newRpcId();
    const frame = { jsonrpc: "2.0", id: rpcId, method: "model.generate", params: { schema_version: 1, ...request } };
    try {
      encodeWebModelFrame(frame);
    } catch (error) {
      throw stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started");
    }
    try {
      planned = this.journal.plan(request.request_id, request.request_digest, request.session_id);
    } catch (error) {
      if (error instanceof Error && error.message === "JOURNAL_FULL") throw new BrokerError("BROKER_BUSY", "not_started");
      this.journalFailed = true;
      throw new BrokerError("JOURNAL_UNAVAILABLE", "not_started");
    }
    const active = {
      requestId: request.request_id,
      requestDigest: request.request_digest,
      generation: planned.generation,
      queue: new AsyncQueue(this.maxBufferedEvents),
      accepted: deferred(),
      eventCount: 0,
      terminal: false
    };
    let encoded;
    try {
      encoded = this.prepareHostFrame(peer, frame);
    } catch (error) {
      throw stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started");
    }
    this.clearCancelResults(request.request_id);
    this.activeGeneration = active;
    try {
      this.updateRecord(request.request_id, { type: "dispatch" });
      this.trackOperation(rpcId, { kind: "generate", identity: active, deferred: active.accepted });
      this.sendPreparedFrame(peer, encoded);
      const timeoutMs = Math.min(request.options.timeout_ms ?? DEFAULT_GENERATION_TIMEOUT_MS, 30 * 60 * 1e3);
      active.deadlineTimer = deadline(() => {
        this.settleGenerationAmbiguous("generation_timeout");
        this.closePeer(peer, 1008, "REQUEST_TIMEOUT");
      }, timeoutMs);
      await active.accepted.promise;
      for (; ; ) {
        const next = await active.queue.next();
        if (next.done) break;
        yield next.value;
      }
    } catch (error) {
      const normalized = stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started");
      const pending = this.operations.get(rpcId);
      if (pending) {
        clearTimeout(pending.timer);
        this.operations.delete(rpcId);
      }
      if (normalized.externalOutcome === "not_started") {
        if (this.activeGeneration === active) {
          this.activeGeneration = void 0;
          active.queue.close();
        }
        throw normalized;
      }
      if (this.activeGeneration === active) {
        this.settleGenerationAmbiguous("send_outcome_unknown");
        this.closePeer(peer, 1011, "SEND_FAILED");
      } else {
        this.updateRecord(request.request_id, { type: "disconnect" });
      }
      for (; ; ) {
        const next = await active.queue.next();
        if (next.done) break;
        yield next.value;
      }
      return;
    } finally {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      if (this.activeGeneration === active && !active.terminal) {
        this.settleGenerationAmbiguous("consumer_closed");
        this.closePeer(peer, 1e3, "STREAM_CLOSED");
      }
    }
  }
  async cancel(request) {
    const key = identityKey(request.request_id, request.request_digest);
    this.assertLedgerIdentity(request);
    const persisted = this.journal.get(request.request_id);
    if (persisted?.cancelStatus) return {
      schema_version: 1,
      type: "model.cancelled",
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: persisted.cancelStatus
    };
    const cached = this.cancelResults.get(key);
    if (cached) return cached;
    const inFlight = this.cancelInFlight.get(key);
    if (inFlight) return inFlight;
    const ledger = this.journal.get(request.request_id);
    if (ledger && isFinalRecord(ledger)) {
      const terminalResult = {
        schema_version: 1,
        type: "model.cancelled",
        request_id: request.request_id,
        request_digest: request.request_digest,
        status: "already_terminal"
      };
      return terminalResult;
    }
    const pending = this.performCancel(request);
    this.cancelInFlight.set(key, pending);
    try {
      const value = await pending;
      if (!this.journal.get(request.request_id)) {
        this.cancelResults.set(key, value);
        trimMap(this.cancelResults, 128);
      }
      return value;
    } finally {
      this.cancelInFlight.delete(key);
    }
  }
  async performCancel(request) {
    const peer = this.requirePeer();
    const rpcId = newRpcId();
    const result = deferred();
    const frame = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "model.cancel",
      params: {
        schema_version: 1,
        request_id: request.request_id,
        request_digest: request.request_digest,
        ...request.reason === void 0 ? {} : { reason: request.reason }
      }
    };
    if (this.journal.get(request.request_id)) this.updateRecord(request.request_id, { type: "cancel" });
    this.trackOperation(rpcId, { kind: "cancel", identity: identityOf(request), deferred: result });
    try {
      this.sendHostFrame(peer, frame);
    } catch (error) {
      this.discardOperation(rpcId);
      result.reject(stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started"));
    }
    return result.promise;
  }
  async query(request) {
    this.assertLedgerIdentity(request);
    const peer = this.requirePeer(true);
    const record2 = this.journal.get(request.request_id);
    if (record2?.remoteStatus === "accepted" || record2?.remoteStatus === "streaming") {
      peer.validator.hydrateRequestCheckpoint({
        request_id: record2.requestId,
        request_digest: record2.requestDigest,
        status: record2.remoteStatus,
        last_sequence: record2.sequence
      });
    }
    if (record2?.state === "ambiguous" || record2 && isFinalRecord(record2)) {
      peer.validator.allowStatusSnapshot(request.request_id, request.request_digest);
    }
    const rpcId = newRpcId();
    const result = deferred();
    const frame = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "model.query",
      params: { schema_version: 1, request_id: request.request_id, request_digest: request.request_digest }
    };
    this.trackOperation(rpcId, { kind: "query", identity: identityOf(request), deferred: result });
    try {
      this.sendHostFrame(peer, frame);
    } catch (error) {
      this.discardOperation(rpcId);
      result.reject(stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started"));
    }
    return result.promise;
  }
  handleUpgrade(request, socket, head) {
    if (this.stopping || !this.addressValue) return rejectUpgrade(socket, 503);
    const rejection = validateUpgradeRequest(request, { port: this.addressValue.port, allowedOrigins: this.allowedOrigins });
    if (rejection) return rejectUpgrade(socket, 403);
    if (this.connection) return rejectUpgrade(socket, 409);
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.attachConnection(webSocket);
      this.webSocketServer.emit("connection", webSocket, request);
    });
  }
  attachConnection(socket) {
    const peer = {
      socket,
      validator: new WebModelSequenceValidator(),
      connectionId: `connection-${randomBytes2(16).toString("base64url")}`,
      authenticated: false,
      closing: false
    };
    this.connection = peer;
    peer.authenticationTimer = deadline(() => this.closePeer(peer, 1008, "AUTH_TIMEOUT"), this.authenticationTimeoutMs);
    socket.on("message", (data, isBinary) => this.handleMessage(peer, data, isBinary));
    socket.on("close", () => this.handleClose(peer));
    socket.on("error", () => void 0);
  }
  handleMessage(peer, data, isBinary) {
    if (peer !== this.connection || peer.closing) return;
    try {
      if (isBinary) throw new Error("TEXT_REQUIRED");
      const text = decodeTextFrame(data);
      const frame = peer.validator.decodeAndAccept(text, "browser");
      if (!peer.authenticated) {
        this.authenticate(peer, frame);
        return;
      }
      if ("method" in frame && frame.method === "bridge.heartbeat") {
        this.armHeartbeat(peer);
        return;
      }
      this.routeFrame(peer, frame);
    } catch {
      this.closePeer(peer, isBinary ? 1003 : 1008, isBinary ? "TEXT_REQUIRED" : "PROTOCOL_ERROR");
    }
  }
  authenticate(peer, frame) {
    if (!("method" in frame) || frame.method !== "bridge.hello") throw new Error("AUTH_REQUIRED");
    const hello = frame;
    if (!pairingTokenMatches(hello.params.pairing_token, this.pairingToken)) {
      this.closePeer(peer, 1008, "AUTH_FAILED");
      return;
    }
    const capabilities = negotiateCapabilities(hello.params.capabilities);
    const response = {
      jsonrpc: "2.0",
      id: hello.id,
      result: {
        schema_version: 1,
        type: "bridge.hello",
        connection_id: peer.connectionId,
        status: "ready",
        capabilities
      }
    };
    this.sendHostFrame(peer, response);
    peer.authenticated = true;
    if (peer.authenticationTimer) clearTimeout(peer.authenticationTimer);
    delete peer.authenticationTimer;
    this.armHeartbeat(peer);
    if (this.durableJournal) {
      this.recovering = true;
      void this.recoverRequests(peer);
    }
  }
  routeFrame(peer, frame) {
    if ("method" in frame) {
      if (frame.method !== "model.event") throw new Error("UNEXPECTED_NOTIFICATION");
      this.handleModelEvent(peer, frame);
      return;
    }
    this.handleRpcResponse(peer, frame);
  }
  handleModelEvent(peer, frame) {
    const active = this.activeGeneration;
    if (!active || frame.params.request_id !== active.requestId) throw new Error("UNKNOWN_REQUEST");
    this.recordRemoteEvent(active, frame.params.sequence, frame.params.event);
    active.eventCount += 1;
    if (active.eventCount > this.maxEventsPerGeneration || !active.queue.push(frame.params.event)) {
      this.settleGenerationAmbiguous("stream_limit_exceeded");
      this.closePeer(peer, 1008, "STREAM_LIMIT");
      return;
    }
    if (isTerminalEvent(frame.params.event)) {
      active.terminal = true;
      active.queue.close();
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      this.activeGeneration = void 0;
    }
  }
  handleRpcResponse(peer, frame) {
    if (frame.id === null) throw new Error("UNEXPECTED_RESPONSE");
    const operation = this.operations.get(frame.id);
    if (!operation) throw new Error("UNEXPECTED_RESPONSE");
    clearTimeout(operation.timer);
    if ("error" in frame) {
      this.handleRpcError(peer, operation, frame);
      this.operations.delete(frame.id);
      return;
    }
    if (operation.kind === "generate" && frame.result.type === "model.accepted") {
      this.updateRecord(operation.identity.requestId, { type: "accept" });
      this.operations.delete(frame.id);
      operation.deferred.resolve();
      return;
    }
    if (operation.kind === "cancel" && frame.result.type === "model.cancelled") {
      if (this.journal.get(operation.identity.requestId)) this.updateRecord(operation.identity.requestId, { type: "cancel_ack", status: frame.result.status });
      this.operations.delete(frame.id);
      operation.deferred.resolve(frame.result);
      return;
    }
    if (operation.kind === "query" && frame.result.type === "model.status") {
      this.recordRemoteStatus(frame.result);
      this.operations.delete(frame.id);
      operation.deferred.resolve(frame.result);
      return;
    }
    throw new Error("UNEXPECTED_RESPONSE");
  }
  handleRpcError(peer, operation, frame) {
    const outcome = frame.error.data.external_outcome;
    const error = preStartRemoteError(frame);
    if (operation.kind === "generate") {
      if (outcome === "not_started") {
        if (this.activeGeneration?.requestId === operation.identity.requestId) {
          this.activeGeneration.queue.close();
          if (this.activeGeneration.deadlineTimer) clearTimeout(this.activeGeneration.deadlineTimer);
          this.activeGeneration = void 0;
        }
        this.updateRecord(operation.identity.requestId, { type: "not_started" });
        operation.deferred.reject(error);
      } else {
        this.settleGenerationAmbiguous(error.remoteCode ?? "remote_outcome_unknown");
        operation.deferred.resolve();
      }
      return;
    }
    operation.deferred.reject(error);
    if (outcome !== "not_started") this.closePeer(peer, 1008, "REQUEST_OUTCOME_UNKNOWN");
  }
  sendHostFrame(peer, frame) {
    const encoded = this.prepareHostFrame(peer, frame);
    this.sendPreparedFrame(peer, encoded);
  }
  prepareHostFrame(peer, frame) {
    if (peer !== this.connection || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    }
    const encoded = encodeWebModelFrame(frame);
    peer.validator.accept(frame, "host");
    return encoded;
  }
  sendPreparedFrame(peer, encoded) {
    if (peer !== this.connection || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("CONNECTION_LOST", "unknown");
    }
    try {
      peer.socket.send(encoded);
    } catch {
      throw new BrokerError("CONNECTION_LOST", "unknown");
    }
  }
  trackOperation(rpcId, operation) {
    const timer = deadline(() => {
      const pending = this.operations.get(rpcId);
      if (!pending) return;
      this.operations.delete(rpcId);
      if (pending.kind === "generate") {
        this.settleGenerationAmbiguous("accept_timeout");
        pending.deferred.resolve();
      } else {
        pending.deferred.reject(new BrokerError("REQUEST_TIMEOUT", "unknown"));
      }
      if (this.connection) this.closePeer(this.connection, 1008, "REQUEST_TIMEOUT");
    }, this.rpcTimeoutMs);
    this.operations.set(rpcId, { ...operation, timer });
  }
  discardOperation(rpcId) {
    const pending = this.operations.get(rpcId);
    if (pending) clearTimeout(pending.timer);
    this.operations.delete(rpcId);
  }
  armHeartbeat(peer) {
    if (peer.heartbeatTimer) clearTimeout(peer.heartbeatTimer);
    peer.heartbeatTimer = deadline(() => this.closePeer(peer, 1008, "HEARTBEAT_TIMEOUT"), this.heartbeatTimeoutMs);
  }
  closePeer(peer, code, reason) {
    if (peer.closing) return;
    peer.closing = true;
    this.clearPeerTimers(peer);
    if (peer === this.connection) {
      this.settleGenerationAmbiguous("browser_disconnected");
      this.rejectPeerOperations();
    }
    if (peer.socket.readyState === WebSocket.CLOSED) return;
    peer.socket.close(code, reason);
    if (!peer.closeTimer) peer.closeTimer = deadline(() => peer.socket.terminate(), 50);
  }
  handleClose(peer) {
    this.clearPeerTimers(peer);
    if (this.connection !== peer) return;
    peer.closing = true;
    this.connection = void 0;
    this.settleGenerationAmbiguous("browser_disconnected");
    this.rejectPeerOperations();
  }
  settleGenerationAmbiguous(reason) {
    const active = this.activeGeneration;
    if (!active || active.terminal) return;
    active.terminal = true;
    const terminal = { type: "ambiguous", reason };
    active.queue.finishWith(terminal);
    active.accepted.resolve();
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeGeneration = void 0;
    try {
      this.updateRecord(active.requestId, { type: "disconnect" });
    } catch {
      this.journalFailed = true;
    }
  }
  assertLedgerIdentity(request) {
    const ledger = this.journal.get(request.request_id);
    if (ledger && ledger.requestDigest !== request.request_digest) {
      throw new BrokerError("REQUEST_DIGEST_MISMATCH", "not_started");
    }
  }
  hasCancelInFlight(requestId) {
    const prefix = `${requestId}\0`;
    for (const key of this.cancelInFlight.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
  clearCancelResults(requestId) {
    const prefix = `${requestId}\0`;
    for (const key of this.cancelResults.keys()) {
      if (key.startsWith(prefix)) this.cancelResults.delete(key);
    }
  }
  recordRemoteEvent(active, sequence, event) {
    const record2 = this.journal.get(active.requestId);
    if (!record2 || record2.generation !== active.generation) throw new Error("JOURNAL_CAS_MISMATCH");
    this.updateRecord(active.requestId, { type: "event", sequence, event });
  }
  recordRemoteStatus(result) {
    if (this.journal.get(result.request_id)) this.updateRecord(result.request_id, { type: "query", result });
    if (this.activeGeneration?.requestId === result.request_id && this.journal.get(result.request_id)?.state === "ambiguous") {
      this.settleGenerationAmbiguous("status_without_stream");
    }
  }
  updateRecord(requestId, action) {
    const record2 = this.journal.get(requestId);
    if (!record2) throw new BrokerError("JOURNAL_UNAVAILABLE", "unknown");
    try {
      this.journal.apply(requestId, record2.generation, record2.revision, action);
    } catch {
      this.journalFailed = true;
      throw new BrokerError("JOURNAL_UNAVAILABLE", record2.state === "planned" ? "not_started" : "unknown");
    }
  }
  async recoverRequests(peer) {
    try {
      for (const record2 of this.journal.recoverable()) {
        if (peer !== this.connection || peer.closing || this.stopping) return;
        await this.query({ request_id: record2.requestId, request_digest: record2.requestDigest });
      }
    } catch {
      this.closePeer(peer, 1008, "RECOVERY_FAILED");
    } finally {
      if (peer === this.connection) this.recovering = false;
    }
  }
  rejectPeerOperations() {
    for (const [rpcId, operation] of this.operations) {
      clearTimeout(operation.timer);
      this.operations.delete(rpcId);
      if (operation.kind === "generate") operation.deferred.resolve();
      else operation.deferred.reject(new BrokerError("CONNECTION_LOST", "unknown"));
    }
  }
  clearPeerTimers(peer) {
    if (peer.authenticationTimer) clearTimeout(peer.authenticationTimer);
    if (peer.heartbeatTimer) clearTimeout(peer.heartbeatTimer);
    if (peer.closeTimer) clearTimeout(peer.closeTimer);
  }
  requirePeer(allowRecovery = false) {
    if (this.stopping) throw new BrokerError("BROKER_STOPPED", "not_started");
    if (this.journalFailed) throw new BrokerError("JOURNAL_UNAVAILABLE", "not_started");
    if (this.recovering && !allowRecovery) throw new BrokerError("BROKER_BUSY", "not_started");
    const peer = this.connection;
    if (!peer?.authenticated || peer.closing || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    }
    return peer;
  }
};
function negotiateCapabilities(offered) {
  return {
    ...offered.text === true ? { text: true } : {},
    ...offered.reasoning === true ? { reasoning: true } : {},
    structured_tool_calls: true,
    ...offered.usage === true ? { usage: true } : {},
    cancel: true,
    query: true
  };
}
function decodeTextFrame(data) {
  let bytes;
  if (Array.isArray(data)) {
    const length = data.reduce((total, part) => total + part.byteLength, 0);
    if (length > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
    bytes = Buffer.concat(data, length);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function identityOf(value) {
  return { requestId: value.request_id, requestDigest: value.request_digest };
}
function identityKey(requestId, requestDigest2) {
  return `${requestId}\0${requestDigest2}`;
}
function newRpcId() {
  return `rpc-${randomBytes2(16).toString("hex")}`;
}
function boundedInteger2(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
function deadline(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return timer;
}
function rejectUpgrade(socket, status) {
  const reason = status === 409 ? "Conflict" : status === 503 ? "Service Unavailable" : "Forbidden";
  socket.end(`HTTP/1.1 ${status} ${reason}\r
Connection: close\r
Content-Length: 0\r
\r
`);
}
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port });
  });
}
async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function closeWebSocketServer(server) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(() => resolve()));
}
function trimMap(map, maximum) {
  while (map.size > maximum) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}
function stableBrokerError(error, fallback, outcome) {
  return error instanceof BrokerError ? error : new BrokerError(fallback, outcome);
}
function preStartRemoteError(frame) {
  const outcome = frame.error.data.external_outcome;
  if (outcome === "not_started") {
    switch (frame.error.data.error_code) {
      case "DEEPSEEK_AUTH_REQUIRED":
      case "DEEPSEEK_PREPARATION_FAILED":
      case "MODEL_PREPARATION_FAILED":
      case "BROKER_BUSY":
      case "SESSION_QUARANTINED":
        return new BrokerError(frame.error.data.error_code, outcome);
    }
  }
  return new BrokerError("PROTOCOL_VIOLATION", outcome, frame.error.data.error_code);
}

// ../dsh-llm-deepseek-web/src/constants.ts
var DEEPSEEK_WEB_PROVIDER = "deepseek-web";
var DEEPSEEK_WEB_MODEL = "current-web-session";
var DEEPSEEK_WEB_EXPERT_MODEL = "current-web-session-expert";
var DEEPSEEK_WEB_REASONING_OFF = "off";
var DEEPSEEK_WEB_REASONING_ON = "on";
var DEEPSEEK_WEB_CONTEXT_WINDOW = 128e3;

// ../dsh-llm-deepseek-web/src/request.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "node:crypto";
import { LlmError } from "@deepseek-ai/dsh-llm";
function serializeGenerateRequest(options, serialization = {}) {
  assertRoute(options);
  assertSupportedGenerationOptions(options);
  const requestId = serialization.requestId ?? serialization.createRequestId?.() ?? `request-${randomUUID2()}`;
  const sessionId = options.sessionId === void 0 ? `session-${randomUUID2()}` : String(options.sessionId);
  const purpose = options.purpose ?? "agent";
  const messages = [
    ...options.system === void 0 ? [] : [{ role: "system", content: textOnly(options.system, "system") }],
    ...options.messages.map(serializeMessage)
  ];
  if (messages.length === 0) {
    throw invalidRequest("DeepSeek Web requests require at least one message.");
  }
  const tools = (options.tools ?? []).map((tool) => {
    const inputSchema = cloneJsonObject(tool.parameters, `tool ${JSON.stringify(tool.name)} parameters`);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema
    };
  });
  const body = {
    session_id: sessionId,
    purpose,
    model: { provider: DEEPSEEK_WEB_PROVIDER, model_id: DEEPSEEK_WEB_MODEL },
    input: { messages },
    tools,
    options: {
      thinking_enabled: options.reasoningEffort === DEEPSEEK_WEB_REASONING_ON,
      search_enabled: false,
      model_type: options.model === DEEPSEEK_WEB_EXPERT_MODEL ? "expert" : "default"
    }
  };
  assertJsonStructure(body);
  const requestDigest2 = createHash4("sha256").update(canonicalJson(body)).digest("hex");
  return { request_id: requestId, request_digest: requestDigest2, ...body };
}
function assertRoute(options) {
  if (options.provider !== DEEPSEEK_WEB_PROVIDER) {
    throw new LlmError("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER");
  }
  if (options.model !== DEEPSEEK_WEB_MODEL && options.model !== DEEPSEEK_WEB_EXPERT_MODEL) {
    throw new LlmError("The DeepSeek Web adapter does not expose this browser-session mode.", "UNKNOWN_MODEL");
  }
}
function assertSupportedGenerationOptions(options) {
  const unsupportedMaxTokens = options.maxTokens !== void 0 && options.purpose !== "compaction";
  if (options.temperature !== void 0 || unsupportedMaxTokens || options.stop !== void 0) {
    throw unsupportedOption("DeepSeek Web Protocol v1 does not support per-request generation controls.");
  }
  if (options.reasoningEffort !== void 0 && options.reasoningEffort !== DEEPSEEK_WEB_REASONING_OFF && options.reasoningEffort !== DEEPSEEK_WEB_REASONING_ON) {
    throw unsupportedOption("DeepSeek Web accepts only the off and on thinking selections.");
  }
}
function serializeMessage(message) {
  const isToolMessage = message.source.kind === "tool";
  const role = isToolMessage ? "tool" : message.role;
  const content = message.content.map((block) => serializeContent(block, role));
  if (content.length === 0) throw invalidRequest("DeepSeek Web messages cannot have empty content.");
  return { role, content };
}
function serializeContent(block, role) {
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
        arguments: parseArguments(block.arguments)
      };
    case "tool-result": {
      if (role !== "tool") throw invalidRequest("Tool results require a tool message.");
      const content = block.content.map((item) => {
        if (item.type !== "text" || item.text.length === 0) {
          throw invalidRequest("Protocol v1 tool results support non-empty text blocks only.");
        }
        return { type: "text", text: item.text };
      });
      return {
        type: "tool_result",
        tool_call_id: String(block.toolCallId),
        content,
        is_error: block.isError ?? false
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
function textOnly(text, label) {
  if (text.length === 0) throw invalidRequest(`DeepSeek Web ${label} text cannot be empty.`);
  return [{ type: "text", text }];
}
function parseArguments(raw) {
  try {
    return cloneJsonObject(JSON.parse(raw), "tool-call arguments");
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw invalidRequest("Tool-call arguments must be a JSON object.", error);
  }
}
function cloneJsonObject(value, label) {
  try {
    assertJsonStructure(value);
  } catch (error) {
    throw invalidRequest(`${label} must be bounded JSON.`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest(`${label} must be a JSON object.`);
  }
  return structuredClone(value);
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function invalidRequest(message, cause) {
  return new LlmError(message, "INVALID_REQUEST", cause === void 0 ? void 0 : { cause });
}
function unsupportedOption(message) {
  return new LlmError(message, "UNSUPPORTED_OPTION");
}

// ../dsh-llm-deepseek-web/src/generation-scheduler.ts
import { LlmError as LlmError2 } from "@deepseek-ai/dsh-llm";
var GenerationScheduler = class {
  busy = false;
  waiting = [];
  acquire(signal) {
    if (signal?.aborted) return Promise.resolve(void 0);
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(this.lease());
    }
    if (this.waiting.length >= 16) {
      return Promise.reject(new LlmError2("The DeepSeek Web model request queue is full.", "BROKER_BUSY"));
    }
    return new Promise((resolve) => {
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        entry.detach();
        resolve(void 0);
      };
      const entry = { resolve, detach: () => signal?.removeEventListener("abort", abort) };
      this.waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  lease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === void 0) {
        this.busy = false;
        return;
      }
      next.detach();
      next.resolve(this.lease());
    };
  }
};

// ../dsh-llm-deepseek-web/src/diagnostics.ts
import { createHash as createHash5 } from "node:crypto";
var REASONS = /* @__PURE__ */ new Set([
  "browser_worker_restarted",
  "browser_recovery_failed",
  "consumer_callback_outcome_unknown",
  "deepseek_turn_outcome_unknown",
  "deepseek_stream_incomplete",
  "deepseek_rate_limit_reached",
  "response_message_id_missing",
  "request_message_id_missing",
  "deepseek_chain_unverified",
  "adapter_state_inconsistent",
  "deepseek_turn_timeout",
  "deepseek_dispatch_abort_outcome_unknown",
  "generation_timeout",
  "accept_timeout",
  "request_timeout",
  "browser_disconnected",
  "connection_closed",
  "connection_lost",
  "host_stopped",
  "send_outcome_unknown",
  "stream_limit_exceeded",
  "remote_outcome_unknown",
  "consumer_closed",
  "status_without_stream",
  "DEEPSEEK_AUTH_REQUIRED",
  "DEEPSEEK_PREPARATION_FAILED",
  "MODEL_PREPARATION_FAILED",
  "BROKER_BUSY",
  "SESSION_QUARANTINED",
  "SESSION_BUSY",
  "CAPACITY_EXCEEDED",
  "REQUEST_CAPACITY_EXCEEDED",
  "DUPLICATE_REQUEST",
  "REQUEST_IDENTITY_MISMATCH",
  "REASONING_NOT_NEGOTIATED",
  "REASONING_CALLBACK_REQUIRED",
  "REQUEST_ABORTED",
  "BROKER_STOPPED",
  "CONNECTION_LOST",
  "JOURNAL_UNAVAILABLE",
  "PROTOCOL_VIOLATION",
  "REQUEST_ALREADY_EXISTS",
  "REQUEST_DIGEST_MISMATCH",
  "REQUEST_TIMEOUT",
  "WAITING_FOR_BROWSER",
  "TOOL_CALL_INVALID",
  "MODEL_OUTPUT_BUDGET_EXCEEDED",
  "DEEPSEEK_DISPATCH_FAILED",
  "ACCEPTED_CALLBACK_FAILED"
]);
function diagnosticSuffix(requestId, startedAt, stage, reason) {
  const request = createHash5("sha256").update(requestId).digest("hex").slice(0, 16);
  const elapsed = Math.max(0, Math.floor(performance.now() - startedAt));
  const safeReason = reason && (REASONS.has(reason) || isCompletionDiagnosticReason(reason)) ? reason : "unknown";
  return ` [web-diag:v1 request=${request} stage=${stage} reason=${safeReason} elapsed_ms=${elapsed}]`;
}

// ../dsh-llm-deepseek-web/src/request-budget.ts
var REQUEST_ID = `request-${"0".repeat(36)}`;
var SESSION_ID = `session-${"0".repeat(36)}`;
var RPC_ID = `rpc-${"0".repeat(32)}`;
function deepSeekWebRequestBudget(options, customRequestId = false) {
  let frame;
  try {
    const request = serializeGenerateRequest({
      ...options,
      sessionId: options.sessionId ?? SESSION_ID
    }, { requestId: customRequestId ? "r".repeat(MAX_ID_LENGTH) : REQUEST_ID });
    frame = {
      jsonrpc: "2.0",
      id: RPC_ID,
      method: "model.generate",
      params: { schema_version: 1, ...request }
    };
    encodeWebModelFrame(frame);
    return void 0;
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      if (error.code === "ARRAY_TOO_LONG" && (error.path === "$.input.messages" || error.path === "$frame.params.input.messages")) {
        return { dimension: "messages", actual: options.messages.length + Number(options.system !== void 0), limit: MAX_MESSAGES };
      }
      if (error.code === "FRAME_TOO_LARGE" && error.path === "$frame") {
        return { dimension: "bytes", actual: Buffer.byteLength(JSON.stringify(frame), "utf8"), limit: MAX_FRAME_BYTES };
      }
    }
    throw error;
  }
}

// ../dsh-llm-deepseek-web/src/adapter.ts
var NO_RETRY_POLICY = resolveRetryPolicy(
  { mode: "normal", maxRetries: 0 },
  "llm-deepseek-web: retryPolicy"
);
var DeepSeekWebAdapter = class extends LlmAdapter {
  broker;
  createRequestId;
  abortSettleTimeoutMs;
  onReasoningEvent;
  cleanupState = "ready";
  scheduler = new GenerationScheduler();
  constructor(options) {
    super();
    this.broker = options.broker;
    this.createRequestId = options.createRequestId;
    this.onReasoningEvent = options.onReasoningEvent;
    const timeout = options.abortSettleTimeoutMs ?? 15e3;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 6e5) {
      throw new Error("abortSettleTimeoutMs must be a positive finite number no greater than 600000");
    }
    this.abortSettleTimeoutMs = timeout;
  }
  providerInfo(provider) {
    return { id: provider, name: "DeepSeek Web" };
  }
  providerRetryPolicy(_provider) {
    return NO_RETRY_POLICY;
  }
  requestBudget(options) {
    return deepSeekWebRequestBudget(options, this.createRequestId !== void 0);
  }
  listModels(provider) {
    if (provider !== DEEPSEEK_WEB_PROVIDER) {
      return Promise.reject(new LlmError3("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER"));
    }
    return Promise.resolve([modelInfo(provider, DEEPSEEK_WEB_MODEL), modelInfo(provider, DEEPSEEK_WEB_EXPERT_MODEL)]);
  }
  resolveModel(provider, model) {
    if (provider !== DEEPSEEK_WEB_PROVIDER) {
      return Promise.reject(new LlmError3("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER"));
    }
    if (model !== DEEPSEEK_WEB_MODEL && model !== DEEPSEEK_WEB_EXPERT_MODEL) {
      return Promise.reject(new LlmError3("The DeepSeek Web adapter does not expose this browser-session mode.", "UNKNOWN_MODEL"));
    }
    return Promise.resolve({
      ...modelInfo(provider, model),
      context: { contextWindow: DEEPSEEK_WEB_CONTEXT_WINDOW },
      reasoning: {
        efforts: [
          { id: ReasoningEffortId(DEEPSEEK_WEB_REASONING_OFF), name: "Thinking off" },
          { id: ReasoningEffortId(DEEPSEEK_WEB_REASONING_ON), name: "Thinking on" }
        ],
        defaultEffort: ReasoningEffortId(DEEPSEEK_WEB_REASONING_OFF)
      }
    });
  }
  async *stream(options) {
    const release = await this.scheduler.acquire(options.signal);
    if (release === void 0) {
      yield abortedFinish();
      return;
    }
    try {
      yield* this.streamExclusive(options);
    } finally {
      release();
    }
  }
  async *streamExclusive(options) {
    if (this.cleanupState !== "ready") {
      throw ambiguousFailure("A previous DeepSeek Web request has not confirmed transport cleanup.");
    }
    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }
    let request;
    try {
      request = serializeGenerateRequest(options, {
        ...this.createRequestId === void 0 ? {} : { createRequestId: this.createRequestId }
      });
    } catch (error) {
      throw normalizeAdapterError(error, options.signal);
    }
    const diagnosticStartedAt = performance.now();
    const diagnose = (chunk, stage, reason) => {
      if (chunk.type !== "finish" || chunk.reason.kind !== "error") return chunk;
      const failure = chunk.reason.failure;
      return { ...chunk, reason: { ...chunk.reason, failure: {
        ...failure,
        message: failure.message + diagnosticSuffix(request.request_id, diagnosticStartedAt, stage, reason)
      } } };
    };
    let terminal = false;
    const reasoningVisible = request.options.thinking_enabled;
    if (reasoningVisible) this.publishReasoning({
      phase: "start",
      sessionId: request.session_id,
      requestId: request.request_id
    });
    let textIndex;
    let text = "";
    let nextIndex = 0;
    let contentBlocks = 0;
    let toolCallBlocks = 0;
    let usageSeen = false;
    let cancellation;
    const requestCancellation = () => {
      if (cancellation !== void 0) return cancellation;
      try {
        cancellation = Promise.resolve(this.broker.cancel({
          request_id: request.request_id,
          request_digest: request.request_digest,
          reason: "caller_aborted"
        }));
      } catch (error) {
        cancellation = Promise.reject(error);
      }
      void cancellation.catch(() => void 0);
      return cancellation;
    };
    const handleAbort = () => {
      void requestCancellation();
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) requestCancellation();
    const closeText = function* () {
      if (textIndex === void 0) return;
      yield { type: "block-end", index: textIndex, block: { type: "text", text } };
      textIndex = void 0;
      text = "";
    };
    const iterator = this.broker.generate(request)[Symbol.asyncIterator]();
    let iteratorDone = false;
    let iteratorCleanupHandled = false;
    let cancellationAllowed = true;
    try {
      for (; ; ) {
        const next = await nextOrAbort(iterator, options.signal);
        if (next.kind === "aborted") {
          const event2 = await this.settleAfterAbort(iterator, next.pending, requestCancellation());
          iteratorCleanupHandled = true;
          if (textIndex !== void 0) contentBlocks += 1;
          yield* closeText();
          yield diagnose(terminalAfterAbort(event2), "cancel_settlement", event2?.type === "ambiguous" ? event2.reason : void 0);
          terminal = true;
          return;
        }
        if (next.result.done) {
          iteratorDone = true;
          break;
        }
        const event = next.result.value;
        if (options.signal?.aborted) {
          const settled = await this.settleAfterAbort(iterator, Promise.resolve(next.result), requestCancellation());
          iteratorCleanupHandled = true;
          if (textIndex !== void 0) contentBlocks += 1;
          yield* closeText();
          yield diagnose(terminalAfterAbort(settled), "cancel_settlement", settled?.type === "ambiguous" ? settled.reason : void 0);
          terminal = true;
          return;
        }
        switch (event.type) {
          case "text_delta":
            if (usageSeen) throw protocolFailure();
            if (textIndex === void 0) {
              textIndex = nextIndex++;
              yield { type: "block-start", index: textIndex, blockType: "text" };
            }
            text += event.text;
            yield { type: "text-delta", index: textIndex, text: event.text };
            break;
          case "reasoning_delta":
            if (usageSeen) throw protocolFailure();
            if (reasoningVisible) this.publishReasoning({
              phase: "delta",
              sessionId: request.session_id,
              requestId: request.request_id,
              text: event.text
            });
            break;
          case "tool_call": {
            if (usageSeen) throw protocolFailure();
            yield* closeText();
            contentBlocks += 1;
            toolCallBlocks += 1;
            const index = nextIndex++;
            const id = ToolCallId(event.tool_call_id);
            const argumentsText = canonicalArguments(event.arguments);
            yield { type: "block-start", index, blockType: "tool-call" };
            yield { type: "tool-call-delta", index, id, name: event.name, argumentsDelta: argumentsText };
            yield {
              type: "block-end",
              index,
              block: { type: "tool-call", id, name: event.name, arguments: argumentsText }
            };
            break;
          }
          case "usage":
            if (usageSeen) throw protocolFailure();
            usageSeen = true;
            if (textIndex !== void 0) contentBlocks += 1;
            yield* closeText();
            yield {
              type: "usage",
              usage: {
                inputTokens: event.input_tokens,
                outputTokens: event.output_tokens,
                ...event.cache_read_tokens === void 0 ? {} : { cacheReadTokens: event.cache_read_tokens },
                ...event.cache_write_tokens === void 0 ? {} : { cacheWriteTokens: event.cache_write_tokens }
              }
            };
            break;
          case "completed":
          case "aborted":
          case "failed":
          case "ambiguous":
            if (textIndex !== void 0) contentBlocks += 1;
            yield* closeText();
            iteratorCleanupHandled = true;
            await this.closeIteratorOrBlock(iterator);
            if (event.type === "completed") {
              if (contentBlocks === 0) {
                yield errorFinish("EMPTY_RESPONSE", "The DeepSeek Web model returned no content.");
                terminal = true;
                return;
              }
              if (event.finish_reason === "tool_calls" !== toolCallBlocks > 0) throw protocolFailure();
            }
            yield diagnose(terminalFinish(event), "browser_terminal", event.type === "ambiguous" ? event.reason : event.type === "failed" ? event.error.code : void 0);
            terminal = true;
            return;
          default:
            throw protocolFailure();
        }
      }
      if (!terminal) throw protocolFailure();
    } catch (error) {
      if (error instanceof BrokerError && error.externalOutcome === "not_started") cancellationAllowed = false;
      const normalized = normalizeAdapterError(error, options.signal);
      throw new LlmError3(
        normalized.message + diagnosticSuffix(
          request.request_id,
          diagnosticStartedAt,
          "broker_error",
          error instanceof BrokerError ? error.remoteCode ?? error.code : void 0
        ),
        normalized instanceof LlmError3 ? normalized.code : "WEB_MODEL_TRANSPORT"
      );
    } finally {
      if (reasoningVisible) this.publishReasoning({
        phase: "end",
        sessionId: request.session_id,
        requestId: request.request_id
      });
      options.signal?.removeEventListener("abort", handleAbort);
      if (!iteratorDone && !iteratorCleanupHandled) {
        const cancellationResult = !terminal && cancellationAllowed ? requestCancellation() : cancellation ?? Promise.resolve();
        const cleanup = closeIterator(iterator);
        try {
          await within(Promise.all([cancellationResult, cleanup]), this.abortSettleTimeoutMs);
        } catch {
          this.trackCleanup(cleanup);
        }
      }
    }
  }
  publishReasoning(event) {
    try {
      this.onReasoningEvent?.(event);
    } catch {
    }
  }
  async settleAfterAbort(iterator, pending, cancellation) {
    const deadlineAt = Date.now() + this.abortSettleTimeoutMs;
    const terminal = consumeUntilTerminal(iterator, pending);
    try {
      const [, event] = await within(Promise.all([cancellation, terminal]), remaining(deadlineAt));
      const cleanup = closeIterator(iterator);
      try {
        await within(cleanup, remaining(deadlineAt));
        return event;
      } catch {
        this.trackCleanup(cleanup);
        return void 0;
      }
    } catch {
      this.trackCleanup(terminal.then(() => closeIterator(iterator)));
      return void 0;
    }
  }
  async closeIteratorOrBlock(iterator) {
    const cleanup = closeIterator(iterator);
    try {
      await within(cleanup, this.abortSettleTimeoutMs);
    } catch (error) {
      this.trackCleanup(cleanup);
      throw ambiguousFailure("The DeepSeek Web request ended without confirmed transport cleanup.", error);
    }
  }
  trackCleanup(cleanup) {
    this.cleanupState = "pending";
    void cleanup.then(
      () => {
        this.cleanupState = "ready";
      },
      () => {
        this.cleanupState = "failed";
      }
    );
  }
};
function modelInfo(provider, model) {
  const expert = model === DEEPSEEK_WEB_EXPERT_MODEL;
  return {
    provider,
    id: model,
    name: expert ? "DeepSeek Web (Expert)" : "DeepSeek Web (Default)",
    description: expert ? "Uses Expert mode in the authenticated DeepSeek++ browser session." : "Uses Default mode in the authenticated DeepSeek++ browser session.",
    inputModalities: ["text"]
  };
}
async function nextOrAbort(iterator, signal) {
  const pending = Promise.resolve(iterator.next());
  if (signal?.aborted) return { kind: "aborted", pending };
  if (signal === void 0) return { kind: "next", result: await pending };
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      resolve({ kind: "aborted", pending });
    };
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve({ kind: "next", result });
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}
async function consumeUntilTerminal(iterator, first) {
  let next = await first;
  for (; ; ) {
    if (next.done) throw protocolFailure();
    if (isTerminal(next.value)) return next.value;
    next = await iterator.next();
  }
}
function closeIterator(iterator) {
  if (iterator.return === void 0) return Promise.resolve();
  try {
    return Promise.resolve(iterator.return()).then(() => void 0);
  } catch (error) {
    return Promise.reject(error);
  }
}
function within(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SETTLEMENT_TIMEOUT")), Math.max(1, timeoutMs));
    void Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function remaining(deadlineAt) {
  return Math.max(1, deadlineAt - Date.now());
}
function terminalFinish(event) {
  switch (event.type) {
    case "completed":
      return {
        type: "finish",
        reason: event.finish_reason === "tool_calls" ? { kind: "tool-calls" } : event.finish_reason === "length" ? { kind: "max-tokens" } : { kind: "stop" }
      };
    case "aborted":
      return errorFinish("WEB_MODEL_BROWSER_ABORTED", "The browser stopped the request before web generation was dispatched.");
    case "failed":
      if (event.error.code === LOCAL_REQUEST_BUDGET_EXCEEDED_CODE) {
        return errorFinish("WEB_MODEL_PROTOCOL", "The browser reported a reserved local failure code.");
      }
      return errorFinish(event.error.code, event.error.message);
    case "ambiguous":
      return ambiguousFinish(event.reason);
  }
}
function terminalAfterAbort(event) {
  if (event === void 0 || event.type === "completed") {
    return errorFinish("WEB_MODEL_CANCEL_UNCONFIRMED", "Cancellation was requested, but the web result or cleanup could not be confirmed. Do not replay automatically.");
  }
  return event.type === "aborted" ? abortedFinish() : terminalFinish(event);
}
function errorFinish(code, message) {
  return { type: "finish", reason: { kind: "error", failure: { code, message } } };
}
function ambiguousFinish(reason) {
  if (reason === "deepseek_rate_limit_reached") {
    return errorFinish("WEB_MODEL_RATE_LIMITED", "DeepSeek \u7F51\u9875\u63D0\u793A\u6D88\u606F\u53D1\u9001\u8FC7\u4E8E\u9891\u7E41\uFF0C\u672C\u8F6E\u5DF2\u6682\u505C\u3002\u8BF7\u81F3\u5C11\u7B49\u5F85 30 \u79D2\uFF1B\u8FDE\u7EED\u9650\u6D41\u65F6\u7B49\u5F85\u4F1A\u5EF6\u957F\u3002\u5DF2\u5B8C\u6210\u7684\u5DE5\u5177\u7ED3\u679C\u4FDD\u7559\uFF0C\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u653E\u3002\u5F53\u524D\u7F51\u9875\u94FE\u5DF2\u9694\u79BB\uFF0C\u8BF7\u6838\u5BF9\u8FDB\u5EA6\u540E\u5728 Harness \u4E2D\u65B0\u5EFA\u6216\u5206\u652F\u4F1A\u8BDD\u7EE7\u7EED\u3002");
  }
  if (reason === "generation_timeout" || reason === "accept_timeout" || reason === "request_timeout" || reason === "deepseek_turn_timeout") {
    return errorFinish("WEB_MODEL_TIMEOUT_AMBIGUOUS", "The web request timed out; its outcome is unknown. Do not replay automatically.");
  }
  if (reason === "browser_disconnected" || reason === "connection_closed" || reason === "connection_lost" || reason === "host_stopped") {
    return errorFinish("WEB_MODEL_DISCONNECTED_AMBIGUOUS", "The browser connection was lost; the web outcome is unknown. Reconnect to query the original request.");
  }
  return errorFinish("WEB_MODEL_AMBIGUOUS", "The DeepSeek Web model request outcome is ambiguous.");
}
function abortedFinish() {
  return {
    type: "finish",
    reason: { kind: "aborted", failure: { code: "ABORTED", message: "DeepSeek Web request aborted by caller." } }
  };
}
function isTerminal(event) {
  return event.type === "completed" || event.type === "aborted" || event.type === "failed" || event.type === "ambiguous";
}
function canonicalArguments(value) {
  return canonicalJson(value);
}
function protocolFailure() {
  return new LlmError3("The DeepSeek Web broker stream ended without one valid terminal event.", "WEB_MODEL_PROTOCOL");
}
function ambiguousFailure(message, cause) {
  return new LlmError3(message, "WEB_MODEL_AMBIGUOUS", cause === void 0 ? void 0 : { cause });
}
function normalizeAdapterError(error, signal) {
  if (error instanceof BrokerError && error.externalOutcome !== "not_started") {
    if (error.code === "REQUEST_TIMEOUT") {
      return new LlmError3("The web request timed out; its outcome is unknown. Do not replay automatically.", "WEB_MODEL_TIMEOUT_AMBIGUOUS", { cause: error });
    }
    if (error.code === "CONNECTION_LOST" || error.code === "BROKER_STOPPED") {
      return new LlmError3("The browser connection was lost; the web outcome is unknown. Reconnect to query the original request.", "WEB_MODEL_DISCONNECTED_AMBIGUOUS", { cause: error });
    }
    return ambiguousFailure("The DeepSeek Web model request outcome is ambiguous.", error);
  }
  if (error instanceof LlmError3) return error;
  if (signal?.aborted) return new LlmError3("DeepSeek Web request aborted by caller.", "ABORTED", { cause: error });
  if (error instanceof BrokerError) {
    switch (error.code) {
      case "WAITING_FOR_BROWSER":
        return new LlmError3("Waiting for an authenticated DeepSeek++ browser broker.", "WAITING_FOR_BROWSER", { cause: error });
      case "BROKER_BUSY":
        return new LlmError3("The DeepSeek Web browser broker is busy.", "BROKER_BUSY", { cause: error });
      case "JOURNAL_UNAVAILABLE":
        return new LlmError3("The local request journal could not be saved; no new web request was sent.", error.code, { cause: error });
      case "DEEPSEEK_AUTH_REQUIRED":
        return new LlmError3("Refresh the signed-in DeepSeek web page so the extension can use its login state.", error.code, { cause: error });
      case "DEEPSEEK_PREPARATION_FAILED":
      case "MODEL_PREPARATION_FAILED":
        return new LlmError3("The DeepSeek web model could not prepare the request before generation.", error.code, { cause: error });
      case "SESSION_QUARANTINED":
        return new LlmError3("\u4E0A\u4E00\u7F51\u9875\u8BF7\u6C42\u7684\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u5F53\u524D\u7F51\u9875\u94FE\u5DF2\u9694\u79BB\uFF1B\u672C\u6B21\u8BF7\u6C42\u5C1A\u672A\u53D1\u9001\u5230\u7F51\u9875\u3002\u8BF7\u5728 Harness \u4E2D\u65B0\u5EFA\u6216\u5206\u652F\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u5E76\u5148\u6838\u5BF9\u5DF2\u5B8C\u6210\u7684\u64CD\u4F5C\uFF1B\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u653E\u539F\u8BF7\u6C42\u3002", error.code, { cause: error });
      case "REQUEST_TIMEOUT":
        return new LlmError3("The DeepSeek Web browser broker timed out.", "TIMEOUT", { cause: error });
      case "PROTOCOL_VIOLATION":
      case "REQUEST_ALREADY_EXISTS":
      case "REQUEST_DIGEST_MISMATCH":
        return new LlmError3("The DeepSeek Web browser broker rejected the request contract.", "WEB_MODEL_PROTOCOL", { cause: error });
      case "BROKER_STOPPED":
      case "CONNECTION_LOST":
        return new LlmError3("The DeepSeek Web browser broker is unavailable.", "WEB_MODEL_TRANSPORT", { cause: error });
    }
  }
  return new LlmError3("The DeepSeek Web browser broker failed.", "WEB_MODEL_TRANSPORT", { cause: error });
}

// ../dsh-llm-deepseek-web/src/index.ts
function registerDeepSeekWebAdapter(ctx, broker, options = {}) {
  const adapter = new DeepSeekWebAdapter({ broker, ...options });
  ctx.llm.registerAdapter([DEEPSEEK_WEB_PROVIDER], adapter);
  return adapter;
}

// src/config.ts
import z from "@deepseek-ai/schemastery";

// src/connection-contract.ts
var DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web";
var DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN";
var DEEPSEEK_WEB_PROVIDER2 = "deepseek-web";
var DEEPSEEK_WEB_MODEL2 = "current-web-session";
var DEEPSEEK_WEB_EXPERT_MODEL2 = "current-web-session-expert";
var DEEPSEEK_WEB_REASONING_OFF2 = "off";
var DEEPSEEK_WEB_REASONING_ON2 = "on";
var DEEPSEEK_WEB_CONNECTION_NAMESPACE = "deepseekWebConnection";
var DEEPSEEK_WEB_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze(["status", "reconnect"].map((method) => Object.freeze({
    id: `@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebConnection/${method}`,
    service: "deepseekWebConnection",
    namespace: DEEPSEEK_WEB_CONNECTION_NAMESPACE,
    method,
    invocation: Object.freeze({ kind: "direct" }),
    parameters: Object.freeze([]),
    result: Object.freeze({ mode: "src-json" })
  })))
});

// src/config.ts
var DEFAULT_DEEPSEEK_WEB_BROKER_PORT = 43123;
var DeepSeekWebOfficialSettings = z.object({
  browser: z.union(["chrome", "edge", "firefox"]).default("chrome"),
  chromiumExtensionId: z.string().default(""),
  firefoxExtensionOrigin: z.string().default(""),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_DEEPSEEK_WEB_BROKER_PORT),
  webModelMode: z.union(["default", "expert"]).default("default"),
  thinkingEnabled: z.boolean().default(false),
  makeDefaultForNewSessions: z.boolean().default(false),
  windowsCommandsEnabled: z.boolean().default(false),
  windowsApprovalPolicy: z.union(["ask", "auto"]).default("ask"),
  powerShellExecutable: z.string().default("")
});
function validateOfficialSettings(value) {
  if (value.powerShellExecutable.includes("\0") || value.powerShellExecutable.length > 1024) {
    throw new Error("powerShellExecutable must be at most 1024 characters and contain no NUL byte");
  }
  if (value.browser === "firefox") {
    if (value.firefoxExtensionOrigin !== "" && !/^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value.firefoxExtensionOrigin)) {
      throw new Error("firefoxExtensionOrigin must be a complete moz-extension:// origin");
    }
    return;
  }
  if (value.chromiumExtensionId !== "" && !/^[a-p]{32}$/u.test(value.chromiumExtensionId)) {
    throw new Error("chromiumExtensionId must be a 32-character Chrome/Edge extension ID");
  }
}
function extensionOrigin(value) {
  if (value.browser === "firefox") return value.firefoxExtensionOrigin || void 0;
  return value.chromiumExtensionId === "" ? void 0 : `chrome-extension://${value.chromiumExtensionId}`;
}

// src/connection-controller.ts
var DeepSeekWebConnectionController = class {
  constructor(options) {
    this.options = options;
    this.broker = new TrackedBroker(this);
  }
  options;
  broker;
  host;
  cleanupHosts = /* @__PURE__ */ new Set();
  activeOperations = 0;
  tokenConfigured = false;
  pendingReconfigure = false;
  stopped = false;
  lastErrorCode;
  tail = Promise.resolve();
  async start() {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    await this.queueReconfigure();
  }
  status() {
    const settings = this.options.readSettings();
    const originConfigured = extensionOrigin(settings) !== void 0;
    const configured = originConfigured && this.tokenConfigured;
    const busy = this.activeOperations > 0;
    let phase;
    if (this.lastErrorCode !== void 0) phase = "error";
    else if (!configured || this.host === void 0) phase = "unconfigured";
    else if (busy) phase = "busy";
    else if (this.host.hasAuthenticatedPeer) phase = "connected";
    else phase = "waiting_for_browser";
    return Object.freeze({
      phase,
      configured,
      tokenConfigured: this.tokenConfigured,
      originConfigured,
      busy,
      pendingReconfigure: this.pendingReconfigure,
      browser: settings.browser,
      port: settings.port,
      windows: this.options.readWindowsStatus?.() ?? { kind: "disabled" },
      ...this.lastErrorCode === void 0 ? {} : { errorCode: this.lastErrorCode }
    });
  }
  async requestReconfigure(reason) {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    if (this.activeOperations > 0) {
      if (reason === "reconnect") {
        return { accepted: false, deferred: false, reason: "busy", status: this.status() };
      }
      this.pendingReconfigure = true;
      return { accepted: true, deferred: true, status: this.status() };
    }
    await this.queueReconfigure();
    const status = this.status();
    return {
      accepted: status.configured,
      deferred: false,
      ...status.configured ? {} : { reason: "unconfigured" },
      status
    };
  }
  async dispose() {
    this.stopped = true;
    this.pendingReconfigure = false;
    await this.tail;
    const host = this.host;
    this.host = void 0;
    if (host !== void 0) this.cleanupHosts.add(host);
    const failures = [];
    for (const candidate of this.cleanupHosts) {
      try {
        await candidate.stop();
        this.cleanupHosts.delete(candidate);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DeepSeek Web connection cleanup failed");
  }
  delegate() {
    if (this.host === void 0) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.host;
  }
  operationStarted() {
    this.activeOperations += 1;
  }
  operationFinished() {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0 || !this.pendingReconfigure || this.stopped) return;
    this.pendingReconfigure = false;
    void this.queueReconfigure().catch((error) => {
      this.lastErrorCode = "CONNECTION_START_FAILED";
      this.options.reportError?.(error);
    });
  }
  queueReconfigure() {
    const next = this.tail.then(() => this.reconfigure());
    this.tail = next.catch(() => void 0);
    return next;
  }
  async reconfigure() {
    if (this.stopped) return;
    if (this.activeOperations > 0) {
      this.pendingReconfigure = true;
      return;
    }
    const previous = this.host;
    this.host = void 0;
    this.lastErrorCode = void 0;
    if (previous !== void 0) {
      this.cleanupHosts.add(previous);
      try {
        await previous.stop();
        this.cleanupHosts.delete(previous);
      } catch (error) {
        this.connectionFailed(error);
        return;
      }
    }
    let next;
    try {
      const settings = this.options.readSettings();
      const origin = extensionOrigin(settings);
      const pairingToken = await this.options.resolvePairingToken();
      this.tokenConfigured = pairingToken !== void 0;
      if (origin === void 0 || pairingToken === void 0) return;
      next = this.options.createHost({
        pairingToken,
        allowedOrigins: [origin],
        port: settings.port
      });
      this.cleanupHosts.add(next);
      await next.start();
      if (this.stopped) {
        await next.stop();
        this.cleanupHosts.delete(next);
        return;
      }
      this.host = next;
      this.cleanupHosts.delete(next);
    } catch (error) {
      let reported = error;
      if (next !== void 0) {
        try {
          await next.stop();
          this.cleanupHosts.delete(next);
        } catch (cleanupError) {
          reported = new AggregateError([error, cleanupError], "DeepSeek Web connection startup cleanup failed");
        }
      }
      this.connectionFailed(reported);
    }
  }
  connectionFailed(error) {
    this.lastErrorCode = "CONNECTION_START_FAILED";
    this.options.reportError?.(error);
  }
};
function createDeepSeekWebModelHost(options) {
  return new DeepSeekWebModelHost(options);
}
var TrackedBroker = class {
  constructor(owner) {
    this.owner = owner;
  }
  owner;
  async *generate(request) {
    this.owner.operationStarted();
    try {
      yield* this.owner.delegate().generate(request);
    } finally {
      this.owner.operationFinished();
    }
  }
  async cancel(request) {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().cancel(request);
    } finally {
      this.owner.operationFinished();
    }
  }
  async query(request) {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().query(request);
    } finally {
      this.owner.operationFinished();
    }
  }
};

// src/connection-remote.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
var DeepSeekWebConnectionRemote = class extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, "deepseekWebConnection");
    this.controller = controller;
    for (const initialize of remoteInitializers) initialize.call(this);
  }
  controller;
  status() {
    return projectStatus(this.controller.status());
  }
  async reconnect() {
    const receipt = await this.controller.requestReconfigure("reconnect");
    return Object.freeze({
      accepted: receipt.accepted,
      deferred: receipt.deferred,
      ...receipt.reason === void 0 ? {} : { reason: receipt.reason },
      status: projectStatus(receipt.status)
    });
  }
};
function projectStatus(status) {
  return Object.freeze({
    phase: status.phase,
    configured: status.configured,
    tokenConfigured: status.tokenConfigured,
    originConfigured: status.originConfigured,
    busy: status.busy,
    pendingReconfigure: status.pendingReconfigure,
    browser: status.browser,
    port: status.port,
    windows: Object.freeze({ ...status.windows }),
    ...status.errorCode === void 0 ? {} : { errorCode: status.errorCode }
  });
}
var remoteInitializers = [];
markRemote("status");
markRemote("reconnect");
function markRemote(method) {
  const decorate3 = Remote;
  decorate3(DeepSeekWebConnectionRemote.prototype[method], {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    }
  });
}

// src/reasoning-remote.ts
import { Remote as Remote2, TypertRemoteService as TypertRemoteService2 } from "@deepseek-ai/dsh-typert-protocol";
var MAX_PENDING_FRAMES = 128;
var MAX_DELTA_TEXT = 16384;
var DeepSeekWebReasoningFeed = class {
  subscribers = /* @__PURE__ */ new Set();
  publish(event) {
    const frame = event.phase === "delta" ? { ...event, text: event.text.slice(0, MAX_DELTA_TEXT) } : { ...event };
    for (const subscriber of this.subscribers) subscriber(frame);
  }
  async *follow(signal) {
    const queue = [];
    let wake;
    const notify = (frame) => {
      if (queue.length >= MAX_PENDING_FRAMES) {
        if (frame.phase !== "end") return;
        queue.shift();
      }
      queue.push(frame);
      wake?.();
      wake = void 0;
    };
    const aborted = () => {
      wake?.();
      wake = void 0;
    };
    this.subscribers.add(notify);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise((resolve) => {
          wake = resolve;
        });
        while (queue.length > 0) yield queue.shift();
      }
    } finally {
      signal.removeEventListener("abort", aborted);
      this.subscribers.delete(notify);
    }
  }
};
var DeepSeekWebReasoningRemote = class extends TypertRemoteService2 {
  constructor(ctx, feed) {
    super(ctx, "deepseekWebReasoningRemote");
    this.feed = feed;
    for (const initialize of remoteInitializers2) initialize.call(this);
  }
  feed;
  follow(signal) {
    return this.feed.follow(signal);
  }
};
var remoteInitializers2 = [];
var decorate = Remote2({ mode: "stream" });
decorate(DeepSeekWebReasoningRemote.prototype.follow, {
  kind: "method",
  name: "follow",
  static: false,
  private: false,
  addInitializer(initializer) {
    remoteInitializers2.push(initializer);
  }
});

// src/session-import-remote.ts
import { Remote as Remote3, TypertRemoteService as TypertRemoteService3 } from "@deepseek-ai/dsh-typert-protocol";
var DeepSeekWebSessionImportRemote = class extends TypertRemoteService3 {
  constructor(ctx, importer) {
    super(ctx, "deepseekWebSessionImportRemote");
    this.importer = importer;
    for (const initialize of remoteInitializers3) initialize.call(this);
  }
  importer;
  async importCompleted(request) {
    if (!isRecord2(request) || typeof request.sourceHome !== "string" || typeof request.rootSessionId !== "string" || request.sourceProcessesStopped !== true || Object.keys(request).sort().join("\0") !== ["rootSessionId", "sourceHome", "sourceProcessesStopped"].sort().join("\0")) {
      throw new Error("SESSION_IMPORT_REQUEST_INVALID");
    }
    return this.importer.importCompleted(request);
  }
};
var remoteInitializers3 = [];
var decorate2 = Remote3;
decorate2(DeepSeekWebSessionImportRemote.prototype.importCompleted, {
  kind: "method",
  name: "importCompleted",
  static: false,
  private: false,
  addInitializer(initializer) {
    remoteInitializers3.push(initializer);
  }
});
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/windows-powershell.ts
import { createHash as createHash6, randomUUID as randomUUID3 } from "node:crypto";
import { open, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";
import { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local";
import * as PwshTools from "@deepseek-ai/dsh-tool-pwsh";
var POWERSHELL_7_REQUIRED = "POWERSHELL_7_REQUIRED";
var WINDOWS_COMMANDS_DISABLED = "WINDOWS_COMMANDS_DISABLED";
var WINDOWS_BACKGROUND_COMMANDS_DISABLED = "WINDOWS_BACKGROUND_COMMANDS_DISABLED";
var WINDOWS_COMMAND_POLICY_NOT_APPLIED = "WINDOWS_COMMAND_POLICY_NOT_APPLIED";
var WINDOWS_SESSION_POLICY_UNAVAILABLE = "WINDOWS_SESSION_POLICY_UNAVAILABLE";
var WINDOWS_COMMAND_DISCLOSURE = "Commands run with the current Windows user's permissions; cwd is not a sandbox or an isolation boundary.";
var POWERSHELL_PROBE_TIMEOUT_MS = 3e3;
var DEEPSEEK_WEB_PROVIDER3 = "deepseek-web";
var SESSION_POLICY_FILE_MAX_BYTES = 1024 * 1024;
var SESSION_POLICY_MAX_ENTRIES = 1e4;
var JsonWindowsSessionPolicyStore = class {
  filePath;
  tail = Promise.resolve();
  document;
  constructor(filePath) {
    if (!isAbsolute(filePath)) throw new Error("windows session policy path must be absolute");
    this.filePath = filePath;
  }
  get(sessionId, identity) {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    return this.enqueue(async () => {
      const record2 = (await this.load()).sessions[sessionId];
      return record2?.identity === identity ? record2.policy : void 0;
    });
  }
  putIfAbsent(sessionId, identity, policy) {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    const validated = resolveWindowsPowerShellConfig(policy);
    return this.enqueue(async () => {
      const current = await this.load();
      const existing = current.sessions[sessionId];
      if (existing !== void 0) {
        if (existing.identity !== identity) throw new Error("windows session policy identity does not match");
        return existing.policy;
      }
      if (Object.keys(current.sessions).length >= SESSION_POLICY_MAX_ENTRIES) {
        throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
      }
      const next = {
        version: 2,
        sessions: { ...current.sessions, [sessionId]: { identity, policy: validated } }
      };
      await writePolicyDocument(this.filePath, next);
      this.document = freezePolicyDocument(next);
      return validated;
    });
  }
  async flush() {
    await this.tail;
  }
  enqueue(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => void 0, () => void 0);
    return result;
  }
  async load() {
    if (this.document !== void 0) return this.document;
    await assertNoSymlinkComponents(this.filePath);
    let text;
    try {
      const file = await open(this.filePath, "r");
      try {
        const stats = await file.stat();
        if (stats.size > SESSION_POLICY_FILE_MAX_BYTES) {
          throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
        }
        text = await file.readFile("utf8");
        if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_FILE_MAX_BYTES) {
          throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.document = freezePolicyDocument({ version: 2, sessions: {} });
        return this.document;
      }
      throw error;
    }
    this.document = parsePolicyDocument(text);
    return this.document;
  }
};
function resolveWindowsPowerShellConfig(config) {
  if (config.enabled !== void 0 && typeof config.enabled !== "boolean") {
    throw new Error("windowsPowerShell.enabled must be a boolean");
  }
  if (config.approvalPolicy !== void 0 && config.approvalPolicy !== "ask" && config.approvalPolicy !== "auto") {
    throw new Error("windowsPowerShell.approvalPolicy must be ask or auto");
  }
  return {
    enabled: config.enabled ?? false,
    approvalPolicy: config.approvalPolicy ?? "ask"
  };
}
async function probePowerShell7(ctx, executable, signal, timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS) {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw powerShell7Error("no PowerShell 7 executable was configured");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("PowerShell probe timeout must be positive");
  const deadline2 = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal === void 0 ? deadline2 : AbortSignal.any([signal, deadline2]);
  let resolved;
  try {
    resolved = await raceAbort(
      ctx.subprocess.resolveExecutable(executable.trim(), void 0, operationSignal),
      operationSignal
    );
  } catch (cause) {
    if (deadline2.aborted && !signal?.aborted) {
      throw powerShell7Error(`probe timed out after ${timeoutMs}ms while resolving the executable`, cause);
    }
    throw powerShell7Error(`cannot resolve ${JSON.stringify(executable.trim())}`, cause);
  }
  const handle = ctx.subprocess.spawn({
    argv: [
      resolved,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write($PSVersionTable.PSVersion.Major)"
    ],
    cwd: process.cwd(),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 64 },
      stderr: { maxBytes: 512 }
    },
    graceMs: 500,
    signal: operationSignal
  });
  try {
    const outcome = await raceAbort(handle.done, operationSignal);
    await handle.waitForExit(operationSignal);
    const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? "";
    const major = Number(stdout);
    if (outcome.exitCode !== 0 || !Number.isSafeInteger(major) || major < 7) {
      const detail = stderr.length > 0 ? stderr : `reported major version ${stdout || "unknown"}`;
      throw powerShell7Error(`${resolved} is not PowerShell 7 (${detail})`);
    }
    return { executable: resolved, major };
  } catch (cause) {
    handle.terminate();
    await handle.waitForExit().catch(() => false);
    if (deadline2.aborted && !signal?.aborted) {
      throw powerShell7Error(`probe timed out after ${timeoutMs}ms`, cause);
    }
    if (cause instanceof Error && cause.message.startsWith(POWERSHELL_7_REQUIRED)) throw cause;
    throw powerShell7Error(`failed to verify ${resolved}`, cause);
  }
}
function raceAbort(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    operation,
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  ]);
}
async function installWindowsPowerShellPolicy(ctx, input, sessionPolicies, readCurrentConfig, readRequiredExecutable, isImportedSessionDenied) {
  let defaultConfig = resolveWindowsPowerShellConfig(input);
  let verifiedPowerShell;
  let verifiedDeclaredPath;
  let status = { kind: "disabled" };
  const policies = /* @__PURE__ */ new WeakMap();
  const pendingWrites = /* @__PURE__ */ new Set();
  const nativeStacks = /* @__PURE__ */ new Map();
  const configuredExecutable = () => {
    if (process.platform !== "win32") {
      throw powerShell7Error("native Windows commands are available on Windows only");
    }
    const shell = ctx.get("shell");
    if (shell === void 0 || typeof shell.pwshPath !== "string" || shell.pwshPath.trim().length === 0) {
      throw powerShell7Error("the official PowerShell executor is not mounted");
    }
    const actual = shell.pwshPath.trim();
    const required = readRequiredExecutable?.().trim() ?? "";
    if (required !== "" && actual !== required) {
      throw powerShell7Error("the configured executable has not been applied by the official Shell settings");
    }
    return actual;
  };
  const ensureAvailable = async (signal, force = false) => {
    try {
      const executable = configuredExecutable();
      if (!force && verifiedPowerShell !== void 0 && verifiedDeclaredPath === executable) {
        return verifiedPowerShell;
      }
      const powershell = await probePowerShell7(ctx, executable, signal);
      verifiedPowerShell = powershell;
      verifiedDeclaredPath = executable;
      status = { kind: "available", powershell };
      return powershell;
    } catch (error) {
      if (signal?.aborted) return void 0;
      verifiedPowerShell = void 0;
      verifiedDeclaredPath = void 0;
      const message = error instanceof Error ? error.message : `${POWERSHELL_7_REQUIRED}: ${String(error)}`;
      status = { kind: "unavailable", code: POWERSHELL_7_REQUIRED, message };
      return void 0;
    }
  };
  const refreshStatus = async () => {
    if (!defaultConfig.enabled) {
      status = { kind: "disabled" };
      return status;
    }
    await ensureAvailable(void 0, true);
    return status;
  };
  const trackWrite = (write) => {
    pendingWrites.add(write);
    void write.finally(() => {
      pendingWrites.delete(write);
    });
    return write;
  };
  const createState = (session) => {
    const existing = policies.get(session);
    if (existing !== void 0) return existing;
    const isNew = isFreshWindowsPolicySession(session);
    const currentDefault = resolveWindowsPowerShellConfig(readCurrentConfig?.() ?? defaultConfig);
    const state = {
      policy: isNew ? currentDefault : DISABLED_SESSION_POLICY,
      ready: Promise.resolve()
    };
    policies.set(session, state);
    const identity = windowsSessionPolicyIdentity(session);
    const imported = isImportedSessionDenied?.(String(session.id)) === true;
    if (imported) state.policy = DISABLED_SESSION_POLICY;
    const operation = imported ? Promise.resolve(void 0) : isNew ? sessionPolicies.putIfAbsent(String(session.id), identity, state.policy) : sessionPolicies.get(String(session.id), identity);
    const ready = operation.then((stored) => {
      state.policy = stored ?? DISABLED_SESSION_POLICY;
    }, (error) => {
      state.policy = DISABLED_SESSION_POLICY;
      state.failure = `${WINDOWS_SESSION_POLICY_UNAVAILABLE}: ${errorMessage(error)}`;
    });
    state.ready = isNew ? trackWrite(ready) : ready;
    return state;
  };
  const policyFor = async (session) => {
    if (session === void 0) {
      return { policy: DISABLED_SESSION_POLICY, ready: Promise.resolve() };
    }
    const cached = policies.get(session);
    const state = cached ?? createState(session);
    await state.ready;
    return state;
  };
  const flush = async () => {
    await Promise.all([...pendingWrites]);
    await sessionPolicies.flush();
  };
  ctx.effect(() => async () => {
    await flush();
  });
  ctx.on("session/created", (session) => {
    createState(session);
  });
  const disposeNativeStack = async (agent) => {
    const stack = nativeStacks.get(agent);
    if (stack === void 0) return;
    nativeStacks.delete(agent);
    const failures = [];
    try {
      await stack.toolFiber.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await stack.shellFiber.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "native PowerShell stack disposal failed");
  };
  const ensureNativeStack = async (agent) => {
    if (process.platform !== "win32" || providerForNextStep(agent) !== DEEPSEEK_WEB_PROVIDER3) {
      await disposeNativeStack(agent);
      return;
    }
    const executable = configuredExecutable();
    const current = nativeStacks.get(agent);
    if (current?.executable === executable) return;
    await disposeNativeStack(agent);
    const nativeCtx = agent.ctx.isolate("shell").isolate("settings");
    const shellFiber = await nativeCtx.plugin(PwshLocalExecutor, { pwshPath: executable });
    try {
      const toolFiber = await nativeCtx.plugin(PwshTools, { enableRunInBackground: false });
      nativeStacks.set(agent, { executable, shellFiber, toolFiber });
    } catch (error) {
      await shellFiber.dispose();
      throw error;
    }
  };
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const agent = context.agent;
    if (agent === void 0) return next();
    await ensureNativeStack(agent);
    const transformed = await next();
    const pwsh = ctx.tools.schemas(agent).find((schema) => schema.name === "pwsh");
    if (pwsh === void 0 || !assembly.tools.some((schema) => schema.name === "pwsh")) {
      return transformed;
    }
    return {
      ...transformed,
      tools: transformed.tools.map((schema) => schema.name === "pwsh" ? pwsh : schema)
    };
  }, { prepend: true });
  ctx.on("agent/disposed", ({ agent }) => {
    nativeStacks.delete(agent);
  });
  ctx.effect(() => async () => {
    const failures = await Promise.allSettled([...nativeStacks.keys()].map(disposeNativeStack));
    const rejected = failures.flatMap((failure) => failure.status === "rejected" ? [failure.reason] : []);
    if (rejected.length === 1) throw rejected[0];
    if (rejected.length > 1) throw new AggregateError(rejected, "native PowerShell stacks disposal failed");
  });
  await refreshStatus();
  const admitted = /* @__PURE__ */ new WeakSet();
  ctx.on("tools/result", (exec) => {
    admitted.delete(exec);
  });
  ctx.tools.guard((exec) => {
    if (exec.name !== "pwsh" || !isDeepSeekWebExecution(exec)) return void 0;
    const state = exec.agent === void 0 ? void 0 : policies.get(exec.agent.session);
    if (state === void 0 || !state.policy.enabled) return WINDOWS_COMMANDS_DISABLED;
    if (requestsBackgroundExecution(exec)) return WINDOWS_BACKGROUND_COMMANDS_DISABLED;
    const allowed = admitted.has(exec);
    admitted.delete(exec);
    return allowed ? void 0 : WINDOWS_COMMAND_POLICY_NOT_APPLIED;
  });
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "pwsh" || !isDeepSeekWebExecution(exec)) return next();
    const state = await policyFor(exec.agent?.session);
    if (state.failure !== void 0) return { kind: "deny", reason: state.failure };
    const policy = state.policy;
    if (!policy.enabled) return { kind: "deny", reason: WINDOWS_COMMANDS_DISABLED };
    if (requestsBackgroundExecution(exec)) {
      return { kind: "deny", reason: WINDOWS_BACKGROUND_COMMANDS_DISABLED };
    }
    if (await ensureAvailable(exec.signal) === void 0) {
      if (exec.signal.aborted) {
        admitted.add(exec);
        return next();
      }
      const unavailable = status.kind === "unavailable" ? status.message : POWERSHELL_7_REQUIRED;
      return { kind: "deny", reason: unavailable };
    }
    admitted.add(exec);
    if (policy.approvalPolicy === "auto") return next();
    return {
      kind: "ask",
      reason: `Approve this one foreground PowerShell 7 command. ${WINDOWS_COMMAND_DISCLOSURE}`
    };
  }, { prepend: true });
  return {
    get config() {
      return defaultConfig;
    },
    get status() {
      return status;
    },
    async update(nextInput) {
      defaultConfig = resolveWindowsPowerShellConfig(nextInput);
      return refreshStatus();
    },
    flush
  };
}
var DISABLED_SESSION_POLICY = Object.freeze({
  enabled: false,
  approvalPolicy: "ask"
});
function isFreshWindowsPolicySession(session) {
  return Number(session.firstLiveSeq) === 0 && session.snapshotEvents()[0]?.type !== "session/end-seed";
}
function providerForNextStep(agent) {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "model/selection") {
      const data = plainRecord(event.data);
      if (typeof data?.provider === "string") return data.provider;
    }
    if (event.type === "request/header") return event.data.header.config.provider;
  }
  return agent.options.provider;
}
function providerForToolExecution(agent) {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "request/header") return event.data.header.config.provider;
  }
  return agent.options.provider;
}
function isDeepSeekWebExecution(exec) {
  return exec.agent !== void 0 && providerForToolExecution(exec.agent) === DEEPSEEK_WEB_PROVIDER3;
}
function windowsSessionPolicyIdentity(session) {
  const header = session.header;
  return createHash6("sha256").update(JSON.stringify([
    header.version,
    header.id,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded,
    header.origin ?? null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null
  ])).digest("hex");
}
function requestsBackgroundExecution(exec) {
  const args = plainRecord(exec.arguments);
  return args?.run_in_background === true;
}
function plainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : void 0;
}
function powerShell7Error(message, cause) {
  return new Error(`${POWERSHELL_7_REQUIRED}: ${message}`, cause === void 0 ? {} : { cause });
}
function parsePolicyDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("windows session policy file is not valid JSON", { cause });
  }
  if (!hasExactKeys(parsed, ["version", "sessions"]) || parsed.version !== 2 || !isPlainRecord(parsed.sessions)) {
    throw new Error("windows session policy file must be exactly {version:2,sessions:{...}}");
  }
  const entries = Object.entries(parsed.sessions);
  if (entries.length > SESSION_POLICY_MAX_ENTRIES) {
    throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
  }
  const sessions = /* @__PURE__ */ Object.create(null);
  for (const [sessionId, value] of entries) {
    validateSessionId(sessionId);
    if (!hasExactKeys(value, ["identity", "policy"]) || !hasExactKeys(value.policy, ["enabled", "approvalPolicy"])) {
      throw new Error(`windows session policy for ${JSON.stringify(sessionId)} has unknown or missing fields`);
    }
    validateSessionIdentity(value.identity);
    sessions[sessionId] = Object.freeze({
      identity: value.identity,
      policy: Object.freeze(resolveWindowsPowerShellConfig(value.policy))
    });
  }
  return freezePolicyDocument({ version: 2, sessions });
}
function freezePolicyDocument(document) {
  const sessions = /* @__PURE__ */ Object.create(null);
  for (const [sessionId, record2] of Object.entries(document.sessions)) {
    sessions[sessionId] = Object.freeze({ identity: record2.identity, policy: Object.freeze({ ...record2.policy }) });
  }
  return Object.freeze({ version: 2, sessions: Object.freeze(sessions) });
}
async function writePolicyDocument(filePath, document) {
  const directory = dirname(filePath);
  await assertNoSymlinkComponents(filePath);
  await mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(filePath);
  const text = `${JSON.stringify(document)}
`;
  if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_FILE_MAX_BYTES) {
    throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
  }
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID3()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, "wx", 384);
    created = true;
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}
async function assertNoSymlinkComponents(filePath) {
  const root = parse(filePath).root;
  let current = root;
  for (const component of relative(root, filePath).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`windows session policy path contains a symbolic link or reparse point: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) break;
      throw error;
    }
  }
}
function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256 || sessionId === "__proto__" || sessionId === "prototype" || sessionId === "constructor") {
    throw new Error("windows session policy session id is invalid");
  }
}
function validateSessionIdentity(identity) {
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error("windows session policy identity is invalid");
  }
}
function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/managed-broker.ts
var ManagedDeepSeekWebBroker = class {
  delegate;
  attach(delegate) {
    if (this.delegate !== void 0) throw new Error("DEEPSEEK_WEB_BROKER_ALREADY_ATTACHED");
    this.delegate = delegate;
  }
  detach(delegate) {
    if (this.delegate === delegate) this.delegate = void 0;
  }
  async *generate(request) {
    const delegate = this.available();
    yield* delegate.generate(request);
  }
  cancel(request) {
    return this.available().cancel(request);
  }
  query(request) {
    return this.available().query(request);
  }
  available() {
    if (this.delegate === void 0) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.delegate;
  }
};

// src/reasoning-contract.ts
var DEEPSEEK_WEB_REASONING_NAMESPACE = "deepseekWebReasoning";
var FRAME_CODEC = Object.freeze({
  mode: "strict",
  typeSymbol: "@deepseek-pp/dsh-deepseek-web-official-plugin/reasoning-contract#DeepSeekWebReasoningFrame",
  schema: Object.freeze({ parse: decodeReasoningFrame })
});
var DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze([Object.freeze({
    id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebReasoningRemote/follow",
    service: "deepseekWebReasoningRemote",
    namespace: DEEPSEEK_WEB_REASONING_NAMESPACE,
    method: "follow",
    mode: "stream",
    invocation: Object.freeze({ kind: "direct" }),
    parameters: Object.freeze([]),
    cancellation: Object.freeze({ parameter: "signal" }),
    result: FRAME_CODEC
  })])
});
function decodeReasoningFrame(value) {
  if (!isRecord3(value) || typeof value.sessionId !== "string" || typeof value.requestId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 256 || value.requestId.length === 0 || value.requestId.length > 256) throw new Error("Invalid DeepSeek Web reasoning frame");
  if (value.phase === "delta") {
    if (Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId", "text"].join("\0") || typeof value.text !== "string" || value.text.length > 16384) {
      throw new Error("Invalid DeepSeek Web reasoning frame");
    }
    return { phase: "delta", sessionId: value.sessionId, requestId: value.requestId, text: value.text };
  }
  if (value.phase !== "start" && value.phase !== "end" || Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId"].join("\0")) {
    throw new Error("Invalid DeepSeek Web reasoning frame");
  }
  return { phase: value.phase, sessionId: value.sessionId, requestId: value.requestId };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/index.ts
var name = "deepseek-web-official";
var inject = ["settings", "credentials", "agentDefaultModel", "llm", "tools", "subprocess", "shell", "deepseekWebSessionImport"];
async function apply(ctx) {
  const settings = ctx.settings.register(
    DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    DeepSeekWebOfficialSettings,
    { applies: "live", validate: validateOfficialSettings }
  );
  await applyPowerShellExecutable(ctx, settings.get().powerShellExecutable, false).catch((error) => {
    ctx.logger.warn("DeepSeek Web could not apply the PowerShell executable setting");
    ctx.logger.warn(error);
  });
  const windowsPolicy = await installWindowsPowerShellPolicy(
    ctx,
    windowsConfig(settings.get()),
    new JsonWindowsSessionPolicyStore(
      dshHomePath("profiles", "web", "deepseek-web-official", "windows-session-policies.json")
    ),
    () => windowsConfig(settings.get()),
    () => settings.get().powerShellExecutable,
    (sessionId) => ctx.deepseekWebSessionImport.isImportedSessionDenied(sessionId)
  );
  const connection = new DeepSeekWebConnectionController({
    readSettings: () => settings.get(),
    resolvePairingToken: async () => (await ctx.credentials.resolve(credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF)))?.value,
    createHost: (options) => createDeepSeekWebModelHost({
      ...options,
      journalPath: dshHomePath("profiles", "web", "deepseek-web-model-journal")
    }),
    readWindowsStatus: () => projectWindowsStatus(windowsPolicy.status),
    reportError: (error) => {
      ctx.logger.warn("DeepSeek Web connection reconfiguration failed");
      ctx.logger.warn(error);
    }
  });
  const unprovide = ctx.provide("deepseekWebBroker", connection.broker);
  const reasoningFeed = new DeepSeekWebReasoningFeed();
  registerDeepSeekWebAdapter(ctx, connection.broker, {
    onReasoningEvent: (event) => reasoningFeed.publish(event)
  });
  new DeepSeekWebConnectionRemote(ctx, connection);
  new DeepSeekWebReasoningRemote(ctx, reasoningFeed);
  new DeepSeekWebSessionImportRemote(ctx, ctx.deepseekWebSessionImport);
  const stopWatchingSettings = settings.watch(async (next, previous) => {
    if (connectionSettingsChanged(next, previous)) await connection.requestReconfigure("settings");
    if (next.powerShellExecutable !== previous.powerShellExecutable) {
      await applyPowerShellExecutable(ctx, next.powerShellExecutable, true);
    }
    if (windowsSettingsChanged(next, previous)) await windowsPolicy.update(windowsConfig(next));
    if (next.makeDefaultForNewSessions && !previous.makeDefaultForNewSessions || webModelDefaultsChanged(next, previous)) {
      await applyRequestedDefault(ctx, next, () => settings.update({ makeDefaultForNewSessions: false }));
    }
  });
  const stopWatchingCredential = ctx.on("credentials/reference-updated", (ref) => {
    if (ref === credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF)) {
      return connection.requestReconfigure("credential").then(() => void 0);
    }
  });
  try {
    await connection.start();
    await applyRequestedDefault(ctx, settings.get(), () => settings.update({ makeDefaultForNewSessions: false }));
  } catch (error) {
    const cleanupFailures = [];
    stopWatchingCredential();
    stopWatchingSettings();
    try {
      await unprovide();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await connection.dispose();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await windowsPolicy.flush();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "DeepSeek Web official plugin startup cleanup failed"
      );
    }
    throw error;
  }
  return async () => {
    stopWatchingCredential();
    stopWatchingSettings();
    const failures = [];
    try {
      await unprovide();
    } catch (error) {
      failures.push(error);
    }
    try {
      await connection.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await windowsPolicy.flush();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DeepSeek Web official plugin disposal failed");
  };
}
function windowsConfig(settings) {
  return {
    enabled: settings.windowsCommandsEnabled,
    approvalPolicy: settings.windowsApprovalPolicy
  };
}
function connectionSettingsChanged(left, right) {
  return left.browser !== right.browser || left.chromiumExtensionId !== right.chromiumExtensionId || left.firefoxExtensionOrigin !== right.firefoxExtensionOrigin || left.port !== right.port;
}
function windowsSettingsChanged(left, right) {
  return left.windowsCommandsEnabled !== right.windowsCommandsEnabled || left.windowsApprovalPolicy !== right.windowsApprovalPolicy || left.powerShellExecutable !== right.powerShellExecutable;
}
function webModelDefaultsChanged(left, right) {
  return (left.webModelMode ?? "default") !== (right.webModelMode ?? "default") || (left.thinkingEnabled ?? false) !== (right.thinkingEnabled ?? false);
}
async function applyPowerShellExecutable(ctx, input, clearWhenEmpty) {
  if (process.platform !== "win32") return;
  const executable = input.trim();
  const current = ctx.get("shell");
  if (executable !== "" && current?.pwshPath === executable) return;
  if (executable === "" && !clearWhenEmpty) return;
  if (executable === "") {
    await ctx.settings.mutate("shell", [{ op: "unset", path: ["pwshPath"] }]);
    return;
  }
  await ctx.settings.update("shell", { pwshPath: executable });
}
function projectWindowsStatus(status) {
  if (status.kind === "available") {
    return { kind: "available", executable: status.powershell.executable, major: status.powershell.major };
  }
  if (status.kind === "unavailable") {
    return { kind: "unavailable", code: status.code, message: status.message };
  }
  return { kind: "disabled" };
}
async function applyRequestedDefault(ctx, settings, consume) {
  const authority = ctx.get("agentDefaultModel");
  if (authority === void 0) {
    if (!settings.makeDefaultForNewSessions) return;
    throw new Error("DEEPSEEK_WEB_DEFAULT_MODEL_AUTHORITY_UNAVAILABLE");
  }
  const selected = {
    provider: DEEPSEEK_WEB_PROVIDER2,
    model: (settings.webModelMode ?? "default") === "expert" ? DEEPSEEK_WEB_EXPERT_MODEL2 : DEEPSEEK_WEB_MODEL2,
    reasoningEffort: ReasoningEffortId2(
      settings.thinkingEnabled ?? false ? DEEPSEEK_WEB_REASONING_ON2 : DEEPSEEK_WEB_REASONING_OFF2
    )
  };
  if (!settings.makeDefaultForNewSessions) {
    const current = authority.currentSelection();
    if (current.provider !== DEEPSEEK_WEB_PROVIDER2) return;
    if (current.model === selected.model && current.reasoningEffort === selected.reasoningEffort) return;
  }
  await authority.saveSelection(selected);
  if (settings.makeDefaultForNewSessions) await consume?.();
}
export {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_PROVIDER3 as DEEPSEEK_WEB_PROVIDER,
  DEEPSEEK_WEB_REASONING_NAMESPACE,
  DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  DEFAULT_DEEPSEEK_WEB_BROKER_PORT,
  DeepSeekWebConnectionController,
  DeepSeekWebConnectionRemote,
  DeepSeekWebOfficialSettings,
  DeepSeekWebReasoningFeed,
  DeepSeekWebReasoningRemote,
  JsonWindowsSessionPolicyStore,
  ManagedDeepSeekWebBroker,
  POWERSHELL_7_REQUIRED,
  POWERSHELL_PROBE_TIMEOUT_MS,
  WINDOWS_BACKGROUND_COMMANDS_DISABLED,
  WINDOWS_COMMANDS_DISABLED,
  WINDOWS_COMMAND_DISCLOSURE,
  WINDOWS_COMMAND_POLICY_NOT_APPLIED,
  WINDOWS_SESSION_POLICY_UNAVAILABLE,
  apply,
  applyRequestedDefault,
  createDeepSeekWebModelHost,
  decodeReasoningFrame,
  extensionOrigin,
  inject,
  installWindowsPowerShellPolicy,
  isFreshWindowsPolicySession,
  name,
  probePowerShell7,
  providerForNextStep,
  providerForToolExecution,
  resolveWindowsPowerShellConfig,
  validateOfficialSettings,
  windowsSessionPolicyIdentity
};
