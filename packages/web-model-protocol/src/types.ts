export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = string;

export interface BridgeCapabilities {
  text?: true;
  reasoning?: true;
  structured_tool_calls: true;
  usage?: true;
  cancel: true;
  query: true;
}

export interface BridgeHelloRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: "bridge.hello";
  params: {
    schema_version: 1;
    pairing_token: string;
    browser_instance_id: string;
    client: { name: "DeepSeek++"; version: string };
    capabilities: BridgeCapabilities;
  };
}

export interface BridgeHelloResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: {
    schema_version: 1;
    type: "bridge.hello";
    connection_id: string;
    status: "ready";
    capabilities: BridgeCapabilities;
  };
}

export type Purpose = "agent" | "session-title" | "compaction";

export type TextContent = { type: "text"; text: string };
export type ToolCallContent = {
  type: "tool_call";
  tool_call_id: string;
  name: string;
  arguments: JsonObject;
};
export type ToolResultContent = {
  type: "tool_result";
  tool_call_id: string;
  content: TextContent[];
  is_error: boolean;
};
export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export interface ModelGenerateRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: "model.generate";
  params: {
    schema_version: 1;
    request_id: string;
    session_id: string;
    request_digest: string;
    purpose: Purpose;
    model: { provider: "deepseek-web"; model_id: "current-web-session" };
    input: {
      messages: Array<{
        role: "system" | "user" | "assistant" | "tool";
        content: MessageContent[];
      }>;
    };
    tools: Array<{ name: string; description: string; input_schema: JsonObject }>;
    options: {
      thinking_enabled: boolean;
      search_enabled: boolean;
      model_type: "default" | "expert" | "vision";
      timeout_ms?: number;
    };
  };
}

export interface ModelAcceptedResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: {
    schema_version: 1;
    type: "model.accepted";
    request_id: string;
    request_digest: string;
    status: "accepted";
  };
}

export type ModelTerminalEvent =
  | { type: "completed"; finish_reason: "stop" | "length" | "tool_calls" }
  | { type: "aborted"; reason: string }
  | {
      type: "failed";
      error: {
        code: string;
        message: string;
        retryable: false;
        external_outcome: "started" | "unknown";
      };
    }
  | { type: "ambiguous"; reason: string };

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; retention: "ephemeral" }
  | { type: "tool_call"; tool_call_id: string; name: string; arguments: JsonObject }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    }
  | ModelTerminalEvent;

export interface ModelEventNotification {
  jsonrpc: "2.0";
  method: "model.event";
  params: {
    schema_version: 1;
    request_id: string;
    sequence: number;
    event: ModelEvent;
  };
}

export interface ModelCancelRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: "model.cancel";
  params: { schema_version: 1; request_id: string; request_digest: string; reason?: string };
}

export interface ModelCancelledResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: {
    schema_version: 1;
    type: "model.cancelled";
    request_id: string;
    request_digest: string;
    status: "cancel_requested" | "already_terminal" | "not_found";
  };
}

export interface ModelQueryRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: "model.query";
  params: { schema_version: 1; request_id: string; request_digest: string };
}

export type ModelStatus = "unknown" | "accepted" | "streaming" | "completed" | "aborted" | "failed" | "ambiguous";

export interface ModelStatusResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result: {
    schema_version: 1;
    type: "model.status";
    request_id: string;
    request_digest: string;
    status: ModelStatus;
    last_sequence: number;
    terminal?: ModelTerminalEvent;
  };
}

export interface BridgeHeartbeatNotification {
  jsonrpc: "2.0";
  method: "bridge.heartbeat";
  params: {
    schema_version: 1;
    connection_id: string;
    nonce: string;
    sent_at_ms: number;
  };
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: {
    code: number;
    message: string;
    data: {
      schema_version: 1;
      error_code: string;
      retryable: boolean;
      external_outcome: "not_started" | "started" | "unknown";
      request_id?: string;
      request_digest?: string;
    };
  };
}

export type WebModelRequest = BridgeHelloRequest | ModelGenerateRequest | ModelCancelRequest | ModelQueryRequest;
export type WebModelNotification = ModelEventNotification | BridgeHeartbeatNotification;
export type WebModelResponse =
  | BridgeHelloResponse
  | ModelAcceptedResponse
  | ModelCancelledResponse
  | ModelStatusResponse
  | JsonRpcErrorResponse;
export type WebModelFrame = WebModelRequest | WebModelNotification | WebModelResponse;
