import type { Context } from "@deepseek-ai/cordis";

export interface Config {
  readonly root: string;
  readonly importRoot: string;
  readonly compression?: "none" | "zstd";
  readonly packChunks?: boolean;
  readonly preparedSessionCacheSize?: number;
  readonly writeBatchMaxDelayMs?: number;
}
export declare const inject: readonly ["sessions"];
export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
