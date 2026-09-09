import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeDeepSeekSseEvents, createDeepSeekStreamSummary, parseSSEData } from '../core/deepseek/stream-codec';

describe('optional SSE JSON diagnostic observer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports malformed and falsy JSON using exactly one parse per event', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const observer = vi.fn();
    const parsed = vi.fn();
    const summary = createDeepSeekStreamSummary();
    const result = consumeDeepSeekSseEvents(
      ['{broken', '[DONE]', 'null', 'false', '0', '{"p":"response/status","v":"FINISHED"}']
        .map(data => ({ type: 'message', data })),
      summary, { onSseJson: observer, onParsed: parsed },
    );
    expect(parse).toHaveBeenCalledTimes(6);
    expect(observer.mock.calls.map(([value]) => value.jsonParsed)).toEqual([false, false, true, true, true, true]);
    expect(observer.mock.calls.slice(2, 5).map(([value]) => value.parsed)).toEqual([null, false, 0]);
    expect(parsed).toHaveBeenCalledTimes(1);
    expect(summary.finished).toBe(true);
    expect(result).toBe('');
  });

  it('does not swallow a diagnostic observer exception as invalid JSON', () => {
    const error = new Error('observer failed');
    const summary = createDeepSeekStreamSummary();
    expect(() => consumeDeepSeekSseEvents(
      [{ type: 'message', data: '{"p":"response/status","v":"FINISHED"}' }], summary,
      { onSseJson: () => { throw error; } },
    )).toThrow(error);
    expect(summary.finished).toBe(false);
  });

  it('keeps the legacy parser and no-observer consumption semantics', () => {
    expect(['{broken', 'null', 'false', '0'].map(parseSSEData)).toEqual([null, null, false, 0]);
    const summary = createDeepSeekStreamSummary();
    expect(consumeDeepSeekSseEvents([{ type: 'message', data: '{"v":"Hello"}' }], summary)).toBe('Hello');
    expect(summary.assistantText).toBe('Hello');
    expect(summary.finished).toBe(false);
  });
});
