import {
  encodeWebModelFrame,
  validateWebModelFrame,
  type JsonObject,
  type ModelCancelRequest,
  type ModelEvent,
} from '@deepseek-pp/web-model-protocol';

import {
  createDeepSeekAutomationClient,
  type DeepSeekAutomationClient,
  type ModelTurn,
  type StreamCallbacks,
} from '../deepseek/active-client';
import { createStreamingToolCallParser } from '../interceptor/streaming-tool-call-parser';
import { createStreamingToolTextAccumulator } from '../interceptor/streaming-tool-text';
import { renderToolSchemas } from '../prompt/augmentation';
import { createToolInvocationCatalog, type ToolDescriptor } from '../tool';
import type {
  WebModelTurnAccepted,
  WebModelTurnCallbacks,
  WebModelTurnCancelRequest,
  WebModelTurnCancelResult,
  WebModelTurnContext,
  WebModelTurnPort,
  WebModelTurnRequest,
  WebModelTurnTerminal,
} from './model-turn-port';
import {
  WebModelSessionMap,
  WebModelSessionMapError,
  type VerifiedWebPageTurn,
  type WebPageSessionBinding,
} from './session-map';

export const WEB_MODEL_TURN_BUDGETS = Object.freeze({
  /** Below the existing 4 MiB active-completion response policy. */
  inboundUtf8Bytes: 3 * 1024 * 1024,
  outputUtf8Bytes: 4 * 1024 * 1024,
  events: 8_192,
  /** Conservative against UTF-8 expansion and JSON string escaping. */
  textEventCodeUnits: 128 * 1024,
});

export interface DeepSeekWebModelTurnAdapterDependencies {
  readonly client?: DeepSeekAutomationClient;
  readonly sessions?: WebModelSessionMap;
  readonly loadClientHeaders?: DeepSeekClientHeadersLoader;
}

export interface DeepSeekClientHeadersContext {
  readonly signal: AbortSignal;
}

export type DeepSeekClientHeadersLoader = (
  context: DeepSeekClientHeadersContext,
) => Promise<Record<string, string> | null>;

export type DeepSeekTurnAdapterErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CALLBACKS'
  | 'DUPLICATE_REQUEST'
  | 'SESSION_BUSY'
  | 'SESSION_QUARANTINED'
  | 'CAPACITY_EXCEEDED'
  | 'REASONING_NOT_NEGOTIATED'
  | 'REASONING_CALLBACK_REQUIRED'
  | 'REQUEST_ABORTED'
  | 'DEEPSEEK_AUTH_REQUIRED'
  | 'DEEPSEEK_PREPARATION_FAILED'
  | 'REQUEST_IDENTITY_MISMATCH';

/** Safe pre-dispatch error. It never includes upstream error or request data. */
export class DeepSeekTurnAdapterError extends Error {
  readonly code: DeepSeekTurnAdapterErrorCode;
  readonly retryable: boolean;
  readonly externalOutcome = 'not_started' as const;

  constructor(code: DeepSeekTurnAdapterErrorCode, retryable = false) {
    super(code);
    this.name = 'DeepSeekTurnAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}

type TurnFault = 'budget' | 'callback' | 'tool';
type SafeAbortKind = 'cancel' | 'external' | 'fault' | 'timeout';

const TURN_FAULT = Symbol('TURN_FAULT');

interface ActiveTurn {
  readonly requestDigest: string;
  readonly controller: AbortController;
}

/**
 * DeepSeek browser-model adapter. DeepSeek++ remains the sole owner of webpage
 * credentials, PoW, request encoding, SSE decoding, and history verification.
 */
export class DeepSeekWebModelTurnAdapter implements WebModelTurnPort {
  readonly sessions: WebModelSessionMap;
  private readonly client: DeepSeekAutomationClient;
  private readonly loadClientHeaders: DeepSeekClientHeadersLoader;
  private readonly active = new Map<string, ActiveTurn>();

  constructor(dependencies: DeepSeekWebModelTurnAdapterDependencies = {}) {
    this.client = dependencies.client ?? createDeepSeekAutomationClient();
    this.sessions = dependencies.sessions ?? new WebModelSessionMap();
    this.loadClientHeaders = dependencies.loadClientHeaders ?? (async ({ signal }) => {
      if (signal.aborted) throw signal.reason ?? createSafeAbortReason('external');
      return this.client.createClientHeaders();
    });
  }

  async generate(
    input: unknown,
    callbackInput: WebModelTurnCallbacks,
    context: WebModelTurnContext = {},
  ): Promise<WebModelTurnTerminal> {
    const request = validateGenerateRequest(input);
    const callbacks = validateCallbacks(callbackInput);
    validateTurnContext(context);
    assertReasoningContract(request, callbacks, context);
    if (context.signal?.aborted) throw new DeepSeekTurnAdapterError('REQUEST_ABORTED');

    const descriptors = createHarnessToolDescriptors(request);
    const prompt = serializeWebModelTurnPrompt(request, descriptors);
    const existingBinding = this.reserve(request);
    const turnSignal = createTurnSignal(context.signal, request.options.timeout_ms);
    const budget = new TurnBudget(request.request_id);
    this.active.set(request.request_id, {
      requestDigest: request.request_digest,
      controller: turnSignal.controller,
    });

    let accepted = false;
    let dispatched = false;
    let streamed = false;
    let emittedToolCall = false;
    let fault: TurnFault | undefined;

    const raiseFault = (next: TurnFault): never => {
      fault = next;
      if (!turnSignal.signal.aborted) turnSignal.controller.abort(createSafeAbortReason('fault'));
      throw TURN_FAULT;
    };
    const throwIfAborted = (): void => {
      if (turnSignal.signal.aborted) throw turnSignal.signal.reason ?? createSafeAbortReason('external');
    };
    const markStreaming = (): void => {
      if (streamed) return;
      this.sessions.markStreaming(request.request_id);
      streamed = true;
    };

    try {
      const loadedClientHeaders = await waitForClientHeaders(
        this.loadClientHeaders,
        turnSignal.signal,
      );
      throwIfAborted();
      const clientHeaders = validateClientHeaders(loadedClientHeaders);
      const binding = await this.prepareBinding(
        request.request_id,
        existingBinding,
        clientHeaders,
        turnSignal.signal,
      );
      const powHeaders = await this.client.createPowHeaders(clientHeaders, { signal: turnSignal.signal });
      if (turnSignal.signal.aborted) throw new DeepSeekTurnAdapterError('REQUEST_ABORTED');

      const acceptedValue: WebModelTurnAccepted = Object.freeze({
        request_id: request.request_id,
        request_digest: request.request_digest,
        status: 'accepted',
      });

      // Persist before notifying: the callback may partially send, throw, or
      // synchronously re-enter cancel(). Its request ID must remain reserved.
      this.sessions.markAccepted(request.request_id);
      accepted = true;
      try {
        callbacks.onAccepted(acceptedValue);
      } catch {
        fault = 'callback';
        if (!turnSignal.signal.aborted) turnSignal.controller.abort(createSafeAbortReason('fault'));
        return this.terminal(request.request_id, failedAcceptedCallback());
      }
      if (turnSignal.signal.aborted) {
        return this.terminal(request.request_id, terminalForAbort(turnSignal.signal, false));
      }

      const textAccumulator = createStreamingToolTextAccumulator(descriptors);
      const toolParser = createStreamingToolCallParser(descriptors);
      let lastVisibleText = '';

      const emitEvent = <T extends ModelEvent>(event: T, callback: (value: T) => void): void => {
        throwIfAborted();
        try {
          budget.consumeEvent(event);
        } catch {
          raiseFault('budget');
        }
        try {
          callback(event);
        } catch {
          raiseFault('callback');
        }
        // Callbacks may synchronously call cancel(). Never parse or emit
        // another event from the same upstream chunk after that point.
        throwIfAborted();
      };

      const emitText = (fullText: string): void => {
        if (!fullText.startsWith(lastVisibleText)) raiseFault('callback');
        const delta = fullText.slice(lastVisibleText.length);
        lastVisibleText = fullText;
        forEachConservativeTextChunk(delta, (text) => {
          emitEvent({ type: 'text_delta', text }, callbacks.onTextDelta);
        });
      };

      const consumeParsed = (parsed: ReturnType<typeof toolParser.append>): void => {
        if (parsed.failed.length > 0 || parsed.streamed.length > 0) raiseFault('tool');
        for (const call of parsed.completed) {
          const toolCallId = call.id;
          const invocationName = call.invocationName;
          if (call.parseError || !toolCallId || !invocationName || !isJsonObject(call.payload)) {
            raiseFault('tool');
          }
          const event = {
            type: 'tool_call',
            tool_call_id: toolCallId as string,
            name: invocationName as string,
            arguments: call.payload as JsonObject,
          } as const;
          emitEvent(event, callbacks.onToolCall);
          emittedToolCall = true;
        }
      };

      const streamCallbacks: StreamCallbacks = {
        retainAssistantText: false,
        onTextChunk(text) {
          throwIfAborted();
          try {
            budget.consumeInbound(text);
          } catch {
            raiseFault('budget');
          }
          markStreaming();
          try {
            emitText(textAccumulator.append(text));
            throwIfAborted();
            consumeParsed(toolParser.append(text));
          } catch (error) {
            if (error === TURN_FAULT || turnSignal.signal.aborted) throw error;
            raiseFault('tool');
          }
        },
        ...(request.options.thinking_enabled
          ? {
            // stream-codec currently holds its cumulative reasoning only for
            // this 4 MiB-bounded active response. This adapter receives deltas
            // only and never returns or stores that cumulative value.
            onReasoningChunk(reasoning: string) {
              throwIfAborted();
              try {
                budget.consumeInbound(reasoning);
              } catch {
                raiseFault('budget');
              }
              markStreaming();
              forEachConservativeTextChunk(reasoning, (text) => {
                emitEvent(
                  { type: 'reasoning_delta', text, retention: 'ephemeral' },
                  callbacks.onReasoningDelta!,
                );
              });
            },
          }
          : {}),
      };

      let result: ModelTurn;
      try {
        result = await this.client.submitPromptStreaming({
          chatSessionId: binding.chatSessionId,
          parentMessageId: binding.parentMessageId,
          modelType: request.options.model_type,
          prompt,
          refFileIds: [],
          thinkingEnabled: request.options.thinking_enabled,
          searchEnabled: request.options.search_enabled,
          clientHeaders,
          powHeaders,
        }, streamCallbacks, {
          signal: turnSignal.signal,
          onDispatch: () => {
            this.sessions.markDispatched(request.request_id);
            dispatched = true;
          },
        });
      } catch {
        if (fault === 'budget') return this.terminal(request.request_id, failedBudget());
        if (fault === 'tool') return this.terminal(request.request_id, failedToolCall());
        if (fault === 'callback') {
          return this.terminal(
            request.request_id,
            dispatched ? ambiguous('consumer_callback_outcome_unknown') : failedAcceptedCallback(),
          );
        }
        if (turnSignal.signal.aborted) {
          return this.terminal(request.request_id, terminalForAbort(turnSignal.signal, dispatched));
        }
        return this.terminal(
          request.request_id,
          dispatched ? ambiguous('deepseek_turn_outcome_unknown') : failedDispatch(),
        );
      }

      if (!dispatched) return this.terminal(request.request_id, failedDispatch());
      if (turnSignal.signal.aborted) {
        return this.terminal(request.request_id, terminalForAbort(turnSignal.signal, true));
      }
      if (!result.finished) return this.terminal(request.request_id, ambiguous('deepseek_stream_incomplete'));

      try {
        emitText(textAccumulator.flush());
        throwIfAborted();
        consumeParsed(toolParser.flush());
      } catch {
        if (fault === 'budget') return this.terminal(request.request_id, failedBudget());
        if (fault === 'tool') return this.terminal(request.request_id, failedToolCall());
        return this.terminal(request.request_id, ambiguous('consumer_callback_outcome_unknown'));
      }

      const responseMessageId = safeNormalizeMessageId(
        this.client,
        result.responseMessageId,
        'response_message_id',
      );
      if (responseMessageId === null) {
        return this.terminal(request.request_id, ambiguous('response_message_id_missing'));
      }
      const requestMessageId = safeNormalizeMessageId(
        this.client,
        result.requestMessageId,
        'request_message_id',
      );
      if (requestMessageId === null) {
        return this.terminal(request.request_id, ambiguous('request_message_id_missing'));
      }

      let history;
      try {
        history = await this.client.readHistorySnapshot(
          binding.chatSessionId,
          responseMessageId,
          clientHeaders,
          { signal: turnSignal.signal },
        );
      } catch {
        return this.terminal(request.request_id, ambiguous('deepseek_chain_unverified'));
      }
      if (turnSignal.signal.aborted) {
        return this.terminal(request.request_id, terminalForAbort(turnSignal.signal, true));
      }
      if (!history) return this.terminal(request.request_id, ambiguous('deepseek_chain_unverified'));

      const verified: VerifiedWebPageTurn = {
        chatSessionId: history.chatSessionId,
        requestMessageId,
        responseMessageId,
        nextParentMessageId: history.parentMessageId ?? -1,
        assistantMessageId: history.assistantMessageId ?? -1,
        assistantParentMessageId: history.assistantParentMessageId ?? -1,
        requestParentMessageId: history.requestParentMessageId,
        messageCount: history.messageCount,
        verifiedAt: history.verifiedAt,
      };
      try {
        this.sessions.complete(request.request_id, verified);
      } catch {
        return this.terminal(request.request_id, ambiguous('deepseek_chain_unverified'));
      }
      return completed(emittedToolCall ? 'tool_calls' : 'stop');
    } catch (error) {
      if (accepted) {
        if (fault === 'budget') return this.terminal(request.request_id, failedBudget());
        if (fault === 'tool') return this.terminal(request.request_id, failedToolCall());
        if (turnSignal.signal.aborted) {
          return this.terminal(request.request_id, terminalForAbort(turnSignal.signal, dispatched));
        }
        return this.terminal(
          request.request_id,
          dispatched ? ambiguous('deepseek_turn_outcome_unknown') : failedDispatch(),
        );
      }
      this.releaseUnstarted(request.request_id);
      if (turnSignal.signal.aborted) throw new DeepSeekTurnAdapterError('REQUEST_ABORTED');
      if (error instanceof DeepSeekTurnAdapterError) throw error;
      throw new DeepSeekTurnAdapterError(
        'DEEPSEEK_PREPARATION_FAILED',
        true,
      );
    } finally {
      turnSignal.dispose();
      if (this.active.get(request.request_id)?.controller === turnSignal.controller) {
        this.active.delete(request.request_id);
      }
    }
  }

  cancel(input: unknown): WebModelTurnCancelResult {
    const request = validateCancelRequest(input);
    const record = this.sessions.getRequest(request.request_id);
    if (!record) return Object.freeze({
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: 'not_found',
    });
    if (record.requestDigest !== request.request_digest) {
      throw new DeepSeekTurnAdapterError('REQUEST_IDENTITY_MISMATCH');
    }
    if (isTerminalPhase(record.phase)) return Object.freeze({
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: 'already_terminal',
    });

    const active = this.active.get(request.request_id);
    if (active?.requestDigest !== request.request_digest) {
      throw new DeepSeekTurnAdapterError('REQUEST_IDENTITY_MISMATCH');
    }
    active?.controller.abort(createSafeAbortReason('cancel'));
    return Object.freeze({
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: 'cancel_requested',
    });
  }

  private async prepareBinding(
    requestId: string,
    existing: WebPageSessionBinding | undefined,
    clientHeaders: Record<string, string>,
    signal: AbortSignal,
  ): Promise<WebPageSessionBinding> {
    if (existing) return existing;
    const chatSessionId = await this.client.createChatSession(clientHeaders, { signal });
    return this.sessions.bindNewSession(requestId, chatSessionId);
  }

  private reserve(request: WebModelTurnRequest): WebPageSessionBinding | undefined {
    try {
      return this.sessions.reserve(request.request_id, request.request_digest, request.session_id);
    } catch (error) {
      if (!(error instanceof WebModelSessionMapError)) throw error;
      switch (error.code) {
        case 'DUPLICATE_REQUEST': throw new DeepSeekTurnAdapterError('DUPLICATE_REQUEST');
        case 'SESSION_BUSY': throw new DeepSeekTurnAdapterError('SESSION_BUSY');
        case 'SESSION_QUARANTINED': throw new DeepSeekTurnAdapterError('SESSION_QUARANTINED');
        case 'SESSION_CAPACITY_EXCEEDED':
        case 'REQUEST_CAPACITY_EXCEEDED': throw new DeepSeekTurnAdapterError('CAPACITY_EXCEEDED');
        default: throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
      }
    }
  }

  private releaseUnstarted(requestId: string): void {
    try {
      this.sessions.releaseUnstarted(requestId);
    } catch {
      // Preserve the safe outer error; never expose an upstream payload.
    }
  }

  private terminal(requestId: string, event: WebModelTurnTerminal): WebModelTurnTerminal {
    try {
      if (event.type !== 'completed') this.sessions.markTerminal(requestId, event.type);
    } catch {
      return ambiguous('adapter_state_inconsistent');
    }
    return event;
  }
}

export function createDeepSeekWebModelTurnAdapter(
  dependencies: DeepSeekWebModelTurnAdapterDependencies = {},
): DeepSeekWebModelTurnAdapter {
  return new DeepSeekWebModelTurnAdapter(dependencies);
}

/** Deterministic, credential-free projection of the shared turn DTO. */
export function serializeWebModelTurnPrompt(
  request: WebModelTurnRequest,
  descriptors: readonly ToolDescriptor[] = createHarnessToolDescriptors(request),
): string {
  const transcript = JSON.stringify(request.input.messages);
  const toolSchemas = descriptors.length > 0 ? renderToolSchemas(descriptors, 'en') : '';
  return [
    'You are the model for a local Agent Harness. The harness owns the agent loop, session state, and tool execution.',
    `Turn purpose: ${request.purpose}`,
    'Treat this JSON array as the ordered conversation transcript:',
    '<harness_messages_json>',
    transcript,
    '</harness_messages_json>',
    toolSchemas
      ? `Available harness tools follow. Emit a direct XML tool tag only when a tool is required:\n\n${toolSchemas}`
      : 'No harness tools are available for this turn.',
    'Continue with the next assistant response only.',
  ].join('\n\n');
}

class TurnBudget {
  private readonly encoder = new TextEncoder();
  private inboundBytes = 0;
  private outputBytes = 0;
  private eventCount = 0;

  constructor(private readonly requestId: string) {}

  consumeInbound(value: string): void {
    this.inboundBytes += this.encoder.encode(value).byteLength;
    if (this.inboundBytes > WEB_MODEL_TURN_BUDGETS.inboundUtf8Bytes) throw new Error('BUDGET');
  }

  consumeEvent(event: ModelEvent): void {
    if (this.eventCount >= WEB_MODEL_TURN_BUDGETS.events) throw new Error('BUDGET');
    const encoded = encodeWebModelFrame({
      jsonrpc: '2.0',
      method: 'model.event',
      params: {
        schema_version: 1,
        request_id: this.requestId,
        // Longest valid sequence is conservative for encoded frame size.
        sequence: Number.MAX_SAFE_INTEGER,
        event,
      },
    });
    const bytes = this.encoder.encode(encoded).byteLength;
    if (this.outputBytes + bytes > WEB_MODEL_TURN_BUDGETS.outputUtf8Bytes) throw new Error('BUDGET');
    this.outputBytes += bytes;
    this.eventCount += 1;
  }
}

function createHarnessToolDescriptors(request: WebModelTurnRequest): readonly ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = request.tools.map((tool, index) => {
    if (tool.input_schema.type !== 'object') throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
    return Object.freeze({
      id: `harness:${index}:${tool.name}`,
      provider: Object.freeze({
        kind: 'local' as const,
        id: 'deepseek-harness',
        displayName: 'DeepSeek Harness',
        transport: 'in_process' as const,
      }),
      name: tool.name,
      invocationName: tool.name,
      title: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema as unknown as ToolDescriptor['inputSchema'],
      execution: Object.freeze({ mode: 'disabled' as const, enabled: false, risk: 'high' as const }),
    });
  });
  const catalog = createToolInvocationCatalog(descriptors);
  if (catalog.invocationNames.length !== descriptors.length ||
      descriptors.some((descriptor) => catalog.descriptorByInvocationName.get(descriptor.name) !== descriptor)) {
    throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  }
  return Object.freeze(descriptors);
}

function validateGenerateRequest(value: unknown): WebModelTurnRequest {
  const frame = {
    jsonrpc: '2.0',
    id: 'adapter-generate-validation',
    method: 'model.generate',
    params: value,
  };
  try {
    encodeWebModelFrame(frame);
    const validated = validateWebModelFrame(frame);
    if (!('method' in validated) || validated.method !== 'model.generate') throw new Error('unexpected');
    return validated.params;
  } catch {
    throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  }
}

function validateCancelRequest(value: unknown): WebModelTurnCancelRequest {
  const frame = {
    jsonrpc: '2.0',
    id: 'adapter-cancel-validation',
    method: 'model.cancel',
    params: value,
  };
  try {
    encodeWebModelFrame(frame);
    const validated = validateWebModelFrame(frame);
    if (!('method' in validated) || validated.method !== 'model.cancel') throw new Error('unexpected');
    return (validated as ModelCancelRequest).params;
  } catch {
    throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  }
}

function validateCallbacks(value: unknown): WebModelTurnCallbacks {
  if (!isPlainRecord(value)) throw new DeepSeekTurnAdapterError('INVALID_CALLBACKS');
  const allowed = new Set(['onAccepted', 'onTextDelta', 'onToolCall', 'onReasoningDelta']);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      typeof value.onAccepted !== 'function' ||
      typeof value.onTextDelta !== 'function' ||
      typeof value.onToolCall !== 'function' ||
      (value.onReasoningDelta !== undefined && typeof value.onReasoningDelta !== 'function')) {
    throw new DeepSeekTurnAdapterError('INVALID_CALLBACKS');
  }
  return value as unknown as WebModelTurnCallbacks;
}

function validateTurnContext(context: WebModelTurnContext): void {
  if (!isPlainRecord(context)) throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  const allowed = new Set(['signal', 'negotiatedCapabilities']);
  if (Object.keys(context).some((key) => !allowed.has(key))) throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  if (context.signal !== undefined && !isAbortSignal(context.signal)) {
    throw new DeepSeekTurnAdapterError('INVALID_REQUEST');
  }
}

function assertReasoningContract(
  request: WebModelTurnRequest,
  callbacks: WebModelTurnCallbacks,
  context: WebModelTurnContext,
): void {
  if (!request.options.thinking_enabled) return;
  if (context.negotiatedCapabilities?.reasoning !== true) {
    throw new DeepSeekTurnAdapterError('REASONING_NOT_NEGOTIATED');
  }
  if (!callbacks.onReasoningDelta) {
    throw new DeepSeekTurnAdapterError('REASONING_CALLBACK_REQUIRED');
  }
}

function createTurnSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(createSafeAbortReason('external'));
  parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = timeoutMs === undefined
    ? undefined
    : globalThis.setTimeout(() => controller.abort(createSafeAbortReason('timeout')), timeoutMs);
  return {
    controller,
    signal: controller.signal,
    dispose() {
      parent?.removeEventListener('abort', abortFromParent);
      if (timer !== undefined) globalThis.clearTimeout(timer);
    },
  };
}

function forEachConservativeTextChunk(value: string, emit: (text: string) => void): void {
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + WEB_MODEL_TURN_BUDGETS.textEventCodeUnits, value.length);
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
    emit(value.slice(offset, end));
    offset = end;
  }
}

function completed(finish_reason: 'stop' | 'tool_calls'): WebModelTurnTerminal {
  return { type: 'completed', finish_reason };
}

function aborted(reason: string): WebModelTurnTerminal {
  return { type: 'aborted', reason };
}

function ambiguous(reason: string): WebModelTurnTerminal {
  return { type: 'ambiguous', reason };
}

function failedAcceptedCallback(): WebModelTurnTerminal {
  return failed('ACCEPTED_CALLBACK_FAILED', 'The accepted response could not be delivered.', 'unknown');
}

function failedDispatch(): WebModelTurnTerminal {
  return failed('DEEPSEEK_DISPATCH_FAILED', 'The DeepSeek request was not dispatched.', 'unknown');
}

function failedToolCall(): WebModelTurnTerminal {
  return failed('TOOL_CALL_INVALID', 'DeepSeek returned an invalid structured tool call.', 'started');
}

function failedBudget(): WebModelTurnTerminal {
  return failed('MODEL_OUTPUT_BUDGET_EXCEEDED', 'DeepSeek output exceeded the browser adapter budget.', 'started');
}

function failed(
  code: string,
  message: string,
  external_outcome: 'started' | 'unknown',
): WebModelTurnTerminal {
  return { type: 'failed', error: { code, message, retryable: false, external_outcome } };
}

function terminalForAbort(signal: AbortSignal, dispatched: boolean): WebModelTurnTerminal {
  if (!dispatched) return aborted('request_cancelled_before_dispatch');
  if (getAbortKind(signal) === 'timeout') return ambiguous('deepseek_turn_timeout');
  return ambiguous('deepseek_dispatch_abort_outcome_unknown');
}

function safeNormalizeMessageId(
  client: DeepSeekAutomationClient,
  value: unknown,
  field: string,
): number | null {
  try {
    return client.normalizeMessageId(value, field);
  } catch {
    return null;
  }
}

function isTerminalPhase(value: string): boolean {
  return value === 'completed' || value === 'aborted' || value === 'failed' || value === 'ambiguous';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

async function waitForClientHeaders(
  loader: DeepSeekClientHeadersLoader,
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  if (signal.aborted) throw signal.reason ?? createSafeAbortReason('external');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: Record<string, string> | null } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const onAbort = (): void => finish({ error: signal.reason ?? createSafeAbortReason('external') });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason ?? createSafeAbortReason('external');
        return loader({ signal });
      })
      .then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
  });
}

function validateClientHeaders(value: Record<string, string> | null): Record<string, string> {
  if (value === null || !isPlainRecord(value) ||
      typeof value.Authorization !== 'string' || value.Authorization.trim() === '') {
    throw new DeepSeekTurnAdapterError('DEEPSEEK_AUTH_REQUIRED', true);
  }
  if (Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new DeepSeekTurnAdapterError('DEEPSEEK_PREPARATION_FAILED', true);
  }
  return { ...value };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(value && typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function');
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

class SafeTurnAbort extends Error {
  constructor(readonly kind: SafeAbortKind) {
    super('REQUEST_ABORTED');
    this.name = 'AbortError';
  }
}

function createSafeAbortReason(kind: SafeAbortKind): Error {
  return new SafeTurnAbort(kind);
}

function getAbortKind(signal: AbortSignal): SafeAbortKind {
  return signal.reason instanceof SafeTurnAbort ? signal.reason.kind : 'external';
}
