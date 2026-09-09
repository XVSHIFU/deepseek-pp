import {
  consumeDeepSeekSseEvents,
  createDeepSeekSseByteDecoder,
  createDeepSeekStreamSummary,
  extractResponseUsageStatsFromParsed,
  extractResponseTextForTokenSpeed,
  isStreamFinishedFromParsed,
  type DeepSeekSseJsonObservation,
  type SSEEvent,
} from './stream-codec';
import {
  createResponseTokenSpeedTracker,
  type ResponseTokenSpeedPayload,
} from './stream-metrics';
import {
  NetworkPolicyError,
  cancelResponseBody,
  fetchWithNetworkPolicy,
  readNetworkResponseText,
} from '../network/request-policy';
import {
  solvePowChallengeLocally,
  type PowAnswer,
  type PowChallenge,
} from './pow';
import { DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES } from './upload-limits';
import {
  DEEPSEEK_BYPASS_HOOK_HEADER,
  DEEPSEEK_BODY_BUDGETS,
  DEEPSEEK_FILE_FETCH_PATH,
  DEEPSEEK_FILE_UPLOAD_PATH,
  DEEPSEEK_WEB_ROUTES,
  type DeepSeekUploadedFile,
} from './contracts';
import {
  buildDeepSeekWebSessionUrl,
  encodeDeepSeekRouteRequest,
  encodeCompletionRequest,
  encodeCreateSessionRequest,
  encodeHistoryRequest,
  encodePowChallengeRequest,
  normalizeDeepSeekMessageId,
  normalizeDeepSeekModelType,
} from './request-codec';
import {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from './errors';
import type {
  DeepSeekAutomationClient,
  DeepSeekCompletionContentKind,
  DeepSeekCompletionDiagnostic,
  DeepSeekHistorySnapshot,
  DeepSeekRequestContext,
  ModelTurn,
  StreamCallbacks,
  SubmitPromptInput,
} from './automation-client-port';

export {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from './errors';
export type {
  DeepSeekAutomationClient,
  DeepSeekCompletionContentKind,
  DeepSeekCompletionDiagnostic,
  DeepSeekHistorySnapshot,
  DeepSeekRequestContext,
  ModelTurn,
  StreamCallbacks,
  SubmitPromptInput,
} from './automation-client-port';

const COMPLETION_PATH = DEEPSEEK_WEB_ROUTES.completion;
export { DEEPSEEK_FILE_FETCH_PATH, DEEPSEEK_FILE_UPLOAD_PATH } from './contracts';
export { DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES } from './upload-limits';
const DEFAULT_APP_VERSION = '2.0.0';
const DEEPSEEK_CLIENT_PLATFORM = 'web';
const USER_TOKEN_STORAGE_KEY = 'userToken';
const TOKEN_SPEED_EMIT_INTERVAL_MS = 250;
const FILE_READY_POLL_INTERVAL_MS = 500;
const FILE_READY_TIMEOUT_MS = 15_000;
const STREAM_CONSUMER_CANCEL_REASON = 'DEEPSEEK_STREAM_CONSUMER_FAILED';
const COMPLETION_DIAGNOSTIC_JSON_MAX_BYTES = 64 * 1024;
const SSE_EVENT_KIND = Object.freeze({
  message: 1,
  ready: 2,
  updateSession: 4,
  error: 8,
  done: 16,
  finish: 32,
  close: 64,
  other: 128,
});
const SSE_SHAPE = Object.freeze({
  invalidJson: 1,
  validNonObject: 2,
  object: 4,
  pathAbsent: 8,
  responseStatusPath: 16,
  quasiStatusPath: 32,
  responsePath: 64,
  otherPath: 128,
  batchArray: 256,
  stringValue: 512,
  arrayValue: 1_024,
  objectValue: 2_048,
  otherValue: 4_096,
  finishedValue: 8_192,
  finishedBatchResponseStatus: 16_384,
  finishedBatchQuasiStatus: 32_768,
});
// DeepSeek can return audit_result=unknown together with status=SUCCESS for usable image uploads.
const ACCEPTED_FILE_AUDIT_RESULTS = new Set(['PASS', 'PASSED', 'SUCCESS', 'OK', 'UNKNOWN']);
const REJECTED_FILE_AUDIT_RESULTS = new Set(['REJECT', 'REJECTED', 'FAIL', 'FAILED', 'ERROR', 'BLOCK', 'BLOCKED', 'DENY', 'DENIED']);
export const BYPASS_HOOK_HEADER = DEEPSEEK_BYPASS_HOOK_HEADER;

let rememberedClientHeaders: Record<string, string> | null = null;

interface DeepSeekHistoryMessage {
  id: number | null;
  parentId: number | null;
  role: string | null;
}

export interface DeepSeekFileUploadInput {
  file: Blob;
  filename: string;
  modelType: string | null;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

export type { DeepSeekUploadedFile } from './contracts';

export function createDeepSeekAutomationClient(
  dependencies: { fetchImpl?: typeof fetch } = {},
): DeepSeekAutomationClient {
  const withDependencies = (context: DeepSeekRequestContext): DeepSeekRequestContext => ({
    ...context,
    fetchImpl: context.fetchImpl ?? dependencies.fetchImpl,
  });

  return {
    createClientHeaders,
    createChatSession: (clientHeaders, context) =>
      createChatSessionWithContext(clientHeaders, withDependencies(context)),
    createPowHeaders: (clientHeaders, context) =>
      createPowHeadersForPathWithContext(
        clientHeaders,
        COMPLETION_PATH,
        undefined,
        withDependencies(context),
      ),
    submitPrompt: (input, context) => submitPromptWithContext(input, withDependencies(context)),
    submitPromptStreaming: (input, callbacks, context) =>
      submitPromptStreamingWithContext(input, callbacks, withDependencies(context)),
    readHistorySnapshot: (chatSessionId, expectedAssistantMessageId, clientHeaders, context) =>
      readHistorySnapshotWithContext(
        chatSessionId,
        expectedAssistantMessageId,
        clientHeaders,
        withDependencies(context),
      ),
    normalizeMessageId,
    buildSessionUrl: buildDeepSeekSessionUrl,
  };
}

export async function createChatSession(
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  return createChatSessionWithContext(clientHeaders, { signal });
}

async function createChatSessionWithContext(
  clientHeaders: Record<string, string>,
  context: DeepSeekRequestContext,
): Promise<string> {
  const response = await requestDeepSeek(
    encodeCreateSessionRequest(clientHeaders),
    'DeepSeek chat session create',
    'session',
    context,
  );
  const json = await readJsonResponse(response, 'DeepSeek chat session create', 'session');
  const data = json?.data;
  const chatSessionId = firstString(data?.biz_data?.chat_session?.id);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating chat session: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !chatSessionId) {
    throw new DeepSeekSessionError(`Failed to create DeepSeek chat session: ${JSON.stringify(data ?? json)}`);
  }

  return chatSessionId;
}

export async function createPowHeaders(
  clientHeaders: Record<string, string>,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return createPowHeadersForPathWithContext(clientHeaders, COMPLETION_PATH, wasmUrl, { signal });
}

export async function createPowHeadersForPath(
  clientHeaders: Record<string, string>,
  targetPath: string,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return createPowHeadersForPathWithContext(clientHeaders, targetPath, wasmUrl, { signal });
}

async function createPowHeadersForPathWithContext(
  clientHeaders: Record<string, string>,
  targetPath: string,
  wasmUrl: string | undefined,
  context: DeepSeekRequestContext,
): Promise<Record<string, string>> {
  try {
    const challenge = await createPowChallenge(clientHeaders, targetPath, context);
    assertSignalActive(context.signal);
    const answer = await solvePowChallenge(challenge, wasmUrl, context.signal);
    assertSignalActive(context.signal);
    return {
      'X-DS-PoW-Response': base64EncodeUtf8(JSON.stringify({
        algorithm: answer.algorithm,
        challenge: answer.challenge,
        salt: answer.salt,
        answer: answer.answer,
        signature: answer.signature,
        target_path: targetPath,
      })),
    };
  } catch (err) {
    if (context.signal?.aborted) assertSignalActive(context.signal);
    if (err instanceof DeepSeekPowError) throw err;
    if (err instanceof DeepSeekAuthError) throw err;
    if (err instanceof NetworkPolicyError) throw err;
    throw new DeepSeekPowError(err instanceof Error ? err.message : String(err));
  }
}

function assertSignalActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('DeepSeek request was aborted.', 'AbortError');
}

export function createClientHeaders(options?: { missingTokenMessage?: string }): Record<string, string> {
  if (rememberedClientHeaders) return { ...rememberedClientHeaders };

  const token = readDeepSeekUserToken();
  if (!token) {
    throw new DeepSeekAuthError(
      options?.missingTokenMessage ?? 'DeepSeek login token is missing. Refresh chat.deepseek.com or sign in again.',
    );
  }

  return {
    Authorization: `Bearer ${token}`,
    'X-App-Version': getDeepSeekAppVersion(),
    'x-client-platform': DEEPSEEK_CLIENT_PLATFORM,
    'x-client-version': getDeepSeekAppVersion(),
    'x-client-locale': getDeepSeekLocale(),
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

export function rememberDeepSeekClientHeaders(headersInit: HeadersInit | undefined): void {
  const headers = normalizeHeaders(headersInit);
  if (!headers) return;

  const authorization = headers.get('authorization');
  if (!authorization) return;

  rememberedClientHeaders = {
    Authorization: authorization,
    'X-App-Version': headers.get('x-app-version') || getDeepSeekAppVersion(),
    'x-client-platform': headers.get('x-client-platform') || DEEPSEEK_CLIENT_PLATFORM,
    'x-client-version': headers.get('x-client-version') || getDeepSeekAppVersion(),
    'x-client-locale': headers.get('x-client-locale') || getDeepSeekLocale(),
    'x-client-timezone-offset': headers.get('x-client-timezone-offset') || String(-new Date().getTimezoneOffset() * 60),
  };
}

const STORAGE_HEADERS_KEY = 'deepseekCachedClientHeaders';

export async function saveClientHeadersToStorage(): Promise<boolean> {
  if (!rememberedClientHeaders) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_HEADERS_KEY]: rememberedClientHeaders });
    return true;
  } catch {
    return false;
  }
}

export async function loadClientHeadersFromStorage(): Promise<Record<string, string> | null> {
  try {
    const data = await chrome.storage.local.get(STORAGE_HEADERS_KEY);
    const headers = data[STORAGE_HEADERS_KEY] as Record<string, string> | undefined;
    if (headers?.Authorization) return headers;
    return null;
  } catch {
    return null;
  }
}

export async function uploadDeepSeekFile(input: DeepSeekFileUploadInput, signal?: AbortSignal): Promise<DeepSeekUploadedFile> {
  if (!input.file.type.startsWith('image/')) {
    throw new DeepSeekPayloadError(`${input.filename} is not an image file.`);
  }
  if (input.file.size > DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES) {
    throw new DeepSeekPayloadError(`${input.filename} exceeds the ${formatBytes(DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES)} image upload limit.`);
  }

  const form = new FormData();
  form.append('file', input.file, input.filename);

  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('uploadFile', {
      credentials: 'include',
      headers: {
        [BYPASS_HOOK_HEADER]: '1',
        ...input.clientHeaders,
        ...input.powHeaders,
        'x-thinking-enabled': '0',
        'x-model-type': normalizeDeepSeekModelType(input.modelType),
        'x-file-size': String(input.file.size),
      },
      body: form,
    }),
    'DeepSeek file upload',
    'upload',
    { signal },
  );

  const json = await readJsonResponse(response, 'DeepSeek file upload', 'payload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const uploaded = normalizeUploadedFile(bizData);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while uploading file: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !uploaded) {
    throw new DeepSeekPayloadError(`Failed to upload DeepSeek file: ${JSON.stringify(data ?? json)}`, { retryable: true });
  }

  return waitForUploadedFileReady(uploaded, input.clientHeaders, signal);
}

async function fetchUploadedFileMetadata(
  fileId: string,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile | null> {
  const response = await requestDeepSeek(
    encodeDeepSeekRouteRequest('fetchFiles', {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        [BYPASS_HOOK_HEADER]: '1',
        ...clientHeaders,
      },
    }, { searchParams: { file_ids: fileId } }),
    'DeepSeek file metadata',
    'upload',
    { signal },
  );
  const json = await readJsonResponse(response, 'DeepSeek file metadata', 'payload');
  const data = json?.data;
  const bizData = data?.biz_data ?? data?.bizData ?? json?.biz_data ?? json?.bizData;
  const files = Array.isArray(bizData?.files) ? bizData.files : [];
  const file = files
    .map((item: unknown) => normalizeUploadedFile(item))
    .find((item: DeepSeekUploadedFile | null): item is DeepSeekUploadedFile => item?.id === fileId);

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while fetching file metadata: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0) {
    throw new DeepSeekPayloadError(`Failed to fetch DeepSeek file metadata: ${JSON.stringify(data ?? json)}`, { retryable: true });
  }

  return file ?? null;
}

async function waitForUploadedFileReady(
  uploaded: DeepSeekUploadedFile,
  clientHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekUploadedFile> {
  assertUploadedFileNotRejected(uploaded);
  if (isUploadedFileReady(uploaded)) return uploaded;
  if (!uploaded.status) return uploaded;

  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  let latest = uploaded;
  while (Date.now() < deadline) {
    await sleep(FILE_READY_POLL_INTERVAL_MS, signal);
    const next = await fetchUploadedFileMetadata(uploaded.id, clientHeaders, signal);
    if (!next) continue;
    latest = next;
    assertUploadedFileNotRejected(latest);
    if (isUploadedFileReady(latest)) return latest;
  }

  throw new DeepSeekPayloadError(
    `DeepSeek file ${uploaded.fileName ?? uploaded.id} is still processing after ${Math.round(FILE_READY_TIMEOUT_MS / 1000)}s.`,
    { retryable: true },
  );
}

export async function submitPrompt(input: SubmitPromptInput, signal?: AbortSignal): Promise<ModelTurn> {
  return submitPromptWithContext(input, { signal });
}

async function submitPromptWithContext(
  input: SubmitPromptInput,
  context: DeepSeekRequestContext,
): Promise<ModelTurn> {
  const response = await requestCompletion(input, context);

  if (!response.ok) {
    throw new DeepSeekPayloadError(await readFailureMessage(response), { retryable: true });
  }

  if (!response.body) {
    throw new DeepSeekPayloadError('DeepSeek completion response did not include a stream body.', { retryable: true });
  }

  return readCompletionStream(response, context.completionDiagnostics === true);
}

export async function submitPromptStreaming(
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  return submitPromptStreamingWithContext(input, callbacks, { signal });
}

async function submitPromptStreamingWithContext(
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  context: DeepSeekRequestContext,
): Promise<ModelTurn> {
  const response = await requestCompletion(input, context);

  if (!response.ok) {
    throw new DeepSeekPayloadError(await readFailureMessage(response), { retryable: true });
  }

  if (!response.body) {
    throw new DeepSeekPayloadError('DeepSeek completion response did not include a stream body.', { retryable: true });
  }

  const decoratedCallbacks = callbacks.onTokenSpeed
    ? {
      ...callbacks,
      onTokenSpeed(progress: ResponseTokenSpeedPayload) {
        callbacks.onTokenSpeed?.({
          ...progress,
          chatSessionId: input.chatSessionId,
          modelType: progress.modelType ?? input.modelType,
        });
      },
    }
    : callbacks;

  return readCompletionStreamWithCallbacks(
    response,
    decoratedCallbacks,
    context.completionDiagnostics === true,
  );
}

async function requestCompletion(
  input: SubmitPromptInput,
  context: DeepSeekRequestContext,
): Promise<Response> {
  return requestDeepSeek(
    encodeCompletionRequest(input),
    'DeepSeek completion',
    'completion',
    context,
  );
}

export async function readHistorySnapshot(
  chatSessionId: string,
  expectedAssistantMessageId: number,
  clientHeadersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeepSeekHistorySnapshot | null> {
  return readHistorySnapshotWithContext(
    chatSessionId,
    expectedAssistantMessageId,
    clientHeadersOverride,
    { signal },
  );
}

async function readHistorySnapshotWithContext(
  chatSessionId: string,
  expectedAssistantMessageId: number,
  clientHeadersOverride: Record<string, string> | undefined,
  context: DeepSeekRequestContext,
): Promise<DeepSeekHistorySnapshot | null> {
  const clientHeaders = clientHeadersOverride ?? createClientHeaders();
  const response = await requestDeepSeek(
    encodeHistoryRequest(chatSessionId, clientHeaders),
    'DeepSeek history',
    'history',
    context,
  );
  if (!response.ok) {
    await cancelResponseBody(response);
    return null;
  }

  const json = await readJsonResponse(response, 'DeepSeek history', 'payload');
  const data = json?.data?.biz_data ?? json?.data ?? json?.biz_data ?? json;
  const rawMessages: unknown[] = Array.isArray(data?.chat_messages) ? data.chat_messages : [];
  if (rawMessages.length === 0) return null;

  const messages = rawMessages.map((message: unknown) => normalizeHistoryMessage(message));
  const messageIds = messages
    .map((message) => message.id)
    .filter((id): id is number => id !== null);
  if (new Set(messageIds).size !== messageIds.length) return null;
  const expectedMatches = messages.filter((message) => message.id === expectedAssistantMessageId);
  if (expectedMatches.length !== 1) return null;
  const expected = expectedMatches[0];
  if (!expected || expected.role !== 'assistant') return null;
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!latestAssistant || latestAssistant.id !== expectedAssistantMessageId) return null;
  if (expected.parentId === null) return null;
  const requestMatches = messages.filter((message) => message.id === expected.parentId);
  if (requestMatches.length !== 1 || requestMatches[0]?.role !== 'user') return null;
  const request = requestMatches[0];
  const messageCount = messageIds.length;
  if (messageCount === 0) return null;

  return {
    chatSessionId,
    parentMessageId: expected.id,
    assistantMessageId: expected.id,
    assistantParentMessageId: expected.parentId,
    requestParentMessageId: request.parentId,
    messageCount,
    verifiedAt: Date.now(),
  };
}

export function normalizeMessageId(value: unknown, fieldName = 'message_id'): number | null {
  const id = normalizeDeepSeekMessageId(value);
  if (id !== null || value === null || value === undefined || value === '') return id;
  throw new DeepSeekPayloadError(`DeepSeek ${fieldName} must be a u32 number, received ${JSON.stringify(value)}.`);
}

export function buildDeepSeekSessionUrl(chatSessionId: string): string {
  return buildDeepSeekWebSessionUrl(chatSessionId);
}

async function readCompletionStream(
  response: Response,
  collectDiagnostics = false,
): Promise<ModelTurn> {
  return readCompletionStreamWithCallbacks(response, {}, collectDiagnostics);
}

async function readCompletionStreamWithCallbacks(
  response: Response,
  callbacks: StreamCallbacks,
  collectDiagnostics = false,
): Promise<ModelTurn> {
  const reader = response.body!.getReader();
  const decoder = createDeepSeekSseByteDecoder();
  const summary = createDeepSeekStreamSummary();
  const diagnostic = collectDiagnostics ? new CompletionDiagnosticCollector(response) : null;
  const retainAssistantText = callbacks.retainAssistantText !== false;
  const speedTracker = callbacks.onTokenSpeed
    ? createResponseTokenSpeedTracker((progress) => callbacks.onTokenSpeed?.({
      ...progress,
      assistantMessageId: summary.responseMessageId,
    }), TOKEN_SPEED_EMIT_INTERVAL_MS)
    : null;
  const onParsed = speedTracker || diagnostic
    ? (parsed: unknown, event: SSEEvent) => {
      diagnostic?.observeParsed(parsed, event);
      if (!speedTracker) return;
      speedTracker.updateServerStats(extractResponseUsageStatsFromParsed(parsed, event.type));
      const tokenText = extractResponseTextForTokenSpeed(parsed);
      if (tokenText) speedTracker.append(tokenText);
      if (isStreamFinishedFromParsed(parsed)) speedTracker.finish();
    }
    : undefined;
  const onSseJson = diagnostic
    ? (observation: { jsonParsed: boolean; parsed: unknown }, event: SSEEvent): void => {
      diagnostic.observeSseJson(observation.jsonParsed, observation.parsed, event);
    }
    : undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      diagnostic?.observeBytes(value);
      const events = decoder.push(value);
      diagnostic?.observeEvents(events);
      const newText = consumeDeepSeekSseEvents(events, summary, {
        retainAssistantText,
        onParsed,
        onSseJson,
        onReasoningChunk: callbacks.onReasoningChunk,
      });
      if (newText && callbacks.onTextChunk) {
        callbacks.onTextChunk(newText, summary.assistantText);
      }
    }

    const finalEvents = decoder.finish();
    diagnostic?.observeEvents(finalEvents);
    const finalText = consumeDeepSeekSseEvents(finalEvents, summary, {
      retainAssistantText,
      onParsed,
      onSseJson,
      onReasoningChunk: callbacks.onReasoningChunk,
    });
    if (finalText && callbacks.onTextChunk) {
      callbacks.onTextChunk(finalText, summary.assistantText);
    }
    speedTracker?.finish();
    callbacks.onFinished?.();
    if (!diagnostic) return summary;
    const completionFailure = diagnostic.completionFailure(summary.finished);
    return {
      ...summary,
      completionDiagnostic: diagnostic.finish(),
      ...(completionFailure ? { completionFailure } : {}),
    };
  } catch (error) {
    try {
      speedTracker?.finish();
    } catch {
      // A cleanup callback must not replace the first stream processing error.
    }
    try {
      await reader.cancel(STREAM_CONSUMER_CANCEL_REASON);
    } catch {
      // Preserve the original callback/decoder/read failure.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock release is best-effort cleanup and must not replace stream errors.
    }
  }
}

class CompletionDiagnosticCollector {
  private readonly httpStatus: number;
  private readonly declaredJson: boolean;
  private readonly declaredSse: boolean;
  private readonly jsonChunks: Uint8Array[] = [];
  private jsonTooLarge = false;
  private bodyBytes = 0;
  private sseEvents = 0;
  private sseJsonEvents = 0;
  private sseEventKindMask = 0;
  private sseShapeMask = 0;
  private sawRateLimitFailure = false;
  private code: number | null = null;
  private bizCode: number | null = null;
  private sseError = false;

  constructor(response: Response) {
    this.httpStatus = response.status;
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    this.declaredJson = contentType === 'application/json' || contentType.endsWith('+json');
    this.declaredSse = contentType === 'text/event-stream';
  }

  observeBytes(bytes: Uint8Array): void {
    this.bodyBytes += bytes.byteLength;
    if (!this.declaredJson || this.jsonTooLarge) return;
    if (this.bodyBytes > COMPLETION_DIAGNOSTIC_JSON_MAX_BYTES) {
      this.jsonChunks.length = 0;
      this.jsonTooLarge = true;
      return;
    }
    this.jsonChunks.push(bytes.slice());
  }

  observeEvents(events: readonly SSEEvent[]): void {
    this.sseEvents += events.length;
    for (const event of events) {
      const eventKind = classifySseEventKind(event.type);
      this.sseEventKindMask |= eventKind;
      if (eventKind === SSE_EVENT_KIND.error) this.sseError = true;
    }
  }

  observeSseJson(jsonParsed: boolean, parsed: unknown, event: SSEEvent): void {
    if (jsonParsed) this.sseJsonEvents += 1;
    this.sseShapeMask |= classifySseShape(jsonParsed, parsed);
    if (isRateLimitFailureHint(event, parsed)) this.sawRateLimitFailure = true;
  }

  observeParsed(parsed: unknown, event: SSEEvent): void {
    const signal = readCompletionErrorSignal(parsed);
    this.code ??= signal.code;
    this.bizCode ??= signal.bizCode;
    if (event.type.trim().toLowerCase() === 'error' || signal.isError) this.sseError = true;
  }

  finish(): DeepSeekCompletionDiagnostic {
    let contentKind: DeepSeekCompletionContentKind;
    if (this.bodyBytes === 0) {
      contentKind = 'empty';
    } else if (this.declaredJson) {
      if (this.jsonTooLarge) {
        contentKind = 'other';
      } else {
        const signal = readJsonCompletionErrorSignal(this.jsonChunks, this.bodyBytes);
        this.code ??= signal.code;
        this.bizCode ??= signal.bizCode;
        contentKind = signal.parsed ? (signal.isError ? 'json_error' : 'json') : 'other';
      }
    } else if (this.declaredSse || this.sseEvents > 0) {
      contentKind = this.sseError ? 'sse_error' : 'sse';
    } else {
      contentKind = 'other';
    }

    return Object.freeze({
      httpStatus: this.httpStatus,
      contentKind,
      bodyBytes: this.bodyBytes,
      sseEvents: this.sseEvents,
      code: this.code,
      bizCode: this.bizCode,
      sseJsonEvents: this.sseJsonEvents,
      sseEventKindMask: this.sseEventKindMask,
      sseShapeMask: this.sseShapeMask,
    });
  }

  completionFailure(finished: boolean): ModelTurn['completionFailure'] {
    return !finished && this.sawRateLimitFailure ? 'rate_limit_reached' : undefined;
  }
}

function isRateLimitFailureHint(event: SSEEvent, parsed: unknown): boolean {
  return event.type === 'hint' &&
    isPlainRecord(parsed) &&
    parsed.type === 'error' &&
    parsed.clear_response === true &&
    parsed.finish_reason === 'rate_limit_reached';
}

function classifySseEventKind(value: string): number {
  switch (value.trim().toLowerCase()) {
    case '':
    case 'default':
    case 'message': return SSE_EVENT_KIND.message;
    case 'ready': return SSE_EVENT_KIND.ready;
    case 'update_session': return SSE_EVENT_KIND.updateSession;
    case 'error': return SSE_EVENT_KIND.error;
    case 'done': return SSE_EVENT_KIND.done;
    case 'finish': return SSE_EVENT_KIND.finish;
    case 'close': return SSE_EVENT_KIND.close;
    default: return SSE_EVENT_KIND.other;
  }
}

function classifySseShape(jsonParsed: boolean, parsed: unknown): number {
  if (!jsonParsed) return SSE_SHAPE.invalidJson;
  if (!isPlainRecord(parsed)) return SSE_SHAPE.validNonObject;

  let mask = SSE_SHAPE.object;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'p')) {
    mask |= SSE_SHAPE.pathAbsent;
  } else if (parsed.p === 'response/status') {
    mask |= SSE_SHAPE.responseStatusPath;
  } else if (parsed.p === 'quasi_status') {
    mask |= SSE_SHAPE.quasiStatusPath;
  } else if (parsed.p === 'response') {
    mask |= SSE_SHAPE.responsePath;
  } else {
    mask |= SSE_SHAPE.otherPath;
  }

  if (typeof parsed.v === 'string') {
    mask |= SSE_SHAPE.stringValue;
  } else if (Array.isArray(parsed.v)) {
    mask |= SSE_SHAPE.arrayValue;
  } else if (isPlainRecord(parsed.v)) {
    mask |= SSE_SHAPE.objectValue;
  } else {
    mask |= SSE_SHAPE.otherValue;
  }
  if (parsed.v === 'FINISHED') mask |= SSE_SHAPE.finishedValue;

  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    mask |= SSE_SHAPE.batchArray;
    for (const child of parsed.v) {
      if (!isPlainRecord(child) || child.v !== 'FINISHED') continue;
      if (child.p === 'response/status') mask |= SSE_SHAPE.finishedBatchResponseStatus;
      if (child.p === 'quasi_status') mask |= SSE_SHAPE.finishedBatchQuasiStatus;
    }
  }
  return mask;
}

function readJsonCompletionErrorSignal(
  chunks: readonly Uint8Array[],
  byteLength: number,
): ReturnType<typeof readCompletionErrorSignal> & { parsed: boolean } {
  try {
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ...readCompletionErrorSignal(JSON.parse(new TextDecoder().decode(body))), parsed: true };
  } catch {
    return { code: null, bizCode: null, isError: false, parsed: false };
  }
}

function readCompletionErrorSignal(value: unknown): {
  code: number | null;
  bizCode: number | null;
  isError: boolean;
} {
  const record = isPlainRecord(value) ? value : null;
  const data = record && isPlainRecord(record.data) ? record.data : null;
  const code = readDiagnosticCode(record?.code);
  const bizCode = readDiagnosticCode(data?.biz_code);
  const hasError = Boolean(
    record && Object.prototype.hasOwnProperty.call(record, 'error') && record.error !== null && record.error !== false ||
    data && Object.prototype.hasOwnProperty.call(data, 'error') && data.error !== null && data.error !== false
  );
  return {
    code,
    bizCode,
    isError: hasError || code !== null && code !== 0 || bizCode !== null && bizCode !== 0,
  };
}

function readDiagnosticCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999_999
    ? value
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeHistoryMessage(raw: unknown): DeepSeekHistoryMessage {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    id: firstMessageId(value.message_id, value.id, value.uuid),
    parentId: firstMessageId(value.parent_id, value.parent_message_id, value.parentMessageId),
    role: firstString(value.message_role, value.role)?.toLowerCase() ?? null,
  };
}

function readDeepSeekUserToken(): string | null {
  try {
    const raw = localStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (!raw) return null;

    const parsed = tryParseJson(raw);
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (parsed && typeof parsed === 'object') {
      return firstString(
        (parsed as Record<string, unknown>).token,
        (parsed as Record<string, unknown>).value,
        (parsed as Record<string, unknown>).accessToken,
      );
    }

    if (raw.trim() === 'null') return null;
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function normalizeHeaders(headersInit: HeadersInit | undefined): Headers | null {
  if (!headersInit) return null;
  try {
    return new Headers(headersInit);
  } catch {
    return null;
  }
}

function getDeepSeekAppVersion(): string {
  return DEFAULT_APP_VERSION;
}

function getDeepSeekLocale(): string {
  return document.documentElement.lang || navigator.language || 'en-US';
}

async function createPowChallenge(
  clientHeaders: Record<string, string>,
  targetPath: string,
  context: DeepSeekRequestContext,
): Promise<PowChallenge> {
  const response = await requestDeepSeek(
    encodePowChallengeRequest(clientHeaders, targetPath),
    'DeepSeek PoW challenge',
    'pow',
    context,
  );
  // HTTP 401/403 means the token itself is rejected; classify as auth so the
  // caller refreshes credentials instead of treating it as a PoW failure and
  // retry-storming (401/403 PoW misclassification).
  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekAuthError(
      `DeepSeek auth token was rejected (HTTP ${response.status}) while creating PoW challenge.`,
    );
  }
  const json = await readJsonResponse(response, 'DeepSeek PoW challenge', 'pow');
  const data = json?.data;
  const challenge = data?.biz_data?.challenge;

  if (isAuthBizError(data, json)) {
    throw new DeepSeekAuthError(`DeepSeek auth token was rejected while creating PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  if (!response.ok || data?.biz_code !== 0 || !challenge) {
    throw new DeepSeekPowError(`Failed to create DeepSeek PoW challenge: ${JSON.stringify(data ?? json)}`);
  }

  return {
    algorithm: String(challenge.algorithm),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt),
    difficulty: Number(challenge.difficulty),
    signature: String(challenge.signature),
    expireAt: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
    expireAfter: Number(challenge.expire_after ?? challenge.expireAfter ?? 0),
  };
}

function normalizeUploadedFile(raw: unknown): DeepSeekUploadedFile | null {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const id = firstString(value.id, value.file_id, value.fileId);
  if (!id) return null;

  return {
    id,
    fileName: firstString(value.file_name, value.fileName, value.name),
    fileSize: firstFiniteNumber(value.file_size, value.fileSize, value.size),
    mimeType: firstString(value.mime_type, value.mimeType),
    status: firstString(value.status),
    signedPath: firstString(value.signed_path, value.signedPath),
    auditResult: firstString(value.audit_result, value.auditResult),
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
    width: firstFiniteNumber(value.width),
    height: firstFiniteNumber(value.height),
  };
}

function isUploadedFileReady(file: DeepSeekUploadedFile): boolean {
  const status = file.status?.toUpperCase();
  return status === 'SUCCESS' && isUploadedFileAuditAccepted(file);
}

function assertUploadedFileNotRejected(file: DeepSeekUploadedFile): void {
  const status = file.status?.toUpperCase();
  if (isUploadedFileAuditRejected(file)) {
    throw new DeepSeekPayloadError(`DeepSeek rejected ${file.fileName ?? file.id}: audit_result=${file.auditResult}.`);
  }
  if (status === 'FAILED' || status === 'FAIL' || status === 'ERROR') {
    throw new DeepSeekPayloadError(`DeepSeek failed to process ${file.fileName ?? file.id}: status=${file.status}.`, {
      retryable: file.retryable ?? false,
    });
  }
}

function normalizeFileAuditResult(file: DeepSeekUploadedFile): string | null {
  const auditResult = file.auditResult?.trim();
  return auditResult ? auditResult.toUpperCase() : null;
}

function isUploadedFileAuditAccepted(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return !auditResult || ACCEPTED_FILE_AUDIT_RESULTS.has(auditResult);
}

function isUploadedFileAuditRejected(file: DeepSeekUploadedFile): boolean {
  const auditResult = normalizeFileAuditResult(file);
  return auditResult ? REJECTED_FILE_AUDIT_RESULTS.has(auditResult) : false;
}

async function solvePowChallenge(
  challenge: PowChallenge,
  wasmUrl?: string,
  signal?: AbortSignal,
): Promise<PowAnswer> {
  try {
    return await solvePowChallengeLocally(challenge, wasmUrl, signal);
  } catch (err) {
    const localMessage = err instanceof Error ? err.message : String(err);
    throw new DeepSeekPowError(`DeepSeek PoW challenge failed: ${localMessage}`);
  }
}

function isAuthBizError(data: any, json: any): boolean {
  return data?.biz_code === 40002 || data?.biz_code === 40003 || json?.code === 40002 || json?.code === 40003;
}

async function readFailureMessage(response: Response): Promise<string> {
  const text = await readNetworkResponseText(response, 'DeepSeek completion');
  return text || `DeepSeek completion failed with HTTP ${response.status}.`;
}

type DeepSeekJsonErrorKind = 'payload' | 'pow' | 'session';

async function readJsonResponse(
  response: Response,
  label: string,
  errorKind: DeepSeekJsonErrorKind,
): Promise<any> {
  const text = await readNetworkResponseText(response, label);
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    const message = `${label} returned non-JSON HTTP ${response.status}: ${preview || response.statusText}`;
    if (errorKind === 'pow') throw new DeepSeekPowError(message);
    if (errorKind === 'session') throw new DeepSeekSessionError(message);
    throw new DeepSeekPayloadError(message, { retryable: response.status >= 500 });
  }
}

async function requestDeepSeek(
  request: { url: string; init: RequestInit },
  operation: string,
  phase: 'session' | 'pow' | 'completion' | 'history' | 'upload',
  context: DeepSeekRequestContext,
): Promise<Response> {
  return fetchWithNetworkPolicy(request.url, {
    ...request.init,
    signal: context.signal,
  }, {
    operation,
    phase,
    deadlineAt: context.deadlineAt,
    maxRequestBytes: DEEPSEEK_BODY_BUDGETS.activeRequest,
    maxResponseBytes: phase === 'completion'
      ? DEEPSEEK_BODY_BUDGETS.activeCompletion
      : DEEPSEEK_BODY_BUDGETS.activeJson,
    fetchImpl: context.fetchImpl,
    onDispatch: context.onDispatch,
  });
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstMessageId(...values: unknown[]): number | null {
  for (const value of values) {
    const id = normalizeDeepSeekMessageId(value);
    if (id !== null) return id;
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
