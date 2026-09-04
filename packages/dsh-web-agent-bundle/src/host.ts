import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  DeepSeekWebModelHost,
  type DeepSeekWebBroker,
} from "@deepseek-pp/dsh-web-model-transport";

export const name = "deepseek-web-model-host";

export interface Config {
  readonly pairingToken: string;
  readonly allowedExtensionOrigins: string[];
  readonly port?: number;
}

export const Config: z<Config> = z.object({
  pairingToken: z.string().role("secret").required(),
  allowedExtensionOrigins: z.array(z.string()).min(1).required(),
  port: z.number().step(1).min(1).max(65_535).default(43_123),
});

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebBroker: DeepSeekWebBroker;
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const host = new DeepSeekWebModelHost({
    pairingToken: config.pairingToken,
    allowedOrigins: config.allowedExtensionOrigins,
    ...(config.port === undefined ? {} : { port: config.port }),
  });
  await host.start();
  let unprovide: ReturnType<Context["provide"]> | undefined;
  try {
    unprovide = ctx.provide("deepseekWebBroker", host);
  } catch (error) {
    await host.stop();
    throw error;
  }
  return async () => {
    let unprovideFailure: unknown;
    try {
      await unprovide?.();
    } catch (error) {
      unprovideFailure = error;
    }
    try {
      await host.stop();
    } catch (stopFailure) {
      if (unprovideFailure !== undefined) {
        throw new AggregateError([unprovideFailure, stopFailure], "DeepSeek Web Host disposal failed");
      }
      throw stopFailure;
    }
    if (unprovideFailure !== undefined) throw unprovideFailure;
  };
}
