// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const packaging = await import(new URL('../scripts/package-harness-integration.mjs', import.meta.url).href);
const preparing = await import(new URL('../scripts/prepare-dsh-web-agent-distribution.mjs', import.meta.url).href);
const installer = await import(new URL('../packages/dsh-web-agent-bundle/bin/install-runtime.mjs', import.meta.url).href);
const repo = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve('wxt'))('jszip');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = '4'.repeat(40);
const BROWSERS = ['chrome', 'edge', 'firefox'];
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function put(root: string, path: string, bytes: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-test-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'));
  await put(source, 'package.json', JSON.stringify(pkg));
  await put(source, 'package-lock.json', JSON.stringify(lock));
  await put(source, 'wxt.config.ts', 'export default {};');
  await symlink(join(repo, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const tracked = ['LICENSE',
    ...Object.keys(installer.VENDOR_HASHES).map(name => `vendor/harness-request-budget/${name}`),
    ...installer.WORKSPACE_NAMES.map((name: string) => `packages/${name}/package.json`),
    ...['bin/install-runtime.mjs', 'bin/model-credentials.mjs', 'bin/dsh-web-agent.mjs', 'bin/browser-ready.patch.yml',
      'scripts/seed-profile.mjs', 'cordis.patch.yml'].map(file => `packages/dsh-web-agent-bundle/${file}`)];
  for (const file of tracked) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await copyFile(join(repo, file), join(source, file));
  }
  const state = { commit: COMMIT, dirty: false, sbomFailure: false };
  const run = vi.fn(async (_exe: string, args: string[], cwd: string) => {
    if (args[0] === 'rev-parse') return { stdout: state.commit };
    if (args[0] === 'status') return { stdout: state.dirty ? ' M package.json' : '' };
    if (args[0] === 'ls-files') return { stdout: tracked.join('\0') };
    if (args[1] === 'install') {
      const manifest = preparing.runtimeManifest(pkg);
      const candidateLock = structuredClone(lock);
      candidateLock.packages[''].dependencies = manifest.dependencies;
      candidateLock.packages[''].workspaces = manifest.workspaces;
      await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(candidateLock));
      return { stdout: '' };
    }
    if (args[1] === 'sbom') {
      if (state.sbomFailure) throw new Error('fixture failure');
      expect(args).toContain('--package-lock-only');
      expect(args).toContain('--offline');
      return { stdout: JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
        components: [{ type: 'library', name: 'fixture', version: '1.0.0' }] }) };
    }
    throw new Error('unexpected command');
  });
  const zip = vi.fn(async (config: { browser: string; outDir: string; zip: { artifactTemplate: string } }) => {
    const files = {
      'manifest.json': JSON.stringify({ manifest_version: 3, name: '__MSG_extension_name__', default_locale: 'en', version: pkg.version,
        ...(config.browser === 'firefox' ? { browser_specific_settings: { gecko: { id: 'fixture@example.invalid' } } } : {}) }),
      'background.js': '/* Candidate test fixture, not a real browser build. */',
      '_locales/en/messages.json': '{}', '_locales/zh_CN/messages.json': '{}',
    };
    const archive = new JSZip();
    for (const [path, content] of Object.entries(files)) {
      archive.file(path, content);
      await put(join(config.outDir, `${config.browser}-mv3`), path, content);
    }
    const output = join(config.outDir, config.zip.artifactTemplate);
    await writeFile(output, await archive.generateAsync({ type: 'nodebuffer' }));
    return [output];
  });
  const wxt = { version: lock.packages['node_modules/wxt'].version, zip };
  const distribution = join(root, 'distribution');
  const prepared = await preparing.prepareDistribution({ source, output: distribution }, { run });
  const extensions = Object.fromEntries(BROWSERS.map(browser => [browser, join(root, browser)]));
  const options = { source, distribution, distributionSha256: prepared.manifest_sha256, extensions, output: join(root, 'candidate') };
  async function builds() {
    for (const browser of BROWSERS) await packaging.buildExtension({ source, output: extensions[browser], browser }, { run, wxt });
  }
  return { root, source, run, wxt, state, options, builds };
}

describe('local Harness candidate packaging', () => {
  it('uses existing WXT zip and commits a path-free source-bound build receipt only after content checks', async () => {
    const f = await fixture();
    const result = await packaging.buildExtension({ source: f.source, output: f.options.extensions.chrome, browser: 'chrome' }, f);
    expect(result).toMatchObject({ ok: true, source_commit: COMMIT, browser: 'chrome' });
    expect(f.wxt.zip).toHaveBeenCalledWith(expect.objectContaining({ mode: 'production', manifestVersion: 3,
      zip: expect.objectContaining({ zipSources: false, downloadPackages: [] }) }));
    const raw = await readFile(join(f.options.extensions.chrome, 'build.json'), 'utf8');
    expect(raw).not.toContain(f.root);
    expect(JSON.parse(raw).source.files).toHaveProperty('wxt.config.ts');
  });

  it('assembles and independently verifies pinned runtime, three ZIPs and scoped SBOMs without claiming acceptance', async () => {
    const f = await fixture();
    await f.builds();
    const result = await packaging.packageCandidate(f.options, { run: f.run });
    expect(result).toMatchObject({ ok: true, kind: 'local-candidate', source_commit: COMMIT, release_eligible: false,
      acceptance: { clean_install_fake: 'pending', real_web: 'pending', recovery: 'pending', final_quality: 'pending' } });
    const verified = await packaging.verifyCandidate({ candidate: f.options.output, source: f.source, expectedSha256: result.manifest_sha256 });
    expect(verified).toEqual(result);
    const raw = await readFile(join(f.options.output, 'manifest.json'), 'utf8');
    expect(raw).not.toContain(f.root);
    const manifest = JSON.parse(raw);
    expect(manifest.sbom_scopes['sbom/extension-build.cdx.json']).toContain('not-shipped-dependency-claim');
    expect(manifest.pr_568).toBe('deferred');
    expect(await readFile(join(f.options.output, 'runtime/distribution.json'))).toEqual(await readFile(join(f.options.distribution, 'distribution.json')));
    expect(f.run.mock.calls.filter(([, args]) => args[1] === 'sbom')).toHaveLength(2);
    expect(existsSync(join(f.options.output, 'runtime/node_modules'))).toBe(false);
  });

  it.each(['chrome', 'edge', 'firefox'])('rejects altered %s archive bytes before creating a candidate', async browser => {
    const f = await fixture(); await f.builds();
    const receipt = JSON.parse(await readFile(join(f.options.extensions[browser], 'build.json'), 'utf8'));
    await writeFile(join(f.options.extensions[browser], receipt.archive.path), 'not a zip');
    await expect(packaging.packageCandidate(f.options, { run: f.run })).rejects.toThrow(/CANDIDATE_EXTENSION/);
    expect(existsSync(f.options.output)).toBe(false);
  });

  it('rejects a receipt from another source instead of pairing old extension with new runtime', async () => {
    const f = await fixture(); await f.builds();
    const path = join(f.options.extensions.edge, 'build.json');
    const receipt = JSON.parse(await readFile(path, 'utf8')); receipt.source.commit = '7'.repeat(40);
    await writeFile(path, JSON.stringify(receipt));
    await expect(packaging.packageCandidate(f.options, { run: f.run })).rejects.toThrow('CANDIDATE_SOURCE_CHANGED');
    expect(existsSync(f.options.output)).toBe(false);
  });

  it('uses installer hash authority before invoking any npm/SBOM command', async () => {
    const f = await fixture();
    await expect(packaging.packageCandidate({ ...f.options, distributionSha256: '0'.repeat(64) }, { run: f.run })).rejects.toThrow('DISTRIBUTION_HASH_MISMATCH');
    expect(f.run.mock.calls.some(([, args]) => args[1] === 'sbom')).toBe(false);
    expect(existsSync(f.options.output)).toBe(false);
  });

  it('rejects a runtime source mismatch', async () => {
    const f = await fixture(); f.state.commit = '9'.repeat(40);
    await expect(packaging.packageCandidate(f.options, { run: f.run })).rejects.toThrow('CANDIDATE_RUNTIME_SOURCE_MISMATCH');
  });

  it('rejects dirty source and relative or overlapping outputs without writes', async () => {
    const f = await fixture(); f.state.dirty = true;
    await expect(packaging.buildExtension({ source: f.source, output: f.options.extensions.chrome, browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_SOURCE_DIRTY');
    f.state.dirty = false;
    await expect(packaging.buildExtension({ source: f.source, output: 'relative', browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_ABSOLUTE_PATH_REQUIRED');
    await expect(packaging.buildExtension({ source: f.source, output: join(f.source, 'candidate'), browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_OUTPUT_OVERLAP');
    expect(f.wxt.zip).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing output', async () => {
    const f = await fixture(); await mkdir(f.options.extensions.chrome);
    await writeFile(join(f.options.extensions.chrome, 'user.txt'), 'keep');
    await expect(packaging.buildExtension({ source: f.source, output: f.options.extensions.chrome, browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_OUTPUT_EXISTS');
    expect(await readFile(join(f.options.extensions.chrome, 'user.txt'), 'utf8')).toBe('keep');
  });

  it('rejects linked build output ancestry', async () => {
    const f = await fixture();
    const link = join(f.root, 'link');
    await symlink(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(packaging.buildExtension({ source: f.source, output: join(link, 'new'), browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_LINK_DENIED');
  });

  it('does not write a completion marker if source changes during a build', async () => {
    const f = await fixture();
    const original = f.wxt.zip.getMockImplementation()!;
    f.wxt.zip.mockImplementation(async config => { const result = await original(config); f.state.commit = '8'.repeat(40); return result; });
    await expect(packaging.buildExtension({ source: f.source, output: f.options.extensions.chrome, browser: 'chrome' }, f)).rejects.toThrow('CANDIDATE_SOURCE_CHANGED');
    expect(existsSync(f.options.extensions.chrome)).toBe(true);
    expect(existsSync(join(f.options.extensions.chrome, 'build.json'))).toBe(false);
  });

  it('retains failed assembly without a manifest commit marker or fabricated SBOM', async () => {
    const f = await fixture(); await f.builds(); f.state.sbomFailure = true;
    await expect(packaging.packageCandidate(f.options, { run: f.run })).rejects.toThrow('fixture failure');
    expect(existsSync(join(f.options.output, 'runtime/distribution.json'))).toBe(true);
    expect(existsSync(join(f.options.output, 'manifest.json'))).toBe(false);
    expect(existsSync(join(f.options.output, 'SHA256SUMS'))).toBe(false);
  });

  it('rejects unexpected candidate files and hash tampering in verification', async () => {
    const f = await fixture(); await f.builds();
    const result = await packaging.packageCandidate(f.options, { run: f.run });
    const options = { candidate: f.options.output, source: f.source, expectedSha256: result.manifest_sha256 };
    await expect(packaging.verifyCandidate({ ...options, expectedSha256: '0'.repeat(64) })).rejects.toThrow('CANDIDATE_HASH_MISMATCH');
    await writeFile(join(f.options.output, 'unexpected.txt'), 'must not ship');
    await expect(packaging.verifyCandidate(options)).rejects.toThrow('CANDIDATE_FILE_SET_MISMATCH');
  });

  it('does not accept fake release eligibility even under a newly supplied manifest hash', async () => {
    const f = await fixture(); await f.builds();
    await packaging.packageCandidate(f.options, { run: f.run });
    const path = join(f.options.output, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.release_eligible = true;
    const raw = JSON.stringify(manifest); await writeFile(path, raw);
    await expect(packaging.verifyCandidate({ candidate: f.options.output, source: f.source, expectedSha256: hash(raw) })).rejects.toThrow('CANDIDATE_MANIFEST_INVALID');
  });

  it('normalizes only npm expanded fixed-vendor distribution URIs while preserving SBOM identities and hashes', async () => {
    const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'));
    const record = lock.packages['node_modules/@deepseek-ai/dsh-llm'];
    const sbom = { bomFormat: 'CycloneDX', components: [{ name: '@deepseek-ai/dsh-llm', version: record.version,
      hashes: [{ alg: 'SHA-512', content: 'fixture-hash' }],
      externalReferences: [{ type: 'distribution', url: `file:${resolve(repo, record.resolved.slice(5))}` }] }] };
    const normalized = packaging.normalizeSbomLocalReferences(sbom, repo, lock);
    expect(normalized.components[0].externalReferences[0].url).toBe(record.resolved);
    expect(normalized.components[0].hashes).toEqual(sbom.components[0].hashes);
    expect(sbom.components[0].externalReferences[0].url).not.toBe(record.resolved);
    const wrong = structuredClone(sbom); wrong.components[0].externalReferences[0].url = `file:${resolve(repo, 'untrusted.tgz')}`;
    expect(() => packaging.normalizeSbomLocalReferences(wrong, repo, lock)).toThrow('CANDIDATE_SBOM_LOCAL_REFERENCE_INVALID');
    const foreign = structuredClone(sbom); foreign.components[0].name = 'unrelated-package';
    expect(() => packaging.normalizeSbomLocalReferences(foreign, repo, lock)).toThrow('CANDIDATE_SBOM_LOCAL_REFERENCE_INVALID');
  });

  it.each([[], ['publish'], ['build-extension', '--source', 'a', '--source', 'b'], ['verify', '--candidate']].map(args => ({ args })))('fails invalid CLI arguments $args', async ({ args }) => {
    await expect(packaging.main(args)).rejects.toThrow('CANDIDATE_USAGE');
  });
});
