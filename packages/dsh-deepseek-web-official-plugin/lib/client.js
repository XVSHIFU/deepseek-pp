window.__ModuleLoader__.load({
  id: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.ts
    var client_exports = {};
    __export(client_exports, {
      DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION: () => DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION,
      DeepSeekWebClientController: () => DeepSeekWebClientController,
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(client_exports);
    var import_react = __toESM(require("react"), 1);

    // src/connection-contract.ts
    var DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web";
    var DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN";
    var DEEPSEEK_WEB_CONNECTION_NAMESPACE = "deepseekWebConnection";
    var DEEPSEEK_WEB_REMOTE_CONTRIBUTION = Object.freeze({
      package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
      descriptors: Object.freeze(["status", "reconnect"].map((method) => Object.freeze({
        id: `@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebConnection/${method}`,
        service: "deepseekWebConnection",
        namespace: DEEPSEEK_WEB_CONNECTION_NAMESPACE,
        method,
        invocation: Object.freeze({ kind: "direct" }),
        parameters: Object.freeze([]),
        result: Object.freeze({ mode: "src-json" })
      })))
    });

    // src/session-import-contract.ts
    var DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE = "deepseekWebSessionImport";
    var COMPLETED_SESSION_IMPORT_REQUEST_CODEC = Object.freeze({
      mode: "strict",
      typeSymbol: "@deepseek-pp/dsh-deepseek-web-official-plugin/session-import-contract#CompletedSessionImportRequest",
      schema: Object.freeze({
        parse(value) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Completed session import request must be an object");
          }
          const record = value;
          const keys = Object.keys(record).sort();
          if (keys.join("\0") !== ["rootSessionId", "sourceHome", "sourceProcessesStopped"].join("\0") || typeof record.sourceHome !== "string" || typeof record.rootSessionId !== "string" || record.sourceProcessesStopped !== true) {
            throw new Error("Invalid completed session import request");
          }
          return {
            sourceHome: record.sourceHome,
            rootSessionId: record.rootSessionId,
            sourceProcessesStopped: true
          };
        }
      })
    });
    var DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION = Object.freeze({
      package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
      descriptors: Object.freeze([Object.freeze({
        id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebSessionImport/importCompleted",
        service: "deepseekWebSessionImportRemote",
        namespace: DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE,
        method: "importCompleted",
        invocation: Object.freeze({ kind: "direct" }),
        parameters: Object.freeze([
          Object.freeze({
            name: "request",
            wire: "request",
            source: "json",
            codec: COMPLETED_SESSION_IMPORT_REQUEST_CODEC
          })
        ]),
        result: Object.freeze({ mode: "src-json" })
      })])
    });

    // src/client.ts
    var inject = ["slots", "settingsScope", "remote"];
    var DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION = Object.freeze({
      package: DEEPSEEK_WEB_REMOTE_CONTRIBUTION.package,
      descriptors: Object.freeze([
        ...DEEPSEEK_WEB_REMOTE_CONTRIBUTION.descriptors,
        ...DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION.descriptors
      ])
    });
    var DeepSeekWebClientController = class {
      constructor(options) {
        this.options = options;
        this.snapshotValue = this.snapshot();
        this.unsubscribeSettings = options.settings.subscribe(() => {
          if (!this.savingSettings && this.staged.size > 0 && options.settings.getSnapshot().revision !== this.draftRevision) {
            if (this.stagedValuesLanded()) this.clearSettingsDraft();
            else this.settingsConflict = true;
          }
          this.publish();
          void this.refreshConnection();
        });
        this.statusTimer = setInterval(() => {
          void this.refreshConnection();
        }, 1e3);
        if (typeof this.statusTimer === "object" && "unref" in this.statusTimer) this.statusTimer.unref();
      }
      options;
      listeners = /* @__PURE__ */ new Set();
      unsubscribeSettings;
      credential = { configured: false, writable: true };
      connection;
      loading = false;
      error = null;
      refreshGeneration = 0;
      disposed = false;
      staged = /* @__PURE__ */ new Map();
      draftRevision;
      savingSettings = false;
      settingsConflict = false;
      snapshotValue;
      statusTimer;
      statusRequestActive = false;
      getSnapshot = () => this.snapshotValue;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      async refresh() {
        if (this.statusRequestActive || this.disposed) return;
        this.statusRequestActive = true;
        const generation = ++this.refreshGeneration;
        this.loading = true;
        this.error = null;
        this.publish();
        try {
          const [credential, connection] = await Promise.all([
            this.options.credentials.describe([DEEPSEEK_WEB_PAIRING_TOKEN_REF]),
            this.options.callConnection("status")
          ]);
          if (generation !== this.refreshGeneration) return;
          if (!credential.ok || credential.value === void 0) {
            this.error = credential.error?.message ?? "Credential status is unavailable.";
          } else {
            this.credential = projectCredential(credential.value[DEEPSEEK_WEB_PAIRING_TOKEN_REF]);
          }
          if (!connection.ok || connection.value === void 0) {
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
      editSetting(field, value) {
        if (this.staged.size === 0) this.draftRevision = this.options.settings.getSnapshot().revision;
        this.staged.set(field, value);
        this.error = null;
        this.publish();
      }
      discardSettings() {
        this.clearSettingsDraft();
        this.error = null;
        this.publish();
      }
      async saveSettings() {
        if (this.staged.size === 0) return;
        const draft = this.draft();
        if (draft === void 0 || !validDraft(draft)) this.fail(void 0, "Connection settings are invalid.");
        if (this.settingsConflict || this.options.settings.getSnapshot().revision !== this.draftRevision) {
          this.settingsConflict = true;
          this.fail(void 0, "Settings changed in another client. Discard this draft before editing again.");
        }
        const values = {
          browser: draft.browser,
          chromiumExtensionId: draft.chromiumExtensionId,
          firefoxExtensionOrigin: draft.firefoxExtensionOrigin,
          port: Number(draft.port),
          makeDefaultForNewSessions: draft.makeDefaultForNewSessions,
          windowsCommandsEnabled: draft.windowsCommandsEnabled,
          windowsApprovalPolicy: draft.windowsApprovalPolicy,
          powerShellExecutable: draft.powerShellExecutable
        };
        const ops = [...this.staged.keys()].map((field) => ({
          op: "set",
          path: [field],
          value: values[field]
        }));
        this.savingSettings = true;
        try {
          await this.options.settings.mutate(ops, this.draftRevision);
          this.savingSettings = false;
          if (!this.stagedValuesLanded()) {
            if (this.options.settings.getSnapshot().revision !== this.draftRevision) {
              this.settingsConflict = true;
              this.fail(void 0, "Settings changed in another client. Discard this draft before editing again.");
            }
            this.fail(void 0, "Settings were not saved.");
          }
          this.clearSettingsDraft();
          this.error = null;
          this.publish();
        } catch (error) {
          this.savingSettings = false;
          if (this.options.settings.getSnapshot().revision !== this.draftRevision && !this.stagedValuesLanded()) {
            this.settingsConflict = true;
            this.fail(void 0, "Settings changed in another client. Discard this draft before editing again.");
          }
          this.fail(error, "Settings were not saved.");
        }
      }
      async reconnect() {
        const response = await this.options.callConnection("reconnect");
        if (!response.ok || response.value === void 0) {
          this.fail(response.error?.message, "Reconnect was refused.");
        }
        const receipt = parseReconnectReceipt(response.value);
        this.connection = receipt.status;
        this.publish();
        return receipt;
      }
      async importCompleted(request) {
        if (this.options.importCompleted === void 0) this.fail(void 0, "Session import is unavailable.");
        const response = await this.options.importCompleted(request);
        if (!response.ok || response.value === void 0) {
          this.fail(response.error?.message, "Session import failed.");
        }
        return response.value;
      }
      async pair() {
        return this.replacePairingToken();
      }
      async rePair() {
        return this.replacePairingToken();
      }
      dispose() {
        this.disposed = true;
        this.refreshGeneration += 1;
        clearInterval(this.statusTimer);
        this.unsubscribeSettings();
        this.listeners.clear();
      }
      async replacePairingToken() {
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
      async refreshConnection() {
        if (this.statusRequestActive || this.disposed) return;
        this.statusRequestActive = true;
        const generation = ++this.refreshGeneration;
        try {
          const response = await this.options.callConnection("status");
          if (this.disposed || generation !== this.refreshGeneration) return;
          if (!response.ok || response.value === void 0) return;
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
      publish() {
        if (this.disposed) return;
        this.snapshotValue = this.snapshot();
        for (const listener of this.listeners) listener();
      }
      snapshot() {
        const draft = this.draft();
        return {
          settings: this.options.settings.getSnapshot(),
          credential: this.credential,
          connection: this.connection,
          draft,
          dirty: this.staged.size > 0,
          conflicted: this.settingsConflict,
          invalid: draft !== void 0 && !validDraft(draft),
          loading: this.loading,
          error: this.error
        };
      }
      draft() {
        const current = this.options.settings.getSnapshot().value;
        if (current === void 0) return void 0;
        const read = (key) => this.staged.has(key) ? this.staged.get(key) : current[key];
        return {
          browser: String(read("browser")),
          chromiumExtensionId: String(read("chromiumExtensionId")),
          firefoxExtensionOrigin: String(read("firefoxExtensionOrigin")),
          port: String(read("port")),
          makeDefaultForNewSessions: read("makeDefaultForNewSessions") === true,
          windowsCommandsEnabled: read("windowsCommandsEnabled") === true,
          windowsApprovalPolicy: read("windowsApprovalPolicy") === "auto" ? "auto" : "ask",
          powerShellExecutable: String(read("powerShellExecutable"))
        };
      }
      stagedValuesLanded() {
        const current = this.options.settings.getSnapshot().value;
        if (current === void 0) return false;
        for (const [field, value] of this.staged) {
          if (!Object.is(current[field], normalizedSettingValue(field, value))) return false;
        }
        return true;
      }
      clearSettingsDraft() {
        this.staged.clear();
        this.draftRevision = void 0;
        this.settingsConflict = false;
      }
      fail(error, fallback) {
        const message = typeof error === "string" ? error : error instanceof Error ? error.message : fallback;
        this.error = message;
        this.publish();
        throw new Error(message, error instanceof Error ? { cause: error } : void 0);
      }
    };
    function DeepSeekWebSettingsCard({ controller }) {
      const snapshot = import_react.default.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
      const [pairingTokenValue, setPairingTokenValue] = import_react.default.useState(null);
      const [importSourceHome, setImportSourceHome] = import_react.default.useState("");
      const [importRootSessionId, setImportRootSessionId] = import_react.default.useState("");
      const [sourceProcessesStopped, setSourceProcessesStopped] = import_react.default.useState(false);
      const [importing, setImporting] = import_react.default.useState(false);
      const [importStatus, setImportStatus] = import_react.default.useState(null);
      import_react.default.useEffect(() => {
        void controller.refresh();
      }, [controller]);
      const settings = snapshot.draft;
      if (settings === void 0) {
        return import_react.default.createElement("section", cardProps(), "DeepSeek Web settings are unavailable.");
      }
      const disabled = !snapshot.settings.writable;
      const field = (label, input) => import_react.default.createElement("label", { style: fieldStyle }, label, input);
      const update = (name, value) => controller.editSetting(name, value);
      const createToken = (replace) => {
        void (replace ? controller.rePair() : controller.pair()).then(setPairingTokenValue);
      };
      return import_react.default.createElement(
        "section",
        cardProps(),
        import_react.default.createElement("h3", { style: { marginTop: 0 } }, "DeepSeek Web"),
        import_react.default.createElement("p", null, snapshot.connection === void 0 ? "Connection status unavailable" : `Connection: ${snapshot.connection.phase}${snapshot.connection.pendingReconfigure ? " (change pending)" : ""}`),
        field("Browser", import_react.default.createElement(
          "select",
          {
            value: settings.browser,
            disabled,
            onChange: (event) => update("browser", event.currentTarget.value)
          },
          import_react.default.createElement("option", { value: "chrome" }, "Chrome"),
          import_react.default.createElement("option", { value: "edge" }, "Edge"),
          import_react.default.createElement("option", { value: "firefox" }, "Firefox")
        )),
        settings.browser === "firefox" ? field("Firefox extension origin", import_react.default.createElement("input", {
          value: settings.firefoxExtensionOrigin,
          disabled,
          placeholder: "moz-extension://\u2026",
          onChange: (event) => update("firefoxExtensionOrigin", event.currentTarget.value)
        })) : field("Chrome/Edge extension ID", import_react.default.createElement("input", {
          value: settings.chromiumExtensionId,
          disabled,
          onChange: (event) => update("chromiumExtensionId", event.currentTarget.value)
        })),
        field("Loopback port", import_react.default.createElement("input", {
          type: "number",
          min: 1,
          max: 65535,
          value: settings.port,
          disabled,
          onChange: (event) => update("port", event.currentTarget.value)
        })),
        field("Set DeepSeek Web as the default for future new sessions", import_react.default.createElement("input", {
          type: "checkbox",
          checked: settings.makeDefaultForNewSessions,
          disabled,
          onChange: (event) => update("makeDefaultForNewSessions", event.currentTarget.checked)
        })),
        import_react.default.createElement("h4", null, "Windows PowerShell 7"),
        import_react.default.createElement("p", null, windowsStatusText(snapshot.connection)),
        field("Enable native Windows commands for new sessions", import_react.default.createElement("input", {
          type: "checkbox",
          checked: settings.windowsCommandsEnabled,
          disabled,
          onChange: (event) => update("windowsCommandsEnabled", event.currentTarget.checked)
        })),
        field("Default approval for new sessions", import_react.default.createElement(
          "select",
          {
            value: settings.windowsApprovalPolicy,
            disabled: disabled || !settings.windowsCommandsEnabled,
            onChange: (event) => update("windowsApprovalPolicy", event.currentTarget.value)
          },
          import_react.default.createElement("option", { value: "ask" }, "Ask for every command"),
          import_react.default.createElement("option", { value: "auto" }, "Run automatically (explicit opt-in)")
        )),
        import_react.default.createElement(
          "p",
          null,
          "Commands run as the current Windows user; cwd is not a sandbox."
        ),
        field("PowerShell 7 executable", import_react.default.createElement("input", {
          value: settings.powerShellExecutable,
          disabled,
          placeholder: "pwsh or C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          onChange: (event) => update("powerShellExecutable", event.currentTarget.value)
        })),
        import_react.default.createElement("button", {
          type: "button",
          disabled: disabled || !snapshot.dirty || snapshot.invalid || snapshot.conflicted,
          onClick: () => {
            void controller.saveSettings().catch(() => void 0);
          }
        }, "Save settings"),
        import_react.default.createElement("button", {
          type: "button",
          disabled: !snapshot.dirty,
          onClick: () => controller.discardSettings()
        }, "Discard"),
        snapshot.conflicted ? import_react.default.createElement(
          "p",
          { role: "status" },
          "Settings changed in another client. Discard this draft before editing again."
        ) : null,
        import_react.default.createElement("p", null, snapshot.credential.configured ? "Pairing token configured" : "No pairing token configured"),
        import_react.default.createElement("button", { type: "button", disabled: !snapshot.credential.writable || snapshot.credential.configured, onClick: () => createToken(false) }, "Generate pairing token"),
        import_react.default.createElement("button", { type: "button", disabled: !snapshot.credential.writable, onClick: () => createToken(true) }, "Re-pair"),
        import_react.default.createElement("button", { type: "button", onClick: () => {
          void controller.reconnect();
        } }, "Reconnect"),
        pairingTokenValue === null ? null : import_react.default.createElement(
          "div",
          null,
          import_react.default.createElement("output", { "aria-label": "New pairing token" }, pairingTokenValue),
          import_react.default.createElement("button", { type: "button", onClick: () => {
            void globalThis.navigator?.clipboard?.writeText(pairingTokenValue);
          } }, "Copy"),
          import_react.default.createElement("p", null, "Copy this token now. It cannot be read back later.")
        ),
        import_react.default.createElement("h4", null, "Import completed standalone session"),
        import_react.default.createElement(
          "p",
          null,
          "The completed root and its completed child sessions are validated and committed as one group. Source records are retained; imported sessions never inherit Windows command permission."
        ),
        field("Old DeepSeek Web Agent installation directory", import_react.default.createElement("input", {
          value: importSourceHome,
          disabled: importing,
          placeholder: "C:\\Users\\you\\AppData\\Local\\DeepSeekWebAgent",
          onChange: (event) => setImportSourceHome(event.currentTarget.value)
        })),
        field("Completed root session ID", import_react.default.createElement("input", {
          value: importRootSessionId,
          disabled: importing,
          onChange: (event) => setImportRootSessionId(event.currentTarget.value)
        })),
        field("I have stopped every process using the old installation", import_react.default.createElement("input", {
          type: "checkbox",
          checked: sourceProcessesStopped,
          disabled: importing,
          onChange: (event) => setSourceProcessesStopped(event.currentTarget.checked)
        })),
        import_react.default.createElement("button", {
          type: "button",
          disabled: importing || !sourceProcessesStopped || importSourceHome.trim() === "" || importRootSessionId.trim() === "",
          onClick: () => {
            setImporting(true);
            setImportStatus(null);
            void controller.importCompleted({
              sourceHome: importSourceHome.trim(),
              rootSessionId: importRootSessionId.trim(),
              sourceProcessesStopped: true
            }).then((receipt) => {
              setImportStatus(`Imported ${receipt.imported}; already identical ${receipt.idempotent}.`);
            }, (error) => {
              setImportStatus(error instanceof Error ? error.message : "Session import failed.");
            }).finally(() => setImporting(false));
          }
        }, importing ? "Importing\u2026" : "Import completed session"),
        importStatus === null ? null : import_react.default.createElement("p", { role: "status" }, importStatus),
        snapshot.error === null ? null : import_react.default.createElement("p", { role: "alert" }, snapshot.error)
      );
    }
    async function apply(ctx) {
      const client = ctx;
      const unmountRemote = await client.remote.$mount(DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION);
      client.slots.inject("settings.plugin.item", () => {
        const settings = client.settingsScope.bind({
          namespace: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
          decode: decodeSettings
        });
        const controller = new DeepSeekWebClientController({
          settings,
          credentials: client.remote.credentials,
          callConnection: (method) => client.remote[DEEPSEEK_WEB_CONNECTION_NAMESPACE][method](),
          importCompleted: (request) => client.remote[DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE].importCompleted(request)
        });
        const unregister = client.slots.register({
          name: "settings.plugin.item",
          key: DEEPSEEK_WEB_SETTINGS_NAMESPACE
        }, () => import_react.default.createElement(DeepSeekWebSettingsCard, { controller }));
        return () => {
          controller.dispose();
          if (typeof unregister === "function") unregister();
        };
      });
      return async () => {
        await unmountRemote();
      };
    }
    function decodeSettings(value) {
      if (!isRecord(value)) return void 0;
      const browser = value.browser;
      if (browser !== "chrome" && browser !== "edge" && browser !== "firefox") return void 0;
      if (typeof value.chromiumExtensionId !== "string" || typeof value.firefoxExtensionOrigin !== "string" || !Number.isSafeInteger(value.port) || typeof value.makeDefaultForNewSessions !== "boolean" || typeof value.windowsCommandsEnabled !== "boolean" || value.windowsApprovalPolicy !== "ask" && value.windowsApprovalPolicy !== "auto") return void 0;
      if (typeof value.powerShellExecutable !== "string") return void 0;
      return {
        browser,
        chromiumExtensionId: value.chromiumExtensionId,
        firefoxExtensionOrigin: value.firefoxExtensionOrigin,
        port: value.port,
        makeDefaultForNewSessions: value.makeDefaultForNewSessions,
        windowsCommandsEnabled: value.windowsCommandsEnabled,
        windowsApprovalPolicy: value.windowsApprovalPolicy,
        powerShellExecutable: value.powerShellExecutable
      };
    }
    function parseConnectionStatus(value) {
      if (!isRecord(value)) throw new Error("Invalid DeepSeek Web connection status");
      const allowed = /* @__PURE__ */ new Set(["phase", "configured", "tokenConfigured", "originConfigured", "busy", "pendingReconfigure", "browser", "port", "windows", "errorCode"]);
      if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Invalid DeepSeek Web connection status");
      const phase = value.phase;
      const browser = value.browser;
      if (phase !== "unconfigured" && phase !== "waiting_for_browser" && phase !== "connected" && phase !== "busy" && phase !== "error" || browser !== "chrome" && browser !== "edge" && browser !== "firefox" || typeof value.configured !== "boolean" || typeof value.tokenConfigured !== "boolean" || typeof value.originConfigured !== "boolean" || typeof value.busy !== "boolean" || typeof value.pendingReconfigure !== "boolean" || !Number.isSafeInteger(value.port) || !validWindowsStatus(value.windows) || value.errorCode !== void 0 && value.errorCode !== "CONNECTION_START_FAILED") throw new Error("Invalid DeepSeek Web connection status");
      return {
        phase,
        configured: value.configured,
        tokenConfigured: value.tokenConfigured,
        originConfigured: value.originConfigured,
        busy: value.busy,
        pendingReconfigure: value.pendingReconfigure,
        browser,
        port: value.port,
        windows: value.windows,
        ...value.errorCode === void 0 ? {} : { errorCode: value.errorCode }
      };
    }
    function parseReconnectReceipt(value) {
      if (!isRecord(value) || typeof value.accepted !== "boolean" || typeof value.deferred !== "boolean" || value.reason !== void 0 && value.reason !== "busy" && value.reason !== "unconfigured") {
        throw new Error("Invalid DeepSeek Web reconnect receipt");
      }
      return {
        accepted: value.accepted,
        deferred: value.deferred,
        ...value.reason === void 0 ? {} : { reason: value.reason },
        status: parseConnectionStatus(value.status)
      };
    }
    function projectCredential(value) {
      if (value === void 0) return { configured: false, writable: false };
      return { configured: value.configured === true, ...typeof value.source === "string" ? { source: value.source } : {}, writable: value.writable === true };
    }
    function sameConnectionStatus(left, right) {
      return right !== void 0 && left.phase === right.phase && left.configured === right.configured && left.tokenConfigured === right.tokenConfigured && left.originConfigured === right.originConfigured && left.busy === right.busy && left.pendingReconfigure === right.pendingReconfigure && left.browser === right.browser && left.port === right.port && left.errorCode === right.errorCode && JSON.stringify(left.windows) === JSON.stringify(right.windows);
    }
    function validDraft(value) {
      if (value.powerShellExecutable.includes("\0") || value.powerShellExecutable.length > 1024) return false;
      if (value.browser !== "chrome" && value.browser !== "edge" && value.browser !== "firefox") return false;
      if (!/^[1-9][0-9]{0,4}$/u.test(value.port)) return false;
      const port = Number(value.port);
      if (!Number.isSafeInteger(port) || port > 65535) return false;
      if (value.browser === "firefox") {
        return value.firefoxExtensionOrigin === "" || /^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value.firefoxExtensionOrigin);
      }
      return value.chromiumExtensionId === "" || /^[a-p]{32}$/u.test(value.chromiumExtensionId);
    }
    function normalizedSettingValue(field, value) {
      return field === "port" ? Number(value) : value;
    }
    function validWindowsStatus(value) {
      if (!isRecord(value)) return false;
      if (value.kind === "disabled") return Object.keys(value).length === 1;
      if (value.kind === "available") {
        return Object.keys(value).every((key) => key === "kind" || key === "executable" || key === "major") && typeof value.executable === "string" && Number.isSafeInteger(value.major) && Number(value.major) >= 7;
      }
      return value.kind === "unavailable" && value.code === "POWERSHELL_7_REQUIRED" && typeof value.message === "string" && Object.keys(value).every((key) => key === "kind" || key === "code" || key === "message");
    }
    function windowsStatusText(connection) {
      const status = connection?.windows;
      if (status === void 0) return "PowerShell status unavailable.";
      if (status.kind === "disabled") return "Native Windows commands are disabled for new sessions.";
      if (status.kind === "available") return `PowerShell ${status.major} ready: ${status.executable}`;
      return status.message;
    }
    function pairingToken(randomBytes) {
      const bytes = randomBytes(32);
      if (bytes.byteLength !== 32) throw new Error("Pairing token entropy source returned the wrong length");
      let bits = 0;
      let bitCount = 0;
      let encoded = "";
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      for (const byte of bytes) {
        bits = bits << 8 | byte;
        bitCount += 8;
        while (bitCount >= 6) {
          bitCount -= 6;
          encoded += alphabet[bits >>> bitCount & 63];
        }
      }
      if (bitCount > 0) encoded += alphabet[bits << 6 - bitCount & 63];
      return encoded;
    }
    function secureRandomBytes(length) {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    }
    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function cardProps() {
      return {
        "aria-label": "DeepSeek Web",
        "data-dsh-plugin-card": DEEPSEEK_WEB_SETTINGS_NAMESPACE,
        style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", padding: "16px" }
      };
    }
    var fieldStyle = { display: "grid", gap: "4px", marginBlock: "12px" };
    return module.exports;
  }
});
