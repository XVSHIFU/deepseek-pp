import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { DeepSeekWebReasoningEvent } from "@deepseek-pp/dsh-llm-deepseek-web";

import type { DeepSeekWebReasoningFrame } from "./reasoning-contract.ts";

const MAX_PENDING_FRAMES = 128;
const MAX_DELTA_TEXT = 16_384;

/** Process-local fanout for live reasoning. It has no replay or persistence path. */
export class DeepSeekWebReasoningFeed {
  private readonly subscribers = new Set<(frame: DeepSeekWebReasoningFrame) => void>();

  publish(event: DeepSeekWebReasoningEvent): void {
    const frame: DeepSeekWebReasoningFrame = event.phase === "delta"
      ? { ...event, text: event.text.slice(0, MAX_DELTA_TEXT) }
      : { ...event };
    for (const subscriber of this.subscribers) subscriber(frame);
  }

  async *follow(signal: AbortSignal): AsyncIterable<DeepSeekWebReasoningFrame> {
    const queue: DeepSeekWebReasoningFrame[] = [];
    let wake: (() => void) | undefined;
    const notify = (frame: DeepSeekWebReasoningFrame): void => {
      if (queue.length >= MAX_PENDING_FRAMES) {
        if (frame.phase !== "end") return;
        queue.shift();
      }
      queue.push(frame);
      wake?.();
      wake = undefined;
    };
    const aborted = (): void => {
      wake?.();
      wake = undefined;
    };
    this.subscribers.add(notify);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        while (queue.length > 0) yield queue.shift()!;
      }
    } finally {
      signal.removeEventListener("abort", aborted);
      this.subscribers.delete(notify);
    }
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebReasoningRemote: DeepSeekWebReasoningRemote;
  }
}

export class DeepSeekWebReasoningRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly feed: DeepSeekWebReasoningFeed) {
    super(ctx, "deepseekWebReasoningRemote");
    for (const initialize of remoteInitializers) initialize.call(this);
  }

  follow(signal: AbortSignal): AsyncIterable<DeepSeekWebReasoningFrame> {
    return this.feed.follow(signal);
  }
}

const remoteInitializers: Array<(this: DeepSeekWebReasoningRemote) => void> = [];
const decorate = Remote({ mode: "stream" }) as unknown as (
  value: (...args: never[]) => unknown,
  context: {
    readonly kind: "method";
    readonly name: string;
    readonly static: false;
    readonly private: false;
    addInitializer(initializer: (this: DeepSeekWebReasoningRemote) => void): void;
  },
) => void;
decorate(DeepSeekWebReasoningRemote.prototype.follow as (...args: never[]) => unknown, {
  kind: "method",
  name: "follow",
  static: false,
  private: false,
  addInitializer(initializer) { remoteInitializers.push(initializer); },
});
