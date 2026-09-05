import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';

import { DeepSeekWebModelHost, createPairingToken } from '../packages/dsh-web-model-transport/src/index';
import { serializeGenerateRequest } from '../packages/dsh-llm-deepseek-web/src/request';
import { HarnessBridgeClient, type HarnessBridgeSocket } from '../core/harness-bridge/client';
import { HarnessBridgeCoordinator } from '../core/harness-bridge/coordinator';
import type { HarnessBridgeRecoveryIndex } from '../core/harness-bridge/result-cache';
import { createDeepSeekWebModelTurnAdapter } from '../core/harness-bridge/deepseek-turn-adapter';
import type { DeepSeekAutomationClient } from '../core/deepseek/automation-client-port';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const disposers: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
  vi.unstubAllGlobals();
});

it.each(['ready', 'missing-auth'] as const)('runs the actual browser composition for an empty-tool DSH request (%s)', async (mode) => {
  vi.stubGlobal('localStorage', undefined);
  vi.stubGlobal('crypto', webcrypto);
  let recoveryIndex: HarnessBridgeRecoveryIndex | undefined;
  const token = createPairingToken();
  const host = new DeepSeekWebModelHost({ pairingToken: token, allowedOrigins: [ORIGIN] });
  const address = await host.start();
  disposers.push(() => host.stop());
  const loadedHeaders = vi.fn(async () => mode === 'missing-auth' ? null : ({ Authorization: 'Bearer local-test-only' }));
  const client: DeepSeekAutomationClient = {
    createClientHeaders: vi.fn(() => { throw new Error('No page localStorage in service worker'); }),
    createChatSession: vi.fn(async () => 'chat-1'),
    createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'local-test-only' })),
    submitPrompt: vi.fn(async () => ({ assistantText: 'ok', responseMessageId: 11, requestMessageId: 10, finished: true })),
    submitPromptStreaming: vi.fn(async (_input, callbacks, context) => {
      context.onDispatch?.();
      callbacks.onTextChunk?.('ok', 'ok');
      return { assistantText: 'ok', responseMessageId: 11, requestMessageId: 10, finished: true };
    }),
    readHistorySnapshot: vi.fn(async () => ({
      chatSessionId: 'chat-1', parentMessageId: 11, assistantMessageId: 11,
      assistantParentMessageId: 10, requestParentMessageId: null, messageCount: 2, verifiedAt: 1000,
    })),
    normalizeMessageId: (value) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null,
    buildSessionUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
  };
  const turnAdapter = createDeepSeekWebModelTurnAdapter({ client, loadClientHeaders: loadedHeaders });
  const turnErrors: unknown[] = [];
  const coordinator = new HarnessBridgeCoordinator({
    recoveryStorage: {
      read: async () => structuredClone(recoveryIndex),
      write: async (value) => { recoveryIndex = structuredClone(value); },
    },
    settings: {
      read: async () => ({ version: 1, enabled: true, port: address.port, pairingToken: token }),
      update: async () => { throw new Error('Not used'); },
    },
    turnPort: {
      generate: async (...args) => {
        try { return await turnAdapter.generate(...args); }
        catch (error) { turnErrors.push(error); throw error; }
      },
      cancel: (input) => turnAdapter.cancel(input),
    },
    createClient: () => new HarnessBridgeClient({
      port: address.port, pairingToken: token,
      browserInstanceId: 'abcdefghijklmnopabcdefghijklmnop', clientVersion: '1.14.0',
    }, {
      webSocketFactory: (url, subprotocol) => new WebSocket(url, subprotocol, { origin: ORIGIN }) as unknown as HarnessBridgeSocket,
    }),
  });
  disposers.push(() => coordinator.stop());
  await coordinator.initialize();
  await vi.waitFor(() => expect(host.hasAuthenticatedPeer).toBe(true));
  const request = serializeGenerateRequest({
    provider: 'deepseek-web', model: 'current-web-session', sessionId: 'session-smoke' as GenerateOptions['sessionId'],
    tools: [], messages: [createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply exactly ok.' }],
    })],
  });
  const events = [];
  if (mode === 'missing-auth') {
    const consume = async () => { for await (const event of host.generate(request)) events.push(event); };
    await expect(consume()).rejects.toMatchObject({ code: 'DEEPSEEK_AUTH_REQUIRED', externalOutcome: 'not_started' });
    expect(client.createChatSession).not.toHaveBeenCalled();
    expect(client.createPowHeaders).not.toHaveBeenCalled();
    expect(client.submitPromptStreaming).not.toHaveBeenCalled();
    return;
  }
  try { for await (const event of host.generate(request)) events.push(event); }
  catch (error) { if (turnErrors.length > 0) throw turnErrors[0]; throw error; }
  expect(events).toEqual([{ type: 'text_delta', text: 'ok' }, { type: 'completed', finish_reason: 'stop' }]);
  expect(loadedHeaders).toHaveBeenCalledOnce();
  expect(client.submitPromptStreaming).toHaveBeenCalledOnce();
});
