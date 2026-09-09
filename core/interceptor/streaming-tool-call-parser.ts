import type { ToolCall, ToolDescriptor, ToolError } from '../types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  getToolCloseTag,
  type ToolInvocationCatalog,
} from '../tool';
import { createExternalizedToolPayload } from '../tool/externalized-payload';
import { INCOMPLETE_TOOL_CALL_ERROR_CODE } from '../tool/execution-error';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from '../tool/xml-tags';

const STREAM_TOOL_RAW_MAX_LENGTH = 2048;
const TRUNCATION_SUFFIX = '\n...[truncated]';
const EXTERNALIZE_BODY_THRESHOLD_CHARS = 64_000;
const STREAM_TOOL_BODY_MAX_CHARS = 1_048_576;

export interface StreamingToolCallParserEvent {
  started: ToolCall[];
  completed: ToolCall[];
  failed: ToolCall[];
  streamed: ToolCallPayloadChunk[];
}

export interface StreamingToolCallParser {
  append(chunk: string): StreamingToolCallParserEvent;
  flush(): StreamingToolCallParserEvent;
}

export interface ToolCallPayloadChunk {
  id: string;
  invocationName: string;
  chunk: string;
  requestId?: string;
}

export interface StreamingToolCallParserOptions {
  // Only Mode A opts in: reject truncated advertised openings and unknown
  // bare tags followed by JSON-object/array bodies. Ordinary HTML stays text.
  strictToolCalls?: boolean;
  // The active local skill's skillDir for the request owning the current response; when non-empty, parsed
  // shell_exec / shell_session_begin calls carry localSkillDir as the "initial cwd hint" at the background
  // runtime (not a hard persistent binding; Review #4 Route A).
  activeLocalSkillDir?: string;
}

export function createStreamingToolCallParser(
  descriptors: readonly ToolDescriptor[],
  options?: StreamingToolCallParserOptions,
): StreamingToolCallParser {
  return new XmlStreamingToolCallParser(createToolInvocationCatalog(descriptors), options);
}

class XmlStreamingToolCallParser implements StreamingToolCallParser {
  private readonly invocationNames: ReadonlySet<string>;
  private readonly strictToolCalls: boolean;
  private state: 'NORMAL' | 'SUPPRESSING' | 'UNKNOWN_TAG' = 'NORMAL';
  private unknownTag: { name: string; raw: string } | null = null;
  private pendingNormal = '';
  // Strict unknown-tag detection must not interpret CLI placeholders inside
  // backtick examples as tool intent. Keep delimiter runs across SSE chunks.
  private readonly codeSpans = new BacktickCodeContext();
  private pendingSuppressed = '';
  private current: {
    id: string;
    invocationName: string;
    openTag: string;
    closeTag: string;
    bodyParts: string[];
    bodyLength: number;
    externalized: boolean;
    externalizable: boolean;
    failed: boolean;
  } | null = null;

  constructor(
    private readonly catalog: ToolInvocationCatalog,
    options?: StreamingToolCallParserOptions,
  ) {
    this.invocationNames = new Set(catalog.invocationNames);
    this.strictToolCalls = options?.strictToolCalls === true;
    this.activeLocalSkillDir = options?.activeLocalSkillDir || undefined;
  }

  private readonly activeLocalSkillDir: string | undefined;

  append(chunk: string): StreamingToolCallParserEvent {
    const event = createEmptyParserEvent();
    if (!chunk || (this.invocationNames.size === 0 && !this.strictToolCalls)) return event;

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining = this.state === 'SUPPRESSING'
        ? this.consumeSuppressedText(remaining, event)
        : this.state === 'UNKNOWN_TAG'
          ? this.consumeUnknownTagBody(remaining, event)
          : this.consumeNormalText(remaining, event);
    }
    return event;
  }

  flush(): StreamingToolCallParserEvent {
    const event = createEmptyParserEvent();
    if (this.current && !this.current.failed) {
      event.failed.push(this.createIncompleteCall(this.current, this.pendingSuppressed));
    }
    if (this.strictToolCalls && this.state === 'NORMAL' && /[A-Za-z_]/.test(this.pendingNormal)) {
      const name = this.catalog.invocationNames.find((candidate) => (
        getPartialXmlToolTagTailLength(this.pendingNormal, new Set([candidate]), { closing: false }) ===
        this.pendingNormal.length
      ));
      if (name) event.failed.push(createToolCallFromInvocation(name, {}, this.pendingNormal, this.catalog, {
        parseError: createToolParseError(INCOMPLETE_TOOL_CALL_ERROR_CODE, name, 'Tool call opening tag ended before >.'),
      }));
    }
    this.state = 'NORMAL';
    this.pendingNormal = '';
    this.pendingSuppressed = '';
    this.current = null;
    this.unknownTag = null;
    this.codeSpans.reset();
    return event;
  }

  private consumeNormalText(input: string, event: StreamingToolCallParserEvent): string {
    const text = this.pendingNormal + input;
    this.pendingNormal = '';

    const scannedNames = this.strictToolCalls ? null : this.invocationNames;
    const found = findFirstXmlToolTag(text, scannedNames, { closing: false });
    if (!found) {
      const tailLength = getPartialXmlToolTagTailLength(text, scannedNames, { closing: false });
      this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : '';
      if (this.strictToolCalls) this.codeSpans.append(text.slice(0, text.length - tailLength));
      return '';
    }

    if (this.strictToolCalls) this.codeSpans.append(text.slice(0, found.index));
    const quotedUnknown = this.strictToolCalls && !this.invocationNames.has(found.name)
      && this.codeSpans.inside;
    if (this.strictToolCalls) this.codeSpans.append(found.raw);
    if (quotedUnknown) return text.slice(found.endIndex);

    if (!this.invocationNames.has(found.name)) {
      this.state = 'UNKNOWN_TAG';
      this.unknownTag = { name: found.name, raw: found.raw };
      return text.slice(found.endIndex);
    }

    const id = crypto.randomUUID();
    this.state = 'SUPPRESSING';
    this.pendingSuppressed = '';
    this.current = {
      id,
      invocationName: found.name,
      openTag: found.raw,
      closeTag: getToolCloseTag(found.name),
      bodyParts: [],
      bodyLength: 0,
      externalized: false,
      externalizable: isExternalizableInvocation(found.name),
      failed: false,
    };
    event.started.push(createToolCallFromInvocation(
      found.name,
      {},
      found.raw,
      this.catalog,
      { id },
    ));
    return text.slice(found.endIndex);
  }

  private consumeUnknownTagBody(input: string, event: StreamingToolCallParserEvent): string {
    const body = input.trimStart();
    if (body.length === 0) return '';
    const unknown = this.unknownTag;
    this.unknownTag = null;
    this.state = 'NORMAL';
    if (unknown && (body[0] === '{' || body[0] === '[')) {
      event.failed.push(createToolCallFromInvocation(unknown.name, {}, unknown.raw, this.catalog, {
        parseError: createToolParseError('tool_call_unknown', unknown.name, 'Tool call names must match the advertised catalog.'),
      }));
      return '';
    }
    // Not a JSON tool body. Continue scanning for advertised calls inside
    // ordinary markup instead of suppressing the whole HTML/XML element.
    return input;
  }

  private consumeSuppressedText(input: string, event: StreamingToolCallParserEvent): string {
    const current = this.current;
    if (!current) {
      this.state = 'NORMAL';
      return input;
    }

    const text = this.pendingSuppressed + input;
    this.pendingSuppressed = '';
    const closeTag = findFirstXmlToolTag(text, new Set([current.invocationName]), { closing: true });

    if (!closeTag) {
      const tailLength = getPartialXmlToolTagTailLength(text, new Set([current.invocationName]), { closing: true });
      this.appendBody(text.slice(0, text.length - tailLength), event);
      this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    this.appendBody(text.slice(0, closeTag.index), event);
    if (!current.failed) {
      event.completed.push(this.createCompletedCall({ ...current, closeTag: closeTag.raw }));
    }
    this.state = 'NORMAL';
    this.pendingSuppressed = '';
    this.current = null;
    return text.slice(closeTag.endIndex);
  }

  private appendBody(value: string, event: StreamingToolCallParserEvent): void {
    if (!value || !this.current) return;
    if (this.current.failed) return;

    this.current.bodyLength += value.length;
    if (this.current.bodyLength > STREAM_TOOL_BODY_MAX_CHARS) {
      this.current.failed = true;
      this.current.bodyParts = [];
      event.failed.push(this.createOversizedCall(this.current));
      return;
    }

    if (this.current.externalized) {
      event.streamed.push({ id: this.current.id, invocationName: this.current.invocationName, chunk: value });
      return;
    }

    this.current.bodyParts.push(value);
    if (this.current.externalizable && this.current.bodyLength > EXTERNALIZE_BODY_THRESHOLD_CHARS) {
      this.current.externalized = true;
      const buffered = this.current.bodyParts.join('');
      this.current.bodyParts = [];
      if (buffered) {
        event.streamed.push({
          id: this.current.id,
          invocationName: this.current.invocationName,
          chunk: buffered,
        });
      }
    }
  }

  private createCompletedCall(current: NonNullable<XmlStreamingToolCallParser['current']>): ToolCall {
    if (current.externalized) {
      return createToolCallFromInvocation(
        current.invocationName,
        createExternalizedToolPayload(current.id, current.invocationName),
        createExternalizedRaw(current),
        this.catalog,
        { id: current.id, localSkillDir: this.activeLocalSkillDir },
      );
    }

    const body = current.bodyParts.join('');
    const raw = createBoundedRaw(current, body);

    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body);
      if (!isToolPayload(parsed)) {
        return createToolCallFromInvocation(current.invocationName, {}, raw, this.catalog, {
          id: current.id,
          localSkillDir: this.activeLocalSkillDir,
          parseError: createToolParseError(
            'tool_call_payload_invalid',
            current.invocationName,
            'Tool call body must be a JSON object.',
          ),
        });
      }
      return createToolCallFromInvocation(current.invocationName, parsed, raw, this.catalog, {
        id: current.id,
        localSkillDir: this.activeLocalSkillDir,
      });
    } catch (error) {
      return createToolCallFromInvocation(current.invocationName, {}, raw, this.catalog, {
        id: current.id,
        localSkillDir: this.activeLocalSkillDir,
        parseError: createToolParseError(
          'tool_call_json_invalid',
          current.invocationName,
          [
            'Tool call body is not valid JSON.',
            'Use double quotes for strings and escape backslashes in local file paths, for example "D:\\\\project\\\\file.txt" or "D:/project/file.txt".',
            error instanceof Error ? error.message : String(error),
          ].join(' '),
        ),
      });
    }
  }

  private createIncompleteCall(
    current: NonNullable<XmlStreamingToolCallParser['current']>,
    pendingTail: string,
  ): ToolCall {
    return createToolCallFromInvocation(
      current.invocationName,
      current.externalized
        ? createExternalizedToolPayload(current.id, current.invocationName)
        : {},
      createIncompleteRaw(current, pendingTail),
      this.catalog,
      {
        id: current.id,
        localSkillDir: this.activeLocalSkillDir,
        parseError: createToolParseError(
          INCOMPLETE_TOOL_CALL_ERROR_CODE,
          current.invocationName,
          `Tool call ended before the closing tag ${current.closeTag}.`,
        ),
      },
    );
  }

  private createOversizedCall(
    current: NonNullable<XmlStreamingToolCallParser['current']>,
  ): ToolCall {
    return createToolCallFromInvocation(
      current.invocationName,
      {},
      createOversizedRaw(current),
      this.catalog,
      {
        id: current.id,
        localSkillDir: this.activeLocalSkillDir,
        parseError: createToolParseError(
          'tool_call_payload_too_large',
          current.invocationName,
          createOversizedToolCallMessage(current.invocationName),
        ),
      },
    );
  }

}

function createEmptyParserEvent(): StreamingToolCallParserEvent {
  return { started: [], completed: [], failed: [], streamed: [] };
}

function createBoundedRaw(
  current: { openTag: string; closeTag: string },
  body: string,
): string {
  const rawLength = current.openTag.length + body.length + current.closeTag.length;
  if (rawLength <= STREAM_TOOL_RAW_MAX_LENGTH) return `${current.openTag}${body}${current.closeTag}`;
  return [
    current.openTag,
    `...[payload ${body.length} chars omitted]`,
    current.closeTag,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createExternalizedRaw(
  current: { openTag: string; closeTag: string; bodyLength: number },
): string {
  return [
    current.openTag,
    `...[payload ${current.bodyLength} chars externalized]`,
    current.closeTag,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createIncompleteRaw(
  current: {
    openTag: string;
    bodyParts: string[];
    bodyLength: number;
    externalized: boolean;
  },
  pendingTail: string,
): string {
  const bodyLength = current.bodyLength + pendingTail.length;
  if (current.externalized) {
    return [
      current.openTag,
      `...[payload ${bodyLength} chars externalized before EOF]`,
      TRUNCATION_SUFFIX,
    ].join('\n');
  }

  const body = current.bodyParts.join('') + pendingTail;
  const raw = current.openTag + body;
  if (raw.length <= STREAM_TOOL_RAW_MAX_LENGTH) return raw;
  return [
    current.openTag,
    `...[incomplete payload ${bodyLength} chars omitted]`,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createOversizedRaw(
  current: { openTag: string; bodyLength: number },
): string {
  return [
    current.openTag,
    `...[payload exceeded ${STREAM_TOOL_BODY_MAX_CHARS} chars; ${current.bodyLength} chars received]`,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createOversizedToolCallMessage(invocationName: string): string {
  const limit = `Tool call body exceeded the safe streaming limit of ${STREAM_TOOL_BODY_MAX_CHARS} characters.`;
  if (invocationName === 'artifact_create' || invocationName === 'artifact_bundle_create') {
    return [
      limit,
      'Do not embed binary or base64 file data in artifact calls.',
      'Keep files produced by Shell or OfficeCLI at their local path and report that path to the user.',
    ].join(' ');
  }
  return `${limit} Split the operation into smaller tool calls.`;
}

function isToolPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function createToolParseError(code: string, invocationName: string, message: string): ToolError {
  return {
    code,
    message,
    retryable: false,
    details: { invocationName },
  };
}

/** Tracks only backtick quoting, not tool bodies or arbitrary Markdown syntax. */
class BacktickCodeContext {
  private delimiter = 0;
  private run = 0;
  private escaped = false;

  get inside(): boolean {
    this.finishRun();
    return this.delimiter > 0;
  }

  append(text: string): void {
    for (const char of text) {
      if (char === '`' && !this.escaped) {
        this.run += 1;
        continue;
      }
      this.finishRun();
      // Backslashes only escape opening delimiters outside a code span.
      this.escaped = this.delimiter === 0 && char === '\\' && !this.escaped;
    }
  }

  reset(): void {
    this.delimiter = 0;
    this.run = 0;
    this.escaped = false;
  }

  private finishRun(): void {
    if (this.run === 0) return;
    if (this.delimiter === 0) this.delimiter = this.run;
    else if (this.delimiter === this.run) this.delimiter = 0;
    this.run = 0;
  }
}

function isExternalizableInvocation(invocationName: string): boolean {
  return invocationName === 'artifact_create' ||
    invocationName === 'artifact_bundle_create' ||
    invocationName === 'shell_exec' ||
    invocationName === 'shell_session_exec' ||
    invocationName === 'local_file_write';
}
