import z from "@deepseek-ai/schemastery";

import {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  type BrowserKind,
  type DeepSeekWebOfficialSettings as DeepSeekWebOfficialSettingsValue,
} from "./connection-contract.ts";

export {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
};
export type DeepSeekWebOfficialSettings = DeepSeekWebOfficialSettingsValue;
export type { BrowserKind };
export const DEFAULT_DEEPSEEK_WEB_BROKER_PORT = 43_123;

export const DeepSeekWebOfficialSettings: z<DeepSeekWebOfficialSettings> = z.object({
  browser: z.union(["chrome", "edge", "firefox"]).default("chrome"),
  chromiumExtensionId: z.string().default(""),
  firefoxExtensionOrigin: z.string().default(""),
  port: z.number().step(1).min(1).max(65_535).default(DEFAULT_DEEPSEEK_WEB_BROKER_PORT),
  webModelMode: z.union(["default", "expert"]).default("default"),
  thinkingEnabled: z.boolean().default(false),
  makeDefaultForNewSessions: z.boolean().default(false),
  windowsCommandsEnabled: z.boolean().default(false),
  windowsApprovalPolicy: z.union(["ask", "auto"]).default("ask"),
  powerShellExecutable: z.string().default(""),
});

export function validateOfficialSettings(value: DeepSeekWebOfficialSettings): void {
  if (value.powerShellExecutable.includes("\0") || value.powerShellExecutable.length > 1_024) {
    throw new Error("powerShellExecutable must be at most 1024 characters and contain no NUL byte");
  }
  if (value.browser === "firefox") {
    if (value.firefoxExtensionOrigin !== "" &&
      !/^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value.firefoxExtensionOrigin)) {
      throw new Error("firefoxExtensionOrigin must be a complete moz-extension:// origin");
    }
    return;
  }
  if (value.chromiumExtensionId !== "" && !/^[a-p]{32}$/u.test(value.chromiumExtensionId)) {
    throw new Error("chromiumExtensionId must be a 32-character Chrome/Edge extension ID");
  }
}

export function extensionOrigin(value: DeepSeekWebOfficialSettings): string | undefined {
  if (value.browser === "firefox") return value.firefoxExtensionOrigin || undefined;
  return value.chromiumExtensionId === "" ? undefined : `chrome-extension://${value.chromiumExtensionId}`;
}
