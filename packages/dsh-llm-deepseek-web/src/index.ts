import type { Context } from "@deepseek-ai/cordis";
import type { DeepSeekWebBroker } from "@deepseek-pp/dsh-web-model-transport";

import { DeepSeekWebAdapter, type DeepSeekWebAdapterOptions } from "./adapter.ts";
import { DEEPSEEK_WEB_PROVIDER } from "./constants.ts";

export * from "./adapter.ts";
export * from "./constants.ts";
export * from "./request.ts";

export const name = "llm-deepseek-web";
export const inject = ["llm", "deepseekWebBroker"] as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebBroker: DeepSeekWebBroker;
  }
}

export function apply(ctx: Context): void {
  registerDeepSeekWebAdapter(ctx, ctx.deepseekWebBroker);
}

export function registerDeepSeekWebAdapter(
  ctx: Context,
  broker: DeepSeekWebBroker,
  options: Omit<DeepSeekWebAdapterOptions, "broker"> = {},
): DeepSeekWebAdapter {
  const adapter = new DeepSeekWebAdapter({ broker, ...options });
  ctx.llm.registerAdapter([DEEPSEEK_WEB_PROVIDER], adapter);
  return adapter;
}
