import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { decodeSeqRanges, decodeStorageRecord } from "@deepseek-ai/dsh-session";

import {
  WEB_MODEL_PATH,
  WEB_MODEL_SUBPROTOCOL,
  createPairingToken,
  type DeepSeekWebModelHostAddress,
} from "@deepseek-pp/dsh-web-model-transport";
import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";

import {
  FAKE_EXTENSION_ORIGIN,
  FakeBrowserPeer,
  type FakeGenerationInput,
} from "../harness-bridge/fake-peer/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DSH_MANIFEST = join(REPO_ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json");
const DSH_BIN = join(dirname(DSH_MANIFEST), "lib", "bin.js");
const BUNDLE_ROOT = join(REPO_ROOT, "packages", "dsh-web-agent-bundle");
const SEED_SCRIPT = join(BUNDLE_ROOT, "scripts", "seed-profile.mjs");
const BARRIER_PATCH = join(import.meta.dirname, "startup-barrier.patch.yml");
const PROFILE_NAME = "deepseek-web-agent";
const CHILD_TIMEOUT_MS = 30_000;
const HEADLESS_SYSTEM_ENVIRONMENT = [
  "APPDATA",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const;

interface FakeHeadlessCommonOptions {
  readonly task: string;
  readonly inheritedEnvironmentProbe?: Readonly<NodeJS.ProcessEnv>;
  readonly patches?: readonly string[];
  readonly prepareWorkspace?: (workspace: string) => Promise<void>;
}

export type FakeHeadlessOptions = FakeHeadlessCommonOptions & ({
  readonly answerFragments: readonly [string, ...string[]];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly generationScripts?: never;
} | {
  readonly generationScripts: readonly [FakeGenerationInput, ...FakeGenerationInput[]];
  readonly answerFragments?: never;
  readonly usage?: never;
});

export interface FakeHeadlessResult {
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly shell: false;
    readonly windowsHide: true;
  };
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly observedRequests: readonly ModelGenerateRequest["params"][];
  readonly persistedRecords: readonly Record<string, unknown>[];
  readonly persistedRaw: string;
  readonly sessionLogCount: number;
  readonly workspaceCwd: string;
  readonly childEnvironmentKeys: readonly string[];
  readonly portReleased: boolean;
  readonly childClosed: boolean;
  readonly tempRootRemoved: boolean;
}

interface ChildResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ChildCapture {
  readonly result: Promise<ChildResult>;
  readonly closed: Promise<void>;
  isClosed(): boolean;
}

type HeadlessChild = ChildProcessByStdio<null, Readable, Readable>;

export async function runFakeDshHeadless(options: FakeHeadlessOptions): Promise<FakeHeadlessResult> {
  validateOptions(options);
  const tempRoot = await mkdtemp(join(tmpdir(), "dsh-web-agent-fake-"));
  const home = join(tempRoot, "dsh-home");
  const workspace = join(tempRoot, "workspace");
  const releaseFile = join(tempRoot, "browser-ready");
  const pairingToken = createPairingToken();
  const port = await reserveLoopbackPort();
  const inheritedEnvironment = {
    ...process.env,
    ...options.inheritedEnvironmentProbe,
  };
  const preparationEnv = createPreparationEnvironment(inheritedEnvironment, home);
  const env = createHeadlessEnvironment(inheritedEnvironment, {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_WEB_BROKER_PORT: String(port),
    DSH_WEB_PAIRING_TOKEN: pairingToken,
    DSH_WEB_ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGIN,
    DSH_WEB_FAKE_RELEASE_FILE: releaseFile,
    DSH_WEB_WORKSPACE_ROOT: workspace,
  });
  const args = [
    DSH_BIN, "--profile", PROFILE_NAME,
    ...(options.patches ?? []).flatMap((patch) => ["--patch", patch]),
    "--patch", BARRIER_PATCH, options.task,
  ] as const;
  const command = {
    executable: process.execPath,
    args,
    shell: false as const,
    windowsHide: true as const,
  };

  let child: HeadlessChild | undefined;
  let capture: ChildCapture | undefined;
  let peer: FakeBrowserPeer | undefined;
  let outcome: Omit<FakeHeadlessResult, "tempRootRemoved"> | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    await mkdir(workspace, { recursive: true });
    await options.prepareWorkspace?.(workspace);
    await runManagedCommand(
      process.execPath,
      [SEED_SCRIPT, "--home", home],
      REPO_ROOT,
      preparationEnv,
      10_000,
      "DSH_PROFILE_SEED",
    );
    await runManagedCommand(
      process.execPath,
      [DSH_BIN, "plugin", "--profile", PROFILE_NAME, "add", "--offline", BUNDLE_ROOT],
      workspace,
      preparationEnv,
      30_000,
      "DSH_PROFILE_INSTALL",
    );

    child = spawn(command.executable, command.args, {
      cwd: workspace,
      env,
      shell: command.shell,
      windowsHide: command.windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    capture = captureChild(child, CHILD_TIMEOUT_MS, "DSH_HEADLESS_TIMEOUT");
    void capture.result.catch(() => undefined);

    const address: DeepSeekWebModelHostAddress = {
      host: "127.0.0.1",
      port,
      path: WEB_MODEL_PATH,
      url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`,
      subprotocol: WEB_MODEL_SUBPROTOCOL,
    };
    peer = await connectWhileChildRuns(address, pairingToken, capture);
    let generationScripts: readonly FakeGenerationInput[];
    if (options.generationScripts !== undefined) {
      generationScripts = options.generationScripts;
    } else {
      generationScripts = [{
        events: [
          ...options.answerFragments.map((text) => ({ type: "text_delta" as const, text })),
          {
            type: "usage" as const,
            input_tokens: options.usage.inputTokens,
            output_tokens: options.usage.outputTokens,
          },
          { type: "completed" as const, finish_reason: "stop" as const },
        ],
      }];
    }
    for (const script of generationScripts) peer.enqueueGeneration(script);
    await writeFile(releaseFile, "ready\n", { encoding: "utf8", flag: "wx" });

    const childResult = await capture.result;
    peer.throwIfFailed();
    if (childResult.stdout.includes(pairingToken) || childResult.stderr.includes(pairingToken)) {
      throw new Error("PAIRING_TOKEN_DISCLOSURE");
    }
    const persisted = await readOnlySessionLog(join(home, "sessions"));
    if (persisted.raw.includes(pairingToken)) throw new Error("PAIRING_TOKEN_PERSISTED");
    const observedRequests = structuredClone(peer.observedGenerateRequests);

    await peer.close();
    peer = undefined;
    const portReleased = await canBindLoopback(port);
    outcome = {
      command,
      ...childResult,
      observedRequests,
      persistedRecords: persisted.records,
      persistedRaw: persisted.raw,
      sessionLogCount: persisted.logCount,
      workspaceCwd: workspace,
      childEnvironmentKeys: Object.keys(env).sort(),
      portReleased,
      childClosed: capture.isClosed(),
    };
  } catch (error) {
    failure = error;
  } finally {
    if (peer !== undefined) {
      try {
        await peer.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (child !== undefined && capture !== undefined && !capture.isClosed()) {
      try {
        await terminateChildTree(child, REPO_ROOT, env);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (capture !== undefined) {
      try {
        await within(capture.closed, 5_000, "DSH_CHILD_DID_NOT_CLOSE");
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...failure === undefined ? [] : [failure], ...cleanupFailures],
      "DSH_WEB_AGENT_FAKE_E2E_FAILED",
    );
  }
  if (outcome === undefined) throw new Error("DSH_WEB_AGENT_FAKE_E2E_NO_OUTCOME");
  return { ...outcome, tempRootRemoved: !existsSync(tempRoot) };
}

function validateOptions(options: FakeHeadlessOptions): void {
  if (options.task.trim() === "") throw new Error("FAKE_HEADLESS_TASK_REQUIRED");
  if (options.patches?.some((patch) => !isAbsolute(patch) || !existsSync(patch))) {
    throw new Error("FAKE_HEADLESS_PATCH_INVALID");
  }
  if (options.generationScripts !== undefined) {
    if (options.generationScripts.length === 0) throw new Error("FAKE_HEADLESS_SCRIPT_REQUIRED");
    return;
  }
  if (options.answerFragments.length === 0 || options.answerFragments.some((text) => text.length === 0)) {
    throw new Error("FAKE_HEADLESS_ANSWER_REQUIRED");
  }
  if (!Number.isSafeInteger(options.usage.inputTokens) || options.usage.inputTokens < 0 ||
      !Number.isSafeInteger(options.usage.outputTokens) || options.usage.outputTokens < 0) {
    throw new Error("FAKE_HEADLESS_USAGE_INVALID");
  }
}

async function connectWhileChildRuns(
  address: DeepSeekWebModelHostAddress,
  pairingToken: string,
  capture: ChildCapture,
): Promise<FakeBrowserPeer> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (capture.isClosed()) throw new Error("DSH_EXITED_BEFORE_BROWSER_CONNECTED");
    try {
      return await FakeBrowserPeer.connect({ address, pairingToken, timeoutMs: 200 });
    } catch (error) {
      if (!isRetryableConnectFailure(error)) throw error;
      await delay(25);
    }
  }
  throw new Error("DSH_HOST_DID_NOT_ACCEPT_FAKE_BROWSER");
}

function isRetryableConnectFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "FAKE_PEER_CONNECT_FAILED" ||
    error.message === "FAKE_PEER_CONNECT_TIMEOUT"
  );
}

function captureChild(child: HeadlessChild, timeoutMs: number, timeoutCode: string): ChildCapture {
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  let closeCapture!: () => void;
  let closeCaptured = false;
  const closedPromise = new Promise<void>((resolveClosed) => { closeCapture = resolveClosed; });
  const markClosed = (): void => {
    if (closeCaptured) return;
    closeCaptured = true;
    closed = true;
    closeCapture();
  };
  const result = new Promise<ChildResult>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutCode));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      markClosed();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      markClosed();
      resolveResult({ exitCode: code ?? -1, stdout, stderr });
    });
  });
  return { result, closed: closedPromise, isClosed: () => closed };
}

async function runManagedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  label: string,
): Promise<void> {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const capture = captureChild(child, timeout, `${label}_TIMEOUT`);
  void capture.result.catch(() => undefined);
  let result: ChildResult | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    result = await capture.result;
  } catch (error) {
    failure = error;
  } finally {
    if (!capture.isClosed()) {
      try {
        await terminateChildTree(child, cwd, env);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await within(capture.closed, 5_000, `${label}_DID_NOT_CLOSE`);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (failure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...failure === undefined ? [] : [failure], ...cleanupFailures],
      `${label}_FAILED`,
    );
  }
  if (result === undefined || result.exitCode !== 0) throw new Error(`${label}_EXIT_${result?.exitCode ?? -1}`);
}

async function readOnlySessionLog(root: string): Promise<{
  readonly raw: string;
  readonly records: Record<string, unknown>[];
  readonly logCount: number;
}> {
  const entries = await readdir(root, { recursive: true });
  const logs = entries.filter((entry) => entry.endsWith("session.jsonl"));
  if (logs.length !== 1) throw new Error(`EXPECTED_ONE_DURABLE_SESSION_LOG:${logs.length}`);
  const content = await readFile(join(root, logs[0] as string), "utf8");
  if (!content.endsWith("\n")) throw new Error("DURABLE_SESSION_LOG_NOT_FLUSHED");
  const stored = content.split("\n").filter((line) => line.length > 0).map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("INVALID_DURABLE_SESSION_RECORD");
    }
    return parsed as Record<string, unknown>;
  });
  if (stored.length === 0 || stored[0]?.type !== "session") throw new Error("DURABLE_SESSION_HEADER_MISSING");
  const records: Record<string, unknown>[] = [stored[0]];
  for (const row of stored.slice(1)) {
    // Physical JSONL rows can contain text-chunks; only upstream decoding owns
    // the one-row-to-many-events expansion and source-sequence range encoding.
    const decodedRow = row.sourceEventSeqs === undefined ? row : {
      ...row,
      sourceEventSeqs: decodeSeqRanges(row.sourceEventSeqs, row.seq as number),
    };
    records.push(...decodeStorageRecord(decodedRow as Parameters<typeof decodeStorageRecord>[0]) as unknown as Record<string, unknown>[]);
  }
  if (records.slice(1).some((record, index) => record.seq !== index)) {
    throw new Error("INVALID_DURABLE_SESSION_SEQUENCE");
  }
  return { raw: content, records, logCount: logs.length };
}

function createPreparationEnvironment(input: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const clean = { ...input };
  const secretLike = /(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|(?:^|_)(?:TOKEN|PASSWORD|CREDENTIALS?)(?:$|_))/i;
  const modelProvider = /^(?:DEEPSEEK|DASHSCOPE|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|MISTRAL|COHERE|GROQ|OPENROUTER|OLLAMA|AWS_(?:BEDROCK|ACCESS|SECRET|SESSION))/i;
  for (const key of Object.keys(clean)) {
    if (secretLike.test(key) || modelProvider.test(key) || /^DSH_WEB_/i.test(key)) delete clean[key];
  }
  clean.DSH_HOME = home;
  clean.DSH_TELEMETRY_DISABLED = "1";
  return clean;
}

function createHeadlessEnvironment(
  input: NodeJS.ProcessEnv,
  owned: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const canonicalName of HEADLESS_SYSTEM_ENVIRONMENT) {
    const value = environmentValue(input, canonicalName);
    if (value !== undefined) environment[canonicalName] = value;
  }
  for (const [key, value] of Object.entries(owned)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function environmentValue(input: NodeJS.ProcessEnv, name: string): string | undefined {
  const actualName = Object.keys(input).find((key) => key.toLowerCase() === name.toLowerCase());
  return actualName === undefined ? undefined : input[actualName];
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("EXPECTED_LOOPBACK_ADDRESS");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
  return port;
}

async function canBindLoopback(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port }, resolveListen);
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error === undefined ? resolveClose() : reject(error));
      });
    }
  }
}

async function terminateChildTree(
  child: HeadlessChild,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      await runTaskkill(resolveTaskkillPath(env), child.pid, cwd, env);
      return;
    } catch {
      child.kill("SIGKILL");
      return;
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function resolveTaskkillPath(env: NodeJS.ProcessEnv): string {
  const windowsRoot = environmentValue(env, "SystemRoot") ?? environmentValue(env, "WINDIR");
  if (windowsRoot === undefined || !isAbsolute(windowsRoot)) throw new Error("WINDOWS_ROOT_UNAVAILABLE");
  const executable = join(resolve(windowsRoot), "System32", "taskkill.exe");
  if (!existsSync(executable)) throw new Error("TASKKILL_UNAVAILABLE");
  return executable;
}

async function runTaskkill(
  executable: string,
  pid: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const killer = spawn(executable, ["/PID", String(pid), "/T", "/F"], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolveKill, reject) => {
    const timer = setTimeout(() => {
      killer.kill("SIGKILL");
      reject(new Error("TASKKILL_TIMEOUT"));
    }, 5_000);
    killer.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveKill();
      else reject(new Error("TASKKILL_FAILED"));
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function within<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
