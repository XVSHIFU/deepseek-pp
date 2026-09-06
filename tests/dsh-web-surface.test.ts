// @vitest-environment node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn as spawnPty } from "node-pty";
import { afterEach, it } from "vitest";
import WebSocket from "ws";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "./fixtures/harness-bridge/fake-peer/index.ts";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL, createPairingToken } from "@deepseek-pp/dsh-web-model-transport";
import { canBindLoopback, captureChild, createHeadlessEnvironment, reserveLoopbackPort, terminateChildTree } from "./fixtures/dsh-web-agent/run-fake-headless.ts";
import { createReadLoopScripts, NONCE_FILE } from "./fixtures/dsh-web-agent/tool-loop/request-script.ts";
import { createFileEditLoopScripts, EDIT_NONCE_FILE, OLD_STATE } from "./fixtures/dsh-web-agent/mutation/file-edit-loop.ts";

const { seedProfile } = await import(new URL("../packages/dsh-web-agent-bundle/scripts/seed-profile.mjs", import.meta.url).href);
const repo = resolve(import.meta.dirname, "..");
const installedHome = process.env.DSH_WEB_SURFACE_INSTALL_HOME;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(process.env.DSH_WEB_SURFACE_INSPECT === "1" ? ["readonly"] : ["readonly", "files"])("serves the official authenticated UI and admits a real %s loop through the official Remote controller", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-web-surface-"));
  // Explicit installed acceptance retains its owned fixtures as disk evidence.
  if (installedHome === undefined) roots.push(root);
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, NONCE_FILE), `fixture-nonce=${randomBytes(16).toString("hex")}`);
  const editNonce = randomBytes(16).toString("hex"), editTarget = join(workspace, EDIT_NONCE_FILE);
  await writeFile(editTarget, `file-edit-nonce=${editNonce}\n${OLD_STATE}\n`);
  let port: number, token: string;
  if (installedHome === undefined) {
    const profile = seedProfile(home);
    const manifestPath = join(profile, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = { "@deepseek-pp/dsh-web-agent-bundle": "0.0.0-private" };
    manifest.dsh.profile.bundles = ["@deepseek-pp/dsh-web-agent-bundle"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await symlink(join(repo, "node_modules"), join(profile, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    port = await reserveLoopbackPort(); token = createPairingToken();
  } else {
    assert.ok(isAbsolute(installedHome) && basename(installedHome).startsWith("dsh-web-installed-"));
    const receipt = JSON.parse(await readFile(`${installedHome}.acceptance.json`, "utf8"));
    assert.equal(receipt.stage, "installed");
    assert.equal(existsSync(`${installedHome}.input`), false);
    assert.equal(existsSync(`${installedHome}.input.unavailable/distribution.json`), true);
    const pairing = JSON.parse(await readFile(join(installedHome, "secrets/pairing.json"), "utf8"));
    assert.deepEqual(pairing.origins, [FAKE_EXTENSION_ORIGIN], "Never use a real browser installation");
    port = pairing.port; token = pairing.token;
  }
  const webPort = await reserveLoopbackPort();
  const env = createHeadlessEnvironment(process.env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", DSH_WEB_WORKSPACE_ROOT: workspace, DSH_WEB_TOOL_MODE: mode,
    DSH_WEB_BROKER_PORT: String(port), DSH_WEB_PAIRING_TOKEN: token, DSH_WEB_ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGIN });
  const bundle = join(repo, "packages/dsh-web-agent-bundle");
  const modePatches = mode === "readonly" ? ["cordis.readonly.patch.yml"] : ["cordis.workspace-files.patch.yml", "cordis.harness-features.patch.yml"];
  let stdout = "", stderr = "", peer: FakeBrowserPeer | undefined;
  const launch = () => {
    stdout = ""; stderr = "";
    if (installedHome !== undefined) {
      const pty = spawnPty(process.execPath, [join(installedHome, "dsh-web-agent.mjs"), "web", "--workspace", workspace, "--mode", mode, "--no-open", "--port", String(webPort)], {
        name: "xterm-color", cols: 1000, rows: 50, cwd: workspace, env: createHeadlessEnvironment(process.env, {}),
      });
      let closed = false;
      pty.onData(data => { stdout += data.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""); });
      const watchdog = setTimeout(() => pty.kill(), 18000);
      const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>(done => pty.onExit(event => {
        closed = true; clearTimeout(watchdog); done({ exitCode: event.exitCode, stdout, stderr });
      }));
      const capture = { result, closed: result.then(() => undefined), isClosed: () => closed };
      const stop = async () => {
        if (!closed) pty.write("\x03"); // Real terminal Ctrl+C reaches launcher and official DSH.
        const end = Date.now() + 7000;
        while (!closed && Date.now() < end) await new Promise(done => setTimeout(done, 20));
        if (!closed) { pty.kill(); await capture.closed; assert.fail("INSTALLED_WEB_GRACEFUL_EXIT_TIMEOUT"); }
        pty.kill(); // Also release the ConPTY owner after normal process exit.
        const outcome = await result;
        assert.equal(outcome.exitCode, 130, outcome.stdout);
        assert.doesNotMatch(outcome.stdout, /fatal load failure|cannot get property|START_TERMINAL_FAILED/);
      };
      return { capture, stop };
    }
    const child = spawn(process.execPath, [join(repo, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", "deepseek-web-agent", ...modePatches.flatMap(patch => ["--patch", join(bundle, patch)]), "--patch", join(bundle, "bin/web-app.patch.yml"), "--no-open", "--port", String(webPort)], { cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const capture = captureChild(child as unknown as Parameters<typeof captureChild>[0], process.env.DSH_WEB_SURFACE_INSPECT === "1" ? 48000 : 18000, "WEB_SURFACE_TIMEOUT");
    void capture.result.catch(() => undefined);
    child.stdout.on("data", b => { stdout += b.toString(); }); child.stderr.on("data", b => { stderr += b.toString(); });
    const stop = async () => {
      if (!capture.isClosed()) await terminateChildTree(child as unknown as Parameters<typeof terminateChildTree>[0], root, env);
      await capture.closed;
    };
    return { capture, stop };
  };
  let { capture, stop } = launch();
  try {
    const deadline = Date.now() + 12000;
    while (!stdout.includes("?token=") && Date.now() < deadline && !capture.isClosed()) await new Promise(done => setTimeout(done, 20));
    assert.match(stdout, /http:\/\/127\.0\.0\.1:\d+\/\?token=/, stderr);
    const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)![0];
    const base = `http://127.0.0.1:${webPort}`;
    assert.equal((await fetch(base)).status, 401);
    const exchange = await fetch(url, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    let cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await fetch(base, { headers: { cookie } })).text();
    assert.ok(html.includes("__DSH_BOOT__"));
    assert.ok(html.includes("@deepseek-ai/dsh-client-ui-chat"));
    assert.ok(!html.includes("@deepseek-ai/dsh-client-ui-settings-models"));
    const rpcArgs = async (method: string, args: unknown) => (await fetch(`${base}/api/${method}`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } }) })).json();
    const rpc = (method: string, request: unknown) => rpcArgs(method, { request });
    const follow = async (sessionId: string, matches: (text: string) => boolean) => {
      const socket = new WebSocket(`ws://127.0.0.1:${webPort}/api/remote.mux`, { headers: { cookie, origin: base } });
      const frames: any[] = [];
      try {
        await new Promise<void>((done, reject) => { socket.once("open", done); socket.once("error", reject); });
        socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
        socket.send(JSON.stringify({ type: "open", streamId: "follow-1", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } }));
        const end = Date.now() + 4000;
        while (!matches(JSON.stringify(frames)) && Date.now() < end) await new Promise(done => setTimeout(done, 20));
        assert.ok(matches(JSON.stringify(frames)), JSON.stringify(frames));
        return frames;
      } finally { socket.terminate(); }
    };
    const denied = await rpc("session/create", { cwd: root });
    assert.equal(denied.result.ok, false); assert.match(denied.result.error.message, /WEB_WORKSPACE_FIXED/);
    const preset = await rpc("session/create", { cwd: workspace, agentPreset: "standard" });
    assert.equal(preset.result.ok, false); assert.match(preset.result.error.message, /WEB_PRESET_FIXED/);
    const invalidId = await rpc("session/create", { cwd: workspace, sessionId: "custom-unusable-id" });
    assert.equal(invalidId.result.ok, false); assert.match(invalidId.result.error.message, /WEB_SESSION_ID_INVALID/);
    const creation = await rpc("session/create", { cwd: workspace });
    assert.equal(creation.result.ok, true, JSON.stringify(creation));
    const sessionId = creation.result.value.sessionId;
    peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port, path: WEB_MODEL_PATH, url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 1000 });
    if (mode === "readonly") for (const script of createReadLoopScripts("read")) peer.enqueueGeneration(script);
    else for (const script of createFileEditLoopScripts()) peer.enqueueGeneration(request => {
      assert.deepEqual(request.tools.map(tool => tool.name).sort(), ["skill", "str_replace_editor", "subagent"]);
      return script({ ...request, tools: request.tools.filter(tool => tool.name === "str_replace_editor") });
    });
    const task = mode === "readonly" ? "Read nonce.txt" : `View and edit this file. FILE_EDIT_TARGET_JSON=${JSON.stringify(editTarget)}`;
    const prompt = await rpc("session/prompt", { requestId: randomUUID(), mode: "queue", sessionId, content: [{ type: "text", text: task }] });
    assert.equal(prompt.result.ok, true, JSON.stringify(prompt));
    await follow(sessionId, text => text.includes("complete:") && text.includes("turn/end"));
    assert.equal(peer.observedGenerateRequests.length, mode === "readonly" ? 2 : 3);
    if (mode === "files") assert.equal(await readFile(editTarget, "utf8"), `file-edit-nonce=${editNonce}\nstate=verified-${editNonce}\n`);
    const model = await rpc("session/selectModel", { sessionId, provider: "deepseek-official", model: "deepseek-v4-flash" });
    assert.equal(model.result.ok, false); assert.match(model.result.error.message, /WEB_CONFIGURATION_FIXED/);
    peer.throwIfFailed();
    // Explicit, bounded developer inspection only; the ordinary test never waits.
    if (process.env.DSH_WEB_SURFACE_INSPECT === "1") {
      console.log(JSON.stringify({ status: "official_web_fixture_ready", url, workspace, sessionId }));
      peer.enqueueGeneration({ events: [{ type: "text_delta", text: "Official Harness web fixture is connected." }, { type: "completed", finish_reason: "stop" }] });
      const heartbeat = setInterval(() => peer!.heartbeat(), 2000);
      try { await new Promise(done => setTimeout(done, 35000)); }
      finally { clearInterval(heartbeat); }
    } else {
      if (mode === "files") {
        const childMarker = `CHILD_CONFIRMED=${randomBytes(8).toString("hex")}`;
        peer.enqueueGeneration({ events: [{ type: "tool_call", tool_call_id: "web-child", name: "subagent", arguments: { description: "Confirm web fixture", prompt: `Return ${childMarker}` } }, { type: "completed", finish_reason: "tool_calls" }] });
        peer.enqueueGeneration(request => {
          assert.notEqual(request.session_id, sessionId);
          assert.ok(JSON.stringify(request.input.messages).includes(childMarker));
          return { events: [{ type: "text_delta", text: childMarker }, { type: "completed", finish_reason: "stop" }] };
        });
        peer.enqueueGeneration(request => {
          assert.equal(request.session_id, sessionId);
          assert.ok(request.input.messages.flatMap(message => message.content).some(block => block.type === "tool_result" && JSON.stringify(block).includes(childMarker)));
          return { events: [{ type: "text_delta", text: "Delegation complete." }, { type: "completed", finish_reason: "stop" }] };
        });
        assert.equal((await rpc("session/prompt", { requestId: randomUUID(), mode: "queue", sessionId, content: [{ type: "text", text: "Delegate fixture confirmation." }] })).result.ok, true);
        await follow(sessionId, text => text.includes("Delegation complete."));
        assert.equal(peer.observedGenerateRequests.length, 6);
      }
      const renamed = await rpc("session/rename", { sessionId, title: "Saved web fixture" });
      assert.equal(renamed.result.ok, true, JSON.stringify(renamed));
      const abortedId = (await rpc("session/create", { cwd: workspace })).result.value.sessionId;
      peer.enqueueGeneration({ delivery: "after_cancel", events: [{ type: "failed", error: { code: "CANCELLED", message: "Fixture cancelled", retryable: false, external_outcome: "started" } }] });
      assert.equal((await rpc("session/prompt", { requestId: randomUUID(), mode: "queue", sessionId: abortedId, content: [{ type: "text", text: "Wait for cancellation" }] })).result.ok, true);
      await peer.waitForGenerateCount(mode === "readonly" ? 3 : 7);
      assert.equal((await rpc("session/cancel", { sessionId: abortedId })).result.ok, true);
      await follow(abortedId, text => text.includes("turn/end"));
      await peer.close(); peer = undefined;
      await stop();
      ({ capture, stop } = launch());
      const restartedBy = Date.now() + 7000;
      while (!stdout.includes("?token=") && Date.now() < restartedBy && !capture.isClosed()) await new Promise(done => setTimeout(done, 20));
      assert.match(stdout, /\?token=/, stderr);
      const exchange2 = await fetch(stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)![0], { redirect: "manual" });
      cookie = exchange2.headers.get("set-cookie")!.split(";")[0]!;
      const abortedPage = await rpc("session/page", { address: { kind: "session", sessionId: abortedId }, throughSeq: 0 });
      assert.equal(abortedPage.result.ok, true, JSON.stringify(abortedPage));
      await follow(abortedId, text => text.includes("START_RESUME_NOT_QUIESCENT"));
      const rejectedResume = await rpc("session/prompt", { requestId: randomUUID(), mode: "queue", sessionId: abortedId, content: [{ type: "text", text: "Do not replay" }] });
      assert.equal(rejectedResume.result.ok, false);
      const lookupResume = await rpcArgs("commands/list", { agentId: abortedId });
      assert.equal(lookupResume.result.ok, false, JSON.stringify(lookupResume));
      assert.match(lookupResume.result.error.message, /START_RESUME_NOT_QUIESCENT/);
      const settingsWrite = await rpcArgs("settings/mutate", { ns: "llm", ops: [], expectedRevision: 0 });
      assert.equal(settingsWrite.result.ok, false); assert.match(settingsWrite.result.error.message, /WEB_CONFIGURATION_FIXED/);
      const credentialWrite = await rpcArgs("credentials/set", { ref: "DEEPSEEK_API_KEY", value: "fixture-forbidden-value" });
      assert.equal(credentialWrite.result.ok, false); assert.match(credentialWrite.result.error.message, /WEB_CONFIGURATION_FIXED/);
      peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port, path: WEB_MODEL_PATH, url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 1000 });
      await follow(sessionId, text => text.includes("complete:"));
      assert.equal(peer.observedGenerateRequests.length, 0, "Opening completed history must never generate");
      peer.enqueueGeneration(request => {
        assert.match(JSON.stringify(request.input.messages), /complete:/);
        return { events: [{ type: "text_delta", text: "History restored." }, { type: "completed", finish_reason: "stop" }] };
      });
      const resumed = await rpc("session/prompt", { requestId: randomUUID(), mode: "queue", sessionId, content: [{ type: "text", text: "Remember the previous task?" }] });
      assert.equal(resumed.result.ok, true, JSON.stringify(resumed));
      await follow(sessionId, text => text.includes("History restored."));
      assert.equal(peer.observedGenerateRequests.length, 1);
      peer.throwIfFailed();
      if (installedHome !== undefined) console.log(JSON.stringify({ ok: true, acceptance: "installed-official-web", installed_home: installedHome, mode, workspace, session_id: sessionId,
        launcher: "web", input_unavailable: true, real_web: false, tool_calls: mode === "readonly" ? 1 : 3, file_verified: mode === "files", subagent_verified: mode === "files", cold_resume_verified: true, cancelled_resume_blocked: true }));
    }
  } finally {
    await peer?.close();
    await stop();
    assert.equal(await canBindLoopback(port), true);
    assert.equal(await canBindLoopback(webPort), true);
    if (installedHome !== undefined) {
      assert.equal(existsSync(join(installedHome, ".installation.lock")), false);
      assert.equal(existsSync(join(installedHome, "state/profiles/deepseek-web-agent/web-model-journal/owner.lock")), false);
    }
  }
}, process.env.DSH_WEB_SURFACE_INSPECT === "1" ? 50000 : 22000);
