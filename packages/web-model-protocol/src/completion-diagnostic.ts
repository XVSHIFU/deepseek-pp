/** Safe metadata only: no upstream strings, response bodies, headers or URLs. */
export interface CompletionDiagnosticMetadata {
  httpStatus: number;
  contentKind: 'empty' | 'json_error' | 'json' | 'sse_error' | 'sse' | 'other';
  bodyBytes: number;
  sseEvents: number;
  code: number | null;
  bizCode: number | null;
  /** v2: all three fields must be present together; no upstream strings. */
  sseJsonEvents?: number;
  sseEventKindMask?: number;
  sseShapeMask?: number;
}

const PREFIX = 'deepseek_stream_incomplete';
const KINDS = new Set(['empty', 'json_error', 'json', 'sse_error', 'sse', 'other']);
const FIELDS = ['bodyBytes', 'bizCode', 'code', 'contentKind', 'httpStatus', 'sseEvents'].sort().join(',');
const V2_FIELDS = [...FIELDS.split(','), 'sseJsonEvents', 'sseEventKindMask', 'sseShapeMask'].sort().join(',');
const boundedInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Encode within the existing bounded protocol reason, without changing outcome semantics. */
export function completionDiagnosticReason(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return PREFIX;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  const isV2 = keys === V2_FIELDS;
  if ((keys !== FIELDS && !isV2) ||
      !boundedInteger(record.httpStatus, 100, 599) ||
      typeof record.contentKind !== 'string' || !KINDS.has(record.contentKind) ||
      !boundedInteger(record.bodyBytes, 0, 4 * 1024 * 1024) ||
      !boundedInteger(record.sseEvents, 0, 4 * 1024 * 1024) ||
      (record.code !== null && !boundedInteger(record.code, 0, 999_999)) ||
      (record.bizCode !== null && !boundedInteger(record.bizCode, 0, 999_999))) return PREFIX;
  if (isV2 && (!boundedInteger(record.sseJsonEvents, 0, record.sseEvents as number) ||
      !boundedInteger(record.sseEventKindMask, 0, 255) ||
      !boundedInteger(record.sseShapeMask, 0, 65535))) return PREFIX;
  const base = `${PREFIX}.v${isV2 ? 2 : 1}:h${record.httpStatus}:${record.contentKind}:b${record.bodyBytes}:e${record.sseEvents}:c${record.code ?? 'n'}:biz${record.bizCode ?? 'n'}`;
  return isV2 ? `${base}:j${record.sseJsonEvents}:k${record.sseEventKindMask}:s${record.sseShapeMask}` : base;
}

/** Validate the whole canonical reason before persistence or user-visible diagnostics. */
export function isCompletionDiagnosticReason(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 220) return false;
  const match = /^deepseek_stream_incomplete\.v([12]):h([0-9]{3}):(empty|json_error|json|sse_error|sse|other):b([0-9]{1,7}):e([0-9]{1,7}):c(n|[0-9]{1,6}):biz(n|[0-9]{1,6})(?::j([0-9]{1,7}):k([0-9]{1,3}):s([0-9]{1,5}))?$/.exec(value);
  if (!match) return false;
  if ((match[1] === '2') !== (match[8] !== undefined)) return false;
  return completionDiagnosticReason({
    httpStatus: Number(match[2]), contentKind: match[3], bodyBytes: Number(match[4]),
    sseEvents: Number(match[5]), code: match[6] === 'n' ? null : Number(match[6]),
    bizCode: match[7] === 'n' ? null : Number(match[7]),
    ...(match[1] === '2' ? {
      sseJsonEvents: Number(match[8]), sseEventKindMask: Number(match[9]), sseShapeMask: Number(match[10]),
    } : {}),
  }) === value;
}
