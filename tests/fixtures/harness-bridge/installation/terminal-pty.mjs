// Explicit local PTY acceptance. Never use a user installation or a real browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createRuntimeEnvironment, runProcess } from "../../../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL } from "@deepseek-pp/dsh-web-model-transport";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "../fake-peer/index.ts";
import { createReadLoopScripts, NONCE_FILE } from "../../dsh-web-agent/tool-loop/request-script.ts";
import { canBindLoopback, readOnlySessionLog } from "../../dsh-web-agent/run-fake-headless.ts";

const [home, phase] = process.argv.slice(2);
assert.ok(process.stdin.isTTY && process.stdout.isTTY, "A real PTY is required");
assert.ok(isAbsolute(home) && ["new", "resume"].includes(phase));
const pairing = JSON.parse(await readFile(join(home, "secrets/pairing.json"), "utf8"));
assert.deepEqual(pairing.origins, [FAKE_EXTENSION_ORIGIN], "Only a fixture installation is allowed");
const marker = `${home}.terminal-acceptance.json`, workspace = `${home}.terminal-workspace`;
let previous;
if (phase === "new") {
  await mkdir(workspace);
  await writeFile(join(workspace, NONCE_FILE), `fixture-nonce=${randomBytes(16).toString("hex")}\n`, { flag: "wx" });
} else previous = JSON.parse(await readFile(marker, "utf8"));
const env = createRuntimeEnvironment(process.env);
const child = spawn(process.execPath, [join(home, "dsh-web-agent.mjs"), "start", "--workspace", workspace, "--mode", "readonly",
  ...(previous ? ["--resume", previous.session_id] : [])], {
  cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "inherit",
});
let closed = false, peer;
const completion = new Promise((done, reject) => {
  child.once("error", reject);
  child.once("close", code => { closed = true; done(code); });
});
async function stop() {
  if (closed || !child.pid) return;
  if (process.platform === "win32") await runProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { env, timeoutMs: 5000 });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
}
const watchdog = setTimeout(() => { void stop(); }, 50000);
const interrupt = () => {
  // Windows sends real console Ctrl+C to the inherited launcher too.
  if (process.platform !== "win32" && child.pid && !closed) process.kill(-child.pid, "SIGINT");
};
process.on("SIGINT", interrupt);
try {
  const deadline = Date.now() + 10000;
  while (!peer && !closed && Date.now() < deadline) {
    try {
      peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port: pairing.port, path: WEB_MODEL_PATH,
        url: `ws://127.0.0.1:${pairing.port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL },
      pairingToken: pairing.token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 150 });
    } catch (error) {
      if (!["FAKE_PEER_CONNECT_FAILED", "FAKE_PEER_CONNECT_TIMEOUT"].includes(error.message)) throw error;
      await new Promise(done => setTimeout(done, 25));
    }
  }
  assert.ok(peer, "Installed launcher did not connect");
  if (phase === "new") {
    for (const script of createReadLoopScripts("read")) peer.enqueueGeneration(script);
    peer.enqueueGeneration({ events: [{ type: "text_delta", text: "Second terminal turn completed." }, { type: "completed", finish_reason: "stop" }] });
    process.stderr.write(`PTY fixture ready: enter Read ${NONCE_FILE}, then Second task, then /exit.\n`);
  } else {
    peer.enqueueGeneration(request => {
      assert.equal(request.session_id, previous.session_id);
      assert.ok(JSON.stringify(request.input.messages).includes("Second terminal turn completed."));
      return { events: [{ type: "text_delta", text: "Installed terminal session resumed." }, { type: "completed", finish_reason: "stop" }] };
    });
    process.stderr.write("PTY fixture ready: enter Recall previous tasks, then /exit.\n");
  }
  assert.equal(await completion, 0);
  peer.throwIfFailed();
  assert.equal(peer.observedGenerateRequests.length, phase === "new" ? 3 : 1);
  const persisted = await readOnlySessionLog(join(home, "state/sessions"));
  assert.equal(persisted.records.filter(row => row.type === "turn/end").length, phase === "new" ? 2 : 3);
  assert.equal(persisted.records.filter(row => row.type === "tool/result").length, 1);
  const result = { ok: true, phase, real_pty: true, real_web: false, session_id: peer.observedGenerateRequests[0].session_id };
  if (phase === "new") await writeFile(marker, `${JSON.stringify(result)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  clearTimeout(watchdog);
  process.off("SIGINT", interrupt);
  await peer?.close();
  await stop();
  await completion;
  assert.equal(await canBindLoopback(pairing.port), true);
}
