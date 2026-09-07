import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-subprocess";
import * as PwshTools from "@deepseek-ai/dsh-tool-pwsh";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

export const POWERSHELL_7_REQUIRED = "POWERSHELL_7_REQUIRED";
export const WINDOWS_COMMANDS_DISABLED = "WINDOWS_COMMANDS_DISABLED";
export const WINDOWS_BACKGROUND_COMMANDS_DISABLED = "WINDOWS_BACKGROUND_COMMANDS_DISABLED";
export const WINDOWS_COMMAND_POLICY_NOT_APPLIED = "WINDOWS_COMMAND_POLICY_NOT_APPLIED";
export const WINDOWS_SESSION_POLICY_UNAVAILABLE = "WINDOWS_SESSION_POLICY_UNAVAILABLE";
export const WINDOWS_COMMAND_DISCLOSURE =
  "Commands run with the current Windows user's permissions; cwd is not a sandbox or an isolation boundary.";
export const POWERSHELL_PROBE_TIMEOUT_MS = 3_000;
export const DEEPSEEK_WEB_PROVIDER = "deepseek-web";

export type WindowsCommandApprovalPolicy = "ask" | "auto";

export interface WindowsPowerShellConfig {
  /** Commands remain unavailable unless the user explicitly enables them. */
  readonly enabled?: boolean;
  /** `auto` is an explicit opt-in; omission always resolves to `ask`. */
  readonly approvalPolicy?: WindowsCommandApprovalPolicy;
}

export interface ResolvedWindowsPowerShellConfig {
  readonly enabled: boolean;
  readonly approvalPolicy: WindowsCommandApprovalPolicy;
}

export interface PowerShell7Probe {
  readonly executable: string;
  readonly major: number;
}

export type WindowsPowerShellAvailability =
  | { readonly kind: "disabled" }
  | { readonly kind: "available"; readonly powershell: PowerShell7Probe }
  | { readonly kind: "unavailable"; readonly code: typeof POWERSHELL_7_REQUIRED; readonly message: string };

export interface WindowsPowerShellPolicyInstallation {
  /** Mutable default for sessions created after the latest update. */
  readonly config: ResolvedWindowsPowerShellConfig;
  /** Display-safe readiness; installation never throws for a missing pwsh 7. */
  readonly status: WindowsPowerShellAvailability;
  /** Change only the future-session default and refresh display readiness. */
  update(input: WindowsPowerShellConfig): Promise<WindowsPowerShellAvailability>;
  /** Wait until every session-policy write queued by this installation settles. */
  flush(): Promise<void>;
}

export interface WindowsSessionPolicyStore {
  get(sessionId: string, identity: string): Promise<ResolvedWindowsPowerShellConfig | undefined>;
  putIfAbsent(
    sessionId: string,
    identity: string,
    policy: ResolvedWindowsPowerShellConfig,
  ): Promise<ResolvedWindowsPowerShellConfig>;
  flush(): Promise<void>;
}

interface WindowsSessionPolicyDocument {
  readonly version: 2;
  readonly sessions: Readonly<Record<string, {
    readonly identity: string;
    readonly policy: ResolvedWindowsPowerShellConfig;
  }>>;
}

const SESSION_POLICY_FILE_MAX_BYTES = 1024 * 1024;
const SESSION_POLICY_MAX_ENTRIES = 10_000;

/** Production JSON store rooted at one owner-supplied absolute DSH home path. */
export class JsonWindowsSessionPolicyStore implements WindowsSessionPolicyStore {
  readonly filePath: string;
  private tail: Promise<void> = Promise.resolve();
  private document: WindowsSessionPolicyDocument | undefined;

  constructor(filePath: string) {
    if (!isAbsolute(filePath)) throw new Error("windows session policy path must be absolute");
    this.filePath = filePath;
  }

  get(sessionId: string, identity: string): Promise<ResolvedWindowsPowerShellConfig | undefined> {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    return this.enqueue(async () => {
      const record = (await this.load()).sessions[sessionId];
      return record?.identity === identity ? record.policy : undefined;
    });
  }

  putIfAbsent(
    sessionId: string,
    identity: string,
    policy: ResolvedWindowsPowerShellConfig,
  ): Promise<ResolvedWindowsPowerShellConfig> {
    validateSessionId(sessionId);
    validateSessionIdentity(identity);
    const validated = resolveWindowsPowerShellConfig(policy);
    return this.enqueue(async () => {
      const current = await this.load();
      const existing = current.sessions[sessionId];
      if (existing !== undefined) {
        if (existing.identity !== identity) throw new Error("windows session policy identity does not match");
        return existing.policy;
      }
      if (Object.keys(current.sessions).length >= SESSION_POLICY_MAX_ENTRIES) {
        throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
      }
      const next: WindowsSessionPolicyDocument = {
        version: 2,
        sessions: { ...current.sessions, [sessionId]: { identity, policy: validated } },
      };
      await writePolicyDocument(this.filePath, next);
      this.document = freezePolicyDocument(next);
      return validated;
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<WindowsSessionPolicyDocument> {
    if (this.document !== undefined) return this.document;
    await assertNoSymlinkComponents(this.filePath);
    let text: string;
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
}

/**
 * Resolve the narrow user-controlled policy. Defaults are deliberately closed:
 * merely installing or loading the plugin does not enable native commands, and
 * enabling them does not select unattended execution.
 */
export function resolveWindowsPowerShellConfig(
  config: WindowsPowerShellConfig,
): ResolvedWindowsPowerShellConfig {
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error("windowsPowerShell.enabled must be a boolean");
  }
  if (config.approvalPolicy !== undefined
    && config.approvalPolicy !== "ask"
    && config.approvalPolicy !== "auto") {
    throw new Error("windowsPowerShell.approvalPolicy must be ask or auto");
  }
  return {
    enabled: config.enabled ?? false,
    approvalPolicy: config.approvalPolicy ?? "ask",
  };
}

/**
 * Verify one exact executable through the official managed-subprocess seam.
 * This intentionally does not call pwsh-local's default resolver: the pinned
 * upstream resolver includes Windows PowerShell 5.1 as a last-resort fallback,
 * while this product contract accepts PowerShell 7 only.
 */
export async function probePowerShell7(
  ctx: Context,
  executable: string,
  signal?: AbortSignal,
  timeoutMs = POWERSHELL_PROBE_TIMEOUT_MS,
): Promise<PowerShell7Probe> {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw powerShell7Error("no PowerShell 7 executable was configured");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("PowerShell probe timeout must be positive");
  const deadline = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  let resolved: string;
  try {
    resolved = await raceAbort(
      ctx.subprocess.resolveExecutable(executable.trim(), undefined, operationSignal),
      operationSignal,
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
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write($PSVersionTable.PSVersion.Major)",
    ],
    cwd: process.cwd(),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 64 },
      stderr: { maxBytes: 512 },
    },
    graceMs: 500,
    signal: operationSignal,
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

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/**
 * Add the product-specific admission layer and a per-Agent, isolated composition
 * of the official local executor and official pwsh tool. The official profile's
 * global sandbox executor remains intact for every other provider; only an Agent
 * whose current request route is `deepseek-web` sees the scoped native tool.
 * This function owns no executor or tool implementation and executes no command.
 */
export async function installWindowsPowerShellPolicy(
  ctx: Context,
  input: WindowsPowerShellConfig,
  sessionPolicies: WindowsSessionPolicyStore,
  readCurrentConfig?: () => WindowsPowerShellConfig,
  readRequiredExecutable?: () => string,
  isImportedSessionDenied?: (sessionId: string) => boolean,
): Promise<WindowsPowerShellPolicyInstallation> {
  let defaultConfig = resolveWindowsPowerShellConfig(input);
  let verifiedPowerShell: PowerShell7Probe | undefined;
  let verifiedDeclaredPath: string | undefined;
  let status: WindowsPowerShellAvailability = { kind: "disabled" };
  interface SessionPolicyState {
    policy: ResolvedWindowsPowerShellConfig;
    ready: Promise<void>;
    failure?: string;
  }
  const policies = new WeakMap<Session, SessionPolicyState>();
  const pendingWrites = new Set<Promise<void>>();

  interface NativePowerShellStack {
    readonly executable: string;
    readonly shellFiber: { dispose(): void | Promise<void> };
    readonly toolFiber: { dispose(): void | Promise<void> };
  }
  const nativeStacks = new Map<Agent, NativePowerShellStack>();

  const configuredExecutable = (): string => {
    if (process.platform !== "win32") {
      throw powerShell7Error("native Windows commands are available on Windows only");
    }
    const shell = ctx.get("shell") as { readonly pwshPath?: unknown } | undefined;
    if (shell === undefined || typeof shell.pwshPath !== "string" || shell.pwshPath.trim().length === 0) {
      throw powerShell7Error("the official PowerShell executor is not mounted");
    }
    const actual = shell.pwshPath.trim();
    const required = readRequiredExecutable?.().trim() ?? "";
    if (required !== "" && actual !== required) {
      throw powerShell7Error("the configured executable has not been applied by the official Shell settings");
    }
    return actual;
  };
  const ensureAvailable = async (signal?: AbortSignal, force = false): Promise<PowerShell7Probe | undefined> => {
    try {
      const executable = configuredExecutable();
      if (!force && verifiedPowerShell !== undefined && verifiedDeclaredPath === executable) {
        return verifiedPowerShell;
      }
      const powershell = await probePowerShell7(ctx, executable, signal);
      verifiedPowerShell = powershell;
      verifiedDeclaredPath = executable;
      status = { kind: "available", powershell };
      return powershell;
    } catch (error) {
      if (signal?.aborted) return undefined;
      verifiedPowerShell = undefined;
      verifiedDeclaredPath = undefined;
      const message = error instanceof Error ? error.message : `${POWERSHELL_7_REQUIRED}: ${String(error)}`;
      status = { kind: "unavailable", code: POWERSHELL_7_REQUIRED, message };
      return undefined;
    }
  };
  const refreshStatus = async (): Promise<WindowsPowerShellAvailability> => {
    if (!defaultConfig.enabled) {
      status = { kind: "disabled" };
      return status;
    }
    await ensureAvailable(undefined, true);
    return status;
  };
  const trackWrite = (write: Promise<void>): Promise<void> => {
    pendingWrites.add(write);
    void write.finally(() => { pendingWrites.delete(write); });
    return write;
  };
  const createState = (session: Session): SessionPolicyState => {
    const existing = policies.get(session);
    if (existing !== undefined) return existing;
    const isNew = isFreshWindowsPolicySession(session);
    const currentDefault = resolveWindowsPowerShellConfig(readCurrentConfig?.() ?? defaultConfig);
    const state: SessionPolicyState = {
      policy: isNew ? currentDefault : DISABLED_SESSION_POLICY,
      ready: Promise.resolve(),
    };
    policies.set(session, state);
    const identity = windowsSessionPolicyIdentity(session);
    const imported = isImportedSessionDenied?.(String(session.id)) === true;
    if (imported) state.policy = DISABLED_SESSION_POLICY;
    const operation = imported
      ? Promise.resolve(undefined)
      : isNew
      ? sessionPolicies.putIfAbsent(String(session.id), identity, state.policy)
      : sessionPolicies.get(String(session.id), identity);
    const ready = operation.then((stored) => {
      state.policy = stored ?? DISABLED_SESSION_POLICY;
    }, (error: unknown) => {
      state.policy = DISABLED_SESSION_POLICY;
      state.failure = `${WINDOWS_SESSION_POLICY_UNAVAILABLE}: ${errorMessage(error)}`;
    });
    state.ready = isNew ? trackWrite(ready) : ready;
    return state;
  };
  const policyFor = async (session: Session | undefined): Promise<SessionPolicyState> => {
    if (session === undefined) {
      return { policy: DISABLED_SESSION_POLICY, ready: Promise.resolve() };
    }
    const cached = policies.get(session);
    const state = cached ?? createState(session);
    await state.ready;
    return state;
  };
  const flush = async (): Promise<void> => {
    await Promise.all([...pendingWrites]);
    await sessionPolicies.flush();
  };
  ctx.effect(() => async () => { await flush(); });
  // Registered after the flush disposer so Fiber teardown first prevents new
  // session writes, then drains the already queued writes.
  ctx.on("session/created", (session) => {
    createState(session);
  });

  const disposeNativeStack = async (agent: Agent): Promise<void> => {
    const stack = nativeStacks.get(agent);
    if (stack === undefined) return;
    nativeStacks.delete(agent);
    const failures: unknown[] = [];
    try { await stack.toolFiber.dispose(); } catch (error) { failures.push(error); }
    try { await stack.shellFiber.dispose(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "native PowerShell stack disposal failed");
  };
  const ensureNativeStack = async (agent: Agent): Promise<void> => {
    if (process.platform !== "win32" || providerForNextStep(agent) !== DEEPSEEK_WEB_PROVIDER) {
      await disposeNativeStack(agent);
      return;
    }
    const executable = configuredExecutable();
    const current = nativeStacks.get(agent);
    if (current?.executable === executable) return;
    await disposeNativeStack(agent);

    // `ctx.shell` is a single profile service. A fresh Cordis isolation realm
    // lets the official local executor coexist without replacing the base
    // sandbox service; retaining the Agent scope makes this tool definition
    // shadow the global one for this Agent only. Isolating settings prevents a
    // second registration of the shared `shell` settings namespace: the plugin
    // settings owner supplies this exact executable instead.
    const nativeCtx = agent.ctx.isolate("shell").isolate("settings");
    const shellFiber = await nativeCtx.plugin(PwshLocalExecutor, { pwshPath: executable });
    try {
      const toolFiber = await nativeCtx.plugin(PwshTools, { enableRunInBackground: false });
      nativeStacks.set(agent, { executable, shellFiber, toolFiber });
    } catch (error) {
      await shellFiber.dispose();
      throw error;
    }
  };
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const agent = context.agent;
    if (agent === undefined) return next();
    await ensureNativeStack(agent);
    const transformed = await next();
    const pwsh = ctx.tools.schemas(agent).find((schema) => schema.name === "pwsh");
    if (pwsh === undefined || !assembly.tools.some((schema) => schema.name === "pwsh")) {
      return transformed;
    }
    // SystemPrompt collected its tool providers immediately before this
    // awaited waterfall. Replace only the pwsh snapshot after the scoped stack
    // settles so the first request after a model switch advertises the exact
    // definition ToolRuntime will dispatch; every unrelated schema and its
    // established ordering remain byte-for-byte untouched.
    return {
      ...transformed,
      tools: transformed.tools.map((schema) => schema.name === "pwsh" ? pwsh : schema),
    };
  }, { prepend: true });
  ctx.on("agent/disposed", ({ agent }) => {
    nativeStacks.delete(agent);
  });
  ctx.effect(() => async () => {
    const failures = await Promise.allSettled([...nativeStacks.keys()].map(disposeNativeStack));
    const rejected = failures.flatMap((failure) => failure.status === "rejected" ? [failure.reason] : []);
    if (rejected.length === 1) throw rejected[0];
    if (rejected.length > 1) throw new AggregateError(rejected, "native PowerShell stacks disposal failed");
  });

  // Missing PowerShell 7 is displayable state, never a reason to stop the
  // official Web host. An enabled session rechecks lazily before its command.
  await refreshStatus();

  const admitted = new WeakSet<ToolExecution>();
  ctx.on("tools/result", (exec) => { admitted.delete(exec); });
  // This monotonic backstop keeps disabled and background calls denied even if
  // another extensible listener short-circuits the waterfall later. The
  // one-shot admission also proves this policy's prepended listener actually
  // saw the exact runtime-owned execution object before dispatch.
  ctx.tools.guard((exec) => {
    if (exec.name !== "pwsh" || !isDeepSeekWebExecution(exec)) return undefined;
    const state = exec.agent === undefined ? undefined : policies.get(exec.agent.session);
    if (state === undefined || !state.policy.enabled) return WINDOWS_COMMANDS_DISABLED;
    if (requestsBackgroundExecution(exec)) return WINDOWS_BACKGROUND_COMMANDS_DISABLED;
    const allowed = admitted.has(exec);
    admitted.delete(exec);
    return allowed ? undefined : WINDOWS_COMMAND_POLICY_NOT_APPLIED;
  });
  // Prepend owns the ask decision before any permissive listener can return.
  // ToolRuntime then delegates the ask to the official ApprovalService, whose
  // only granting outcome is the audited one-shot `allowed-once`.
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "pwsh" || !isDeepSeekWebExecution(exec)) return next();
    const state = await policyFor(exec.agent?.session);
    if (state.failure !== undefined) return { kind: "deny", reason: state.failure };
    const policy = state.policy;
    if (!policy.enabled) return { kind: "deny", reason: WINDOWS_COMMANDS_DISABLED };
    if (requestsBackgroundExecution(exec)) {
      return { kind: "deny", reason: WINDOWS_BACKGROUND_COMMANDS_DISABLED };
    }
    if (await ensureAvailable(exec.signal) === undefined) {
      if (exec.signal.aborted) {
        // Let ToolRuntime's post-gate cancellation recheck produce its
        // canonical aborted-before-dispatch result; the admission only avoids
        // our monotonic guard replacing that result and cannot reach the body.
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
      reason: `Approve this one foreground PowerShell 7 command. ${WINDOWS_COMMAND_DISCLOSURE}`,
    };
  }, { prepend: true });

  return {
    get config() { return defaultConfig; },
    get status() { return status; },
    async update(nextInput) {
      defaultConfig = resolveWindowsPowerShellConfig(nextInput);
      return refreshStatus();
    },
    flush,
  };
}

const DISABLED_SESSION_POLICY: ResolvedWindowsPowerShellConfig = Object.freeze({
  enabled: false,
  approvalPolicy: "ask",
});

/**
 * A fresh Session has no constructor seed. An empty persistence restore is the
 * subtle boundary: its `firstLiveSeq` is also zero, but the official Session
 * constructor records `session/end-seed` at that exact position. Treat every
 * seeded/restored incarnation as existing so a missing policy record fails
 * closed instead of inheriting today's default.
 */
export function isFreshWindowsPolicySession(session: Session): boolean {
  return Number(session.firstLiveSeq) === 0
    && session.snapshotEvents()[0]?.type !== "session/end-seed";
}

/** The provider selected for the next prompt assembly. */
export function providerForNextStep(agent: Agent): string | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    // The selection event is contributed by the optional official session
    // controller package, so this plugin validates it structurally rather than
    // acquiring that UI/controller package as a runtime dependency.
    if ((event.type as string) === "model/selection") {
      const data = plainRecord(event.data);
      if (typeof data?.provider === "string") return data.provider;
    }
    if (event.type === "request/header") return event.data.header.config.provider;
  }
  return agent.options.provider;
}

/**
 * Tool calls belong to the latest durable request header. A selection appended
 * while a step is running is only for a later request and must not change the
 * executor beneath the current tool call.
 */
export function providerForToolExecution(agent: Agent): string | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "request/header") return event.data.header.config.provider;
  }
  return agent.options.provider;
}

function isDeepSeekWebExecution(exec: ToolExecution): boolean {
  return exec.agent !== undefined && providerForToolExecution(exec.agent) === DEEPSEEK_WEB_PROVIDER;
}

/** Binds an external policy record to one immutable durable session header. */
export function windowsSessionPolicyIdentity(session: Session): string {
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
    header.agentPreset ?? null,
  ])).digest("hex");
}

function requestsBackgroundExecution(exec: ToolExecution): boolean {
  const args = plainRecord(exec.arguments);
  return args?.run_in_background === true;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function powerShell7Error(message: string, cause?: unknown): Error {
  return new Error(`${POWERSHELL_7_REQUIRED}: ${message}`, cause === undefined ? {} : { cause });
}

function parsePolicyDocument(text: string): WindowsSessionPolicyDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("windows session policy file is not valid JSON", { cause });
  }
  if (!hasExactKeys(parsed, ["version", "sessions"]) || parsed.version !== 2
    || !isPlainRecord(parsed.sessions)) {
    throw new Error("windows session policy file must be exactly {version:2,sessions:{...}}");
  }
  const entries = Object.entries(parsed.sessions);
  if (entries.length > SESSION_POLICY_MAX_ENTRIES) {
    throw new Error(`windows session policy store exceeds ${SESSION_POLICY_MAX_ENTRIES} entries`);
  }
  const sessions: Record<string, { readonly identity: string; readonly policy: ResolvedWindowsPowerShellConfig }> = Object.create(null) as Record<
    string,
    { readonly identity: string; readonly policy: ResolvedWindowsPowerShellConfig }
  >;
  for (const [sessionId, value] of entries) {
    validateSessionId(sessionId);
    if (!hasExactKeys(value, ["identity", "policy"]) || !hasExactKeys(value.policy, ["enabled", "approvalPolicy"])) {
      throw new Error(`windows session policy for ${JSON.stringify(sessionId)} has unknown or missing fields`);
    }
    validateSessionIdentity(value.identity);
    sessions[sessionId] = Object.freeze({
      identity: value.identity,
      policy: Object.freeze(resolveWindowsPowerShellConfig(value.policy)),
    });
  }
  return freezePolicyDocument({ version: 2, sessions });
}

function freezePolicyDocument(document: WindowsSessionPolicyDocument): WindowsSessionPolicyDocument {
  const sessions: Record<string, { readonly identity: string; readonly policy: ResolvedWindowsPowerShellConfig }> = Object.create(null) as Record<
    string,
    { readonly identity: string; readonly policy: ResolvedWindowsPowerShellConfig }
  >;
  for (const [sessionId, record] of Object.entries(document.sessions)) {
    sessions[sessionId] = Object.freeze({ identity: record.identity, policy: Object.freeze({ ...record.policy }) });
  }
  return Object.freeze({ version: 2, sessions: Object.freeze(sessions) });
}

async function writePolicyDocument(filePath: string, document: WindowsSessionPolicyDocument): Promise<void> {
  const directory = dirname(filePath);
  await assertNoSymlinkComponents(filePath);
  await mkdir(directory, { recursive: true });
  await assertNoSymlinkComponents(filePath);
  const text = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_FILE_MAX_BYTES) {
    throw new Error(`windows session policy file exceeds ${SESSION_POLICY_FILE_MAX_BYTES} bytes`);
  }
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
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
    if (created) await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

async function assertNoSymlinkComponents(filePath: string): Promise<void> {
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

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256
    || sessionId === "__proto__" || sessionId === "prototype" || sessionId === "constructor") {
    throw new Error("windows session policy session id is invalid");
  }
}

function validateSessionIdentity(identity: unknown): asserts identity is string {
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error("windows session policy identity is invalid");
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
