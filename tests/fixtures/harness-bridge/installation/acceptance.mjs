import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as installer from "../../../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";
import { WEB_MODEL_PATH, WEB_MODEL_SUBPROTOCOL } from "@deepseek-pp/dsh-web-model-transport";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "../fake-peer/index.ts";
import { createReadLoopScripts, NONCE_FILE } from "../../dsh-web-agent/tool-loop/request-script.ts";
import { captureChild, createHeadlessEnvironment, reserveLoopbackPort, terminateChildTree, readOnlySessionLog, canBindLoopback } from "../../dsh-web-agent/run-fake-headless.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const recordFile = (home) => `${home}.acceptance.json`;
const readRecord = async (home) => JSON.parse(await readFile(recordFile(home), "utf8"));
const writeRecord = (home, record) => writeFile(recordFile(home), `${JSON.stringify(record, null, 2)}\n`);
const journalPath = (home) => join(home, "state/profiles/deepseek-web-agent/web-model-journal/journal.json");

async function fingerprint(home) {
  const sessions = await readOnlySessionLog(join(home, "state/sessions"));
  return {
    sessions_sha256: hash(sessions.raw), journal_sha256: hash(await readFile(journalPath(home))),
    pairing_sha256: hash(await readFile(join(home, "secrets/pairing.json"))),
  };
}

async function installedCommand(home, args, timeoutMs = 15000) {
  const result = await installer.runProcess(process.execPath, [join(home, "dsh-web-agent.mjs"), ...args], {
    cwd: home, env: installer.createRuntimeEnvironment(process.env), timeoutMs,
  });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function install(home, distribution, sha256) {
  assert.equal(existsSync(home), false, "Use a fresh explicitly owned acceptance home");
  const input = `${home}.input`;
  assert.equal(existsSync(input), false);
  await cp(distribution, input, { recursive: true });
  const options = { home, distribution: input, manifestSha256: sha256, origins: [FAKE_EXTENSION_ORIGIN], port: await reserveLoopbackPort(), offline: true };
  await assert.rejects(installer.install({ ...options, manifestSha256: "0".repeat(64) }), /DISTRIBUTION_HASH_MISMATCH/u);
  assert.equal(existsSync(home), false);
  assert.equal((await installer.install({ ...options, dryRun: true })).status, "dry_run");
  assert.equal(existsSync(home), false);
  assert.equal((await installer.install(options)).status, "installed");
  assert.equal((await installer.install(options)).status, "already_installed");
  // The installed launcher cannot resolve the distribution path used to install it anymore.
  await rename(input, `${input}.unavailable`);
  const doctor = await installedCommand(home, ["doctor"]);
  assert.equal(doctor.status, "ready_for_browser");
  await writeRecord(home, { schema_version: 1, distribution_sha256: sha256, stage: "installed" });
  return { ok: true, phase: "install", independent_launcher: true, source_unavailable: true, doctor: doctor.status };
}

async function run(home) {
  const record = await readRecord(home);
  const workspace = await mkdtemp(`${home}.workspace-`);
  const nonce = `fixture-nonce=${randomBytes(16).toString("hex")}`;
  await writeFile(join(workspace, NONCE_FILE), `${nonce}\n`, { flag: "wx" });
  const secret = JSON.parse(await readFile(join(home, "secrets/pairing.json"), "utf8"));
  const env = createHeadlessEnvironment(process.env, {});
  const child = spawn(process.execPath, [join(home, "dsh-web-agent.mjs"), "start", "--workspace", workspace, "--mode", "readonly", "--task", `Read ${NONCE_FILE} with the read tool and report the fixture nonce from its contents.`], {
    cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = captureChild(child, 15000, "INSTALLED_FIXTURE_TIMEOUT");
  void capture.result.catch(() => undefined);
  let peer;
  try {
    const deadline = Date.now() + 10000;
    while (peer === undefined && Date.now() < deadline) {
      if (capture.isClosed()) throw new Error(`INSTALLED_CLI_EARLY_EXIT:${(await capture.result).stderr}`);
      try {
        peer = await FakeBrowserPeer.connect({ address: { host: "127.0.0.1", port: secret.port, path: WEB_MODEL_PATH, url: `ws://127.0.0.1:${secret.port}${WEB_MODEL_PATH}`, subprotocol: WEB_MODEL_SUBPROTOCOL }, pairingToken: secret.token, origin: FAKE_EXTENSION_ORIGIN, timeoutMs: 200 });
      } catch (error) {
        if (!["FAKE_PEER_CONNECT_FAILED", "FAKE_PEER_CONNECT_TIMEOUT"].includes(error.message)) throw error;
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    assert.ok(peer, "Installed original CLI listener did not become available");
    // Product operations share the exact active task lease, including the waiting-browser interval.
    await assert.rejects(installer.uninstall({ home }), /INSTALL_BUSY_OR_INTERRUPTED/u);
    for (const script of createReadLoopScripts("read")) peer.enqueueGeneration(script);
    const result = await capture.result;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `Read complete: ${nonce}\n`);
    assert.equal(result.stderr.includes(secret.token), false);
    assert.equal(peer.observedGenerateRequests.length, 2);
    assert.equal(JSON.stringify(peer.observedGenerateRequests[0]).includes(nonce), false);
    peer.throwIfFailed();
  } finally {
    await peer?.close();
    if (!capture.isClosed()) await terminateChildTree(child, workspace, env);
    await capture.closed;
  }
  assert.equal(await canBindLoopback(secret.port), true);
  const session = await readOnlySessionLog(join(home, "state/sessions"));
  assert.equal(session.records.filter((entry) => entry.type === "tool/call").length, 1);
  assert.equal(session.records.filter((entry) => entry.type === "tool/result").length, 1);
  assert.equal(session.records.at(-1).data.reason.kind, "completed");
  const fingerprints = await fingerprint(home);
  await writeRecord(home, { ...record, ...fingerprints, stage: "tool-loop-completed" });
  return { ok: true, phase: "original-cli-read", model_steps: 2, tool_calls: 1, tool_results: 1, durable: true, child_closed: true, port_released: true, real_web: false };
}

async function upgrade(home, distribution, sha256) {
  const record = await readRecord(home);
  // Windows needs to exercise replacing an actual junction. This is explicitly
  // a synthetic next-build fixture, never a claim of a new source release.
  await installer.readDistribution(distribution, { expectedSha256: sha256 });
  const input = `${home}.synthetic-upgrade`;
  assert.equal(existsSync(input), false);
  await cp(distribution, input, { recursive: true });
  const readme = "packages/dsh-web-agent-bundle/README.md";
  const changed = `${await readFile(join(input, readme), "utf8")}\nSynthetic installation-mechanism fixture only.\n`;
  await writeFile(join(input, readme), changed);
  const manifest = JSON.parse(await readFile(join(input, "distribution.json"), "utf8"));
  manifest.source_commit = "f".repeat(40);
  manifest.files.find((file) => file.path === readme).sha256 = hash(changed);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(input, "distribution.json"), bytes);
  sha256 = hash(bytes); distribution = input;
  const before = await fingerprint(home);
  assert.deepEqual(before, { sessions_sha256: record.sessions_sha256, journal_sha256: record.journal_sha256, pairing_sha256: record.pairing_sha256 });
  const result = await installedCommand(home, ["install", "--distribution", distribution, "--sha256", sha256, "--origin", FAKE_EXTENSION_ORIGIN, "--offline"], 50000);
  assert.equal(result.status, "upgraded");
  assert.deepEqual(await fingerprint(home), before);
  assert.equal((await installedCommand(home, ["doctor"])).distribution_sha256, sha256);
  await writeRecord(home, { ...record, distribution_sha256: sha256, synthetic_distribution: { directory: input, sha256 }, stage: "upgraded" });
  return { ok: true, phase: "upgrade", synthetic_next_build: true, sessions_preserved: true, journal_preserved: true, pairing_preserved: true };
}

async function uninstall(home, distribution, sha256) {
  const record = await readRecord(home), before = await fingerprint(home);
  if (record.synthetic_distribution) ({ directory: distribution, sha256 } = record.synthetic_distribution);
  const unrelated = join(home, "state/another-profile-data.txt");
  await writeFile(unrelated, "Retain unrelated user data.\n", { flag: "wx" });
  assert.equal((await installedCommand(home, ["uninstall"])).status, "uninstalled");
  assert.equal((await installedCommand(home, ["uninstall"])).status, "already_uninstalled");
  assert.equal(await readFile(unrelated, "utf8"), "Retain unrelated user data.\n");
  assert.equal((await installedCommand(home, ["install", "--distribution", distribution, "--sha256", sha256, "--origin", FAKE_EXTENSION_ORIGIN, "--offline"])).status, "reinstalled");
  assert.deepEqual(await fingerprint(home), before);
  assert.equal((await installedCommand(home, ["doctor"])).status, "ready_for_browser");
  await writeRecord(home, { ...record, stage: "uninstall-reinstall-completed" });
  return { ok: true, phase: "uninstall-reinstall", idempotent: true, unrelated_data_preserved: true, durable_state_preserved: true };
}

async function failure(home, distribution, sha256) {
  await installer.readDistribution(distribution, { expectedSha256: sha256 });
  const input = `${home}.failed-upgrade`;
  assert.equal(existsSync(input), false);
  await cp(distribution, input, { recursive: true });
  const packagePath = join(input, "package.json"), manifestPath = join(input, "distribution.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.dependencies["dsh-web-agent-unavailable-fixture"] = "0.0.0";
  const packageBytes = `${JSON.stringify(pkg, null, 2)}\n`;
  await writeFile(packagePath, packageBytes);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.source_commit = "e".repeat(40);
  manifest.files.find((entry) => entry.path === "package.json").sha256 = hash(packageBytes);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestBytes);
  const before = await fingerprint(home), active = await readFile(join(home, "active.json"), "utf8");
  const result = await installer.runProcess(process.execPath, [join(home, "dsh-web-agent.mjs"), "install", "--distribution", input, "--sha256", hash(manifestBytes), "--origin", FAKE_EXTENSION_ORIGIN, "--offline"], {
    cwd: home, env: installer.createRuntimeEnvironment(process.env), timeoutMs: 50000,
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, "INSTALL_NPM_FAILED");
  assert.equal(await readFile(join(home, "active.json"), "utf8"), active);
  assert.deepEqual(await fingerprint(home), before);
  assert.equal((await installedCommand(home, ["doctor"])).status, "ready_for_browser");
  return { ok: true, phase: "failed-upgrade", npm_failure_observed: true, original_activation_preserved: true, durable_state_preserved: true };
}

async function restore(home, distribution, sha256) {
  const before = await fingerprint(home);
  assert.equal((await installedCommand(home, ["install", "--distribution", distribution, "--sha256", sha256, "--origin", FAKE_EXTENSION_ORIGIN, "--offline"], 50000)).status, "upgraded");
  assert.equal((await installedCommand(home, ["doctor"])).distribution_sha256, sha256);
  assert.deepEqual(await fingerprint(home), before);
  const record = await readRecord(home);
  delete record.synthetic_distribution;
  await writeRecord(home, { ...record, distribution_sha256: sha256, stage: "original-distribution-restored" });
  return { ok: true, phase: "restore", distribution_sha256: sha256, durable_state_preserved: true };
}

const [phase, home, distribution, sha256] = process.argv.slice(2);
try {
  assert.ok(isAbsolute(home));
  if (phase !== "run") assert.ok(isAbsolute(distribution) && /^[a-f0-9]{64}$/u.test(sha256));
  const phases = { install, run, upgrade, uninstall, failure, restore };
  assert.ok(Object.hasOwn(phases, phase));
  process.stdout.write(`${JSON.stringify(await phases[phase](home, distribution, sha256))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, phase, error: error.code ?? error.message })}\n`);
  process.exitCode = 1;
}
