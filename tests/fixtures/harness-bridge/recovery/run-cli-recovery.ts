import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPairingToken } from "@deepseek-pp/dsh-web-model-transport";
import type { ModelQueryRequest, ModelStatusResponse } from "@deepseek-pp/web-model-protocol";
import { canBindLoopback, captureChild, createHeadlessEnvironment, createPreparationEnvironment,
  readOnlySessionLog, reserveLoopbackPort, runManagedCommand, terminateChildTree } from "../../dsh-web-agent/run-fake-headless.ts";
import { createRecoveryBrowser } from "./browser.ts";
import { ControlledModelTurn } from "./model.ts";
import { RecoverySockets, waitUntil } from "./socket.ts";
import { FAKE_EXTENSION_ORIGIN } from "../fake-peer/index.ts";

const REPO = resolve(import.meta.dirname, "../../../..");
const DSH = join(REPO, "node_modules/@deepseek-ai/dsh/lib/bin.js");
const BUNDLE = join(REPO, "packages/dsh-web-agent-bundle");
const PROFILE = "deepseek-web-agent";
const BARRIER = join(REPO, "tests/fixtures/dsh-web-agent/startup-barrier.patch.yml");

export type CrashStage = "before_ack" | "accepted" | "streaming" | "terminal_not_delivered";
interface JournalRecord {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly state: string;
  readonly sequence: number;
  readonly remoteStatus?: string;
  readonly terminalDigest?: string;
}
interface Journal { readonly schema_version: number; readonly records: readonly JournalRecord[]; readonly checksum: string }

/** Two launches of the shipped CLI, sharing one untouched profile journal. */
export async function runCliCrashRecovery(stage: CrashStage) {
  const root = await mkdtemp(join(tmpdir(), "dsh-cli-recovery-"));
  const home = join(root, "dsh-home");
  const workspace = join(root, "workspace");
  const cacheFile = join(root, "browser-index.json");
  const journalFile = join(home, "profiles", PROFILE, "web-model-journal", "journal.json");
  const token = createPairingToken();
  const port = await reserveLoopbackPort();
  const preparationEnv = createPreparationEnvironment(process.env, home);
  const browsers: Awaited<ReturnType<typeof createRecoveryBrowser>>[] = [];
  const children: ReturnType<typeof startChild>[] = [];
  let evidence: Record<string, unknown> | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const journal = (): Journal => JSON.parse(readFileSync(journalFile, "utf8")) as Journal;

  function startChild(releaseFile: string) {
    const env = createHeadlessEnvironment(process.env, {
      DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", DSH_WEB_WORKSPACE_ROOT: workspace,
      DSH_WEB_BROKER_PORT: String(port), DSH_WEB_PAIRING_TOKEN: token,
      DSH_WEB_ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGIN, DSH_WEB_FAKE_RELEASE_FILE: releaseFile,
    });
    const command = { executable: process.execPath,
      args: [DSH, "--profile", PROFILE, "--patch", BARRIER, "Complete only this owned recovery fixture turn."] };
    const child = spawn(command.executable, command.args, { cwd: workspace, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const capture = captureChild(child, 20_000, "RECOVERY_CLI_TIMEOUT");
    void capture.result.catch(() => undefined);
    return { child, capture, env, command };
  }

  async function kill(child: ReturnType<typeof startChild>) {
    if (!child.capture.isClosed()) await terminateChildTree(child.child, workspace, child.env);
    await waitUntil(() => child.capture.isClosed(), "RECOVERY_CLI_DID_NOT_CLOSE", 5_000);
    const result = await child.capture.result;
    if (result.stdout.includes(token) || result.stderr.includes(token)) throw new Error("RECOVERY_PAIRING_TOKEN_DISCLOSURE");
    return result;
  }

  async function waitForListener(child: ReturnType<typeof startChild>) {
    await waitUntil(async () => {
      if (child.capture.isClosed()) {
        const result = await child.capture.result;
        if (result.stderr.includes(token)) throw new Error("RECOVERY_PAIRING_TOKEN_DISCLOSURE");
        throw new Error(`RECOVERY_CLI_EARLY_EXIT:${result.exitCode}:${result.stderr}`);
      }
      return tcpListening(port);
    }, "RECOVERY_CLI_NOT_LISTENING", 8_000);
  }

  try {
    await mkdir(workspace);
    await runManagedCommand(process.execPath, [join(BUNDLE, "scripts/seed-profile.mjs"), "--home", home], REPO, preparationEnv, 10_000, "RECOVERY_SEED");
    await runManagedCommand(process.execPath, [DSH, "plugin", "--profile", PROFILE, "add", "--offline", "--workspace-root", BUNDLE],
      workspace, preparationEnv, 30_000, "RECOVERY_INSTALL");

    const release = join(root, "first-ready");
    const first = startChild(release);
    children.push(first);
    await waitForListener(first);
    const firstModel = new ControlledModelTurn();
    const firstSockets = new RecoverySockets();
    if (stage === "terminal_not_delivered") {
      firstSockets.intercept = (frame) => "method" in frame && frame.method === "model.event" && frame.params.event.type === "completed" ? "suppress" : undefined;
    }
    const firstBrowser = await createRecoveryBrowser({ port, pairingToken: token, cacheFile, turnPort: firstModel, sockets: firstSockets });
    browsers.push(firstBrowser);
    await writeFile(release, "ready\n", { flag: "wx" });
    await waitUntil(() => firstModel.turns.length === 1, "RECOVERY_FIRST_GENERATION_MISSING");
    const turn = firstModel.turns[0]!;
    if (stage !== "before_ack") {
      turn.accept();
      await waitUntil(() => firstSockets.outgoing.some((frame) => "result" in frame && frame.result.type === "model.accepted"), "RECOVERY_ACK_MISSING");
      await waitUntil(() => journal().records[0]?.state === "accepted", "RECOVERY_HOST_ACK_NOT_DURABLE");
    }
    if (stage === "streaming" || stage === "terminal_not_delivered") {
      turn.text("Owned fixture partial stream; this is not completion evidence.");
      await waitUntil(() => firstSockets.outgoing.some((frame) => "method" in frame && frame.method === "model.event"), "RECOVERY_FIRST_CHUNK_MISSING");
      await waitUntil(() => journal().records[0]?.state === "streaming" && journal().records[0]?.sequence === 1,
        "RECOVERY_HOST_CHUNK_NOT_DURABLE");
    }
    if (stage === "terminal_not_delivered") {
      turn.finish({ type: "completed", finish_reason: "stop" });
      await waitUntil(() => firstSockets.outgoing.some((frame) => "method" in frame && frame.method === "model.event" && frame.params.event.type === "completed"), "RECOVERY_TERMINAL_NOT_COMMITTED");
    }
    const firstExit = await kill(first);
    const beforeRestart = journal();
    const persisted = await readOnlySessionLog(join(home, "sessions"));
    await firstBrowser.dispose();
    // No completion is injected into the abandoned worker's model promise.
    // Reconstructing the coordinator below models loss of worker-local memory.
    const second = startChild(join(root, "second-must-remain-blocked"));
    children.push(second);
    await waitForListener(second);
    const restartedModel = new ControlledModelTurn();
    const secondBrowser = await createRecoveryBrowser({ port, pairingToken: token, cacheFile, turnPort: restartedModel });
    browsers.push(secondBrowser);
    await waitUntil(() => secondBrowser.sockets.outgoing.some((frame) => "result" in frame && frame.result.type === "model.status"), "RECOVERY_QUERY_RESPONSE_MISSING");
    const queries = secondBrowser.sockets.incoming.filter((frame): frame is ModelQueryRequest => "method" in frame && frame.method === "model.query");
    const statusFrames = secondBrowser.sockets.outgoing.filter((frame): frame is ModelStatusResponse => "result" in frame && frame.result.type === "model.status");
    const status = statusFrames[0]!.result;
    // Short synchronous inspections do not hold a Windows handle across awaits.
    await waitUntil(() => {
      const record = journal().records.find((entry) => entry.requestId === turn.request.request_id);
      return record?.state === "ambiguous" && record.remoteStatus === status.status && record.sequence === status.last_sequence;
    }, "RECOVERY_STATUS_NOT_DURABLE");
    const recovered = journal();
    const secondExit = await kill(second);
    const durable = `${JSON.stringify(beforeRestart)}${JSON.stringify(recovered)}${readFileSync(cacheFile, "utf8")}`;
    if (durable.includes(token) || durable.includes("Owned fixture partial stream")) throw new Error("RECOVERY_DURABLE_CONTENT_LEAK");
    evidence = {
      stage, beforeRestart, recovered, queries: queries.map((frame) => frame.params), status,
      request: turn.request, firstExit, secondExit, persistedRecords: persisted.records,
      initialGenerations: firstSockets.generateCount,
      restartGenerations: secondBrowser.sockets.generateCount,
      restartedModelCalls: restartedModel.turns.length,
      journalPreserved: existsSync(journalFile), command: first.command,
    };
  } catch (error) {
    failure = error;
  } finally {
    for (const browser of browsers) {
      try { await browser.dispose(); } catch (error) { cleanupFailures.push(error); }
    }
    for (const child of children) {
      try { await kill(child); } catch (error) { cleanupFailures.push(error); }
    }
    let portReleased = false;
    try {
      portReleased = await canBindLoopback(port);
      if (!portReleased) cleanupFailures.push(new Error("RECOVERY_PORT_NOT_RELEASED"));
    } catch (error) { cleanupFailures.push(error); }
    const childrenClosed = children.every((child) => child.capture.isClosed());
    if (childrenClosed) {
      try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    } else cleanupFailures.push(new Error("RECOVERY_CHILDREN_STILL_RUNNING"));
    if (evidence) Object.assign(evidence, { portReleased, childrenClosed, tempRemoved: !existsSync(root) });
  }
  if (failure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], "RECOVERY_CLI_FAILED");
  }
  if (evidence === undefined) throw new Error("RECOVERY_EVIDENCE_MISSING");
  return evidence;
}

async function tcpListening(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); resolveProbe(false); }, 100);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolveProbe(false); });
  });
}
