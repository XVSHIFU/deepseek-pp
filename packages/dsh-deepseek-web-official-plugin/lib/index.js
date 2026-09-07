// src/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

// src/config.ts
import z from "@deepseek-ai/schemastery";

// src/connection-contract.ts
var DEEPSEEK_WEB_SETTINGS_NAMESPACE = "deepseek-web";
var DEEPSEEK_WEB_PAIRING_TOKEN_REF = "DSH_WEB_PAIRING_TOKEN";
var DEEPSEEK_WEB_PROVIDER = "deepseek-web";
var DEEPSEEK_WEB_MODEL = "current-web-session";
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

// src/config.ts
var DEFAULT_DEEPSEEK_WEB_BROKER_PORT = 43123;
var DeepSeekWebOfficialSettings = z.object({
  browser: z.union(["chrome", "edge", "firefox"]).default("chrome"),
  chromiumExtensionId: z.string().default(""),
  firefoxExtensionOrigin: z.string().default(""),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_DEEPSEEK_WEB_BROKER_PORT),
  makeDefaultForNewSessions: z.boolean().default(false),
  windowsCommandsEnabled: z.boolean().default(false),
  windowsApprovalPolicy: z.union(["ask", "auto"]).default("ask"),
  powerShellExecutable: z.string().default("")
});
function validateOfficialSettings(value) {
  if (value.powerShellExecutable.includes("\0") || value.powerShellExecutable.length > 1024) {
    throw new Error("powerShellExecutable must be at most 1024 characters and contain no NUL byte");
  }
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

// src/connection-controller.ts
import {
  BrokerError,
  DeepSeekWebModelHost
} from "@deepseek-pp/dsh-web-model-transport";
var DeepSeekWebConnectionController = class {
  constructor(options) {
    this.options = options;
    this.broker = new TrackedBroker(this);
  }
  options;
  broker;
  host;
  cleanupHosts = /* @__PURE__ */ new Set();
  activeOperations = 0;
  tokenConfigured = false;
  pendingReconfigure = false;
  stopped = false;
  lastErrorCode;
  tail = Promise.resolve();
  async start() {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    await this.queueReconfigure();
  }
  status() {
    const settings = this.options.readSettings();
    const originConfigured = extensionOrigin(settings) !== void 0;
    const configured = originConfigured && this.tokenConfigured;
    const busy = this.activeOperations > 0;
    let phase;
    if (this.lastErrorCode !== void 0) phase = "error";
    else if (!configured || this.host === void 0) phase = "unconfigured";
    else if (busy) phase = "busy";
    else if (this.host.hasAuthenticatedPeer) phase = "connected";
    else phase = "waiting_for_browser";
    return Object.freeze({
      phase,
      configured,
      tokenConfigured: this.tokenConfigured,
      originConfigured,
      busy,
      pendingReconfigure: this.pendingReconfigure,
      browser: settings.browser,
      port: settings.port,
      windows: this.options.readWindowsStatus?.() ?? { kind: "disabled" },
      ...this.lastErrorCode === void 0 ? {} : { errorCode: this.lastErrorCode }
    });
  }
  async requestReconfigure(reason) {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    if (this.activeOperations > 0) {
      if (reason === "reconnect") {
        return { accepted: false, deferred: false, reason: "busy", status: this.status() };
      }
      this.pendingReconfigure = true;
      return { accepted: true, deferred: true, status: this.status() };
    }
    await this.queueReconfigure();
    const status = this.status();
    return {
      accepted: status.configured,
      deferred: false,
      ...status.configured ? {} : { reason: "unconfigured" },
      status
    };
  }
  async dispose() {
    this.stopped = true;
    this.pendingReconfigure = false;
    await this.tail;
    const host = this.host;
    this.host = void 0;
    if (host !== void 0) this.cleanupHosts.add(host);
    const failures = [];
    for (const candidate of this.cleanupHosts) {
      try {
        await candidate.stop();
        this.cleanupHosts.delete(candidate);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DeepSeek Web connection cleanup failed");
  }
  delegate() {
    if (this.host === void 0) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.host;
  }
  operationStarted() {
    this.activeOperations += 1;
  }
  operationFinished() {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0 || !this.pendingReconfigure || this.stopped) return;
    this.pendingReconfigure = false;
    void this.queueReconfigure().catch((error) => {
      this.lastErrorCode = "CONNECTION_START_FAILED";
      this.options.reportError?.(error);
    });
  }
  queueReconfigure() {
    const next = this.tail.then(() => this.reconfigure());
    this.tail = next.catch(() => void 0);
    return next;
  }
  async reconfigure() {
    if (this.stopped) return;
    if (this.activeOperations > 0) {
      this.pendingReconfigure = true;
      return;
    }
    const previous = this.host;
    this.host = void 0;
    this.lastErrorCode = void 0;
    if (previous !== void 0) {
      this.cleanupHosts.add(previous);
      try {
        await previous.stop();
        this.cleanupHosts.delete(previous);
      } catch (error) {
        this.connectionFailed(error);
        return;
      }
    }
    let next;
    try {
      const settings = this.options.readSettings();
      const origin = extensionOrigin(settings);
      const pairingToken = await this.options.resolvePairingToken();
      this.tokenConfigured = pairingToken !== void 0;
      if (origin === void 0 || pairingToken === void 0) return;
      next = this.options.createHost({
        pairingToken,
        allowedOrigins: [origin],
        port: settings.port
      });
      this.cleanupHosts.add(next);
      await next.start();
      if (this.stopped) {
        await next.stop();
        this.cleanupHosts.delete(next);
        return;
      }
      this.host = next;
      this.cleanupHosts.delete(next);
    } catch (error) {
      let reported = error;
      if (next !== void 0) {
        try {
          await next.stop();
          this.cleanupHosts.delete(next);
        } catch (cleanupError) {
          reported = new AggregateError([error, cleanupError], "DeepSeek Web connection startup cleanup failed");
        }
      }
      this.tokenConfigured = false;
      this.connectionFailed(reported);
    }
  }
  connectionFailed(error) {
    this.lastErrorCode = "CONNECTION_START_FAILED";
    this.options.reportError?.(error);
  }
};
function createDeepSeekWebModelHost(options) {
  return new DeepSeekWebModelHost(options);
}
var TrackedBroker = class {
  constructor(owner) {
    this.owner = owner;
  }
  owner;
  async *generate(request) {
    this.owner.operationStarted();
    try {
      yield* this.owner.delegate().generate(request);
    } finally {
      this.owner.operationFinished();
    }
  }
  async cancel(request) {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().cancel(request);
    } finally {
      this.owner.operationFinished();
    }
  }
  async query(request) {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().query(request);
    } finally {
      this.owner.operationFinished();
    }
  }
};

// src/connection-remote.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
var DeepSeekWebConnectionRemote = class extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, "deepseekWebConnection");
    this.controller = controller;
    for (const initialize of remoteInitializers) initialize.call(this);
  }
  controller;
  status() {
    return projectStatus(this.controller.status());
  }
  async reconnect() {
    const receipt = await this.controller.requestReconfigure("reconnect");
    return Object.freeze({
      accepted: receipt.accepted,
      deferred: receipt.deferred,
      ...receipt.reason === void 0 ? {} : { reason: receipt.reason },
      status: projectStatus(receipt.status)
    });
  }
};
function projectStatus(status) {
  return Object.freeze({
    phase: status.phase,
    configured: status.configured,
    tokenConfigured: status.tokenConfigured,
    originConfigured: status.originConfigured,
    busy: status.busy,
    pendingReconfigure: status.pendingReconfigure,
    browser: status.browser,
    port: status.port,
    windows: Object.freeze({ ...status.windows }),
    ...status.errorCode === void 0 ? {} : { errorCode: status.errorCode }
  });
}
var remoteInitializers = [];
markRemote("status");
markRemote("reconnect");
function markRemote(method) {
  const decorate = Remote;
  decorate(DeepSeekWebConnectionRemote.prototype[method], {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    }
  });
}

// src/windows-powershell.ts
import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";
var POWERSHELL_7_REQUIRED = "POWERSHELL_7_REQUIRED";
var WINDOWS_COMMANDS_DISABLED = "WINDOWS_COMMANDS_DISABLED";
var WINDOWS_BACKGROUND_COMMANDS_DISABLED = "WINDOWS_BACKGROUND_COMMANDS_DISABLED";
var WINDOWS_COMMAND_POLICY_NOT_APPLIED = "WINDOWS_COMMAND_POLICY_NOT_APPLIED";
var WINDOWS_SESSION_POLICY_UNAVAILABLE = "WINDOWS_SESSION_POLICY_UNAVAILABLE";
var WINDOWS_COMMAND_DISCLOSURE = "Commands run with the current Windows user's permissions; cwd is not a sandbox or an isolation boundary.";
var POWERSHELL_PROBE_TIMEOUT_MS = 3e3;
var SESSION_POLICY_FILE_MAX_BYTES = 1024 * 1024;
var SESSION_POLICY_MAX_ENTRIES = 1e4;
var JsonWindowsSessionPolicyStore = class {
  filePath;
  tail = Promise.resolve();
  document;
  constructor(filePath) {
    if (!isAbsolute(filePath)) throw new Error("windows session policy path must be absolute");
    this.filePath = filePath;
  }
  get(sessionId, identity) {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    return this.enqueue(async () => {
      const record = (await this.load()).sessions[sessionId];
      return record?.identity === identity ? record.policy : void 0;
    });
  }
  putIfAbsent(sessionId, identity, policy) {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    const validated = resolveWindowsPowerShellConfig(policy);
    return this.enqueue(async () => {
      const current = await this.load();
      const existing = current.sessions[sessionId];
      if (existing !== void 0) {
        if (existing.identity !== identity) throw new Error("windows session policy identity does not match");
        return existing.policy;
      }
      if (Object.keys(current.sessions).length >= SESSION_POLICY_MAX_ENTRIES) {
        throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
      }
      const next = {
        version: 2,
        sessions: { ...current.sessions, [sessionId]: { identity, policy: validated } }
      };
      await writePolicyDocument(this.filePath, next);
      this.document = freezePolicyDocument(next);
      return validated;
    });
  }
  async flush() {
    await this.tail;
  }
  enqueue(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => void 0, () => void 0);
    return result;
  }
  async load() {
    if (this.document !== void 0) return this.document;
    await assertNoSymlinkComponents(this.filePath);
    let text;
    try {
      const file = await open(this.filePath, "r");
      try {
        const stats = await file.stat();
        if (stats.size > SESSION_POLICY_FILE_MAX_BYTES) {
          throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
        }
        text = await file.readFile("utf8");
        if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_FILE_MAX_BYTES) {
          throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.document = freezePolicyDocument({ version: 2, sessions: {} });
        return this.document;
      }
      throw error;
    }
    this.document = parsePolicyDocument(text);
    return this.document;
  }
};
function resolveWindowsPowerShellConfig(config) {
  if (config.enabled !== void 0 && typeof config.enabled !== "boolean") {
    throw new Error("windowsPowerShell.enabled must be a boolean");
  }
  if (config.approvalPolicy !== void 0 && config.approvalPolicy !== "ask" && config.approvalPolicy !== "auto") {
    throw new Error("windowsPowerShell.approvalPolicy must be ask or auto");
  }
  return {
    enabled: config.enabled ?? false,
    approvalPolicy: config.approvalPolicy ?? "ask"
  };
}
async function probePowerShell7(ctx, executable, signal, timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS) {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw powerShell7Error("no PowerShell 7 executable was configured");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("PowerShell probe timeout must be positive");
  const deadline = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal === void 0 ? deadline : AbortSignal.any([signal, deadline]);
  let resolved;
  try {
    resolved = await raceAbort(
      ctx.subprocess.resolveExecutable(executable.trim(), void 0, operationSignal),
      operationSignal
    );
  } catch (cause) {
    if (deadline.aborted && !signal?.aborted) {
      throw powerShell7Error(`probe timed out after ${timeoutMs}ms while resolving the executable`, cause);
    }
    throw powerShell7Error(`cannot resolve ${JSON.stringify(executable.trim())}`, cause);
  }
  const handle = ctx.subprocess.spawn({
    argv: [
      resolved,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write($PSVersionTable.PSVersion.Major)"
    ],
    cwd: process.cwd(),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 64 },
      stderr: { maxBytes: 512 }
    },
    graceMs: 500,
    signal: operationSignal
  });
  try {
    const outcome = await raceAbort(handle.done, operationSignal);
    await handle.waitForExit(operationSignal);
    const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? "";
    const major = Number(stdout);
    if (outcome.exitCode !== 0 || !Number.isSafeInteger(major) || major < 7) {
      const detail = stderr.length > 0 ? stderr : `reported major version ${stdout || "unknown"}`;
      throw powerShell7Error(`${resolved} is not PowerShell 7 (${detail})`);
    }
    return { executable: resolved, major };
  } catch (cause) {
    handle.terminate();
    await handle.waitForExit().catch(() => false);
    if (deadline.aborted && !signal?.aborted) {
      throw powerShell7Error(`probe timed out after ${timeoutMs}ms`, cause);
    }
    if (cause instanceof Error && cause.message.startsWith(POWERSHELL_7_REQUIRED)) throw cause;
    throw powerShell7Error(`failed to verify ${resolved}`, cause);
  }
}
function raceAbort(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    operation,
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  ]);
}
async function installWindowsPowerShellPolicy(ctx, input, sessionPolicies, readCurrentConfig, readRequiredExecutable) {
  let defaultConfig = resolveWindowsPowerShellConfig(input);
  let verifiedPowerShell;
  let verifiedDeclaredPath;
  let status = { kind: "disabled" };
  const policies = /* @__PURE__ */ new WeakMap();
  const pendingWrites = /* @__PURE__ */ new Set();
  const configuredExecutable = () => {
    if (process.platform !== "win32") {
      throw powerShell7Error("native Windows commands are available on Windows only");
    }
    const shell = ctx.get("shell");
    if (shell === void 0 || typeof shell.pwshPath !== "string" || shell.pwshPath.trim().length === 0) {
      throw powerShell7Error("the official PowerShell executor is not mounted");
    }
    const actual = shell.pwshPath.trim();
    const required = readRequiredExecutable?.().trim() ?? "";
    if (required !== "" && actual !== required) {
      throw powerShell7Error("the configured executable has not been applied by the official Shell settings");
    }
    return actual;
  };
  const ensureAvailable = async (signal, force = false) => {
    try {
      const executable = configuredExecutable();
      if (!force && verifiedPowerShell !== void 0 && verifiedDeclaredPath === executable) {
        return verifiedPowerShell;
      }
      const powershell = await probePowerShell7(ctx, executable, signal);
      verifiedPowerShell = powershell;
      verifiedDeclaredPath = executable;
      status = { kind: "available", powershell };
      return powershell;
    } catch (error) {
      if (signal?.aborted) return void 0;
      verifiedPowerShell = void 0;
      verifiedDeclaredPath = void 0;
      const message = error instanceof Error ? error.message : `${POWERSHELL_7_REQUIRED}: ${String(error)}`;
      status = { kind: "unavailable", code: POWERSHELL_7_REQUIRED, message };
      return void 0;
    }
  };
  const refreshStatus = async () => {
    if (!defaultConfig.enabled) {
      status = { kind: "disabled" };
      return status;
    }
    await ensureAvailable(void 0, true);
    return status;
  };
  const trackWrite = (write) => {
    pendingWrites.add(write);
    void write.finally(() => {
      pendingWrites.delete(write);
    });
    return write;
  };
  const createState = (session) => {
    const existing = policies.get(session);
    if (existing !== void 0) return existing;
    const isNew = Number(session.firstLiveSeq) === 0;
    const currentDefault = resolveWindowsPowerShellConfig(readCurrentConfig?.() ?? defaultConfig);
    const state = {
      policy: isNew ? currentDefault : DISABLED_SESSION_POLICY,
      ready: Promise.resolve()
    };
    policies.set(session, state);
    const identity = windowsSessionPolicyIdentity(session);
    const operation = isNew ? sessionPolicies.putIfAbsent(String(session.id), identity, state.policy) : sessionPolicies.get(String(session.id), identity);
    const ready = operation.then((stored) => {
      state.policy = stored ?? DISABLED_SESSION_POLICY;
    }, (error) => {
      state.policy = DISABLED_SESSION_POLICY;
      state.failure = `${WINDOWS_SESSION_POLICY_UNAVAILABLE}: ${errorMessage(error)}`;
    });
    state.ready = isNew ? trackWrite(ready) : ready;
    return state;
  };
  const policyFor = async (session) => {
    if (session === void 0) {
      return { policy: DISABLED_SESSION_POLICY, ready: Promise.resolve() };
    }
    const cached = policies.get(session);
    const state = cached ?? createState(session);
    await state.ready;
    return state;
  };
  const flush = async () => {
    await Promise.all([...pendingWrites]);
    await sessionPolicies.flush();
  };
  ctx.effect(() => async () => {
    await flush();
  });
  ctx.on("session/created", (session) => {
    createState(session);
  });
  await refreshStatus();
  const admitted = /* @__PURE__ */ new WeakSet();
  ctx.on("tools/result", (exec) => {
    admitted.delete(exec);
  });
  ctx.tools.guard((exec) => {
    if (exec.name !== "pwsh") return void 0;
    const state = exec.agent === void 0 ? void 0 : policies.get(exec.agent.session);
    if (state === void 0 || !state.policy.enabled) return WINDOWS_COMMANDS_DISABLED;
    if (requestsBackgroundExecution(exec)) return WINDOWS_BACKGROUND_COMMANDS_DISABLED;
    const allowed = admitted.has(exec);
    admitted.delete(exec);
    return allowed ? void 0 : WINDOWS_COMMAND_POLICY_NOT_APPLIED;
  });
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "pwsh") return next();
    const state = await policyFor(exec.agent?.session);
    if (state.failure !== void 0) return { kind: "deny", reason: state.failure };
    const policy = state.policy;
    if (!policy.enabled) return { kind: "deny", reason: WINDOWS_COMMANDS_DISABLED };
    if (requestsBackgroundExecution(exec)) {
      return { kind: "deny", reason: WINDOWS_BACKGROUND_COMMANDS_DISABLED };
    }
    if (await ensureAvailable(exec.signal) === void 0) {
      if (exec.signal.aborted) {
        admitted.add(exec);
        return next();
      }
      const unavailable = status.kind === "unavailable" ? status.message : POWERSHELL_7_REQUIRED;
      return { kind: "deny", reason: unavailable };
    }
    admitted.add(exec);
    if (policy.approvalPolicy === "auto") return next();
    return {
      kind: "ask",
      reason: `Approve this one foreground PowerShell 7 command. ${WINDOWS_COMMAND_DISCLOSURE}`
    };
  }, { prepend: true });
  return {
    get config() {
      return defaultConfig;
    },
    get status() {
      return status;
    },
    async update(nextInput) {
      defaultConfig = resolveWindowsPowerShellConfig(nextInput);
      return refreshStatus();
    },
    flush
  };
}
var DISABLED_SESSION_POLICY = Object.freeze({
  enabled: false,
  approvalPolicy: "ask"
});
function windowsSessionPolicyIdentity(session) {
  const header = session.header;
  return createHash("sha256").update(JSON.stringify([
    header.version,
    header.id,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded,
    header.origin ?? null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null
  ])).digest("hex");
}
function requestsBackgroundExecution(exec) {
  const args = plainRecord(exec.arguments);
  return args?.run_in_background === true;
}
function plainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : void 0;
}
function powerShell7Error(message, cause) {
  return new Error(`${POWERSHELL_7_REQUIRED}: ${message}`, cause === void 0 ? {} : { cause });
}
function parsePolicyDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("windows session policy file is not valid JSON", { cause });
  }
  if (!hasExactKeys(parsed, ["version", "sessions"]) || parsed.version !== 2 || !isPlainRecord(parsed.sessions)) {
    throw new Error("windows session policy file must be exactly {version:2,sessions:{...}}");
  }
  const entries = Object.entries(parsed.sessions);
  if (entries.length > SESSION_POLICY_MAX_ENTRIES) {
    throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
  }
  const sessions = /* @__PURE__ */ Object.create(null);
  for (const [sessionId, value] of entries) {
    validateSessionId(sessionId);
    if (!hasExactKeys(value, ["identity", "policy"]) || !hasExactKeys(value.policy, ["enabled", "approvalPolicy"])) {
      throw new Error(`windows session policy for ${JSON.stringify(sessionId)} has unknown or missing fields`);
    }
    validateSessionIdentity(value.identity);
    sessions[sessionId] = Object.freeze({
      identity: value.identity,
      policy: Object.freeze(resolveWindowsPowerShellConfig(value.policy))
    });
  }
  return freezePolicyDocument({ version: 2, sessions });
}
function freezePolicyDocument(document) {
  const sessions = /* @__PURE__ */ Object.create(null);
  for (const [sessionId, record] of Object.entries(document.sessions)) {
    sessions[sessionId] = Object.freeze({ identity: record.identity, policy: Object.freeze({ ...record.policy }) });
  }
  return Object.freeze({ version: 2, sessions: Object.freeze(sessions) });
}
async function writePolicyDocument(filePath, document) {
  const directory = dirname(filePath);
  await assertNoSymlinkComponents(filePath);
  await mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(filePath);
  const text = `${JSON.stringify(document)}
`;
  if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_FILE_MAX_BYTES) {
    throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
  }
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, "wx", 384);
    created = true;
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}
async function assertNoSymlinkComponents(filePath) {
  const root = parse(filePath).root;
  let current = root;
  for (const component of relative(root, filePath).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`windows session policy path contains a symbolic link or reparse point: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) break;
      throw error;
    }
  }
}
function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256 || sessionId === "__proto__" || sessionId === "prototype" || sessionId === "constructor") {
    throw new Error("windows session policy session id is invalid");
  }
}
function validateSessionIdentity(identity) {
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error("windows session policy identity is invalid");
  }
}
function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/managed-broker.ts
import {
  BrokerError as BrokerError2
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
    if (this.delegate === void 0) throw new BrokerError2("WAITING_FOR_BROWSER", "not_started");
    return this.delegate;
  }
};

// src/index.ts
var name = "deepseek-web-official";
var inject = ["settings", "credentials", "agentDefaultModel", "tools", "subprocess", "shell"];
async function apply(ctx) {
  const settings = ctx.settings.register(
    DEEPSEEK_WEB_SETTINGS_NAMESPACE,
    DeepSeekWebOfficialSettings,
    { applies: "live", validate: validateOfficialSettings }
  );
  await applyPowerShellExecutable(ctx, settings.get().powerShellExecutable, false).catch((error) => {
    ctx.logger.warn("DeepSeek Web could not apply the PowerShell executable setting");
    ctx.logger.warn(error);
  });
  const windowsPolicy = await installWindowsPowerShellPolicy(
    ctx,
    windowsConfig(settings.get()),
    new JsonWindowsSessionPolicyStore(
      dshHomePath("profiles", "web", "deepseek-web-official", "windows-session-policies.json")
    ),
    () => windowsConfig(settings.get()),
    () => settings.get().powerShellExecutable
  );
  const connection = new DeepSeekWebConnectionController({
    readSettings: () => settings.get(),
    resolvePairingToken: async () => (await ctx.credentials.resolve(credentialRef(DEEPSEEK_WEB_PAIRING_TOKEN_REF)))?.value,
    createHost: (options) => createDeepSeekWebModelHost({
      ...options,
      journalPath: dshHomePath("profiles", "web", "deepseek-web-model-journal")
    }),
    readWindowsStatus: () => projectWindowsStatus(windowsPolicy.status),
    reportError: (error) => {
      ctx.logger.warn("DeepSeek Web connection reconfiguration failed");
      ctx.logger.warn(error);
    }
  });
  const unprovide = ctx.provide("deepseekWebBroker", connection.broker);
  new DeepSeekWebConnectionRemote(ctx, connection);
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
      return connection.requestReconfigure("credential").then(() => void 0);
    }
  });
  try {
    await connection.start();
    await applyRequestedDefault(ctx, settings.get(), () => settings.update({ makeDefaultForNewSessions: false }));
  } catch (error) {
    const cleanupFailures = [];
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
        "DeepSeek Web official plugin startup cleanup failed"
      );
    }
    throw error;
  }
  return async () => {
    stopWatchingCredential();
    stopWatchingSettings();
    const failures = [];
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
function windowsConfig(settings) {
  return {
    enabled: settings.windowsCommandsEnabled,
    approvalPolicy: settings.windowsApprovalPolicy
  };
}
function connectionSettingsChanged(left, right) {
  return left.browser !== right.browser || left.chromiumExtensionId !== right.chromiumExtensionId || left.firefoxExtensionOrigin !== right.firefoxExtensionOrigin || left.port !== right.port;
}
function windowsSettingsChanged(left, right) {
  return left.windowsCommandsEnabled !== right.windowsCommandsEnabled || left.windowsApprovalPolicy !== right.windowsApprovalPolicy || left.powerShellExecutable !== right.powerShellExecutable;
}
async function applyPowerShellExecutable(ctx, input, clearWhenEmpty) {
  if (process.platform !== "win32") return;
  const executable = input.trim();
  const current = ctx.get("shell");
  if (executable !== "" && current?.pwshPath === executable) return;
  if (executable === "" && !clearWhenEmpty) return;
  if (executable === "") {
    await ctx.settings.mutate("shell", [{ op: "unset", path: ["pwshPath"] }]);
    return;
  }
  await ctx.settings.update("shell", { pwshPath: executable });
}
function projectWindowsStatus(status) {
  if (status.kind === "available") {
    return { kind: "available", executable: status.powershell.executable, major: status.powershell.major };
  }
  if (status.kind === "unavailable") {
    return { kind: "unavailable", code: status.code, message: status.message };
  }
  return { kind: "disabled" };
}
async function applyRequestedDefault(ctx, settings, consume) {
  if (!settings.makeDefaultForNewSessions) return;
  const authority = ctx.get("agentDefaultModel");
  if (authority === void 0) throw new Error("DEEPSEEK_WEB_DEFAULT_MODEL_AUTHORITY_UNAVAILABLE");
  await authority.saveSelection({
    provider: DEEPSEEK_WEB_PROVIDER,
    model: DEEPSEEK_WEB_MODEL
  });
  await consume?.();
}
export {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  DEEPSEEK_WEB_SETTINGS_NAMESPACE,
  DEFAULT_DEEPSEEK_WEB_BROKER_PORT,
  DeepSeekWebConnectionController,
  DeepSeekWebConnectionRemote,
  DeepSeekWebOfficialSettings,
  JsonWindowsSessionPolicyStore,
  ManagedDeepSeekWebBroker,
  POWERSHELL_7_REQUIRED,
  POWERSHELL_PROBE_TIMEOUT_MS,
  WINDOWS_BACKGROUND_COMMANDS_DISABLED,
  WINDOWS_COMMANDS_DISABLED,
  WINDOWS_COMMAND_DISCLOSURE,
  WINDOWS_COMMAND_POLICY_NOT_APPLIED,
  WINDOWS_SESSION_POLICY_UNAVAILABLE,
  apply,
  applyRequestedDefault,
  createDeepSeekWebModelHost,
  extensionOrigin,
  inject,
  installWindowsPowerShellPolicy,
  name,
  probePowerShell7,
  resolveWindowsPowerShellConfig,
  validateOfficialSettings,
  windowsSessionPolicyIdentity
};
