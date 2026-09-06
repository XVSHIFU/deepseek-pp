// @vitest-environment node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN, type FakeGenerationInput } from "./fixtures/harness-bridge/fake-peer/index.ts";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL, createPairingToken } from "@deepseek-pp/dsh-web-model-transport";
import { canBindLoopback, captureChild, createHeadlessEnvironment, readOnlySessionLog, reserveLoopbackPort, terminateChildTree } from "./fixtures/dsh-web-agent/run-fake-headless.ts";
import { createReadLoopScripts, NONCE_FILE } from "./fixtures/dsh-web-agent/tool-loop/request-script.ts";

const terminal = await import(new URL("../packages/dsh-web-agent-bundle/bin/terminal-app.mjs", import.meta.url).href);
const options = await import(new URL("../packages/dsh-web-agent-bundle/bin/terminal-options.mjs", import.meta.url).href);
const { seedProfile } = await import(new URL("../packages/dsh-web-agent-bundle/scripts/seed-profile.mjs", import.meta.url).href);
const repo = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-terminal-test-")); roots.push(root);
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(workspace);
  const profile = seedProfile(home);
  const manifestPath = join(profile, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = { "@deepseek-pp/dsh-web-agent-bundle": "0.0.0-private" };
  manifest.dsh.profile.bundles = ["@deepseek-pp/dsh-web-agent-bundle"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await symlink(join(repo, "node_modules"), join(profile, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { root, home, workspace };
}

type TerminalInput = string | ((io: { write: (text: string) => void; output: () => string; errors: () => string; peer: FakeBrowserPeer }) => Promise<string>);
async function run(f: Awaited<ReturnType<typeof fixture>>, scripts: readonly FakeGenerationInput[], input: TerminalInput, resume?: string, idleProbe = false) {
  const port = await reserveLoopbackPort(), token = createPairingToken();
  const bundle = join(repo, "packages/dsh-web-agent-bundle");
  const env = createHeadlessEnvironment(process.env, { DSH_HOME: f.home, DSH_TELEMETRY_DISABLED: "1", DSH_WEB_WORKSPACE_ROOT: f.workspace,
    DSH_WEB_BROKER_PORT: String(port), DSH_WEB_PAIRING_TOKEN: token, DSH_WEB_ALLOWED_EXTENSION_ORIGINS: FAKE_EXTENSION_ORIGIN, DSH_WEB_BROWSER_WAIT_MS: "5000" });
  const child = spawn(process.execPath, [join(repo, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", "deepseek-web-agent", "--patch", join(bundle, "cordis.readonly.patch.yml"), "--patch", join(bundle, "bin/browser-ready.patch.yml"), "--patch", join(bundle, "bin/terminal-app.patch.yml"), ...(resume ? ["--resume", resume] : [])], {
    cwd: f.workspace, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const capture = captureChild(child as unknown as Parameters<typeof captureChild>[0], 12000, "TERMINAL_TEST_TIMEOUT");
  void capture.result.catch(() => undefined);
  let peer: FakeBrowserPeer | undefined;
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes.toString(); });
  child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  try {
    const deadline = Date.now() + 6000;
    while (peer === undefined && Date.now() < deadline) {
      if (capture.isClosed()) throw new Error((await capture.result).stderr);
      try { peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port, path: WEB_MODEL_PATH, url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 150 }); }
      catch (error) {
        if (!(error instanceof Error) || !["FAKE_PEER_CONNECT_FAILED", "FAKE_PEER_CONNECT_TIMEOUT"].includes(error.message)) throw error;
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    assert.ok(peer);
    for (const script of scripts) peer.enqueueGeneration(script);
    if (idleProbe) {
      while (!stdout.includes("会话：") && !capture.isClosed() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      if (capture.isClosed()) throw new Error((await capture.result).stderr);
      assert.match(stdout, /会话：/u);
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(peer.observedGenerateRequests.length, 0, "Resume must wait for an explicit new user input");
    }
    child.stdin.end(typeof input === "string" ? input : await input({ write: (text) => { child.stdin.write(text); }, output: () => stdout, errors: () => stderr, peer }));
    const result = await capture.result;
    peer.throwIfFailed();
    assert.equal(result.stderr.includes(token), false);
    return { ...result, requests: structuredClone(peer.observedGenerateRequests) };
  } finally {
    await peer?.close();
    if (!capture.isClosed()) await terminateChildTree(child as unknown as Parameters<typeof terminateChildTree>[0], f.root, env);
    await capture.closed;
    assert.equal(await canBindLoopback(port), true);
  }
}

describe("product terminal argument and resume boundary", () => {
  it("leaves explicit tasks headless and only opens interactive when task is omitted", () => {
    expect(options.validateStartInput({})).toEqual({ interactive: true, resume: undefined });
    expect(options.validateStartInput({ task: "Read README" }).interactive).toBe(false);
    expect(options.parseTerminalArguments(["--resume", "session-123"]).resume).toBe("session-123");
    expect(() => options.validateStartInput({ task: " ", resume: "session-1" })).toThrow("START_TASK_REQUIRED");
    expect(() => options.validateStartInput({ task: "task", resume: "session-1" })).toThrow("START_TASK_RESUME_CONFLICT");
    expect(() => options.parseTerminalArguments(["--continue"])).toThrow("START_TERMINAL_ARGUMENTS_INVALID");
    expect(() => options.validateStartInput({ resume: "../session" })).toThrow("START_RESUME_ID_INVALID");
  });
  it("refuses child sessions and incomplete/error/cancelled or queued history", async () => {
    const f = await fixture();
    for (const extra of [{ origin: "subagent" }, { parentSession: "parent" }, { isSeeded: true }, { delegationDepth: 1 }]) {
      await expect(terminal.validateResumeHeader({ cwd: f.workspace, ...extra }, f.workspace)).rejects.toThrow("START_RESUME_ROOT_SESSION_REQUIRED");
    }
    for (const last of [{ type: "turn/start" }, { type: "turn/end", data: { reason: { kind: "aborted" } } }, { type: "turn/end", data: { reason: { kind: "error" } } }]) expect(() => terminal.validateResumeTail(last)).toThrow("START_RESUME_NOT_QUIESCENT");
    expect(() => terminal.validateResumeTail(undefined, true)).toThrow("START_RESUME_NOT_QUIESCENT");
    expect(() => terminal.validateResumeTail(undefined)).not.toThrow();
    expect(() => terminal.validateResumeTail({ type: "turn/end", data: { reason: { kind: "completed" } } })).not.toThrow();
  });
  it("does not emit model supplied terminal escape/control bytes", () => {
    expect(options.terminalText("text\u001b]52;c;bad\u0007\nnext\u009b")).toBe("text]52;c;bad\nnext");
  });
});

describe("unchanged official CLI with product terminal and fake web model", () => {
  it("runs two separate user turns, reads a real file, resumes that same durable session, and rejects a different cwd without model work", async () => {
    const f = await fixture();
    const nonce = `fixture-nonce=${randomBytes(16).toString("hex")}`;
    await writeFile(join(f.workspace, NONCE_FILE), nonce);
    const first = await run(f, [...createReadLoopScripts("read"), (request) => {
      assert.ok(JSON.stringify(request.input.messages).includes(nonce));
      return { events: [{ type: "text_delta", text: "Second user turn completed." }, { type: "completed", finish_reason: "stop" }] };
    }], `Read ${NONCE_FILE}\nRemember the previous result\n`);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Read complete: ${nonce}`);
    expect(first.stdout).toContain("Second user turn completed.");
    expect(first.requests).toHaveLength(3);
    const persisted = await readOnlySessionLog(join(f.home, "sessions"));
    expect(persisted.records.filter((row) => row.type === "turn/end")).toHaveLength(2);
    expect(persisted.records.filter((row) => row.type === "tool/result")).toHaveLength(1);
    const sessionId = first.requests[0]!.session_id;
    expect(new Set(first.requests.map((request) => request.session_id)).size).toBe(1);
    for (let reopen = 0; reopen < 2; reopen++) {
      const idle = await run(f, [], "/exit\n", sessionId, true);
      expect(idle.exitCode, idle.stderr).toBe(0);
      expect(idle.requests).toHaveLength(0);
    }
    const resumed = await run(f, [(request) => {
      assert.equal(request.session_id, sessionId);
      assert.ok(JSON.stringify(request.input.messages).includes(nonce));
      assert.ok(JSON.stringify(request.input.messages).includes("Second user turn completed."));
      return { events: [{ type: "text_delta", text: "Same session resumed." }, { type: "completed", finish_reason: "stop" }] };
    }], "Recall our prior turns\n/exit\n", sessionId, true);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.requests).toHaveLength(1);
    expect(resumed.stdout).toContain("Same session resumed.");
    const after = await readOnlySessionLog(join(f.home, "sessions"));
    expect(after.logCount).toBe(1);
    expect(after.records.filter((row) => row.type === "turn/end")).toHaveLength(3);
    const different = join(f.root, "other-workspace"); await mkdir(different);
    const rejected = await run({ ...f, workspace: different }, [], "must not be sent\n", sessionId);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("START_RESUME_WORKSPACE_MISMATCH");
    expect(rejected.requests).toHaveLength(0);
    expect((await readOnlySessionLog(join(f.home, "sessions"))).raw).toBe(after.raw);
  }, 30000);
  it("materializes an empty root for a later explicit resume without requesting the model", async () => {
    const f = await fixture();
    const empty = await run(f, [], "/exit\n");
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(empty.requests).toHaveLength(0);
    const id = empty.stdout.match(/会话：(session-[a-z0-9-]+)/u)?.[1];
    expect(id).toBeDefined();
    const resumed = await run(f, [], "/exit\n", id, true);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.requests).toHaveLength(0);
    expect((await readOnlySessionLog(join(f.home, "sessions"))).logCount).toBe(1);
  }, 15000);
  it("shows a real model error without retrying and admits only the next explicit user input", async () => {
    const f = await fixture();
    const result = await run(f, [{ events: [{ type: "failed", error: { code: "DEEPSEEK_AUTH_REQUIRED", message: "Fixture requires login", retryable: false, external_outcome: "started" } }] },
      { events: [{ type: "text_delta", text: "Explicit follow-up completed." }, { type: "completed", finish_reason: "stop" }] }], async (io) => {
      io.write("First task\n");
      const deadline = Date.now() + 5000;
      while (!io.errors().includes("DEEPSEEK_AUTH_REQUIRED") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      assert.match(io.errors(), /本轮失败：DEEPSEEK_AUTH_REQUIRED/u);
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(io.peer.observedGenerateRequests.length, 1);
      return "New explicit task\n/exit\n";
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Explicit follow-up completed.");
    expect(result.requests).toHaveLength(2);
    expect(result.stderr).not.toContain("TypeError");
    const log = await readOnlySessionLog(join(f.home, "sessions"));
    expect(log.records.filter((row) => row.type === "turn/end").map((row) => (row.data as { reason: { kind: string } }).reason.kind)).toEqual(["error", "completed"]);
  }, 15000);
  it("refuses a failed persisted turn on resume without repairing, generating, or touching its log", async () => {
    const f = await fixture();
    const failed = await run(f, [{ events: [{ type: "failed", error: { code: "DEEPSEEK_AUTH_REQUIRED", message: "Fixture requires login", retryable: false, external_outcome: "started" } }] }], "One failed task\n/exit\n");
    expect(failed.exitCode).toBe(0); // Interactive shell exited normally; the shown turn did not succeed.
    expect(failed.stderr).toContain("DEEPSEEK_AUTH_REQUIRED");
    const before = await readOnlySessionLog(join(f.home, "sessions"));
    const rejected = await run(f, [], "Do not send\n", failed.requests[0]!.session_id);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("START_RESUME_NOT_QUIESCENT");
    expect(rejected.requests).toHaveLength(0);
    expect((await readOnlySessionLog(join(f.home, "sessions"))).raw).toBe(before.raw);
  }, 15000);
});
