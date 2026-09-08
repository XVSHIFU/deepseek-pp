import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type {
  DeepSeekAutomationClient,
  DeepSeekHistorySnapshot,
  DeepSeekRequestContext,
  ModelTurn,
} from '../core/deepseek/automation-client-port';
import {
  loadClientHeadersFromStorage,
  type StreamCallbacks,
  type SubmitPromptInput,
} from '../core/deepseek/active-client';
import {
  DeepSeekTurnAdapterError,
  WEB_MODEL_TURN_BUDGETS,
  createDeepSeekWebModelTurnAdapter,
  serializeWebModelTurnPrompt,
} from '../core/harness-bridge/deepseek-turn-adapter';
import { WebModelSessionMap } from '../core/harness-bridge/session-map';
import type {
  WebModelReasoningDelta,
  WebModelTextDelta,
  WebModelToolCall,
  WebModelTurnAccepted,
  WebModelTurnCallbacks,
  WebModelTurnRequest,
} from '../core/harness-bridge/model-turn-port';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function request(overrides: Partial<WebModelTurnRequest> = {}): WebModelTurnRequest {
  return {
    schema_version: 1,
    request_id: 'request-1',
    session_id: 'session-1',
    request_digest: DIGEST_A,
    purpose: 'agent',
    model: { provider: 'deepseek-web', model_id: 'current-web-session' },
    input: {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Work carefully.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Read the README.' }] },
      ],
    },
    tools: [{
      name: 'local_agent_read',
      description: 'Read a workspace-relative file.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }],
    options: {
      thinking_enabled: false,
      search_enabled: false,
      model_type: 'default',
    },
    ...overrides,
  };
}

function history(
  responseMessageId = 11,
  overrides: Partial<DeepSeekHistorySnapshot> = {},
): DeepSeekHistorySnapshot {
  return {
    chatSessionId: 'chat-1',
    parentMessageId: responseMessageId,
    assistantMessageId: responseMessageId,
    assistantParentMessageId: responseMessageId - 1,
    requestParentMessageId: responseMessageId === 11 ? null : responseMessageId - 2,
    messageCount: 2,
    verifiedAt: 1_000,
    ...overrides,
  };
}

function turn(overrides: Partial<ModelTurn> = {}): ModelTurn {
  return {
    assistantText: '',
    responseMessageId: 11,
    requestMessageId: 10,
    finished: true,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<DeepSeekAutomationClient> = {}): DeepSeekAutomationClient {
  const base: DeepSeekAutomationClient = {
    createClientHeaders: vi.fn(() => ({
      Authorization: 'Bearer browser-secret',
      Cookie: 'session=browser-secret',
    })),
    createChatSession: vi.fn(async () => 'chat-1'),
    createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'pow-secret' })),
    submitPrompt: vi.fn(async () => turn()),
    submitPromptStreaming: vi.fn(async (_input, _callbacks, context) => {
      context.onDispatch?.();
      return turn();
    }),
    readHistorySnapshot: vi.fn(async (_chat, expected) => history(expected)),
    normalizeMessageId: vi.fn((value) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null),
    buildSessionUrl: vi.fn((chat) => `https://chat.deepseek.com/a/chat/s/${chat}`),
  };
  return {
    ...base,
    ...overrides,
    submitPromptStreaming: overrides.submitPromptStreaming ?? base.submitPromptStreaming,
  };
}

interface CollectedCallbacks {
  readonly accepted: WebModelTurnAccepted[];
  readonly text: WebModelTextDelta[];
  readonly tools: WebModelToolCall[];
  readonly reasoning: WebModelReasoningDelta[];
  readonly callbacks: WebModelTurnCallbacks;
}

function collectCallbacks(includeReasoning = false): CollectedCallbacks {
  const accepted: WebModelTurnAccepted[] = [];
  const text: WebModelTextDelta[] = [];
  const tools: WebModelToolCall[] = [];
  const reasoning: WebModelReasoningDelta[] = [];
  return {
    accepted,
    text,
    tools,
    reasoning,
    callbacks: {
      onAccepted: (event) => accepted.push(event),
      onTextDelta: (event) => text.push(event),
      onToolCall: (event) => tools.push(event),
      ...(includeReasoning ? { onReasoningDelta: (event: WebModelReasoningDelta) => reasoning.push(event) } : {}),
    },
  };
}

type TestStreamer = (
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  context: DeepSeekRequestContext,
) => Promise<ModelTurn>;

function adapterWith(
  streamer: TestStreamer,
  client = fakeClient(),
  sessions = new WebModelSessionMap(),
) {
  const connectedClient: DeepSeekAutomationClient = {
    ...client,
    submitPromptStreaming: vi.fn((input, callbacks, context) => {
      context.onDispatch?.();
      return streamer(input, callbacks, context);
    }),
  };
  return {
    adapter: createDeepSeekWebModelTurnAdapter({ client: connectedClient, sessions }),
    client: connectedClient,
    sessions,
  };
}

describe('DeepSeekWebModelTurnAdapter', () => {
  it('uses the async background header dependency without page localStorage', async () => {
    vi.stubGlobal('localStorage', undefined);
    const localGet = vi.fn(async () => ({
      deepseekCachedClientHeaders: {
        Authorization: 'Bearer background-storage-token',
        'X-App-Version': '2.0.0',
      },
    }));
    vi.stubGlobal('chrome', { storage: { local: { get: localGet } } });
    try {
      const client = fakeClient({
        createClientHeaders: vi.fn(() => {
          throw new Error('page localStorage must not be read in background');
        }),
      });
      const loadClientHeaders = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        if (signal.aborted) throw new Error('request aborted');
        return loadClientHeadersFromStorage();
      });
      const adapter = createDeepSeekWebModelTurnAdapter({ client, loadClientHeaders });

      await expect(adapter.generate(request(), collectCallbacks().callbacks)).resolves.toMatchObject({
        type: 'completed',
      });

      expect(loadClientHeaders).toHaveBeenCalledOnce();
      expect(loadClientHeaders.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
      expect(localGet).toHaveBeenCalledWith('deepseekCachedClientHeaders');
      expect(client.createClientHeaders).not.toHaveBeenCalled();
      expect(client.submitPromptStreaming).toHaveBeenCalledWith(
        expect.objectContaining({
          clientHeaders: expect.objectContaining({ Authorization: 'Bearer background-storage-token' }),
        }),
        expect.any(Object),
        expect.any(Object),
      );
      const backgroundSource = readFileSync('entrypoints/background.ts', 'utf8');
      expect(backgroundSource).toContain(
        'loadClientHeaders: ({ signal }) => loadOrRefreshClientHeaders(undefined, signal)',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('classifies missing background auth before any DeepSeek request is dispatched', async () => {
    const client = fakeClient();
    const loadClientHeaders = vi.fn(async () => null);
    const sessions = new WebModelSessionMap();
    const adapter = createDeepSeekWebModelTurnAdapter({ client, sessions, loadClientHeaders });
    const collected = collectCallbacks();

    await expect(adapter.generate(request(), collected.callbacks)).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_REQUIRED',
      retryable: true,
      externalOutcome: 'not_started',
      message: 'DEEPSEEK_AUTH_REQUIRED',
    });

    expect(collected.accepted).toEqual([]);
    expect(client.createClientHeaders).not.toHaveBeenCalled();
    expect(client.createChatSession).not.toHaveBeenCalled();
    expect(client.createPowHeaders).not.toHaveBeenCalled();
    expect(client.submitPromptStreaming).not.toHaveBeenCalled();
    expect(sessions.snapshot()).toMatchObject({ requestCount: 0, sessionCount: 0 });
  });

  it('cancels an unresolved async header load and never dispatches a DeepSeek request', async () => {
    let resolveHeaders!: (value: Record<string, string> | null) => void;
    const client = fakeClient();
    const loadClientHeaders = vi.fn(({ signal: _signal }: { signal: AbortSignal }) => (
      new Promise<Record<string, string> | null>((resolve) => { resolveHeaders = resolve; })
    ));
    const sessions = new WebModelSessionMap();
    const adapter = createDeepSeekWebModelTurnAdapter({ client, sessions, loadClientHeaders });
    const pending = adapter.generate(request(), collectCallbacks().callbacks);
    await vi.waitFor(() => expect(loadClientHeaders).toHaveBeenCalledOnce());

    expect(adapter.cancel({
      schema_version: 1,
      request_id: 'request-1',
      request_digest: DIGEST_A,
      reason: 'cancel_during_auth_refresh',
    })).toMatchObject({ status: 'cancel_requested' });
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED', externalOutcome: 'not_started' });

    expect(loadClientHeaders.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(client.createChatSession).not.toHaveBeenCalled();
    expect(client.createPowHeaders).not.toHaveBeenCalled();
    expect(client.submitPromptStreaming).not.toHaveBeenCalled();
    expect(sessions.snapshot()).toMatchObject({ requestCount: 0, sessionCount: 0 });
    resolveHeaders({ Authorization: 'Bearer too-late' });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.createChatSession).not.toHaveBeenCalled();
    expect(client.createPowHeaders).not.toHaveBeenCalled();
    expect(client.submitPromptStreaming).not.toHaveBeenCalled();
  });

  it('serializes structured context deterministically and maps text plus terminal tool calls', async () => {
    const seenInputs: SubmitPromptInput[] = [];
    const streamer: TestStreamer = vi.fn(async (input, callbacks) => {
      seenInputs.push(input);
      callbacks.onTextChunk?.('Checking ', 'Checking ');
      callbacks.onTextChunk?.(
        '<local_agent_read>{"path":"README.md"}</local_agent_read>',
        'Checking <local_agent_read>{"path":"README.md"}</local_agent_read>',
      );
      callbacks.onTextChunk?.('done.', 'Checking <local_agent_read>{"path":"README.md"}</local_agent_read>done.');
      return turn();
    });
    const { adapter, sessions } = adapterWith(streamer);
    const collected = collectCallbacks();

    const terminal = await adapter.generate(request(), collected.callbacks);

    expect(collected.accepted).toEqual([{
      request_id: 'request-1',
      request_digest: DIGEST_A,
      status: 'accepted',
    }]);
    expect(collected.text.map((event) => event.text).join('')).toBe('Checking ');
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0]).toMatchObject({
      type: 'tool_call',
      name: 'local_agent_read',
      arguments: { path: 'README.md' },
    });
    expect(terminal).toEqual({ type: 'completed', finish_reason: 'tool_calls' });
    expect(seenInputs[0]).toMatchObject({
      chatSessionId: 'chat-1',
      parentMessageId: null,
      modelType: 'default',
      thinkingEnabled: false,
      searchEnabled: false,
      refFileIds: [],
    });
    expect(seenInputs[0]?.prompt).toBe(serializeWebModelTurnPrompt(request()));
    expect(sessions.getSession('session-1')).toEqual({
      chatSessionId: 'chat-1',
      parentMessageId: 11,
      messageCount: 2,
      quarantined: false,
    });

    const publicOutput = JSON.stringify({
      accepted: collected.accepted,
      text: collected.text,
      tools: collected.tools,
      terminal,
      snapshot: sessions.snapshot(),
    });
    expect(publicOutput).not.toMatch(/browser-secret|Authorization|Cookie|X-DS-PoW|pow-secret/i);
    expect(publicOutput).not.toContain('[object Response]');
  });

  it('uses the verified response as the next parent and never recreates a bound page session', async () => {
    const parents: Array<number | null> = [];
    let responseId = 11;
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async (_chat, expected) => history(expected, {
        messageCount: expected === 11 ? 2 : 4,
      })),
    });
    const streamer: TestStreamer = vi.fn(async (input) => {
      parents.push(input.parentMessageId);
      const nextResponseId = responseId;
      responseId += 2;
      return turn({ responseMessageId: nextResponseId, requestMessageId: nextResponseId - 1 });
    });
    const { adapter } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'completed', finish_reason: 'stop',
    });
    expect(await adapter.generate(request({
      request_id: 'request-2',
      request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).toEqual({ type: 'completed', finish_reason: 'stop' });

    expect(parents).toEqual([null, 11]);
    expect(client.createChatSession).toHaveBeenCalledTimes(1);
  });

  it('quarantines when the new webpage request does not descend from the current parent', async () => {
    let responseId = 11;
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async (_chat, expected) => history(expected, {
        messageCount: expected === 11 ? 2 : 4,
        ...(expected === 13 ? { requestParentMessageId: 999 } : {}),
      })),
    });
    const streamer: TestStreamer = vi.fn(async () => {
      const currentResponseId = responseId;
      responseId += 2;
      return turn({
        requestMessageId: currentResponseId - 1,
        responseMessageId: currentResponseId,
      });
    });
    const { adapter, sessions } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'completed', finish_reason: 'stop',
    });
    expect(await adapter.generate(request({
      request_id: 'request-2', request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).toEqual({
      type: 'ambiguous', reason: 'deepseek_chain_unverified',
    });
    expect(sessions.getSession('session-1')).toEqual({
      chatSessionId: 'chat-1', parentMessageId: 11, messageCount: 2, quarantined: true,
    });
  });

  it('records reserved to accepted to dispatched to streaming before completed', async () => {
    const phases: string[] = [];
    let sessions!: WebModelSessionMap;
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      phases.push(sessions.getRequest('request-1')?.phase ?? 'missing');
      callbacks.onTextChunk?.('ok', '');
      phases.push(sessions.getRequest('request-1')?.phase ?? 'missing');
      return turn();
    });
    const setup = adapterWith(streamer);
    sessions = setup.sessions;

    await setup.adapter.generate(request(), {
      ...collectCallbacks().callbacks,
      onAccepted() {
        phases.push(sessions.getRequest('request-1')?.phase ?? 'missing');
      },
    });
    phases.push(sessions.getRequest('request-1')?.phase ?? 'missing');

    expect(phases).toEqual(['accepted', 'dispatched', 'streaming', 'completed']);
  });

  it('retains request tombstones and rejects every duplicate request id without dispatch', async () => {
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter, sessions } = adapterWith(streamer);
    await adapter.generate(request(), collectCallbacks().callbacks);

    await expect(adapter.generate(request(), collectCallbacks().callbacks)).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      externalOutcome: 'not_started',
    });
    expect(streamer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing FINISHED', turn({ finished: false }), 'deepseek_stream_incomplete'],
    ['missing response id', turn({ responseMessageId: null }), 'response_message_id_missing'],
    ['missing request id', turn({ requestMessageId: null }), 'request_message_id_missing'],
  ])('maps %s to ambiguous and does not advance the chain', async (_label, result, reason) => {
    const { adapter, sessions, client } = adapterWith(vi.fn(async () => result));
    const terminal = await adapter.generate(request(), collectCallbacks().callbacks);

    expect(terminal).toEqual({ type: 'ambiguous', reason });
    expect(sessions.getSession('session-1')).toEqual({
      chatSessionId: 'chat-1', parentMessageId: null, messageCount: 0, quarantined: true,
    });
    if (!result.finished || result.responseMessageId === null || result.requestMessageId === null) {
      expect(client.readHistorySnapshot).not.toHaveBeenCalled();
    }
  });

  it('requires the history snapshot to prove the exact continuous page chain', async () => {
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async () => history(11, { assistantMessageId: 12 })),
    });
    const { adapter, sessions } = adapterWith(vi.fn(async () => turn()), client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'ambiguous', reason: 'deepseek_chain_unverified',
    });
    expect(sessions.getSession('session-1')?.parentMessageId).toBeNull();
  });

  it.each([
    ['assistant parent mismatch', { assistantParentMessageId: 999 }],
    ['unexpected history growth', { messageCount: 3 }],
  ])('quarantines a completed-looking turn when %s', async (_label, snapshotOverride) => {
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async () => history(11, snapshotOverride)),
    });
    const { adapter, sessions } = adapterWith(vi.fn(async () => turn()), client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'ambiguous', reason: 'deepseek_chain_unverified',
    });
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
    await expect(adapter.generate(request({
      request_id: 'request-2', request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).rejects.toMatchObject({ code: 'SESSION_QUARANTINED' });
  });

  it('does not allow accepted state to skip dispatch and complete directly', () => {
    const sessions = new WebModelSessionMap();
    sessions.reserve('request-1', DIGEST_A, 'session-1');
    sessions.bindNewSession('request-1', 'chat-1');
    sessions.markAccepted('request-1');

    expect(() => sessions.complete('request-1', {
      chatSessionId: 'chat-1',
      requestMessageId: 10,
      responseMessageId: 11,
      nextParentMessageId: 11,
      assistantMessageId: 11,
      assistantParentMessageId: 10,
      requestParentMessageId: null,
      messageCount: 2,
      verifiedAt: 1,
    })).toThrow('REQUEST_PHASE_INVALID');
  });

  it('does not persist reasoning and rejects it unless capability plus ephemeral sink are present', async () => {
    const unnegotiated = adapterWith(vi.fn(async () => turn()));
    const thinkingRequest = request({
      options: { thinking_enabled: true, search_enabled: false, model_type: 'expert' },
    });
    await expect(unnegotiated.adapter.generate(thinkingRequest, collectCallbacks(true).callbacks))
      .rejects.toMatchObject({ code: 'REASONING_NOT_NEGOTIATED' });
    expect(unnegotiated.client.createClientHeaders).not.toHaveBeenCalled();

    const reasoningText = 'ephemeral-private-reasoning';
    const cumulativeReasoning = 'cumulative-reasoning-must-not-cross-port';
    const negotiated = adapterWith(vi.fn(async (_input, callbacks) => {
      callbacks.onReasoningChunk?.(reasoningText, cumulativeReasoning);
      callbacks.onTextChunk?.('answer', 'answer');
      return turn();
    }));
    const collected = collectCallbacks(true);
    const terminal = await negotiated.adapter.generate(thinkingRequest, collected.callbacks, {
      negotiatedCapabilities: {
        text: true,
        reasoning: true,
        structured_tool_calls: true,
        cancel: true,
        query: true,
      },
    });

    expect(collected.reasoning).toEqual([{
      type: 'reasoning_delta', text: reasoningText, retention: 'ephemeral',
    }]);
    expect(terminal.type).toBe('completed');
    expect(JSON.stringify(negotiated.sessions.snapshot())).not.toContain(reasoningText);
    expect(JSON.stringify(terminal)).not.toContain(reasoningText);
    expect(JSON.stringify({ events: collected.reasoning, terminal })).not.toContain(cumulativeReasoning);
  });

  it('persists accepted before notifying and does not dispatch after re-entrant cancellation', async () => {
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter, sessions } = adapterWith(streamer);
    const callbacks = collectCallbacks().callbacks;

    const terminal = await adapter.generate(request(), {
      ...callbacks,
      onAccepted(value) {
        expect(sessions.getRequest(value.request_id)?.phase).toBe('accepted');
        expect(adapter.cancel({
          schema_version: 1,
          request_id: value.request_id,
          request_digest: value.request_digest,
          reason: 'cancel_from_accepted_callback',
        })).toMatchObject({ status: 'cancel_requested' });
      },
    });

    expect(terminal).toEqual({ type: 'aborted', reason: 'request_cancelled_before_dispatch' });
    expect(streamer).not.toHaveBeenCalled();
    expect(sessions.getRequest('request-1')?.phase).toBe('aborted');
    expect(sessions.getSession('session-1')?.quarantined).toBe(false);
    await expect(adapter.generate(request(), collectCallbacks().callbacks))
      .rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });

  it('reports an already-aborted external signal as not started without reserving the request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('sensitive caller reason'));
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter, sessions, client } = adapterWith(streamer);

    await expect(adapter.generate(request(), collectCallbacks().callbacks, { signal: controller.signal }))
      .rejects.toMatchObject({
        code: 'REQUEST_ABORTED',
        externalOutcome: 'not_started',
        message: 'REQUEST_ABORTED',
      });
    expect(streamer).not.toHaveBeenCalled();
    expect(client.createClientHeaders).not.toHaveBeenCalled();
    expect(sessions.snapshot()).toMatchObject({ requestCount: 0, sessionCount: 0 });
  });

  it('retains the request tombstone but unlocks the session when accepted notification throws', async () => {
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter, sessions } = adapterWith(streamer);
    const brokenCallbacks = collectCallbacks().callbacks;
    const terminal = await adapter.generate(request(), {
      ...brokenCallbacks,
      onAccepted() {
        throw new Error('partial socket send');
      },
    });

    expect(terminal).toMatchObject({
      type: 'failed', error: { code: 'ACCEPTED_CALLBACK_FAILED' },
    });
    expect(streamer).not.toHaveBeenCalled();
    expect(sessions.getRequest('request-1')?.phase).toBe('failed');
    expect(sessions.getSession('session-1')?.quarantined).toBe(false);
    await expect(adapter.generate(request(), collectCallbacks().callbacks))
      .rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
    expect(await adapter.generate(request({
      request_id: 'request-2', request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).toEqual({ type: 'completed', finish_reason: 'stop' });
  });

  it('stops the current chunk after a text callback re-enters cancel and quarantines the session', async () => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.(
        'visible<local_agent_read>{"path":"README.md"}</local_agent_read>',
        '',
      );
      callbacks.onTextChunk?.('late', '');
      return turn();
    });
    const { adapter, sessions } = adapterWith(streamer);
    const toolEvents: WebModelToolCall[] = [];
    let textEvents = 0;
    const terminal = await adapter.generate(request(), {
      onAccepted() {},
      onTextDelta() {
        textEvents += 1;
        adapter.cancel({
          schema_version: 1,
          request_id: 'request-1',
          request_digest: DIGEST_A,
        });
      },
      onToolCall(event) { toolEvents.push(event); },
    });

    expect(textEvents).toBe(1);
    expect(toolEvents).toEqual([]);
    expect(terminal).toEqual({
      type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown',
    });
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
    await expect(adapter.generate(request({
      request_id: 'request-2', request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).rejects.toMatchObject({ code: 'SESSION_QUARANTINED' });
  });

  it('stops later tool calls when a tool callback re-enters cancel', async () => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.([
        '<local_agent_read>{"path":"one"}</local_agent_read>',
        '<local_agent_read>{"path":"two"}</local_agent_read>',
      ].join(''), '');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const tools: WebModelToolCall[] = [];
    const terminal = await adapter.generate(request(), {
      onAccepted() {},
      onTextDelta() {},
      onToolCall(event) {
        tools.push(event);
        adapter.cancel({
          schema_version: 1, request_id: 'request-1', request_digest: DIGEST_A,
        });
      },
    });

    expect(tools).toHaveLength(1);
    expect(terminal).toEqual({
      type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown',
    });
  });

  it('stops later reasoning when its ephemeral callback re-enters cancel', async () => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onReasoningChunk?.('first', 'first');
      callbacks.onReasoningChunk?.('late', 'firstlate');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const reasoning: WebModelReasoningDelta[] = [];
    const terminal = await adapter.generate(request({
      options: { thinking_enabled: true, search_enabled: false, model_type: 'expert' },
    }), {
      onAccepted() {},
      onTextDelta() {},
      onToolCall() {},
      onReasoningDelta(event) {
        reasoning.push(event);
        adapter.cancel({
          schema_version: 1, request_id: 'request-1', request_digest: DIGEST_A,
        });
      },
    }, {
      negotiatedCapabilities: {
        reasoning: true, structured_tool_calls: true, cancel: true, query: true,
      },
    });

    expect(reasoning).toEqual([{ type: 'reasoning_delta', text: 'first', retention: 'ephemeral' }]);
    expect(terminal).toEqual({
      type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown',
    });
  });

  it('releases only proven pre-dispatch failures so the same request can be explicitly retried', async () => {
    const createPowHeaders = vi.fn()
      .mockRejectedValueOnce(new Error('Authorization: Bearer browser-secret'))
      .mockResolvedValueOnce({ 'X-DS-PoW-Response': 'ok' });
    const client = fakeClient({ createPowHeaders });
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter } = adapterWith(streamer, client);

    let caught: unknown;
    try {
      await adapter.generate(request(), collectCallbacks().callbacks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeepSeekTurnAdapterError);
    expect(caught).toMatchObject({
      code: 'DEEPSEEK_PREPARATION_FAILED',
      retryable: true,
      externalOutcome: 'not_started',
      message: 'DEEPSEEK_PREPARATION_FAILED',
    });
    expect(JSON.stringify(caught)).not.toMatch(/browser-secret|Authorization|Bearer/i);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'completed', finish_reason: 'stop',
    });
    expect(streamer).toHaveBeenCalledTimes(1);
  });

  it('never retries an exception after entering submitPromptStreaming', async () => {
    const streamer: TestStreamer = vi.fn(async () => {
      throw new Error('Response Authorization browser-secret');
    });
    const { adapter, sessions } = adapterWith(streamer);

    const terminal = await adapter.generate(request(), collectCallbacks().callbacks);

    expect(terminal).toEqual({ type: 'ambiguous', reason: 'deepseek_turn_outcome_unknown' });
    expect(streamer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ terminal, snapshot: sessions.snapshot() }))
      .not.toMatch(/browser-secret|Authorization/i);
  });

  it('cancels the active request with AbortSignal and cancellation remains idempotent', async () => {
    let signalSeen: AbortSignal | undefined;
    const streamer: TestStreamer = vi.fn((_input, _callbacks, context) => {
      signalSeen = context.signal;
      return new Promise<ModelTurn>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
      });
    });
    const { adapter, sessions } = adapterWith(streamer);
    let accepted!: () => void;
    const acceptedPromise = new Promise<void>((resolve) => { accepted = resolve; });
    const callbacks = collectCallbacks().callbacks;
    const generating = adapter.generate(request(), {
      ...callbacks,
      onAccepted(value) {
        callbacks.onAccepted(value);
        accepted();
      },
    });
    await acceptedPromise;

    expect(adapter.cancel({
      schema_version: 1,
      request_id: 'request-1',
      request_digest: DIGEST_A,
      reason: 'user_requested',
    })).toMatchObject({ status: 'cancel_requested' });
    expect(signalSeen?.aborted).toBe(true);
    expect(await generating).toEqual({
      type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown',
    });
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
    expect(adapter.cancel({
      schema_version: 1,
      request_id: 'request-1',
      request_digest: DIGEST_A,
    })).toMatchObject({ status: 'already_terminal' });
    await expect(adapter.generate(request({
      request_id: 'request-2', request_digest: DIGEST_B,
    }), collectCallbacks().callbacks)).rejects.toMatchObject({ code: 'SESSION_QUARANTINED' });
  });

  it('reports an adapter timeout after dispatch as ambiguous rather than a successful abort', async () => {
    vi.useFakeTimers();
    try {
      const streamer: TestStreamer = vi.fn((_input, _callbacks, context) =>
        new Promise<ModelTurn>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
        }));
      const { adapter } = adapterWith(streamer);
      const generating = adapter.generate(request({
        options: {
          thinking_enabled: false,
          search_enabled: false,
          model_type: 'default',
          timeout_ms: 10,
        },
      }), collectCallbacks().callbacks);

      await vi.advanceTimersByTimeAsync(10);
      expect(await generating).toEqual({ type: 'ambiguous', reason: 'deepseek_turn_timeout' });
      expect(streamer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an external AbortSignal after dispatch as ambiguous', async () => {
    const controller = new AbortController();
    const streamer: TestStreamer = vi.fn((_input, _callbacks, context) =>
      new Promise<ModelTurn>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
      }));
    const { adapter, sessions } = adapterWith(streamer);
    let accepted!: () => void;
    const acceptedPromise = new Promise<void>((resolve) => { accepted = resolve; });
    const callbacks = collectCallbacks().callbacks;
    const generating = adapter.generate(request(), {
      ...callbacks,
      onAccepted(value) {
        callbacks.onAccepted(value);
        accepted();
      },
    }, { signal: controller.signal });
    await acceptedPromise;
    controller.abort(new Error('host cancellation detail must not escape'));

    expect(await generating).toEqual({
      type: 'ambiguous', reason: 'deepseek_dispatch_abort_outcome_unknown',
    });
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
  });

  it('fails after one bounded correction when an incomplete tool call remains malformed', async () => {
    const client = fakeClient();
    const streamer: TestStreamer = vi.fn(async (_input, callbacks: StreamCallbacks) => {
      callbacks.onTextChunk?.('<local_agent_read>{"path":"README.md"}', '');
      return turn();
    });
    const { adapter } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'failed',
      error: {
        code: 'TOOL_CALL_INVALID',
        message: 'DeepSeek returned an invalid structured tool call.',
        retryable: false,
        external_outcome: 'started',
      },
    });
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(client.readHistorySnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    '[调用 local_agent_read]',
    '[调用 local_agent_read] {"path":"README.md"}',
    '[调用 local_agent_read]\n{"path":"README.md"}',
    '[call local_agent_read]\r\n{\r\n  "path": "README.md",\r\n  "nested": {"values": ["a", "b"]}\r\n}',
    '[调用 local_agent_read] {"path":"README.md"}\n[调用 local_agent_read]\n{"path":"other.md"}',
  ])('corrects bracket intent into a formal tool call on the verified page chain: %s', async (text) => {
    const parents: Array<number | null> = [];
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async (_chat, expected) => history(expected, {
        messageCount: expected === 13 ? 4 : 2,
      })),
    });
    const streamer: TestStreamer = vi.fn(async (input, callbacks) => {
      parents.push(input.parentMessageId);
      if (parents.length === 1) {
        for (const chunk of text) callbacks.onTextChunk?.(chunk, '');
        return turn();
      }
      callbacks.onTextChunk?.(
        '<local_agent_read>{"path":"README.md"}</local_agent_read>',
        '',
      );
      return turn({ requestMessageId: 12, responseMessageId: 13 });
    });
    const { adapter, sessions } = adapterWith(streamer, client);
    const collected = collectCallbacks();

    expect(await adapter.generate(request(), collected.callbacks)).toEqual({
      type: 'completed', finish_reason: 'tool_calls',
    });
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(parents).toEqual([null, 11]);
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0]).toMatchObject({
      name: 'local_agent_read', arguments: { path: 'README.md' },
    });
    expect(sessions.getSession('session-1')).toEqual({
      chatSessionId: 'chat-1', parentMessageId: 13, messageCount: 4, quarantined: false,
    });
  });

  it.each([
    'The user wrote [调用 local_agent_read] in ordinary prose.',
    '```text\n[调用 local_agent_read]\n```',
    '[调用 unknown_tool]',
    '[调用 unknown_tool] {"path":"README.md"}',
    'Example:\n[调用 local_agent_read] {"path":"README.md"}',
    '```json\n[调用 local_agent_read]\n{"path":"README.md"}\n```',
    '> [调用 local_agent_read] {"path":"README.md"}',
    '    [调用 local_agent_read] {"path":"README.md"}',
    '[调用 local_agent_read] {"path":"README.md"}\nThis is an example.',
    '[调用 local_agent_read] ["README.md"]',
  ])('keeps ordinary or unadvertised marker text as text without correction: %s', async (text) => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.(text, '');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const collected = collectCallbacks();

    expect(await adapter.generate(request(), collected.callbacks)).toEqual({
      type: 'completed', finish_reason: 'stop',
    });
    expect(streamer).toHaveBeenCalledOnce();
    expect(collected.text.map((event) => event.text).join('')).toBe(text);
    expect(collected.tools).toHaveLength(0);
  });

  it.each(['No tool is needed; I can answer your question directly.', 'Here is a code example:\n```text\n[调用 local_agent_read]\n```'])('allows a normal corrected answer with verified history: %s', async (answer) => {
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async (_chat, expected) => history(expected, {
        messageCount: expected === 13 ? 4 : 2,
      })),
    });
    let attempts = 0;
    const streamer: TestStreamer = vi.fn(async (input, callbacks) => {
      if (++attempts === 1) {
        callbacks.onTextChunk?.('[调用 local_agent_read] {"path":"README.md"}', '');
        return turn();
      }
      expect(input.prompt).toContain('If no tool is needed, answer normally instead.');
      callbacks.onTextChunk?.(answer, '');
      return turn({ requestMessageId: 12, responseMessageId: 13 });
    });
    const { adapter, sessions } = adapterWith(streamer, client);
    const collected = collectCallbacks();
    expect(await adapter.generate(request(), collected.callbacks)).toEqual({ type: 'completed', finish_reason: 'stop' });
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(collected.tools).toHaveLength(0);
    expect(collected.text.map((event) => event.text).join('')).toContain(answer);
    expect(sessions.getSession('session-1')).toMatchObject({ parentMessageId: 13, messageCount: 4, quarantined: false });
  });

  it.each(['[调用 local_agent_read]', '[调用 local_agent_read]\n{"path":"README.md"}', ''])('rejects a still malformed or empty correction without a third request: %s', async (answer) => {
    let attempts = 0;
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.(++attempts === 1 ? '[调用 local_agent_read]' : answer, '');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const collected = collectCallbacks();
    expect(await adapter.generate(request(), collected.callbacks)).toMatchObject({ type: 'failed', error: { code: 'TOOL_CALL_INVALID' } });
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(collected.tools).toHaveLength(0);
  });

  it('does not correct bracket text after a formal tool call has already been emitted', async () => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.('<local_agent_read>{"path":"README.md"}</local_agent_read>\n[调用 local_agent_read] {"path":"other.md"}', '');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const collected = collectCallbacks();
    expect(await adapter.generate(request(), collected.callbacks)).toEqual({ type: 'completed', finish_reason: 'tool_calls' });
    expect(streamer).toHaveBeenCalledOnce();
    expect(collected.tools).toHaveLength(1);
  });

  it('does not accept a corrected normal answer without verified history', async () => {
    const client = fakeClient({
      readHistorySnapshot: vi.fn(async (_chat, expected) => expected === 11 ? history(11) : null),
    });
    let attempts = 0;
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      if (++attempts === 1) {
        callbacks.onTextChunk?.('[调用 local_agent_read] {"path":"README.md"}', '');
        return turn();
      }
      callbacks.onTextChunk?.('No tool is needed.', '');
      return turn({ requestMessageId: 12, responseMessageId: 13 });
    });
    const { adapter, sessions } = adapterWith(streamer, client);
    const collected = collectCallbacks();
    expect(await adapter.generate(request(), collected.callbacks)).toEqual({ type: 'ambiguous', reason: 'deepseek_chain_unverified' });
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(collected.tools).toHaveLength(0);
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
  });

  it('keeps correction options frozen and stops on cancellation without replay', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const streamer: TestStreamer = vi.fn(async (input, callbacks, context) => {
      expect(input.modelType).toBe('expert');
      expect(input.thinkingEnabled).toBe(true);
      if (++attempts === 1) {
        callbacks.onTextChunk?.('[调用 local_agent_read] {"path":"README.md"}', '');
        return turn();
      }
      controller.abort();
      expect(context.signal?.aborted).toBe(true);
      throw new Error('cancelled');
    });
    const { adapter } = adapterWith(streamer);
    const collected = collectCallbacks(true);
    const result = await adapter.generate(request({ options: { model_type: 'expert', thinking_enabled: true, search_enabled: false } }), collected.callbacks, {
      signal: controller.signal,
      negotiatedCapabilities: { reasoning: true, structured_tool_calls: true, cancel: true, query: true },
    });
    expect(result.type).toBe('ambiguous');
    expect(streamer).toHaveBeenCalledTimes(2);
    expect(collected.tools).toHaveLength(0);
  });

  it('does not issue a corrective turn when the first malformed response chain is unverified', async () => {
    const client = fakeClient({ readHistorySnapshot: vi.fn(async () => null) });
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.('[调用 local_agent_read]', '');
      return turn();
    });
    const { adapter } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'ambiguous', reason: 'deepseek_chain_unverified',
    });
    expect(streamer).toHaveBeenCalledOnce();
  });

  it('never attempts a third webpage turn after a corrective dispatch becomes ambiguous', async () => {
    let attempts = 0;
    const streamer: TestStreamer = vi.fn(async (_input, callbacks, context) => {
      attempts += 1;
      if (attempts === 1) {
        callbacks.onTextChunk?.('[调用 local_agent_read]', '');
        return turn();
      }
      context.onDispatch?.();
      throw new Error('browser disconnected');
    });
    const { adapter } = adapterWith(streamer);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toEqual({
      type: 'ambiguous', reason: 'deepseek_turn_outcome_unknown',
    });
    expect(streamer).toHaveBeenCalledTimes(2);
  });

  it('splits multi-byte Unicode into independently valid full model.event frames', async () => {
    const unicode = '😀'.repeat(90_000);
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      callbacks.onTextChunk?.(unicode, 'not-retained');
      return turn();
    });
    const { adapter } = adapterWith(streamer);
    const collected = collectCallbacks();

    expect(await adapter.generate(request(), collected.callbacks)).toEqual({
      type: 'completed', finish_reason: 'stop',
    });
    expect(collected.text.length).toBeGreaterThan(1);
    expect(collected.text.map((event) => event.text).join('')).toBe(unicode);
    expect(collected.text.every((event) => !/^[\uDC00-\uDFFF]/u.test(event.text))).toBe(true);
    expect(collected.text.every((event) => !/[\uD800-\uDBFF]$/u.test(event.text))).toBe(true);
  });

  it('aborts and quarantines before parsing input beyond the cumulative UTF-8 budget', async () => {
    const oversized = 'x'.repeat(WEB_MODEL_TURN_BUDGETS.inboundUtf8Bytes + 1);
    let streamSignal: AbortSignal | undefined;
    const client = fakeClient();
    const streamer: TestStreamer = vi.fn(async (_input, callbacks, context) => {
      streamSignal = context.signal;
      callbacks.onTextChunk?.(oversized, '');
      return turn();
    });
    const { adapter, sessions } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toMatchObject({
      type: 'failed', error: { code: 'MODEL_OUTPUT_BUDGET_EXCEEDED' },
    });
    expect(streamSignal?.aborted).toBe(true);
    expect(client.readHistorySnapshot).not.toHaveBeenCalled();
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
  });

  it('rejects a tool event that cannot fit one 1 MiB protocol notification', async () => {
    const hugeArguments = '😀'.repeat(300_000);
    let streamSignal: AbortSignal | undefined;
    const client = fakeClient();
    const streamer: TestStreamer = vi.fn(async (_input, callbacks, context) => {
      streamSignal = context.signal;
      callbacks.onTextChunk?.(
        `<local_agent_read>{"path":${JSON.stringify(hugeArguments)}}</local_agent_read>`,
        '',
      );
      return turn();
    });
    const { adapter, sessions } = adapterWith(streamer, client);

    expect(await adapter.generate(request(), collectCallbacks().callbacks)).toMatchObject({
      type: 'failed', error: { code: 'MODEL_OUTPUT_BUDGET_EXCEEDED' },
    });
    expect(streamSignal?.aborted).toBe(true);
    expect(client.readHistorySnapshot).not.toHaveBeenCalled();
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
  });

  it('enforces a cumulative model event count budget', async () => {
    const streamer: TestStreamer = vi.fn(async (_input, callbacks) => {
      for (let index = 0; index <= WEB_MODEL_TURN_BUDGETS.events; index += 1) {
        callbacks.onTextChunk?.('x', '');
      }
      return turn();
    });
    const { adapter, sessions } = adapterWith(streamer);
    const collected = collectCallbacks();

    expect(await adapter.generate(request(), collected.callbacks)).toMatchObject({
      type: 'failed', error: { code: 'MODEL_OUTPUT_BUDGET_EXCEEDED' },
    });
    expect(collected.text).toHaveLength(WEB_MODEL_TURN_BUDGETS.events);
    expect(sessions.getSession('session-1')?.quarantined).toBe(true);
  });

  it('strictly rejects unknown fields and non-XML-safe tool names before browser access', async () => {
    const client = fakeClient();
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter } = adapterWith(streamer, client);
    const withUnknown = { ...request(), unexpected: true };
    const invalidTool = request({
      tools: [{
        name: 'bad tool',
        description: 'bad',
        input_schema: { type: 'object' },
      }],
    });

    await expect(adapter.generate(withUnknown, collectCallbacks().callbacks))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter.generate(invalidTool, collectCallbacks().callbacks))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(client.createClientHeaders).not.toHaveBeenCalled();
    expect(streamer).not.toHaveBeenCalled();
  });

  it('fails closed at bounded session/request capacity without evicting duplicate tombstones', async () => {
    const sessions = new WebModelSessionMap({ maxSessions: 1, maxRequests: 1 });
    const streamer: TestStreamer = vi.fn(async () => turn());
    const { adapter } = adapterWith(streamer, fakeClient(), sessions);
    await adapter.generate(request(), collectCallbacks().callbacks);

    await expect(adapter.generate(request({
      request_id: 'request-2',
      request_digest: DIGEST_B,
      session_id: 'session-2',
    }), collectCallbacks().callbacks)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(sessions.snapshot()).toMatchObject({ sessionCount: 1, requestCount: 1 });
  });
});
