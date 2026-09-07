// src/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import {
  DeepSeekWebModelHost
} from "@deepseek-pp/dsh-web-model-transport";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web";
var DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN";
var DEFAULT_DEEPSEEK_WEB_BROKER_PORT = 43123;
var DeepSeekWebOfficialSettings = z.object({
  browser: z.union(["chrome", "edge", "firefox"]).default("chrome"),
  chromiumExtensionId: z.string().default(""),
  firefoxExtensionOrigin: z.string().default(""),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_DEEPSEEK_WEB_BROKER_PORT),
  makeDefaultForNewSessions: z.boolean().default(false)
});
function validateOfficialSettings(value) {
  if (value.browser === "firefox") {
    if (value.firefoxExtensionOrigin !== "" && !/^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value.firefoxExtensionOrigin)) {
      throw new Error("firefoxExtensionOrigin must be a complete moz-extension:// origin");
    }
    return;
  }
  if (value.chromiumExtensionId !== "" && !/^[a-p]{32}$/u.test(value.chromiumExtensionId)) {
    throw new Error("chromiumExtensionId must be a 32-character Chrome/Edge extension ID");
  }
}
function extensionOrigin(value) {
  if (value.browser === "firefox") return value.firefoxExtensionOrigin || void 0;
  return value.chromiumExtensionId === "" ? void 0 : `chrome-extension://${value.chromiumExtensionId}`;
}

// src/managed-broker.ts
import {
  BrokerError
} from "@deepseek-pp/dsh-web-model-transport";
var ManagedDeepSeekWebBroker = class {
  delegate;
  attach(delegate) {
    if (this.delegate !== void 0) throw new Error("DEEPSEEK_WEB_BROKER_ALREADY_ATTACHED");
    this.delegate = delegate;
  }
  detach(delegate) {
    if (this.delegate === delegate) this.delegate = void 0;
  }
  async *generate(request) {
    const delegate = this.available();
    yield* delegate.generate(request);
  }
  cancel(request) {
    return this.available().cancel(request);
  }
  query(request) {
    return this.available().query(request);
  }
  available() {
    if (this.delegate === void 0) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.delegate;
  }
};

// src/index.ts
var name = "deepseek-web-official";
var inject = ["settings", "credentials"];
async function apply(ctx) {
  const settings = ctx.settings.register(
    DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    DeepSeekWebOfficialSettings,
    { applies: "restart", validate: validateOfficialSettings }
  );
  const broker = new ManagedDeepSeekWebBroker();
  const unprovide = ctx.provide("deepseekWebBroker", broker);
  let host;
  try {
    const current = settings.get();
    const origin = extensionOrigin(current);
    if (origin !== void 0) {
      const credential = await ctx.credentials.resolve(credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF));
      if (credential !== void 0) {
        host = new DeepSeekWebModelHost({
          pairingToken: credential.value,
          allowedOrigins: [origin],
          port: current.port,
          journalPath: dshHomePath("profiles", "web", "deepseek-web-model-journal")
        });
        await host.start();
        broker.attach(host);
      }
    }
  } catch (error) {
    const cleanupFailures = [];
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
        "DeepSeek Web official plugin startup cleanup failed"
      );
    }
    throw error;
  }
  return async () => {
    if (host !== void 0) broker.detach(host);
    let serviceFailure;
    try {
      await unprovide();
    } catch (error) {
      serviceFailure = error;
    }
    try {
      await host?.stop();
    } catch (error) {
      if (serviceFailure !== void 0) {
        throw new AggregateError([serviceFailure, error], "DeepSeek Web official plugin disposal failed");
      }
      throw error;
    }
    if (serviceFailure !== void 0) throw serviceFailure;
  };
}
export {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  DEFAULT_DEEPSEEK_WEB_BROKER_PORT,
  DeepSeekWebOfficialSettings,
  ManagedDeepSeekWebBroker,
  apply,
  extensionOrigin,
  inject,
  name,
  validateOfficialSettings
};
