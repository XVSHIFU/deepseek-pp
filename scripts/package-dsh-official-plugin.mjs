#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HARNESS_VERSION,
  VENDOR_HASHES,
  createRuntimeEnvironment,
  findNpmCli,
  runProcess,
} from "../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";
import { readExtension } from "./package-harness-integration.mjs";

const BROWSERS = Object.freeze(["chrome", "edge", "firefox"]);
const VENDOR_PACKAGES = Object.freeze([
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-llm-retry",
]);
const VENDOR_ARCHIVE_BY_PACKAGE = Object.freeze({
  "@deepseek-ai/dsh-llm": "deepseek-ai-dsh-llm-0.1.2-rc.1-494a4a63fb46.tgz",
  "@deepseek-ai/dsh-compaction-basic": "deepseek-ai-dsh-compaction-basic-0.1.2-rc.1-44f8a92cd699.tgz",
  "@deepseek-ai/dsh-llm-retry": "deepseek-ai-dsh-llm-retry-0.1.2-rc.1-aa44c61be81b.tgz",
});
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PLUGIN_NAME = "@deepseek-pp/dsh-deepseek-web-official-plugin";
const EXPECTED_PLUGIN_PATCH = `# Incremental layer for the official \`web\` profile. The base and web bundles
# continue to own the Harness loop, sessions, tools, approval, settings and UI.
- insert:
    - id: deepseek-web-session-persistence
      name: '@deepseek-pp/dsh-deepseek-web-official-plugin/session-persistence'
      config:
        root: !!js dshHomePath('sessions')
        importRoot: !!js dshHomePath('profiles', 'web', 'deepseek-web-official', 'session-import')
    - id: deepseek-web-official
      name: '@deepseek-pp/dsh-deepseek-web-official-plugin'
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  disabled: true
`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sri512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

async function command(executable, args, cwd, timeoutMs = 45_000) {
  const result = await runProcess(executable, args, {
    cwd,
    env: createRuntimeEnvironment(process.env),
    timeoutMs,
  });
  if (result.code !== 0) fail("OFFICIAL_PACKAGE_COMMAND_FAILED");
  return result;
}

async function plainPath(input, missing = false) {
  if (typeof input !== "string" || !isAbsolute(input)) fail("OFFICIAL_PACKAGE_ABSOLUTE_PATH_REQUIRED");
  const target = resolve(input);
  let cursor = parse(target).root;
  for (const part of relative(cursor, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) fail("OFFICIAL_PACKAGE_LINK_DENIED");
    } catch (error) {
      if (missing && error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return target;
}

function outside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function inventory(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) fail("OFFICIAL_PACKAGE_LINK_DENIED");
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), path));
    else if (entry.isFile()) files.push(path);
    else fail("OFFICIAL_PACKAGE_FILE_TYPE_INVALID");
  }
  return files.sort();
}

async function sourceIdentity(source, run = command) {
  const commit = (await run("git", ["rev-parse", "HEAD"], source)).stdout.trim();
  if (!COMMIT.test(commit)) fail("OFFICIAL_PACKAGE_SOURCE_INVALID");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"], source)).stdout.trim() !== "") {
    fail("OFFICIAL_PACKAGE_SOURCE_DIRTY");
  }
  const files = {};
  for (const file of ["package.json", "package-lock.json", "wxt.config.ts"]) {
    files[file] = sha256(await readFile(join(source, file)));
  }
  return { commit, files };
}

function sameIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("OFFICIAL_PACKAGE_SOURCE_CHANGED");
}

function vendorRecords(rootManifest) {
  return VENDOR_PACKAGES.map((name) => {
    const spec = rootManifest.devDependencies?.[name];
    if (typeof spec !== "string" || !spec.startsWith("file:vendor/harness-request-budget/")) {
      fail("OFFICIAL_PACKAGE_VENDOR_SPEC_INVALID");
    }
    const sourcePath = spec.slice("file:".length).replaceAll("/", sep);
    const filename = basename(sourcePath);
    const expected = VENDOR_HASHES[filename];
    if (!HASH.test(expected ?? "")) fail("OFFICIAL_PACKAGE_VENDOR_HASH_INVALID");
    return { name, sourcePath, filename, expected };
  });
}

async function packPlugin(source, destination, run) {
  const pluginRoot = join(source, "packages", "dsh-deepseek-web-official-plugin");
  const pkg = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
  if (pkg.name !== PLUGIN_NAME || pkg.private !== true || pkg.version !== "0.0.0-private") {
    fail("OFFICIAL_PACKAGE_PLUGIN_MANIFEST_INVALID");
  }
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    if (dependency.startsWith("@deepseek-pp/")) fail("OFFICIAL_PACKAGE_PRIVATE_RUNTIME_DEPENDENCY");
  }
  if (pkg.dependencies?.ws !== "8.21.0" || pkg.dependencies?.koffi !== "3.2.1") {
    fail("OFFICIAL_PACKAGE_RUNTIME_DEPENDENCY_INVALID");
  }
  const host = await readFile(join(pluginRoot, "lib", "index.js"), "utf8");
  const persistence = await readFile(join(pluginRoot, "lib", "session-persistence.js"), "utf8");
  if (/(?:from\s+|import\s*\()["']@deepseek-pp\//u.test(host)
      || /(?:from\s+|import\s*\()["']@deepseek-pp\//u.test(persistence)) {
    fail("OFFICIAL_PACKAGE_HOST_NOT_SELF_CONTAINED");
  }
  const requiredPayload = [
    "package.json",
    "lib/index.js",
    "lib/index.d.ts",
    "lib/client.js",
    "lib/client.d.ts",
    "lib/session-persistence.js",
    "lib/session-persistence.d.ts",
    "cordis.patch.yml",
  ];
  if (pkg.main !== "./lib/index.js" || pkg.types !== "./lib/index.d.ts"
      || pkg.exports?.["."]?.default !== "./lib/index.js" || pkg.exports?.["."]?.types !== "./lib/index.d.ts"
      || pkg.exports?.["./client"]?.default !== "./lib/client.js" || pkg.exports?.["./client"]?.types !== "./lib/client.d.ts"
      || pkg.exports?.["./session-persistence"]?.default !== "./lib/session-persistence.js"
      || pkg.exports?.["./session-persistence"]?.types !== "./lib/session-persistence.d.ts") {
    fail("OFFICIAL_PACKAGE_PLUGIN_MANIFEST_INVALID");
  }
  const patch = await readFile(join(pluginRoot, "cordis.patch.yml"), "utf8");
  if (patch.replaceAll("\r\n", "\n") !== EXPECTED_PLUGIN_PATCH) {
    fail("OFFICIAL_PACKAGE_PLUGIN_MANIFEST_INVALID");
  }
  for (const path of requiredPayload) await plainPath(join(pluginRoot, path));
  await mkdir(destination, { recursive: true });
  const packed = await run(process.execPath, [
    findNpmCli(), "pack", "--json", "--ignore-scripts", "--pack-destination", destination,
  ], pluginRoot);
  let parsed;
  try { parsed = JSON.parse(packed.stdout); } catch { fail("OFFICIAL_PACKAGE_PACK_OUTPUT_INVALID"); }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("OFFICIAL_PACKAGE_PACK_OUTPUT_INVALID");
  const record = parsed[0];
  const expectedFilename = "deepseek-pp-dsh-deepseek-web-official-plugin-0.0.0-private.tgz";
  const packedPaths = Array.isArray(record?.files) ? new Set(record.files.map((file) => file.path)) : new Set();
  if (record?.name !== PLUGIN_NAME || record.filename !== expectedFilename
      || requiredPayload.some((path) => !packedPaths.has(path))) {
    fail("OFFICIAL_PACKAGE_PACK_OUTPUT_INVALID");
  }
  const path = join(destination, record.filename);
  const bytes = await readFile(path);
  if (record.integrity !== sri512(bytes)) fail("OFFICIAL_PACKAGE_PLUGIN_INTEGRITY_MISMATCH");
  if ((await inventory(destination)).join("\0") !== expectedFilename) fail("OFFICIAL_PACKAGE_PACK_OUTPUT_INVALID");
  return { path, filename: record.filename, sha256: sha256(bytes), integrity: record.integrity };
}

export async function packageOfficialPlugin(options, injected = {}) {
  if (Number(process.versions.node.split(".")[0]) !== 24) fail("OFFICIAL_PACKAGE_NODE_VERSION_INVALID");
  const source = await plainPath(options.source);
  const output = await plainPath(options.output, true);
  if (existsSync(output)) fail("OFFICIAL_PACKAGE_OUTPUT_EXISTS");
  if (![source, ...BROWSERS.map((browser) => options.extensions[browser])]
    .every((input) => outside(resolve(input), output) && outside(output, resolve(input)))) {
    fail("OFFICIAL_PACKAGE_OUTPUT_OVERLAP");
  }
  const run = injected.run ?? command;
  const identity = await sourceIdentity(source, run);
  const rootManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (rootManifest.devDependencies?.["@deepseek-ai/dsh"] !== HARNESS_VERSION) {
    fail("OFFICIAL_PACKAGE_HARNESS_VERSION_INVALID");
  }
  await mkdir(output);
  const plugin = await packPlugin(source, join(output, "plugin"), run);
  const vendors = [];
  for (const record of vendorRecords(rootManifest)) {
    const sourcePath = join(source, record.sourcePath);
    const bytes = await readFile(await plainPath(sourcePath));
    const actual = sha256(bytes);
    if (actual !== record.expected) fail("OFFICIAL_PACKAGE_VENDOR_HASH_MISMATCH");
    const target = join(output, "vendor", record.filename);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
    vendors.push({ name: record.name, path: `vendor/${record.filename}`, sha256: actual });
  }
  const extensions = {};
  for (const browser of BROWSERS) {
    const directory = await plainPath(options.extensions[browser]);
    const build = await (injected.readExtension ?? readExtension)(directory, identity, browser, rootManifest.version, source);
    const targetDirectory = join(output, "extensions", browser);
    const target = join(targetDirectory, build.archive.path);
    await mkdir(targetDirectory, { recursive: true });
    await copyFile(join(directory, "build.json"), join(targetDirectory, "build.json"));
    await copyFile(join(directory, build.archive.path), target);
    const copied = await (injected.readExtension ?? readExtension)(targetDirectory, identity, browser, rootManifest.version, source);
    extensions[browser] = { path: `extensions/${browser}/${copied.archive.path}`, sha256: copied.archive.sha256 };
  }
  const instructions = await readFile(join(source, "docs", "verification", "T7_官方插件使用.md"));
  await writeFile(join(output, "使用说明.md"), instructions, { flag: "wx" });
  sameIdentity(await sourceIdentity(source, run), identity);
  const files = [];
  for (const path of await inventory(output)) files.push({ path, sha256: sha256(await readFile(join(output, path))) });
  const manifest = {
    schema_version: 1,
    kind: "local-official-plugin-candidate",
    source_commit: identity.commit,
    extension_version: rootManifest.version,
    node_major: 24,
    harness_version: HARNESS_VERSION,
    plugin: { name: PLUGIN_NAME, version: "0.0.0-private", path: `plugin/${plugin.filename}`, sha256: plugin.sha256, integrity: plugin.integrity },
    budget_overrides: vendors,
    extensions,
    acceptance: { automated_install: "pending", real_web: "pending" },
    release_eligible: false,
    files,
  };
  const raw = json(manifest);
  const manifestHash = sha256(raw);
  await writeFile(join(output, "SHA256SUMS"), [
    ...files.map((file) => `${file.sha256}  ${file.path}\n`),
    `${manifestHash}  manifest.json\n`,
  ].join(""), { flag: "wx" });
  await writeFile(join(output, "manifest.json"), raw, { flag: "wx" });
  return { ok: true, source_commit: identity.commit, manifest_sha256: manifestHash, files: files.length };
}

export async function verifyOfficialPlugin({ candidate, expectedSha256 }) {
  const directory = await plainPath(candidate);
  if (!HASH.test(expectedSha256 ?? "")) fail("OFFICIAL_PACKAGE_HASH_REQUIRED");
  const raw = await readFile(join(directory, "manifest.json"));
  if (sha256(raw) !== expectedSha256) fail("OFFICIAL_PACKAGE_MANIFEST_HASH_MISMATCH");
  const manifest = JSON.parse(raw);
  if (!exact(manifest, ["schema_version", "kind", "source_commit", "extension_version", "node_major", "harness_version", "plugin", "budget_overrides", "extensions", "acceptance", "release_eligible", "files"])
      || manifest?.schema_version !== 1 || manifest?.kind !== "local-official-plugin-candidate"
      || manifest?.node_major !== 24 || manifest?.harness_version !== HARNESS_VERSION
      || !COMMIT.test(manifest?.source_commit ?? "") || typeof manifest?.extension_version !== "string"
      || manifest?.release_eligible !== false || !exact(manifest?.acceptance, ["automated_install", "real_web"])
      || manifest.acceptance.automated_install !== "pending" || manifest.acceptance.real_web !== "pending"
      || !exact(manifest?.plugin, ["name", "version", "path", "sha256", "integrity"])
      || manifest.plugin.name !== PLUGIN_NAME || manifest.plugin.version !== "0.0.0-private"
      || manifest.plugin.path !== "plugin/deepseek-pp-dsh-deepseek-web-official-plugin-0.0.0-private.tgz"
      || !HASH.test(manifest.plugin.sha256 ?? "") || typeof manifest.plugin.integrity !== "string"
      || !Array.isArray(manifest?.budget_overrides) || !exact(manifest?.extensions, BROWSERS)
      || !Array.isArray(manifest?.files) || manifest.files.length === 0) {
    fail("OFFICIAL_PACKAGE_MANIFEST_INVALID");
  }
  const paths = new Set();
  for (const file of manifest.files) {
    if (!exact(file, ["path", "sha256"]) || !safeRelative(file.path) || !HASH.test(file.sha256 ?? "") || paths.has(file.path)) {
      fail("OFFICIAL_PACKAGE_MANIFEST_INVALID");
    }
    paths.add(file.path);
  }
  const actual = await inventory(directory);
  const expected = [...manifest.files.map((file) => file.path), "manifest.json", "SHA256SUMS"].sort();
  if (actual.join("\0") !== expected.join("\0")) fail("OFFICIAL_PACKAGE_FILE_SET_MISMATCH");
  for (const file of manifest.files) {
    if (sha256(await readFile(join(directory, file.path))) !== file.sha256) {
      fail("OFFICIAL_PACKAGE_FILE_HASH_MISMATCH");
    }
  }
  const fileByPath = new Map(manifest.files.map((file) => [file.path, file]));
  if (fileByPath.get(manifest.plugin.path)?.sha256 !== manifest.plugin.sha256
      || sri512(await readFile(join(directory, manifest.plugin.path))) !== manifest.plugin.integrity) {
    fail("OFFICIAL_PACKAGE_PLUGIN_MANIFEST_INVALID");
  }
  const checksums = [
    ...manifest.files.map((file) => `${file.sha256}  ${file.path}\n`),
    `${expectedSha256}  manifest.json\n`,
  ].join("");
  if (await readFile(join(directory, "SHA256SUMS"), "utf8") !== checksums) {
    fail("OFFICIAL_PACKAGE_CHECKSUMS_INVALID");
  }
  if (manifest.budget_overrides.length !== VENDOR_PACKAGES.length) fail("OFFICIAL_PACKAGE_VENDOR_MANIFEST_INVALID");
  for (let index = 0; index < VENDOR_PACKAGES.length; index += 1) {
    const vendor = manifest.budget_overrides[index];
    const name = VENDOR_PACKAGES[index];
    const filename = VENDOR_ARCHIVE_BY_PACKAGE[name];
    const path = `vendor/${filename}`;
    if (!exact(vendor, ["name", "path", "sha256"]) || vendor.name !== name || vendor.path !== path
        || vendor.sha256 !== VENDOR_HASHES[filename] || fileByPath.get(path)?.sha256 !== vendor.sha256) {
      fail("OFFICIAL_PACKAGE_VENDOR_MANIFEST_INVALID");
    }
  }
  for (const browser of BROWSERS) {
    const record = manifest.extensions?.[browser];
    const expectedPath = `extensions/${browser}/deepseek-plus-plus-${manifest.extension_version}-${browser}.zip`;
    if (!exact(record, ["path", "sha256"]) || record.path !== expectedPath || !HASH.test(record.sha256 ?? "")
        || fileByPath.get(expectedPath)?.sha256 !== record.sha256) {
      fail("OFFICIAL_PACKAGE_EXTENSION_MANIFEST_INVALID");
    }
  }
  return { ok: true, source_commit: manifest.source_commit, manifest_sha256: expectedSha256, files: manifest.files.length };
}

function safeRelative(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function main(args) {
  const [action, ...tail] = args;
  const options = {};
  if (tail.length % 2 !== 0) fail("OFFICIAL_PACKAGE_USAGE");
  for (let index = 0; index < tail.length; index += 2) {
    const key = tail[index];
    if (!key?.startsWith("--") || Object.hasOwn(options, key.slice(2))) fail("OFFICIAL_PACKAGE_USAGE");
    options[key.slice(2)] = tail[index + 1];
  }
  if (action === "package" && ["source", "output", ...BROWSERS].every((key) => typeof options[key] === "string")) {
    return packageOfficialPlugin({
      source: options.source,
      output: options.output,
      extensions: Object.fromEntries(BROWSERS.map((browser) => [browser, options[browser]])),
    });
  }
  if (action === "verify" && typeof options.candidate === "string" && typeof options.sha256 === "string") {
    return verifyOfficialPlugin({ candidate: options.candidate, expectedSha256: options.sha256 });
  }
  fail("OFFICIAL_PACKAGE_USAGE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code ?? "OFFICIAL_PACKAGE_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
