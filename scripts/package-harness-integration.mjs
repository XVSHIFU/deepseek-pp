#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { assertNodeVersion, createRuntimeEnvironment, findNpmCli, readDistribution, VENDOR_HASHES } from '../packages/dsh-web-agent-bundle/bin/install-runtime.mjs';
import { assertPinnedLock, runtimeManifest } from './prepare-dsh-web-agent-distribution.mjs';
import { assertPayloadPolicy, checkDistributionPolicy } from './harness-release-policy-check.mjs';

const execute = promisify(execFile);
const BROWSERS = ['chrome', 'edge', 'firefox'];
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PENDING = Object.freeze({ clean_install_fake: 'pending', recovery: 'pending', real_web: 'pending', final_quality: 'pending' });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function command(executable, args, cwd) {
  try {
    return await execute(executable, args, { cwd, env: createRuntimeEnvironment(process.env), shell: false,
      windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  } catch { fail('CANDIDATE_COMMAND_FAILED'); }
}

async function plainPath(path, missing = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('CANDIDATE_ABSOLUTE_PATH_REQUIRED');
  path = resolve(path);
  let cursor = parse(path).root;
  for (const part of relative(cursor, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) fail('CANDIDATE_LINK_DENIED'); }
    catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
  }
  return path;
}

function outside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function newOutput(output, inputs) {
  output = await plainPath(output, true);
  if (existsSync(output)) fail('CANDIDATE_OUTPUT_EXISTS');
  if (inputs.some(input => !outside(resolve(input), output) || !outside(output, resolve(input)))) fail('CANDIDATE_OUTPUT_OVERLAP');
  return output;
}

async function sourceIdentity(source, run = command) {
  source = await plainPath(source);
  const commit = (await run('git', ['rev-parse', 'HEAD'], source)).stdout.trim();
  if (!COMMIT.test(commit)) fail('CANDIDATE_SOURCE_INVALID');
  if ((await run('git', ['status', '--porcelain', '--untracked-files=normal'], source)).stdout.trim()) fail('CANDIDATE_SOURCE_DIRTY');
  const identity = { commit, files: {} };
  for (const file of ['package.json', 'package-lock.json', 'wxt.config.ts']) {
    await plainPath(join(source, file));
    identity.files[file] = hash(await readFile(join(source, file)));
  }
  return identity;
}

function sameIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('CANDIDATE_SOURCE_CHANGED');
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('CANDIDATE_LINK_DENIED');
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), path));
    else if (entry.isFile()) files.push(path);
    else fail('CANDIDATE_FILE_TYPE_INVALID');
  }
  return files.sort();
}

async function zipLibrary(source) {
  // Reuse WXT's already-locked ZIP implementation, not a new archive dependency.
  const require = createRequire(join(source, 'package.json'));
  const wxtRequire = createRequire(require.resolve('wxt'));
  return wxtRequire('jszip');
}

async function inspectExtension(zipPath, browser, version, source, expectedFiles) {
  const bytes = await readFile(await plainPath(zipPath));
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) fail('CANDIDATE_EXTENSION_SIZE');
  const JSZip = await zipLibrary(source);
  let archive;
  try { archive = await JSZip.loadAsync(bytes); } catch { fail('CANDIDATE_EXTENSION_ZIP_INVALID'); }
  const files = [];
  let total = 0;
  for (const [path, entry] of Object.entries(archive.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.dir) continue;
    // JSZip exposes the original name when it normalizes a traversal entry.
    if (entry.unsafeOriginalName !== path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) fail('CANDIDATE_EXTENSION_PATH');
    const content = await entry.async('nodebuffer');
    // The Harness source scanner is not an extension/third-party binary policy.
    // Existing extension release gates remain pending in the candidate manifest.
    if (content.length > 32 * 1024 * 1024) fail('CANDIDATE_EXTENSION_SIZE');
    total += content.length;
    if (total > 128 * 1024 * 1024) fail('CANDIDATE_EXTENSION_SIZE');
    files.push({ path, sha256: hash(content) });
  }
  if (files.filter(file => file.path.split('/').at(-1) === 'manifest.json').length !== 1) fail('CANDIDATE_EXTENSION_MANIFEST');
  const manifest = JSON.parse(await archive.file('manifest.json')?.async('string') ?? 'null');
  if (manifest?.manifest_version !== 3 || manifest.version !== version || manifest.name !== '__MSG_extension_name__'
    || manifest.default_locale !== 'en' || (browser === 'firefox') !== Boolean(manifest.browser_specific_settings?.gecko)) fail('CANDIDATE_EXTENSION_MANIFEST');
  for (const file of ['background.js', '_locales/en/messages.json', '_locales/zh_CN/messages.json']) {
    if (!files.some(record => record.path === file)) fail('CANDIDATE_EXTENSION_MANIFEST');
  }
  if (expectedFiles && JSON.stringify(files) !== JSON.stringify(expectedFiles)) fail('CANDIDATE_EXTENSION_CONTENT_CHANGED');
  return { sha256: hash(bytes), files };
}

/** One fresh browser build per invocation. No source ZIP/download/publish path. */
export async function buildExtension({ source, output, browser }, injected = {}) {
  assertNodeVersion();
  if (!BROWSERS.includes(browser)) fail('CANDIDATE_BROWSER_INVALID');
  const run = injected.run ?? command;
  const identity = await sourceIdentity(source, run);
  output = await newOutput(output, [source]);
  const pkg = await readJson(join(source, 'package.json'));
  const lock = await readJson(join(source, 'package-lock.json'));
  const require = createRequire(join(source, 'package.json'));
  const wxt = injected.wxt ?? await import(pathToFileURL(require.resolve('wxt')).href);
  if (wxt.version !== lock.packages?.['node_modules/wxt']?.version) fail('CANDIDATE_BUILD_TOOL_VERSION');
  await mkdir(output);
  const filename = `deepseek-plus-plus-${pkg.version}-${browser}.zip`;
  const result = await wxt.zip({ root: source, outDir: output, browser, manifestVersion: 3, mode: 'production',
    zip: { artifactTemplate: filename, zipSources: false, downloadPackages: [] } });
  if (result.length !== 1 || resolve(result[0]) !== join(output, filename)) fail('CANDIDATE_BUILD_OUTPUT_INVALID');
  const archive = await inspectExtension(result[0], browser, pkg.version, source);
  const builtFiles = [];
  const buildRoot = join(output, `${browser}-mv3`);
  for (const path of await inventory(buildRoot)) builtFiles.push({ path, sha256: hash(await readFile(join(buildRoot, path))) });
  builtFiles.sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(archive.files) !== JSON.stringify(builtFiles)) fail('CANDIDATE_EXTENSION_CONTENT_CHANGED');
  sameIdentity(await sourceIdentity(source, run), identity);
  const receipt = { schema_version: 1, kind: 'local-extension-build', source: identity, browser,
    version: pkg.version, wxt_version: wxt.version, archive: { path: filename, sha256: archive.sha256 }, files: archive.files };
  const raw = json(receipt);
  await writeFile(join(output, 'build.json'), raw, { flag: 'wx' });
  return { ok: true, browser, source_commit: identity.commit, receipt_sha256: hash(raw), archive_sha256: archive.sha256 };
}

async function readExtension(directory, identity, browser, version, source) {
  await plainPath(directory);
  const receipt = await readJson(join(directory, 'build.json'));
  if (!exact(receipt, ['schema_version', 'kind', 'source', 'browser', 'version', 'wxt_version', 'archive', 'files'])
    || receipt.schema_version !== 1 || receipt.kind !== 'local-extension-build' || receipt.browser !== browser || receipt.version !== version
    || !exact(receipt.archive, ['path', 'sha256']) || receipt.archive.path !== `deepseek-plus-plus-${version}-${browser}.zip`
    || !HASH.test(receipt.archive.sha256) || !Array.isArray(receipt.files)) fail('CANDIDATE_BUILD_RECEIPT_INVALID');
  sameIdentity(receipt.source, identity);
  const archive = await inspectExtension(join(directory, receipt.archive.path), browser, version, source, receipt.files);
  if (archive.sha256 !== receipt.archive.sha256) fail('CANDIDATE_EXTENSION_HASH_MISMATCH');
  return receipt;
}

export function normalizeSbomLocalReferences(value, directory, lock) {
  const normalized = structuredClone(value);
  for (const component of normalized.components ?? []) {
    for (const reference of component.externalReferences ?? []) {
      if (typeof reference.url !== 'string' || !reference.url.startsWith('file:')) continue;
      const record = lock.packages?.[`node_modules/${component.name}`];
      const resolved = record?.resolved;
      const vendor = typeof resolved === 'string' ? resolved.replace('file:vendor/harness-request-budget/', '') : '';
      if (reference.type !== 'distribution' || record?.version !== component.version || !Object.hasOwn(VENDOR_HASHES, vendor)
        || resolved !== `file:vendor/harness-request-budget/${vendor}`
        || resolve(reference.url.slice(5)) !== resolve(directory, resolved.slice(5))) fail('CANDIDATE_SBOM_LOCAL_REFERENCE_INVALID');
      // npm expands these three locked vendor URIs to builder-specific absolute
      // paths. Restore exactly their authenticated lock URI, preserving all
      // component identities, hashes, licenses and dependency relationships.
      reference.url = resolved;
    }
  }
  return normalized;
}

async function generateSbom(directory, run) {
  const result = await run(process.execPath, [findNpmCli(), 'sbom', '--sbom-format=cyclonedx', '--package-lock-only', '--offline', '--ignore-scripts'], directory);
  const value = JSON.parse(result.stdout);
  if (value.bomFormat !== 'CycloneDX' || !Array.isArray(value.components) || value.components.length === 0) fail('CANDIDATE_SBOM_INVALID');
  const bytes = json(normalizeSbomLocalReferences(value, directory, await readJson(join(directory, 'package-lock.json'))));
  assertPayloadPolicy('dependencies.cdx.json', Buffer.from(bytes));
  return bytes;
}

async function copyOwned(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(await plainPath(source), destination);
}

/** Assemble only authenticated runtime bytes and locally produced build receipts. */
export async function packageCandidate({ source, distribution, distributionSha256, extensions, output }, injected = {}) {
  assertNodeVersion();
  const run = injected.run ?? command;
  const identity = await sourceIdentity(source, run);
  if (!exact(extensions, BROWSERS)) fail('CANDIDATE_THREE_BROWSERS_REQUIRED');
  output = await newOutput(output, [source, distribution, ...Object.values(extensions)]);
  const runtime = await readDistribution(distribution, { expectedSha256: distributionSha256 });
  if (runtime.manifest.source_commit !== identity.commit) fail('CANDIDATE_RUNTIME_SOURCE_MISMATCH');
  const pkg = await readJson(join(source, 'package.json'));
  const sourceLock = await readJson(join(source, 'package-lock.json'));
  assertPinnedLock(sourceLock, await readJson(join(distribution, 'package-lock.json')), runtimeManifest(pkg));
  for (const file of runtime.manifest.files.filter(item => !['package.json', 'package-lock.json'].includes(item.path))) {
    if (hash(await readFile(join(source, file.path))) !== file.sha256) fail('CANDIDATE_RUNTIME_SOURCE_CHANGED');
  }
  await checkDistributionPolicy(distribution, { expectedSha256: distributionSha256 });
  const receipts = {};
  for (const browser of BROWSERS) {
    receipts[browser] = await readExtension(extensions[browser], identity, browser, pkg.version, source);
    if (receipts[browser].wxt_version !== sourceLock.packages?.['node_modules/wxt']?.version) fail('CANDIDATE_BUILD_TOOL_VERSION');
  }
  // All readiness/status fields remain pending: packaging is not acceptance.
  // This newly owned output is retained on failure; manifest.json is written last.
  await mkdir(output);
  for (const file of [...runtime.manifest.files.map(item => item.path), 'distribution.json']) {
    await copyOwned(join(distribution, file), join(output, 'runtime', file));
  }
  await readDistribution(join(output, 'runtime'), { expectedSha256: distributionSha256 });
  for (const browser of BROWSERS) {
    const target = join(output, 'extensions', browser);
    await copyOwned(join(extensions[browser], 'build.json'), join(target, 'build.json'));
    await copyOwned(join(extensions[browser], receipts[browser].archive.path), join(target, receipts[browser].archive.path));
    await readExtension(target, identity, browser, pkg.version, source);
  }
  await mkdir(join(output, 'sbom'));
  await writeFile(join(output, 'sbom', 'runtime.cdx.json'), await generateSbom(join(output, 'runtime'), run), { flag: 'wx' });
  await writeFile(join(output, 'sbom', 'extension-build.cdx.json'), await generateSbom(source, run), { flag: 'wx' });
  sameIdentity(await sourceIdentity(source, run), identity);
  const files = [];
  for (const path of await inventory(output)) files.push({ path, sha256: hash(await readFile(join(output, path))) });
  const manifest = { schema_version: 1, kind: 'local-candidate', version: pkg.version, source: identity,
    node_major: 24, harness_version: runtime.manifest.harness_version, runtime: { path: 'runtime', distribution_sha256: distributionSha256 },
    browsers: BROWSERS, sbom_scopes: { 'sbom/runtime.cdx.json': 'runtime-lock-closure', 'sbom/extension-build.cdx.json': 'source-lock-build-inventory-not-shipped-dependency-claim' },
    pr_568: 'deferred', acceptance: PENDING, release_eligible: false, files };
  const raw = json(manifest);
  await writeFile(join(output, 'SHA256SUMS'), [...files, { path: 'manifest.json', sha256: hash(raw) }]
    .map(file => `${file.sha256}  ${file.path}\n`).join(''), { flag: 'wx' });
  await writeFile(join(output, 'manifest.json'), raw, { flag: 'wx' });
  return { ok: true, kind: 'local-candidate', source_commit: identity.commit, manifest_sha256: hash(raw), files: files.length,
    acceptance: PENDING, release_eligible: false };
}

export async function verifyCandidate({ candidate, expectedSha256, source }) {
  await plainPath(candidate);
  if (!HASH.test(expectedSha256 ?? '')) fail('CANDIDATE_HASH_REQUIRED');
  const raw = await readFile(join(candidate, 'manifest.json'));
  if (hash(raw) !== expectedSha256) fail('CANDIDATE_HASH_MISMATCH');
  const manifest = JSON.parse(raw);
  if (!exact(manifest, ['schema_version', 'kind', 'version', 'source', 'node_major', 'harness_version', 'runtime', 'browsers', 'sbom_scopes', 'pr_568', 'acceptance', 'release_eligible', 'files'])
    || manifest.schema_version !== 1 || manifest.kind !== 'local-candidate' || manifest.node_major !== 24 || manifest.release_eligible !== false
    || manifest.pr_568 !== 'deferred' || JSON.stringify(manifest.acceptance) !== JSON.stringify(PENDING)
    || JSON.stringify(manifest.browsers) !== JSON.stringify(BROWSERS) || !Array.isArray(manifest.files)
    || !exact(manifest.runtime, ['path', 'distribution_sha256']) || manifest.runtime.path !== 'runtime') fail('CANDIDATE_MANIFEST_INVALID');
  const actual = await inventory(candidate);
  const expected = [...manifest.files.map(file => file.path), 'manifest.json', 'SHA256SUMS'].sort();
  if (actual.join('\0') !== expected.join('\0')) fail('CANDIDATE_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    if (!exact(file, ['path', 'sha256']) || !HASH.test(file.sha256) || !actual.includes(file.path)) fail('CANDIDATE_FILE_INVALID');
    if (hash(await readFile(join(candidate, file.path))) !== file.sha256) fail('CANDIDATE_FILE_HASH_MISMATCH');
  }
  const checksums = [...manifest.files, { path: 'manifest.json', sha256: expectedSha256 }].map(file => `${file.sha256}  ${file.path}\n`).join('');
  if (await readFile(join(candidate, 'SHA256SUMS'), 'utf8') !== checksums) fail('CANDIDATE_CHECKSUMS_INVALID');
  const runtime = await readDistribution(join(candidate, 'runtime'), { expectedSha256: manifest.runtime.distribution_sha256 });
  if (runtime.manifest.source_commit !== manifest.source?.commit || runtime.manifest.harness_version !== manifest.harness_version) fail('CANDIDATE_RUNTIME_SOURCE_MISMATCH');
  await checkDistributionPolicy(join(candidate, 'runtime'), { expectedSha256: manifest.runtime.distribution_sha256 });
  for (const browser of BROWSERS) await readExtension(join(candidate, 'extensions', browser), manifest.source, browser, manifest.version, source);
  for (const path of ['sbom/runtime.cdx.json', 'sbom/extension-build.cdx.json']) {
    const bytes = await readFile(join(candidate, path));
    assertPayloadPolicy(path, bytes);
    if (JSON.parse(bytes).bomFormat !== 'CycloneDX') fail('CANDIDATE_SBOM_INVALID');
  }
  return { ok: true, kind: manifest.kind, source_commit: manifest.source.commit, manifest_sha256: expectedSha256,
    files: manifest.files.length, acceptance: PENDING, release_eligible: false };
}

export async function main(args) {
  const [action, ...tail] = args;
  const options = {};
  if (tail.length % 2) fail('CANDIDATE_USAGE');
  for (let i = 0; i < tail.length; i += 2) {
    if (!tail[i].startsWith('--') || Object.hasOwn(options, tail[i].slice(2))) fail('CANDIDATE_USAGE');
    options[tail[i].slice(2)] = tail[i + 1];
  }
  if (action === 'build-extension' && exact(options, ['source', 'output', 'browser'])) return buildExtension(options);
  if (action === 'package' && exact(options, ['source', 'distribution', 'sha256', 'chrome', 'edge', 'firefox', 'output'])) {
    return packageCandidate({ source: options.source, distribution: options.distribution, distributionSha256: options.sha256,
      extensions: Object.fromEntries(BROWSERS.map(browser => [browser, options[browser]])), output: options.output });
  }
  if (action === 'verify' && exact(options, ['source', 'candidate', 'sha256'])) return verifyCandidate({ source: options.source, candidate: options.candidate, expectedSha256: options.sha256 });
  fail('CANDIDATE_USAGE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, error: error.code ?? 'CANDIDATE_FAILED' })}\n`); process.exitCode = 1; }
}
