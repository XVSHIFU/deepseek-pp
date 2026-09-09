import { describe, expect, it } from 'vitest';
import { completionDiagnosticReason, isCompletionDiagnosticReason, MAX_REASON_LENGTH } from '../packages/web-model-protocol/src/index';
import { recoveryTerminal } from '../core/harness-bridge/result-cache';
import { diagnosticSuffix } from '../packages/dsh-llm-deepseek-web/src/diagnostics';

const metadata = { httpStatus: 200, contentKind: 'json_error', bodyBytes: 124, sseEvents: 0, code: 0, bizCode: 40001 };

describe('safe completion diagnostics across browser persistence and host display', () => {
  it.each(['empty', 'json_error', 'json', 'sse_error', 'sse', 'other'])('preserves bounded %s metadata without changing ambiguous semantics', contentKind => {
    const reason = completionDiagnosticReason({ ...metadata, contentKind });
    expect(isCompletionDiagnosticReason(reason)).toBe(true);
    expect(reason.length).toBeLessThan(MAX_REASON_LENGTH);
    const event = { type: 'ambiguous', reason } as const;
    expect(recoveryTerminal(event)).toEqual(event);
    const suffix = diagnosticSuffix('private-request-canary', performance.now(), 'browser_terminal', reason);
    expect(suffix).toContain(`reason=${reason}`);
    expect(suffix).not.toContain('private-request-canary');
  });

  it('preserves null codes without inventing success or a business error', () => {
    expect(completionDiagnosticReason({ ...metadata, code: null, bizCode: null })).toMatch(/:cn:bizn$/);
  });

  it.each([
    { ...metadata, contentKind: 'private-cookie-canary' },
    { ...metadata, bodyBytes: 4 * 1024 * 1024 + 1 },
    { ...metadata, httpStatus: 999 },
    { ...metadata, code: 'secret' },
    { ...metadata, code: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata, code: 1234567890123456 },
    { ...metadata, bizCode: -1 },
    { ...metadata, rawBody: 'private-cookie-canary' },
  ])('rejects invalid or free-form metadata', input => {
    expect(completionDiagnosticReason(input)).toBe('deepseek_stream_incomplete');
  });

  it.each(['\nsecret', ':token=secret', ' secret'])('rejects an appended payload %j at both boundaries', payload => {
    const reason = completionDiagnosticReason(metadata) + payload;
    expect(isCompletionDiagnosticReason(reason)).toBe(false);
    expect(recoveryTerminal({ type: 'ambiguous', reason })).toEqual({ type: 'ambiguous', reason: 'browser_recovery_failed' });
    expect(diagnosticSuffix('request', performance.now(), 'browser_terminal', reason)).toContain('reason=unknown');
  });

  it.each(['remote_outcome_unknown', 'consumer_closed', 'status_without_stream'])('keeps an existing Host-generated reason: %s', reason => {
    expect(diagnosticSuffix('request', performance.now(), 'browser_terminal', reason)).toContain(`reason=${reason}`);
  });
});
