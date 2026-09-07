import z from "@deepseek-ai/schemastery";

export const DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web" as const;
export const DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN" as const;
export const DEFAULT_DEEPSEEK_WEB_BROKER_PORT = 43_123;

export type BrowserKind = "chrome" | "edge" | "firefox";

export interface DeepSeekWebOfficialSettings {
  readonly browser: BrowserKind;
  readonly chromiumExtensionId: string;
  readonly firefoxExtensionOrigin: string;
  readonly port: number;
  readonly makeDefaultForNewSessions: boolean;
}

export const DeepSeekWebOfficialSettings: z<DeepSeekWebOfficialSettings> = z.object({
  browser: z.union(["chrome", "edge", "firefox"]).default("chrome"),
  chromiumExtensionId: z.string().default(""),
  firefoxExtensionOrigin: z.string().default(""),
  port: z.number().step(1).min(1).max(65_535).default(DEFAULT_DEEPSEEK_WEB_BROKER_PORT),
  makeDefaultForNewSessions: z.boolean().default(false),
});

export function validateOfficialSettings(value: DeepSeekWebOfficialSettings): void {
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
