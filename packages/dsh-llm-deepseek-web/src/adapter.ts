import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  BrokerError,
  type BrokerGenerateRequest,
  type DeepSeekWebBroker,
} from "@deepseek-pp/dsh-web-model-transport";
import type { ModelEvent, ModelTerminalEvent } from "@deepseek-pp/web-model-protocol";

import {
  DEEPSEEK_WEB_CONTEXT_WINDOW,
  DEEPSEEK_WEB_MODEL,
  DEEPSEEK_WEB_PROVIDER,
} from "./constants.ts";
import { canonicalJson, serializeGenerateRequest, type RequestIdentityFactory } from "./request.ts";
import { GenerationScheduler } from "./generation-scheduler.ts";

const NO_RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(
  { mode: "normal", maxRetries: 0 },
  "llm-deepseek-web: retryPolicy",
);

export interface DeepSeekWebAdapterOptions {
  readonly broker: DeepSeekWebBroker;
  readonly createRequestId?: RequestIdentityFactory;
  readonly abortSettleTimeoutMs?: number;
}

export class DeepSeekWebAdapter extends LlmAdapter {
  private readonly broker: DeepSeekWebBroker;
  private readonly createRequestId: RequestIdentityFactory | undefined;
  private readonly abortSettleTimeoutMs: number;
  private cleanupState: "ready" | "pending" | "failed" = "ready";
  private readonly scheduler = new GenerationScheduler();

  constructor(options: DeepSeekWebAdapterOptions) {
    super();
    this.broker = options.broker;
    this.createRequestId = options.createRequestId;
    const timeout = options.abortSettleTimeoutMs ?? 15_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000) {
      throw new Error("abortSettleTimeoutMs must be a positive finite number no greater than 600000");
    }
    this.abortSettleTimeoutMs = timeout;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "DeepSeek Web" };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return NO_RETRY_POLICY;
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider !== DEEPSEEK_WEB_PROVIDER) {
      return Promise.reject(new LlmError("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER"));
    }
    return Promise.resolve([modelInfo(provider)]);
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== DEEPSEEK_WEB_PROVIDER) {
      return Promise.reject(new LlmError("The DeepSeek Web adapter does not own this provider route.", "NO_ADAPTER"));
    }
    if (model !== DEEPSEEK_WEB_MODEL) {
      return Promise.reject(new LlmError("The DeepSeek Web adapter only exposes the current browser session.", "UNKNOWN_MODEL"));
    }
    return Promise.resolve({ ...modelInfo(provider), context: { contextWindow: DEEPSEEK_WEB_CONTEXT_WINDOW } });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const release = await this.scheduler.acquire(options.signal);
    if (release === undefined) { yield abortedFinish(); return; }
    try {
      yield* this.streamExclusive(options);
    } finally { release(); }
  }

  private async *streamExclusive(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.cleanupState !== "ready") {
      throw ambiguousFailure("A previous DeepSeek Web request has not confirmed transport cleanup.");
    }
    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }

    let request: BrokerGenerateRequest;
    try {
      request = serializeGenerateRequest(options, {
        ...(this.createRequestId === undefined ? {} : { createRequestId: this.createRequestId }),
      });
    } catch (error) {
      throw normalizeAdapterError(error, options.signal);
    }

    let terminal = false;
    let textIndex: number | undefined;
    let text = "";
    let nextIndex = 0;
    let contentBlocks = 0;
    let toolCallBlocks = 0;
    let usageSeen = false;
    let cancellation: Promise<unknown> | undefined;
    const requestCancellation = (): Promise<unknown> => {
      if (cancellation !== undefined) return cancellation;
      try {
        cancellation = Promise.resolve(this.broker.cancel({
          request_id: request.request_id,
          request_digest: request.request_digest,
          reason: "caller_aborted",
        }));
      } catch (error) {
        cancellation = Promise.reject(error);
      }
      void cancellation.catch(() => undefined);
      return cancellation;
    };
    const handleAbort = (): void => {
      void requestCancellation();
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) requestCancellation();

    const closeText = function* (): Generator<StreamChunk> {
      if (textIndex === undefined) return;
      yield { type: "block-end", index: textIndex, block: { type: "text", text } };
      textIndex = undefined;
      text = "";
    };

    const iterator = this.broker.generate(request)[Symbol.asyncIterator]();
    let iteratorDone = false;
    let iteratorCleanupHandled = false;
    let cancellationAllowed = true;
    try {
      for (;;) {
        const next = await nextOrAbort(iterator, options.signal);
        if (next.kind === "aborted") {
          const event = await this.settleAfterAbort(iterator, next.pending, requestCancellation());
          iteratorCleanupHandled = true;
          if (textIndex !== undefined) contentBlocks += 1;
          yield* closeText();
          yield terminalAfterAbort(event);
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
          if (textIndex !== undefined) contentBlocks += 1;
          yield* closeText();
          yield terminalAfterAbort(settled);
          terminal = true;
          return;
        }
        switch (event.type) {
          case "text_delta":
            if (usageSeen) throw protocolFailure();
            if (textIndex === undefined) {
              textIndex = nextIndex++;
              yield { type: "block-start", index: textIndex, blockType: "text" };
            }
            text += event.text;
            yield { type: "text-delta", index: textIndex, text: event.text };
            break;
          case "reasoning_delta":
            if (usageSeen) throw protocolFailure();
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
              block: { type: "tool-call", id, name: event.name, arguments: argumentsText },
            };
            break;
          }
          case "usage":
            if (usageSeen) throw protocolFailure();
            usageSeen = true;
            if (textIndex !== undefined) contentBlocks += 1;
            yield* closeText();
            yield {
              type: "usage",
              usage: {
                inputTokens: event.input_tokens,
                outputTokens: event.output_tokens,
                ...event.cache_read_tokens === undefined ? {} : { cacheReadTokens: event.cache_read_tokens },
                ...event.cache_write_tokens === undefined ? {} : { cacheWriteTokens: event.cache_write_tokens },
              },
            };
            break;
          case "completed":
          case "aborted":
          case "failed":
          case "ambiguous":
            if (textIndex !== undefined) contentBlocks += 1;
            yield* closeText();
            iteratorCleanupHandled = true;
            await this.closeIteratorOrBlock(iterator);
            if (event.type === "completed") {
              if (contentBlocks === 0) {
                yield errorFinish("EMPTY_RESPONSE", "The DeepSeek Web model returned no content.");
                terminal = true;
                return;
              }
              if ((event.finish_reason === "tool_calls") !== (toolCallBlocks > 0)) throw protocolFailure();
            }
            yield terminalFinish(event);
            terminal = true;
            return;
          default:
            throw protocolFailure();
        }
      }
      if (!terminal) throw protocolFailure();
    } catch (error) {
      if (error instanceof BrokerError && error.externalOutcome === "not_started") cancellationAllowed = false;
      throw normalizeAdapterError(error, options.signal);
    } finally {
      options.signal?.removeEventListener("abort", handleAbort);
      if (!iteratorDone && !iteratorCleanupHandled) {
        const cancellationResult = !terminal && cancellationAllowed
          ? requestCancellation()
          : cancellation ?? Promise.resolve();
        const cleanup = closeIterator(iterator);
        try {
          await within(Promise.all([cancellationResult, cleanup]), this.abortSettleTimeoutMs);
        } catch {
          this.trackCleanup(cleanup);
        }
      }
    }
  }

  private async settleAfterAbort(
    iterator: AsyncIterator<ModelEvent>,
    pending: Promise<IteratorResult<ModelEvent>>,
    cancellation: Promise<unknown>,
  ): Promise<ModelTerminalEvent | undefined> {
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
        return undefined;
      }
    } catch {
      this.trackCleanup(terminal.then(() => closeIterator(iterator)));
      return undefined;
    }
  }

  private async closeIteratorOrBlock(iterator: AsyncIterator<ModelEvent>): Promise<void> {
    const cleanup = closeIterator(iterator);
    try {
      await within(cleanup, this.abortSettleTimeoutMs);
    } catch (error) {
      this.trackCleanup(cleanup);
      throw ambiguousFailure("The DeepSeek Web request ended without confirmed transport cleanup.", error);
    }
  }

  private trackCleanup(cleanup: Promise<void>): void {
    this.cleanupState = "pending";
    void cleanup.then(
      () => { this.cleanupState = "ready"; },
      () => { this.cleanupState = "failed"; },
    );
  }
}

function modelInfo(provider: string): LlmModelInfo {
  return {
    provider,
    id: DEEPSEEK_WEB_MODEL,
    name: "Current DeepSeek Web Session",
    description: "Uses the authenticated DeepSeek++ browser broker; no local model or model API credential.",
    inputModalities: ["text"],
  };
}

type NextOrAbort =
  | { readonly kind: "next"; readonly result: IteratorResult<ModelEvent> }
  | { readonly kind: "aborted"; readonly pending: Promise<IteratorResult<ModelEvent>> };

async function nextOrAbort(iterator: AsyncIterator<ModelEvent>, signal?: AbortSignal): Promise<NextOrAbort> {
  const pending = Promise.resolve(iterator.next());
  if (signal?.aborted) return { kind: "aborted", pending };
  if (signal === undefined) return { kind: "next", result: await pending };
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener("abort", aborted);
      resolve({ kind: "aborted", pending });
    };
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve({ kind: "next", result });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function consumeUntilTerminal(
  iterator: AsyncIterator<ModelEvent>,
  first: Promise<IteratorResult<ModelEvent>>,
): Promise<ModelTerminalEvent> {
  let next = await first;
  for (;;) {
    if (next.done) throw protocolFailure();
    if (isTerminal(next.value)) return next.value;
    next = await iterator.next();
  }
}

function closeIterator(iterator: AsyncIterator<ModelEvent>): Promise<void> {
  if (iterator.return === undefined) return Promise.resolve();
  try {
    return Promise.resolve(iterator.return()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

function within<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SETTLEMENT_TIMEOUT")), Math.max(1, timeoutMs));
    void Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function remaining(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function terminalFinish(event: ModelTerminalEvent): StreamChunk {
  switch (event.type) {
    case "completed":
      return {
        type: "finish",
        reason: event.finish_reason === "tool_calls"
          ? { kind: "tool-calls" }
          : event.finish_reason === "length"
            ? { kind: "max-tokens" }
            : { kind: "stop" },
      };
    case "aborted":
      return abortedFinish();
    case "failed":
      return errorFinish(event.error.code, event.error.message);
    case "ambiguous":
      return ambiguousFinish();
  }
}

function terminalAfterAbort(event: ModelTerminalEvent | undefined): StreamChunk {
  // consumeUntilTerminal intentionally discards events racing with cancellation.
  // A completed terminal therefore cannot safely claim a complete text/tool result.
  return event === undefined || event.type === "completed" ? ambiguousFinish() : terminalFinish(event);
}

function errorFinish(code: string, message: string): StreamChunk {
  return { type: "finish", reason: { kind: "error", failure: { code, message } } };
}

function ambiguousFinish(): StreamChunk {
  return errorFinish("WEB_MODEL_AMBIGUOUS", "The DeepSeek Web model request outcome is ambiguous.");
}

function abortedFinish(): StreamChunk {
  return {
    type: "finish",
    reason: { kind: "aborted", failure: { code: "ABORTED", message: "DeepSeek Web request aborted by caller." } },
  };
}

function isTerminal(event: ModelEvent): event is ModelTerminalEvent {
  return event.type === "completed" || event.type === "aborted" || event.type === "failed" || event.type === "ambiguous";
}

function canonicalArguments(value: Record<string, unknown>): string {
  return canonicalJson(value as never);
}

function protocolFailure(): LlmError {
  return new LlmError("The DeepSeek Web broker stream ended without one valid terminal event.", "WEB_MODEL_PROTOCOL");
}

function ambiguousFailure(message: string, cause?: unknown): LlmError {
  return new LlmError(message, "WEB_MODEL_AMBIGUOUS", cause === undefined ? undefined : { cause });
}

function normalizeAdapterError(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof BrokerError && error.externalOutcome !== "not_started") {
    return ambiguousFailure("The DeepSeek Web model request outcome is ambiguous.", error);
  }
  if (error instanceof LlmError) return error;
  if (signal?.aborted) return new LlmError("DeepSeek Web request aborted by caller.", "ABORTED", { cause: error });
  if (error instanceof BrokerError) {
    switch (error.code) {
      case "WAITING_FOR_BROWSER":
        return new LlmError("Waiting for an authenticated DeepSeek++ browser broker.", "WAITING_FOR_BROWSER", { cause: error });
      case "BROKER_BUSY":
        return new LlmError("The DeepSeek Web browser broker is busy.", "BROKER_BUSY", { cause: error });
      case "DEEPSEEK_AUTH_REQUIRED":
        return new LlmError("Refresh the signed-in DeepSeek web page so the extension can use its login state.", error.code, { cause: error });
      case "DEEPSEEK_PREPARATION_FAILED":
      case "MODEL_PREPARATION_FAILED":
        return new LlmError("The DeepSeek web model could not prepare the request before generation.", error.code, { cause: error });
      case "REQUEST_TIMEOUT":
        return new LlmError("The DeepSeek Web browser broker timed out.", "TIMEOUT", { cause: error });
      case "PROTOCOL_VIOLATION":
      case "REQUEST_ALREADY_EXISTS":
      case "REQUEST_DIGEST_MISMATCH":
        return new LlmError("The DeepSeek Web browser broker rejected the request contract.", "WEB_MODEL_PROTOCOL", { cause: error });
      case "BROKER_STOPPED":
      case "CONNECTION_LOST":
        return new LlmError("The DeepSeek Web browser broker is unavailable.", "WEB_MODEL_TRANSPORT", { cause: error });
    }
  }
  return new LlmError("The DeepSeek Web browser broker failed.", "WEB_MODEL_TRANSPORT", { cause: error });
}
