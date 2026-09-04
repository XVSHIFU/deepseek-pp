import type { ResponseTokenSpeedPayload } from './stream-metrics';

export interface ModelTurn {
  assistantText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
}

export interface DeepSeekHistorySnapshot {
  chatSessionId: string;
  parentMessageId: number | null;
  assistantMessageId: number | null;
  assistantParentMessageId: number | null;
  requestParentMessageId: number | null;
  messageCount: number;
  verifiedAt: number;
}

export interface StreamCallbacks {
  onTextChunk?(text: string, fullText: string): void;
  /** Reasoning/thinking deltas of the current response (THINK fragments). */
  onReasoningChunk?(reasoning: string, fullReasoning: string): void;
  onTokenSpeed?(progress: ResponseTokenSpeedPayload): void;
  onFinished?(): void;
  retainAssistantText?: boolean;
}

export interface SubmitPromptInput {
  chatSessionId: string;
  parentMessageId: number | null;
  modelType: string | null;
  prompt: string;
  refFileIds: string[];
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

export interface DeepSeekRequestContext {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onDispatch?: () => void;
}

export interface DeepSeekAutomationClient {
  createClientHeaders(options?: { missingTokenMessage?: string }): Record<string, string>;
  createChatSession(
    clientHeaders: Record<string, string>,
    context: DeepSeekRequestContext,
  ): Promise<string>;
  createPowHeaders(
    clientHeaders: Record<string, string>,
    context: DeepSeekRequestContext,
  ): Promise<Record<string, string>>;
  submitPrompt(input: SubmitPromptInput, context: DeepSeekRequestContext): Promise<ModelTurn>;
  submitPromptStreaming(
    input: SubmitPromptInput,
    callbacks: StreamCallbacks,
    context: DeepSeekRequestContext,
  ): Promise<ModelTurn>;
  readHistorySnapshot(
    chatSessionId: string,
    expectedAssistantMessageId: number,
    clientHeaders: Record<string, string>,
    context: DeepSeekRequestContext,
  ): Promise<DeepSeekHistorySnapshot | null>;
  normalizeMessageId(value: unknown, fieldName?: string): number | null;
  buildSessionUrl(chatSessionId: string): string;
}
