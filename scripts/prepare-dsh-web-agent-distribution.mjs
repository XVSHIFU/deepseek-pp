import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findNpmCli, HARNESS_VERSION as VERSION } from '../packages/dsh-web-agent-bundle/bin/install-runtime.mjs';

const execute = promisify(execFile);
const PACKAGES = ['web-model-protocol', 'dsh-web-model-transport', 'dsh-llm-deepseek-web', 'dsh-web-agent-bundle'];
const VENDOR_PACKAGES = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm-retry'];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

export function runtimeManifest(sourceManifest) {
  if (sourceManifest.devDependencies?.['@deepseek-ai/dsh'] !== VERSION) fail('DISTRIBUTION_HARNESS_VERSION_INVALID');
  const dependencies = { '@deepseek-ai/dsh': VERSION };
  // Keep the checkout's compatibility overrides while npm prunes unrelated
  // roots. Dropping one can silently resolve a new transitive version.
  const overrides = { ...sourceManifest.overrides };
  for (const name of VENDOR_PACKAGES) {
    const spec = sourceManifest.devDependencies?.[name];
    if (typeof spec !== 'string' || !/^file:vendor\/harness-request-budget\/[a-z0-9.-]+\.tgz$/.test(spec) ||
        sourceManifest.overrides?.[name] !== `$${name}`) fail('DISTRIBUTION_VENDOR_INVALID');
    dependencies[name] = spec;
    overrides[name] = `$${name}`;
  }
  return { name: 'deepseek-web-agent-local-runtime', version: '0.0.0-private', private: true,
    type: 'module', license: 'Apache-2.0', engines: { node: '>=24 <25' },
    workspaces: PACKAGES.map(name => `packages/${name}`), dependencies, overrides };
}

function registryIdentity(key, record) {
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return JSON.stringify([name, record.version, record.integrity, record.resolved]);
}

function sameDependencies(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const keys = Object.keys(left).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort()) && keys.every(key => left[key] === right[key]);
}

/** npm owns lock pruning; this guard rejects any newly resolved package identity. */
export function assertPinnedLock(source, candidate, manifest) {
  if (source.lockfileVersion !== 3 || candidate.lockfileVersion !== 3 || !candidate.packages?.[''] ||
      !sameDependencies(candidate.packages[''].dependencies, manifest.dependencies) ||
      JSON.stringify(candidate.packages[''].workspaces) !== JSON.stringify(manifest.workspaces)) fail('DISTRIBUTION_LOCK_INVALID');
  const known = new Set(Object.entries(source.packages).filter(([key, value]) => key.includes('node_modules/') && !value.link)
    .map(([key, value]) => registryIdentity(key, value)));
  for (const [key, record] of Object.entries(candidate.packages)) {
    if (!key.includes('node_modules/') || record.link) continue;
    if (!known.has(registryIdentity(key, record))) fail('DISTRIBUTION_LOCK_IDENTITY_CHANGED');
  }
  for (const name of PACKAGES) {
    const local = candidate.packages[`packages/${name}`];
    const link = candidate.packages[`node_modules/@deepseek-pp/${name}`];
    if (local?.version !== '0.0.0-private' || !link?.link || link.resolved !== `packages/${name}`) fail('DISTRIBUTION_WORKSPACE_INVALID');
  }
  if (candidate.packages['node_modules/@deepseek-ai/dsh']?.version !== VERSION) fail('DISTRIBUTION_HARNESS_VERSION_INVALID');
}

async function run(executable, args, cwd) {
  try {
    return await execute(executable, args, { cwd, shell: false, windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024 });
  } catch { fail('DISTRIBUTION_PREPARE_COMMAND_FAILED'); }
}

export async function prepareDistribution({ source, output, npmCli, offline = true }, injected = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('DISTRIBUTION_NODE_VERSION_INVALID');
  if (!isAbsolute(source) || !isAbsolute(output)) fail('DISTRIBUTION_ABSOLUTE_PATH_REQUIRED');
  source = resolve(source); output = resolve(output);
  const inside = relative(source, output);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) fail('DISTRIBUTION_OUTPUT_INSIDE_SOURCE');
  if (existsSync(output)) fail('DISTRIBUTION_OUTPUT_EXISTS');
  const command = injected.run ?? run;
  const commit = (await command('git', ['rev-parse', 'HEAD'], source)).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('DISTRIBUTION_SOURCE_IDENTITY_INVALID');
  if ((await command('git', ['status', '--porcelain', '--untracked-files=normal'], source)).stdout.trim() !== '') fail('DISTRIBUTION_SOURCE_DIRTY');
  const tracked = (await command('git', ['ls-files', '-z'], source)).stdout.split('\0').filter(Boolean);
  const rootPackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  const manifest = runtimeManifest(rootPackage);
  const vendors = VENDOR_PACKAGES.map(name => manifest.dependencies[name].slice('file:'.length));
  const selected = tracked.filter(file => file === 'LICENSE' || vendors.includes(file) ||
    PACKAGES.some(name => file.startsWith(`packages/${name}/`) &&
      /\.(?:ts|mjs|json|yml|yaml|md)$/.test(file) && !file.split('/').some(part => ['node_modules', 'dist', 'tests', '.env'].includes(part))));
  for (const required of ['LICENSE', ...vendors, ...PACKAGES.map(name => `packages/${name}/package.json`),
    'packages/dsh-web-agent-bundle/bin/install-runtime.mjs', 'packages/dsh-web-agent-bundle/bin/model-credentials.mjs']) {
    if (!selected.includes(required)) fail('DISTRIBUTION_SOURCE_FILE_MISSING');
  }
  for (const file of selected) {
    if (file.split('/').some(part => !part || part === '..') || file.includes('\\') || isAbsolute(file)) fail('DISTRIBUTION_SOURCE_PATH_INVALID');
    let current = source;
    for (const part of file.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) fail('DISTRIBUTION_SOURCE_SYMLINK');
    }
  }
  // This is a new explicit output directory. Failed preparation is retained for
  // diagnosis, with no distribution.json commit marker and no active install.
  await mkdir(output);
  for (const file of selected.sort()) {
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(source, file), destination);
  }
  await writeFile(join(output, 'package.json'), json(manifest), { flag: 'wx' });
  await writeFile(join(output, 'package-lock.json'), json(rootLock), { flag: 'wx' });
  await command(process.execPath, [npmCli ?? findNpmCli(), 'install', '--package-lock-only', '--ignore-scripts',
    '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], output);
  const lock = JSON.parse(await readFile(join(output, 'package-lock.json'), 'utf8'));
  assertPinnedLock(rootLock, lock, manifest);
  if (existsSync(join(output, 'node_modules'))) fail('DISTRIBUTION_UNEXPECTED_NODE_MODULES');
  const files = [];
  for (const file of [...selected, 'package.json', 'package-lock.json'].sort()) {
    files.push({ path: file, sha256: hash(await readFile(join(output, file))) });
  }
  const actual = (await readdir(output, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  if (actual.length !== files.length) fail('DISTRIBUTION_UNEXPECTED_FILES');
  const distribution = { schema_version: 1, kind: 'local-development', node_major: 24,
    harness_version: VERSION, source_commit: commit, files };
  const bytes = json(distribution);
  await writeFile(join(output, 'distribution.json'), bytes, { flag: 'wx' });
  return { ok: true, kind: 'local-development', source_commit: commit, manifest_sha256: hash(bytes), files: files.length };
}

export async function main(args) {
  if (args.length !== 2 || args[0] !== '--output') fail('DISTRIBUTION_USAGE');
  return prepareDistribution({ source: resolve(import.meta.dirname, '..'), output: resolve(args[1]) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, error: error.code ?? 'DISTRIBUTION_PREPARE_FAILED' })}\n`); process.exitCode = 1; }
}
