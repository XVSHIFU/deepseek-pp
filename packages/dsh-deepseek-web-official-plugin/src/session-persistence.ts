import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import {
  ImportingJsonlSessionPersistence,
  recoverSessionImports,
} from "./session-import.ts";

export interface Config {
  readonly root: string;
  readonly importRoot: string;
  readonly compression?: "none" | "zstd";
  readonly packChunks?: boolean;
  readonly preparedSessionCacheSize?: number;
  readonly writeBatchMaxDelayMs?: number;
}
export const inject = ["sessions"] as const;
export const Config = z.object({
  root: z.string().required(),
  importRoot: z.string().required(),
  compression: z.union([z.const("none"), z.const("zstd")]).default("zstd"),
  packChunks: z.boolean().default(true),
  preparedSessionCacheSize: z.number().step(1).min(1).default(5),
  writeBatchMaxDelayMs: z.number().step(1).min(1).default(200),
});

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebSessionImport: ImportingJsonlSessionPersistence["sessionImport"];
  }
}

/** Recovery completes before the SessionPersistence service is provided. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const denied = await recoverSessionImports(config.importRoot, config.root);
  const persistence = new ImportingJsonlSessionPersistence(ctx, {
    root: config.root,
    compression: config.compression ?? "zstd",
    packChunks: config.packChunks ?? true,
    preparedSessionCacheSize: config.preparedSessionCacheSize ?? 5,
    writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? 200,
  }, config.importRoot, denied);
  const unprovide = ctx.provide("deepseekWebSessionImport", persistence.sessionImport);
  return async () => { await unprovide(); };
}
