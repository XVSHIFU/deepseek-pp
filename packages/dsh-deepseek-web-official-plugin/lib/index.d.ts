import type { Context } from "@deepseek-ai/cordis";

export declare const name = "deepseek-web-official";
export declare const inject: readonly ["settings", "credentials", "agentDefaultModel", "llm", "tools", "subprocess", "shell", "deepseekWebSessionImport"];
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
