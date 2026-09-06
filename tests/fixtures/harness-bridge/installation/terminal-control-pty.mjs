// Explicit local acceptance with Harness's pinned node-pty dependency.
// Runs the unchanged official CLI in a real PTY against only an owned fixture.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node-pty";
import { seedProfile } from "../../../../packages/dsh-web-agent-bundle/scripts/seed-profile.mjs";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL, createPairingToken } from "@deepseek-pp/dsh-web-model-transport";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "../fake-peer/index.ts";
import { createReadLoopScripts, NONCE_FILE } from "../../dsh-web-agent/tool-loop/request-script.ts";
import { canBindLoopback, createHeadlessEnvironment, readOnlySessionLog, reserveLoopbackPort } from "../../dsh-web-agent/run-fake-headless.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const root = await mkdtemp(join(tmpdir(), "dsh-terminal-control-pty-"));
const home = join(root, "home"), workspace = join(root, "workspace");
const port = await reserveLoopbackPort(), token = createPairingToken();
let child, peer, completion, closed = false, output = "";
const deadline = Date.now() + 45000;
const waitFor = async (predicate, label) => {
  while (!predicate() && !closed && Date.now() < deadline) { peer?.throwIfFailed(); await new Promise(done => setTimeout(done, 20)); }
  assert.ok(predicate(), `${label}: ${output}`);
};
const watchdog = setTimeout(() => child?.kill(), 45000);
try {
  await mkdir(workspace);
  await writeFile(join(workspace, NONCE_FILE), `fixture-nonce=${randomBytes(16).toString("hex")}`);
  const profile = seedProfile(home), manifestPath = join(profile, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = { "@deepseek-pp/dsh-web-agent-bundle": "0.0.0-private" };
  manifest.dsh.profile.bundles = ["@deepseek-pp/dsh-web-agent-bundle"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await symlink(join(repo, "node_modules"), join(profile, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const bundle = join(repo, "packages/dsh-web-agent-bundle");
  const env = createHeadlessEnvironment(process.env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", DSH_WEB_WORKSPACE_ROOT: workspace,
    DSH_WEB_BROKER_PORT: String(port), DSH_WEB_PAIRING_TOKEN: token, DSH_WEB_ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGIN, DSH_WEB_BROWSER_WAIT_MS: "5000" });
  child = spawn(process.execPath, [join(repo, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", "deepseek-web-agent",
    ...["cordis.readonly.patch.yml", "bin/browser-ready.patch.yml", "bin/terminal-app.patch.yml"].flatMap(path => ["--patch", join(bundle, path)])],
  { name: "xterm-color", cols: 120, rows: 30, cwd: workspace, env });
  child.onData(data => { output += data; });
  completion = new Promise(done => child.onExit(result => { closed = true; done(result); }));
  while (!peer && !closed && Date.now() < deadline) {
    try { peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port, path: WEB_MODEL_PATH,
      url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 150 }); }
    catch (error) { if (!["FAKE_PEER_CONNECT_FAILED", "FAKE_PEER_CONNECT_TIMEOUT"].includes(error.message)) throw error; await new Promise(done => setTimeout(done, 20)); }
  }
  assert.ok(peer);
  for (const script of createReadLoopScripts("read")) peer.enqueueGeneration(script);
  peer.enqueueGeneration({ delivery: "after_cancel", events: [{ type: "failed", error: { code: "CANCELLED", message: "Fixture cancelled", retryable: false, external_outcome: "started" } }] });
  await waitFor(() => output.includes("你 >"), "terminal ready");
  child.write(`Read ${NONCE_FILE}\r`);
  await waitFor(() => output.includes("Read complete:"), "real read result");
  child.write("Wait for cancellation\r");
  await waitFor(() => peer.observedGenerateRequests.length === 3, "active model request");
  child.write("\x03"); // Actual terminal Ctrl+C, not process.emit or child.kill.
  const result = await completion;
  assert.equal(result.exitCode, 130, output);
  assert.doesNotMatch(output, /START_TERMINAL_FAILED|cannot get property|inactive context|fatal load failure/u);
  assert.equal(peer.cancelRequestCount, 1);
  const log = await readOnlySessionLog(join(home, "sessions"));
  assert.equal(log.records.filter(row => row.type === "tool/result").length, 1);
  assert.deepEqual(log.records.filter(row => row.type === "turn/end").map(row => row.data.reason.kind), ["completed", "aborted"]);
  process.stdout.write(`${JSON.stringify({ ok: true, real_pty: true, real_web: false, exit_code: result.exitCode, model_steps: 3, tool_results: 1, cancelled_requests: peer.cancelRequestCount, cancelled_turn_persisted: true })}\n`);
} finally {
  clearTimeout(watchdog);
  // node-pty still owns its ConPTY host/worker after the inner process exits.
  // Release that exact PTY even when onExit has already fired.
  child?.kill();
  await completion;
  await peer?.close();
  assert.equal(await canBindLoopback(port), true);
  await rm(root, { recursive: true, force: true });
}
