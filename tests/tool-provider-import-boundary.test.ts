import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  getModuleSpecifiers,
  parseTypeScriptSource,
  walkSourceAst,
} from './helpers/typescript-source';

const ROOT = process.cwd();
const CORE_ROOT = resolve(ROOT, 'core');
const TARGET_PREFIXES = ['core/tool/', 'core/mcp/'];
const TARGET_FILES = new Set(['core/constants.ts', 'core/types.ts']);
// Include new, uncommitted source too, but never walk ignored installation
// archives or follow their dependency junctions outside the active checkout.
const SOURCE_FILES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.ts', '*.tsx'], {
  cwd: ROOT, encoding: 'utf8',
}).split('\0').filter(Boolean).map((file) => normalize(resolve(ROOT, file))).sort();

describe('tool provider import boundary', () => {
  it('keeps registry and runtime independent from concrete providers', () => {
    expect(relativeImports('core/tool/provider-registry.ts').sort()).toEqual([
      '../i18n',
      './types',
    ]);
    expect(relativeImports('core/tool/runtime.ts').sort()).toEqual([
      '../diagnostics/log-buffer',
      '../i18n/background',
      '../messaging/tool-record-codec',
      './authorization',
      './execution-error',
      './externalized-payload',
      './history',
      './local-skill-cwd',
      './provider-registry',
      './types',
    ]);
  });

  it('has no static SCC in the migrated tool/MCP contract slice', () => {
    const files = listSourceFiles(CORE_ROOT);
    const graph = new Map(files.map((file) => [file, resolveImports(file, files)]));
    const cycles = stronglyConnectedComponents(graph)
      .filter((component) => component.length > 1 || graph.get(component[0])?.has(component[0]))
      .filter((component) => component.some((file) => {
        const relative = toRelative(file);
        return TARGET_FILES.has(relative) || TARGET_PREFIXES.some((prefix) => relative.startsWith(prefix));
      }))
      .map((component) => component.map(toRelative).sort());

    expect(cycles).toEqual([]);
  });

  it('keeps the only production registration array in Background composition', () => {
    const productionFiles = listSourceFiles(ROOT)
      .filter((file) => !toRelative(file).startsWith('tests/'));
    const owners = productionFiles
      .filter((file) => registryConstructionShape(file).count > 0)
      .map(toRelative);

    expect(owners).toEqual(['entrypoints/background/tool-provider-composition.ts']);
    expect(registryConstructionShape(resolve(
      ROOT,
      'entrypoints/background/tool-provider-composition.ts',
    ))).toEqual({ count: 1, inlineProviderArrays: 1 });
    expect(relativeImports('entrypoints/background.ts')).toContain('./background/tool-provider-composition');
  });

  it('keeps content descriptor synchronization strict and fail-closed', () => {
    const source = readFileSync(resolve(ROOT, 'entrypoints/content.ts'), 'utf8');

    expect(source).toMatch(/import\s*\{[\s\S]*?isToolDescriptorRecord[\s\S]*?\}\s*from ['"]\.\.\/core\/messaging\/tool-record-codec['"];/);
    expect(source).toMatch(/sendRuntimeMessageStrict<ToolDescriptor\[\]>\(\{\s*type:\s*['"]GET_TOOL_DESCRIPTORS['"],?\s*\}\)/);
    expect(source).toContain('tool descriptor sync failed; tool execution disabled');
    expect(source).toContain('let currentToolDescriptors: ToolDescriptor[] = [];');
    expect(source).toContain('const toolDescriptorSyncGate = createLatestSyncGate();');
    expect(source).toMatch(/const runtimeStateSync = Promise\.all\([\s\S]*?currentToolDescriptors,[\s\S]*?const descriptorSync = descriptorResultPromise\.then/);
    expect(source).toContain('await Promise.all([runtimeStateSync, descriptorSync]);');
    expect(source).toMatch(/syncLease\.commit\(\(\) =>\s*syncToMainWorld\(/);
    expect(source).toContain('syncRuntimeState: syncCurrentRuntimeStateToMainWorld,');
    expect(source).toContain('const fallbackPromptDescriptors = toolDescriptors.filter(');
    expect(source).toContain('(descriptor) => !isMcpCapabilityDescriptor(descriptor)');
    expect(source).toContain('toolDescriptors: fallbackPromptDescriptors,');
    expect(source).not.toContain('normalizeToolDescriptors');

    const hookSource = readFileSync(resolve(ROOT, 'core/interceptor/fetch-hook.ts'), 'utf8');
    const mainWorldSource = readFileSync(resolve(ROOT, 'entrypoints/main-world.content.ts'), 'utf8');
    const bridgeSource = readFileSync(resolve(
      ROOT,
      'entrypoints/content/controllers/isolated-bridge-controller.ts',
    ), 'utf8');
    expect(hookSource).toContain('toolDescriptors: [],');
    expect(hookSource).not.toContain('DEFAULT_TOOL_DESCRIPTORS');
    expect(mainWorldSource).toContain('updateHookState({ toolDescriptors: [] });');
    expect(bridgeSource).toContain('dependencies.syncRuntimeState();');
  });
});

function registryConstructionShape(file: string): { count: number; inlineProviderArrays: number } {
  const source = readFileSync(file, 'utf8');
  const program = parseTypeScriptSource(file, source);
  const localNames = new Set<string>();
  for (const node of program.body) {
    if (!t.isImportDeclaration(node)) continue;
    for (const specifier of node.specifiers) {
      if (!t.isImportSpecifier(specifier)) continue;
      const imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
      if (imported === 'ToolProviderRegistry') {
        localNames.add(specifier.local.name);
      }
    }
  }
  let count = 0;
  let inlineProviderArrays = 0;
  walkSourceAst(program, (node) => {
    if (
      t.isNewExpression(node)
      && t.isIdentifier(node.callee)
      && localNames.has(node.callee.name)
    ) {
      count += 1;
      if (node.arguments.length === 1 && t.isArrayExpression(node.arguments[0])) {
        inlineProviderArrays += 1;
      }
    }
  });
  return { count, inlineProviderArrays };
}

function relativeImports(path: string): string[] {
  return parseModuleSpecifiers(resolve(ROOT, path)).filter((specifier) => specifier.startsWith('.'));
}

function resolveImports(file: string, files: readonly string[]): Set<string> {
  const fileSet = new Set(files);
  const result = new Set<string>();
  for (const specifier of parseModuleSpecifiers(file)) {
    if (!specifier.startsWith('.')) continue;
    const candidate = resolve(dirname(file), specifier);
    const resolved = [
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      join(candidate, 'index.ts'),
      join(candidate, 'index.tsx'),
    ].find((item) => fileSet.has(normalize(item)));
    if (resolved) result.add(normalize(resolved));
  }
  return result;
}

function parseModuleSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return getModuleSpecifiers(parseTypeScriptSource(file, source));
}

function listSourceFiles(root: string): string[] {
  return SOURCE_FILES.filter((file) => file.startsWith(`${normalize(root)}${sep}`));
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

function toRelative(path: string): string {
  const normalizedRoot = normalize(ROOT).replace(/\\/g, '/');
  return normalize(path).replace(/\\/g, '/').slice(`${normalizedRoot}/`.length);
}
