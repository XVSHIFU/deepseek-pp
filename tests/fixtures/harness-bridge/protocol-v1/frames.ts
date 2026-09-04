export const pairingToken = "A".repeat(43);

export const helloRequest = {
  jsonrpc: "2.0",
  id: "rpc-hello",
  method: "bridge.hello",
  params: {
    schema_version: 1,
    pairing_token: pairingToken,
    browser_instance_id: "browser-1",
    client: { name: "DeepSeek++", version: "1.14.0" },
    capabilities: {
      text: true,
      structured_tool_calls: true,
      usage: true,
      cancel: true,
      query: true,
    },
  },
} as const;

export const helloResponse = {
  jsonrpc: "2.0",
  id: "rpc-hello",
  result: {
    schema_version: 1,
    type: "bridge.hello",
    connection_id: "connection-1",
    status: "ready",
    capabilities: {
      text: true,
      structured_tool_calls: true,
      usage: true,
      cancel: true,
      query: true,
    },
  },
} as const;

export const generateRequest = {
  jsonrpc: "2.0",
  id: "rpc-generate",
  method: "model.generate",
  params: {
    schema_version: 1,
    request_id: "request-1",
    session_id: "session-1",
    request_digest: "a".repeat(64),
    purpose: "agent",
    model: { provider: "deepseek-web", model_id: "current-web-session" },
    input: {
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        { role: "user", content: [{ type: "text", text: "Inspect the repository." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              tool_call_id: "call-1",
              name: "list_files",
              arguments: { path: "." },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_call_id: "call-1",
              content: [{ type: "text", text: "README.md" }],
              is_error: false,
            },
          ],
        },
      ],
    },
    tools: [
      {
        name: "list_files",
        description: "List files below a registered workspace path.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    options: {
      thinking_enabled: true,
      search_enabled: false,
      model_type: "expert",
      timeout_ms: 120000,
    },
  },
} as const;

export const acceptedResponse = {
  jsonrpc: "2.0",
  id: "rpc-generate",
  result: {
    schema_version: 1,
    type: "model.accepted",
    request_id: "request-1",
    request_digest: "a".repeat(64),
    status: "accepted",
  },
} as const;

export const eventFrames = [
  {
    jsonrpc: "2.0",
    method: "model.event",
    params: {
      schema_version: 1,
      request_id: "request-1",
      sequence: 1,
      event: { type: "reasoning_delta", text: "I will inspect it.", retention: "ephemeral" },
    },
  },
  {
    jsonrpc: "2.0",
    method: "model.event",
    params: {
      schema_version: 1,
      request_id: "request-1",
      sequence: 2,
      event: { type: "text_delta", text: "Calling a local tool." },
    },
  },
  {
    jsonrpc: "2.0",
    method: "model.event",
    params: {
      schema_version: 1,
      request_id: "request-1",
      sequence: 3,
      event: {
        type: "tool_call",
        tool_call_id: "call-2",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    },
  },
  {
    jsonrpc: "2.0",
    method: "model.event",
    params: {
      schema_version: 1,
      request_id: "request-1",
      sequence: 4,
      event: {
        type: "usage",
        input_tokens: 120,
        output_tokens: 42,
        cache_read_tokens: 10,
      },
    },
  },
  {
    jsonrpc: "2.0",
    method: "model.event",
    params: {
      schema_version: 1,
      request_id: "request-1",
      sequence: 5,
      event: { type: "completed", finish_reason: "tool_calls" },
    },
  },
] as const;

export const cancelRequest = {
  jsonrpc: "2.0",
  id: "rpc-cancel",
  method: "model.cancel",
  params: {
    schema_version: 1,
    request_id: "request-1",
    request_digest: "a".repeat(64),
    reason: "user_requested",
  },
} as const;

export const cancelResponse = {
  jsonrpc: "2.0",
  id: "rpc-cancel",
  result: {
    schema_version: 1,
    type: "model.cancelled",
    request_id: "request-1",
    request_digest: "a".repeat(64),
    status: "already_terminal",
  },
} as const;

export const queryRequest = {
  jsonrpc: "2.0",
  id: "rpc-query",
  method: "model.query",
  params: { schema_version: 1, request_id: "request-1", request_digest: "a".repeat(64) },
} as const;

export const queryResponse = {
  jsonrpc: "2.0",
  id: "rpc-query",
  result: {
    schema_version: 1,
    type: "model.status",
    request_id: "request-1",
    request_digest: "a".repeat(64),
    status: "completed",
    last_sequence: 5,
    terminal: { type: "completed", finish_reason: "tool_calls" },
  },
} as const;

export const heartbeat = {
  jsonrpc: "2.0",
  method: "bridge.heartbeat",
  params: {
    schema_version: 1,
    connection_id: "connection-1",
    nonce: "heartbeat-1",
    sent_at_ms: 1_788_451_200_000,
  },
} as const;

export const standardError = {
  jsonrpc: "2.0",
  id: "rpc-query",
  error: {
    code: -32602,
    message: "Invalid params",
    data: {
      schema_version: 1,
      error_code: "INVALID_PARAMS",
      retryable: false,
      external_outcome: "not_started",
      request_id: "request-1",
      request_digest: "a".repeat(64),
    },
  },
} as const;

export const validFrames = [
  helloRequest,
  helloResponse,
  generateRequest,
  acceptedResponse,
  ...eventFrames,
  cancelRequest,
  cancelResponse,
  queryRequest,
  queryResponse,
  heartbeat,
  standardError,
] as const;

export const helloWithReasoningRequest = {
  ...helloRequest,
  params: {
    ...helloRequest.params,
    capabilities: { ...helloRequest.params.capabilities, reasoning: true },
  },
} as const;

export const helloWithReasoningResponse = {
  ...helloResponse,
  result: {
    ...helloResponse.result,
    capabilities: { ...helloResponse.result.capabilities, reasoning: true },
  },
} as const;

export const defaultEventFrames = [
  { ...eventFrames[1], params: { ...eventFrames[1].params, sequence: 1 } },
  { ...eventFrames[2], params: { ...eventFrames[2].params, sequence: 2 } },
  { ...eventFrames[3], params: { ...eventFrames[3].params, sequence: 3 } },
  { ...eventFrames[4], params: { ...eventFrames[4].params, sequence: 4 } },
] as const;

export const defaultQueryResponse = {
  ...queryResponse,
  result: { ...queryResponse.result, last_sequence: 4 },
} as const;

export const successSequenceFrames = [
  helloRequest,
  helloResponse,
  generateRequest,
  acceptedResponse,
  ...defaultEventFrames,
  queryRequest,
  defaultQueryResponse,
  heartbeat,
] as const;
