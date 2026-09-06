// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "./fixtures/harness-bridge/fake-peer/index.ts";
import { captureChild, createHeadlessEnvironment, reserveLoopbackPort, terminateChildTree, readOnlySessionLog } from "./fixtures/dsh-web-agent/run-fake-headless.ts";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL } from "@deepseek-pp/dsh-web-model-transport";

const installer = await import(new URL("../packages/dsh-web-agent-bundle/bin/install-runtime.mjs", import.meta.url).href);
const browserReady = await import(new URL("../packages/dsh-web-agent-bundle/bin/browser-ready.mjs", import.meta.url).href);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "dsh-installer-test-")); roots.push(root); return root; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function manifestFixture(overrides: Record<string, unknown> = {}) {
  const directory = await temporary();
  const manifest = { schema_version: 1, kind: "local-development", node_major: 24, harness_version: "0.1.2-rc.1", source_commit: "1".repeat(40),
    files: Array.from({ length: 10 }, (_, index) => ({ path: `packages/web-model-protocol/src/fixture-${index}.ts`, sha256: "0".repeat(64) })), ...overrides };
  const raw = JSON.stringify(manifest);
  await writeFile(join(directory, "distribution.json"), raw);
  return { directory, expectedSha256: hash(raw) };
}

describe("fixed local Harness installer boundary", () => {
  it.each(["20.19.0", "22.10.0", "25.0.0", "24", "latest"])("refuses unsupported Node %s", (version) => {
    expect(() => installer.assertNodeVersion(version)).toThrow("INSTALL_NODE_24_REQUIRED");
  });
  it("accepts the pinned Node major without a floating upgrade", () => {
    expect(() => installer.assertNodeVersion("24.18.0")).not.toThrow();
    expect(existsSync(installer.findNpmCli())).toBe(true);
  });
  it("drops API, bootstrap, npm and pairing input variables and retains only owned pairing", () => {
    const result = installer.createRuntimeEnvironment({ PATH: "system", DEEPSEEK_API_KEY: "not-read", NODE_OPTIONS: "--import unsafe", NODE_PATH: "foreign", NPM_CONFIG_USERCONFIG: "secret.npmrc", DSH_HOME: "foreign", DSH_WEB_PAIRING_TOKEN: "foreign" }, { DSH_HOME: "owned", DSH_WEB_PAIRING_TOKEN: "owned-token" });
    expect(result).toEqual({ PATH: "system", DSH_HOME: "owned", DSH_WEB_PAIRING_TOKEN: "owned-token", DSH_TELEMETRY_DISABLED: "1" });
  });
  it("requires the operator's exact manifest SHA before touching a home", async () => {
    const fixture = await manifestFixture();
    await expect(installer.readDistribution(fixture.directory, {})).rejects.toThrow("DISTRIBUTION_IDENTITY_REQUIRED");
    await expect(installer.readDistribution(fixture.directory, { expectedSha256: "f".repeat(64) })).rejects.toThrow("DISTRIBUTION_HASH_MISMATCH");
  });
  it.each([{ schema_version: 2 }, { kind: "release" }, { node_major: 25 }, { harness_version: "latest" }, { source_commit: "master" }, { extra: true }])("rejects malformed or future source identity %j", async (change) => {
    const fixture = await manifestFixture(change);
    await expect(installer.readDistribution(fixture.directory, fixture)).rejects.toThrow("DISTRIBUTION_MANIFEST_INVALID");
  });
  it.each(["../escape", "/absolute", "C:/absolute", "packages/web-model-protocol/../escape", "packages/web-model-protocol//empty", "packages/web-model-protocol/.env", "node_modules/foreign/index.js"])("rejects path %s before loading source", async (path) => {
    const fixture = await manifestFixture({ files: Array.from({ length: 10 }, () => ({ path, sha256: "0".repeat(64) })) });
    await expect(installer.readDistribution(fixture.directory, fixture)).rejects.toThrow(/DISTRIBUTION_PATH_/);
  });
  it("rejects junction/symlink distribution roots", async () => {
    const root = await temporary();
    const actual = join(root, "actual"), link = join(root, "link");
    await mkdir(actual); await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
    await expect(installer.readDistribution(link, { expectedSha256: "0".repeat(64) })).rejects.toThrow("INSTALL_LINK_PATH_DENIED");
  });
  it("does not treat a null task timeout as an immediate timer", async () => {
    const result = await installer.runProcess(process.execPath, ["-e", "setTimeout(() => process.stdout.write('task-completed'), 40)"], {
      cwd: resolve("."), env: installer.createRuntimeEnvironment(process.env), timeoutMs: null,
    });
    expect(result).toMatchObject({ code: 0, stdout: "task-completed", stderr: "" });
  });
  it("bounds a stalled owned child and waits for its actual close", async () => {
    const root = await temporary();
    const pidFile = join(root, "pid");
    await expect(installer.runProcess(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile], {
      cwd: root, env: installer.createRuntimeEnvironment(process.env), timeoutMs: 300,
    })).rejects.toThrow("INSTALL_CHILD_TIMEOUT");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("uninstall is a no-op for an unrelated home", async () => {
    const root = await temporary();
    const userFile = join(root, "keep.txt"); await writeFile(userFile, "owned by user");
    expect(await installer.uninstall({ home: root })).toEqual({ ok: true, status: "not_installed" });
    expect(await readFile(userFile, "utf8")).toBe("owned by user");
  });
  it("preserves corrupt/future home ownership metadata", async () => {
    const root = await temporary();
    const marker = join(root, ".deepseek-web-agent-owner.json");
    await writeFile(marker, JSON.stringify({ schema_version: 2, product: "another-product" }));
    await expect(installer.uninstall({ home: root })).rejects.toThrow("INSTALL_HOME_NOT_OWNED");
    expect(JSON.parse(await readFile(marker, "utf8")).schema_version).toBe(2);
  });
});

describe("production original-CLI browser startup wait", () => {
  it("waits for the actual broker readiness value instead of inventing a successful generation", async () => {
    const ctx = { deepseekWebBroker: { hasAuthenticatedPeer: false } };
    let finished = false;
    const running = browserReady.apply(ctx).then(() => { finished = true; });
    await new Promise((done) => setTimeout(done, 60));
    expect(finished).toBe(false);
    ctx.deepseekWebBroker.hasAuthenticatedPeer = true;
    await running;
    expect(finished).toBe(true);
  });
  it("returns waiting_for_browser after its bounded no-peer deadline", async () => {
    const previous = process.env.DSH_WEB_BROWSER_WAIT_MS;
    process.env.DSH_WEB_BROWSER_WAIT_MS = "100";
    try { await expect(browserReady.apply({ deepseekWebBroker: { hasAuthenticatedPeer: false } })).rejects.toThrow("WAITING_FOR_BROWSER"); }
    finally { if (previous === undefined) delete process.env.DSH_WEB_BROWSER_WAIT_MS; else process.env.DSH_WEB_BROWSER_WAIT_MS = previous; }
  });
});

/** A copied source fixture has a synthetic Git identity; npm, package loading and the original CLI remain real. */
async function immutableDistribution(root: string) {
  const source = join(root, "source-fixture"), output = join(root, "distribution");
  await mkdir(source);
  for (const path of ["package.json", "package-lock.json", "LICENSE", "vendor/harness-request-budget", ...installer.WORKSPACE_NAMES.map((name: string) => `packages/${name}`)]) {
    await cp(resolve(path), join(source, path), { recursive: true, filter: (path) => !path.split(/[\\/]/u).some((part) => ["node_modules", "dist", ".git"].includes(part)) });
  }
  const entries = (await readdir(source, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const { relative } = await import("node:path");
  const tracked = entries.map((entry) => relative(source, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  const { prepareDistribution } = await import(new URL("../scripts/prepare-dsh-web-agent-distribution.mjs", import.meta.url).href);
  const prepared = await prepareDistribution({ source, output }, { run: async (executable: string, args: string[], cwd: string) => {
    if (executable === "git") return { stdout: args[0] === "rev-parse" ? "1".repeat(40) : args[0] === "status" ? "" : tracked.join("\0") };
    const result = await installer.runProcess(executable, args, { cwd, env: installer.createRuntimeEnvironment(process.env), timeoutMs: 15000 });
    if (result.code !== 0) throw new Error("FIXTURE_LOCK_PREPARATION_FAILED");
    return result;
  } });
  return { output, sha256: prepared.manifest_sha256 };
}

it("installs an immutable runtime, runs the original CLI, upgrades without losing state, and uninstalls/reinstalls idempotently", async () => {
  const root = await temporary();
  const distribution = await immutableDistribution(root);
  const home = join(root, "product-home"), workspace = join(root, "workspace");
  await mkdir(workspace);
  const port = await reserveLoopbackPort();
  const installOptions = { distribution: distribution.output, home, manifestSha256: distribution.sha256, offline: true, origins: [FAKE_EXTENSION_ORIGIN], port };
  expect((await installer.install({ ...installOptions, dryRun: true })).status).toBe("dry_run");
  expect(existsSync(home)).toBe(false);
  expect((await installer.install(installOptions)).status).toBe("installed");
  expect((await installer.doctor({ home })).status).toBe("ready_for_browser");
  expect((await installer.install(installOptions)).status).toBe("already_installed");
  const secretPath = join(home, "secrets/pairing.json");
  const secretBytes = await readFile(secretPath, "utf8");
  const secret = JSON.parse(secretBytes);
  expect(Buffer.from(secret.token, "base64url").byteLength).toBe(32);
  // Input source and distribution are unavailable during the installed entry's actual task.
  await rename(join(root, "source-fixture"), join(root, "source-unavailable"));
  await rename(distribution.output, `${distribution.output}-unavailable`);
  const launcher = join(home, "dsh-web-agent.mjs");
  const env = createHeadlessEnvironment(process.env, {});
  const child = spawn(process.execPath, [launcher, "start", "--workspace", workspace, "--mode", "readonly", "--task", "Reply only with the deterministic installed fixture acknowledgement."], {
    cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = captureChild(child, 12000, "INSTALLED_FIXTURE_TIMEOUT");
  void capture.result.catch(() => undefined);
  let peer: FakeBrowserPeer | undefined;
  try {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && peer === undefined) {
      if (capture.isClosed()) throw new Error(`INSTALLED_CLI_EARLY_EXIT:${(await capture.result).stderr}`);
      try {
        peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port, path: WEB_MODEL_PATH, url: `ws://127.0.0.1:${port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: secret.token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 100 });
      } catch { await new Promise((done) => setTimeout(done, 25)); }
    }
    if (peer === undefined) throw new Error("INSTALLED_BROWSER_LISTENER_MISSING");
    peer.enqueueGeneration({ events: [{ type: "text_delta", text: "Installed original Harness task completed." }, { type: "completed", finish_reason: "stop" }] });
    const result = await capture.result;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("Installed original Harness task completed.\n");
    expect(result.stderr).not.toContain(secret.token);
    expect(peer.observedGenerateRequests).toHaveLength(1);
  } finally {
    await peer?.close();
    if (!capture.isClosed()) await terminateChildTree(child, workspace, env);
    await capture.closed;
  }
  const logs = await readOnlySessionLog(join(home, "state/sessions"));
  expect(logs.records.at(-1)).toMatchObject({ type: "turn/end", data: { reason: { kind: "completed" } } });
  const journalPath = join(home, "state/profiles/deepseek-web-agent/web-model-journal/journal.json");
  const journal = await readFile(journalPath, "utf8");
  await rename(`${distribution.output}-unavailable`, distribution.output);
  const manifestPath = join(distribution.output, "distribution.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimePackagePath = join(distribution.output, "package.json");
  const runtimePackageBytes = await readFile(runtimePackagePath, "utf8");
  const invalidPackage = JSON.parse(runtimePackageBytes);
  invalidPackage.dependencies["fixture-install-unavailable-dependency"] = "0.0.0";
  const invalidPackageBytes = `${JSON.stringify(invalidPackage, null, 2)}\n`;
  await writeFile(runtimePackagePath, invalidPackageBytes);
  const failedBuild = structuredClone(manifest);
  failedBuild.source_commit = "3".repeat(40);
  failedBuild.files.find((entry: { path: string }) => entry.path === "package.json").sha256 = hash(invalidPackageBytes);
  const failedBytes = `${JSON.stringify(failedBuild, null, 2)}\n`;
  await writeFile(manifestPath, failedBytes);
  const activeBeforeFailure = await readFile(join(home, "active.json"), "utf8");
  await expect(installer.install({ ...installOptions, manifestSha256: hash(failedBytes) })).rejects.toThrow("INSTALL_NPM_FAILED");
  expect(await readFile(join(home, "active.json"), "utf8")).toBe(activeBeforeFailure);
  expect(await readFile(journalPath, "utf8")).toBe(journal);
  expect((await installer.doctor({ home })).status).toBe("ready_for_browser");
  await writeFile(runtimePackagePath, runtimePackageBytes);
  manifest.source_commit = "2".repeat(40);
  const upgradeBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, upgradeBytes);
  expect((await installer.install({ ...installOptions, manifestSha256: hash(upgradeBytes) })).status).toBe("upgraded");
  expect(await readFile(journalPath, "utf8")).toBe(journal);
  expect(await readFile(secretPath, "utf8")).toBe(secretBytes);
  expect((await readOnlySessionLog(join(home, "state/sessions"))).raw).toBe(logs.raw);
  expect((await installer.doctor({ home })).source_commit).toBe("2".repeat(40));
  await writeFile(join(home, "state", "unrelated.txt"), "user state");
  expect((await installer.uninstall({ home })).status).toBe("uninstalled");
  expect((await installer.uninstall({ home })).status).toBe("already_uninstalled");
  expect(await readFile(join(home, "state", "unrelated.txt"), "utf8")).toBe("user state");
  expect((await installer.install({ ...installOptions, manifestSha256: hash(upgradeBytes) })).status).toBe("reinstalled");
  expect(await readFile(journalPath, "utf8")).toBe(journal);
  expect((await installer.doctor({ home })).status).toBe("ready_for_browser");
}, 50000);
