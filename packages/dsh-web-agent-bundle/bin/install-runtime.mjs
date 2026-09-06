import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoLayeredModelCredentials } from "./model-credentials.mjs";
import { validateProfileDump } from "./profile-validation.mjs";

export const PROFILE_NAME = "deepseek-web-agent";
export const HARNESS_VERSION = "0.1.2-rc.1";
export const WORKSPACE_NAMES = Object.freeze(["dsh-web-agent-bundle", "dsh-llm-deepseek-web", "dsh-web-model-transport", "web-model-protocol"]);
export const VENDOR_HASHES = Object.freeze({
  "deepseek-ai-dsh-llm-0.1.2-rc.1-494a4a63fb46.tgz": "494a4a63fb46ca6c8875ac25a03a6298285db315810e6bc6951f157c530da274",
  "deepseek-ai-dsh-compaction-basic-0.1.2-rc.1-44f8a92cd699.tgz": "44f8a92cd6992f4a24499d8df6e009a2dd5f173916fd7d7c699a84a8fc235ea3",
  "deepseek-ai-dsh-llm-retry-0.1.2-rc.1-aa44c61be81b.tgz": "aa44c61be81b55382521986134e0d517c6301e5743c447b23a7b5dc9273a2c87",
});
const BUNDLE = "@deepseek-pp/dsh-web-agent-bundle";
const OWNER = { schema_version: 1, product: "deepseek-pp-web-agent" };
const HASH = /^[a-f0-9]{64}$/u;
const SYSTEM_ENV = ["APPDATA", "ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "LOGNAME", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ", "USER", "USERNAME", "USERPROFILE", "WINDIR"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const readJson = async (file) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fail("INSTALL_METADATA_INVALID"); } };

export function findNpmCli() {
  const npm = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((path) => existsSync(path));
  if (npm === undefined) fail("INSTALL_NPM_CLI_REQUIRED");
  return resolve(npm);
}

export function assertNodeVersion(version = process.versions.node) {
  if (!/^24\.\d+\.\d+(?:[-+].*)?$/u.test(version)) fail("INSTALL_NODE_24_REQUIRED");
}

/** Only literal OS runtime names cross the process boundary, never arbitrary inherited model/bootstrap variables. */
export function createRuntimeEnvironment(input, owned = {}) {
  const output = {};
  for (const key of SYSTEM_ENV) {
    const found = Object.keys(input).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
    if (found !== undefined && typeof input[found] === "string") output[key] = input[found];
  }
  return Object.assign(output, owned, { DSH_TELEMETRY_DISABLED: "1" });
}

async function noLinks(path, allowMissing = false) {
  const absolute = resolve(path);
  let next = parse(absolute).root;
  for (const part of relative(next, absolute).split(sep).filter(Boolean)) {
    next = join(next, part);
    try { if ((await lstat(next)).isSymbolicLink()) fail("INSTALL_LINK_PATH_DENIED"); }
    catch (error) { if (allowMissing && error.code === "ENOENT") continue; throw error; }
  }
  return absolute;
}

function ownedPath(home, child) {
  const result = resolve(home, child);
  const rel = relative(home, result);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("INSTALL_PATH_OUTSIDE_HOME");
  return result;
}

async function checkedHome(home) {
  if (typeof home !== "string" || !isAbsolute(home)) fail("INSTALL_ABSOLUTE_HOME_REQUIRED");
  const absolute = resolve(home);
  if (absolute === parse(absolute).root || absolute === resolve(homedir())) fail("INSTALL_BROAD_HOME_DENIED");
  return noLinks(absolute, true);
}

async function inventory(root) {
  const files = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) fail("DISTRIBUTION_SYMLINK_DENIED");
      if (stat.isDirectory()) await walk(path, name);
      else if (stat.isFile()) files.push(name);
      else fail("DISTRIBUTION_FILE_TYPE_INVALID");
    }
  }
  await walk(root, "");
  return files.sort();
}

function validateRelativeFile(path) {
  if (typeof path !== "string" || path.length > 240 || !/^[A-Za-z0-9_./@+-]+$/u.test(path) ||
      path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) fail("DISTRIBUTION_PATH_INVALID");
  const allowed = path === "package.json" || path === "package-lock.json" || path === "LICENSE" ||
    WORKSPACE_NAMES.some((name) => path.startsWith(`packages/${name}/`)) ||
    Object.hasOwn(VENDOR_HASHES, path.replace(/^vendor\/harness-request-budget\//u, "")) && path.startsWith("vendor/harness-request-budget/");
  if (!allowed || path.split("/").some((part) => part === "node_modules" || part === ".git" || part === ".env")) fail("DISTRIBUTION_PATH_NOT_ALLOWED");
}

/** The caller pins the *raw* manifest hash. Every listed source byte is checked before npm or profile mutation. */
export async function readDistribution(directory, { expectedSha256, installed = false } = {}) {
  assertNodeVersion();
  if (typeof directory !== "string" || !isAbsolute(directory) || !HASH.test(expectedSha256 ?? "")) fail("DISTRIBUTION_IDENTITY_REQUIRED");
  const root = await noLinks(directory);
  const raw = await readFile(join(root, "distribution.json"));
  if (sha256(raw) !== expectedSha256) fail("DISTRIBUTION_HASH_MISMATCH");
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); } catch { fail("DISTRIBUTION_MANIFEST_INVALID"); }
  if (!exactKeys(manifest, ["schema_version", "kind", "node_major", "harness_version", "source_commit", "files"]) ||
      manifest.schema_version !== 1 || manifest.kind !== "local-development" || manifest.node_major !== 24 ||
      manifest.harness_version !== HARNESS_VERSION || !/^[a-f0-9]{40}$/u.test(manifest.source_commit) ||
      !Array.isArray(manifest.files) || manifest.files.length < 10 || manifest.files.length > 2000) fail("DISTRIBUTION_MANIFEST_INVALID");
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ["path", "sha256"]) || !HASH.test(entry.sha256)) fail("DISTRIBUTION_FILE_INVALID");
    validateRelativeFile(entry.path);
    const folded = entry.path.toLowerCase();
    if (paths.has(folded)) fail("DISTRIBUTION_DUPLICATE_FILE");
    paths.add(folded);
    const path = await noLinks(join(root, entry.path));
    if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== entry.sha256) fail("DISTRIBUTION_FILE_HASH_MISMATCH");
  }
  if (!installed) {
    const actual = await inventory(root);
    if (actual.join("\0") !== [...manifest.files.map((item) => item.path), "distribution.json"].sort().join("\0")) fail("DISTRIBUTION_FILE_SET_MISMATCH");
  }
  const requireFile = (name) => { if (!paths.has(name.toLowerCase())) fail("DISTRIBUTION_REQUIRED_FILE_MISSING"); };
  for (const name of ["package.json", "package-lock.json", "LICENSE", "packages/dsh-web-agent-bundle/scripts/seed-profile.mjs", "packages/dsh-web-agent-bundle/bin/browser-ready.patch.yml", "packages/dsh-web-agent-bundle/bin/dsh-web-agent.mjs"]) requireFile(name);
  const rootPackage = await readJson(join(root, "package.json"));
  const lock = await readJson(join(root, "package-lock.json"));
  if (rootPackage.private !== true || rootPackage.type !== "module" || rootPackage.dependencies?.["@deepseek-ai/dsh"] !== HARNESS_VERSION ||
      rootPackage.scripts !== undefined && Object.keys(rootPackage.scripts).length > 0 || lock.lockfileVersion !== 3 || !isRecord(lock.packages) ||
      lock.packages["node_modules/@deepseek-ai/dsh"]?.version !== HARNESS_VERSION) fail("DISTRIBUTION_HARNESS_VERSION_MISMATCH");
  for (const name of WORKSPACE_NAMES) {
    const path = `packages/${name}/package.json`;
    requireFile(path);
    const pkg = await readJson(join(root, path));
    if (pkg.name !== `@deepseek-pp/${name}` || pkg.version !== "0.0.0-private" || pkg.type !== "module") fail("DISTRIBUTION_WORKSPACE_VERSION_MISMATCH");
    if (lock.packages[`node_modules/@deepseek-pp/${name}`]?.resolved !== `packages/${name}` || lock.packages[`node_modules/@deepseek-pp/${name}`]?.link !== true) fail("DISTRIBUTION_WORKSPACE_LOCK_INVALID");
  }
  for (const [name, hash] of Object.entries(VENDOR_HASHES)) {
    const path = `vendor/harness-request-budget/${name}`;
    requireFile(path);
    if (manifest.files.find((entry) => entry.path === path)?.sha256 !== hash) fail("DISTRIBUTION_VENDOR_HASH_MISMATCH");
    const packageName = `@deepseek-ai/${name.replace(/^deepseek-ai-/u, "").replace(/-0\.1\.2-rc\.1-.+$/u, "")}`;
    if (rootPackage.dependencies?.[packageName] !== `file:${path}` || rootPackage.overrides?.[packageName] !== `$${packageName}` ||
        lock.packages[`node_modules/${packageName}`]?.resolved !== `file:${path}`) fail("DISTRIBUTION_VENDOR_LOCK_INVALID");
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || entry.link === true) continue;
    if (path.includes("/@deepseek-ai/dsh") && typeof entry.version === "string" && entry.version !== HARNESS_VERSION) fail("DISTRIBUTION_HARNESS_VERSION_MISMATCH");
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string" || !/^(?:sha512|sha256)-[A-Za-z0-9+/=]+$/u.test(entry.integrity) ||
        !entry.resolved.startsWith("https://registry.npmjs.org/") && !Object.keys(VENDOR_HASHES).some((name) => entry.resolved === `file:vendor/harness-request-budget/${name}`)) fail("DISTRIBUTION_DEPENDENCY_LOCK_INVALID");
  }
  return { directory: root, manifest, sha256: expectedSha256 };
}

/** Bounded children, no shell strings; npm diagnostics are intentionally not replayed into product logs. */
export async function runProcess(executable, args, { cwd, env, timeoutMs = 45000, inherit = false } = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timeout = false, overflow = false;
    function kill() {
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); } }
    }
    const timer = timeoutMs == null ? undefined : setTimeout(() => { timeout = true; kill(); }, timeoutMs);
    for (const [stream, key] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream?.on("data", (data) => {
      if (key === "stdout") stdout += data.toString(); else stderr += data.toString();
      if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; kill(); }
    });
    const abort = () => { kill(); };
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    function cleanup() { clearTimeout(timer); process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    child.once("error", () => { cleanup(); reject(Object.assign(new Error("INSTALL_CHILD_START_FAILED"), { code: "INSTALL_CHILD_START_FAILED" })); });
    child.once("close", (code) => {
      cleanup();
      if (timeout || overflow) reject(Object.assign(new Error(timeout ? "INSTALL_CHILD_TIMEOUT" : "INSTALL_CHILD_OUTPUT_LIMIT"), { code: timeout ? "INSTALL_CHILD_TIMEOUT" : "INSTALL_CHILD_OUTPUT_LIMIT" }));
      else resolveProcess({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function mustRun(executable, args, options, code) {
  const result = await runProcess(executable, args, options);
  if (result.code !== 0) fail(code);
  return result;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { await chmod(path, 0o700); return; }
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env = createRuntimeEnvironment(process.env);
  const identity = await mustRun(join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { env, timeoutMs: 5000 }, "INSTALL_SECRET_ACL_FAILED");
  const sid = identity.stdout.match(/S-1-5-(?:\d+-)*\d+/u)?.[0];
  if (!sid) fail("INSTALL_SECRET_ACL_FAILED");
  await mustRun(join(system, "icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { env, timeoutMs: 5000 }, "INSTALL_SECRET_ACL_FAILED");
}

function validatePairing(value) {
  if (!exactKeys(value, ["schema_version", "token", "origins", "port"]) || value.schema_version !== 1 ||
      typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.token) || Buffer.from(value.token, "base64url").toString("base64url") !== value.token ||
      !Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 8 || new Set(value.origins).size !== value.origins.length ||
      value.origins.some((origin) => !/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-zA-Z0-9_-]+)$/u.test(origin)) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) fail("INSTALL_PAIRING_INVALID");
  return value;
}

async function claimHome(home) {
  await mkdir(home, { recursive: true });
  const marker = ownedPath(home, ".deepseek-web-agent-owner.json");
  if (existsSync(marker)) { if (json(await readJson(marker)) !== json(OWNER)) fail("INSTALL_HOME_NOT_OWNED"); }
  else {
    for (const path of ["state", ".versions", "secrets", "active.json", "inactive.json", "dsh-web-agent.mjs"]) if (existsSync(ownedPath(home, path))) fail("INSTALL_HOME_COLLISION");
    await writeFile(marker, json(OWNER), { flag: "wx", mode: 0o600 });
  }
}

async function ownedHome(home) {
  const root = await checkedHome(home);
  if (json(await readJson(join(root, ".deepseek-web-agent-owner.json"))) !== json(OWNER)) fail("INSTALL_HOME_NOT_OWNED");
  for (const part of [".versions", "state", "secrets", "secrets/pairing.json", "dsh-web-agent.mjs", "active.json", "inactive.json", "state/profiles", `state/profiles/${PROFILE_NAME}`]) await noLinks(ownedPath(root, part), true);
  return root;
}

async function withLock(home, action) {
  const path = ownedPath(home, ".installation.lock");
  let handle;
  try { handle = await open(path, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") fail("INSTALL_BUSY_OR_INTERRUPTED"); throw error; }
  try { await handle.writeFile(json({ ...OWNER, pid: process.pid })); await handle.sync(); return await action(); }
  finally { await handle.close(); await unlink(path); }
}

async function loadActive(home, filename = "active.json") {
  const value = await readJson(ownedPath(home, filename));
  if (!exactKeys(value, ["schema_version", "distribution_sha256", "version_directory"]) || value.schema_version !== 1 || !HASH.test(value.distribution_sha256) ||
      !/^[a-f0-9]{64}-[a-f0-9]{16}$/u.test(value.version_directory) || !value.version_directory.startsWith(`${value.distribution_sha256}-`)) fail("INSTALL_ACTIVE_INVALID");
  const version = ownedPath(home, `.versions/${value.version_directory}`);
  await noLinks(version);
  if (json(await readJson(join(version, "owner.json"))) !== json(OWNER)) fail("INSTALL_VERSION_NOT_OWNED");
  return { value, version, runtime: join(version, "runtime") };
}

async function verifyRuntime(active) {
  const distribution = await readDistribution(active.runtime, { expectedSha256: active.value.distribution_sha256, installed: true });
  const lock = await readJson(join(active.runtime, "package-lock.json"));
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || item.link === true) continue;
    const manifestPath = join(active.runtime, path, "package.json");
    if (!existsSync(manifestPath) && item.optional === true) continue;
    const manifest = await readJson(manifestPath);
    if (manifest.version !== item.version) fail("INSTALL_PACKAGE_VERSION_MISMATCH");
  }
  for (const name of WORKSPACE_NAMES) {
    if (await realpath(join(active.runtime, "node_modules/@deepseek-pp", name)) !== await realpath(join(active.runtime, "packages", name))) fail("INSTALL_WORKSPACE_LINK_INVALID");
  }
  return distribution;
}

async function verifyProfile(home, runtime, archived = false) {
  const profile = ownedPath(home, `state/profiles/${PROFILE_NAME}${archived ? ".uninstalled" : ""}`);
  await noLinks(profile);
  if (json(await readJson(join(profile, ".product-owner.json"))) !== json(OWNER)) fail("INSTALL_PROFILE_NOT_OWNED");
  const manifest = await readJson(join(profile, "package.json"));
  if (manifest.private !== true || json(manifest.dependencies) !== json({ [BUNDLE]: "0.0.0-private" }) ||
      json(manifest.dsh) !== json({ profile: { bundles: [BUNDLE], patchReload: "startup" } }) ||
      await readFile(join(profile, "cordis.patch.yml"), "utf8") !== "[]\n") fail("INSTALL_PROFILE_MODIFIED");
  if (!archived && (!(await lstat(join(profile, "node_modules"))).isSymbolicLink() || await realpath(join(profile, "node_modules")) !== await realpath(join(runtime, "node_modules")))) fail("INSTALL_PROFILE_LINK_INVALID");
  return profile;
}

export async function install({ distribution, home, manifestSha256, offline = false, dryRun = false, origins, port = 43123 }) {
  const source = await readDistribution(distribution, { expectedSha256: manifestSha256 });
  const root = await checkedHome(home);
  const pairing = validatePairing({ schema_version: 1, token: randomBytes(32).toString("base64url"), origins, port });
  if (dryRun) return { ok: true, status: "dry_run", kind: source.manifest.kind, distribution_sha256: source.sha256, source_commit: source.manifest.source_commit };
  await claimHome(root);
  return withLock(root, async () => {
    await ownedHome(root);
    let previous;
    if (existsSync(join(root, "active.json"))) {
      previous = await loadActive(root);
      await verifyRuntime(previous); await verifyProfile(root, previous.runtime);
      if (previous.value.distribution_sha256 === source.sha256) return { ok: true, status: "already_installed", distribution_sha256: source.sha256 };
      if (existsSync(join(root, "state/profiles", PROFILE_NAME, "web-model-journal/owner.lock"))) fail("INSTALL_SESSION_LOCK_PRESENT");
    }
    if (existsSync(join(root, "inactive.json"))) {
      const active = await loadActive(root, "inactive.json");
      if (active.value.distribution_sha256 !== source.sha256) fail("INSTALL_DIFFERENT_BUILD_REQUIRES_SEPARATE_HOME");
      await verifyRuntime(active);
      const archived = await verifyProfile(root, active.runtime, true);
      await symlink(join(active.runtime, "node_modules"), join(archived, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await rename(archived, ownedPath(root, `state/profiles/${PROFILE_NAME}`));
      await rename(join(root, "inactive.json"), join(root, "active.json"));
      return { ok: true, status: "reinstalled", distribution_sha256: source.sha256 };
    }
    const versionName = `${source.sha256}-${randomBytes(8).toString("hex")}`;
    const version = ownedPath(root, `.versions/${versionName}`);
    const runtime = join(version, "runtime");
    const stageHome = join(version, "profile-staging");
    const finalProfile = ownedPath(root, `state/profiles/${PROFILE_NAME}`);
    if (existsSync(finalProfile) && previous === undefined) fail("INSTALL_PROFILE_COLLISION");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(version, "owner.json"), json(OWNER), { flag: "wx" });
    let profileCommitted = false;
    let secretCreated = false;
    let activationCommitted = false;
    let priorLink;
    try {
      for (const entry of source.manifest.files) {
        const target = join(runtime, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(source.directory, entry.path), target);
      }
      await copyFile(join(source.directory, "distribution.json"), join(runtime, "distribution.json"));
      await readDistribution(runtime, { expectedSha256: source.sha256 });
      const npm = findNpmCli();
      await writeFile(join(version, "empty.npmrc"), "", { flag: "wx" });
      const env = createRuntimeEnvironment(process.env, {
        DSH_HOME: stageHome, NPM_CONFIG_USERCONFIG: join(version, "empty.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(version, "empty-global.npmrc"),
        NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false",
      });
      await writeFile(join(version, "empty-global.npmrc"), "", { flag: "wx" });
      await mustRun(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", ...(offline ? ["--offline"] : [])], { cwd: runtime, env }, "INSTALL_NPM_FAILED");
      const active = { value: { schema_version: 1, distribution_sha256: source.sha256, version_directory: versionName }, version, runtime };
      await verifyRuntime(active);
      const bundle = join(runtime, "packages/dsh-web-agent-bundle");
      // Public profile initialization APIs; the official CLI consumes this same manifest and one package link.
      const { seedProfile } = await import(pathToFileURL(join(bundle, "scripts/seed-profile.mjs")).href);
      const profile = seedProfile(stageHome);
      const { readProfileManifest, writeProfileManifest } = await import(pathToFileURL(createRequire(join(runtime, "package.json")).resolve("@deepseek-ai/dsh-app-boot")).href);
      const manifest = readProfileManifest(PROFILE_NAME, profile);
      manifest.dependencies = { [BUNDLE]: "0.0.0-private" };
      manifest.dsh.profile.bundles = [BUNDLE];
      writeProfileManifest(profile, manifest);
      await symlink(join(runtime, "node_modules"), join(profile, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(profile, ".product-owner.json"), json(OWNER), { flag: "wx" });
      const dsh = join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
      const versionOutput = await mustRun(process.execPath, [dsh, "--version"], { cwd: runtime, env }, "INSTALL_DSH_LOAD_FAILED");
      if (versionOutput.stdout.trim() !== HARNESS_VERSION) fail("INSTALL_PACKAGE_VERSION_MISMATCH");
      const dumped = await mustRun(process.execPath, [dsh, "--profile", PROFILE_NAME, "--dump-config"], { cwd: runtime, env }, "INSTALL_PROFILE_LOAD_FAILED");
      validateProfileDump(dumped.stdout);
      if (previous === undefined) {
        await privateDirectory(ownedPath(root, "secrets"));
        await writeFile(ownedPath(root, "secrets/pairing.json"), json(pairing), { flag: "wx", mode: 0o600 }); secretCreated = true;
        await mkdir(dirname(finalProfile), { recursive: true });
        await rename(profile, finalProfile); profileCommitted = true;
      } else {
        // Sessions, journal, pairing and all profile data stay in place. Only this one owned module link changes.
        priorLink = join(finalProfile, `.node_modules.previous-${randomBytes(8).toString("hex")}`);
        await rename(join(finalProfile, "node_modules"), priorLink);
        await rename(join(profile, "node_modules"), join(finalProfile, "node_modules")); profileCommitted = true;
      }
      await mkdir(ownedPath(root, "state/sessions"), { recursive: true });
      const launcher = ownedPath(root, "dsh-web-agent.mjs");
      if (previous === undefined) await copyFile(join(bundle, "bin/dsh-web-agent.mjs"), launcher);
      await atomicJson(ownedPath(root, "active.json"), active.value);
      activationCommitted = true;
      if (priorLink !== undefined) await unlink(priorLink);
      return { ok: true, status: previous === undefined ? "installed" : "upgraded", distribution_sha256: source.sha256, source_commit: source.manifest.source_commit, profile: PROFILE_NAME };
    } catch (error) {
      // Roll back only paths created by this invocation, never an existing profile/session/home.
      if (activationCommitted) throw error; // The new build is committed; do not mis-rollback a completed activation.
      if (previous === undefined && profileCommitted) await rename(finalProfile, join(stageHome, "profiles", PROFILE_NAME));
      if (previous !== undefined && priorLink !== undefined) {
        if (profileCommitted) await unlink(join(finalProfile, "node_modules"));
        await rename(priorLink, join(finalProfile, "node_modules"));
      }
      if (secretCreated) await unlink(join(root, "secrets/pairing.json"));
      // Failed staging is retained for diagnosis. It has no active pointer and cannot run.
      throw error;
    }
  });
}

export async function doctor({ home }) {
  assertNodeVersion();
  const root = await ownedHome(home);
  if (existsSync(join(root, ".installation.lock"))) fail("INSTALL_BUSY_OR_INTERRUPTED");
  const active = await loadActive(root);
  const distribution = await verifyRuntime(active);
  await verifyProfile(root, active.runtime);
  validatePairing(await readJson(join(root, "secrets/pairing.json")));
  return { ok: true, status: "ready_for_browser", distribution_sha256: active.value.distribution_sha256, source_commit: distribution.manifest.source_commit, harness_version: HARNESS_VERSION, provider: "deepseek-web", model: "current-web-session" };
}

export async function prepareStart({ home, workspace, task, mode = "files", browserWaitMs = 60000 }) {
  await doctor({ home });
  const root = await ownedHome(home);
  if (typeof workspace !== "string" || !isAbsolute(workspace) || !(await lstat(workspace)).isDirectory()) fail("START_ABSOLUTE_WORKSPACE_REQUIRED");
  workspace = await realpath(workspace);
  if (typeof task !== "string" || !task.trim() || task.length > 262144) fail("START_TASK_REQUIRED");
  if (!["readonly", "files", "linux-commands"].includes(mode) || mode === "linux-commands" && process.platform !== "linux") fail("START_MODE_UNSUPPORTED");
  if (!Number.isInteger(browserWaitMs) || browserWaitMs < 100 || browserWaitMs > 60000) fail("START_BROWSER_WAIT_INVALID");
  const active = await loadActive(root);
  const pairing = validatePairing(await readJson(join(root, "secrets/pairing.json")));
  const stateHome = ownedPath(root, "state");
  await assertNoLayeredModelCredentials(workspace, stateHome, async (path) => { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } });
  const bundle = join(active.runtime, "packages/dsh-web-agent-bundle");
  const patches = mode === "readonly" ? ["cordis.readonly.patch.yml"] : ["cordis.workspace-files.patch.yml", "cordis.harness-features.patch.yml", ...(mode === "linux-commands" ? ["cordis.linux-commands.patch.yml"] : [])];
  const env = createRuntimeEnvironment(process.env, { DSH_HOME: stateHome, DSH_WEB_WORKSPACE_ROOT: workspace,
    DSH_WEB_PAIRING_TOKEN: pairing.token, DSH_WEB_ALLOWED_EXTENSION_ORIGINS: pairing.origins.join(","), DSH_WEB_BROKER_PORT: String(pairing.port), DSH_WEB_BROWSER_WAIT_MS: String(browserWaitMs) });
  return { executable: process.execPath, args: [join(active.runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", PROFILE_NAME, ...patches.flatMap((patch) => ["--patch", join(bundle, patch)]), "--patch", join(bundle, "bin/browser-ready.patch.yml"), task], cwd: workspace, env, shell: false, windowsHide: true };
}

export async function start(options) {
  const command = await prepareStart(options);
  process.stderr.write("正在等待已配对的 DeepSeek++ 浏览器；请保持登录，并在本机 Harness 中保存连接设置。\n");
  // No loop here: the unchanged official headless CLI owns the full task and its lifetime.
  return runProcess(command.executable, command.args, { cwd: command.cwd, env: command.env, inherit: true, timeoutMs: null });
}

export async function pair({ home, origins, port, copyToken = false }) {
  const root = await ownedHome(home);
  await doctor({ home: root });
  const path = ownedPath(root, "secrets/pairing.json");
  const previous = validatePairing(await readJson(path));
  const value = validatePairing({ ...previous, origins: origins ?? previous.origins, port: port ?? previous.port });
  await atomicJson(path, value);
  if (copyToken) {
    if (process.platform !== "win32") fail("PAIRING_CLIPBOARD_WINDOWS_ONLY");
    // Secret supplied over stdin, never in process arguments or output.
    await new Promise((done, reject) => {
      const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32/clip.exe"), [], { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("PAIRING_CLIPBOARD_TIMEOUT")); }, 5000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("PAIRING_CLIPBOARD_FAILED")); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? done() : reject(new Error("PAIRING_CLIPBOARD_FAILED")); });
      child.stdin.end(value.token);
    });
  }
  return { ok: true, status: copyToken ? "pairing_token_copied" : "pairing_saved", port: value.port, origins: value.origins };
}

export async function uninstall({ home }) {
  const root = await checkedHome(home);
  if (!existsSync(join(root, ".deepseek-web-agent-owner.json"))) return { ok: true, status: "not_installed" };
  await ownedHome(root);
  return withLock(root, async () => {
    if (!existsSync(join(root, "active.json"))) return { ok: true, status: "already_uninstalled", retained: "sessions, recovery, pairing and version archives" };
    const active = await loadActive(root);
    const profile = await verifyProfile(root, active.runtime);
    const journalLock = join(profile, "web-model-journal", "owner.lock");
    if (existsSync(journalLock)) fail("UNINSTALL_SESSION_LOCK_PRESENT");
    const archived = `${profile}.uninstalled`;
    if (existsSync(archived)) fail("UNINSTALL_ARCHIVE_COLLISION");
    await unlink(join(profile, "node_modules"));
    try { await rename(profile, archived); await rename(join(root, "active.json"), join(root, "inactive.json")); }
    catch (error) {
      if (existsSync(archived)) await rename(archived, profile);
      await symlink(join(active.runtime, "node_modules"), join(profile, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      throw error;
    }
    return { ok: true, status: "uninstalled", retained: "sessions, recovery, pairing and version archives" };
  });
}

export async function cli(args = process.argv.slice(2), defaultAction = "install") {
  const action = args[0] && !args[0].startsWith("--") ? args.shift() : defaultAction;
  const options = {};
  const values = { "--home": "home", "--distribution": "distribution", "--sha256": "manifestSha256", "--origin": "origins", "--port": "port", "--workspace": "workspace", "--task": "task", "--mode": "mode" };
  while (args.length) {
    const key = args.shift();
    if (["--dry-run", "--offline", "--copy-token"].includes(key)) { options[{ "--dry-run": "dryRun", "--offline": "offline", "--copy-token": "copyToken" }[key]] = true; continue; }
    if (!Object.hasOwn(values, key) || !args.length) fail("INSTALL_ARGUMENTS_INVALID");
    const name = values[key], value = args.shift();
    if (name === "origins") (options.origins ??= []).push(value);
    else if (Object.hasOwn(options, name)) fail("INSTALL_ARGUMENTS_INVALID");
    else options[name] = name === "port" ? Number(value) : value;
  }
  const handlers = { install, doctor, start, pair, uninstall };
  if (!Object.hasOwn(handlers, action)) fail("INSTALL_ARGUMENTS_INVALID");
  const result = await handlers[action](options);
  if (action === "start") process.exitCode = result.code;
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export function reportFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/u.test(error.code) ? error.code : "DSH_WEB_INSTALLER_FAILED";
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = 1;
}
