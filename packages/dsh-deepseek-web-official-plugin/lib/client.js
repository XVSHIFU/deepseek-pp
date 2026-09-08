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
      DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT: () => DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT,
      DeepSeekWebClientController: () => DeepSeekWebClientController,
      DeepSeekWebReasoningStore: () => DeepSeekWebReasoningStore,
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

    // src/reasoning-contract.ts
    var DEEPSEEK_WEB_REASONING_NAMESPACE = "deepseekWebReasoning";
    var FRAME_CODEC = Object.freeze({
      mode: "strict",
      typeSymbol: "@deepseek-pp/dsh-deepseek-web-official-plugin/reasoning-contract#DeepSeekWebReasoningFrame",
      schema: Object.freeze({ parse: decodeReasoningFrame })
    });
    var DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION = Object.freeze({
      package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
      descriptors: Object.freeze([Object.freeze({
        id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebReasoningRemote/follow",
        service: "deepseekWebReasoningRemote",
        namespace: DEEPSEEK_WEB_REASONING_NAMESPACE,
        method: "follow",
        mode: "stream",
        invocation: Object.freeze({ kind: "direct" }),
        parameters: Object.freeze([]),
        cancellation: Object.freeze({ parameter: "signal" }),
        result: FRAME_CODEC
      })])
    });
    function decodeReasoningFrame(value) {
      if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.requestId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 256 || value.requestId.length === 0 || value.requestId.length > 256) throw new Error("Invalid DeepSeek Web reasoning frame");
      if (value.phase === "delta") {
        if (Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId", "text"].join("\0") || typeof value.text !== "string" || value.text.length > 16384) {
          throw new Error("Invalid DeepSeek Web reasoning frame");
        }
        return { phase: "delta", sessionId: value.sessionId, requestId: value.requestId, text: value.text };
      }
      if (value.phase !== "start" && value.phase !== "end" || Object.keys(value).sort().join("\0") !== ["phase", "requestId", "sessionId"].join("\0")) {
        throw new Error("Invalid DeepSeek Web reasoning frame");
      }
      return { phase: value.phase, sessionId: value.sessionId, requestId: value.requestId };
    }
    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    // src/client.ts
    var DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE = "settings.deepseek-web";
    var settingsLocales = {
      zh: {
        title: "DeepSeek \u7F51\u9875\u6A21\u578B",
        description: "\u901A\u8FC7\u6D4F\u89C8\u5668\u6269\u5C55\u8FDE\u63A5\u5DF2\u767B\u5F55\u7684 DeepSeek \u7F51\u9875\u4F1A\u8BDD\u3002",
        expand: "\u5C55\u5F00",
        collapse: "\u6536\u8D77",
        unsaved: "\u672A\u4FDD\u5B58",
        readOnly: "\u8FD9\u4E9B\u8BBE\u7F6E\u5F53\u524D\u4E3A\u53EA\u8BFB\u3002",
        unavailable: "DeepSeek \u7F51\u9875\u6A21\u578B\u8BBE\u7F6E\u5F53\u524D\u4E0D\u53EF\u7528\u3002",
        connectionUnavailable: "\u8FDE\u63A5\u72B6\u6001\u4E0D\u53EF\u7528",
        connection: "\u8FDE\u63A5\uFF1A{phase}",
        changePending: "\uFF08\u66F4\u6539\u7B49\u5F85\u5E94\u7528\uFF09",
        phaseUnconfigured: "\u672A\u914D\u7F6E",
        phaseWaiting: "\u7B49\u5F85\u6D4F\u89C8\u5668",
        phaseConnected: "\u5DF2\u8FDE\u63A5",
        phaseBusy: "\u5FD9\u788C",
        phaseError: "\u9519\u8BEF",
        connectionTitle: "\u8FDE\u63A5",
        connectionDescription: "\u914D\u7F6E\u6D4F\u89C8\u5668\u6269\u5C55\u4E0E\u672C\u673A Harness \u4E4B\u95F4\u7684\u56DE\u73AF\u8FDE\u63A5\u3002",
        browser: "\u6D4F\u89C8\u5668",
        chromiumExtensionId: "Chrome / Edge \u6269\u5C55 ID",
        chromiumExtensionIdHint: "\u5728\u6D4F\u89C8\u5668\u6269\u5C55\u7BA1\u7406\u9875\u4E2D\u67E5\u770B\uFF1B\u7559\u7A7A\u8868\u793A\u5C1A\u672A\u914D\u7F6E\u3002",
        firefoxExtensionOrigin: "Firefox \u6269\u5C55\u6765\u6E90",
        firefoxExtensionOriginHint: "\u4F7F\u7528 moz-extension:// \u5F00\u5934\u7684\u6269\u5C55\u6765\u6E90\uFF1B\u7559\u7A7A\u8868\u793A\u5C1A\u672A\u914D\u7F6E\u3002",
        port: "\u56DE\u73AF\u7AEF\u53E3",
        portHint: "\u4EC5\u76D1\u542C 127.0.0.1 \u7AEF\u53E3\uFF0C\u4E0D\u63A5\u53D7\u8FDC\u7A0B\u4E3B\u673A\u6216\u4EFB\u610F URL\u3002",
        invalidPort: "\u8BF7\u8F93\u5165 1 \u5230 65535 \u4E4B\u95F4\u7684\u7AEF\u53E3\u3002",
        invalidChromiumExtensionId: "\u6269\u5C55 ID \u5E94\u4E3A 32 \u4F4D\u5C0F\u5199\u5B57\u6BCD a\u2013p\uFF0C\u6216\u7559\u7A7A\u3002",
        invalidFirefoxExtensionOrigin: "\u8BF7\u8F93\u5165\u6709\u6548\u7684 moz-extension:// \u6765\u6E90\uFF0C\u6216\u7559\u7A7A\u3002",
        modelTitle: "\u7F51\u9875\u6A21\u578B",
        modelDescription: "\u4E3A\u65B0\u4F1A\u8BDD\u9009\u62E9\u7F51\u9875\u6A21\u5F0F\u4E0E\u601D\u8003\u884C\u4E3A\uFF1B\u6B63\u5728\u8FD0\u884C\u7684\u4F1A\u8BDD\u4E0D\u4F1A\u88AB\u6539\u5199\u3002",
        modelMode: "\u7F51\u9875\u6A21\u578B\u6A21\u5F0F",
        modelModeHint: "\u4E13\u5BB6\u6A21\u5F0F\u4F1A\u8BF7\u6C42\u7F51\u9875\u7AEF\u73B0\u6709\u7684\u4E13\u5BB6\u6A21\u578B\u7C7B\u578B\u3002",
        modelDefault: "\u9ED8\u8BA4\u6A21\u5F0F",
        modelExpert: "\u4E13\u5BB6\u6A21\u5F0F",
        thinking: "\u4E3A\u65B0\u4F1A\u8BDD\u542F\u7528\u601D\u8003",
        thinkingHint: "\u601D\u8003\u5185\u5BB9\u4EC5\u5728\u5F53\u524D\u6D4F\u89C8\u5668\u5185\u4E34\u65F6\u5C55\u793A\uFF0C\u4E0D\u5199\u5165\u4F1A\u8BDD\u8BB0\u5F55\u3002",
        makeDefault: "\u5C06 DeepSeek \u7F51\u9875\u6A21\u578B\u8BBE\u4E3A\u4EE5\u540E\u65B0\u4F1A\u8BDD\u7684\u9ED8\u8BA4\u6A21\u578B",
        makeDefaultHint: "\u53EA\u5F71\u54CD\u4E4B\u540E\u65B0\u5EFA\u7684\u4F1A\u8BDD\uFF0C\u4E0D\u8986\u76D6\u5176\u4ED6\u6A21\u578B\u63D0\u4F9B\u65B9\u7684\u73B0\u6709\u4F1A\u8BDD\u3002",
        windowsTitle: "Windows PowerShell 7",
        windowsDescription: "\u63A7\u5236\u65B0\u4F1A\u8BDD\u662F\u5426\u53EF\u4EE5\u5728\u5F53\u524D Windows \u7528\u6237\u8EAB\u4EFD\u4E0B\u8FD0\u884C\u539F\u751F\u547D\u4EE4\u3002",
        windowsUnavailable: "PowerShell \u72B6\u6001\u4E0D\u53EF\u7528\u3002",
        windowsDisabled: "\u65B0\u4F1A\u8BDD\u7684\u539F\u751F Windows \u547D\u4EE4\u5DF2\u7981\u7528\u3002",
        windowsReady: "PowerShell {major} \u5DF2\u5C31\u7EEA\uFF1A{executable}",
        windowsEnable: "\u4E3A\u65B0\u4F1A\u8BDD\u542F\u7528\u539F\u751F Windows \u547D\u4EE4",
        windowsApproval: "\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u6279\u51C6\u65B9\u5F0F",
        windowsAsk: "\u6BCF\u6761\u547D\u4EE4\u90FD\u8BE2\u95EE",
        windowsAuto: "\u81EA\u52A8\u8FD0\u884C\uFF08\u660E\u786E\u9009\u62E9\uFF09",
        windowsWarning: "\u547D\u4EE4\u4EE5\u5F53\u524D Windows \u7528\u6237\u8EAB\u4EFD\u8FD0\u884C\uFF1B\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u662F\u6C99\u7BB1\u3002",
        powershellExecutable: "PowerShell 7 \u53EF\u6267\u884C\u6587\u4EF6",
        powershellExecutableHint: "\u53EF\u586B\u5199 pwsh\uFF0C\u6216 PowerShell 7 \u53EF\u6267\u884C\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002",
        invalidPowerShellExecutable: "\u8DEF\u5F84\u4E0D\u80FD\u5305\u542B\u7A7A\u5B57\u7B26\uFF0C\u4E14\u957F\u5EA6\u4E0D\u80FD\u8D85\u8FC7 1024 \u4E2A\u5B57\u7B26\u3002",
        save: "\u4FDD\u5B58\u8BBE\u7F6E",
        saving: "\u6B63\u5728\u4FDD\u5B58\u2026",
        discard: "\u653E\u5F03\u66F4\u6539",
        conflict: "\u8BBE\u7F6E\u5DF2\u5728\u53E6\u4E00\u4E2A\u5BA2\u6237\u7AEF\u4E2D\u66F4\u6539\u3002\u8BF7\u653E\u5F03\u5F53\u524D\u8349\u7A3F\u540E\u518D\u7F16\u8F91\u3002",
        tokenConfigured: "\u914D\u5BF9\u4EE4\u724C\u5DF2\u4FDD\u5B58\u5728\u53D7\u4FDD\u62A4\u7684\u51ED\u636E\u5B58\u50A8\u4E2D\uFF08\u5DF2\u6709\u503C\u4E0D\u80FD\u56DE\u8BFB\uFF09",
        tokenMissing: "\u5C1A\u672A\u914D\u7F6E\u914D\u5BF9\u4EE4\u724C",
        generateToken: "\u751F\u6210\u914D\u5BF9\u4EE4\u724C",
        repair: "\u91CD\u65B0\u914D\u5BF9",
        reconnect: "\u91CD\u65B0\u8FDE\u63A5",
        pairingTitle: "\u914D\u5BF9",
        pairingDescription: "Harness \u5728\u53D7\u4FDD\u62A4\u7684\u51ED\u636E\u5B58\u50A8\u4E2D\u4FDD\u5B58\u4EE4\u724C\uFF1B\u7C98\u8D34\u5230\u6269\u5C55\u540E\uFF0C\u526F\u672C\u53EA\u4FDD\u5B58\u5728\u6D4F\u89C8\u5668\u672C\u5730\u3002",
        newTokenLabel: "\u65B0\u914D\u5BF9\u4EE4\u724C",
        copy: "\u590D\u5236",
        copied: "\u5DF2\u590D\u5236",
        tokenOnce: "\u8BF7\u7ACB\u5373\u590D\u5236\u6B64\u4EE4\u724C\u5E76\u7C98\u8D34\u5230\u6D4F\u89C8\u5668\u6269\u5C55\u3002\u5173\u95ED\u6216\u5237\u65B0\u6B64\u9875\u9762\u540E\u65E0\u6CD5\u518D\u6B21\u67E5\u770B\u3002",
        importTitle: "\u5BFC\u5165\u5DF2\u5B8C\u6210\u7684\u72EC\u7ACB\u4F1A\u8BDD",
        importDescription: "\u5DF2\u5B8C\u6210\u7684\u6839\u4F1A\u8BDD\u53CA\u5176\u5DF2\u5B8C\u6210\u7684\u5B50\u4F1A\u8BDD\u4F1A\u4F5C\u4E3A\u4E00\u7EC4\u9A8C\u8BC1\u5E76\u63D0\u4EA4\u3002\u6E90\u8BB0\u5F55\u4F1A\u4FDD\u7559\uFF1B\u5BFC\u5165\u7684\u4F1A\u8BDD\u4E0D\u4F1A\u7EE7\u627F Windows \u547D\u4EE4\u6743\u9650\u3002",
        importHome: "\u65E7\u7248 DeepSeek Web Agent \u5B89\u88C5\u76EE\u5F55",
        importRoot: "\u5DF2\u5B8C\u6210\u7684\u6839\u4F1A\u8BDD ID",
        importStopped: "\u6211\u5DF2\u505C\u6B62\u6240\u6709\u4F7F\u7528\u65E7\u5B89\u88C5\u7684\u8FDB\u7A0B",
        importAction: "\u5BFC\u5165\u5DF2\u5B8C\u6210\u4F1A\u8BDD",
        importing: "\u6B63\u5728\u5BFC\u5165\u2026",
        imported: "\u5DF2\u5BFC\u5165 {imported} \u4E2A\uFF1B\u5DF2\u6709\u76F8\u540C\u8BB0\u5F55 {idempotent} \u4E2A\u3002",
        importFailed: "\u4F1A\u8BDD\u5BFC\u5165\u5931\u8D25\u3002",
        reasoningWorking: "\u601D\u8003\u4E2D\u2026",
        reasoningDone: "\u5DF2\u601D\u8003"
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
        invalidChromiumExtensionId: "The extension ID must be 32 lowercase letters from a\u2013p, or blank.",
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
        saving: "Saving\u2026",
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
        importing: "Importing\u2026",
        imported: "Imported {imported}; already identical {idempotent}.",
        importFailed: "Session import failed.",
        reasoningWorking: "Thinking\u2026",
        reasoningDone: "Thought process"
      }
    };
    var inject = ["remote"];
    var DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT = [
      "slots",
      "locale",
      "settingsScope",
      "remote.credentials",
      `remote.${DEEPSEEK_WEB_CONNECTION_NAMESPACE}`,
      `remote.${DEEPSEEK_WEB_REASONING_NAMESPACE}`,
      `remote.${DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE}`
    ];
    var DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION = Object.freeze({
      package: DEEPSEEK_WEB_REMOTE_CONTRIBUTION.package,
      descriptors: Object.freeze([
        ...DEEPSEEK_WEB_REMOTE_CONTRIBUTION.descriptors,
        ...DEEPSEEK_WEB_REASONING_REMOTE_CONTRIBUTION.descriptors,
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
      pairingTask;
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
          webModelMode: draft.webModelMode,
          thinkingEnabled: draft.thinkingEnabled,
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
        this.publish();
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
      pair() {
        return this.beginPairing();
      }
      rePair() {
        return this.beginPairing();
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
      beginPairing() {
        if (this.pairingTask !== void 0) return this.pairingTask;
        const operation = this.replacePairingToken();
        const tracked = operation.finally(() => {
          if (this.pairingTask !== tracked) return;
          this.pairingTask = void 0;
          this.publish();
        });
        this.pairingTask = tracked;
        this.publish();
        return tracked;
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
          saving: this.savingSettings,
          pairing: this.pairingTask !== void 0,
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
          webModelMode: read("webModelMode") === "expert" ? "expert" : "default",
          thinkingEnabled: read("thinkingEnabled") === true,
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
    var DeepSeekWebReasoningStore = class {
      listeners = /* @__PURE__ */ new Set();
      snapshot = { sessions: /* @__PURE__ */ new Map(), revision: 0 };
      abort = new AbortController();
      started = false;
      getSnapshot = () => this.snapshot;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      async start(remote) {
        if (this.started) return;
        this.started = true;
        try {
          for await (const frame of remote.follow(this.abort.signal)) this.accept(frame);
        } catch {
          if (!this.abort.signal.aborted) this.clear();
        }
      }
      dispose() {
        this.abort.abort();
        this.clear();
        this.listeners.clear();
      }
      accept(frame) {
        const sessions = new Map(this.snapshot.sessions);
        if (frame.phase === "start") {
          sessions.set(frame.sessionId, { requestId: frame.requestId, text: "", active: true });
        } else {
          const current = sessions.get(frame.sessionId);
          if (current === void 0 || current.requestId !== frame.requestId) return;
          if (frame.phase === "delta") {
            const joined = current.text + frame.text;
            sessions.set(frame.sessionId, {
              ...current,
              text: joined.length <= 131072 ? joined : `\u2026${joined.slice(-131071)}`
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
      clear() {
        if (this.snapshot.sessions.size === 0) return;
        this.snapshot = { sessions: /* @__PURE__ */ new Map(), revision: this.snapshot.revision + 1 };
        for (const listener of this.listeners) listener();
      }
    };
    function DeepSeekWebReasoningDock({
      sessionId,
      store,
      locale
    }) {
      const snapshot = import_react.default.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      import_react.default.useSyncExternalStore(
        (listener) => locale.subscribe(listener),
        () => locale.getSnapshot(),
        () => locale.getSnapshot()
      );
      const reasoning = snapshot.sessions.get(sessionId);
      if (reasoning === void 0 || reasoning.text === "") return null;
      const t = locale.bind(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE);
      return import_react.default.createElement(
        "details",
        {
          key: reasoning.requestId,
          open: reasoning.active || void 0,
          className: "dsh-deepseek-web-reasoning"
        },
        import_react.default.createElement(
          "summary",
          { className: "dsh-deepseek-web-reasoning-summary" },
          t(reasoning.active ? "reasoningWorking" : "reasoningDone")
        ),
        import_react.default.createElement("div", { className: "dsh-deepseek-web-reasoning-text" }, reasoning.text)
      );
    }
    function DeepSeekWebSettingsCard({
      controller,
      locale
    }) {
      const snapshot = import_react.default.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
      import_react.default.useSyncExternalStore(
        (listener) => locale.subscribe(listener),
        () => locale.getSnapshot(),
        () => locale.getSnapshot()
      );
      const t = locale.bind(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE);
      const [open, setOpen] = import_react.default.useState(false);
      const saveStarted = import_react.default.useRef(false);
      const formId = import_react.default.useId();
      const [pairingTokenValue, setPairingTokenValue] = import_react.default.useState(null);
      const [tokenCopied, setTokenCopied] = import_react.default.useState(false);
      const [importSourceHome, setImportSourceHome] = import_react.default.useState("");
      const [importRootSessionId, setImportRootSessionId] = import_react.default.useState("");
      const [sourceProcessesStopped, setSourceProcessesStopped] = import_react.default.useState(false);
      const [importing, setImporting] = import_react.default.useState(false);
      const [importStatus, setImportStatus] = import_react.default.useState(null);
      import_react.default.useEffect(() => {
        void controller.refresh();
      }, [controller]);
      import_react.default.useEffect(() => {
        if (snapshot.saving) {
          saveStarted.current = true;
          return;
        }
        if (!saveStarted.current) return;
        saveStarted.current = false;
        if (!snapshot.dirty && snapshot.error === null) setOpen(false);
      }, [snapshot.dirty, snapshot.error, snapshot.saving]);
      const settings = snapshot.draft;
      if (settings === void 0) return null;
      const disabled = !snapshot.settings.writable;
      const controlId = (name) => `${formId}-${name}`;
      const field = (id, label, input, hint, invalidMessage) => import_react.default.createElement(
        "div",
        { className: "dsh-deepseek-web-field" },
        import_react.default.createElement("label", { className: "dsh-deepseek-web-label", htmlFor: id }, label),
        input,
        import_react.default.createElement("p", {
          id: `${id}-hint`,
          className: invalidMessage === void 0 ? "dsh-deepseek-web-hint" : "dsh-deepseek-web-error",
          ...invalidMessage === void 0 ? {} : { role: "alert" }
        }, invalidMessage ?? hint)
      );
      const select = (id, value, selectDisabled, onChange, options) => import_react.default.createElement(
        "span",
        { className: "dsh-deepseek-web-select-wrap" },
        import_react.default.createElement("select", {
          id,
          className: "dsh-deepseek-web-control dsh-deepseek-web-select-control",
          value,
          disabled: selectDisabled,
          "aria-describedby": `${id}-hint`,
          onChange: (event) => onChange(event.currentTarget.value)
        }, ...options.map(([optionValue, optionLabel]) => import_react.default.createElement("option", { key: optionValue, value: optionValue }, optionLabel))),
        chevronIcon("dsh-deepseek-web-select-chevron")
      );
      const toggle = (id, label, hint, checked, toggleDisabled, onChange) => import_react.default.createElement(
        "div",
        { className: "dsh-deepseek-web-field" },
        import_react.default.createElement(
          "button",
          {
            id,
            type: "button",
            role: "switch",
            className: "dsh-deepseek-web-toggle",
            "aria-checked": checked,
            "aria-describedby": `${id}-hint`,
            disabled: toggleDisabled,
            onClick: () => onChange(!checked)
          },
          import_react.default.createElement("span", { className: "dsh-deepseek-web-toggle-label" }, label),
          import_react.default.createElement("span", {
            className: "dsh-deepseek-web-switch",
            "data-checked": checked,
            "aria-hidden": true
          }, import_react.default.createElement("span", { className: "dsh-deepseek-web-switch-thumb" }))
        ),
        import_react.default.createElement("p", { id: `${id}-hint`, className: "dsh-deepseek-web-hint" }, hint)
      );
      const section = (name, titleText, descriptionText, ...children) => {
        const titleId = controlId(`${name}-title`);
        return import_react.default.createElement(
          "section",
          {
            className: "dsh-deepseek-web-section",
            "aria-labelledby": titleId,
            "data-section": name
          },
          import_react.default.createElement(
            "div",
            { className: "dsh-deepseek-web-section-head" },
            import_react.default.createElement("h4", { id: titleId, className: "dsh-deepseek-web-section-title" }, titleText),
            import_react.default.createElement("p", { className: "dsh-deepseek-web-section-description" }, descriptionText)
          ),
          ...children
        );
      };
      const update = (name, value) => controller.editSetting(name, value);
      const createToken = (replace) => {
        setPairingTokenValue(null);
        setTokenCopied(false);
        void (replace ? controller.rePair() : controller.pair()).then(setPairingTokenValue, () => void 0);
      };
      const title = t("title");
      const status = snapshot.connection === void 0 ? t("connectionUnavailable") : formatText(t("connection"), { phase: connectionPhaseText(snapshot.connection.phase, t) }) + (snapshot.connection.pendingReconfigure ? t("changePending") : "");
      const statusId = controlId("status");
      const pendingId = controlId("pending");
      const header = import_react.default.createElement(
        "button",
        {
          type: "button",
          className: "dsh-deepseek-web-card-header",
          "aria-expanded": open,
          "aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
          "aria-describedby": snapshot.dirty ? `${statusId} ${pendingId}` : statusId,
          onClick: () => setOpen(!open)
        },
        import_react.default.createElement(
          "span",
          { className: "dsh-deepseek-web-head-text" },
          import_react.default.createElement("span", { className: "dsh-deepseek-web-name" }, title),
          import_react.default.createElement("span", { className: "dsh-deepseek-web-description" }, t("description")),
          import_react.default.createElement("span", {
            id: statusId,
            className: "dsh-deepseek-web-status",
            "data-phase": snapshot.connection?.phase ?? "unavailable"
          }, import_react.default.createElement("span", { className: "dsh-deepseek-web-status-dot", "aria-hidden": true }), status)
        ),
        snapshot.dirty ? import_react.default.createElement("span", { id: pendingId, className: "dsh-deepseek-web-pending" }, t("unsaved")) : null,
        chevronIcon(`dsh-deepseek-web-chevron${open ? " dsh-deepseek-web-chevron-open" : ""}`)
      );
      if (!open) return import_react.default.createElement("li", cardProps(false), header);
      const portInvalid = !validPortDraft(settings.port);
      const originInvalid = settings.browser === "firefox" ? !validFirefoxOriginDraft(settings.firefoxExtensionOrigin) : !validChromiumExtensionIdDraft(settings.chromiumExtensionId);
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
      return import_react.default.createElement(
        "li",
        cardProps(true),
        header,
        import_react.default.createElement(
          "div",
          {
            className: "dsh-deepseek-web-card-body",
            "aria-busy": snapshot.saving || snapshot.pairing || importing || snapshot.loading
          },
          disabled ? import_react.default.createElement("p", { role: "status", className: "dsh-deepseek-web-notice" }, t("readOnly")) : null,
          section(
            "connection",
            t("connectionTitle"),
            t("connectionDescription"),
            field(browserId, t("browser"), select(browserId, settings.browser, disabled, (value) => update("browser", value), [
              ["chrome", "Chrome"],
              ["edge", "Edge"],
              ["firefox", "Firefox"]
            ]), ""),
            settings.browser === "firefox" ? field(originId, t("firefoxExtensionOrigin"), import_react.default.createElement("input", {
              id: originId,
              className: "dsh-deepseek-web-control",
              value: settings.firefoxExtensionOrigin,
              disabled,
              placeholder: "moz-extension://\u2026",
              "aria-invalid": originInvalid || void 0,
              "aria-describedby": `${originId}-hint`,
              onChange: (event) => update("firefoxExtensionOrigin", event.currentTarget.value)
            }), t("firefoxExtensionOriginHint"), originInvalid ? t("invalidFirefoxExtensionOrigin") : void 0) : field(originId, t("chromiumExtensionId"), import_react.default.createElement("input", {
              id: originId,
              className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
              value: settings.chromiumExtensionId,
              disabled,
              autoComplete: "off",
              spellCheck: false,
              "aria-invalid": originInvalid || void 0,
              "aria-describedby": `${originId}-hint`,
              onChange: (event) => update("chromiumExtensionId", event.currentTarget.value)
            }), t("chromiumExtensionIdHint"), originInvalid ? t("invalidChromiumExtensionId") : void 0),
            field(portId, t("port"), import_react.default.createElement("input", {
              id: portId,
              className: "dsh-deepseek-web-control",
              type: "number",
              inputMode: "numeric",
              min: 1,
              max: 65535,
              value: settings.port,
              disabled,
              "aria-invalid": portInvalid || void 0,
              "aria-describedby": `${portId}-hint`,
              onChange: (event) => update("port", event.currentTarget.value)
            }), t("portHint"), portInvalid ? t("invalidPort") : void 0)
          ),
          section(
            "model",
            t("modelTitle"),
            t("modelDescription"),
            field(modelModeId, t("modelMode"), select(modelModeId, settings.webModelMode, disabled, (value) => update("webModelMode", value), [
              ["default", t("modelDefault")],
              ["expert", t("modelExpert")]
            ]), t("modelModeHint")),
            toggle(
              thinkingId,
              t("thinking"),
              t("thinkingHint"),
              settings.thinkingEnabled,
              disabled,
              (value) => update("thinkingEnabled", value)
            ),
            toggle(
              makeDefaultId,
              t("makeDefault"),
              t("makeDefaultHint"),
              settings.makeDefaultForNewSessions,
              disabled,
              (value) => update("makeDefaultForNewSessions", value)
            )
          ),
          section(
            "windows",
            t("windowsTitle"),
            t("windowsDescription"),
            import_react.default.createElement(
              "p",
              { className: "dsh-deepseek-web-state-line", role: "status" },
              windowsStatusText(snapshot.connection, t)
            ),
            toggle(
              windowsEnableId,
              t("windowsEnable"),
              t("windowsWarning"),
              settings.windowsCommandsEnabled,
              disabled,
              (value) => update("windowsCommandsEnabled", value)
            ),
            field(windowsApprovalId, t("windowsApproval"), select(
              windowsApprovalId,
              settings.windowsApprovalPolicy,
              disabled || !settings.windowsCommandsEnabled,
              (value) => update("windowsApprovalPolicy", value),
              [["ask", t("windowsAsk")], ["auto", t("windowsAuto")]]
            ), ""),
            field(executableId, t("powershellExecutable"), import_react.default.createElement("input", {
              id: executableId,
              className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
              value: settings.powerShellExecutable,
              disabled,
              placeholder: "pwsh or C:\\Program Files\\PowerShell\\7\\pwsh.exe",
              spellCheck: false,
              "aria-invalid": executableInvalid || void 0,
              "aria-describedby": `${executableId}-hint`,
              onChange: (event) => update("powerShellExecutable", event.currentTarget.value)
            }), t("powershellExecutableHint"), executableInvalid ? t("invalidPowerShellExecutable") : void 0)
          ),
          snapshot.conflicted ? import_react.default.createElement("p", { role: "alert", className: "dsh-deepseek-web-alert" }, t("conflict")) : null,
          section(
            "pairing",
            t("pairingTitle"),
            t("pairingDescription"),
            import_react.default.createElement(
              "p",
              { className: "dsh-deepseek-web-state-line", role: "status" },
              snapshot.credential.configured ? t("tokenConfigured") : t("tokenMissing")
            ),
            import_react.default.createElement(
              "div",
              { className: "dsh-deepseek-web-actions" },
              import_react.default.createElement("button", {
                type: "button",
                className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
                disabled: snapshot.pairing || !snapshot.credential.writable || snapshot.credential.configured,
                onClick: () => createToken(false)
              }, t("generateToken")),
              import_react.default.createElement("button", {
                type: "button",
                className: "dsh-deepseek-web-button dsh-deepseek-web-button-caution",
                disabled: snapshot.pairing || !snapshot.credential.writable,
                onClick: () => createToken(true)
              }, t("repair")),
              import_react.default.createElement("button", {
                type: "button",
                className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
                disabled: snapshot.pairing,
                onClick: () => {
                  void controller.reconnect().catch(() => void 0);
                }
              }, t("reconnect"))
            ),
            snapshot.pairing || pairingTokenValue === null ? null : import_react.default.createElement(
              "div",
              { className: "dsh-deepseek-web-token-panel" },
              import_react.default.createElement(
                "div",
                { className: "dsh-deepseek-web-token-row" },
                import_react.default.createElement("output", {
                  className: "dsh-deepseek-web-token-value",
                  "aria-label": t("newTokenLabel")
                }, pairingTokenValue),
                import_react.default.createElement("button", {
                  type: "button",
                  className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
                  onClick: () => {
                    void globalThis.navigator?.clipboard?.writeText(pairingTokenValue).then(() => setTokenCopied(true), () => void 0);
                  }
                }, t(tokenCopied ? "copied" : "copy"))
              ),
              import_react.default.createElement("p", { className: "dsh-deepseek-web-token-warning" }, t("tokenOnce"))
            )
          ),
          section(
            "import",
            t("importTitle"),
            t("importDescription"),
            field(importHomeId, t("importHome"), import_react.default.createElement("input", {
              id: importHomeId,
              className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
              value: importSourceHome,
              disabled: importing,
              placeholder: "C:\\Users\\you\\AppData\\Local\\DeepSeekWebAgent",
              spellCheck: false,
              onChange: (event) => setImportSourceHome(event.currentTarget.value)
            }), ""),
            field(importRootId, t("importRoot"), import_react.default.createElement("input", {
              id: importRootId,
              className: "dsh-deepseek-web-control dsh-deepseek-web-monospace",
              value: importRootSessionId,
              disabled: importing,
              spellCheck: false,
              onChange: (event) => setImportRootSessionId(event.currentTarget.value)
            }), ""),
            import_react.default.createElement(
              "label",
              { className: "dsh-deepseek-web-check-row" },
              import_react.default.createElement("input", {
                className: "dsh-deepseek-web-checkbox",
                type: "checkbox",
                checked: sourceProcessesStopped,
                disabled: importing,
                onChange: (event) => setSourceProcessesStopped(event.currentTarget.checked)
              }),
              import_react.default.createElement("span", null, t("importStopped"))
            ),
            import_react.default.createElement(
              "div",
              { className: "dsh-deepseek-web-actions dsh-deepseek-web-actions-end" },
              import_react.default.createElement("button", {
                type: "button",
                className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
                disabled: importing || !sourceProcessesStopped || importSourceHome.trim() === "" || importRootSessionId.trim() === "",
                onClick: () => {
                  setImporting(true);
                  setImportStatus(null);
                  void controller.importCompleted({
                    sourceHome: importSourceHome.trim(),
                    rootSessionId: importRootSessionId.trim(),
                    sourceProcessesStopped: true
                  }).then((receipt) => {
                    setImportStatus(formatText(t("imported"), { imported: receipt.imported, idempotent: receipt.idempotent }));
                  }, (error) => {
                    setImportStatus(error instanceof Error ? error.message : t("importFailed"));
                  }).finally(() => setImporting(false));
                }
              }, importing ? t("importing") : t("importAction"))
            ),
            importStatus === null ? null : import_react.default.createElement("p", { role: "status", className: "dsh-deepseek-web-notice" }, importStatus)
          ),
          snapshot.error === null ? null : import_react.default.createElement("p", { role: "alert", className: "dsh-deepseek-web-alert" }, snapshot.error),
          import_react.default.createElement(
            "div",
            { className: "dsh-deepseek-web-card-footer" },
            import_react.default.createElement("button", {
              type: "button",
              className: "dsh-deepseek-web-button dsh-deepseek-web-button-secondary",
              disabled: !snapshot.dirty || snapshot.saving,
              onClick: () => controller.discardSettings()
            }, t("discard")),
            import_react.default.createElement("button", {
              type: "button",
              className: "dsh-deepseek-web-button dsh-deepseek-web-button-primary",
              disabled: disabled || !snapshot.dirty || snapshot.invalid || snapshot.conflicted || snapshot.saving,
              onClick: () => {
                void controller.saveSettings().catch(() => void 0);
              }
            }, snapshot.saving ? t("saving") : t("save"))
          )
        )
      );
    }
    function chevronIcon(className) {
      return import_react.default.createElement("svg", {
        className,
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: "none",
        "aria-hidden": true
      }, import_react.default.createElement("path", {
        d: "M3.25 5.25 7 9l3.75-3.75",
        stroke: "currentColor",
        strokeWidth: 1.25,
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }));
    }
    async function apply(ctx) {
      const client = ctx;
      const unmountRemote = await client.remote.$mount(DEEPSEEK_WEB_CLIENT_REMOTE_CONTRIBUTION);
      const settingsFiber = client.inject(DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT, (injectedCtx) => {
        const injected = injectedCtx;
        injected.effect(
          () => injected.locale.register(DEEPSEEK_WEB_SETTINGS_LOCALE_NAMESPACE, settingsLocales),
          "deepseek-web: settings dictionaries"
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
          inject: (sessionId) => ({ sessionId, store: reasoningStore, locale: injected.locale })
        }, DeepSeekWebReasoningDock));
        injected.slots.inject("settings.plugin.item", () => {
          const settings = injected.settingsScope.bind({
            namespace: DEEPSEEK_WEB_SETTINGS_NAMESPACE,
            decode: decodeSettings
          });
          const controller = new DeepSeekWebClientController({
            settings,
            credentials: injected.remote.credentials,
            callConnection: (method) => injected.remote[DEEPSEEK_WEB_CONNECTION_NAMESPACE][method](),
            importCompleted: (request) => injected.remote[DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE].importCompleted(request)
          });
          const unregister = injected.slots.register({
            name: "settings.plugin.item",
            key: DEEPSEEK_WEB_SETTINGS_NAMESPACE
          }, () => import_react.default.createElement(DeepSeekWebSettingsCard, { controller, locale: injected.locale }));
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
    function decodeSettings(value) {
      if (!isRecord2(value)) return void 0;
      const browser = value.browser;
      if (browser !== "chrome" && browser !== "edge" && browser !== "firefox") return void 0;
      if (typeof value.chromiumExtensionId !== "string" || typeof value.firefoxExtensionOrigin !== "string" || !Number.isSafeInteger(value.port) || typeof value.makeDefaultForNewSessions !== "boolean" || typeof value.windowsCommandsEnabled !== "boolean" || value.windowsApprovalPolicy !== "ask" && value.windowsApprovalPolicy !== "auto") return void 0;
      if (typeof value.powerShellExecutable !== "string") return void 0;
      const webModelMode = value.webModelMode === void 0 ? "default" : value.webModelMode;
      const thinkingEnabled = value.thinkingEnabled === void 0 ? false : value.thinkingEnabled;
      if (webModelMode !== "default" && webModelMode !== "expert" || typeof thinkingEnabled !== "boolean") return void 0;
      return {
        browser,
        chromiumExtensionId: value.chromiumExtensionId,
        firefoxExtensionOrigin: value.firefoxExtensionOrigin,
        port: value.port,
        webModelMode,
        thinkingEnabled,
        makeDefaultForNewSessions: value.makeDefaultForNewSessions,
        windowsCommandsEnabled: value.windowsCommandsEnabled,
        windowsApprovalPolicy: value.windowsApprovalPolicy,
        powerShellExecutable: value.powerShellExecutable
      };
    }
    function parseConnectionStatus(value) {
      if (!isRecord2(value)) throw new Error("Invalid DeepSeek Web connection status");
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
      if (!isRecord2(value) || typeof value.accepted !== "boolean" || typeof value.deferred !== "boolean" || value.reason !== void 0 && value.reason !== "busy" && value.reason !== "unconfigured") {
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
      if (!validPowerShellExecutableDraft(value.powerShellExecutable)) return false;
      if (value.browser !== "chrome" && value.browser !== "edge" && value.browser !== "firefox") return false;
      if (!validPortDraft(value.port)) return false;
      if (value.browser === "firefox") {
        return validFirefoxOriginDraft(value.firefoxExtensionOrigin);
      }
      return validChromiumExtensionIdDraft(value.chromiumExtensionId);
    }
    function validPortDraft(value) {
      if (!/^[1-9][0-9]{0,4}$/u.test(value)) return false;
      const port = Number(value);
      return Number.isSafeInteger(port) && port <= 65535;
    }
    function validFirefoxOriginDraft(value) {
      return value === "" || /^moz-extension:\/\/[a-zA-Z0-9_-]+$/u.test(value);
    }
    function validChromiumExtensionIdDraft(value) {
      return value === "" || /^[a-p]{32}$/u.test(value);
    }
    function validPowerShellExecutableDraft(value) {
      return !value.includes("\0") && value.length <= 1024;
    }
    function normalizedSettingValue(field, value) {
      return field === "port" ? Number(value) : value;
    }
    function validWindowsStatus(value) {
      if (!isRecord2(value)) return false;
      if (value.kind === "disabled") return Object.keys(value).length === 1;
      if (value.kind === "available") {
        return Object.keys(value).every((key) => key === "kind" || key === "executable" || key === "major") && typeof value.executable === "string" && Number.isSafeInteger(value.major) && Number(value.major) >= 7;
      }
      return value.kind === "unavailable" && value.code === "POWERSHELL_7_REQUIRED" && typeof value.message === "string" && Object.keys(value).every((key) => key === "kind" || key === "code" || key === "message");
    }
    function windowsStatusText(connection, t) {
      const status = connection?.windows;
      if (status === void 0) return t("windowsUnavailable");
      if (status.kind === "disabled") return t("windowsDisabled");
      if (status.kind === "available") {
        return formatText(t("windowsReady"), { major: status.major, executable: status.executable });
      }
      return status.message;
    }
    function connectionPhaseText(phase, t) {
      if (phase === "unconfigured") return t("phaseUnconfigured");
      if (phase === "waiting_for_browser") return t("phaseWaiting");
      if (phase === "connected") return t("phaseConnected");
      if (phase === "busy") return t("phaseBusy");
      return t("phaseError");
    }
    function formatText(template, values) {
      return template.replace(/\{([^}]+)\}/gu, (whole, key) => Object.hasOwn(values, key) ? String(values[key]) : whole);
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
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function cardProps(open) {
      return {
        "aria-label": "DeepSeek Web",
        "data-dsh-plugin-card": DEEPSEEK_WEB_SETTINGS_NAMESPACE,
        "data-open": open,
        className: "dsh-deepseek-web-card"
      };
    }
    var DEEPSEEK_WEB_CLIENT_STYLE_ID = "@deepseek-pp/dsh-deepseek-web-official-plugin/client.css";
    var deepSeekWebStyleUsers = 0;
    var ownedDeepSeekWebStyle;
    function installDeepSeekWebClientStyles() {
      deepSeekWebStyleUsers += 1;
      if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${DEEPSEEK_WEB_CLIENT_STYLE_ID}"]`) === null) {
        const style = document.createElement("style");
        style.dataset.plugin = "@deepseek-pp/dsh-deepseek-web-official-plugin";
        style.dataset.pluginCss = DEEPSEEK_WEB_CLIENT_STYLE_ID;
        style.textContent = DEEPSEEK_WEB_CLIENT_CSS;
        document.head.appendChild(style);
        ownedDeepSeekWebStyle = style;
      }
      return () => {
        deepSeekWebStyleUsers = Math.max(0, deepSeekWebStyleUsers - 1);
        if (deepSeekWebStyleUsers !== 0 || ownedDeepSeekWebStyle === void 0) return;
        ownedDeepSeekWebStyle.remove();
        ownedDeepSeekWebStyle = void 0;
      };
    }
    var DEEPSEEK_WEB_CLIENT_CSS = String.raw`
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
    return module.exports;
  }
});
