#!/usr/bin/env node
// Build from this checkout only. Never downloads old releases or publishes assets.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageOfficialPlugin, verifyOfficialPlugin } from './package-dsh-official-plugin.mjs';
import { findNpmCli, runProcess } from '../packages/dsh-web-agent-bundle/bin/install-runtime.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new Error(message); };

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--output', '--name', '--instructions'].includes(key) || !args[i + 1] || Object.hasOwn(options, key.slice(2))) fail('Use --output <new directory outside repository> [--name <archive name>] [--instructions <docs/verification/file.md>]');
    options[key.slice(2)] = args[i + 1];
  }
  if (!options.output) fail('--output is required');
  if (options.name && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.name)) fail('Invalid archive name');
  if (options.instructions && (!/^docs\/verification\/[^/\\]+\.md$/u.test(options.instructions) || options.instructions.includes('..'))) fail('Instructions must be one Markdown file in docs/verification');
  return options;
}

export function localImages(markdown) {
  const paths = new Set();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const path = match[1];
    if (/^https?:\/\//.test(path)) continue;
    if (!/^(assets|docs\/images)\/[a-zA-Z0-9_./-]+$/.test(path)
        || path.split('/').some(part => ['', '.', '..'].includes(part))) fail(`Unsupported image path: ${path}`);
    paths.add(path);
  }
  return [...paths].sort();
}

export async function readSourceAsset(root, path) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail(`Source asset cannot be a link: ${path}`);
  }
  return readFile(current);
}

async function command(executable, args, inherit = true) {
  const result = await runProcess(executable, args, { cwd: source, inherit, timeoutMs: 300_000 });
  if (result.code !== 0) fail(`Command failed: ${executable} ${args.join(' ')}\n${result.stderr ?? ''}`);
  return result.stdout?.trim();
}

export async function packageWebHarness(options) {
  if (process.versions.node.split('.')[0] !== '24') fail('Node.js 24.x is required');
  const output = resolve(options.output);
  // Require an existing real parent and a fresh leaf; no overwrite or recursive cleanup.
  const parent = await realpath(dirname(output));
  const canonical = join(parent, output.split(sep).at(-1));
  const sourceReal = await realpath(source);
  for (const [a, b] of [[sourceReal, canonical], [canonical, sourceReal]]) {
    const rel = relative(a, b);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) fail('Output must be outside repository');
  }
  const commit = await command('git', ['rev-parse', 'HEAD'], false);
  if (await command('git', ['status', '--porcelain', '--untracked-files=all'], false)) fail('Commit changes before packaging');
  const name = options.name ?? `deepseek-web-harness-${commit.slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) fail('Invalid archive name');
  await mkdir(canonical);
  await command(process.execPath, [findNpmCli(), 'run', 'build', '--workspace', '@deepseek-pp/dsh-deepseek-web-official-plugin']);
  const extensions = {};
  for (const browser of ['chrome', 'edge', 'firefox']) {
    extensions[browser] = join(canonical, `build-${browser}`);
    await command(process.execPath, [join(source, 'scripts/package-harness-integration.mjs'), 'build-extension', '--source', source,
      '--output', extensions[browser], '--browser', browser]);
  }
  const candidate = join(canonical, 'components');
  const built = await packageOfficialPlugin({ source, output: candidate, extensions });
  await verifyOfficialPlugin({ candidate, expectedSha256: built.manifest_sha256 });
  const component = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
  const distribution = join(canonical, name);
  await mkdir(distribution);
  const files = [];
  async function put(path, bytes) {
    await mkdir(dirname(join(distribution, path)), { recursive: true });
    await writeFile(join(distribution, path), bytes, { flag: 'wx' });
    files.push({ path, sha256: hash(bytes) });
  }
  const images = new Set();
  for (const path of ['README.md', 'README_EN.md']) {
    const text = await readFile(join(source, path), 'utf8');
    for (const image of localImages(text)) images.add(image);
    // The checked-out README names the published release; local instructions name this archive.
    await put(path, text.replace(/deepseek-web-harness-\d{8}(?:-r\d+)?/g, name));
  }
  await put('LICENSE', await readFile(join(source, 'LICENSE')));
  if (options.instructions) await put('复测说明.md', await readSourceAsset(source, options.instructions));
  for (const path of [...images].sort()) await put(path, await readSourceAsset(source, path));
  for (const file of component.files.filter(file => /^(plugin|extensions|vendor)\//.test(file.path))) {
    const bytes = await readFile(join(candidate, file.path));
    if (hash(bytes) !== file.sha256) fail(`Component changed: ${file.path}`);
    await put(file.path, bytes);
  }
  await put('vendor/LICENSE', await readFile(join(source, 'vendor/harness-request-budget/LICENSE')));
  const manifest = { schema_version: 1, kind: 'portable-harness-distribution', distribution: name,
    source_commit: commit, extension_version: component.extension_version, harness_version: component.harness_version,
    node_major: 24, component_manifest_sha256: built.manifest_sha256,
    validation: { component_hashes: 'verified', real_web: 'not_run', publication: 'not_published' },
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)) };
  if (await command('git', ['rev-parse', 'HEAD'], false) !== commit
      || await command('git', ['status', '--porcelain', '--untracked-files=all'], false)) fail('Source changed while packaging');
  await put('manifest.json', json(manifest));
  await put('SHA256SUMS', files.map(file => `${file.sha256}  ${file.path}\n`).join(''));
  const require = createRequire(join(source, 'package.json'));
  const JSZip = createRequire(require.resolve('wxt'))('jszip');
  const zip = new JSZip();
  for (const file of files) zip.file(`${name}/${file.path}`, await readFile(join(distribution, file.path)));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const archive = join(canonical, `${name}.zip`);
  await writeFile(archive, bytes, { flag: 'wx' });
  await writeFile(`${archive}.sha256`, `${hash(bytes)}  ${name}.zip\n`, { flag: 'wx' });
  const roundtrip = await JSZip.loadAsync(await readFile(archive));
  if (Object.values(roundtrip.files).filter(file => !file.dir).length !== files.length) fail('Archive file count mismatch');
  for (const file of files) {
    if (hash(await roundtrip.file(`${name}/${file.path}`).async('nodebuffer')) !== file.sha256) fail(`Archive mismatch: ${file.path}`);
  }
  return { ok: true, source_commit: commit, archive, sha256: hash(bytes), files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await packageWebHarness(parseOptions(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
