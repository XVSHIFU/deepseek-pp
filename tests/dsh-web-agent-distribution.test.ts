// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PackageRecord = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  dependencies?: Record<string, string>;
  workspaces?: string[];
};
type Lock = { lockfileVersion: number; packages: Record<string, PackageRecord> };
type SourceManifest = { devDependencies: Record<string, string>; overrides: Record<string, string> };
type RuntimeManifest = {
  name: string; version: string; private: boolean; type: string; license: string;
  engines: { node: string }; workspaces: string[];
  dependencies: Record<string, string>; overrides: Record<string, string>;
};
type Command = (executable: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr?: string }>;
interface DistributionModule {
  runtimeManifest(source: SourceManifest): RuntimeManifest;
  assertPinnedLock(source: Lock, candidate: Lock, manifest: RuntimeManifest): void;
  prepareDistribution(options: { source: string; output: string; npmCli?: string; offline?: boolean }, injected?: {
    run?: Command;
  }): Promise<{ ok: true; kind: string; source_commit: string; manifest_sha256: string; files: number }>;
}

// This CLI is intentionally executable directly by Node without a TS build.
// @ts-expect-error -- The standalone .mjs CLI has no TypeScript declaration file.
const { runtimeManifest, assertPinnedLock, prepareDistribution } = await import('../scripts/prepare-dsh-web-agent-distribution.mjs') as DistributionModule;

const VERSION = '0.1.2-rc.1';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PACKAGES = ['web-model-protocol', 'dsh-web-model-transport', 'dsh-llm-deepseek-web', 'dsh-web-agent-bundle'];
const VENDORS = {
  '@deepseek-ai/dsh-llm': 'file:vendor/harness-request-budget/deepseek-ai-dsh-llm-0.1.2-rc.1-494a4a63fb46.tgz',
  '@deepseek-ai/dsh-compaction-basic': 'file:vendor/harness-request-budget/deepseek-ai-dsh-compaction-basic-0.1.2-rc.1-44f8a92cd699.tgz',
  '@deepseek-ai/dsh-llm-retry': 'file:vendor/harness-request-budget/deepseek-ai-dsh-llm-retry-0.1.2-rc.1-aa44c61be81b.tgz',
};
const COMPATIBILITY_OVERRIDES = {
  '@earendil-works/pi-ai': '0.83.0',
  tmp: '^0.2.7',
  uuid: '^11.1.1',
};
const roots: string[] = [];

afterEach(async () => {
  // Only test-owned mkdtemp roots are ever recursively removed.
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function sourceManifest(): SourceManifest {
  return {
    devDependencies: { '@deepseek-ai/dsh': VERSION, ...VENDORS, vitest: '^4.1.8' },
    overrides: { ...Object.fromEntries(Object.keys(VENDORS).map(name => [name, `$${name}`])), ...COMPATIBILITY_OVERRIDES },
  };
}

function identity(name: string, version: string, resolved = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`): PackageRecord {
  return { version, resolved, integrity: `sha512-${Buffer.from(`${name}:${version}:${resolved}`).toString('base64')}` };
}

function pinnedLock(manifest = runtimeManifest(sourceManifest())): Lock {
  const packages: Record<string, PackageRecord> = {
    '': { dependencies: { ...manifest.dependencies }, workspaces: [...manifest.workspaces] },
    'node_modules/@deepseek-ai/dsh': identity('@deepseek-ai/dsh', VERSION),
    'node_modules/@earendil-works/pi-ai': identity('@earendil-works/pi-ai', '0.83.0'),
    'node_modules/ws': identity('ws', '8.18.3'),
  };
  for (const [name, spec] of Object.entries(VENDORS)) packages[`node_modules/${name}`] = identity(name, VERSION, spec);
  for (const name of PACKAGES) {
    packages[`packages/${name}`] = { version: '0.0.0-private', dependencies: { ws: '8.18.3' } };
    packages[`node_modules/@deepseek-pp/${name}`] = { resolved: `packages/${name}`, link: true };
  }
  return { lockfileVersion: 3, packages };
}

function sortedDependencies(lock: Lock): Lock {
  const candidate = structuredClone(lock);
  candidate.packages[''].dependencies = Object.fromEntries(Object.entries(candidate.packages[''].dependencies!).sort(([left], [right]) => left.localeCompare(right)));
  return candidate;
}

async function put(root: string, file: string, contents: string | Uint8Array) {
  const destination = join(root, file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

type Fixture = {
  root: string; source: string; output: string; tracked: string[];
  selected: string[]; lock: Lock; manifest: RuntimeManifest;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-distribution-test-'));
  roots.push(root);
  const source = join(root, 'source');
  const output = join(root, 'runtime');
  const manifest = runtimeManifest(sourceManifest());
  const lock = pinnedLock(manifest);
  lock.packages['node_modules/unrelated-dev-package'] = { ...identity('unrelated-dev-package', '1.2.3'), dev: true };
  const selected = ['LICENSE', ...Object.values(VENDORS).map(spec => spec.slice('file:'.length))];
  await put(source, 'LICENSE', 'Apache-2.0 fixture license\n');
  for (const [index, file] of selected.slice(1).entries()) await put(source, file, Uint8Array.from([31, 139, 8, 0, index, 255, 0]));
  for (const name of PACKAGES) {
    const packageFile = `packages/${name}/package.json`;
    const sourceFile = `packages/${name}/src/index.ts`;
    selected.push(packageFile, sourceFile);
    await put(source, packageFile, JSON.stringify({ name: `@deepseek-pp/${name}`, version: '0.0.0-private', private: true, type: 'module', dependencies: { ws: '8.18.3' } }));
    await put(source, sourceFile, `export const packageName = '${name}';\n`);
  }
  for (const file of ['bin/install-runtime.mjs', 'bin/model-credentials.mjs', 'cordis.patch.yml', 'README.md']) {
    const path = `packages/dsh-web-agent-bundle/${file}`;
    selected.push(path);
    await put(source, path, `fixture ${file}\n`);
  }
  // Both tracked unrelated files and untracked package-local state are present;
  // the distribution must not pick them up by recursively copying the source.
  const excluded = [
    'package.json', 'package-lock.json', '.env', '.sessions/turn.json',
    'node_modules/secret/package.json', 'docs/private-notes.md',
    'packages/unrelated-runtime/src/private.ts',
    'packages/web-model-protocol/node_modules/private/index.ts',
    'packages/web-model-protocol/tests/private.test.ts',
    'packages/web-model-protocol/dist/private.json',
    'packages/web-model-protocol/.env/private.json',
  ];
  for (const file of excluded) await put(source, file, 'UNRELATED_SECRET_OR_SESSION\n');
  await put(source, 'packages/dsh-web-agent-bundle/local-session.json', 'UNTRACKED_LOCAL_SESSION\n');
  await put(source, 'package.json', JSON.stringify(sourceManifest()));
  await put(source, 'package-lock.json', JSON.stringify(lock));
  return { root, source, output, tracked: [...selected, ...excluded], selected, lock, manifest };
}

function fakeCommands(state: Fixture, options: {
  status?: string;
  commit?: string;
  onNpm?: (candidate: Lock) => Promise<void> | void;
  sorted?: boolean;
} = {}) {
  return vi.fn<Command>(async (executable, args, cwd) => {
    if (executable === 'git') {
      expect(cwd).toBe(state.source);
      if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${options.commit ?? COMMIT}\n` };
      if (args.join(' ') === 'status --porcelain --untracked-files=normal') return { stdout: options.status ?? '' };
      if (args.join(' ') === 'ls-files -z') return { stdout: `${state.tracked.join('\0')}\0` };
      throw new Error(`Unexpected git command: ${args.join(' ')}`);
    }
    expect(executable).toBe(process.execPath);
    expect(cwd).toBe(state.output);
    expect(args).toEqual(['fixture-npm-cli.mjs', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline']);
    expect(existsSync(join(cwd, 'distribution.json'))).toBe(false);
    // Before the only external lock-pruning operation, all explicit copied
    // inputs must exist, including a byte-identical copy of the source lock.
    expect(JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))).toEqual(state.lock);
    expect(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))).toEqual(state.manifest);
    for (const file of state.selected) expect(await readFile(join(cwd, file))).toEqual(await readFile(join(state.source, file)));
    let candidate = structuredClone(state.lock);
    delete candidate.packages['node_modules/unrelated-dev-package'];
    if (options.sorted) candidate = sortedDependencies(candidate);
    await options.onNpm?.(candidate);
    await writeFile(join(cwd, 'package-lock.json'), `${JSON.stringify(candidate, null, 2)}\n`);
    return { stdout: 'up to date\n' };
  });
}

function options(state: Fixture) {
  return { source: state.source, output: state.output, npmCli: 'fixture-npm-cli.mjs' };
}

describe('local-development runtime manifest', () => {
  it('fixes the four workspace roots and preserves the vendored Harness dependencies and source compatibility overrides', () => {
    expect(runtimeManifest(sourceManifest())).toEqual({
      name: 'deepseek-web-agent-local-runtime', version: '0.0.0-private', private: true,
      type: 'module', license: 'Apache-2.0', engines: { node: '>=24 <25' },
      workspaces: PACKAGES.map(name => `packages/${name}`),
      dependencies: { '@deepseek-ai/dsh': VERSION, ...VENDORS },
      overrides: { ...Object.fromEntries(Object.keys(VENDORS).map(name => [name, `$${name}`])), ...COMPATIBILITY_OVERRIDES },
    });
  });

  it('copies all source overrides without changing them or turning transitive compatibility pins into root dependencies', () => {
    const source = sourceManifest();
    const before = structuredClone(source);
    const manifest = runtimeManifest(source);
    expect(manifest.overrides).toEqual(source.overrides);
    expect(manifest.overrides).not.toBe(source.overrides);
    expect(manifest.overrides).toMatchObject({ '@earendil-works/pi-ai': '0.83.0', tmp: '^0.2.7', uuid: '^11.1.1' });
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@deepseek-ai/dsh', ...Object.keys(VENDORS)].sort());
    expect(source).toEqual(before);
  });

  it.each(['^0.1.2-rc.1', '0.1.2', '', 'latest'])('rejects non-pinned Harness spec %j', spec => {
    const source = sourceManifest();
    source.devDependencies['@deepseek-ai/dsh'] = spec;
    expect(() => runtimeManifest(source)).toThrow('DISTRIBUTION_HARNESS_VERSION_INVALID');
  });

  it.each(['0.1.2-rc.1', 'https://example.invalid/runtime.tgz', 'file:vendor/harness-request-budget/../../escape.tgz', 'file:vendor/other/runtime.tgz'])('rejects non-vendor or traversal spec %j', spec => {
    const source = sourceManifest();
    source.devDependencies['@deepseek-ai/dsh-llm'] = spec;
    expect(() => runtimeManifest(source)).toThrow('DISTRIBUTION_VENDOR_INVALID');
  });

  it('rejects a missing or independently resolved vendor override', () => {
    const source = sourceManifest();
    delete source.overrides['@deepseek-ai/dsh-llm'];
    expect(() => runtimeManifest(source)).toThrow('DISTRIBUTION_VENDOR_INVALID');
    source.overrides['@deepseek-ai/dsh-llm'] = VERSION;
    expect(() => runtimeManifest(source)).toThrow('DISTRIBUTION_VENDOR_INVALID');
  });
});

describe('pruned lock identity guard', () => {
  it('accepts npm dependency key sorting, pruning, dev-flag removal, and unchanged registry identities after hoisting', () => {
    const manifest = runtimeManifest(sourceManifest());
    const candidate = sortedDependencies(pinnedLock(manifest));
    const source = structuredClone(candidate);
    source.packages['packages/dsh-web-agent-bundle/node_modules/ws'] = { ...source.packages['node_modules/ws'], dev: true };
    delete source.packages['node_modules/ws'];
    source.packages['node_modules/unrelated-dev-package'] = identity('unrelated-dev-package', '1.2.3');
    expect(() => assertPinnedLock(source, candidate, manifest)).not.toThrow();
  });

  it.each(['version', 'resolved', 'integrity'] as const)('rejects a changed vendor %s despite retaining its package name', field => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    const candidate = structuredClone(source);
    candidate.packages['node_modules/@deepseek-ai/dsh-llm'][field] = 'changed-identity';
    expect(() => assertPinnedLock(source, candidate, manifest)).toThrow('DISTRIBUTION_LOCK_IDENTITY_CHANGED');
  });

  it('rejects a newly resolved registry package', () => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    const candidate = structuredClone(source);
    candidate.packages['node_modules/unapproved'] = identity('unapproved', '1.0.0');
    expect(() => assertPinnedLock(source, candidate, manifest)).toThrow('DISTRIBUTION_LOCK_IDENTITY_CHANGED');
  });

  it('still rejects a transitive pi-ai upgrade instead of compensating for a missing source override', () => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    const candidate = structuredClone(source);
    candidate.packages['node_modules/@earendil-works/pi-ai'] = identity('@earendil-works/pi-ai', '0.84.4');
    expect(() => assertPinnedLock(source, candidate, manifest)).toThrow('DISTRIBUTION_LOCK_IDENTITY_CHANGED');
  });

  it.each(['source-version', 'candidate-version', 'root-dependency', 'root-workspaces'] as const)('rejects invalid lock metadata: %s', kind => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    const candidate = structuredClone(source);
    if (kind === 'source-version') source.lockfileVersion = 2;
    if (kind === 'candidate-version') candidate.lockfileVersion = 2;
    if (kind === 'root-dependency') candidate.packages[''].dependencies!['@deepseek-ai/dsh'] = '^0.1.2-rc.1';
    if (kind === 'root-workspaces') candidate.packages[''].workspaces!.push('packages/unrelated-runtime');
    expect(() => assertPinnedLock(source, candidate, manifest)).toThrow('DISTRIBUTION_LOCK_INVALID');
  });

  it.each(['missing-package', 'package-version', 'missing-link', 'link-target'] as const)('rejects invalid selected workspace: %s', kind => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    const candidate = structuredClone(source);
    if (kind === 'missing-package') delete candidate.packages['packages/web-model-protocol'];
    if (kind === 'package-version') candidate.packages['packages/web-model-protocol'].version = '1.0.0';
    if (kind === 'missing-link') delete candidate.packages['node_modules/@deepseek-pp/web-model-protocol'];
    if (kind === 'link-target') candidate.packages['node_modules/@deepseek-pp/web-model-protocol'].resolved = 'packages/unrelated-runtime';
    expect(() => assertPinnedLock(source, candidate, manifest)).toThrow('DISTRIBUTION_WORKSPACE_INVALID');
  });

  it('rejects an unpinned Harness even when that identity appears in the original lock', () => {
    const manifest = runtimeManifest(sourceManifest());
    const source = pinnedLock(manifest);
    source.packages['node_modules/@deepseek-ai/dsh'] = identity('@deepseek-ai/dsh', '0.1.3');
    expect(() => assertPinnedLock(source, structuredClone(source), manifest)).toThrow('DISTRIBUTION_HARNESS_VERSION_INVALID');
  });
});

describe('distribution preparation with real file copy and hashing', () => {
  it('produces only explicitly selected inputs and a final verified local-development manifest after npm sorts the lock', async () => {
    const state = await fixture();
    const originalPackage = await readFile(join(state.source, 'package.json'));
    const originalLock = await readFile(join(state.source, 'package-lock.json'));
    const run = fakeCommands(state, { sorted: true });
    const result = await prepareDistribution(options(state), { run });
    const markerBytes = await readFile(join(state.output, 'distribution.json'));
    const marker = JSON.parse(markerBytes.toString('utf8')) as {
      schema_version: number; kind: string; node_major: number; harness_version: string;
      source_commit: string; files: { path: string; sha256: string }[];
    };
    const expectedFiles = [...state.selected, 'package.json', 'package-lock.json'].sort();
    expect(marker).toEqual({
      schema_version: 1, kind: 'local-development', node_major: 24, harness_version: VERSION,
      source_commit: COMMIT,
      files: await Promise.all(expectedFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(state.output, path))).digest('hex') }))),
    });
    expect(result).toEqual({ ok: true, kind: 'local-development', source_commit: COMMIT,
      manifest_sha256: createHash('sha256').update(markerBytes).digest('hex'), files: expectedFiles.length });
    const actualFiles = (await readdir(state.output, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name));
    expect(actualFiles.sort()).toEqual([...expectedFiles, 'distribution.json'].map(file => join(state.output, file)).sort());
    expect(markerBytes.toString('utf8')).not.toMatch(/UNRELATED_SECRET_OR_SESSION|UNTRACKED_LOCAL_SESSION/);
    expect(await readFile(join(state.source, 'package.json'))).toEqual(originalPackage);
    expect(await readFile(join(state.source, 'package-lock.json'))).toEqual(originalLock);
    expect(run.mock.calls).toHaveLength(4);
    expect(run.mock.calls.slice(0, 3).map(call => call[1])).toEqual([
      ['rev-parse', 'HEAD'], ['status', '--porcelain', '--untracked-files=normal'], ['ls-files', '-z'],
    ]);
  });

  it('rejects dirty source before creating an output or invoking npm', async () => {
    const state = await fixture();
    const run = fakeCommands(state, { status: ' M packages/web-model-protocol/src/index.ts\n' });
    await expect(prepareDistribution(options(state), { run })).rejects.toMatchObject({ code: 'DISTRIBUTION_SOURCE_DIRTY' });
    expect(existsSync(state.output)).toBe(false);
    expect(run.mock.calls).toHaveLength(2);
  });

  it('rejects an invalid source commit before trusting the tracked file list', async () => {
    const state = await fixture();
    const run = fakeCommands(state, { commit: 'not-a-pinned-commit' });
    await expect(prepareDistribution(options(state), { run })).rejects.toMatchObject({ code: 'DISTRIBUTION_SOURCE_IDENTITY_INVALID' });
    expect(existsSync(state.output)).toBe(false);
    expect(run.mock.calls).toHaveLength(1);
  });

  it('refuses an existing output without changing any byte or querying source state', async () => {
    const state = await fixture();
    await put(state.output, 'keep.txt', 'existing user file\n');
    const run = fakeCommands(state);
    await expect(prepareDistribution(options(state), { run })).rejects.toMatchObject({ code: 'DISTRIBUTION_OUTPUT_EXISTS' });
    expect(await readdir(state.output)).toEqual(['keep.txt']);
    expect(await readFile(join(state.output, 'keep.txt'), 'utf8')).toBe('existing user file\n');
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['source-root', 'source-child', 'relative-source', 'relative-output'] as const)('rejects unsafe output/input location: %s', async kind => {
    const state = await fixture();
    const input = options(state);
    const run = fakeCommands(state);
    if (kind === 'source-root') input.output = state.source;
    if (kind === 'source-child') input.output = join(state.source, 'runtime');
    if (kind === 'relative-source') input.source = 'relative-source';
    if (kind === 'relative-output') input.output = 'relative-output';
    await expect(prepareDistribution(input, { run })).rejects.toMatchObject({ code: kind.startsWith('relative-') ? 'DISTRIBUTION_ABSOLUTE_PATH_REQUIRED' : 'DISTRIBUTION_OUTPUT_INSIDE_SOURCE' });
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(state.output)).toBe(false);
  });

  it('rejects a tracked traversal before creating the output', async () => {
    const state = await fixture();
    state.tracked.push('packages/web-model-protocol/../../outside.ts');
    await expect(prepareDistribution(options(state), { run: fakeCommands(state) })).rejects.toMatchObject({ code: 'DISTRIBUTION_SOURCE_PATH_INVALID' });
    expect(existsSync(state.output)).toBe(false);
  });

  it('rejects a directory symlink/junction in a selected path without following it', async () => {
    const state = await fixture();
    const target = join(state.root, 'symlink-target');
    await put(target, 'private.ts', 'MUST_NOT_COPY\n');
    await symlink(target, join(state.source, 'packages/web-model-protocol/external'), process.platform === 'win32' ? 'junction' : 'dir');
    state.tracked.push('packages/web-model-protocol/external/private.ts');
    await expect(prepareDistribution(options(state), { run: fakeCommands(state) })).rejects.toMatchObject({ code: 'DISTRIBUTION_SOURCE_SYMLINK' });
    expect(existsSync(state.output)).toBe(false);
    expect(await readFile(join(target, 'private.ts'), 'utf8')).toBe('MUST_NOT_COPY\n');
  });

  it.each(['LICENSE', 'packages/dsh-web-agent-bundle/bin/install-runtime.mjs', 'packages/dsh-web-agent-bundle/bin/model-credentials.mjs'])('refuses absent tracked required file %s', async required => {
    const state = await fixture();
    state.tracked = state.tracked.filter(file => file !== required);
    await expect(prepareDistribution(options(state), { run: fakeCommands(state) })).rejects.toMatchObject({ code: 'DISTRIBUTION_SOURCE_FILE_MISSING' });
    expect(existsSync(state.output)).toBe(false);
  });

  it.each(['identity-drift', 'unexpected-file', 'node-modules'] as const)('retains failed output without a completion marker: %s', async kind => {
    const state = await fixture();
    const run = fakeCommands(state, { onNpm: async candidate => {
      if (kind === 'identity-drift') candidate.packages['node_modules/ws'].integrity = 'sha512-different';
      if (kind === 'unexpected-file') await put(state.output, 'unrequested.txt', 'unexpected npm effect\n');
      if (kind === 'node-modules') await mkdir(join(state.output, 'node_modules'));
    } });
    const code = kind === 'identity-drift' ? 'DISTRIBUTION_LOCK_IDENTITY_CHANGED' : kind === 'unexpected-file' ? 'DISTRIBUTION_UNEXPECTED_FILES' : 'DISTRIBUTION_UNEXPECTED_NODE_MODULES';
    await expect(prepareDistribution(options(state), { run })).rejects.toMatchObject({ code });
    expect(existsSync(state.output)).toBe(true);
    expect(existsSync(join(state.output, 'distribution.json'))).toBe(false);
    expect(await readFile(join(state.output, 'LICENSE'))).toEqual(await readFile(join(state.source, 'LICENSE')));
    expect(await readFile(join(state.source, 'package-lock.json'), 'utf8')).toBe(JSON.stringify(state.lock));
  });
});
