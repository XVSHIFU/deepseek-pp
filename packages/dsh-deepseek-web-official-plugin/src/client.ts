import type { Context } from "@deepseek-ai/cordis";
import React from "react";

import {
  DEEPSEEK_WEB_CONNECTION_NAMESPACE,
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_REMOTE_CONTRIBUTION,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  type DeepSeekWebConnectionStatus,
  type DeepSeekWebOfficialSettings,
  type DeepSeekWebReconnectReceipt,
} from "./connection-contract.ts";
import {
  DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE,
  DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION,
  type CompletedSessionImportReceipt,
  type CompletedSessionImportRequest,
} from "./session-import-contract.ts";

export const inject = ["slots", "settingsScope", "remote"] as const;

/** Remote packages are unique in the browser loader, so mount all plugin descriptors together. */
export const DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION = Object.freeze({
  package: DEEPSEEK_WEB_REMOTE_CONTRIBUTION.package,
  descriptors: Object.freeze([
    ...DEEPSEEK_WEB_REMOTE_CONTRIBUTION.descriptors,
    ...DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION.descriptors,
  ]),
});

interface RemoteResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly message: string };
}

interface CredentialView {
  readonly configured: boolean;
  readonly source?: string;
  readonly writable: boolean;
}

interface ClientSettingsSnapshot<T> {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value: T | undefined;
  readonly revision?: number;
  readonly writable: boolean;
}

interface ClientSettingsScope<T> {
  getSnapshot(): ClientSettingsSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
}

interface SettingsPathOp {
  readonly op: "set" | "unset";
  readonly path: readonly string[];
  readonly value?: unknown;
}

export interface DeepSeekWebSettingsDraft {
  readonly browser: string;
  readonly chromiumExtensionId: string;
  readonly firefoxExtensionOrigin: string;
  readonly port: string;
  readonly makeDefaultForNewSessions: boolean;
  readonly windowsCommandsEnabled: boolean;
  readonly windowsApprovalPolicy: "ask" | "auto";
  readonly powerShellExecutable: string;
}

export interface DeepSeekWebClientSnapshot {
  readonly settings: ClientSettingsSnapshot<DeepSeekWebOfficialSettings>;
  readonly credential: CredentialView;
  readonly connection: DeepSeekWebConnectionStatus | undefined;
  readonly draft: DeepSeekWebSettingsDraft | undefined;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  readonly invalid: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface DeepSeekWebClientControllerOptions {
  readonly settings: ClientSettingsScope<DeepSeekWebOfficialSettings>;
  readonly credentials: {
    describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialView>>>;
    set(ref: string, value: string): Promise<RemoteResult<void>>;
  };
  readonly callConnection: (method: "status" | "reconnect") =>
    Promise<RemoteResult<DeepSeekWebConnectionStatus | DeepSeekWebReconnectReceipt>>;
  readonly importCompleted?: (request: CompletedSessionImportRequest) =>
    Promise<RemoteResult<CompletedSessionImportReceipt>>;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** Client-side view model. Pairing literals are action results, never snapshot state. */
export class DeepSeekWebClientController {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeSettings: () => void;
  private credential: CredentialView = { configured: false, writable: true };
  private connection: DeepSeekWebConnectionStatus | undefined;
  private loading = false;
  private error: string | null = null;
  private refreshGeneration = 0;
  private disposed = false;
  private readonly staged = new Map<keyof DeepSeekWebOfficialSettings, unknown>();
  private draftRevision: number | undefined;
  private savingSettings = false;
  private settingsConflict = false;
  private snapshotValue: DeepSeekWebClientSnapshot;
  private readonly statusTimer: ReturnType<typeof setInterval>;
  private statusRequestActive = false;

  constructor(private readonly options: DeepSeekWebClientControllerOptions) {
    this.snapshotValue = this.snapshot();
    this.unsubscribeSettings = options.settings.subscribe(() => {
      if (!this.savingSettings && this.staged.size > 0 &&
          options.settings.getSnapshot().revision !== this.draftRevision) {
        if (this.stagedValuesLanded()) this.clearSettingsDraft();
        else this.settingsConflict = true;
      }
      this.publish();
      void this.refreshConnection();
    });
    this.statusTimer = setInterval(() => { void this.refreshConnection(); }, 1_000);
    if (typeof this.statusTimer === "object" && "unref" in this.statusTimer) this.statusTimer.unref();
  }

  getSnapshot = (): DeepSeekWebClientSnapshot => this.snapshotValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    if (this.statusRequestActive || this.disposed) return;
    this.statusRequestActive = true;
    const generation = ++this.refreshGeneration;
    this.loading = true;
    this.error = null;
    this.publish();
    try {
      const [credential, connection] = await Promise.all([
        this.options.credentials.describe([DEEPSEEK_WEB_PAIRING_TOKEN_REF]),
        this.options.callConnection("status"),
      ]);
      if (generation !== this.refreshGeneration) return;
      if (!credential.ok || credential.value === undefined) {
        this.error = credential.error?.message ?? "Credential status is unavailable.";
      } else {
        this.credential = projectCredential(credential.value[DEEPSEEK_WEB_PAIRING_TOKEN_REF]);
      }
      if (!connection.ok || connection.value === undefined) {
        this.error ??= connection.error?.message ?? "Connection status is unavailable.";
      } else {
        this.connection = parseConnectionStatus(connection.value);
      }
      this.loading = false;
      this.publish();
    } catch (error) {
      if (generation === this.refreshGeneration) {
        this.loading = false;
        this.error = error instanceof Error ? error.message : "Connection status is unavailable.";
        this.publish();
      }
    } finally {
      this.statusRequestActive = false;
    }
  }

  editSetting(field: keyof DeepSeekWebOfficialSettings, value: unknown): void {
    if (this.staged.size === 0) this.draftRevision = this.options.settings.getSnapshot().revision;
    this.staged.set(field, value);
    this.error = null;
    this.publish();
  }

  discardSettings(): void {
    this.clearSettingsDraft();
    this.error = null;
    this.publish();
  }

  async saveSettings(): Promise<void> {
    if (this.staged.size === 0) return;
    const draft = this.draft();
    if (draft === undefined || !validDraft(draft)) this.fail(undefined, "Connection settings are invalid.");
    if (this.settingsConflict || this.options.settings.getSnapshot().revision !== this.draftRevision) {
      this.settingsConflict = true;
      this.fail(undefined, "Settings changed in another client. Discard this draft before editing again.");
    }
    const values: DeepSeekWebOfficialSettings = {
      browser: draft.browser as DeepSeekWebOfficialSettings["browser"],
      chromiumExtensionId: draft.chromiumExtensionId,
      firefoxExtensionOrigin: draft.firefoxExtensionOrigin,
      port: Number(draft.port),
      makeDefaultForNewSessions: draft.makeDefaultForNewSessions,
      windowsCommandsEnabled: draft.windowsCommandsEnabled,
      windowsApprovalPolicy: draft.windowsApprovalPolicy,
      powerShellExecutable: draft.powerShellExecutable,
    };
    const ops = [...this.staged.keys()].map((field): SettingsPathOp => ({
      op: "set",
      path: [field],
      value: values[field],
    }));
    this.savingSettings = true;
    try {
      await this.options.settings.mutate(ops, this.draftRevision);
      this.savingSettings = false;
      if (!this.stagedValuesLanded()) {
        if (this.options.settings.getSnapshot().revision !== this.draftRevision) {
          this.settingsConflict = true;
          this.fail(undefined, "Settings changed in another client. Discard this draft before editing again.");
        }
        this.fail(undefined, "Settings were not saved.");
      }
      this.clearSettingsDraft();
      this.error = null;
      this.publish();
    } catch (error) {
      this.savingSettings = false;
      if (this.options.settings.getSnapshot().revision !== this.draftRevision && !this.stagedValuesLanded()) {
        this.settingsConflict = true;
        this.fail(undefined, "Settings changed in another client. Discard this draft before editing again.");
      }
      this.fail(error, "Settings were not saved.");
    }
  }

  async reconnect(): Promise<DeepSeekWebReconnectReceipt> {
    const response = await this.options.callConnection("reconnect");
    if (!response.ok || response.value === undefined) {
      this.fail(response.error?.message, "Reconnect was refused.");
    }
    const receipt = parseReconnectReceipt(response.value);
    this.connection = receipt.status;
    this.publish();
    return receipt;
  }

  async importCompleted(request: CompletedSessionImportRequest): Promise<CompletedSessionImportReceipt> {
    if (this.options.importCompleted === undefined) this.fail(undefined, "Session import is unavailable.");
    const response = await this.options.importCompleted(request);
    if (!response.ok || response.value === undefined) {
      this.fail(response.error?.message, "Session import failed.");
    }
    return response.value;
  }

  async pair(): Promise<string> {
    return this.replacePairingToken();
  }

  async rePair(): Promise<string> {
    return this.replacePairingToken();
  }

  dispose(): void {
    this.disposed = true;
    this.refreshGeneration += 1;
    clearInterval(this.statusTimer);
    this.unsubscribeSettings();
    this.listeners.clear();
  }

  private async replacePairingToken(): Promise<string> {
    const token = pairingToken(this.options.randomBytes ?? secureRandomBytes);
    const stored = await this.options.credentials.set(DEEPSEEK_WEB_PAIRING_TOKEN_REF, token);
    if (!stored.ok) this.fail(stored.error?.message, "Pairing token was not stored.");
    this.credential = { configured: true, writable: this.credential.writable };
    try {
      const receipt = await this.reconnect();
      this.connection = receipt.status;
    } catch (error) {
      this.error = `Pairing token was stored, but reconnect failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.publish();
    return token;
  }

  private async refreshConnection(): Promise<void> {
    if (this.statusRequestActive || this.disposed) return;
    this.statusRequestActive = true;
    const generation = ++this.refreshGeneration;
    try {
      const response = await this.options.callConnection("status");
      if (this.disposed || generation !== this.refreshGeneration) return;
      if (!response.ok || response.value === undefined) return;
      const next = parseConnectionStatus(response.value);
      if (sameConnectionStatus(next, this.connection)) return;
      this.connection = next;
      this.publish();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Connection status is unavailable.";
      this.publish();
    } finally {
      this.statusRequestActive = false;
    }
  }

  private publish(): void {
    if (this.disposed) return;
    this.snapshotValue = this.snapshot();
    for (const listener of this.listeners) listener();
  }

  private snapshot(): DeepSeekWebClientSnapshot {
    const draft = this.draft();
    return {
      settings: this.options.settings.getSnapshot(),
      credential: this.credential,
      connection: this.connection,
      draft,
      dirty: this.staged.size > 0,
      conflicted: this.settingsConflict,
      invalid: draft !== undefined && !validDraft(draft),
      loading: this.loading,
      error: this.error,
    };
  }

  private draft(): DeepSeekWebSettingsDraft | undefined {
    const current = this.options.settings.getSnapshot().value;
    if (current === undefined) return undefined;
    const read = <Key extends keyof DeepSeekWebOfficialSettings>(key: Key): unknown =>
      this.staged.has(key) ? this.staged.get(key) : current[key];
    return {
      browser: String(read("browser")),
      chromiumExtensionId: String(read("chromiumExtensionId")),
      firefoxExtensionOrigin: String(read("firefoxExtensionOrigin")),
      port: String(read("port")),
      makeDefaultForNewSessions: read("makeDefaultForNewSessions") === true,
      windowsCommandsEnabled: read("windowsCommandsEnabled") === true,
      windowsApprovalPolicy: read("windowsApprovalPolicy") === "auto" ? "auto" : "ask",
      powerShellExecutable: String(read("powerShellExecutable")),
    };
  }

  private stagedValuesLanded(): boolean {
    const current = this.options.settings.getSnapshot().value;
    if (current === undefined) return false;
    for (const [field, value] of this.staged) {
      if (!Object.is(current[field], normalizedSettingValue(field, value))) return false;
    }
    return true;
  }

  private clearSettingsDraft(): void {
    this.staged.clear();
    this.draftRevision = undefined;
    this.settingsConflict = false;
  }

  private fail(error: unknown, fallback: string): never {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : fallback;
    this.error = message;
    this.publish();
    throw new Error(message, error instanceof Error ? { cause: error } : undefined);
  }
}

function DeepSeekWebSettingsCard({ controller }: { readonly controller: DeepSeekWebClientController }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [pairingTokenValue, setPairingTokenValue] = React.useState<string | null>(null);
  const [importSourceHome, setImportSourceHome] = React.useState("");
  const [importRootSessionId, setImportRootSessionId] = React.useState("");
  const [sourceProcessesStopped, setSourceProcessesStopped] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importStatus, setImportStatus] = React.useState<string | null>(null);
  React.useEffect(() => {
    void controller.refresh();
  }, [controller]);
  const settings = snapshot.draft;
  if (settings === undefined) {
    return React.createElement("section", cardProps(), "DeepSeek Web settings are unavailable.");
  }
  const disabled = !snapshot.settings.writable;
  const field = (label: string, input: React.ReactElement): React.ReactElement =>
    React.createElement("label", { style: fieldStyle }, label, input);
  const update = (name: keyof DeepSeekWebOfficialSettings, value: unknown): void => controller.editSetting(name, value);
  const createToken = (replace: boolean): void => {
    void (replace ? controller.rePair() : controller.pair()).then(setPairingTokenValue);
  };
  return React.createElement(
    "section",
    cardProps(),
    React.createElement("h3", { style: { marginTop: 0 } }, "DeepSeek Web"),
    React.createElement("p", null, snapshot.connection === undefined
      ? "Connection status unavailable"
      : `Connection: ${snapshot.connection.phase}${snapshot.connection.pendingReconfigure ? " (change pending)" : ""}`),
    field("Browser", React.createElement("select", {
      value: settings.browser,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => update("browser", event.currentTarget.value),
    }, React.createElement("option", { value: "chrome" }, "Chrome"),
    React.createElement("option", { value: "edge" }, "Edge"),
    React.createElement("option", { value: "firefox" }, "Firefox"))),
    settings.browser === "firefox"
      ? field("Firefox extension origin", React.createElement("input", {
        value: settings.firefoxExtensionOrigin,
        disabled,
        placeholder: "moz-extension://…",
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("firefoxExtensionOrigin", event.currentTarget.value),
      }))
      : field("Chrome/Edge extension ID", React.createElement("input", {
        value: settings.chromiumExtensionId,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("chromiumExtensionId", event.currentTarget.value),
      })),
    field("Loopback port", React.createElement("input", {
      type: "number", min: 1, max: 65_535, value: settings.port, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("port", event.currentTarget.value),
    })),
    field("Set DeepSeek Web as the default for future new sessions", React.createElement("input", {
      type: "checkbox", checked: settings.makeDefaultForNewSessions, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("makeDefaultForNewSessions", event.currentTarget.checked),
    })),
    React.createElement("h4", null, "Windows PowerShell 7"),
    React.createElement("p", null, windowsStatusText(snapshot.connection)),
    field("Enable native Windows commands for new sessions", React.createElement("input", {
      type: "checkbox", checked: settings.windowsCommandsEnabled, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("windowsCommandsEnabled", event.currentTarget.checked),
    })),
    field("Default approval for new sessions", React.createElement("select", {
      value: settings.windowsApprovalPolicy,
      disabled: disabled || !settings.windowsCommandsEnabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => update("windowsApprovalPolicy", event.currentTarget.value),
    }, React.createElement("option", { value: "ask" }, "Ask for every command"),
    React.createElement("option", { value: "auto" }, "Run automatically (explicit opt-in)"))),
    React.createElement("p", null,
      "Commands run as the current Windows user; cwd is not a sandbox."),
    field("PowerShell 7 executable", React.createElement("input", {
      value: settings.powerShellExecutable,
      disabled,
      placeholder: "pwsh or C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("powerShellExecutable", event.currentTarget.value),
    })),
    React.createElement("button", {
      type: "button", disabled: disabled || !snapshot.dirty || snapshot.invalid || snapshot.conflicted,
      onClick: () => { void controller.saveSettings().catch(() => undefined); },
    }, "Save settings"),
    React.createElement("button", {
      type: "button", disabled: !snapshot.dirty, onClick: () => controller.discardSettings(),
    }, "Discard"),
    snapshot.conflicted ? React.createElement("p", { role: "status" },
      "Settings changed in another client. Discard this draft before editing again.") : null,
    React.createElement("p", null, snapshot.credential.configured ? "Pairing token configured" : "No pairing token configured"),
    React.createElement("button", { type: "button", disabled: !snapshot.credential.writable || snapshot.credential.configured, onClick: () => createToken(false) }, "Generate pairing token"),
    React.createElement("button", { type: "button", disabled: !snapshot.credential.writable, onClick: () => createToken(true) }, "Re-pair"),
    React.createElement("button", { type: "button", onClick: () => { void controller.reconnect(); } }, "Reconnect"),
    pairingTokenValue === null ? null : React.createElement("div", null,
      React.createElement("output", { "aria-label": "New pairing token" }, pairingTokenValue),
      React.createElement("button", { type: "button", onClick: () => { void globalThis.navigator?.clipboard?.writeText(pairingTokenValue); } }, "Copy"),
      React.createElement("p", null, "Copy this token now. It cannot be read back later.")),
    React.createElement("h4", null, "Import completed standalone session"),
    React.createElement("p", null,
      "The completed root and its completed child sessions are validated and committed as one group. Source records are retained; imported sessions never inherit Windows command permission."),
    field("Old DeepSeek Web Agent installation directory", React.createElement("input", {
      value: importSourceHome,
      disabled: importing,
      placeholder: "C:\\Users\\you\\AppData\\Local\\DeepSeekWebAgent",
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportSourceHome(event.currentTarget.value),
    })),
    field("Completed root session ID", React.createElement("input", {
      value: importRootSessionId,
      disabled: importing,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportRootSessionId(event.currentTarget.value),
    })),
    field("I have stopped every process using the old installation", React.createElement("input", {
      type: "checkbox",
      checked: sourceProcessesStopped,
      disabled: importing,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSourceProcessesStopped(event.currentTarget.checked),
    })),
    React.createElement("button", {
      type: "button",
      disabled: importing || !sourceProcessesStopped || importSourceHome.trim() === "" || importRootSessionId.trim() === "",
      onClick: () => {
        setImporting(true);
        setImportStatus(null);
        void controller.importCompleted({
          sourceHome: importSourceHome.trim(),
          rootSessionId: importRootSessionId.trim(),
          sourceProcessesStopped: true,
        }).then((receipt) => {
          setImportStatus(`Imported ${receipt.imported}; already identical ${receipt.idempotent}.`);
        }, (error: unknown) => {
          setImportStatus(error instanceof Error ? error.message : "Session import failed.");
        }).finally(() => setImporting(false));
      },
    }, importing ? "Importing…" : "Import completed session"),
    importStatus === null ? null : React.createElement("p", { role: "status" }, importStatus),
    snapshot.error === null ? null : React.createElement("p", { role: "alert" }, snapshot.error),
  );
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const client = ctx as Context & ClientContext;
  const unmountRemote = await client.remote.$mount(DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION);
  client.slots.inject("settings.plugin.item", () => {
    const settings = client.settingsScope.bind<DeepSeekWebOfficialSettings>({
      namespace: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
      decode: decodeSettings,
    });
    const controller = new DeepSeekWebClientController({
      settings,
      credentials: client.remote.credentials,
      callConnection: (method) => client.remote[DEEPSEEK_WEB_CONNECTION_NAMESPACE][method]() as
        Promise<RemoteResult<DeepSeekWebConnectionStatus | DeepSeekWebReconnectReceipt>>,
      importCompleted: (request) => client.remote[DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE].importCompleted(request),
    });
    const unregister = client.slots.register({
      name: "settings.plugin.item",
      key: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    }, () => React.createElement(DeepSeekWebSettingsCard, { controller }));
    return () => {
      controller.dispose();
      if (typeof unregister === "function") unregister();
    };
  });
  return async () => {
    await unmountRemote();
  };
}

function decodeSettings(value: unknown): DeepSeekWebOfficialSettings | undefined {
  if (!isRecord(value)) return undefined;
  const browser = value.browser;
  if (browser !== "chrome" && browser !== "edge" && browser !== "firefox") return undefined;
  if (typeof value.chromiumExtensionId !== "string" || typeof value.firefoxExtensionOrigin !== "string" ||
      !Number.isSafeInteger(value.port) || typeof value.makeDefaultForNewSessions !== "boolean" ||
      typeof value.windowsCommandsEnabled !== "boolean" ||
      (value.windowsApprovalPolicy !== "ask" && value.windowsApprovalPolicy !== "auto")) return undefined;
  if (typeof value.powerShellExecutable !== "string") return undefined;
  return {
    browser, chromiumExtensionId: value.chromiumExtensionId, firefoxExtensionOrigin: value.firefoxExtensionOrigin,
    port: value.port as number, makeDefaultForNewSessions: value.makeDefaultForNewSessions,
    windowsCommandsEnabled: value.windowsCommandsEnabled,
    windowsApprovalPolicy: value.windowsApprovalPolicy,
    powerShellExecutable: value.powerShellExecutable,
  };
}

function parseConnectionStatus(value: unknown): DeepSeekWebConnectionStatus {
  if (!isRecord(value)) throw new Error("Invalid DeepSeek Web connection status");
  const allowed = new Set(["phase", "configured", "tokenConfigured", "originConfigured", "busy", "pendingReconfigure", "browser", "port", "windows", "errorCode"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Invalid DeepSeek Web connection status");
  const phase = value.phase;
  const browser = value.browser;
  if ((phase !== "unconfigured" && phase !== "waiting_for_browser" && phase !== "connected" && phase !== "busy" && phase !== "error") ||
      (browser !== "chrome" && browser !== "edge" && browser !== "firefox") || typeof value.configured !== "boolean" ||
      typeof value.tokenConfigured !== "boolean" || typeof value.originConfigured !== "boolean" || typeof value.busy !== "boolean" ||
      typeof value.pendingReconfigure !== "boolean" || !Number.isSafeInteger(value.port) || !validWindowsStatus(value.windows) ||
      (value.errorCode !== undefined && value.errorCode !== "CONNECTION_START_FAILED")) throw new Error("Invalid DeepSeek Web connection status");
  return {
    phase, configured: value.configured, tokenConfigured: value.tokenConfigured,
    originConfigured: value.originConfigured, busy: value.busy, pendingReconfigure: value.pendingReconfigure,
    browser, port: value.port as number, windows: value.windows,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function parseReconnectReceipt(value: unknown): DeepSeekWebReconnectReceipt {
  if (!isRecord(value) || typeof value.accepted !== "boolean" || typeof value.deferred !== "boolean" ||
      (value.reason !== undefined && value.reason !== "busy" && value.reason !== "unconfigured")) {
    throw new Error("Invalid DeepSeek Web reconnect receipt");
  }
  return {
    accepted: value.accepted, deferred: value.deferred,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    status: parseConnectionStatus(value.status),
  };
}

function projectCredential(value: CredentialView | undefined): CredentialView {
  if (value === undefined) return { configured: false, writable: false };
  return { configured: value.configured === true, ...(typeof value.source === "string" ? { source: value.source } : {}), writable: value.writable === true };
}

function sameConnectionStatus(
  left: DeepSeekWebConnectionStatus,
  right: DeepSeekWebConnectionStatus | undefined,
): boolean {
  return right !== undefined && left.phase === right.phase && left.configured === right.configured &&
    left.tokenConfigured === right.tokenConfigured && left.originConfigured === right.originConfigured &&
    left.busy === right.busy && left.pendingReconfigure === right.pendingReconfigure &&
    left.browser === right.browser && left.port === right.port && left.errorCode === right.errorCode &&
    JSON.stringify(left.windows) === JSON.stringify(right.windows);
}

function validDraft(value: DeepSeekWebSettingsDraft): boolean {
  if (value.powerShellExecutable.includes("\0") || value.powerShellExecutable.length > 1_024) return false;
  if (value.browser !== "chrome" && value.browser !== "edge" && value.browser !== "firefox") return false;
  if (!/^[1-9][0-9]{0,4}$/u.test(value.port)) return false;
  const port = Number(value.port);
  if (!Number.isSafeInteger(port) || port > 65_535) return false;
  if (value.browser === "firefox") {
    return value.firefoxExtensionOrigin === "" || /^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value.firefoxExtensionOrigin);
  }
  return value.chromiumExtensionId === "" || /^[a-p]{32}$/u.test(value.chromiumExtensionId);
}

function normalizedSettingValue(
  field: keyof DeepSeekWebOfficialSettings,
  value: unknown,
): DeepSeekWebOfficialSettings[typeof field] | unknown {
  return field === "port" ? Number(value) : value;
}

function validWindowsStatus(value: unknown): value is DeepSeekWebConnectionStatus["windows"] {
  if (!isRecord(value)) return false;
  if (value.kind === "disabled") return Object.keys(value).length === 1;
  if (value.kind === "available") {
    return Object.keys(value).every((key) => key === "kind" || key === "executable" || key === "major") &&
      typeof value.executable === "string" && Number.isSafeInteger(value.major) && Number(value.major) >= 7;
  }
  return value.kind === "unavailable" && value.code === "POWERSHELL_7_REQUIRED" && typeof value.message === "string" &&
    Object.keys(value).every((key) => key === "kind" || key === "code" || key === "message");
}

function windowsStatusText(connection: DeepSeekWebConnectionStatus | undefined): string {
  const status = connection?.windows;
  if (status === undefined) return "PowerShell status unavailable.";
  if (status.kind === "disabled") return "Native Windows commands are disabled for new sessions.";
  if (status.kind === "available") return `PowerShell ${status.major} ready: ${status.executable}`;
  return status.message;
}

function pairingToken(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(32);
  if (bytes.byteLength !== 32) throw new Error("Pairing token entropy source returned the wrong length");
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 6) {
      bitCount -= 6;
      encoded += alphabet[(bits >>> bitCount) & 63];
    }
  }
  if (bitCount > 0) encoded += alphabet[(bits << (6 - bitCount)) & 63];
  return encoded;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cardProps(): Record<string, unknown> {
  return {
    "aria-label": "DeepSeek Web", "data-dsh-plugin-card": DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", padding: "16px" },
  };
}

const fieldStyle = { display: "grid", gap: "4px", marginBlock: "12px" } as const;

interface ClientContext {
  readonly slots: {
    inject(name: string, register: () => unknown): void;
    register(options: { readonly name: string; readonly key: string }, component: unknown): unknown;
  };
  readonly settingsScope: {
    bind<T>(spec: { readonly namespace: string; readonly decode?: (value: unknown) => T | undefined }): ClientSettingsScope<T>;
  };
  readonly remote: {
    readonly credentials: DeepSeekWebClientControllerOptions["credentials"];
    readonly deepseekWebConnection: {
      status(): Promise<RemoteResult<DeepSeekWebConnectionStatus>>;
      reconnect(): Promise<RemoteResult<DeepSeekWebReconnectReceipt>>;
    };
    readonly deepseekWebSessionImport: {
      importCompleted(request: CompletedSessionImportRequest): Promise<RemoteResult<CompletedSessionImportReceipt>>;
    };
    $mount(contribution: unknown): Promise<() => Promise<void>>;
  };
}
