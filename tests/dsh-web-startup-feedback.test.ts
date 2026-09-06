// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const { seedProfile } = await import(new URL("../packages/dsh-web-agent-bundle/scripts/seed-profile.mjs", import.meta.url).href);
const { createRuntimeEnvironment, runProcess } = await import(new URL("../packages/dsh-web-agent-bundle/bin/install-runtime.mjs", import.meta.url).href);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function runOriginalCli(mode: string, input = "") {
  const root = await mkdtemp(join(tmpdir(), "dsh-startup-feedback-"));
  roots.push(root);
  const home = join(root, "home");
  const profile = seedProfile(home);
  const rows = [
    { id: "fixture", name: pathToFileURL(resolve("tests/fixtures/harness-bridge/startup-feedback.mjs")).href },
    { id: "browser-ready", name: pathToFileURL(resolve("packages/dsh-web-agent-bundle/bin/browser-ready.mjs")).href },
  ];
  await writeFile(join(profile, "cordis.patch.yml"), JSON.stringify([{ insert: rows }]));
  const env = createRuntimeEnvironment(process.env, {
    DSH_HOME: home, DSH_WEB_BROWSER_WAIT_MS: mode === "cancel" ? "1000" : "200", DSH_FEEDBACK_FIXTURE_MODE: mode,
  });
  const child = spawn(process.execPath, [resolve("node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", "deepseek-web-agent"], {
    cwd: root, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") void runProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { env, timeoutMs: 5000 });
    else if (child.pid) process.kill(-child.pid, "SIGKILL");
  }, 6000);
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  expect(timedOut, stderr).toBe(false);
  const lifecycle = JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8"));
  expect(lifecycle.closed, stderr).toBe(true);
  expect(() => process.kill(lifecycle.pid, 0)).toThrow();
  const probe = createServer();
  await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(lifecycle.port, "127.0.0.1", done); });
  await new Promise<void>((done) => probe.close(() => done()));
  return { code, stdout, stderr, ready: lifecycle.ready };
}

describe("expected browser wait outcomes use the original CLI exit lifecycle", () => {
  it("prints a short retry instruction, exits nonzero, never starts the app and releases owned resources", async () => {
    const result = await runOriginalCli("timeout");
    expect(result).toMatchObject({ code: 1, stdout: "", ready: false });
    expect(result.stderr).toMatch(/^WAITING_FOR_BROWSER: 等待浏览器连接超时；[^\n]+\n$/u);
    expect(result.stderr).not.toContain("Error:");
  }, 10000);

  it("cancels before startup without converting cancellation to success", async () => {
    const result = await runOriginalCli("cancel");
    expect(result).toMatchObject({ code: 130, stdout: "", ready: false });
    expect(result.stderr).toContain("BROWSER_WAIT_CANCELLED");
    expect(result.stderr).not.toContain("Error:");
  }, 10000);

  it("does not suppress an unexpected exception or relabel it as browser unavailable", async () => {
    const result = await runOriginalCli("unknown");
    expect(result).toMatchObject({ code: 1, stdout: "", ready: false });
    expect(result.stderr).toContain("UNEXPECTED_FIXTURE_FAILURE");
    expect(result.stderr).toContain("Error:");
    expect(result.stderr).not.toContain("WAITING_FOR_BROWSER");
  }, 10000);

  it("preserves task stdout, ANSI and stdin bytes and leaves appReady to the original CLI", async () => {
    const result = await runOriginalCli("stdio", "第二轮输入\r\n");
    expect(result).toEqual({ code: 0, stderr: "", ready: true, stdout: "\u001b[32m网页模型终答：\u001b[0m\n第二轮输入\r\n" });
  }, 10000);
});

describe("product parent cancellation does not preempt the official disposer", () => {
  it.each(["graceful", "stalled", "second-interrupt"])("waits for close and restores parent listeners: %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-startup-parent-"));
    roots.push(root);
    const outcome = await runProcess(process.execPath, [resolve("tests/fixtures/harness-bridge/startup-parent-cancel.mjs"), mode, root], {
      cwd: root, env: createRuntimeEnvironment(process.env), timeoutMs: 12000,
    });
    expect(outcome.code, outcome.stderr).toBe(0);
    const result = JSON.parse(await readFile(join(root, "outcome.json"), "utf8"));
    expect(result).toMatchObject({ code: 130, childClosed: true, abortMessages: 1, stdout: "", stderr: "" });
    expect(result.after).toEqual(result.before);
    if (mode === "graceful") expect(result.flushed).toBe(true);
    else expect(result.flushed).toBe(false);
    if (mode === "second-interrupt") {
      expect(result.disposing).toBe(true);
      // Prove the second signal force-closes before the 5500 ms fallback.
      expect(result.secondInterruptElapsedMs).toBeLessThan(5000);
    }
  }, 14000);
});
