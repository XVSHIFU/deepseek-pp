import type { SSEEvent } from '../types';
import { normalizeDeepSeekMessageId } from './request-codec';

export type { SSEEvent } from '../types';

export interface ResponseStreamUsageStats {
  modelType?: string | null;
  insertedAt?: number | null;
  updatedAt?: number | null;
  accumulatedTokenUsage?: number | null;
}

export interface DeepSeekStreamSummary {
  assistantText: string;
  /**
   * Thinking/reasoning text of the current response, accumulated separately
   * from `assistantText`. The DeepSeek web stream interleaves `THINK`
   * fragments (reasoning) and `RESPONSE` fragments (answer) over the same
   * patch paths (`response/fragments/-1/content` and bare `{"v":...}`
   * shorthand appends), so consumers that only want the answer text must read
   * `assistantText` while reasoning consumers read this field. Consumers that
   * want the combined visible text keep using the old mixed extraction
   * (`extractResponseTextFromParsed`).
   */
  assistantReasoningText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
}

export interface DeepSeekSseByteDecoder {
  push(bytes: Uint8Array): SSEEvent[];
  finish(): SSEEvent[];
}

export interface DeepSeekSseTextDecoder {
  push(text: string): SSEEvent[];
  finish(): SSEEvent[];
}

export interface DeepSeekSseFrame {
  readonly block: string;
  readonly separator: string;
  readonly event: SSEEvent | null;
  readonly parsed: unknown | null;
}

export interface DeepSeekSseFrameDecoder {
  push(text: string): DeepSeekSseFrame[];
  finish(): DeepSeekSseFrame[];
}

export interface DeepSeekSseJsonObservation {
  readonly jsonParsed: boolean;
  readonly parsed: unknown;
}

export function createDeepSeekStreamSummary(): DeepSeekStreamSummary {
  return {
    assistantText: '',
    assistantReasoningText: '',
    responseMessageId: null,
    requestMessageId: null,
    finished: false,
  };
}

export function createDeepSeekSseByteDecoder(): DeepSeekSseByteDecoder {
  const decoder = new TextDecoder();
  const textDecoder = createDeepSeekSseTextDecoder();

  return {
    push(bytes) {
      return textDecoder.push(decoder.decode(bytes, { stream: true }));
    },
    finish() {
      const decoded = decoder.decode();
      const events = decoded ? textDecoder.push(decoded) : [];
      return events.concat(textDecoder.finish());
    },
  };
}

export function createDeepSeekSseTextDecoder(): DeepSeekSseTextDecoder {
  const frameDecoder = createDeepSeekSseFrameDecoder();

  return {
    push(text) {
      return parseSSEFrames(frameDecoder.push(text));
    },
    finish() {
      return parseSSEFrames(frameDecoder.finish());
    },
  };
}

export function createDeepSeekSseFrameDecoder(): DeepSeekSseFrameDecoder {
  let buffer = '';
  let scanFrom = 0;

  const drain = (): DeepSeekSseFrame[] => {
    const frames: DeepSeekSseFrame[] = [];
    const boundaryPattern = /\r?\n\r?\n/g;
    boundaryPattern.lastIndex = scanFrom;
    let offset = 0;
    let match: RegExpExecArray | null;

    while ((match = boundaryPattern.exec(buffer)) !== null) {
      const separator = match[0];
      frames.push(createDeepSeekSseFrame(buffer.slice(offset, match.index), separator));
      offset = match.index + separator.length;
    }

    buffer = buffer.slice(offset);
    scanFrom = Math.max(0, buffer.length - 3);
    return frames;
  };

  return {
    push(text) {
      buffer += text;
      return drain();
    },
    finish() {
      const frames = drain();
      if (buffer) frames.push(createDeepSeekSseFrame(buffer, ''));
      buffer = '';
      scanFrom = 0;
      return frames;
    },
  };
}

export function consumeDeepSeekSseEvents(
  events: readonly SSEEvent[],
  summary: DeepSeekStreamSummary,
  options: {
    retainAssistantText?: boolean;
    onParsed?: (parsed: unknown, event: SSEEvent) => void;
    onSseJson?: (observation: DeepSeekSseJsonObservation, event: SSEEvent) => void;
    onReasoningChunk?: (reasoning: string, fullReasoning: string) => void;
  } = {},
): string {
  const appendedText: string[] = [];

  for (const event of events) {
    const observation = parseSSEDataObservation(event.data);
    options.onSseJson?.(observation, event);
    if (!observation.jsonParsed) continue;
    const parsed = observation.parsed;
    if (!parsed) continue;
    consumeParsedDeepSeekSseEvent(parsed, event, summary, options, appendedText);
  }

  return appendedText.join('');
}

export function consumeDeepSeekSseFrames(
  frames: readonly DeepSeekSseFrame[],
  summary: DeepSeekStreamSummary,
  options: {
    retainAssistantText?: boolean;
    onParsed?: (parsed: unknown, event: SSEEvent) => void;
    onReasoningChunk?: (reasoning: string, fullReasoning: string) => void;
  } = {},
): string {
  const appendedText: string[] = [];
  for (const frame of frames) {
    if (!frame.event || !frame.parsed) continue;
    consumeParsedDeepSeekSseEvent(frame.parsed, frame.event, summary, options, appendedText);
  }
  return appendedText.join('');
}

export function parseSSEChunk(chunk: string): SSEEvent[] {
  const decoder = createDeepSeekSseFrameDecoder();
  return parseSSEFrames(decoder.push(chunk).concat(decoder.finish()));
}

function parseSSEFrames(frames: readonly DeepSeekSseFrame[]): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const frame of frames) {
    if (frame.event) events.push(frame.event);
  }
  return events;
}

function createDeepSeekSseFrame(block: string, separator: string): DeepSeekSseFrame {
  const event = parseSSEBlock(block);
  let parsedResolved = false;
  let parsed: unknown | null = null;
  return {
    block,
    separator,
    event,
    get parsed() {
      if (!parsedResolved) {
        parsed = event ? parseSSEData(event.data) : null;
        parsedResolved = true;
      }
      return parsed;
    },
  };
}

function parseSSEBlock(block: string): SSEEvent | null {
  if (!block.trim()) return null;

  const event: Partial<SSEEvent> = {};
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('id:')) {
      event.id = line.slice(3).trim();
    } else if (line.startsWith('event:')) {
      event.type = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      event.data = event.data != null ? `${event.data}\n${data}` : data;
    }
  }

  if (event.data === undefined) return null;
  return {
    type: event.type ?? 'message',
    data: event.data,
    id: event.id,
  };
}

function consumeParsedDeepSeekSseEvent(
  parsed: unknown,
  event: SSEEvent,
  summary: DeepSeekStreamSummary,
  options: {
    retainAssistantText?: boolean;
    onParsed?: (parsed: unknown, event: SSEEvent) => void;
    onReasoningChunk?: (reasoning: string, fullReasoning: string) => void;
  },
  appendedText: string[],
): void {
  collectDeepSeekMessageIds(parsed, summary);
  options.onParsed?.(parsed, event);

  const split = splitDeepSeekResponseText(parsed, getDeepSeekFragmentState(summary));
  if (split.text) {
    appendedText.push(split.text);
    if (options.retainAssistantText !== false) summary.assistantText += split.text;
  }
  if (split.reasoning) {
    summary.assistantReasoningText += split.reasoning;
    options.onReasoningChunk?.(split.reasoning, summary.assistantReasoningText);
  }
  if (isStreamFinishedFromParsed(parsed)) summary.finished = true;
}

export function parseSSEData(data: string): unknown | null {
  const observation = parseSSEDataObservation(data);
  return observation.jsonParsed ? observation.parsed : null;
}

function parseSSEDataObservation(data: string): DeepSeekSseJsonObservation {
  try {
    return { jsonParsed: true, parsed: JSON.parse(data) };
  } catch {
    return { jsonParsed: false, parsed: null };
  }
}

export function replaceDeepSeekSseFrameData(
  frame: DeepSeekSseFrame,
  data: string,
): string {
  const parts = frame.block.split(/(\r\n|\r|\n)/);
  let replaced = false;
  let output = '';

  // The replacement payload supersedes the WHOLE event, so exactly one
  // `data:` line is emitted and any further data lines are dropped. Per the
  // SSE spec, multiple data lines join with '\n' — emitting one copy per
  // original line would duplicate the payload (`X\nX`) and corrupt the event
  // for servers that split a payload across data lines.
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const lineEnding = parts[index + 1] ?? '';
    if (!line.startsWith('data:')) {
      output += line + lineEnding;
      continue;
    }
    if (!replaced) {
      output += `data: ${data}${lineEnding}`;
      replaced = true;
    }
  }

  return replaced ? output : frame.block;
}

export function extractResponseUsageStatsFromParsed(
  parsed: unknown,
  eventType?: string,
): ResponseStreamUsageStats | null {
  const stats = collectResponseUsageStats(parsed, eventType);
  return hasResponseUsageStats(stats) ? stats : null;
}

export function isResponseTextPatchPath(path: unknown): path is string {
  return isTextPatchPath(path) && isResponsePatchPath(path);
}

function isTextPatchPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const lastSegment = path.split('/').pop();
  return (
    lastSegment === 'content' ||
    lastSegment === 'text' ||
    lastSegment === 'markdown' ||
    lastSegment === 'delta'
  );
}

function isResponsePatchPath(path: unknown): path is string {
  return typeof path === 'string' && (path === 'response' || path.startsWith('response/'));
}

export function isThinkingPatchPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const lastSegment = path.split('/').pop();
  return lastSegment === 'reasoning_content' || lastSegment === 'thinking_content';
}

export function extractTextFromParsed(parsed: any): string | null {
  if (parsed?.o === 'BATCH' && Array.isArray(parsed.v)) {
    const text = parsed.v
      .map((item: unknown) => extractTextFromParsed(item))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  // Format 1: {"v":"text"} — shorthand text append (no path)
  if (!parsed.p && typeof parsed.v === 'string') {
    return parsed.v;
  }
  // Format 2: {"p":"...", "o":"APPEND", "v":"text"} — explicit append
  if (parsed.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    return parsed.v;
  }
  // Format 3: {"p":"response/fragments/-1/content", "v":"text"} — text/content patch (no "o" field)
  if (isTextPatchPath(parsed.p) && typeof parsed.v === 'string' && !parsed.o) {
    return parsed.v;
  }
  // Format 4: {"p":"response/fragments", "o":"APPEND", "v":[{content:"text",...}]} — new fragment with initial content
  if (isFragmentsAppendPatch(parsed)) {
    const text = parsed.v
      .map((frag: unknown) => extractFragmentText(frag))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

export function extractResponseTextFromParsed(parsed: any): string | null {
  if (parsed?.o === 'BATCH' && Array.isArray(parsed.v)) {
    const text = parsed.v
      .map((item: unknown) => extractResponseTextFromParsed(item))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  if (!parsed.p && typeof parsed.v === 'string') {
    return parsed.v;
  }
  if (isResponseTextPatchPath(parsed.p) && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    return parsed.v;
  }
  if (isResponseTextPatchPath(parsed.p) && typeof parsed.v === 'string' && !parsed.o) {
    return parsed.v;
  }
  if (isResponseFragmentsAppendPatch(parsed)) {
    const text = parsed.v
      .map((frag: unknown) => extractFragmentText(frag))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

export function extractResponseTextForTokenSpeed(parsed: unknown): string | null {
  const value = parsed as { o?: unknown; p?: unknown; v?: unknown } | null;
  if (value && typeof value === 'object' && value.o === 'BATCH' && Array.isArray(value.v)) {
    const text = value.v
      .map((item) => extractResponseTextForTokenSpeed(item))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }

  const responseText = extractResponseTextFromParsed(parsed as any);
  if (responseText) return responseText;

  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value.v)) {
    const text = value.v
      .map((item) => extractResponseTextForTokenSpeed(item))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }

  if (isThinkingPatchPath(value.p) && typeof value.v === 'string') {
    return value.v;
  }

  return null;
}

function isFragmentsAppendPatch(parsed: any): boolean {
  return typeof parsed?.p === 'string' &&
    parsed.p.endsWith('/fragments') &&
    parsed.o === 'APPEND' &&
    Array.isArray(parsed.v);
}

// ---------------------------------------------------------------------------
// Fragment-type routing (thinking vs answer). The DeepSeek web stream
// interleaves `THINK` fragments (reasoning) and `RESPONSE` fragments (answer)
// over the SAME patch paths: a fragment-creation event
// (`{"p":"response/fragments","o":"APPEND","v":[{type:"THINK"|"RESPONSE",...}]}`
// or the full `{"v":{"response":{fragments:[...]}}}` snapshot) declares the
// type, and every later content patch (`response/fragments/-1/content` or the
// bare `{"v":"..."}` shorthand) targets the current (last-appended) fragment.
// `extractResponseTextFromParsed` intentionally keeps the old MIXED behavior
// (the fetch-hook filter relies on it to strip tool XML out of both thinking
// and answer text); consumers that need the separated channels go through
// {@link splitDeepSeekResponseText} via `consumeDeepSeekSseEvents`.
// ---------------------------------------------------------------------------

export type DeepSeekResponseFragmentType = 'THINK' | 'RESPONSE' | 'TOOL' | string;

export interface DeepSeekFragmentState {
  /** Fragment types in append order (position = fragment index). */
  fragmentTypes: DeepSeekResponseFragmentType[];
  /** Index of the fragment receiving `-1` content patches and shorthand appends. */
  currentIndex: number;
  /** Set once a fragment-creation or snapshot event declared the fragment list. */
  observed: boolean;
}

const deepSeekFragmentStates = new WeakMap<DeepSeekStreamSummary, DeepSeekFragmentState>();

export function getDeepSeekFragmentState(summary: DeepSeekStreamSummary): DeepSeekFragmentState {
  let state = deepSeekFragmentStates.get(summary);
  if (!state) {
    state = { fragmentTypes: [], currentIndex: -1, observed: false };
    deepSeekFragmentStates.set(summary, state);
  }
  return state;
}

export interface DeepSeekResponseTextSplit {
  /** Answer (non-THINK fragment) content delta. */
  text: string | null;
  /** Thinking/reasoning fragment content delta. */
  reasoning: string | null;
}

function splitByType(type: DeepSeekResponseFragmentType | null, content: string): DeepSeekResponseTextSplit {
  return String(type).toUpperCase() === 'THINK'
    ? { text: null, reasoning: content }
    : { text: content, reasoning: null };
}

/**
 * Consumes the initial `content` of every fragment in a fragment-creation
 * (APPEND or first snapshot) event, routing each fragment's delta by its own
 * type. Returns `{text: null, reasoning: null}` when no fragment carries
 * content.
 */
function consumeFragmentsInitialContent(
  fragments: readonly unknown[],
  types: readonly DeepSeekResponseFragmentType[],
): DeepSeekResponseTextSplit {
  let text: string | null = null;
  let reasoning: string | null = null;
  fragments.forEach((fragment, index) => {
    const content = extractFragmentText(fragment);
    if (!content) return;
    const part = splitByType(types[index] ?? null, content);
    if (part.text) text = (text ?? '') + part.text;
    if (part.reasoning) reasoning = (reasoning ?? '') + part.reasoning;
  });
  return { text, reasoning };
}

function fragmentTypeAt(state: DeepSeekFragmentState, index: number): DeepSeekResponseFragmentType | null {
  if (index === -1) index = state.currentIndex;
  if (index < 0 || index >= state.fragmentTypes.length) return null;
  return state.fragmentTypes[index];
}

/**
 * Splits one parsed SSE payload into answer text and reasoning text, updating
 * the fragment-type tracker as fragment-creation events arrive. Unknown
 * fragment state routes content to the answer channel (the pre-fragment
 * behavior), so non-thinking streams extract exactly like before.
 */
export function splitDeepSeekResponseText(
  parsed: any,
  state: DeepSeekFragmentState,
): DeepSeekResponseTextSplit {
  if (parsed?.o === 'BATCH' && Array.isArray(parsed.v)) {
    let text: string | null = null;
    let reasoning: string | null = null;
    for (const item of parsed.v) {
      const part = splitDeepSeekResponseText(item, state);
      if (part.text) text = (text ?? '') + part.text;
      if (part.reasoning) reasoning = (reasoning ?? '') + part.reasoning;
    }
    return { text, reasoning };
  }

  // Fragment creation: `{"p":"response/fragments","o":"APPEND","v":[...]}`.
  // The appended fragments become the current ones; their initial `content`
  // is a real delta (the server only re-streams it here, not in later
  // patches), routed by each fragment's own type. Every fragment's content is
  // consumed — an APPEND that carries several fragments (for example a final
  // THINK and an opening RESPONSE in one event) must not drop the earlier
  // fragments' initial deltas.
  if (isFragmentsAppendPatch(parsed)) {
    const fragments = parsed.v as unknown[];
    const types: DeepSeekResponseFragmentType[] = fragments.map((fragment) =>
      String((fragment as Record<string, unknown> | null)?.type ?? 'RESPONSE'));
    state.fragmentTypes.push(...types);
    state.currentIndex = state.fragmentTypes.length - 1;
    state.observed = true;
    return consumeFragmentsInitialContent(fragments, types);
  }

  // Full response snapshot: `{"v":{"response":{...,"fragments":[...]}}}`.
  // It declares (or re-declares) the fragment list. Its embedded content is
  // only consumed on the FIRST observation — the snapshot is cumulative, so
  // later snapshots would duplicate already-streamed content.
  const snapshotFragments = getSnapshotFragments(parsed);
  if (snapshotFragments) {
    const firstObservation = !state.observed;
    const types: DeepSeekResponseFragmentType[] = snapshotFragments.map((fragment) =>
      String((fragment as Record<string, unknown> | null)?.type ?? 'RESPONSE'));
    state.fragmentTypes = types;
    state.currentIndex = state.fragmentTypes.length - 1;
    state.observed = true;
    if (firstObservation) {
      return consumeFragmentsInitialContent(snapshotFragments, types);
    }
    return { text: null, reasoning: null };
  }

  // Explicit thinking/reasoning patch paths are always reasoning.
  if (isThinkingPatchPath(parsed?.p) && typeof parsed?.v === 'string') {
    return { text: null, reasoning: parsed.v };
  }

  // Content patches (`response/fragments/-1/content`, `response/content`, ...)
  // route by the fragment they target.
  if (typeof parsed?.p === 'string' && isResponseTextPatchPath(parsed.p) && typeof parsed.v === 'string') {
    const index = fragmentIndexFromPatchPath(parsed.p);
    return splitByType(fragmentTypeAt(state, index), parsed.v);
  }

  // Bare shorthand `{"v":"text"}` appends to the current fragment.
  if (!parsed?.p && typeof parsed?.v === 'string') {
    return splitByType(fragmentTypeAt(state, state.currentIndex), parsed.v);
  }

  return { text: null, reasoning: null };
}

/** Reads `response/fragments/<index>/content`-style paths; `-1` means current. */
function fragmentIndexFromPatchPath(path: string): number {
  const match = /^response\/fragments\/(-?\d+)\//.exec(path);
  if (!match) return -1;
  return Number(match[1]);
}

function getSnapshotFragments(parsed: any): unknown[] | null {
  if (!parsed || parsed.p !== undefined || !parsed.v || typeof parsed.v !== 'object') return null;
  const response = (parsed.v as Record<string, unknown>).response;
  if (!response || typeof response !== 'object') return null;
  const fragments = (response as Record<string, unknown>).fragments;
  return Array.isArray(fragments) && fragments.length > 0 ? fragments : null;
}

function isResponseFragmentsAppendPatch(parsed: any): boolean {
  return parsed?.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v);
}

function extractFragmentText(fragment: unknown): string | null {
  if (!fragment || typeof fragment !== 'object') return null;
  const value = fragment as Record<string, unknown>;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.text === 'string') return value.text;
  return null;
}

export function isStreamFinishedFromParsed(parsed: any): boolean {
  if (parsed.p === 'response/status' && parsed.v === 'FINISHED') return true;
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    return parsed.v.some(
      (item: { p: string; v: string }) => item.p === 'quasi_status' && item.v === 'FINISHED',
    );
  }
  return false;
}

function collectResponseUsageStats(
  parsed: unknown,
  eventType?: string,
): ResponseStreamUsageStats {
  if (!parsed || typeof parsed !== 'object') return {};

  const value = parsed as Record<string, unknown>;
  let stats: ResponseStreamUsageStats = {};

  if (eventType === 'ready' && typeof value.model_type === 'string') {
    stats.modelType = value.model_type;
  }

  if (eventType === 'update_session') {
    stats = mergeResponseUsageStats(stats, {
      updatedAt: readFiniteNumber(value.updated_at),
    });
  }

  if (value.o === 'BATCH' && Array.isArray(value.v)) {
    for (const item of value.v) {
      stats = mergeResponseUsageStats(stats, collectResponseUsageStats(item, eventType));
    }
  }

  if (typeof value.p === 'string') {
    stats = mergeResponseUsageStats(stats, collectPatchUsageStats(value));
  }

  if (value.response && typeof value.response === 'object') {
    stats = mergeResponseUsageStats(stats, collectResponseObjectUsageStats(value.response));
  }

  if (value.v && typeof value.v === 'object' && !Array.isArray(value.v)) {
    stats = mergeResponseUsageStats(stats, collectResponseUsageStats(value.v, eventType));
  }

  return stats;
}

function collectPatchUsageStats(value: Record<string, unknown>): ResponseStreamUsageStats {
  const path = value.p;
  if (typeof path !== 'string') return {};

  if (path === 'response/accumulated_token_usage' || path === 'accumulated_token_usage') {
    return { accumulatedTokenUsage: readNonNegativeNumber(value.v) };
  }
  if (path === 'response/inserted_at' || path === 'inserted_at') {
    return { insertedAt: readFiniteNumber(value.v) };
  }
  if (path === 'response/updated_at' || path === 'updated_at') {
    return { updatedAt: readFiniteNumber(value.v) };
  }
  if ((path === 'response/model_type' || path === 'model_type') && typeof value.v === 'string') {
    return { modelType: value.v };
  }
  if (path === 'response' && value.v && typeof value.v === 'object' && !Array.isArray(value.v)) {
    return collectResponseObjectUsageStats(value.v);
  }
  return {};
}

function collectResponseObjectUsageStats(value: unknown): ResponseStreamUsageStats {
  if (!value || typeof value !== 'object') return {};
  const response = value as Record<string, unknown>;
  const stats: ResponseStreamUsageStats = {};
  const insertedAt = readFiniteNumber(response.inserted_at);
  const accumulatedTokenUsage = readNonNegativeNumber(response.accumulated_token_usage);
  if (insertedAt !== null) stats.insertedAt = insertedAt;
  if (accumulatedTokenUsage !== null) stats.accumulatedTokenUsage = accumulatedTokenUsage;
  if (typeof response.model_type === 'string') {
    stats.modelType = response.model_type;
  }
  return stats;
}

function mergeResponseUsageStats(
  left: ResponseStreamUsageStats,
  right: ResponseStreamUsageStats,
): ResponseStreamUsageStats {
  const merged = { ...left };
  if ('modelType' in right && right.modelType !== null && right.modelType !== undefined) merged.modelType = right.modelType;
  if ('insertedAt' in right && right.insertedAt !== null && right.insertedAt !== undefined) merged.insertedAt = right.insertedAt;
  if ('updatedAt' in right && right.updatedAt !== null && right.updatedAt !== undefined) merged.updatedAt = right.updatedAt;
  if (
    'accumulatedTokenUsage' in right &&
    right.accumulatedTokenUsage !== null &&
    right.accumulatedTokenUsage !== undefined
  ) {
    merged.accumulatedTokenUsage = right.accumulatedTokenUsage;
  }
  return merged;
}

function hasResponseUsageStats(stats: ResponseStreamUsageStats): boolean {
  return stats.modelType !== undefined ||
    stats.insertedAt !== undefined ||
    stats.updatedAt !== undefined ||
    stats.accumulatedTokenUsage !== undefined;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function collectDeepSeekMessageIds(parsed: unknown, summary: DeepSeekStreamSummary): void {
  if (!parsed || typeof parsed !== 'object') return;
  const value = parsed as Record<string, unknown>;

  const responseId = firstMessageId(value.response_message_id, value.responseMessageId);
  if (responseId !== null) summary.responseMessageId = responseId;

  const requestId = firstMessageId(value.request_message_id, value.requestMessageId);
  if (requestId !== null) summary.requestMessageId = requestId;

  if (value.o === 'BATCH' && Array.isArray(value.v)) {
    for (const item of value.v) collectDeepSeekMessageIds(item, summary);
  }

  if (typeof value.p === 'string') {
    if (value.p.includes('response_message_id')) {
      const id = firstMessageId(value.v);
      if (id !== null) summary.responseMessageId = id;
    }
    if (value.p.includes('request_message_id')) {
      const id = firstMessageId(value.v);
      if (id !== null) summary.requestMessageId = id;
    }
  }

  if (Array.isArray(value.v)) {
    for (const item of value.v) collectDeepSeekMessageIds(item, summary);
  } else if (value.v && typeof value.v === 'object') {
    collectDeepSeekMessageIds(value.v, summary);
  }
}

function firstMessageId(...values: unknown[]): number | null {
  for (const value of values) {
    const id = normalizeDeepSeekMessageId(value);
    if (id !== null) return id;
  }
  return null;
}
