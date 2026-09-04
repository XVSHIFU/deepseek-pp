import type {
  BridgeCapabilities,
  ModelCancelRequest,
  ModelCancelledResponse,
  ModelEvent,
  ModelGenerateRequest,
  ModelTerminalEvent,
} from '@deepseek-pp/web-model-protocol';

/**
 * Provider-neutral boundary used by the browser bridge to request one model
 * turn.  The shared wire DTOs are deliberately reused here so the adapter
 * cannot grow a second, slightly different protocol.
 */
export type WebModelTurnRequest = ModelGenerateRequest['params'];
export type WebModelTurnCancelRequest = ModelCancelRequest['params'];
export type WebModelTurnTerminal = ModelTerminalEvent;
export type WebModelTextDelta = Extract<ModelEvent, { type: 'text_delta' }>;
export type WebModelReasoningDelta = Extract<ModelEvent, { type: 'reasoning_delta' }>;
export type WebModelToolCall = Extract<ModelEvent, { type: 'tool_call' }>;
export type WebModelCancelStatus = ModelCancelledResponse['result']['status'];

export interface WebModelTurnAccepted {
  readonly request_id: string;
  readonly request_digest: string;
  readonly status: 'accepted';
}

export interface WebModelTurnCallbacks {
  /** Called synchronously once browser-side preparation has succeeded. */
  onAccepted(value: WebModelTurnAccepted): void;
  onTextDelta(event: WebModelTextDelta): void;
  onToolCall(event: WebModelToolCall): void;
  /** Ephemeral-only sink. Callers must never add this data to a transcript. */
  onReasoningDelta?(event: WebModelReasoningDelta): void;
}

export interface WebModelTurnContext {
  readonly signal?: AbortSignal;
  readonly negotiatedCapabilities?: BridgeCapabilities;
}

export interface WebModelTurnCancelResult {
  readonly request_id: string;
  readonly request_digest: string;
  readonly status: WebModelCancelStatus;
}

export interface WebModelTurnPort {
  /**
   * `aborted` is reserved for cancellation proven before webpage dispatch.
   * Once dispatched, abort/cancel can only yield an `ambiguous` terminal.
   */
  generate(
    request: unknown,
    callbacks: WebModelTurnCallbacks,
    context?: WebModelTurnContext,
  ): Promise<WebModelTurnTerminal>;

  cancel(request: unknown): WebModelTurnCancelResult;
}
