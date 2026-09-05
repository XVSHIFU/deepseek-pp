import { LlmError } from "@deepseek-ai/dsh-llm";

type Release = () => void;
interface Waiting {
  readonly resolve: (release: Release | undefined) => void;
  readonly detach: () => void;
}

/** One adapter is registered for the shared LLM runtime, including child scopes.
 * Only admission is queued: the Host remains the sole request/terminal authority.
 */
export class GenerationScheduler {
  private busy = false;
  private readonly waiting: Waiting[] = [];

  acquire(signal?: AbortSignal): Promise<Release | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(this.lease());
    }
    if (this.waiting.length >= 16) {
      return Promise.reject(new LlmError("The DeepSeek Web model request queue is full.", "BROKER_BUSY"));
    }
    return new Promise((resolve) => {
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        entry.detach();
        resolve(undefined);
      };
      const entry: Waiting = { resolve, detach: () => signal?.removeEventListener("abort", abort) };
      this.waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private lease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) { this.busy = false; return; }
      next.detach();
      next.resolve(this.lease());
    };
  }
}
