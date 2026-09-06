import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { copyHostRuntime } from '../packages/shell-host/lib/installer.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { REQUIRED_HOST_RUNTIME_FILES, getMissingHostRuntimeFiles } from '../packages/shell-host/lib/host-files.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createNativeMessageChannel, NATIVE_EOF } from '../packages/shell-host/native/framing.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createToolRegistry } from '../packages/shell-host/native/router.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createNativeEnvelopeDispatcher } from '../packages/shell-host/native/runtime-dispatcher.mjs';

const tempRoots: string[] = [];
const shellPackage = readJson(resolve('packages/shell-host/package.json'));

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Shell Host modular runtime ownership', () => {
  it('decodes fragmented and queued Native frames in order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const channel = createNativeMessageChannel({
      input,
      output,
      logLine: (message: unknown) => logs.push(String(message)),
      onInvalidFrame: () => { throw new Error('unexpected invalid frame'); },
    });
    const first = { sequence: 1, text: '分片' };
    const second = { sequence: 2, text: 'queued' };
    const firstFrame = createNativeFrame(first);
    const secondFrame = createNativeFrame(second);

    const firstRead = channel.readMessage();
    input.write(firstFrame.subarray(0, 2));
    input.write(firstFrame.subarray(2, 7));
    input.end(Buffer.concat([firstFrame.subarray(7), secondFrame]));

    await expect(firstRead).resolves.toEqual(first);
    await expect(channel.readMessage()).resolves.toEqual(second);
    await expect(channel.readMessage()).resolves.toBe(NATIVE_EOF);
    expect(logs).toEqual([]);
  });

  it('rejects duplicate, missing, and undeclared tool registrations', () => {
    const definitions = [{ name: 'one' }, { name: 'two' }];
    const handler = () => ({ content: [] });

    expect(() => createToolRegistry(definitions, [[{ name: 'one', handle: handler }]]))
      .toThrow('Shell tool handlers missing: two');
    expect(() => createToolRegistry(definitions, [[
      { name: 'one', handle: handler },
      { name: 'one', handle: handler },
      { name: 'two', handle: handler },
    ]])).toThrow('Shell tool handler registered more than once: one');
    expect(() => createToolRegistry(definitions, [[
      { name: 'one', handle: handler },
      { name: 'two', handle: handler },
      { name: 'future', handle: handler },
    ]])).toThrow('Shell tool handler is not declared in the catalog: future');
  });

  it('copies the complete modular runtime and executes the installed entrypoint', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'deepseek-pp-shell-runtime-'));
    tempRoots.push(installDir);
    const hostPath = copyHostRuntime(resolve('packages/shell-host/native'), installDir);

    expect(getMissingHostRuntimeFiles(installDir)).toEqual([]);
    for (const moduleName of REQUIRED_HOST_RUNTIME_FILES) {
      expect(existsSync(join(installDir, moduleName)), moduleName).toBe(true);
    }

    await expect(callHost(hostPath, {
      protocol: 'deepseek-pp-mcp-native',
      version: 1,
      server: { id: 'installed-runtime' },
      message: {
        jsonrpc: '2.0',
        id: 'initialize',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'initialize',
      result: { serverInfo: { name: 'deepseek-pp-shell', version: shellPackage.version } },
    });

    rmSync(join(installDir, 'router.mjs'));
    expect(getMissingHostRuntimeFiles(installDir)).toEqual(['router.mjs']);
  });

  it('reads package metadata from an installed npm package layout', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'deepseek-pp-shell-npm-layout-'));
    tempRoots.push(tempRoot);
    const packDir = tempRoot;
    const installDir = join(tempRoot, 'installed');
    const npmCli = [
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ].find(path => existsSync(path));
    if (npmCli === undefined) throw new Error('This fixture requires npm installed alongside the current Node executable.');
    // Node 24 cannot execFile an npm.cmd batch shim on Windows without a shell.
    // Use the installed JavaScript entry directly on both Windows and Unix.
    const packOutput = execFileSync(process.execPath, [
      npmCli,
      'pack',
      '--offline',
      '--json',
      '--pack-destination',
      packDir,
    ], {
      cwd: resolve('packages/shell-host'),
      encoding: 'utf8',
    });
    // npm versions emit either an array or a package-name keyed record.
    const packed = JSON.parse(packOutput);
    const entries = Array.isArray(packed) ? packed : Object.values(packed);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: shellPackage.name,
      version: shellPackage.version,
      filename: `${shellPackage.name}-${shellPackage.version}.tgz`,
    });
    const { filename } = entries[0] as { filename: string };
    const tarball = resolve(packDir, filename);
    execFileSync(process.execPath, [
      npmCli,
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--prefix',
      installDir,
      tarball,
    ], { stdio: 'pipe' });

    const installedRoot = join(installDir, 'node_modules', shellPackage.name);
    const installedPackage = readJson(join(installedRoot, 'package.json'));
    const hostPath = join(installedRoot, 'native', 'shell-mcp-host.mjs');
    expect(existsSync(hostPath)).toBe(true);

    await expect(callHost(hostPath, {
      protocol: 'deepseek-pp-mcp-native',
      version: 1,
      server: { id: 'npm-layout' },
      message: {
        jsonrpc: '2.0',
        id: 'initialize',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'initialize',
      result: { serverInfo: { name: 'deepseek-pp-shell', version: installedPackage.version } },
    });
  });

  it('preserves the explicit shell timeout result through the process provider', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5';
    const response = await callHost(resolve('packages/shell-host/native/shell-mcp-host.mjs'), {
      protocol: 'deepseek-pp-mcp-native',
      version: 1,
      server: { id: 'timeout-runtime' },
      message: {
        jsonrpc: '2.0',
        id: 'timeout',
        method: 'tools/call',
        params: { name: 'shell_exec', arguments: { command, timeout_ms: 1_000 } },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'timeout',
      result: {
        isError: true,
        structuredContent: { ok: false, data: { exitCode: -1, timedOut: true } },
      },
    });
  });

  it('serves control requests while a long tool call remains in the tool FIFO', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Milliseconds 1200' : 'sleep 1.2';
    const responses = await callHostResponses(resolve('packages/shell-host/native/shell-mcp-host.mjs'), [
      {
        protocol: 'deepseek-pp-mcp-native',
        version: 1,
        server: { id: 'concurrent-runtime' },
        message: {
          jsonrpc: '2.0',
          id: 'slow',
          method: 'tools/call',
          params: { name: 'shell_exec', arguments: { command, timeout_ms: 3_000 } },
        },
      },
      {
        protocol: 'deepseek-pp-mcp-native',
        version: 1,
        server: { id: 'concurrent-runtime' },
        message: { jsonrpc: '2.0', id: 'tools', method: 'tools/list' },
      },
    ]);

    expect(responses.map((response) => response.id)).toEqual(['tools', 'slow']);
  });

  it('serves control requests while tool calls wait for host environment readiness', async () => {
    const environmentReady = deferred<void>();
    const handled: string[] = [];
    const responses: Array<{ id: string }> = [];
    const dispatcher = createNativeEnvelopeDispatcher({
      hostEnvironmentReady: environmentReady.promise,
      logger: { logLine: vi.fn() },
      router: {
        async handleEnvelope(envelope: { message: { id: string } }) {
          handled.push(envelope.message.id);
          return { id: envelope.message.id };
        },
      },
      channel: {
        async writeMessage(response: { id: string }) {
          responses.push(response);
        },
      },
    });

    dispatcher.scheduleEnvelope(createHostEnvelope('tool-1', 'tools/call'));
    dispatcher.scheduleEnvelope(createHostEnvelope('tool-2', 'tools/call'));
    dispatcher.scheduleEnvelope(createHostEnvelope('control', 'tools/list'));

    await vi.waitFor(() => expect(responses).toEqual([{ id: 'control' }]));
    expect(handled).toEqual(['control']);

    environmentReady.resolve();
    await dispatcher.settle();

    expect(handled).toEqual(['control', 'tool-1', 'tool-2']);
    expect(responses).toEqual([
      { id: 'control' },
      { id: 'tool-1' },
      { id: 'tool-2' },
    ]);
  });
});

function createHostEnvelope(id: string, method: string) {
  return {
    protocol: 'deepseek-pp-mcp-native',
    version: 1,
    server: { id: 'readiness-runtime' },
    message: { jsonrpc: '2.0', id, method },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function callHost(hostPath: string, envelope: unknown): Promise<any> {
  const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolveResponse, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Installed Shell Host timed out. stderr: ${stderr}`));
    }, 5_000);

    const finish = (callback: () => void) => {
      clearTimeout(timer);
      child.kill();
      callback();
    };
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => finish(() => reject(error)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length < 4) return;
      const length = stdout.readUInt32LE(0);
      if (stdout.length < length + 4) return;
      finish(() => {
        try {
          resolveResponse(JSON.parse(stdout.subarray(4, length + 4).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.end(createNativeFrame(envelope));
  });
}

function callHostResponses(hostPath: string, envelopes: unknown[]): Promise<any[]> {
  const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolveResponses, reject) => {
    let stdout = Buffer.alloc(0);
    const responses: any[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for concurrent Shell Host responses.'));
    }, 5_000);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      child.kill();
      callback();
    };
    child.on('error', (error) => finish(() => reject(error)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      while (stdout.length >= 4) {
        const length = stdout.readUInt32LE(0);
        if (stdout.length < length + 4) return;
        const body = stdout.subarray(4, length + 4).toString('utf8');
        stdout = stdout.subarray(length + 4);
        responses.push(JSON.parse(body));
        if (responses.length === envelopes.length) {
          finish(() => resolveResponses(responses));
          return;
        }
      }
    });
    child.stdin.end(Buffer.concat(envelopes.map(createNativeFrame)));
  });
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}
