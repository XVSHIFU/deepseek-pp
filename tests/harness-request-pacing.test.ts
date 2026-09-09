import { describe, expect, it, vi } from 'vitest';

import { CompletionPacingGate, type RequestPacingClock } from '../core/harness-bridge/request-pacing';

class FakeClock implements RequestPacingClock {
  nowMs = 0;
  readonly delays: number[] = [];
  private readonly waits: Array<{
    target: number; signal: AbortSignal; resolve: () => void; reject: (error: Error) => void; abort: () => void;
  }> = [];

  now(): number { return this.nowMs; }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    this.delays.push(delayMs);
    return new Promise((resolve, reject) => {
      const pending = { target: this.nowMs + delayMs, signal, resolve, reject, abort: () => {} };
      const abort = () => {
        this.remove(pending);
        reject(new Error('ABORTED'));
      };
      pending.abort = abort;
      signal.addEventListener('abort', abort, { once: true });
      this.waits.push(pending);
    });
  }

  advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (const pending of [...this.waits]) {
      if (pending.target > this.nowMs) continue;
      this.remove(pending);
      pending.resolve();
    }
  }

  get pending(): number { return this.waits.length; }

  private remove(value: { target: number }): void {
    const index = this.waits.indexOf(value as (typeof this.waits)[number]);
    if (index >= 0) {
      const [pending] = this.waits.splice(index, 1);
      pending!.signal.removeEventListener('abort', pending!.abort);
    }
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('adapter-scoped completion pacing', () => {
  it.each([0, 4999, 30001, 5000.5, NaN])('rejects invalid configured intervals instead of silently changing them: %s', async (value) => {
    const gate = new CompletionPacingGate({ getMinIntervalMs: () => value });
    await expect(gate.acquire(new AbortController().signal)).rejects.toThrow('REQUEST_PACING_CONFIG_FAILED');
  });

  it('does not add a fresh interval after a long completion and reads later configuration changes', async () => {
    const clock = new FakeClock();
    let minimum = 5000;
    const gate = new CompletionPacingGate({ clock, getMinIntervalMs: async () => minimum });
    const first = await gate.acquire(new AbortController().signal);
    first.dispatched();
    clock.advance(6000);
    first.release();
    const second = await gate.acquire(new AbortController().signal);
    expect(clock.delays).toEqual([]);
    second.dispatched();
    second.release();
    minimum = 10000;
    const thirdPromise = gate.acquire(new AbortController().signal);
    for (let index = 0; index < 20 && clock.pending === 0; index += 1) await Promise.resolve();
    expect(clock.delays).toEqual([10000]);
    clock.advance(10000);
    const third = await thirdPromise;
    third.release();
    expect(clock.pending).toBe(0);
  });

  it('serializes starts across sessions, records the actual dispatch, and does not consume a slot on preparation failure', async () => {
    const clock = new FakeClock();
    const gate = new CompletionPacingGate({ clock });
    const first = await gate.acquire(new AbortController().signal);
    const secondPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.pending).toBe(0);

    first.release();
    const prepared = await secondPromise;
    prepared.release();
    expect(clock.delays).toEqual([]);

    const dispatched = await gate.acquire(new AbortController().signal);
    dispatched.dispatched();
    dispatched.release();
    const nextPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.delays).toEqual([5_000]);
    clock.advance(4_999);
    await flush();
    expect(clock.pending).toBe(1);
    clock.advance(1);
    const next = await nextPromise;
    next.release();
  });

  it('removes a cancelled queued request without an orphaned wait', async () => {
    const clock = new FakeClock();
    const gate = new CompletionPacingGate({ clock });
    const first = await gate.acquire(new AbortController().signal);
    const controller = new AbortController();
    const cancelled = gate.acquire(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('REQUEST_PACING_ABORTED');
    expect(clock.pending).toBe(0);

    first.release();
    const next = await gate.acquire(new AbortController().signal);
    next.release();
    expect(clock.pending).toBe(0);
  });

  it('cancels the real timer used by a queued production gate', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompletionPacingGate();
      const first = await gate.acquire(new AbortController().signal);
      first.dispatched();
      first.release();
      const controller = new AbortController();
      const queued = gate.acquire(controller.signal);
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await expect(queued).rejects.toThrow('REQUEST_PACING_ABORTED');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a dispatched completion until transport settlement, even when cancellation is ignored', async () => {
    const clock = new FakeClock();
    const gate = new CompletionPacingGate({ clock });
    const first = await gate.acquire(new AbortController().signal);
    first.dispatched();
    const second = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.pending).toBe(0);

    first.release();
    await flush();
    expect(clock.delays).toEqual([5_000]);
    clock.advance(5_000);
    const permit = await second;
    permit.release();
  });

  it('applies 30/60/120-second rate-limit cooldowns and resets escalation after a completed response', async () => {
    const clock = new FakeClock();
    const gate = new CompletionPacingGate({ clock });
    const first = await gate.acquire(new AbortController().signal);
    first.dispatched();
    gate.noteRateLimit();
    first.release();

    const secondPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.delays).toEqual([30_000]);
    clock.advance(30_000);
    const second = await secondPromise;
    second.dispatched();
    gate.noteRateLimit();
    second.release();

    const thirdPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.delays).toEqual([30_000, 60_000]);
    clock.advance(60_000);
    const third = await thirdPromise;
    third.dispatched();
    gate.noteRateLimit();
    third.release();

    const fourthPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.delays).toEqual([30_000, 60_000, 120_000]);
    clock.advance(120_000);
    const fourth = await fourthPromise;
    fourth.dispatched();
    gate.noteCompleted();
    fourth.release();

    const fifthPromise = gate.acquire(new AbortController().signal);
    await flush();
    expect(clock.delays.at(-1)).toBe(5_000);
    clock.advance(5_000);
    const fifth = await fifthPromise;
    fifth.dispatched();
    gate.noteRateLimit();
    fifth.release();
    const controller = new AbortController();
    const sixth = gate.acquire(controller.signal);
    await flush();
    expect(clock.delays.at(-1)).toBe(30_000);
    controller.abort();
    await expect(sixth).rejects.toThrow('REQUEST_PACING_ABORTED');
    expect(clock.pending).toBe(0);
  });
});
