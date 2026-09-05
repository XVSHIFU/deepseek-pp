import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type ToolCallBlock,
} from '@deepseek-ai/dsh-llm';
import {
  DeepSeekWebAdapter,
  serializeGenerateRequest,
} from '@deepseek-pp/dsh-llm-deepseek-web';
import type { DeepSeekWebBroker } from '@deepseek-pp/dsh-web-model-transport';
import type { ModelEvent } from '@deepseek-pp/web-model-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DeepSeekAutomationClient,
  SubmitPromptInput,
} from '../core/deepseek/active-client';
import { createDeepSeekWebModelTurnAdapter } from '../core/harness-bridge/deepseek-turn-adapter';
import type { WebModelTurnRequest } from '../core/harness-bridge/model-turn-port';
import { createStreamingToolCallParser } from '../core/interceptor/streaming-tool-call-parser';
import type { ToolDescriptor } from '../core/tool';

// Official dsh-tool-fs uses `read` and snake_case `file_path`, not read_file/path.
// This fixture only freezes the model wire. DSH owns schema/policy enforcement.
const READ_TOOL = {
  name: 'read',
  description: 'Read a file or list a directory.',
  parameters: {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['file_path'],
  },
};
const CALL_ID = '10000000-0000-4000-8000-000000000001';
const XML_CALL = '<read>{"file_path":"note.txt","limit":20}</read>';

afterEach(() => { vi.restoreAllMocks(); });

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'deepseek-web',
    model: 'current-web-session',
    sessionId: 'session-tool-wire' as GenerateOptions['sessionId'],
    tools: [READ_TOOL],
    messages: [createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read note.txt and summarize it.' }],
    })],
    ...overrides,
  };
}

function request(overrides: Partial<WebModelTurnRequest> = {}): WebModelTurnRequest {
  return {
    schema_version: 1,
    ...serializeGenerateRequest(options(), { requestId: 'request-wire-1' }),
    ...overrides,
  };
}

function browserFixture(replies: readonly (readonly string[])[]) {
  const inputs: SubmitPromptInput[] = [];
  let turn = 0;
  const client: DeepSeekAutomationClient = {
    createClientHeaders: () => ({ Authorization: 'Bearer synthetic-test-only' }),
    createChatSession: vi.fn(async () => 'chat-wire'),
    createPowHeaders: vi.fn(async () => ({})),
    submitPrompt: vi.fn(async () => { throw new Error('Nonstreaming path is forbidden'); }),
    submitPromptStreaming: vi.fn(async (input, callbacks, context) => {
      inputs.push(input);
      context.onDispatch?.();
      const chunks = replies[turn];
      if (!chunks) throw new Error('Unexpected extra model request');
      turn += 1;
      for (const chunk of chunks) callbacks.onTextChunk?.(chunk, '');
      return {
        assistantText: '',
        finished: true,
        requestMessageId: turn * 2,
        responseMessageId: turn * 2 + 1,
      };
    }),
    readHistorySnapshot: vi.fn(async (_chatId, responseId) => ({
      chatSessionId: 'chat-wire',
      parentMessageId: responseId,
      assistantMessageId: responseId,
      assistantParentMessageId: responseId - 1,
      requestParentMessageId: responseId === 3 ? null : responseId - 2,
      messageCount: responseId - 1,
      verifiedAt: 1_000,
    })),
    normalizeMessageId: (value) => typeof value === 'number' ? value : null,
    buildSessionUrl: () => 'https://chat.deepseek.com/',
  };
  const adapter = createDeepSeekWebModelTurnAdapter({ client });
  return { adapter, inputs, client };
}

async function browserTurn(chunks: readonly string[], input = request()) {
  const fixture = browserFixture([chunks]);
  const events: ModelEvent[] = [];
  const terminal = await fixture.adapter.generate(input, {
    onAccepted() {},
    onTextDelta: (event) => { events.push(event); },
    onToolCall: (event) => { events.push(event); },
  });
  return { ...fixture, events, terminal };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('Harness tool wire production mapping', () => {
  it('round-trips the DSH schema, XML call, tool result, and next model text', async () => {
    const fixture = browserFixture([[XML_CALL], ['The note says hello.']]);
    // Only transport is in-memory here; both production model adapters are real.
    const broker: DeepSeekWebBroker = {
      async *generate(input) {
        const events: ModelEvent[] = [];
        const terminal = await fixture.adapter.generate({ schema_version: 1, ...input }, {
          onAccepted() {},
          onTextDelta: (event) => { events.push(event); },
          onToolCall: (event) => { events.push(event); },
        });
        yield* events;
        yield terminal;
      },
      cancel: vi.fn(async () => { throw new Error('Unexpected cancel'); }),
      query: vi.fn(async () => { throw new Error('Unexpected query'); }),
    };
    let requestIndex = 0;
    const dsh = new DeepSeekWebAdapter({ broker, createRequestId: () => `request-wire-${++requestIndex}` });
    const first = options();
    const firstChunks = await collect(dsh.stream(first));
    expect(firstChunks.map((chunk) => chunk.type)).toEqual([
      'block-start', 'tool-call-delta', 'block-end', 'finish',
    ]);
    const end = firstChunks.find((chunk) => chunk.type === 'block-end');
    if (end?.type !== 'block-end' || end.block.type !== 'tool-call') throw new Error('Missing tool call');
    const call: ToolCallBlock = end.block;
    expect(call).toEqual({
      type: 'tool-call', id: expect.any(String), name: 'read',
      arguments: '{"file_path":"note.txt","limit":20}',
    });
    expect(firstChunks[1]).toEqual({
      type: 'tool-call-delta', index: 0, id: call.id, name: 'read', argumentsDelta: call.arguments,
    });
    expect(firstChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } });
    expect(fixture.inputs[0].prompt).toContain(`Parameters JSON Schema: ${JSON.stringify(READ_TOOL.parameters)}`);
    expect(fixture.inputs[0].prompt).toContain('Valid call format for read:\n<read>');

    const second = options({ messages: [
      ...first.messages,
      createAssistantMessage({
        source: { provider: 'deepseek-web', model: 'current-web-session' },
        content: [call],
      }),
      createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: 'hello from the fixture' }],
        isError: false,
      }),
    ] });
    const secondChunks = await collect(dsh.stream(second));
    const transcript = serializeGenerateRequest(second, { requestId: 'next' }).input.messages;
    expect(transcript.at(-2)).toEqual({ role: 'assistant', content: [{
      type: 'tool_call', tool_call_id: call.id, name: 'read',
      arguments: { file_path: 'note.txt', limit: 20 },
    }] });
    expect(transcript.at(-1)).toEqual({ role: 'tool', content: [{
      type: 'tool_result', tool_call_id: call.id,
      content: [{ type: 'text', text: 'hello from the fixture' }], is_error: false,
    }] });
    expect(fixture.inputs[1].prompt).toContain(JSON.stringify(transcript));
    expect(fixture.inputs.map((input) => input.parentMessageId)).toEqual([null, 3]);
    expect(fixture.client.createChatSession).toHaveBeenCalledOnce();
    expect(secondChunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'The note says hello.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'The note says hello.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
  });

  it('keeps the call identity and payload invariant at every stream split boundary', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(CALL_ID);
    const wire = 'Checking. ' + XML_CALL;
    for (let split = 0; split <= wire.length; split += 1) {
      const result = await browserTurn([wire.slice(0, split), wire.slice(split)]);
      expect(result.terminal).toEqual({ type: 'completed', finish_reason: 'tool_calls' });
      expect(result.events.filter((event) => event.type === 'tool_call')).toEqual([{
        type: 'tool_call', tool_call_id: CALL_ID, name: 'read',
        arguments: { file_path: 'note.txt', limit: 20 },
      }]);
      expect(result.events.flatMap((event) => event.type === 'text_delta' ? event.text : []).join('')).toBe('Checking. ');
    }
  });

  it.each([
    ['unknown tool', '<missing>{"file_path":"note.txt"}</missing>'],
    ['unknown malformed payload', '<missing>[</missing>'],
    ['malformed JSON', '<read>{bad}</read>'],
    ['array arguments', '<read>[]</read>'],
    ['unclosed body', '<read>{"file_path":"note.txt"}'],
    ['unclosed opening tag', '<read'],
    ['partial opening tag', '<rea'],
    ['overflow', '<read>{"file_path":"' + 'x'.repeat(1_048_576) + '"}</read>'],
  ])('fails %s rather than accepting an ordinary successful answer', async (_name, wire) => {
    const chunks = wire.length > 1000 ? [wire] : Array.from(wire);
    const result = await browserTurn(chunks);
    expect(result.terminal).toMatchObject({
      type: 'failed', error: { code: 'TOOL_CALL_INVALID', retryable: false, external_outcome: 'started' },
    });
    expect(result.events.filter((event) => event.type === 'tool_call')).toEqual([]);
    expect(result.client.readHistorySnapshot).not.toHaveBeenCalled();
  });

  it('rejects a duplicate parser-generated call ID within one request', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(CALL_ID);
    const result = await browserTurn([XML_CALL, XML_CALL]);
    expect(result.terminal).toMatchObject({ type: 'failed', error: { code: 'TOOL_CALL_INVALID' } });
    expect(result.events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
  });

  it('does not misclassify ordinary visible HTML or a literal less-than sign', async () => {
    const wire = '<b>Here is an answer.</b><div class="note">Fine</div> 2 < 3; trailing <';
    const result = await browserTurn(Array.from(wire));
    expect(result.terminal).toEqual({ type: 'completed', finish_reason: 'stop' });
    expect(result.events.flatMap((event) => event.type === 'text_delta' ? event.text : []).join('')).toBe(wire);
  });

  it('continues finding advertised tools inside ordinary markup', async () => {
    const result = await browserTurn(Array.from('<div>Inspecting ' + XML_CALL + '</div>'));
    expect(result.terminal).toEqual({ type: 'completed', finish_reason: 'tool_calls' });
    expect(result.events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    expect(result.events.flatMap((event) => event.type === 'text_delta' ? event.text : []).join(''))
      .toBe('<div>Inspecting </div>');
  });

  it('rejects a JSON tool attempt when no tools were advertised', async () => {
    const result = await browserTurn(Array.from(XML_CALL), request({ tools: [] }));
    expect(result.terminal).toMatchObject({ type: 'failed', error: { code: 'TOOL_CALL_INVALID' } });
    expect(result.events.filter((event) => event.type === 'tool_call')).toEqual([]);
  });

  it('keeps the default Mode B parser behavior for unknown tags and partial openings', () => {
    const descriptor: ToolDescriptor = {
      id: 'fixture-read', name: 'read', invocationName: 'read', title: 'read',
      description: READ_TOOL.description, inputSchema: READ_TOOL.parameters,
      provider: { kind: 'local', id: 'fixture', displayName: 'Fixture', transport: 'in_process' },
      execution: { mode: 'disabled', enabled: false, risk: 'high' },
    };
    const parser = createStreamingToolCallParser([descriptor]);
    expect(parser.append('<missing>{"file_path":"note.txt"}</missing><rea')).toEqual({
      started: [], completed: [], failed: [], streamed: [],
    });
    expect(parser.flush()).toEqual({ started: [], completed: [], failed: [], streamed: [] });
  });
});
