// Offline probe of the user's existing Chrome bundle. No browser/profile access.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const bundlePath = process.argv[2];
if (!bundlePath) throw new Error('Pass the existing background.js path.');
const bundleBytes = readFileSync(bundlePath);
const expectedHash = '696d25b16a352cafdd2e6c2c4e4100cb2e2dbc999c3b568157ed014439453719';
if (createHash('sha256').update(bundleBytes).digest('hex') !== expectedHash) {
  throw new Error('BUNDLE_PROBE_ARTIFACT_HASH_MISMATCH');
}
const original = bundleBytes.toString('utf8');
const marker = 'Ft(),Ut();var fV=';
if (!original.includes(marker)) throw new Error('BUNDLE_PROBE_MARKER_CHANGED');
const instrumented = original.replace(marker,
  'return { adapterFactory: lN, activeClientFactory: AA, loadHeaders: XV, safePreparation: nP };' + marker);
const context = vm.createContext({
  probeMode: process.argv[3] ?? 'cached',
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  TextEncoder, TextDecoder, URL, URLSearchParams, Headers, Request, Response,
  AbortController, AbortSignal, DOMException, Blob, FormData,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  crypto: webcrypto,
  navigator: { userAgent: 'offline-bundle-fixture', language: 'en-US' },
  fetch() { throw new Error('OFFLINE_PROBE_NETWORK_FORBIDDEN'); },
  WebSocket: class { constructor() { throw new Error('OFFLINE_PROBE_SOCKET_FORBIDDEN'); } },
});
vm.runInContext(`
globalThis.chrome = {
  runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getManifest: () => ({ version: '1.14.0' }),
    getURL: (path) => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' + path,
    onMessage: { addListener() {}, removeListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener() {}, removeListener() {} } },
  tabs: { query: async () => [], sendMessage: async () => ({}) },
};
`, context);
try {
  vm.runInContext(instrumented, context, { timeout: 5000, filename: 'existing-background.js' });
} catch (error) {
  process.stdout.write(JSON.stringify({ phase: 'evaluate', name: error.name, message: error.message,
    stack: error.stack?.split('\n').slice(-5) }) + '\n');
  process.exitCode = 1;
}
if (!process.exitCode) {
  const result = await vm.runInContext(`(async () => {
    const calls = [];
    chrome.storage.local.get = async () => probeMode === 'missing' ? {} : ({deepseekCachedClientHeaders: {
      Authorization: 'Bearer fixture-only', 'X-App-Version': '2.0.0'
    }});
    const client = {
      createClientHeaders() { throw new Error('PAGE_HEADERS_FORBIDDEN'); },
      async createChatSession() { calls.push('create'); return 'fixture-chat'; },
      async createPowHeaders() { calls.push('pow'); return {'X-DS-PoW-Response': 'fixture'}; },
      async submitPromptStreaming(input, callbacks, context) {
        calls.push('submit'); context.onDispatch?.(); callbacks.onTextChunk?.('fixture-answer', 'fixture-answer');
        return { assistantText: 'fixture-answer', requestMessageId: 10, responseMessageId: 11, finished: true };
      },
      async readHistorySnapshot() { calls.push('history'); return {
        chatSessionId: 'fixture-chat', parentMessageId: 11, assistantMessageId: 11,
        assistantParentMessageId: 10, requestParentMessageId: null, messageCount: 2, verifiedAt: 1000
      }; },
      normalizeMessageId(value) { return typeof value === 'number' ? value : null; },
      buildSessionUrl(chat) { return 'https://chat.deepseek.com/a/chat/s/' + chat; },
    };
    if (probeMode === 'sync') client.createClientHeaders = background.activeClientFactory().createClientHeaders;
    const adapter = background.adapterFactory({client,
      ...(probeMode === 'sync' ? {} : {loadClientHeaders: ({signal}) => background.loadHeaders(undefined, signal)})
    });
    const request = {
      schema_version: 1, request_id: 'fixture-request', session_id: 'fixture-session',
      request_digest: 'a'.repeat(64), purpose: 'agent',
      model: {provider: 'deepseek-web', model_id: 'current-web-session'},
      input: {messages: [{role: 'user', content: [{type: 'text', text: 'Reply with fixture-answer'}]}]},
      tools: [], options: {thinking_enabled: false, search_enabled: false, model_type: 'default'}
    };
    try {
      const events = [];
      const terminal = await adapter.generate(request, {
        onAccepted(event) { events.push(event); }, onTextDelta(event) { events.push(event); }, onToolCall(event) { events.push(event); }
      });
      return {phase: 'generate', mode: probeMode, terminal, calls, events};
    } catch (error) {
      return {phase: 'generate', mode: probeMode, name: error.name, code: error.code, message: error.message,
        mapped: background.safePreparation(error), stack: error.stack?.split('\\n').slice(0,5), calls};
    }
  })()`, context, { timeout: 5000 });
  process.stdout.write(JSON.stringify(result) + '\n');
}
