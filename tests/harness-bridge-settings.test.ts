import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelTerminalEvent } from '../packages/web-model-protocol/src/index.ts';
import {
  HarnessBridgeCoordinator,
  type HarnessBridgeClientPort,
} from '../core/harness-bridge/coordinator';
import { DeepSeekTurnAdapterError } from '../core/harness-bridge/deepseek-turn-adapter';
import type { HarnessBridgeHostRequest } from '../core/harness-bridge/client';
import type { HarnessBridgeClientState } from '../core/harness-bridge/state';
import {
  DEFAULT_HARNESS_BRIDGE_PORT,
  HARNESS_BRIDGE_SETTINGS_STORAGE_KEY,
  HarnessBridgeSettingsError,
  createHarnessBridgeSettingsStore,
  decodeHarnessBridgeSettings,
  normalizeHarnessBridgeSettingsPatch,
  projectHarnessBridgeSettings,
  type HarnessBridgeSettings,
  type HarnessBridgeSettingsStorage,
} from '../core/harness-bridge/settings';
import type { WebModelTurnPort } from '../core/harness-bridge/model-turn-port';
import type { HarnessBridgeRecoveryIndex, HarnessBridgeRecoveryStorage } from '../core/harness-bridge/result-cache';
import { decodeHarnessBridgeStatusResult } from '../core/messaging/deepseek-runtime-contracts';

const TOKEN = 'A'.repeat(43);
const DIGEST = 'd'.repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe('Harness bridge browser-local settings', () => {
  it('defaults to disabled without an eager write and projects no secret fields', async () => {
    const fixture = storageFixture();
    const store = createHarnessBridgeSettingsStore(fixture.port);

    const settings = await store.read();

    expect(settings).toEqual({
      version: 2,
      enabled: false,
      port: DEFAULT_HARNESS_BRIDGE_PORT,
      minRequestIntervalMs: 5_000,
      pairingToken: null,
    });
    expect(fixture.set).not.toHaveBeenCalled();
    expect(projectHarnessBridgeSettings(settings)).toEqual({
      version: 2,
      enabled: false,
      port: DEFAULT_HARNESS_BRIDGE_PORT,
      minRequestIntervalMs: 5_000,
      pairingTokenConfigured: false,
    });
  });

  it.each([0, 1] as const)(
    'migrates v%s deterministically in memory and writes v2 only after an authorized update',
    async (version) => {
      const legacy = { version, enabled: false, port: 40_001, pairingToken: TOKEN };
      const fixture = storageFixture(legacy);
      const store = createHarnessBridgeSettingsStore(fixture.port);

      await expect(store.read()).resolves.toEqual({
        ...legacy,
        version: 2,
        minRequestIntervalMs: 5_000,
      });
      expect(fixture.set).not.toHaveBeenCalled();
      await store.update({ enabled: true, port: 40_001, minRequestIntervalMs: 9_000 });

      expect(fixture.raw()).toEqual({
        version: 2,
        enabled: true,
        port: 40_001,
        minRequestIntervalMs: 9_000,
        pairingToken: TOKEN,
      });
    },
  );

  it.each([
    ['corrupt', { version: 2, enabled: false, port: 43_123, minRequestIntervalMs: 5_000, pairingToken: null, extra: true }, 'harness_bridge_settings_corrupt'],
    ['future', { version: 3, enabled: false, port: 43_123, minRequestIntervalMs: 5_000, pairingToken: null }, 'harness_bridge_settings_future_version'],
  ])('rejects %s persisted data without overwriting it', async (_name, raw, code) => {
    const fixture = storageFixture(raw);
    const store = createHarnessBridgeSettingsStore(fixture.port);

    await expect(store.read()).rejects.toMatchObject({ name: HarnessBridgeSettingsError.name, code });
    await expect(store.update({ enabled: false, port: 43_123, minRequestIntervalMs: 5_000 }))
      .rejects.toMatchObject({ code });
    expect(fixture.set).not.toHaveBeenCalled();
    expect(fixture.raw()).toBe(raw);
  });

  it('requires the protocol token shape before enabling and serializes concurrent updates', async () => {
    const fixture = storageFixture();
    const store = createHarnessBridgeSettingsStore(fixture.port);
    await expect(store.update({ enabled: true, port: 43_123, minRequestIntervalMs: 5_000 }))
      .rejects.toMatchObject({ code: 'harness_bridge_pairing_token_required' });
    await expect(store.update({ enabled: false, port: 43_123, minRequestIntervalMs: 5_000, pairingToken: 'short' }))
      .rejects.toMatchObject({ code: 'harness_bridge_settings_corrupt' });

    await Promise.all([
      store.update({ enabled: false, port: 43_124, minRequestIntervalMs: 8_000, pairingToken: TOKEN }),
      store.update({ enabled: true, port: 43_125, minRequestIntervalMs: 12_000 }),
    ]);
    expect(fixture.raw()).toEqual({
      version: 2,
      enabled: true,
      port: 43_125,
      minRequestIntervalMs: 12_000,
      pairingToken: TOKEN,
    });
  });

  it('strictly rejects unknown patch fields, invalid ports, and invalid minimum intervals', () => {
    expect(() => decodeHarnessBridgeSettings({
      version: 2,
      enabled: false,
      port: 0,
      minRequestIntervalMs: 5_000,
      pairingToken: null,
    })).toThrowError(HarnessBridgeSettingsError);
    expect(() => decodeHarnessBridgeSettings({
      version: 2,
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 4_999,
      pairingToken: null,
    })).toThrowError(HarnessBridgeSettingsError);
    expect(() => decodeHarnessBridgeSettings({
      version: 2,
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 30_001,
      pairingToken: null,
    })).toThrowError(HarnessBridgeSettingsError);
    expect(normalizeHarnessBridgeSettingsPatch({ enabled: false, port: 43_123 })).toEqual({
      enabled: false,
      port: 43_123,
    });
    expect(() => normalizeHarnessBridgeSettingsPatch({
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 5_000.5,
    })).toThrowError(HarnessBridgeSettingsError);
    expect(() => normalizeHarnessBridgeSettingsPatch({
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 5_000,
      host: 'localhost',
    })).toThrowError(HarnessBridgeSettingsError);
  });

  it('preserves the current minimum interval when a compatible patch omits it', async () => {
    const fixture = storageFixture({
      version: 2,
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 13_000,
      pairingToken: TOKEN,
    });
    const store = createHarnessBridgeSettingsStore(fixture.port);

    await store.update({ enabled: true, port: 43_124 });

    expect(fixture.raw()).toEqual({
      version: 2,
      enabled: true,
      port: 43_124,
      minRequestIntervalMs: 13_000,
      pairingToken: TOKEN,
    });
  });

  it('uses browser local storage only', async () => {
    const local = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };
    const sync = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };
    vi.stubGlobal('chrome', { storage: { local, sync } });

    const store = createHarnessBridgeSettingsStore();
    await store.update({
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 5_000,
      pairingToken: TOKEN,
    });

    expect(local.get).toHaveBeenCalledWith(HARNESS_BRIDGE_SETTINGS_STORAGE_KEY);
    expect(local.set).toHaveBeenCalledOnce();
    expect(sync.get).not.toHaveBeenCalled();
    expect(sync.set).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field', { ...safeStatus(), token: TOKEN }],
    ['invalid phase', { ...safeStatus(), state: { phase: 'secret_phase', attempt: 0 } }],
    ['invalid port', { ...safeStatus(), settings: { ...safeStatus().settings, port: 0 } }],
    ['missing minimum interval', {
      ...safeStatus(),
      settings: {
        version: 2,
        enabled: false,
        port: 43_123,
        pairingTokenConfigured: false,
      },
    }],
    ['invalid minimum interval', {
      ...safeStatus(),
      settings: { ...safeStatus().settings, minRequestIntervalMs: 30_001 },
    }],
    ['raw capabilities', { ...safeStatus(), state: { ...safeStatus().state, capabilities: { reasoning: true } } }],
  ])('strictly rejects an unsafe status DTO: %s', (_name, value) => {
    expect(() => decodeHarnessBridgeStatusResult(value))
      .toThrow('Invalid Harness bridge status response.');
  });
});

describe('Harness bridge background coordinator', () => {
  it.each([
    ['offline', 'RETRY_EXHAUSTED', 1],
    ['offline', undefined, 0],
    ['retry_wait', 'CONNECTION_FAILED', 0],
    ['connecting', undefined, 0],
    ['authenticating', undefined, 0],
    ['ready', undefined, 0],
    ['needs_pairing', 'PAIRING_REJECTED', 0],
    ['protocol_error', 'PROTOCOL_ERROR', 0],
    ['handler_error', 'HANDLER_FAILED', 0],
    ['stopped', undefined, 0],
  ] as const)('automatic wake only reconnects exhausted network retries: %s/%s', async (phase, errorCode, calls) => {
    const client = new FakeClient();
    const turnPort = fakeTurnPort();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort,
      createClient: () => client,
    });
    await coordinator.initialize();
    client.transition({ phase, attempt: 6, ...(errorCode ? { errorCode } : {}) });
    client.reconnect.mockImplementation(() => client.transition({ phase: 'connecting', attempt: 1 }));
    await Promise.all([coordinator.reconnectOffline(), coordinator.reconnectOffline()]);
    expect(client.reconnect).toHaveBeenCalledTimes(calls);
    expect(turnPort.generate).not.toHaveBeenCalled();
    coordinator.stop();
    await coordinator.reconnectOffline();
    expect(client.reconnect).toHaveBeenCalledTimes(calls);
  });

  it('serializes configuration disable with an automatic reconnect wake', async () => {
    const client = new FakeClient();
    const fixture = storageFixture({ version: 1, enabled: true, port: 43_123, pairingToken: TOKEN });
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: createHarnessBridgeSettingsStore(fixture.port),
      turnPort: fakeTurnPort(),
      createClient: () => client,
    });
    await coordinator.initialize();
    client.transition({ phase: 'offline', attempt: 6, errorCode: 'RETRY_EXHAUSTED' });
    await Promise.all([
      coordinator.updateSettings({ enabled: false, port: 43_123 }),
      coordinator.reconnectOffline(),
    ]);
    expect(client.reconnect).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each([
    'DEEPSEEK_AUTH_REQUIRED',
    'DEEPSEEK_PREPARATION_FAILED',
  ] as const)('forwards only the safe pre-dispatch adapter code %s', async (code) => {
    const client = new FakeClient();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort: fakeTurnPort({
        generate: vi.fn(async () => { throw new DeepSeekTurnAdapterError(code, true); }),
      }),
      createClient: () => client,
    });
    await coordinator.initialize();
    client.ready();
    client.receive(generateFrame());
    await flush();

    expect(client.sent.at(-1)).toMatchObject({
      error: {
        message: 'Web model request was not started.',
        data: { error_code: code, external_outcome: 'not_started' },
      },
    });
  });

  it('maps an unknown pre-dispatch exception without exposing its message', async () => {
    const client = new FakeClient();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort: fakeTurnPort({
        generate: vi.fn(async () => { throw new Error('secret upstream auth response'); }),
      }),
      createClient: () => client,
    });
    await coordinator.initialize();
    client.ready();
    client.receive(generateFrame());
    await flush();

    expect(client.sent.at(-1)).toMatchObject({
      error: { data: { error_code: 'MODEL_PREPARATION_FAILED' } },
    });
    expect(JSON.stringify(client.sent)).not.toContain('secret upstream auth response');
  });

  it('shares startup initialization, hides credentials, and does not recreate a client for a retried update', async () => {
    const readGate = deferred<HarnessBridgeSettings>();
    const settings = enabledSettings();
    const store = {
      read: vi.fn(() => readGate.promise),
      update: vi.fn(async () => settings),
    };
    const clients: FakeClient[] = [];
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: store,
      turnPort: fakeTurnPort(),
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });

    const first = coordinator.getStatus();
    const second = coordinator.getStatus();
    await Promise.resolve();
    expect(store.read).toHaveBeenCalledOnce();
    readGate.resolve(settings);
    await expect(first).resolves.toMatchObject({ ok: true, settings: { pairingTokenConfigured: true } });
    await second;
    await coordinator.updateSettings({ enabled: true, port: settings.port });
    await coordinator.updateSettings({ enabled: true, port: settings.port });

    expect(clients).toHaveLength(1);
    const serialized = JSON.stringify(await coordinator.getStatus());
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('browserInstanceId');
    expect(serialized).not.toContain('capabilities');
  });

  it('does not poison a valid status when an update is rejected', async () => {
    const fixture = storageFixture();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: createHarnessBridgeSettingsStore(fixture.port),
      turnPort: fakeTurnPort(),
      createClient: () => new FakeClient(),
    });

    await expect(coordinator.updateSettings({ enabled: true, port: 43_123 }))
      .resolves.toEqual({ ok: false, error: 'harness_bridge_pairing_token_required' });
    await expect(coordinator.getStatus()).resolves.toMatchObject({
      ok: true,
      settings: { enabled: false },
      state: { phase: 'stopped' },
    });
  });

  it('aborts an active turn on disable, waits for its authoritative terminal, and hydrates it after re-enable', async () => {
    const fixture = storageFixture({ version: 1, enabled: true, port: 43_123, pairingToken: TOKEN });
    const completion = deferred<ModelTerminalEvent>();
    let signal: AbortSignal | undefined;
    const turnPort = fakeTurnPort({
      generate: vi.fn(async (_request, callbacks, context) => {
        signal = context?.signal;
        callbacks.onAccepted({ request_id: 'request-1', request_digest: DIGEST, status: 'accepted' });
        return completion.promise;
      }),
    });
    const clients: FakeClient[] = [];
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: createHarnessBridgeSettingsStore(fixture.port),
      turnPort,
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    await coordinator.initialize();
    clients[0]!.ready();
    clients[0]!.receive(generateFrame());
    await flush();

    await coordinator.updateSettings({ enabled: false, port: 43_123 });
    expect(signal?.aborted).toBe(true);
    clients[0]!.receive(generateFrame('rpc-2', 'request-2'));
    expect(turnPort.generate).toHaveBeenCalledOnce();
    completion.resolve({ type: 'ambiguous', reason: 'deepseek_turn_outcome_unknown' });
    await flush();

    await coordinator.updateSettings({ enabled: true, port: 43_123 });
    clients[1]!.ready();
    await flush();
    expect(clients[1]!.hydrated).toEqual([{
      request_id: 'request-1',
      request_digest: DIGEST,
      status: 'ambiguous',
      last_sequence: 1,
      terminal: { type: 'ambiguous', reason: 'deepseek_turn_outcome_unknown' },
    }]);
    clients[1]!.receive(queryFrame());
    await flush();
    expect(clients[1]!.sent.at(-1)).toMatchObject({
      result: { type: 'model.status', status: 'ambiguous', last_sequence: 1 },
    });
  });

  it('enforces one in-flight turn and distinguishes duplicate identity mismatches', async () => {
    const completion = deferred<ModelTerminalEvent>();
    const turnPort = fakeTurnPort({
      generate: vi.fn(async (_request, callbacks) => {
        callbacks.onAccepted({ request_id: 'request-1', request_digest: DIGEST, status: 'accepted' });
        return completion.promise;
      }),
    });
    const client = new FakeClient();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort,
      createClient: () => client,
    });
    await coordinator.initialize();
    client.ready();
    client.receive(generateFrame());
    await flush();
    client.receive(generateFrame('rpc-2', 'request-2'));
    await flush();
    expect(client.sent.at(-1)).toMatchObject({ error: { data: { error_code: 'BROKER_BUSY' } } });
    completion.resolve({ type: 'completed', finish_reason: 'stop' });
    await flush();
    client.receive(generateFrame('rpc-3', 'request-1', 'e'.repeat(64)));
    await flush();
    expect(client.sent.at(-1)).toMatchObject({ error: { data: { error_code: 'REQUEST_IDENTITY_MISMATCH' } } });
  });

  it.each([
    'offline',
    'stopped',
    'needs_pairing',
    'protocol_error',
    'handler_error',
  ] as const)('reconnects an unchanged enabled authority from %s without replacing its client', async (phase) => {
    const client = new FakeClient();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort: fakeTurnPort(),
      createClient: () => client,
    });
    await coordinator.initialize();
    client.transition({ phase, attempt: 1 });

    await coordinator.updateSettings({ enabled: true, port: 43_123 });

    expect(client.reconnect).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it.each([
    'connecting',
    'authenticating',
    'ready',
    'retry_wait',
  ] as const)('leaves an unchanged enabled authority in %s alone', async (phase) => {
    const client = new FakeClient();
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: fixedSettingsStore(enabledSettings()),
      turnPort: fakeTurnPort(),
      createClient: () => client,
    });
    await coordinator.initialize();
    client.transition({ phase, attempt: phase === 'ready' ? 0 : 1 });

    await coordinator.updateSettings({ enabled: true, port: 43_123 });

    expect(client.reconnect).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it('isolates records on port or token authority change and never imports an old active terminal', async () => {
    const completion = deferred<ModelTerminalEvent>();
    const turnPort = fakeTurnPort({
      generate: vi.fn(async (_request, callbacks, context) => {
        callbacks.onAccepted({ request_id: 'request-1', request_digest: DIGEST, status: 'accepted' });
        await new Promise<void>((resolve) => {
          context?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return completion.promise;
      }),
    });
    const firstSettings = enabledSettings();
    let stored = firstSettings;
    const store = {
      read: vi.fn(async () => stored),
      update: vi.fn(async (patch: { enabled: boolean; port: number; minRequestIntervalMs?: number; pairingToken?: string }) => {
        stored = {
          version: 2,
          enabled: patch.enabled,
          port: patch.port,
          minRequestIntervalMs: patch.minRequestIntervalMs ?? stored.minRequestIntervalMs,
          pairingToken: patch.pairingToken ?? stored.pairingToken,
        };
        return stored;
      }),
    };
    const clients: FakeClient[] = [];
    const coordinator = new HarnessBridgeCoordinator({
      recoveryStorage: recoveryStorage(),
      settings: store,
      turnPort,
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    await coordinator.initialize();
    clients[0]!.ready();
    clients[0]!.receive(generateFrame());
    await flush();

    await coordinator.updateSettings({ enabled: true, port: 44_001, pairingToken: 'g'.repeat(43) });
    clients[1]!.ready();
    completion.resolve({ type: 'ambiguous', reason: 'old_authority_outcome' });
    await flush();
    clients[1]!.receive(queryFrame());
    await flush();

    expect(clients[1]!.hydrated).toEqual([]);
    expect(clients[1]!.sent.at(-1)).toMatchObject({
      result: { type: 'model.status', status: 'unknown', last_sequence: 0 },
    });
  });
});

class FakeClient implements HarnessBridgeClientPort {
  state: HarnessBridgeClientState = { phase: 'offline', attempt: 0 };
  readonly sent: any[] = [];
  readonly hydrated: any[] = [];
  readonly stop = vi.fn(() => { this.state = { phase: 'stopped', attempt: 0 }; });
  readonly reconnect = vi.fn();
  private stateListener: ((state: HarnessBridgeClientState) => void) | undefined;
  private requestListener: ((request: HarnessBridgeHostRequest) => void) | undefined;

  start(): void { this.state = { phase: 'connecting', attempt: 1 }; }
  send(frame: unknown): void { this.sent.push(structuredClone(frame)); }
  hydrateRequestCheckpoint(checkpoint: any): void { this.hydrated.push(structuredClone(checkpoint)); }
  subscribe(listener: (state: HarnessBridgeClientState) => void): () => void {
    this.stateListener = listener;
    listener(this.state);
    return () => { this.stateListener = undefined; };
  }
  subscribeRequests(listener: (request: HarnessBridgeHostRequest) => void): () => void {
    this.requestListener = listener;
    return () => { this.requestListener = undefined; };
  }
  ready(): void {
    this.state = {
      phase: 'ready',
      attempt: 0,
      capabilities: { text: true, structured_tool_calls: true, usage: true, cancel: true, query: true },
    };
    this.stateListener?.(this.state);
  }
  transition(state: HarnessBridgeClientState): void {
    this.state = state;
    this.stateListener?.(state);
  }
  receive(request: HarnessBridgeHostRequest): void { this.requestListener?.(request); }
}

function enabledSettings(): HarnessBridgeSettings {
  return {
    version: 2,
    enabled: true,
    port: 43_123,
    minRequestIntervalMs: 5_000,
    pairingToken: TOKEN,
  };
}

function safeStatus() {
  return {
    ok: true as const,
    settings: {
      version: 2 as const,
      enabled: false,
      port: 43_123,
      minRequestIntervalMs: 5_000,
      pairingTokenConfigured: false,
    },
    state: { phase: 'stopped' as const, attempt: 0 },
  };
}

function fixedSettingsStore(settings: HarnessBridgeSettings) {
  return {
    read: vi.fn(async () => settings),
    update: vi.fn(async () => settings),
  };
}

function fakeTurnPort(overrides: Partial<WebModelTurnPort> = {}): WebModelTurnPort {
  return {
    generate: vi.fn(async () => ({ type: 'completed', finish_reason: 'stop' } as const)),
    cancel: vi.fn((request: any) => ({
      request_id: request.request_id,
      request_digest: request.request_digest,
      status: 'not_found' as const,
    })),
    ...overrides,
  };
}

function generateFrame(id = 'rpc-1', requestId = 'request-1', digest = DIGEST): HarnessBridgeHostRequest {
  return {
    jsonrpc: '2.0', id, method: 'model.generate', params: {
      schema_version: 1, request_id: requestId, session_id: 'session-1', request_digest: digest,
      purpose: 'agent', model: { provider: 'deepseek-web', model_id: 'current-web-session' },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] },
      tools: [], options: { thinking_enabled: false, search_enabled: false, model_type: 'default' },
    },
  };
}

function queryFrame(): HarnessBridgeHostRequest {
  return {
    jsonrpc: '2.0', id: 'query-1', method: 'model.query',
    params: { schema_version: 1, request_id: 'request-1', request_digest: DIGEST },
  };
}

function storageFixture(initial?: unknown) {
  let value = initial;
  const set = vi.fn(async (values: Record<string, unknown>) => {
    value = values[HARNESS_BRIDGE_SETTINGS_STORAGE_KEY];
  });
  const port: HarnessBridgeSettingsStorage = {
    get: vi.fn(async () => ({ [HARNESS_BRIDGE_SETTINGS_STORAGE_KEY]: value })),
    set,
  };
  return { port, set, raw: () => value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function recoveryStorage(): HarnessBridgeRecoveryStorage {
  vi.stubGlobal('crypto', webcrypto);
  let index: HarnessBridgeRecoveryIndex | undefined;
  return {
    read: async () => structuredClone(index),
    write: async (value) => { index = structuredClone(value); },
  };
}
