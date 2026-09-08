import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HarnessBridgeCoordinator, type HarnessBridgeClientPort } from '../core/harness-bridge/coordinator';
import { DeepSeekTurnAdapterError, WEB_MODEL_TURN_BUDGETS } from '../core/harness-bridge/deepseek-turn-adapter';
import type { HarnessBridgeHostRequest } from '../core/harness-bridge/client';
import type { HarnessBridgeClientState } from '../core/harness-bridge/state';
import type { WebModelTurnCallbacks, WebModelTurnPort } from '../core/harness-bridge/model-turn-port';
import {
  HarnessBridgeResultCache, MAX_HARNESS_BRIDGE_RECOVERY_RECORDS,
  decodeHarnessBridgeRecoveryIndex, harnessBridgeAuthorityDigest,
  type HarnessBridgeRecoveryIndex, type HarnessBridgeRecoveryRecord, type HarnessBridgeRecoveryStorage,
} from '../core/harness-bridge/result-cache';
import type { HarnessBridgeSettings } from '../core/harness-bridge/settings';
import type { ModelRequestCheckpoint, ModelTerminalEvent } from '../packages/web-model-protocol/src/index';

const TOKEN = 'A'.repeat(43);
const DIGEST = 'd'.repeat(64);
const coordinators: HarnessBridgeCoordinator[] = [];
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.stop(); vi.unstubAllGlobals(); });

describe('browser metadata recovery index', () => {
  it.each([
    ['before accepted acknowledgement', 'accepted', 0, undefined],
    ['after accepted acknowledgement', 'accepted', 0, undefined],
    ['after first chunk', 'streaming', 1, undefined],
    ['after terminal commit', 'completed', 2, { type: 'completed', finish_reason: 'stop' }],
  ] as const)('recovers %s without generating or replaying result content', async (_label, status, sequence, terminal) => {
    const authorityDigest = await harnessBridgeAuthorityDigest(43123, TOKEN);
    const storage = memoryStorage({ version: 1, records: [{
      authorityDigest, request_id: 'request-1', request_digest: DIGEST, sessionId: 'session-1',
      status, last_sequence: sequence, cancelRequested: false,
      ...(terminal ? { terminal } : {}),
    }] });
    const fixture = await setup(storage);
    const expected = status === 'completed' ? 'completed' : 'ambiguous';

    fixture.client.receive(query());
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ result: {
      type: 'model.status', status: expected, last_sequence: status === 'completed' ? sequence : sequence + 1,
    } }));
    expect(fixture.turn.generate).not.toHaveBeenCalled();
    expect(fixture.client.sent.filter((frame) => frame.method === 'model.event')).toEqual([]);
    expect(storage.index().records[0]?.status).toBe(expected);
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ error: { data: {
      error_code: 'DUPLICATE_REQUEST', external_outcome: 'unknown', retryable: false,
    } } }));
    fixture.client.receive(cancel());
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ result: { type: 'model.cancelled', status: 'already_terminal' } }));
    expect(fixture.turn.generate).not.toHaveBeenCalled();
    expect(fixture.turn.cancel).not.toHaveBeenCalled();
    const reopened = new HarnessBridgeResultCache(storage);
    await reopened.initialize();
    expect((await reopened.read(authorityDigest))[0]).toEqual(storage.index().records[0]);
  });

  it('does not call the webpage turn or acknowledge before the durable reservation commits', async () => {
    const reservation = deferred<void>();
    const storage = memoryStorage();
    storage.beforeWrite = async (value) => { if (value.records.length === 1 && storage.raw() === undefined) await reservation.promise; };
    const fixture = await setup(storage, successfulTurn());
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(storage.writes).toHaveBeenCalledOnce());
    expect(fixture.turn.generate).not.toHaveBeenCalled();
    expect(fixture.client.sent).toEqual([]);

    reservation.resolve();
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ method: 'model.event', params: { event: { type: 'completed' } } }));
    expect(fixture.turn.generate).toHaveBeenCalledOnce();
    expect(storage.index().records[0]).toMatchObject({ status: 'completed', last_sequence: 2 });
    expect(fixture.client.sent.map((frame) => frame.result?.type ?? frame.params?.event.type)).toEqual(['model.accepted', 'text_delta', 'completed']);
  });

  it('commits monotonic sequence metadata before each text/tool/reasoning/terminal emit, never content', async () => {
    const textCommit = deferred<void>();
    const storage = memoryStorage();
    storage.beforeWrite = async (value) => { if (value.records[0]?.last_sequence === 1) await textCommit.promise; };
    const fixture = await setup(storage, {
      generate: vi.fn<WebModelTurnPort['generate']>(async (_request, callbacks) => {
        callbacks.onAccepted(accepted());
        callbacks.onTextDelta({ type: 'text_delta', text: 'PRIVATE_ANSWER' });
        callbacks.onToolCall({ type: 'tool_call', tool_call_id: 'call-1', name: 'tool', arguments: { result: 'PRIVATE_TOOL' } });
        callbacks.onReasoningDelta?.({ type: 'reasoning_delta', text: 'PRIVATE_REASONING', retention: 'ephemeral' });
        return { type: 'completed', finish_reason: 'tool_calls' };
      }),
    });
    fixture.client.beforeSend = (frame) => {
      if (frame.params?.event) expect(storage.index().records[0]?.last_sequence).toBe(frame.params.sequence);
    };
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(storage.writes).toHaveBeenCalledTimes(2));
    expect(fixture.client.sent.map((frame) => frame.result?.type)).toEqual(['model.accepted']);
    textCommit.resolve();
    await vi.waitFor(() => expect(storage.index().records[0]?.status).toBe('completed'));
    await vi.waitFor(() => expect(fixture.client.sent).toHaveLength(5));
    expect(fixture.client.sent.slice(1).map((frame) => frame.params.sequence)).toEqual([1, 2, 3, 4]);
    const raw = JSON.stringify(storage.raw());
    for (const secret of ['PRIVATE_ANSWER', 'PRIVATE_TOOL', 'PRIVATE_REASONING', 'PRIVATE_PROMPT', TOKEN]) expect(raw).not.toContain(secret);
    expect(Object.keys(storage.index().records[0]!).sort()).toEqual([
      'authorityDigest', 'cancelRequested', 'last_sequence', 'request_digest', 'request_id', 'sessionId', 'status', 'terminal',
    ]);
  });

  it('retains a committed completion when socket send fails and answers after a worker recreation', async () => {
    const storage = memoryStorage();
    const fixture = await setup(storage, successfulTurn());
    fixture.client.beforeSend = (frame) => { if (frame.params?.event.type === 'completed') throw new Error('socket closed'); };
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(storage.index().records[0]?.status).toBe('completed'));
    fixture.coordinator.stop();
    const reopened = await setup(storage);
    reopened.client.receive(query());
    await vi.waitFor(() => expect(reopened.client.sent.at(-1)).toMatchObject({ result: { status: 'completed', last_sequence: 2 } }));
    expect(reopened.turn.generate).not.toHaveBeenCalled();
    expect(reopened.client.sent.some((frame) => frame.method === 'model.event')).toBe(false);
  });

  it('persists cancel intent before cancelling the turn and returns already_terminal after restart', async () => {
    const cancellation = deferred<void>();
    const completion = deferred<ModelTerminalEvent>();
    const storage = memoryStorage();
    storage.beforeWrite = async (value) => { if (value.records[0]?.cancelRequested) await cancellation.promise; };
    const fixture = await setup(storage, {
      generate: vi.fn(async (_request, callbacks) => { callbacks.onAccepted(accepted()); return completion.promise; }),
      cancel: vi.fn<WebModelTurnPort['cancel']>((input: any) => {
        expect(storage.index().records[0]?.cancelRequested).toBe(true);
        completion.resolve({ type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown' });
        return { request_id: input.request_id, request_digest: input.request_digest, status: 'cancel_requested' };
      }),
    });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent).toHaveLength(1));
    fixture.client.receive(cancel());
    await vi.waitFor(() => expect(storage.writes).toHaveBeenCalledTimes(2));
    expect(fixture.turn.cancel).not.toHaveBeenCalled();
    expect(fixture.client.sent).toHaveLength(1);
    cancellation.resolve();
    await vi.waitFor(() => expect(storage.index().records[0]?.status).toBe('ambiguous'));
    expect(fixture.turn.cancel).toHaveBeenCalledOnce();
    fixture.coordinator.stop();
    const reopened = await setup(storage);
    reopened.client.receive(cancel());
    await vi.waitFor(() => expect(reopened.client.sent.at(-1)).toMatchObject({ result: { status: 'already_terminal' } }));
    expect(reopened.turn.cancel).not.toHaveBeenCalled();
  });

  it.each(['reserve', 'chunk', 'terminal'] as const)('fails closed on %s storage failure without a success acknowledgement', async (point) => {
    const storage = memoryStorage();
    storage.beforeWrite = async (value) => {
      const record = value.records[0];
      if (point === 'reserve' || (point === 'chunk' && record?.last_sequence === 1) || (point === 'terminal' && record?.status === 'completed')) {
        throw new Error('private disk failure');
      }
    };
    const fixture = await setup(storage, successfulTurn());
    fixture.client.receive(generate());
    await vi.waitFor(async () => expect(await fixture.coordinator.getStatus()).toEqual({ ok: false, error: 'harness_bridge_recovery_unavailable' }));
    expect(fixture.client.sent.some((frame) => frame.params?.event.type === 'completed')).toBe(false);
    if (point === 'reserve') {
      expect(fixture.turn.generate).not.toHaveBeenCalled();
      expect(fixture.client.sent).toEqual([]);
    }
    expect(JSON.stringify(storage.raw() ?? null)).not.toContain('private disk failure');
  });

  it.each(['events', 'bytes'] as const)('bounds queued %s while persistence is slow and never publishes the abandoned content', async (dimension) => {
    const storage = memoryStorage();
    const completion = deferred<ModelTerminalEvent>();
    let observedSignal: AbortSignal | undefined;
    let count = 0;
    const fixture = await setup(storage, {
      generate: vi.fn<WebModelTurnPort['generate']>(async (_request, callbacks, context) => {
        observedSignal = context?.signal;
        callbacks.onAccepted(accepted());
        const text = dimension === 'events' ? 'x' : 'x'.repeat(128 * 1024);
        try {
          for (; count <= WEB_MODEL_TURN_BUDGETS.events; count++) callbacks.onTextDelta({ type: 'text_delta', text });
        } catch {
          completion.resolve({ type: 'ambiguous', reason: 'consumer_callback_outcome_unknown' });
        }
        return completion.promise;
      }),
    });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(storage.index().records[0]?.status).toBe('ambiguous'));
    expect(observedSignal?.aborted).toBe(true);
    expect(count).toBeLessThan(WEB_MODEL_TURN_BUDGETS.events);
    if (dimension === 'bytes') expect(count).toBeLessThan(WEB_MODEL_TURN_BUDGETS.outputUtf8Bytes / (128 * 1024));
    expect(fixture.client.sent.filter((frame) => frame.method === 'model.event')).toEqual([]);
    expect(storage.index().records[0]?.last_sequence).toBe(1);
  });

  it('fails closed if cancel intent cannot be persisted and never invokes cancellation or acknowledges it', async () => {
    const storage = memoryStorage();
    const completion = deferred<ModelTerminalEvent>();
    const fixture = await setup(storage, {
      generate: vi.fn(async (_request, callbacks) => { callbacks.onAccepted(accepted()); return completion.promise; }),
    });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent).toHaveLength(1));
    storage.beforeWrite = async () => { throw new Error('write failed'); };
    fixture.client.receive(cancel());
    await vi.waitFor(async () => expect(await fixture.coordinator.getStatus()).toEqual({ ok: false, error: 'harness_bridge_recovery_unavailable' }));
    expect(fixture.turn.cancel).not.toHaveBeenCalled();
    expect(fixture.client.sent).toHaveLength(1);
    expect(storage.index().records[0]?.cancelRequested).toBe(false);
  });

  it.each([
    ['future', { version: 2, records: [] }, 'harness_bridge_recovery_future_version'],
    ['unknown fields', { version: 1, records: [], prompt: 'PRIVATE_PROMPT' }, 'harness_bridge_recovery_corrupt'],
    ['invalid shape', { version: 1, records: 'wrong' }, 'harness_bridge_recovery_corrupt'],
  ])('preserves %s storage and blocks startup and settings retry', async (_label, raw, code) => {
    const storage = memoryStorage(raw);
    const fixture = await setup(storage);
    expect(fixture.created).toHaveLength(0);
    expect(await fixture.coordinator.getStatus()).toEqual({ ok: false, error: code });
    expect(await fixture.coordinator.updateSettings({ enabled: true, port: 44123, pairingToken: 'B'.repeat(43) })).toEqual({ ok: false, error: code });
    expect(storage.raw()).toEqual(raw);
    expect(storage.writes).not.toHaveBeenCalled();
    expect(fixture.turn.generate).not.toHaveBeenCalled();
  });

  it('re-reads storage for every mutation and does not poison the queue after a transient read failure', async () => {
    const storage = memoryStorage();
    const cache = new HarnessBridgeResultCache(storage);
    const authority = await harnessBridgeAuthorityDigest(43123, TOKEN);
    storage.read.mockRejectedValueOnce(new Error('unavailable'));
    await expect(cache.reserve(authority, 'request-1', DIGEST, 'session-1')).rejects.toMatchObject({ code: 'harness_bridge_recovery_unavailable' });
    await cache.reserve(authority, 'request-1', DIGEST, 'session-1');
    storage.replace({ version: 9 });
    await expect(cache.advance(authority, 'request-1')).rejects.toMatchObject({ code: 'harness_bridge_recovery_future_version' });
    expect(storage.raw()).toEqual({ version: 9 });
    expect(storage.writes).toHaveBeenCalledOnce();
  });

  it('releases only a proved unstarted preparation failure and retains an unknown failure as ambiguous', async () => {
    const storage = memoryStorage();
    const fixture = await setup(storage, {
      generate: vi.fn().mockRejectedValueOnce(new DeepSeekTurnAdapterError('DEEPSEEK_AUTH_REQUIRED', true)).mockRejectedValueOnce(new Error('PRIVATE_ERROR')),
    });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ error: { data: { external_outcome: 'not_started', error_code: 'DEEPSEEK_AUTH_REQUIRED' } } }));
    expect(storage.index().records).toEqual([]);
    fixture.client.receive(generate('request-2'));
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ error: { data: { external_outcome: 'unknown', retryable: false } } }));
    expect(storage.index().records[0]).toMatchObject({ request_id: 'request-2', status: 'ambiguous' });
    expect(JSON.stringify(storage.raw())).not.toContain('PRIVATE_ERROR');
    fixture.client.receive(generate('request-3'));
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ error: { data: { error_code: 'SESSION_QUARANTINED', external_outcome: 'unknown' } } }));
    expect(fixture.turn.generate).toHaveBeenCalledTimes(2);
  });

  it('preserves the adapter quarantine reason without unquarantining or replaying', async () => {
    const storage = memoryStorage();
    const fixture = await setup(storage, {
      generate: vi.fn().mockRejectedValue(new DeepSeekTurnAdapterError('SESSION_QUARANTINED')),
    });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent.at(-1)).toMatchObject({ error: { data: {
      error_code: 'SESSION_QUARANTINED', external_outcome: 'unknown', retryable: false,
    } } }));
    expect(storage.index().records[0]).toMatchObject({ status: 'ambiguous' });
    expect(fixture.turn.generate).toHaveBeenCalledOnce();
  });

  it('retains old authority tombstones across pairing changes and fences a late old terminal', async () => {
    const storage = memoryStorage();
    const completion = deferred<ModelTerminalEvent>();
    const fixture = await setup(storage, { generate: vi.fn(async (_request, callbacks) => { callbacks.onAccepted(accepted()); return completion.promise; }) });
    fixture.client.receive(generate());
    await vi.waitFor(() => expect(fixture.client.sent).toHaveLength(1));
    await fixture.coordinator.updateSettings({ enabled: true, port: 44123, pairingToken: 'B'.repeat(43) });
    const next = fixture.created.at(-1)!;
    next.ready();
    completion.resolve({ type: 'completed', finish_reason: 'stop' });
    next.receive(query());
    await vi.waitFor(() => expect(next.sent.at(-1)).toMatchObject({ result: { status: 'unknown' } }));
    expect(storage.index().records[0]?.status).toBe('ambiguous');
    await fixture.coordinator.updateSettings({ enabled: true, port: 43123, pairingToken: TOKEN });
    const original = fixture.created.at(-1)!;
    original.ready();
    original.receive(query());
    await vi.waitFor(() => expect(original.sent.at(-1)).toMatchObject({ result: { status: 'ambiguous' } }));
    expect(fixture.turn.generate).toHaveBeenCalledOnce();
    expect(storage.index().records).toHaveLength(1);
  });

  it('refuses capacity overflow across authorities without evicting accepted tombstones', async () => {
    const authorityDigest = await harnessBridgeAuthorityDigest(43123, TOKEN);
    const records: HarnessBridgeRecoveryRecord[] = Array.from({ length: MAX_HARNESS_BRIDGE_RECOVERY_RECORDS }, (_, index) => ({
      authorityDigest, request_id: `request-${index}`, request_digest: DIGEST, sessionId: `session-${index}`,
      status: 'completed', last_sequence: 1, cancelRequested: false, terminal: { type: 'completed', finish_reason: 'stop' },
    }));
    const storage = memoryStorage({ version: 1, records });
    const cache = new HarnessBridgeResultCache(storage);
    await expect(cache.reserve('a'.repeat(64), 'new-request', DIGEST, 'new-session')).rejects.toMatchObject({ code: 'REQUEST_CAPACITY_EXCEEDED' });
    expect(storage.writes).not.toHaveBeenCalled();
    expect(storage.index().records).toEqual(records);
  });

  it('sanitizes free-form terminal metadata and rejects secret-bearing or duplicate persisted records', async () => {
    const storage = memoryStorage();
    const cache = new HarnessBridgeResultCache(storage);
    const authority = await harnessBridgeAuthorityDigest(43123, TOKEN);
    await cache.reserve(authority, 'request-1', DIGEST, 'session-1');
    await cache.advance(authority, 'request-1', { type: 'failed', error: { code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE', retryable: false, external_outcome: 'started' } });
    expect(JSON.stringify(storage.raw())).not.toContain('PRIVATE_');
    expect(storage.index().records[0]?.terminal).toMatchObject({ type: 'failed', error: { code: 'WEB_MODEL_FAILED' } });
    const record = storage.index().records[0]!;
    expect(() => decodeHarnessBridgeRecoveryIndex({ version: 1, records: [{ ...record, prompt: 'PRIVATE_PROMPT' }] })).toThrow('harness_bridge_recovery_corrupt');
    expect(() => decodeHarnessBridgeRecoveryIndex({ version: 1, records: [record, record] })).toThrow('harness_bridge_recovery_corrupt');
  });
});

function memoryStorage(initial?: unknown) {
  let value = structuredClone(initial);
  const storage = {
    beforeWrite: undefined as ((next: HarnessBridgeRecoveryIndex) => Promise<void>) | undefined,
    read: vi.fn(async () => structuredClone(value)),
    writes: vi.fn(async (next: HarnessBridgeRecoveryIndex) => {
      await storage.beforeWrite?.(next);
      value = structuredClone(next);
    }),
    write: (next: HarnessBridgeRecoveryIndex) => storage.writes(next),
    raw: () => structuredClone(value),
    index: () => decodeHarnessBridgeRecoveryIndex(value) ?? { version: 1 as const, records: [] },
    replace: (next: unknown) => { value = structuredClone(next); },
  };
  return storage;
}

async function setup(storage: HarnessBridgeRecoveryStorage, overrides: Partial<WebModelTurnPort> = {}) {
  let settings: HarnessBridgeSettings = { version: 1, enabled: true, port: 43123, pairingToken: TOKEN };
  const created: FakeClient[] = [];
  const turn = {
    generate: vi.fn<WebModelTurnPort['generate']>(async () => { throw new Error('No generation expected'); }),
    cancel: vi.fn<WebModelTurnPort['cancel']>((input: any) => ({ request_id: input.request_id, request_digest: input.request_digest, status: 'not_found' })),
    ...overrides,
  };
  const coordinator = new HarnessBridgeCoordinator({
    recoveryStorage: storage,
    settings: {
      read: async () => settings,
      update: async (patch) => { settings = { ...settings, ...patch }; return settings; },
    },
    turnPort: turn,
    createClient: () => { const client = new FakeClient(); created.push(client); return client; },
  });
  coordinators.push(coordinator);
  await coordinator.initialize();
  const client = created[0] ?? new FakeClient();
  client.ready();
  return { coordinator, client, created, turn };
}

class FakeClient implements HarnessBridgeClientPort {
  state: HarnessBridgeClientState = { phase: 'offline', attempt: 0 };
  readonly sent: any[] = [];
  readonly hydrated: ModelRequestCheckpoint[] = [];
  beforeSend?: (frame: any) => void;
  private listener?: (request: HarnessBridgeHostRequest) => void;
  private stateListener?: (state: HarnessBridgeClientState) => void;
  start() { this.state = { phase: 'connecting', attempt: 1 }; }
  stop() { this.state = { phase: 'stopped', attempt: 0 }; }
  reconnect() {}
  send(frame: unknown) { this.beforeSend?.(frame); this.sent.push(structuredClone(frame)); }
  hydrateRequestCheckpoint(checkpoint: ModelRequestCheckpoint) { this.hydrated.push(structuredClone(checkpoint)); }
  subscribe(listener: (state: HarnessBridgeClientState) => void) { this.stateListener = listener; listener(this.state); return () => { this.stateListener = undefined; }; }
  subscribeRequests(listener: (request: HarnessBridgeHostRequest) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  ready() {
    this.state = { phase: 'ready', attempt: 0, capabilities: { text: true, structured_tool_calls: true, usage: true, cancel: true, query: true, reasoning: true } };
    this.stateListener?.(this.state);
  }
  receive(request: HarnessBridgeHostRequest) { this.listener?.(request); }
}

function accepted() { return { request_id: 'request-1', request_digest: DIGEST, status: 'accepted' as const }; }
function successfulTurn(): Partial<WebModelTurnPort> {
  return { generate: vi.fn<WebModelTurnPort['generate']>(async (_request, callbacks: WebModelTurnCallbacks) => {
    callbacks.onAccepted(accepted());
    callbacks.onTextDelta({ type: 'text_delta', text: 'PRIVATE_ANSWER' });
    return { type: 'completed', finish_reason: 'stop' };
  }) };
}
function generate(requestId = 'request-1'): HarnessBridgeHostRequest {
  return { jsonrpc: '2.0', id: `generate-${requestId}`, method: 'model.generate', params: {
    schema_version: 1, request_id: requestId, request_digest: DIGEST, session_id: 'session-1', purpose: 'agent',
    model: { provider: 'deepseek-web', model_id: 'current-web-session' },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] }] },
    tools: [], options: { thinking_enabled: true, search_enabled: false, model_type: 'default' },
  } };
}
function query(): HarnessBridgeHostRequest {
  return { jsonrpc: '2.0', id: 'query-1', method: 'model.query', params: { schema_version: 1, request_id: 'request-1', request_digest: DIGEST } };
}
function cancel(): HarnessBridgeHostRequest {
  return { jsonrpc: '2.0', id: 'cancel-1', method: 'model.cancel', params: { schema_version: 1, request_id: 'request-1', request_digest: DIGEST, reason: 'cancelled' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
