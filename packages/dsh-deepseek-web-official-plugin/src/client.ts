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
    connectionTitle: "连接",
    connectionDescription: "配置浏览器扩展与本机 Harness 之间的回环连接。",
    browser: "浏览器",
    chromiumExtensionId: "Chrome / Edge 扩展 ID",
    chromiumExtensionIdHint: "在浏览器扩展管理页中查看；留空表示尚未配置。",
    firefoxExtensionOrigin: "Firefox 扩展来源",
    firefoxExtensionOriginHint: "使用 moz-extension:// 开头的扩展来源；留空表示尚未配置。",
    port: "回环端口",
    portHint: "仅监听 127.0.0.1 端口，不接受远程主机或任意 URL。",
    invalidPort: "请输入 1 到 65535 之间的端口。",
    invalidChromiumExtensionId: "扩展 ID 应为 32 位小写字母 a–p，或留空。",
    invalidFirefoxExtensionOrigin: "请输入有效的 moz-extension:// 来源，或留空。",
    modelTitle: "网页模型",
    modelDescription: "为新会话选择网页模式与思考行为；正在运行的会话不会被改写。",
    modelMode: "网页模型模式",
    modelModeHint: "专家模式会请求网页端现有的专家模型类型。",
    modelDefault: "默认模式",
    modelExpert: "专家模式",
    thinking: "为新会话启用思考",
    thinkingHint: "思考内容仅在当前浏览器内临时展示，不写入会话记录。",
    makeDefault: "将 DeepSeek 网页模型设为以后新会话的默认模型",
    makeDefaultHint: "只影响之后新建的会话，不覆盖其他模型提供方的现有会话。",
    windowsTitle: "Windows PowerShell 7",
    windowsDescription: "控制新会话是否可以在当前 Windows 用户身份下运行原生命令。",
    windowsUnavailable: "PowerShell 状态不可用。",
    windowsDisabled: "新会话的原生 Windows 命令已禁用。",
    windowsReady: "PowerShell {major} 已就绪：{executable}",
    windowsEnable: "为新会话启用原生 Windows 命令",
    windowsApproval: "新会话默认批准方式",
    windowsAsk: "每条命令都询问",
    windowsAuto: "自动运行（明确选择）",
    windowsWarning: "命令以当前 Windows 用户身份运行；工作目录不是沙箱。",
    powershellExecutable: "PowerShell 7 可执行文件",
    powershellExecutableHint: "可填写 pwsh，或 PowerShell 7 可执行文件的绝对路径。",
    invalidPowerShellExecutable: "路径不能包含空字符，且长度不能超过 1024 个字符。",
    save: "保存设置",
    saving: "正在保存…",
    discard: "放弃更改",
    conflict: "设置已在另一个客户端中更改。请放弃当前草稿后再编辑。",
    tokenConfigured: "配对令牌已保存在受保护的凭据存储中（已有值不能回读）",
    tokenMissing: "尚未配置配对令牌",
    generateToken: "生成配对令牌",
    repair: "重新配对",
    reconnect: "重新连接",
    pairingTitle: "配对",
    pairingDescription: "Harness 在受保护的凭据存储中保存令牌；粘贴到扩展后，副本只保存在浏览器本地。",
    newTokenLabel: "新配对令牌",
    copy: "复制",
    copied: "已复制",
    tokenOnce: "请立即复制此令牌并粘贴到浏览器扩展。关闭或刷新此页面后无法再次查看。",
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
    connectionTitle: "Connection",
    connectionDescription: "Configure the loopback connection between the browser extension and this Harness.",
    browser: "Browser",
    chromiumExtensionId: "Chrome / Edge extension ID",
    chromiumExtensionIdHint: "Find it on the browser extensions page; leave blank while unconfigured.",
    firefoxExtensionOrigin: "Firefox extension origin",
    firefoxExtensionOriginHint: "Use the extension origin beginning with moz-extension://, or leave it blank.",
    port: "Loopback port",
    portHint: "Listens on 127.0.0.1 only; remote hosts and arbitrary URLs are not accepted.",
    invalidPort: "Enter a port from 1 through 65535.",
    invalidChromiumExtensionId: "The extension ID must be 32 lowercase letters from a–p, or blank.",
    invalidFirefoxExtensionOrigin: "Enter a valid moz-extension:// origin, or leave it blank.",
    modelTitle: "Web model",
    modelDescription: "Choose web mode and thinking behavior for new sessions; running sessions are not rewritten.",
    modelMode: "Web model mode",
    modelModeHint: "Expert requests the existing expert model type from the web session.",
    modelDefault: "Default",
    modelExpert: "Expert",
    thinking: "Enable thinking for new sessions",
    thinkingHint: "Reasoning is shown only in this browser and is never written to session history.",
    makeDefault: "Set DeepSeek Web as the default for future new sessions",
    makeDefaultHint: "Affects only future sessions and does not replace existing sessions from other providers.",
    windowsTitle: "Windows PowerShell 7",
    windowsDescription: "Control whether new sessions may run native commands as the current Windows user.",
    windowsUnavailable: "PowerShell status unavailable.",
    windowsDisabled: "Native Windows commands are disabled for new sessions.",
    windowsReady: "PowerShell {major} ready: {executable}",
    windowsEnable: "Enable native Windows commands for new sessions",
    windowsApproval: "Default approval for new sessions",
    windowsAsk: "Ask for every command",
    windowsAuto: "Run automatically (explicit opt-in)",
    windowsWarning: "Commands run as the current Windows user; cwd is not a sandbox.",
    powershellExecutable: "PowerShell 7 executable",
    powershellExecutableHint: "Enter pwsh or an absolute path to a PowerShell 7 executable.",
    invalidPowerShellExecutable: "The path cannot contain NUL and must be at most 1,024 characters.",
    save: "Save settings",
    saving: "Saving…",
    discard: "Discard",
    conflict: "Settings changed in another client. Discard this draft before editing again.",
    tokenConfigured: "Pairing token saved in protected credential storage (existing values cannot be read back)",
    tokenMissing: "No pairing token configured",
    generateToken: "Generate pairing token",
    repair: "Re-pair",
    reconnect: "Reconnect",
    pairingTitle: "Pairing",
    pairingDescription: "Harness stores the token as a protected credential; after you paste it, the extension keeps its copy only in browser-local storage.",
    newTokenLabel: "New pairing token",
    copy: "Copy",
    copied: "Copied",
    tokenOnce: "Copy this token now and paste it into the browser extension. It cannot be viewed again after this page closes or reloads.",
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
  readonly pairing: boolean;
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
  private pairingTask: Promise<string> | undefined;
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

  pair(): Promise<string> {
    return this.beginPairing();
  }

  rePair(): Promise<string> {
    return this.beginPairing();
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

  private beginPairing(): Promise<string> {
    if (this.pairingTask !== undefined) return this.pairingTask;
    const operation = this.replacePairingToken();
    const tracked = operation.finally(() => {
      if (this.pairingTask !== tracked) return;
      this.pairingTask = undefined;
      this.publish();
    });
    this.pairingTask = tracked;
    this.publish();
    return tracked;
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
      pairing: this.pairingTask !== undefined,
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
    className: "dsh-deepseek-web-reasoning",
  },
  React.createElement("summary", { className: "dsh-deepseek-web-reasoning-summary" },
    t(reasoning.active ? "reasoningWorking" : "reasoningDone")),
  React.createElement("div", { className: "dsh-deepseek-web-reasoning-text" }, reasoning.text));
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
  const formId = React.useId();
  const [pairingTokenValue, setPairingTokenValue] = React.useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = React.useState(false);
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
  const controlId = (name: string): string => `${formId}-${name}`;
  const field = (
    id: string,
    label: string,
    input: React.ReactElement,
    hint: string,
    invalidMessage?: string,
  ): React.ReactElement => React.createElement("div", { className: "dsh-deepseek-web-field" },
    React.createElement("label", { className: "dsh-deepseek-web-label", htmlFor: id }, label),
    input,
    React.createElement("p", {
      id: `${id}-hint`,
      className: invalidMessage === undefined ? "dsh-deepseek-web-hint" : "dsh-deepseek-web-error",
      ...(invalidMessage === undefined ? {} : { role: "alert" }),
    }, invalidMessage ?? hint));
  const select = (
    id: string,
    value: string,
    selectDisabled: boolean,
    onChange: (value: string) => void,
    options: readonly (readonly [string, string])[],
  ): React.ReactElement => React.createElement("span", { className: "dsh-deepseek-web-select-wrap" },
    React.createElement("select", {
      id,
      className: "dsh-deepseek-web-control dsh-deepseek-web-select-control",
      value,
      disabled: selectDisabled,
      "aria-describedby": `${id}-hint`,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.currentTarget.value),
    }, ...options.map(([optionValue, optionLabel]) =>
      React.createElement("option", { key: optionValue, value: optionValue }, optionLabel))),
    chevronIcon("dsh-deepseek-web-select-chevron"));
  const toggle = (
    id: string,
    label: string,
    hint: string,
    checked: boolean,
    toggleDisabled: boolean,
    onChange: (value: boolean) => void,
  ): React.ReactElement => React.createElement("div", { className: "dsh-deepseek-web-field" },
    React.createElement("button", {
      id,
      type: "button",
      role: "switch",
      className: "dsh-deepseek-web-toggle",
      "aria-checked": checked,
      "aria-describedby": `${id}-hint`,
      disabled: toggleDisabled,
      onClick: () => onChange(!checked),
    },
    React.createElement("span", { className: "dsh-deepseek-web-toggle-label" }, label),
    React.createElement("span", {
      className: "dsh-deepseek-web-switch",
      "data-checked": checked,
      "aria-hidden": true,
    }, React.createElement("span", { className: "dsh-deepseek-web-switch-thumb" }))),
    React.createElement("p", { id: `${id}-hint`, className: "dsh-deepseek-web-hint" }, hint));
  const section = (
    name: string,
    titleText: string,
    descriptionText: string,
    ...children: React.ReactNode[]
  ): React.ReactElement => {
    const titleId = controlId(`${name}-title`);
    return React.createElement("section", {
      className: "dsh-deepseek-web-section",
      "aria-labelledby": titleId,
      "data-section": name,
    },
    React.createElement("div", { className: "dsh-deepseek-web-section-head" },
      React.createElement("h4", { id: titleId, className: "dsh-deepseek-web-section-title" }, titleText),
      React.createElement("p", { className: "dsh-deepseek-web-section-description" }, descriptionText)),
    ...children);
  };
  const update = (name: keyof DeepSeekWebOfficialSettings, value: unknown): void => controller.editSetting(name, value);
  const createToken = (replace: boolean): void => {
    setPairingTokenValue(null);
    setTokenCopied(false);
    void (replace ? controller.rePair() : controller.pair()).then(setPairingTokenValue, () => undefined);
  };
  const title = t("title");
  const status = snapshot.connection === undefined
    ? t("connectionUnavailable")
    : formatText(t("connection"), { phase: connectionPhaseText(snapshot.connection.phase, t) }) +
      (snapshot.connection.pendingReconfigure ? t("changePending") : "");
  const statusId = controlId("status");
  const pendingId = controlId("pending");
  const header = React.createElement("button", {
    type: "button",
    className: "dsh-deepseek-web-card-header",
    "aria-expanded": open,
    "aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
    "aria-describedby": snapshot.dirty ? `${statusId} ${pendingId}` : statusId,
    onClick: () => setOpen(!open),
  },
  React.createElement("span", { className: "dsh-deepseek-web-head-text" },
    React.createElement("span", { className: "dsh-deepseek-web-name" }, title),
    React.createElement("span", { className: "dsh-deepseek-web-description" }, t("description")),
    React.createElement("span", {
      id: statusId,
      className: "dsh-deepseek-web-status",
      "data-phase": snapshot.connection?.phase ?? "unavailable",
    }, React.createElement("span", { className: "dsh-deepseek-web-status-dot", "aria-hidden": true }), status)),
  snapshot.dirty ? React.createElement("span", { id: pendingId, className: "dsh-deepseek-web-pending" }, t("unsaved")) : null,
  chevronIcon(`dsh-deepseek-web-chevron${open ? " dsh-deepseek-web-chevron-open" : ""}`));
  if (!open) return React.createElement("li", cardProps(false), header);
  const portInvalid = !validPortDraft(settings.port);
  const originInvalid = settings.browser === "firefox"
    ? !validFirefoxOriginDraft(settings.firefoxExtensionOrigin)
    : !validChromiumExtensionIdDraft(settings.chromiumExtensionId);
  const executableInvalid = !validPowerShellExecutableDraft(settings.powerShellExecutable);
  const browserId = controlId("browser");
  const originId = controlId(settings.browser === "firefox" ? "firefox-origin" : "chromium-extension-id");
  const portId = controlId("port");
  const modelModeId = controlId("model-mode");
  const thinkingId = controlId("thinking");
  const makeDefaultId = controlId("make-default");
  const windowsEnableId = controlId("windows-enable");
  const windowsApprovalId = controlId("windows-approval");
  const executableId = controlId("powershell-executable");
  const importHomeId = controlId("import-home");
  const importRootId = controlId("import-root");
  return React.createElement(
    "li",
    cardProps(true),
    header,
    React.createElement("div", {
      className: "dsh-deepseek-web-card-body",
      "aria-busy": snapshot.saving || snapshot.pairing || importing || snapshot.loading,
    },
    disabled ? React.createElement("p", { role: "status", className: "dsh-deepseek-web-notice" }, t("readOnly")) : null,
    section("connection", t("connectionTitle"), t("connectionDescription"),
      field(browserId, t("browser"), select(browserId, settings.browser, disabled, (value) => update("browser", value), [
        ["chrome", "Chrome"], ["edge", "Edge"], ["firefox", "Firefox"],
      ]), ""),
      settings.browser === "firefox"
        ? field(originId, t("firefoxExtensionOrigin"), React.createElement("input", {
          id: originId,
          className: "dsh-deepseek-web-control",
          value: settings.firefoxExtensionOrigin,
          disabled,
          placeholder: "moz-extension://…",
          "aria-invalid": originInvalid || undefined,
          "aria-describedby": `${originId}-hint`,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("firefoxExtensionOrigin", event.currentTarget.value),
        }), t("firefoxExtensionOriginHint"), originInvalid ? t("invalidFirefoxExtensionOrigin") : undefined)
        : field(originId, t("chromiumExtensionId"), React.createElement("input", {
          id: originId,
          className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
          value: settings.chromiumExtensionId,
          disabled,
          autoComplete: "off",
          spellCheck: false,
          "aria-invalid": originInvalid || undefined,
          "aria-describedby": `${originId}-hint`,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("chromiumExtensionId", event.currentTarget.value),
        }), t("chromiumExtensionIdHint"), originInvalid ? t("invalidChromiumExtensionId") : undefined),
      field(portId, t("port"), React.createElement("input", {
        id: portId,
        className: "dsh-deepseek-web-control",
        type: "number",
        inputMode: "numeric",
        min: 1,
        max: 65_535,
        value: settings.port,
        disabled,
        "aria-invalid": portInvalid || undefined,
        "aria-describedby": `${portId}-hint`,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("port", event.currentTarget.value),
      }), t("portHint"), portInvalid ? t("invalidPort") : undefined)),
    section("model", t("modelTitle"), t("modelDescription"),
      field(modelModeId, t("modelMode"), select(modelModeId, settings.webModelMode, disabled, (value) => update("webModelMode", value), [
        ["default", t("modelDefault")], ["expert", t("modelExpert")],
      ]), t("modelModeHint")),
      toggle(thinkingId, t("thinking"), t("thinkingHint"), settings.thinkingEnabled, disabled,
        (value) => update("thinkingEnabled", value)),
      toggle(makeDefaultId, t("makeDefault"), t("makeDefaultHint"), settings.makeDefaultForNewSessions, disabled,
        (value) => update("makeDefaultForNewSessions", value))),
    section("windows", t("windowsTitle"), t("windowsDescription"),
      React.createElement("p", { className: "dsh-deepseek-web-state-line", role: "status" },
        windowsStatusText(snapshot.connection, t)),
      toggle(windowsEnableId, t("windowsEnable"), t("windowsWarning"), settings.windowsCommandsEnabled, disabled,
        (value) => update("windowsCommandsEnabled", value)),
      field(windowsApprovalId, t("windowsApproval"), select(
        windowsApprovalId,
        settings.windowsApprovalPolicy,
        disabled || !settings.windowsCommandsEnabled,
        (value) => update("windowsApprovalPolicy", value),
        [["ask", t("windowsAsk")], ["auto", t("windowsAuto")]],
      ), ""),
      field(executableId, t("powershellExecutable"), React.createElement("input", {
        id: executableId,
        className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
        value: settings.powerShellExecutable,
        disabled,
        placeholder: "pwsh or C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        spellCheck: false,
        "aria-invalid": executableInvalid || undefined,
        "aria-describedby": `${executableId}-hint`,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => update("powerShellExecutable", event.currentTarget.value),
      }), t("powershellExecutableHint"), executableInvalid ? t("invalidPowerShellExecutable") : undefined)),
    snapshot.conflicted ? React.createElement("p", { role: "alert", className: "dsh-deepseek-web-alert" }, t("conflict")) : null,
    section("pairing", t("pairingTitle"), t("pairingDescription"),
      React.createElement("p", { className: "dsh-deepseek-web-state-line", role: "status" },
        snapshot.credential.configured ? t("tokenConfigured") : t("tokenMissing")),
      React.createElement("div", { className: "dsh-deepseek-web-actions" },
        React.createElement("button", {
          type: "button",
          className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
          disabled: snapshot.pairing || !snapshot.credential.writable || snapshot.credential.configured,
          onClick: () => createToken(false),
        }, t("generateToken")),
        React.createElement("button", {
          type: "button",
          className: "dsh-deepseek-web-button dsh-deepseek-web-button-caution",
          disabled: snapshot.pairing || !snapshot.credential.writable,
          onClick: () => createToken(true),
        }, t("repair")),
        React.createElement("button", {
          type: "button",
          className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
          disabled: snapshot.pairing,
          onClick: () => { void controller.reconnect().catch(() => undefined); },
        }, t("reconnect"))),
      snapshot.pairing || pairingTokenValue === null ? null : React.createElement("div", { className: "dsh-deepseek-web-token-panel" },
        React.createElement("div", { className: "dsh-deepseek-web-token-row" },
          React.createElement("output", {
            className: "dsh-deepseek-web-token-value",
            "aria-label": t("newTokenLabel"),
          }, pairingTokenValue),
          React.createElement("button", {
            type: "button",
            className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
            onClick: () => {
              void globalThis.navigator?.clipboard?.writeText(pairingTokenValue).then(() => setTokenCopied(true), () => undefined);
            },
          }, t(tokenCopied ? "copied" : "copy"))),
        React.createElement("p", { className: "dsh-deepseek-web-token-warning" }, t("tokenOnce")))),
    section("import", t("importTitle"), t("importDescription"),
      field(importHomeId, t("importHome"), React.createElement("input", {
        id: importHomeId,
        className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
        value: importSourceHome,
        disabled: importing,
        placeholder: "C:\\Users\\you\\AppData\\Local\\DeepSeekWebAgent",
        spellCheck: false,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportSourceHome(event.currentTarget.value),
      }), ""),
      field(importRootId, t("importRoot"), React.createElement("input", {
        id: importRootId,
        className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
        value: importRootSessionId,
        disabled: importing,
        spellCheck: false,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportRootSessionId(event.currentTarget.value),
      }), ""),
      React.createElement("label", { className: "dsh-deepseek-web-check-row" },
        React.createElement("input", {
          className: "dsh-deepseek-web-checkbox",
          type: "checkbox",
          checked: sourceProcessesStopped,
          disabled: importing,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSourceProcessesStopped(event.currentTarget.checked),
        }),
        React.createElement("span", null, t("importStopped"))),
      React.createElement("div", { className: "dsh-deepseek-web-actions dsh-deepseek-web-actions-end" },
        React.createElement("button", {
          type: "button",
          className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
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
        }, importing ? t("importing") : t("importAction"))),
      importStatus === null ? null : React.createElement("p", { role: "status", className: "dsh-deepseek-web-notice" }, importStatus)),
    snapshot.error === null ? null : React.createElement("p", { role: "alert", className: "dsh-deepseek-web-alert" }, snapshot.error),
    React.createElement("div", { className: "dsh-deepseek-web-card-footer" },
      React.createElement("button", {
        type: "button",
        className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
        disabled: !snapshot.dirty || snapshot.saving,
        onClick: () => controller.discardSettings(),
      }, t("discard")),
      React.createElement("button", {
        type: "button",
        className: "dsh-deepseek-web-button dsh-deepseek-web-button-primary",
        disabled: disabled || !snapshot.dirty || snapshot.invalid || snapshot.conflicted || snapshot.saving,
        onClick: () => { void controller.saveSettings().catch(() => undefined); },
      }, snapshot.saving ? t("saving") : t("save"))),
    ),
  );
}

function chevronIcon(className: string): React.ReactElement {
  return React.createElement("svg", {
    className,
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    fill: "none",
    "aria-hidden": true,
  }, React.createElement("path", {
    d: "M3.25 5.25 7 9l3.75-3.75",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  }));
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
    injected.effect(installDeepSeekWebClientStyles, "deepseek-web: client styles");
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
  if (!validPowerShellExecutableDraft(value.powerShellExecutable)) return false;
  if (value.browser !== "chrome" && value.browser !== "edge" && value.browser !== "firefox") return false;
  if (!validPortDraft(value.port)) return false;
  if (value.browser === "firefox") {
    return validFirefoxOriginDraft(value.firefoxExtensionOrigin);
  }
  return validChromiumExtensionIdDraft(value.chromiumExtensionId);
}

function validPortDraft(value: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) return false;
  const port = Number(value);
  return Number.isSafeInteger(port) && port <= 65_535;
}

function validFirefoxOriginDraft(value: string): boolean {
  return value === "" || /^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value);
}

function validChromiumExtensionIdDraft(value: string): boolean {
  return value === "" || /^[a-p]{32}$/u.test(value);
}

function validPowerShellExecutableDraft(value: string): boolean {
  return !value.includes("\0") && value.length <= 1_024;
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
    "aria-label": "DeepSeek Web",
    "data-dsh-plugin-card": DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    "data-open": open,
    className: "dsh-deepseek-web-card",
  };
}

const DEEPSEEK_WEB_CLIENT_STYLE_ID = "@deepseek-pp/dsh-deepseek-web-official-plugin/client.css";
let deepSeekWebStyleUsers = 0;
let ownedDeepSeekWebStyle: HTMLStyleElement | undefined;

function installDeepSeekWebClientStyles(): () => void {
  deepSeekWebStyleUsers += 1;
  if (typeof document !== "undefined" &&
      document.querySelector(`style[data-plugin-css="${DEEPSEEK_WEB_CLIENT_STYLE_ID}"]`) === null) {
    const style = document.createElement("style");
    style.dataset.plugin = "@deepseek-pp/dsh-deepseek-web-official-plugin";
    style.dataset.pluginCss = DEEPSEEK_WEB_CLIENT_STYLE_ID;
    style.textContent = DEEPSEEK_WEB_CLIENT_CSS;
    document.head.appendChild(style);
    ownedDeepSeekWebStyle = style;
  }
  return () => {
    deepSeekWebStyleUsers = Math.max(0, deepSeekWebStyleUsers - 1);
    if (deepSeekWebStyleUsers !== 0 || ownedDeepSeekWebStyle === undefined) return;
    ownedDeepSeekWebStyle.remove();
    ownedDeepSeekWebStyle = undefined;
  };
}

const DEEPSEEK_WEB_CLIENT_CSS = String.raw`
.dsh-deepseek-web-card {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-3);
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  list-style: none;
  transition: border-color .16s, background .16s;
}
.dsh-deepseek-web-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsh-deepseek-web-card[data-open="true"] {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-deepseek-web-card-header {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 12px;
}
.dsh-deepseek-web-card-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-deepseek-web-head-text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-deepseek-web-name {
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.dsh-deepseek-web-description {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-deepseek-web-status {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-deepseek-web-status-dot {
  width: 6px;
  height: 6px;
  flex: none;
  background: var(--dsw-alias-label-dimmed);
  border-radius: 50%;
}
.dsh-deepseek-web-status[data-phase="connected"] .dsh-deepseek-web-status-dot,
.dsh-deepseek-web-status[data-phase="busy"] .dsh-deepseek-web-status-dot {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-deepseek-web-status[data-phase="waiting_for_browser"] .dsh-deepseek-web-status-dot {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-deepseek-web-status[data-phase="error"] .dsh-deepseek-web-status-dot {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-deepseek-web-pending {
  flex: none;
  padding: 1px 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 999px;
}
.dsh-deepseek-web-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsh-deepseek-web-chevron-open { transform: rotate(180deg); }
.dsh-deepseek-web-card-body {
  min-width: 0;
  margin: 0 16px;
  padding-bottom: 8px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-section {
  min-width: 0;
  padding: 16px 0 4px;
}
.dsh-deepseek-web-section + .dsh-deepseek-web-section {
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-section-head {
  min-width: 0;
  display: grid;
  gap: 3px;
  margin-bottom: 4px;
}
.dsh-deepseek-web-section-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.dsh-deepseek-web-section-description,
.dsh-deepseek-web-hint,
.dsh-deepseek-web-error,
.dsh-deepseek-web-notice,
.dsh-deepseek-web-alert,
.dsh-deepseek-web-token-warning,
.dsh-deepseek-web-state-line {
  overflow-wrap: anywhere;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.dsh-deepseek-web-section-description,
.dsh-deepseek-web-hint,
.dsh-deepseek-web-notice { color: var(--dsw-alias-label-tertiary); }
.dsh-deepseek-web-hint:empty { display: none; }
.dsh-deepseek-web-error,
.dsh-deepseek-web-alert { color: var(--dsw-alias-state-error-primary); }
.dsh-deepseek-web-alert { padding: 10px 0; }
.dsh-deepseek-web-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-deepseek-web-field + .dsh-deepseek-web-field {
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-label {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.dsh-deepseek-web-control {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  background: var(--dsw-alias-bg-layer-3);
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
}
.dsh-deepseek-web-control:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed); }
.dsh-deepseek-web-control:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: 2px solid transparent;
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dsh-deepseek-web-control[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-deepseek-web-control:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
  opacity: .65;
}
.dsh-deepseek-web-monospace {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
}
.dsh-deepseek-web-select-wrap {
  min-width: 0;
  display: block;
  position: relative;
}
.dsh-deepseek-web-select-control { padding-right: 34px; cursor: pointer; }
.dsh-deepseek-web-select-control:disabled { cursor: default; }
.dsh-deepseek-web-select-chevron {
  position: absolute;
  top: 50%;
  right: 12px;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
  transform: translateY(-50%);
}
.dsh-deepseek-web-toggle {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.dsh-deepseek-web-toggle:hover:not(:disabled) .dsh-deepseek-web-toggle-label {
  color: var(--dsw-alias-brand-text);
}
.dsh-deepseek-web-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-deepseek-web-toggle:disabled { cursor: default; opacity: .5; }
.dsh-deepseek-web-toggle-label { min-width: 0; flex: 1; }
.dsh-deepseek-web-switch {
  box-sizing: border-box;
  width: 36px;
  height: 20px;
  flex: none;
  padding: 2px;
  position: relative;
  background: var(--dsw-alias-border-l3);
  border-radius: 10px;
  transition: background .12s;
}
.dsh-deepseek-web-switch[data-checked="true"] { background: var(--dsw-alias-brand-primary); }
.dsh-deepseek-web-switch-thumb {
  width: 16px;
  height: 16px;
  display: block;
  background: var(--dsw-alias-label-primary-foreground);
  border-radius: 50%;
  transition: transform .12s;
}
.dsh-deepseek-web-switch[data-checked="true"] .dsh-deepseek-web-switch-thumb {
  transform: translateX(16px);
}
.dsh-deepseek-web-state-line {
  margin-top: 10px;
  padding: 8px 10px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 8px;
}
.dsh-deepseek-web-actions {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
}
.dsh-deepseek-web-actions-end { justify-content: flex-end; }
.dsh-deepseek-web-button {
  appearance: none;
  box-sizing: border-box;
  min-height: 32px;
  padding: 5px 14px;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
}
.dsh-deepseek-web-button-secondary {
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border-color: var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-button-secondary:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-deepseek-web-button-primary {
  color: var(--dsw-alias-bg-layer-3);
  background: var(--dsw-alias-label-primary);
}
.dsh-deepseek-web-button-primary:hover:not(:disabled) { opacity: .86; }
.dsh-deepseek-web-button-caution {
  color: var(--dsw-alias-state-error-primary);
  background: transparent;
  border-color: var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-button-caution:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-deepseek-web-button:disabled { cursor: default; opacity: .4; }
.dsh-deepseek-web-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-deepseek-web-token-panel {
  min-width: 0;
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  background: var(--dsw-alias-bg-layer-3);
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 10px;
}
.dsh-deepseek-web-token-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.dsh-deepseek-web-token-value {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding: 7px 9px;
  overflow-x: auto;
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 7px;
  scrollbar-width: thin;
}
.dsh-deepseek-web-token-warning { color: var(--dsw-alias-state-warn-label); }
.dsh-deepseek-web-check-row {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-checkbox {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-deepseek-web-checkbox:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-deepseek-web-check-row:has(.dsh-deepseek-web-checkbox:disabled) { cursor: default; opacity: .5; }
.dsh-deepseek-web-card-footer {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding: 12px 0 4px;
  background: var(--dsw-alias-bg-layer-2);
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-deepseek-web-reasoning {
  min-width: 0;
  padding: 8px 12px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-3);
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 10px;
}
.dsh-deepseek-web-reasoning-summary {
  font-size: 13px;
  cursor: pointer;
}
.dsh-deepseek-web-reasoning-summary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-deepseek-web-reasoning-text {
  max-height: 180px;
  padding-top: 8px;
  overflow: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 520px) {
  .dsh-deepseek-web-card-header { gap: 8px; padding: 12px 14px; }
  .dsh-deepseek-web-card-body { margin: 0 14px; }
  .dsh-deepseek-web-token-row { grid-template-columns: minmax(0, 1fr); }
  .dsh-deepseek-web-token-row .dsh-deepseek-web-button { justify-self: start; }
  .dsh-deepseek-web-actions .dsh-deepseek-web-button { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-deepseek-web-card,
  .dsh-deepseek-web-chevron,
  .dsh-deepseek-web-switch,
  .dsh-deepseek-web-switch-thumb { transition: none; }
}
`;

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
