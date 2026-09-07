import type { Context } from "@deepseek-ai/cordis";

export declare const inject: readonly ["slots", "locale", "settingsScope", "remote"];
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
