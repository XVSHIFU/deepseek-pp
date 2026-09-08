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
import {
  DEEPSEEK_WEB_REASONING_NAMESPACE,
  DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION,
  type DeepSeekWebReasoningFrame,
} from "./reasoning-contract.ts";

const DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE = "settings.deepseek-web";

const settingsLocales = {
  zh: {
    title: "DeepSeek 网页模型",
    description: "通过浏览器扩展连接已登录的 DeepSeek 网页会话。",
    expand: "展开",
    collapse: "收起",
    unsaved: "未保存",
    readOnly: "这些设置当前为只读。",
    unavailable: "DeepSeek 网页模型设置当前不可用。",
    connectionUnavailable: "连接状态不可用",
    connection: "连接：{phase}",
    changePending: "（更改等待应用）",
    phaseUnconfigured: "未配置",
    phaseWaiting: "等待浏览器",
    phaseConnected: "已连接",
    phaseBusy: "忙碌",
    phaseError: "错误",
    browser: "浏览器",
    chromiumExtensionId: "Chrome / Edge 扩展 ID",
    firefoxExtensionOrigin: "Firefox 扩展来源",
    port: "回环端口",
    modelMode: "网页模型模式",
    modelDefault: "默认模式",
    modelExpert: "专家模式",
    thinking: "为新会话启用思考",
    makeDefault: "将 DeepSeek 网页模型设为以后新会话的默认模型",
    windowsTitle: "Windows PowerShell 7",
    windowsUnavailable: "PowerShell 状态不可用。",
    windowsDisabled: "新会话的原生 Windows 命令已禁用。",
    windowsReady: "PowerShell {major} 已就绪：{executable}",
    windowsEnable: "为新会话启用原生 Windows 命令",
    windowsApproval: "新会话默认批准方式",
    windowsAsk: "每条命令都询问",
    windowsAuto: "自动运行（明确选择）",
    windowsWarning: "命令以当前 Windows 用户身份运行；工作目录不是沙箱。",
    powershellExecutable: "PowerShell 7 可执行文件",
    save: "保存设置",
    saving: "正在保存…",
    discard: "放弃更改",
    conflict: "设置已在另一个客户端中更改。请放弃当前草稿后再编辑。",
    tokenConfigured: "配对令牌已保存（出于安全原因不能再次读取）",
    tokenMissing: "尚未配置配对令牌",
    generateToken: "生成配对令牌",
    repair: "重新配对",
    reconnect: "重新连接",
    newTokenLabel: "新配对令牌",
    copy: "复制",
    tokenOnce: "请立即复制此令牌并粘贴到浏览器扩展。保存后无法再次查看。",
    importTitle: "导入已完成的独立会话",
    importDescription: "已完成的根会话及其已完成的子会话会作为一组验证并提交。源记录会保留；导入的会话不会继承 Windows 命令权限。",
    importHome: "旧版 DeepSeek Web Agent 安装目录",
    importRoot: "已完成的根会话 ID",
    importStopped: "我已停止所有使用旧安装的进程",
    importAction: "导入已完成会话",
    importing: "正在导入…",
    imported: "已导入 {imported} 个；已有相同记录 {idempotent} 个。",
    importFailed: "会话导入失败。",
    reasoningWorking: "思考中…",
    reasoningDone: "已思考",
  },
  en: {
    title: "DeepSeek Web model",
    description: "Connect the signed-in DeepSeek web session through the browser extension.",
    expand: "Expand",
    collapse: "Collapse",
    unsaved: "Unsaved",
    readOnly: "These settings are currently read-only.",
    unavailable: "DeepSeek Web model settings are unavailable.",
    connectionUnavailable: "Connection status unavailable",
    connection: "Connection: {phase}",
    changePending: " (change pending)",
    phaseUnconfigured: "unconfigured",
    phaseWaiting: "waiting for browser",
    phaseConnected: "connected",
    phaseBusy: "busy",
    phaseError: "error",
    browser: "Browser",
    chromiumExtensionId: "Chrome / Edge extension ID",
    firefoxExtensionOrigin: "Firefox extension origin",
    port: "Loopback port",
    modelMode: "Web model mode",
    modelDefault: "Default",
    modelExpert: "Expert",
    thinking: "Enable thinking for new sessions",
    makeDefault: "Set DeepSeek Web as the default for future new sessions",
    windowsTitle: "Windows PowerShell 7",
    windowsUnavailable: "PowerShell status unavailable.",
    windowsDisabled: "Native Windows commands are disabled for new sessions.",
    windowsReady: "PowerShell {major} ready: {executable}",
    windowsEnable: "Enable native Windows commands for new sessions",
    windowsApproval: "Default approval for new sessions",
    windowsAsk: "Ask for every command",
    windowsAuto: "Run automatically (explicit opt-in)",
    windowsWarning: "Commands run as the current Windows user; cwd is not a sandbox.",
    powershellExecutable: "PowerShell 7 executable",
    save: "Save settings",
    saving: "Saving…",
    discard: "Discard",
    conflict: "Settings changed in another client. Discard this draft before editing again.",
    tokenConfigured: "Pairing token saved (it cannot be read back for security)",
    tokenMissing: "No pairing token configured",
    generateToken: "Generate pairing token",
    repair: "Re-pair",
    reconnect: "Reconnect",
    newTokenLabel: "New pairing token",
    copy: "Copy",
    tokenOnce: "Copy this token now and paste it into the browser extension. It cannot be viewed again after saving.",
    importTitle: "Import completed standalone session",
    importDescription: "The completed root and its completed child sessions are validated and committed as one group. Source records are retained; imported sessions never inherit Windows command permission.",
    importHome: "Old DeepSeek Web Agent installation directory",
    importRoot: "Completed root session ID",
    importStopped: "I have stopped every process using the old installation",
    importAction: "Import completed session",
    importing: "Importing…",
    imported: "Imported {imported}; already identical {idempotent}.",
    importFailed: "Session import failed.",
    reasoningWorking: "Thinking…",
    reasoningDone: "Thought process",
  },
} as const;

export const inject = ["remote"] as const;

export const DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT = [
  "slots",
  "locale",
  "settingsScope",
  "remote.credentials",
  `remote.${DEEPSEEK_WEB_CONNECTION_NAMESPACE}`,
  `remote.${DEEPSEEK_WEB_REASONING_NAMESPACE}`,
  `remote.${DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE}`,
] as const;

/** Remote packages are unique in the browser loader, so mount all plugin descriptors together. */
export const DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION = Object.freeze({
  package: DEEPSEEK_WEB_REMOTE_CONTRIBUTION.package,
  descriptors: Object.freeze([
    ...DEEPSEEK_WEB_REMOTE_CONTRIBUTION.descriptors,
    ...DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION.descriptors,
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
  readonly webModelMode: "default" | "expert";
  readonly thinkingEnabled: boolean;
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
  readonly saving: boolean;
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
      webModelMode: draft.webModelMode,
      thinkingEnabled: draft.thinkingEnabled,
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
    this.publish();
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
      saving: this.savingSettings,
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
      webModelMode: read("webModelMode") === "expert" ? "expert" : "default",
      thinkingEnabled: read("thinkingEnabled") === true,
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

interface LiveReasoning {
  readonly requestId: string;
  readonly text: string;
  readonly active: boolean;
}

interface ReasoningSnapshot {
  readonly sessions: ReadonlyMap<string, LiveReasoning>;
  readonly revision: number;
}

/** Browser-memory-only reasoning projection. It never writes settings or session events. */
export class DeepSeekWebReasoningStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: ReasoningSnapshot = { sessions: new Map(), revision: 0 };
  private readonly abort = new AbortController();
  private started = false;

  getSnapshot = (): ReasoningSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(remote: { follow(signal: AbortSignal): AsyncIterable<DeepSeekWebReasoningFrame> }): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      for await (const frame of remote.follow(this.abort.signal)) this.accept(frame);
    } catch {
      if (!this.abort.signal.aborted) this.clear();
    }
  }

  dispose(): void {
    this.abort.abort();
    this.clear();
    this.listeners.clear();
  }

  private accept(frame: DeepSeekWebReasoningFrame): void {
    const sessions = new Map(this.snapshot.sessions);
    if (frame.phase === "start") {
      sessions.set(frame.sessionId, { requestId: frame.requestId, text: "", active: true });
    } else {
      const current = sessions.get(frame.sessionId);
      if (current === undefined || current.requestId !== frame.requestId) return;
      if (frame.phase === "delta") {
        const joined = current.text + frame.text;
        sessions.set(frame.sessionId, {
          ...current,
          text: joined.length <= 131_072 ? joined : `…${joined.slice(-131_071)}`,
        });
      } else if (current.text === "") {
        sessions.delete(frame.sessionId);
      } else {
        sessions.set(frame.sessionId, { ...current, active: false });
      }
    }
    this.snapshot = { sessions, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }

  private clear(): void {
    if (this.snapshot.sessions.size === 0) return;
    this.snapshot = { sessions: new Map(), revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
}

function DeepSeekWebReasoningDock({
  sessionId,
  store,
  locale,
}: {
  readonly sessionId: string;
  readonly store: DeepSeekWebReasoningStore;
  readonly locale: LocaleService;
}): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  React.useSyncExternalStore(
    (listener) => locale.subscribe(listener),
    () => locale.getSnapshot(),
    () => locale.getSnapshot(),
  );
  const reasoning = snapshot.sessions.get(sessionId);
  if (reasoning === undefined || reasoning.text === "") return null;
  const t = locale.bind(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE);
  return React.createElement("details", {
    key: reasoning.requestId,
    open: reasoning.active || undefined,
    style: reasoningDockStyle,
  },
  React.createElement("summary", { style: { cursor: "pointer" } },
    t(reasoning.active ? "reasoningWorking" : "reasoningDone")),
  React.createElement("div", { style: reasoningTextStyle }, reasoning.text));
}

function DeepSeekWebSettingsCard({
  controller,
  locale,
}: {
  readonly controller: DeepSeekWebClientController;
  readonly locale: LocaleService;
}): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useSyncExternalStore(
    (listener) => locale.subscribe(listener),
    () => locale.getSnapshot(),
    () => locale.getSnapshot(),
  );
  const t = locale.bind(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE);
  const [open, setOpen] = React.useState(false);
  const saveStarted = React.useRef(false);
  const [pairingTokenValue, setPairingTokenValue] = React.useState<string | null>(null);
  const [importSourceHome, setImportSourceHome] = React.useState("");
  const [importRootSessionId, setImportRootSessionId] = React.useState("");
  const [sourceProcessesStopped, setSourceProcessesStopped] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importStatus, setImportStatus] = React.useState<string | null>(null);
  React.useEffect(() => {
    void controller.refresh();
  }, [controller]);
  React.useEffect(() => {
    if (snapshot.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!snapshot.dirty && snapshot.error === null) setOpen(false);
  }, [snapshot.dirty, snapshot.error, snapshot.saving]);
  const settings = snapshot.draft;
  if (settings === undefined) return null;
  const disabled = !snapshot.settings.writable;
  const field = (label: string, input: React.ReactElement): React.ReactElement =>
    React.createElement("label", { style: fieldStyle }, label, input);
  const update = (name: keyof DeepSeekWebOfficialSettings, value: unknown): void => controller.editSetting(name, value);
  const createToken = (replace: boolean): void => {
    void (replace ? controller.rePair() : controller.pair()).then(setPairingTokenValue, () => undefined);
  };
  const title = t("title");
  const status = snapshot.connection === undefined
    ? t("connectionUnavailable")
    : formatText(t("connection"), { phase: connectionPhaseText(snapshot.connection.phase, t) }) +
      (snapshot.connection.pendingReconfigure ? t("changePending") : "");
  const header = React.createElement("button", {
    type: "button",
    style: cardHeaderStyle,
    "aria-expanded": open,
    "aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
    onClick: () => setOpen(!open),
  },
  React.createElement("span", { style: { display: "grid", gap: "3px", textAlign: "left" } },
    React.createElement("span", { style: { fontWeight: 650 } }, title),
    React.createElement("span", { style: mutedTextStyle }, t("description")),
    React.createElement("span", { style: statusTextStyle }, status)),
  snapshot.dirty ? React.createElement("span", { style: pendingStyle }, t("unsaved")) : null,
  React.createElement("span", {
    "aria-hidden": true,
    style: { transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 120ms ease" },
  }, "⌄"));
  if (!open) return React.createElement("li", cardProps(false), header);
  return React.createElement(
    "li",
    cardProps(true),
    header,
    React.createElement("div", { style: cardBodyStyle },
    disabled ? React.createElement("p", { role: "status", style: warningStyle }, t("readOnly")) : null,
    field(t("browser"), React.createElement("select", {
      value: settings.browser,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => update("browser", event.currentTarget.value),
    }, React.createElement("option", { value: "chrome" }, "Chrome"),
    React.createElement("option", { value: "edge" }, "Edge"),
    React.createElement("option", { value: "firefox" }, "Firefox"))),
    settings.browser === "firefox"
      ? field(t("firefoxExtensionOrigin"), React.createElement("input", {
        value: settings.firefoxExtensionOrigin,
        disabled,
        placeholder: "moz-extension://…",
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("firefoxExtensionOrigin", event.currentTarget.value),
      }))
      : field(t("chromiumExtensionId"), React.createElement("input", {
        value: settings.chromiumExtensionId,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("chromiumExtensionId", event.currentTarget.value),
      })),
    field(t("port"), React.createElement("input", {
      type: "number", min: 1, max: 65_535, value: settings.port, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("port", event.currentTarget.value),
    })),
    field(t("modelMode"), React.createElement("select", {
      value: settings.webModelMode,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => update("webModelMode", event.currentTarget.value),
    }, React.createElement("option", { value: "default" }, t("modelDefault")),
    React.createElement("option", { value: "expert" }, t("modelExpert")))),
    field(t("thinking"), React.createElement("input", {
      type: "checkbox", checked: settings.thinkingEnabled, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("thinkingEnabled", event.currentTarget.checked),
    })),
    field(t("makeDefault"), React.createElement("input", {
      type: "checkbox", checked: settings.makeDefaultForNewSessions, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("makeDefaultForNewSessions", event.currentTarget.checked),
    })),
    React.createElement("h4", null, t("windowsTitle")),
    React.createElement("p", null, windowsStatusText(snapshot.connection, t)),
    field(t("windowsEnable"), React.createElement("input", {
      type: "checkbox", checked: settings.windowsCommandsEnabled, disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("windowsCommandsEnabled", event.currentTarget.checked),
    })),
    field(t("windowsApproval"), React.createElement("select", {
      value: settings.windowsApprovalPolicy,
      disabled: disabled || !settings.windowsCommandsEnabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => update("windowsApprovalPolicy", event.currentTarget.value),
    }, React.createElement("option", { value: "ask" }, t("windowsAsk")),
    React.createElement("option", { value: "auto" }, t("windowsAuto")))),
    React.createElement("p", null, t("windowsWarning")),
    field(t("powershellExecutable"), React.createElement("input", {
      value: settings.powerShellExecutable,
      disabled,
      placeholder: "pwsh or C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("powerShellExecutable", event.currentTarget.value),
    })),
    snapshot.conflicted ? React.createElement("p", { role: "status" },
      t("conflict")) : null,
    React.createElement("p", null, snapshot.credential.configured ? t("tokenConfigured") : t("tokenMissing")),
    React.createElement("button", { type: "button", disabled: !snapshot.credential.writable || snapshot.credential.configured, onClick: () => createToken(false) }, t("generateToken")),
    React.createElement("button", { type: "button", disabled: !snapshot.credential.writable, onClick: () => createToken(true) }, t("repair")),
    React.createElement("button", { type: "button", onClick: () => { void controller.reconnect().catch(() => undefined); } }, t("reconnect")),
    pairingTokenValue === null ? null : React.createElement("div", null,
      React.createElement("output", { "aria-label": t("newTokenLabel") }, pairingTokenValue),
      React.createElement("button", { type: "button", onClick: () => { void globalThis.navigator?.clipboard?.writeText(pairingTokenValue); } }, t("copy")),
      React.createElement("p", { style: warningStyle }, t("tokenOnce"))),
    React.createElement("h4", null, t("importTitle")),
    React.createElement("p", null, t("importDescription")),
    field(t("importHome"), React.createElement("input", {
      value: importSourceHome,
      disabled: importing,
      placeholder: "C:\\Users\\you\\AppData\\Local\\DeepSeekWebAgent",
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportSourceHome(event.currentTarget.value),
    })),
    field(t("importRoot"), React.createElement("input", {
      value: importRootSessionId,
      disabled: importing,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportRootSessionId(event.currentTarget.value),
    })),
    field(t("importStopped"), React.createElement("input", {
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
          setImportStatus(formatText(t("imported"), { imported: receipt.imported, idempotent: receipt.idempotent }));
        }, (error: unknown) => {
          setImportStatus(error instanceof Error ? error.message : t("importFailed"));
        }).finally(() => setImporting(false));
      },
    }, importing ? t("importing") : t("importAction")),
    importStatus === null ? null : React.createElement("p", { role: "status" }, importStatus),
    snapshot.error === null ? null : React.createElement("p", { role: "alert" }, snapshot.error),
    React.createElement("div", { style: cardFooterStyle },
      React.createElement("button", {
        type: "button", disabled: !snapshot.dirty || snapshot.saving,
        onClick: () => controller.discardSettings(),
      }, t("discard")),
      React.createElement("button", {
        type: "button",
        disabled: disabled || !snapshot.dirty || snapshot.invalid || snapshot.conflicted || snapshot.saving,
        onClick: () => { void controller.saveSettings().catch(() => undefined); },
      }, snapshot.saving ? t("saving") : t("save"))),
    ),
  );
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const client = ctx as Context & ClientContext;
  const unmountRemote = await client.remote.$mount(DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION);
  const settingsFiber = client.inject(DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT, (injectedCtx) => {
    const injected = injectedCtx as Context & ClientContext;
    injected.effect(
      () => injected.locale.register(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE, settingsLocales),
      "deepseek-web: settings dictionaries",
    );
    const reasoningStore = new DeepSeekWebReasoningStore();
    injected.effect(() => {
      void reasoningStore.start(injected.remote[DEEPSEEK_WEB_REASONING_NAMESPACE]);
      return () => reasoningStore.dispose();
    }, "deepseek-web: ephemeral reasoning stream");
    injected.slots.inject("conversation.input.dock", () => injected.slots.register({
      name: "conversation.input.dock",
      id: "deepseek-web-reasoning",
      order: -10,
      inject: (sessionId: string) => ({ sessionId, store: reasoningStore, locale: injected.locale }),
    }, DeepSeekWebReasoningDock));
    injected.slots.inject("settings.plugin.item", () => {
      const settings = injected.settingsScope.bind<DeepSeekWebOfficialSettings>({
      namespace: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
      decode: decodeSettings,
    });
    const controller = new DeepSeekWebClientController({
      settings,
      credentials: injected.remote.credentials,
      callConnection: (method) => injected.remote[DEEPSEEK_WEB_CONNECTION_NAMESPACE][method]() as
        Promise<RemoteResult<DeepSeekWebConnectionStatus | DeepSeekWebReconnectReceipt>>,
      importCompleted: (request) => injected.remote[DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE].importCompleted(request),
    });
      const unregister = injected.slots.register({
      name: "settings.plugin.item",
      key: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    }, () => React.createElement(DeepSeekWebSettingsCard, { controller, locale: injected.locale }));
      return () => {
        controller.dispose();
        if (typeof unregister === "function") unregister();
      };
    });
  });
  try {
    await settingsFiber;
  } catch (error) {
    await unmountRemote();
    throw error;
  }
  return async () => {
    const failures = await Promise.allSettled([settingsFiber.dispose(), unmountRemote()]);
    const rejected = failures.flatMap((failure) => failure.status === "rejected" ? [failure.reason] : []);
    if (rejected.length === 1) throw rejected[0];
    if (rejected.length > 1) throw new AggregateError(rejected, "DeepSeek Web client cleanup failed");
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
  const webModelMode = value.webModelMode === undefined ? "default" : value.webModelMode;
  const thinkingEnabled = value.thinkingEnabled === undefined ? false : value.thinkingEnabled;
  if ((webModelMode !== "default" && webModelMode !== "expert") || typeof thinkingEnabled !== "boolean") return undefined;
  return {
    browser, chromiumExtensionId: value.chromiumExtensionId, firefoxExtensionOrigin: value.firefoxExtensionOrigin,
    port: value.port as number, webModelMode, thinkingEnabled,
    makeDefaultForNewSessions: value.makeDefaultForNewSessions,
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

function windowsStatusText(connection: DeepSeekWebConnectionStatus | undefined, t: Translate): string {
  const status = connection?.windows;
  if (status === undefined) return t("windowsUnavailable");
  if (status.kind === "disabled") return t("windowsDisabled");
  if (status.kind === "available") {
    return formatText(t("windowsReady"), { major: status.major, executable: status.executable });
  }
  return status.message;
}

function connectionPhaseText(phase: DeepSeekWebConnectionStatus["phase"], t: Translate): string {
  if (phase === "unconfigured") return t("phaseUnconfigured");
  if (phase === "waiting_for_browser") return t("phaseWaiting");
  if (phase === "connected") return t("phaseConnected");
  if (phase === "busy") return t("phaseBusy");
  return t("phaseError");
}

function formatText(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([^}]+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole);
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

function cardProps(open: boolean): Record<string, unknown> {
  return {
    "aria-label": "DeepSeek Web", "data-dsh-plugin-card": DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    style: {
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "12px",
      overflow: "hidden",
      background: open ? "var(--dsw-alias-bg-base)" : "transparent",
      listStyle: "none",
    },
  };
}

const fieldStyle = { display: "grid", gap: "4px", marginBlock: "12px" } as const;
const cardHeaderStyle = {
  alignItems: "center", background: "transparent", border: 0, cursor: "pointer", display: "grid",
  gap: "12px", gridTemplateColumns: "minmax(0, 1fr) auto auto", padding: "16px", textAlign: "left", width: "100%",
} as const;
const cardBodyStyle = { borderTop: "1px solid var(--dsw-alias-border-l2)", padding: "4px 16px 16px" } as const;
const cardFooterStyle = { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" } as const;
const mutedTextStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: "0.875rem" } as const;
const statusTextStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "0.8125rem" } as const;
const pendingStyle = { color: "var(--dsw-alias-status-warning)", fontSize: "0.8125rem" } as const;
const warningStyle = { color: "var(--dsw-alias-label-secondary)" } as const;
const reasoningDockStyle = {
  border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "8px 12px",
} as const;
const reasoningTextStyle = {
  maxHeight: "180px", overflow: "auto", paddingTop: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word",
} as const;

type Translate = (key: string) => string;

interface LocaleService {
  bind(namespace: string): Translate;
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  register(namespace: string, dictionaries: typeof settingsLocales): () => void;
}

interface ClientContext {
  readonly locale: LocaleService;
  readonly slots: {
    inject(name: string, register: () => unknown): void;
    register(options: {
      readonly name: string;
      readonly key?: string;
      readonly id?: string;
      readonly order?: number;
      readonly inject?: (scope: string) => unknown;
    }, component: unknown): unknown;
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
    readonly deepseekWebReasoning: {
      follow(signal: AbortSignal): AsyncIterable<DeepSeekWebReasoningFrame>;
    };
    readonly deepseekWebSessionImport: {
      importCompleted(request: CompletedSessionImportRequest): Promise<RemoteResult<CompletedSessionImportReceipt>>;
    };
    $mount(contribution: unknown): Promise<() => Promise<void>>;
  };
}
