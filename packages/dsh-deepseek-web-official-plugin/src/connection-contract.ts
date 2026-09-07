/** Client-safe contract for the official DeepSeek Web plugin. */

export const DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web" as const;
export const DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN" as const;
export const DEEPSEEK_WEB_PROVIDER = "deepseek-web" as const;
export const DEEPSEEK_WEB_MODEL = "current-web-session" as const;
export const DEEPSEEK_WEB_CONNECTION_NAMESPACE = "deepseekWebConnection" as const;

export type BrowserKind = "chrome" | "edge" | "firefox";

export interface DeepSeekWebOfficialSettings {
  readonly browser: BrowserKind;
  readonly chromiumExtensionId: string;
  readonly firefoxExtensionOrigin: string;
  readonly port: number;
  readonly makeDefaultForNewSessions: boolean;
  readonly windowsCommandsEnabled: boolean;
  readonly windowsApprovalPolicy: "ask" | "auto";
  readonly powerShellExecutable: string;
}

export type DeepSeekWebWindowsStatus =
  | { readonly kind: "disabled" }
  | { readonly kind: "available"; readonly executable: string; readonly major: number }
  | { readonly kind: "unavailable"; readonly code: "POWERSHELL_7_REQUIRED"; readonly message: string };

export type DeepSeekWebConnectionPhase =
  | "unconfigured"
  | "waiting_for_browser"
  | "connected"
  | "busy"
  | "error";

/** Deliberately contains presence facts only; a pairing token has no read path. */
export interface DeepSeekWebConnectionStatus {
  readonly phase: DeepSeekWebConnectionPhase;
  readonly configured: boolean;
  readonly tokenConfigured: boolean;
  readonly originConfigured: boolean;
  readonly busy: boolean;
  readonly pendingReconfigure: boolean;
  readonly browser: BrowserKind;
  readonly port: number;
  readonly windows: DeepSeekWebWindowsStatus;
  readonly errorCode?: "CONNECTION_START_FAILED";
}

export interface DeepSeekWebReconnectReceipt {
  readonly accepted: boolean;
  readonly deferred: boolean;
  readonly reason?: "busy" | "unconfigured";
  readonly status: DeepSeekWebConnectionStatus;
}

/** Generated-equivalent contribution mounted explicitly by this out-of-tree client. */
export const DEEPSEEK_WEB_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze(["status", "reconnect"].map((method) => Object.freeze({
    id: `@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebConnection/${method}`,
    service: "deepseekWebConnection",
    namespace: DEEPSEEK_WEB_CONNECTION_NAMESPACE,
    method,
    invocation: Object.freeze({ kind: "direct" as const }),
    parameters: Object.freeze([]),
    result: Object.freeze({ mode: "src-json" as const }),
  }))),
});
