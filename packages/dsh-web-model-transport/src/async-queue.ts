export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly maximumBufferedValues: number) {}

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (this.values.length >= this.maximumBufferedValues) return false;
    this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  finishWith(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      // A single reserved terminal slot keeps the queue bounded while never
      // discarding an event already accepted into the consumer buffer.
      this.values.push(value);
    }
    this.close();
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
