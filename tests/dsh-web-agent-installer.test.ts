// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
  it("boots the shipped installer without checkout or installed package dependencies", async () => {
    const root = await temporary();
    const bare = join(root, "bare-bin");
    await mkdir(bare);
    for (const name of ["dsh-web-agent.mjs", "install-runtime.mjs", "model-credentials.mjs", "profile-validation.mjs", "web-options.mjs", "terminal-options.mjs"]) {
      await copyFile(resolve("packages/dsh-web-agent-bundle/bin", name), join(bare, name));
    }
    const fixture = await manifestFixture();
    const home = join(root, "not-created");
    const result = await installer.runProcess(process.execPath, [join(bare, "dsh-web-agent.mjs"), "install", "--distribution", fixture.directory,
      "--sha256", "f".repeat(64), "--home", home], { cwd: root, env: installer.createRuntimeEnvironment(process.env), timeoutMs: 3000 });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: "DISTRIBUTION_HASH_MISMATCH" });
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });
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
