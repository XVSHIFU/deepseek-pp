import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-settings";
import { registerDeepSeekWebAdapter } from "@deepseek-pp/dsh-llm-deepseek-web";
import type { DeepSeekWebBroker } from "@deepseek-pp/dsh-web-model-transport";

import {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  type DeepSeekWebOfficialSettings as DeepSeekWebSettingsValue,
  DeepSeekWebOfficialSettings,
  validateOfficialSettings,
} from "./config.ts";
import {
  DEEPSEEK_WEB_MODEL,
  DEEPSEEK_WEB_PROVIDER,
} from "./connection-contract.ts";
import {
  DeepSeekWebConnectionController,
  createDeepSeekWebModelHost,
} from "./connection-controller.ts";
import { DeepSeekWebConnectionRemote } from "./connection-remote.ts";
import { DeepSeekWebSessionImportRemote } from "./session-import-remote.ts";
import {
  installWindowsPowerShellPolicy,
  JsonWindowsSessionPolicyStore,
  type WindowsPowerShellAvailability,
} from "./windows-powershell.ts";

export * from "./config.ts";
export * from "./connection-controller.ts";
export * from "./connection-remote.ts";
export * from "./managed-broker.ts";
export * from "./windows-powershell.ts";

export const name = "deepseek-web-official";
export const inject = ["settings", "credentials", "agentDefaultModel", "llm", "tools", "subprocess", "shell", "deepseekWebSessionImport"] as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebBroker: DeepSeekWebBroker;
  }
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const settings = ctx.settings.register(
    DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    DeepSeekWebOfficialSettings,
    { applies: "live", validate: validateOfficialSettings },
  );
  await applyPowerShellExecutable(ctx, settings.get().powerShellExecutable, false).catch((error) => {
    ctx.logger.warn("DeepSeek Web could not apply the PowerShell executable setting");
    ctx.logger.warn(error);
  });
  const windowsPolicy = await installWindowsPowerShellPolicy(
    ctx,
    windowsConfig(settings.get()),
    new JsonWindowsSessionPolicyStore(
      dshHomePath("profiles", "web", "deepseek-web-official", "windows-session-policies.json"),
    ),
    () => windowsConfig(settings.get()),
    () => settings.get().powerShellExecutable,
    (sessionId) => ctx.deepseekWebSessionImport.isImportedSessionDenied(sessionId),
  );
  const connection = new DeepSeekWebConnectionController({
    readSettings: () => settings.get(),
    resolvePairingToken: async () =>
      (await ctx.credentials.resolve(credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF)))?.value,
    createHost: (options) => createDeepSeekWebModelHost({
      ...options,
      journalPath: dshHomePath("profiles", "web", "deepseek-web-model-journal"),
    }),
    readWindowsStatus: () => projectWindowsStatus(windowsPolicy.status),
    reportError: (error) => {
      ctx.logger.warn("DeepSeek Web connection reconfiguration failed");
      ctx.logger.warn(error);
    },
  });
  const unprovide = ctx.provide("deepseekWebBroker", connection.broker);
  // Keep the final plugin tarball independent from private workspace package
  // installation. The Host bundle embeds the adapter/transport/protocol and
  // registers the adapter in the same Cordis lifecycle as its broker.
  registerDeepSeekWebAdapter(ctx, connection.broker);
  new DeepSeekWebConnectionRemote(ctx, connection);
  new DeepSeekWebSessionImportRemote(ctx, ctx.deepseekWebSessionImport);
  const stopWatchingSettings = settings.watch(async (next, previous) => {
    if (connectionSettingsChanged(next, previous)) await connection.requestReconfigure("settings");
    if (next.powerShellExecutable !== previous.powerShellExecutable) {
      await applyPowerShellExecutable(ctx, next.powerShellExecutable, true);
    }
    if (windowsSettingsChanged(next, previous)) await windowsPolicy.update(windowsConfig(next));
    if (next.makeDefaultForNewSessions && !previous.makeDefaultForNewSessions) {
      await applyRequestedDefault(ctx, next, () => settings.update({ makeDefaultForNewSessions: false }));
    }
  });
  const stopWatchingCredential = ctx.on("credentials/reference-updated", (ref) => {
    if (ref === credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF)) {
      return connection.requestReconfigure("credential").then(() => undefined);
    }
  });

  try {
    await connection.start();
    await applyRequestedDefault(ctx, settings.get(), () => settings.update({ makeDefaultForNewSessions: false }));
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    stopWatchingCredential();
    stopWatchingSettings();
    try {
      await unprovide();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await connection.dispose();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await windowsPolicy.flush();
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
    stopWatchingCredential();
    stopWatchingSettings();
    const failures: unknown[] = [];
    try {
      await unprovide();
    } catch (error) {
      failures.push(error);
    }
    try {
      await connection.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await windowsPolicy.flush();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DeepSeek Web official plugin disposal failed");
  };
}

function windowsConfig(settings: DeepSeekWebSettingsValue) {
  return {
    enabled: settings.windowsCommandsEnabled,
    approvalPolicy: settings.windowsApprovalPolicy,
  } as const;
}

function connectionSettingsChanged(left: DeepSeekWebSettingsValue, right: DeepSeekWebSettingsValue): boolean {
  return left.browser !== right.browser || left.chromiumExtensionId !== right.chromiumExtensionId ||
    left.firefoxExtensionOrigin !== right.firefoxExtensionOrigin || left.port !== right.port;
}

function windowsSettingsChanged(left: DeepSeekWebSettingsValue, right: DeepSeekWebSettingsValue): boolean {
  return left.windowsCommandsEnabled !== right.windowsCommandsEnabled ||
    left.windowsApprovalPolicy !== right.windowsApprovalPolicy ||
    left.powerShellExecutable !== right.powerShellExecutable;
}

async function applyPowerShellExecutable(ctx: Context, input: string, clearWhenEmpty: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const executable = input.trim();
  const current = ctx.get("shell") as { readonly pwshPath?: unknown } | undefined;
  if (executable !== "" && current?.pwshPath === executable) return;
  if (executable === "" && !clearWhenEmpty) return;
  if (executable === "") {
    await ctx.settings.mutate("shell", [{ op: "unset", path: ["pwshPath"] }]);
    return;
  }
  await ctx.settings.update("shell", { pwshPath: executable });
}

function projectWindowsStatus(status: WindowsPowerShellAvailability) {
  if (status.kind === "available") {
    return { kind: "available" as const, executable: status.powershell.executable, major: status.powershell.major };
  }
  if (status.kind === "unavailable") {
    return { kind: "unavailable" as const, code: status.code, message: status.message };
  }
  return { kind: "disabled" as const };
}

/** Uses the official future-Agent default authority; it never mutates a live session. */
export async function applyRequestedDefault(
  ctx: Context,
  settings: DeepSeekWebSettingsValue,
  consume?: () => Promise<void>,
): Promise<void> {
  if (!settings.makeDefaultForNewSessions) return;
  const authority = ctx.get("agentDefaultModel");
  if (authority === undefined) throw new Error("DEEPSEEK_WEB_DEFAULT_MODEL_AUTHORITY_UNAVAILABLE");
  await authority.saveSelection({
    provider: DEEPSEEK_WEB_PROVIDER,
    model: DEEPSEEK_WEB_MODEL,
  });
  await consume?.();
}
