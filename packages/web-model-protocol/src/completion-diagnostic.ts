/** Safe metadata only: no upstream strings, response bodies, headers or URLs. */
export interface CompletionDiagnosticMetadata {
  httpStatus: number;
  contentKind: 'empty' | 'json_error' | 'json' | 'sse_error' | 'sse' | 'other';
  bodyBytes: number;
  sseEvents: number;
  code: number | null;
  bizCode: number | null;
}

const PREFIX = 'deepseek_stream_incomplete';
const KINDS = new Set(['empty', 'json_error', 'json', 'sse_error', 'sse', 'other']);
const FIELDS = ['bodyBytes', 'bizCode', 'code', 'contentKind', 'httpStatus', 'sseEvents'].sort().join(',');
const boundedInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Encode within the existing bounded protocol reason, without changing outcome semantics. */
export function completionDiagnosticReason(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return PREFIX;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== FIELDS ||
      !boundedInteger(record.httpStatus, 100, 599) ||
      typeof record.contentKind !== 'string' || !KINDS.has(record.contentKind) ||
      !boundedInteger(record.bodyBytes, 0, 4 * 1024 * 1024) ||
      !boundedInteger(record.sseEvents, 0, 4 * 1024 * 1024) ||
      (record.code !== null && !boundedInteger(record.code, 0, 999_999)) ||
      (record.bizCode !== null && !boundedInteger(record.bizCode, 0, 999_999))) return PREFIX;
  return `${PREFIX}.v1:h${record.httpStatus}:${record.contentKind}:b${record.bodyBytes}:e${record.sseEvents}:c${record.code ?? 'n'}:biz${record.bizCode ?? 'n'}`;
}

/** Validate the whole canonical reason before persistence or user-visible diagnostics. */
export function isCompletionDiagnosticReason(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 220) return false;
  const match = /^deepseek_stream_incomplete\.v1:h([0-9]{3}):(empty|json_error|json|sse_error|sse|other):b([0-9]{1,7}):e([0-9]{1,7}):c(n|[0-9]{1,6}):biz(n|[0-9]{1,6})$/.exec(value);
  if (!match) return false;
  return completionDiagnosticReason({
    httpStatus: Number(match[1]), contentKind: match[2], bodyBytes: Number(match[3]),
    sseEvents: Number(match[4]), code: match[5] === 'n' ? null : Number(match[5]),
    bizCode: match[6] === 'n' ? null : Number(match[6]),
  }) === value;
}
