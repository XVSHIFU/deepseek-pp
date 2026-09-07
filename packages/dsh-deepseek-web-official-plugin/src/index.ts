import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-settings";
import {
  DeepSeekWebModelHost,
  type DeepSeekWebBroker,
} from "@deepseek-pp/dsh-web-model-transport";

import {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  DeepSeekWebOfficialSettings,
  extensionOrigin,
  validateOfficialSettings,
} from "./config.ts";
import { ManagedDeepSeekWebBroker } from "./managed-broker.ts";

export * from "./config.ts";
export * from "./managed-broker.ts";

export const name = "deepseek-web-official";
export const inject = ["settings", "credentials"] as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebBroker: DeepSeekWebBroker;
  }
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const settings = ctx.settings.register(
    DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    DeepSeekWebOfficialSettings,
    { applies: "restart", validate: validateOfficialSettings },
  );
  const broker = new ManagedDeepSeekWebBroker();
  const unprovide = ctx.provide("deepseekWebBroker", broker);
  let host: DeepSeekWebModelHost | undefined;

  try {
    const current = settings.get();
    const origin = extensionOrigin(current);
    if (origin !== undefined) {
      const credential = await ctx.credentials.resolve(credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF));
      if (credential !== undefined) {
        host = new DeepSeekWebModelHost({
          pairingToken: credential.value,
          allowedOrigins: [origin],
          port: current.port,
          journalPath: dshHomePath("profiles", "web", "deepseek-web-model-journal"),
        });
        await host.start();
        broker.attach(host);
      }
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await unprovide();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await host?.stop();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "DeepSeek Web official plugin startup cleanup failed",
      );
    }
    throw error;
  }

  return async () => {
    if (host !== undefined) broker.detach(host);
    let serviceFailure: unknown;
    try {
      await unprovide();
    } catch (error) {
      serviceFailure = error;
    }
    try {
      await host?.stop();
    } catch (error) {
      if (serviceFailure !== undefined) {
        throw new AggregateError([serviceFailure, error], "DeepSeek Web official plugin disposal failed");
      }
      throw error;
    }
    if (serviceFailure !== undefined) throw serviceFailure;
  };
}
