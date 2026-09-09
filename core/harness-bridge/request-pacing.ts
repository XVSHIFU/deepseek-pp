import {
  DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS as DEFAULT_COMPLETION_MIN_INTERVAL_MS,
  MAX_HARNESS_BRIDGE_REQUEST_INTERVAL_MS as MAX_COMPLETION_MIN_INTERVAL_MS,
  MIN_HARNESS_BRIDGE_REQUEST_INTERVAL_MS as MIN_COMPLETION_MIN_INTERVAL_MS,
} from './contracts';

export { DEFAULT_COMPLETION_MIN_INTERVAL_MS };
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 120_000;

export interface CompletionPacingPermit {
  /** Call exactly when the browser completion request begins dispatching. */
  dispatched(): void;
  /** Release after the completion request settles. Safe to call more than once. */
  release(): void;
}

/** One adapter-scoped completion-start scheduler, shared by every web session. */
export interface CompletionPacing {
  acquire(signal: AbortSignal): Promise<CompletionPacingPermit>;
  noteRateLimit(): void;
  noteCompleted(): void;
}

export interface RequestPacingClock {
  now(): number;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface CompletionPacingOptions {
  readonly getMinIntervalMs?: () => number | Promise<number>;
  readonly clock?: RequestPacingClock;
}

interface QueueEntry {
  readonly signal: AbortSignal;
  readonly resolve: (permit: CompletionPacingPermit) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
}

/**
 * Serializes browser completion requests. Dispatch records the start time, but
 * the permit remains exclusive until the submit promise settles; a transport
 * that ignores cancellation therefore cannot overlap a later completion.
 */
export class CompletionPacingGate implements CompletionPacing {
  private readonly getMinIntervalMs: () => number | Promise<number>;
  private readonly clock: RequestPacingClock;
  private readonly queue: QueueEntry[] = [];
  private active: QueueEntry | undefined;
  private pumping = false;
  private lastDispatchAt: number | undefined;
  private cooldownUntil = 0;
  private consecutiveRateLimits = 0;
  private wakeController = new AbortController();

  constructor(options: CompletionPacingOptions = {}) {
    this.getMinIntervalMs = options.getMinIntervalMs ?? (() => DEFAULT_COMPLETION_MIN_INTERVAL_MS);
    this.clock = options.clock ?? systemClock;
  }

  acquire(signal: AbortSignal): Promise<CompletionPacingPermit> {
    if (signal.aborted) return Promise.reject(pacingAborted());
    return new Promise<CompletionPacingPermit>((resolve, reject) => {
      let entry!: QueueEntry;
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', abort);
        reject(pacingAborted());
        this.wake();
        this.pump();
      };
      entry = { signal, resolve, reject, abort };
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  noteRateLimit(): void {
    this.consecutiveRateLimits = Math.min(this.consecutiveRateLimits + 1, 3);
    const cooldown = Math.min(
      DEFAULT_RATE_LIMIT_COOLDOWN_MS * 2 ** (this.consecutiveRateLimits - 1),
      MAX_RATE_LIMIT_COOLDOWN_MS,
    );
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + cooldown);
    this.wake();
  }

  noteCompleted(): void {
    this.consecutiveRateLimits = 0;
  }

  private pump(): void {
    if (this.pumping || this.active) return;
    this.pumping = true;
    void this.run().catch(() => {
      const entry = this.queue[0];
      if (entry) this.rejectEntry(entry, new Error('REQUEST_PACING_WAIT_FAILED'));
    }).finally(() => {
      this.pumping = false;
      if (!this.active && this.queue.length > 0) this.pump();
    });
  }

  private async run(): Promise<void> {
    while (!this.active && this.queue.length > 0) {
      const entry = this.queue[0]!;
      if (entry.signal.aborted) {
        this.rejectEntry(entry, pacingAborted());
        continue;
      }
      let minimum: number;
      try {
        minimum = await this.readMinimum(entry.signal);
      } catch (error) {
        this.rejectEntry(entry, error instanceof Error ? error : new Error('REQUEST_PACING_CONFIG_FAILED'));
        continue;
      }
      if (this.queue[0] !== entry) continue;
      const nextAllowed = Math.max(
        this.cooldownUntil,
        this.lastDispatchAt === undefined ? 0 : this.lastDispatchAt + minimum,
      );
      const delay = nextAllowed - this.clock.now();
      if (delay > 0) {
        const wakeSignal = this.wakeController.signal;
        try {
          await waitForEither(this.clock, delay, entry.signal, wakeSignal);
        } catch {
          if (entry.signal.aborted) this.rejectEntry(entry, pacingAborted());
          else if (!wakeSignal.aborted) this.rejectEntry(entry, new Error('REQUEST_PACING_WAIT_FAILED'));
        }
        continue;
      }
      this.queue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      this.active = entry;
      let dispatched = false;
      let released = false;
      const settle = () => {
        if (released || this.active !== entry) return;
        released = true;
        this.active = undefined;
        this.pump();
      };
      entry.resolve(Object.freeze({
        dispatched: () => {
          if (dispatched || released || this.active !== entry) return;
          dispatched = true;
          this.lastDispatchAt = this.clock.now();
        },
        release: settle,
      }));
    }
  }

  private async readMinimum(signal: AbortSignal): Promise<number> {
    let value: number;
    try {
      value = await awaitWithAbort(Promise.resolve().then(this.getMinIntervalMs), signal);
    } catch {
      if (signal.aborted) throw pacingAborted();
      throw new Error('REQUEST_PACING_CONFIG_FAILED');
    }
    if (!Number.isSafeInteger(value) || value < MIN_COMPLETION_MIN_INTERVAL_MS || value > MAX_COMPLETION_MIN_INTERVAL_MS) {
      throw new Error('REQUEST_PACING_CONFIG_FAILED');
    }
    return value;
  }

  private rejectEntry(entry: QueueEntry, error: Error): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.signal.removeEventListener('abort', entry.abort);
    entry.reject(error);
  }

  private wake(): void {
    this.wakeController.abort();
    this.wakeController = new AbortController();
  }
}

const systemClock: RequestPacingClock = Object.freeze({
  now: () => Date.now(),
  wait: (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(pacingAborted()); return; }
    const timer = globalThis.setTimeout(done, delayMs);
    const abort = () => done(pacingAborted());
    function done(error?: Error): void {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  }),
});

function waitForEither(clock: RequestPacingClock, delayMs: number, first: AbortSignal, second: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  if (first.aborted || second.aborted) controller.abort();
  return clock.wait(delayMs, controller.signal).finally(() => {
    first.removeEventListener('abort', abort);
    second.removeEventListener('abort', abort);
  });
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(pacingAborted());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      done();
    };
    const abort = () => finish(() => reject(pacingAborted()));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error('REQUEST_PACING_CONFIG_FAILED'))),
    );
  });
}

function pacingAborted(): Error {
  return new Error('REQUEST_PACING_ABORTED');
}
