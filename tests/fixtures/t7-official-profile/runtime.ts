import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  WEB_MODEL_PATH,
  WEB_MODEL_SUBPROTOCOL,
  createPairingToken,
} from "@deepseek-pp/dsh-web-model-transport";
import WebSocket from "ws";

import {
  FakeBrowserPeer,
  FAKE_EXTENSION_ORIGIN,
} from "../harness-bridge/fake-peer/index.ts";
import {
  canBindLoopback,
  createHeadlessEnvironment,
  createPreparationEnvironment,
  reserveLoopbackPort,
  terminateChildTree,
} from "../dsh-web-agent/run-fake-headless.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PACKAGE_ROOT = join(ROOT, "packages", "dsh-deepseek-web-official-plugin");
const DSH_BIN = join(dirname(join(ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json")), "lib", "bin.js");
const installRuntime = await import(new URL(
  "../../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs",
  import.meta.url,
).href);

type WebChild = ChildProcessByStdio<null, Readable, Readable>;

interface WebLaunch {
  readonly child: WebChild;
  readonly closed: Promise<void>;
  readonly cookie: string;
  readonly base: string;
}

export interface RemoteResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export interface ApprovalDecisionRecord {
  readonly outcome: "rejected" | "allowed-once";
  readonly agentId: string;
  readonly request: Record<string, unknown>;
}

export interface ApprovalResponder {
  readonly decisions: readonly ApprovalDecisionRecord[];
  waitForCount(count: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * A real official `web` Profile and Web/Gateway process. The only fake is the
 * browser-side DeepSeek model peer, connected through the product transport.
 */
export class OfficialWebProfileFixture {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly brokerPort: number;
  readonly webPort: number;
  readonly pairingToken: string;
  readonly environment: NodeJS.ProcessEnv;
  private launch: WebLaunch | undefined;
  private peerValue: FakeBrowserPeer | undefined;

  private constructor(options: {
    root: string;
    home: string;
    workspace: string;
    brokerPort: number;
    webPort: number;
    pairingToken: string;
    environment: NodeJS.ProcessEnv;
  }) {
    this.root = options.root;
    this.home = options.home;
    this.workspace = options.workspace;
    this.brokerPort = options.brokerPort;
    this.webPort = options.webPort;
    this.pairingToken = options.pairingToken;
    this.environment = options.environment;
  }

  static async create(): Promise<OfficialWebProfileFixture> {
    const root = await mkdtemp(join(tmpdir(), "dsh-t7-official-profile-"));
    const home = join(root, "dsh-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const preparationEnvironment = createPreparationEnvironment(process.env, home);
    const installed = await installRuntime.runProcess(process.execPath, [
      DSH_BIN,
      "plugin",
      "--profile",
      "web",
      "add",
      "--offline",
      "--workspace-root",
      PACKAGE_ROOT,
    ], { cwd: ROOT, env: preparationEnvironment, timeoutMs: 15_000 });
    if (installed.code !== 0) {
      await rm(root, { recursive: true, force: true });
      throw new Error(`T7_OFFICIAL_PLUGIN_INSTALL_FAILED\n${installed.stderr}`);
    }
    const brokerPort = await reserveLoopbackPort();
    const webPort = await reserveLoopbackPort();
    return new OfficialWebProfileFixture({
      root,
      home,
      workspace,
      brokerPort,
      webPort,
      pairingToken: createPairingToken(),
      environment: createHeadlessEnvironment(process.env, {
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(root, "agents-home"),
        DSH_TELEMETRY_DISABLED: "1",
      }),
    });
  }

  get peer(): FakeBrowserPeer {
    if (this.peerValue === undefined) throw new Error("T7_OFFICIAL_FAKE_BROWSER_NOT_CONNECTED");
    return this.peerValue;
  }

  async writeSkill(name: string, body: string): Promise<void> {
    const directory = join(this.workspace, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: Load the ${name} T7 acceptance fixture.`,
      "---",
      body,
      "",
    ].join("\n"), { flag: "wx" });
  }

  async start(): Promise<void> {
    if (this.launch !== undefined) throw new Error("T7_OFFICIAL_WEB_ALREADY_STARTED");
    const child = spawn(process.execPath, [
      DSH_BIN,
      "web",
      "--no-open",
      "--port",
      String(this.webPort),
    ], {
      cwd: this.workspace,
      env: this.environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    try {
      const url = await waitFor(() => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u);
        if (match?.[0] !== undefined) return match[0];
        if (child.exitCode !== null) throw new Error(`T7_OFFICIAL_WEB_EXITED_${child.exitCode}\n${output}`);
        return undefined;
      }, 12_000, "T7_OFFICIAL_WEB_START_TIMEOUT");
      const exchange = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      assert.equal(exchange.status, 303, output);
      const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("T7_OFFICIAL_WEB_COOKIE_MISSING");
      const base = `http://127.0.0.1:${this.webPort}`;
      const page = await fetch(base, { headers: { cookie }, signal: AbortSignal.timeout(5_000) });
      assert.equal(page.status, 200);
      this.launch = { child, closed, cookie, base };
    } catch (error) {
      await terminateChildTree(child, this.root, this.environment);
      await Promise.race([closed, delay(5_000)]);
      throw error;
    }
  }

  async configureConnection(): Promise<void> {
    const described = await this.rpc<{ namespaces: Array<{ ns: string; revision: number }> }>("settings/describe", {});
    assert.equal(described.ok, true, JSON.stringify(described));
    const namespace = described.value?.namespaces.find((entry) => entry.ns === "deepseek-web");
    if (namespace === undefined) throw new Error("T7_OFFICIAL_SETTINGS_NAMESPACE_MISSING");
    const mutated = await this.rpc("settings/mutate", {
      ns: "deepseek-web",
      ops: [
        { op: "set", path: ["browser"], value: "chrome" },
        { op: "set", path: ["chromiumExtensionId"], value: "abcdefghijklmnopabcdefghijklmnop" },
        { op: "set", path: ["port"], value: this.brokerPort },
        { op: "set", path: ["windowsCommandsEnabled"], value: true },
        { op: "set", path: ["windowsApprovalPolicy"], value: "ask" },
        { op: "set", path: ["powerShellExecutable"], value: "pwsh" },
        { op: "set", path: ["makeDefaultForNewSessions"], value: true },
      ],
      expectedRevision: namespace.revision,
    });
    assert.equal(mutated.ok, true, JSON.stringify(mutated));
    const credential = await this.rpc("credentials/set", {
      ref: "DSH_WEB_PAIRING_TOKEN",
      value: this.pairingToken,
    });
    assert.equal(credential.ok, true, JSON.stringify(credential));
    await this.waitForConnection("waiting_for_browser");
  }

  async openApprovalResponder(
    outcomes: readonly ("rejected" | "allowed-once")[],
  ): Promise<ApprovalResponder> {
    const launch = this.requiredLaunch();
    const socket = new WebSocket(`ws://127.0.0.1:${this.webPort}/api/remote.mux`, {
      headers: { cookie: launch.cookie, origin: launch.base },
    });
    const streamId = `events-${randomUUID()}`;
    const decisions: ApprovalDecisionRecord[] = [];
    let clientId: string | undefined;
    let failure: unknown;
    let tail = Promise.resolve();
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    socket.on("message", (bytes) => {
      tail = tail.then(async () => {
        const frame = JSON.parse(bytes.toString()) as {
          type?: string;
          streamId?: string;
          value?: {
            type?: string;
            clientId?: string;
            event?: string;
            eventId?: string;
            agentId?: string;
            request?: Record<string, unknown>;
          };
        };
        if (frame.type !== "item" || frame.streamId !== streamId || frame.value === undefined) return;
        if (frame.value.type === "ready") {
          clientId = frame.value.clientId;
          return;
        }
        if (frame.value.type !== "waterfall" || frame.value.event !== "approval/request") return;
        const outcome = outcomes[decisions.length];
        if (outcome === undefined || clientId === undefined || frame.value.eventId === undefined
          || frame.value.agentId === undefined || frame.value.request === undefined) {
          throw new Error("T7_OFFICIAL_APPROVAL_FRAME_UNEXPECTED");
        }
        decisions.push({ outcome, agentId: frame.value.agentId, request: frame.value.request });
        const response = await this.rpc("$events/result", {
          clientId,
          eventId: frame.value.eventId,
          outcome: { kind: "result", value: outcome },
        });
        assert.equal(response.ok, true, JSON.stringify(response));
      }).catch((error) => { failure = error; });
    });
    socket.send(JSON.stringify({ type: "open", streamId, endpoint: "$events", payload: { args: {} } }));
    await waitFor(() => {
      if (failure !== undefined) throw failure;
      return clientId === undefined ? undefined : true;
    }, 5_000, "T7_OFFICIAL_APPROVAL_STREAM_READY_TIMEOUT");
    return {
      decisions,
      waitForCount: async (count) => {
        await waitFor(() => {
          if (failure !== undefined) throw failure;
          return decisions.length >= count ? true : undefined;
        }, 8_000, "T7_OFFICIAL_APPROVAL_DECISION_TIMEOUT");
      },
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
        socket.send(JSON.stringify({ type: "cancel", streamId }));
        socket.close(1000, "T7_APPROVAL_DONE");
        await Promise.race([closed, delay(2_000)]);
        await tail;
        if (failure !== undefined) throw failure;
      },
    };
  }

  async connectBrowser(): Promise<FakeBrowserPeer> {
    if (this.peerValue !== undefined) await this.peerValue.close();
    this.peerValue = await FakeBrowserPeer.connect({
      address: {
        host: "127.0.0.1",
        port: this.brokerPort,
        path: WEB_MODEL_PATH,
        url: `ws://127.0.0.1:${this.brokerPort}${WEB_MODEL_PATH}`,
        subprotocol: WEB_MODEL_SUBPROTOCOL,
      },
      pairingToken: this.pairingToken,
      origin: FAKE_EXTENSION_ORIGIN,
      timeoutMs: 2_000,
    });
    await this.waitForConnection("connected");
    return this.peerValue;
  }

  async reconnect(): Promise<RemoteResult<Record<string, unknown>>> {
    const receipt = await this.rpc<Record<string, unknown>>("deepseekWebConnection/reconnect", {});
    this.peerValue = undefined;
    return receipt;
  }

  async restart(): Promise<void> {
    await this.stop();
    assert.equal(await canBindLoopback(this.webPort), true);
    assert.equal(await canBindLoopback(this.brokerPort), true);
    await this.start();
    await this.waitForConnection("waiting_for_browser");
  }

  async rpc<T = unknown>(method: string, args: Record<string, unknown>): Promise<RemoteResult<T>> {
    const launch = this.requiredLaunch();
    const response = await fetch(`${launch.base}/api/${method}`, {
      method: "POST",
      headers: {
        cookie: launch.cookie,
        origin: launch.base,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
    const envelope = await response.json() as { result?: RemoteResult<T> };
    if (envelope.result === undefined) throw new Error(`T7_OFFICIAL_RPC_ENVELOPE_INVALID: ${method}`);
    return envelope.result;
  }

  async followUntil(sessionId: string, predicate: (wire: string) => boolean): Promise<string> {
    const launch = this.requiredLaunch();
    const socket = new WebSocket(`ws://127.0.0.1:${this.webPort}/api/remote.mux`, {
      headers: { cookie: launch.cookie, origin: launch.base },
    });
    const frames: unknown[] = [];
    try {
      await new Promise<void>((resolveOpen, reject) => {
        socket.once("open", resolveOpen);
        socket.once("error", reject);
      });
      socket.on("message", (bytes) => { frames.push(JSON.parse(bytes.toString())); });
      socket.send(JSON.stringify({
        type: "open",
        streamId: `follow-${randomUUID()}`,
        endpoint: "session/follow",
        payload: { args: { request: { address: { kind: "session", sessionId } } } },
      }));
      return await waitFor(() => {
        this.peerValue?.throwIfFailed();
        const wire = JSON.stringify(frames);
        return predicate(wire) ? wire : undefined;
      }, 12_000, "T7_OFFICIAL_SESSION_FOLLOW_TIMEOUT");
    } finally {
      socket.terminate();
    }
  }

  async waitForConnection(phase: string): Promise<Record<string, unknown>> {
    return await this.waitForStatus((status) => status.phase === phase);
  }

  async waitForStatus(
    predicate: (status: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    return await waitFor(async () => {
      const result = await this.rpc<Record<string, unknown>>("deepseekWebConnection/status", {});
      if (!result.ok) throw new Error(`T7_OFFICIAL_CONNECTION_STATUS_FAILED: ${JSON.stringify(result)}`);
      return result.value !== undefined && predicate(result.value) ? result.value : undefined;
    }, 8_000, "T7_OFFICIAL_CONNECTION_STATUS_TIMEOUT");
  }

  async waitForSettings(
    predicate: (description: { namespaces: Array<{ ns: string; value: unknown }> }) => boolean,
  ): Promise<{ namespaces: Array<{ ns: string; value: unknown }> }> {
    return await waitFor(async () => {
      const result = await this.rpc<{ namespaces: Array<{ ns: string; value: unknown }> }>("settings/describe", {});
      if (!result.ok || result.value === undefined) {
        throw new Error(`T7_OFFICIAL_SETTINGS_DESCRIBE_FAILED: ${JSON.stringify(result)}`);
      }
      return predicate(result.value) ? result.value : undefined;
    }, 8_000, "T7_OFFICIAL_SETTINGS_TIMEOUT");
  }

  async stop(): Promise<void> {
    const peer = this.peerValue;
    this.peerValue = undefined;
    await peer?.close().catch(() => undefined);
    const launch = this.launch;
    this.launch = undefined;
    if (launch === undefined) return;
    await terminateChildTree(launch.child, this.root, this.environment);
    await Promise.race([launch.closed, delay(5_000)]);
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.stop(); } catch (error) { failures.push(error); }
    try { assert.equal(await canBindLoopback(this.webPort), true); } catch (error) { failures.push(error); }
    try { assert.equal(await canBindLoopback(this.brokerPort), true); } catch (error) { failures.push(error); }
    try {
      if (!resolve(this.root).startsWith(resolve(tmpdir(), "dsh-t7-official-profile-"))) {
        throw new Error(`refusing to remove unexpected T7 fixture root: ${this.root}`);
      }
      await rm(this.root, { recursive: true, force: true });
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "T7 official fixture cleanup failed");
  }

  async readProfileManifest(): Promise<unknown> {
    return JSON.parse(await readFile(join(this.home, "profiles", "web", "package.json"), "utf8"));
  }

  private requiredLaunch(): WebLaunch {
    if (this.launch === undefined) throw new Error("T7_OFFICIAL_WEB_NOT_STARTED");
    return this.launch;
  }
}

async function waitFor<T>(
  inspect: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await inspect();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(code, lastError === undefined ? {} : { cause: lastError });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}
