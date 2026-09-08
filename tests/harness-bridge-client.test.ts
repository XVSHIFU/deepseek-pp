import {
  encodeWebModelFrame,
  type BridgeCapabilities,
  type WebModelFrame,
} from '../packages/web-model-protocol/src/index.ts';
import {
  HARNESS_BRIDGE_SUBPROTOCOL,
  HarnessBridgeClient,
  HarnessBridgeClientError,
  type HarnessBridgeClientConfig,
  type HarnessBridgeScheduler,
  type HarnessBridgeSocket,
  type HarnessBridgeSocketEventMap,
} from '../core/harness-bridge';
import {
  cancelRequest,
  generateRequest,
  queryRequest,
} from './fixtures/harness-bridge/protocol-v1/frames';
import { describe, expect, it } from 'vitest';

const TOKEN = 'A'.repeat(43);

describe('Harness bridge browser client', () => {
  it('constructs only the fixed loopback URL/subprotocol and keeps the token out of URL and state', () => {
    const fixture = createFixture();
    const states: unknown[] = [];
    fixture.client.subscribe((state) => states.push(state));
    fixture.client.start();
    fixture.client.start();
    expect(fixture.factory.calls).toEqual([{
      url: 'ws://127.0.0.1:43123/web-model/v1',
      subprotocol: HARNESS_BRIDGE_SUBPROTOCOL,
    }]);
    const socket = fixture.factory.sockets[0]!;
    socket.open();
    const hello = socket.sentFrame(0) as any;
    expect(hello.method).toBe('bridge.hello');
    expect(hello.params.pairing_token).toBe(TOKEN);
    expect(fixture.factory.calls[0]?.url).not.toContain(TOKEN);
    expect(JSON.stringify(states)).not.toContain(TOKEN);
    socket.message(helloResponse(hello));
    expect(fixture.client.state).toMatchObject({ phase: 'ready', attempt: 0 });
    expect(fixture.client.state.capabilities).not.toHaveProperty('reasoning');
    expect(JSON.stringify(fixture.client.state)).not.toContain(TOKEN);
  });

  it('advertises reasoning by default for the production client configuration', () => {
    const factory = new FakeWebSocketFactory();
    const scheduler = new FakeScheduler();
    const { capabilities: _explicitCapabilities, ...config } = validConfig();
    const client = new HarnessBridgeClient(config, dependencies(factory, scheduler));

    client.start();
    const socket = factory.sockets[0]!;
    socket.open();
    const hello = socket.sentFrame(0) as any;

    expect(hello.params.capabilities).toEqual({
      text: true,
      reasoning: true,
      structured_tool_calls: true,
      usage: true,
      cancel: true,
      query: true,
    });
    socket.message(helloResponse(hello));
    expect(client.state).toMatchObject({
      phase: 'ready',
      capabilities: { reasoning: true },
    });
  });

  it('negotiates capabilities and validates generate, cancel, query, responses, and events in both directions', () => {
    const fixture = createFixture();
    const socket = makeReady(fixture);
    const received: string[] = [];
    fixture.client.subscribeRequests((frame) => received.push(frame.method));

    socket.message(generateRequest);
    fixture.client.send({
      jsonrpc: '2.0',
      id: generateRequest.id,
      result: {
        schema_version: 1,
        type: 'model.accepted',
        request_id: generateRequest.params.request_id,
        request_digest: generateRequest.params.request_digest,
        status: 'accepted',
      },
    });
    fixture.client.send({
      jsonrpc: '2.0',
      method: 'model.event',
      params: {
        schema_version: 1,
        request_id: generateRequest.params.request_id,
        sequence: 1,
        event: { type: 'text_delta', text: 'done' },
      },
    });
    const terminal = { type: 'completed', finish_reason: 'stop' } as const;
    fixture.client.send({
      jsonrpc: '2.0',
      method: 'model.event',
      params: { schema_version: 1, request_id: generateRequest.params.request_id, sequence: 2, event: terminal },
    });

    socket.message(cancelRequest);
    fixture.client.send({
      jsonrpc: '2.0',
      id: cancelRequest.id,
      result: {
        schema_version: 1,
        type: 'model.cancelled',
        request_id: cancelRequest.params.request_id,
        request_digest: cancelRequest.params.request_digest,
        status: 'already_terminal',
      },
    });
    socket.message(queryRequest);
    fixture.client.send({
      jsonrpc: '2.0',
      id: queryRequest.id,
      result: {
        schema_version: 1,
        type: 'model.status',
        request_id: queryRequest.params.request_id,
        request_digest: queryRequest.params.request_digest,
        status: 'completed',
        last_sequence: 2,
        terminal,
      },
    });

    expect(received).toEqual(['model.generate', 'model.cancel', 'model.query']);
    const outbound = socket.sent.slice(1).map((text) => JSON.parse(text) as WebModelFrame);
    expect(outbound.map((frame) => 'method' in frame ? frame.method : 'result' in frame ? frame.result.type : 'error'))
      .toEqual(['model.accepted', 'model.event', 'model.event', 'model.cancelled', 'model.status']);
    expect(fixture.client.state.phase).toBe('ready');
  });

  it('fails closed when unnegotiated reasoning or a reversed outbound request is sent', () => {
    const reasoningFixture = createFixture();
    const reasoningSocket = makeReady(reasoningFixture);
    reasoningSocket.message(generateRequest);
    reasoningFixture.client.send(acceptedFor(generateRequest));
    expect(() => reasoningFixture.client.send({
      jsonrpc: '2.0',
      method: 'model.event',
      params: {
        schema_version: 1,
        request_id: generateRequest.params.request_id,
        sequence: 1,
        event: { type: 'reasoning_delta', text: 'private', retention: 'ephemeral' },
      },
    })).toThrowError(HarnessBridgeClientError);
    expect(reasoningFixture.client.state).toMatchObject({ phase: 'protocol_error', errorCode: 'PROTOCOL_ERROR' });

    const directionFixture = createFixture();
    makeReady(directionFixture);
    expect(() => directionFixture.client.send(generateRequest)).toThrowError(HarnessBridgeClientError);
    expect(directionFixture.client.state.phase).toBe('protocol_error');
  });

  it('classifies hello rejection/timeout without exposing the token and rejects pre-handshake traffic', () => {
    const rejection = createFixture();
    rejection.client.start();
    const rejectionSocket = rejection.factory.sockets[0]!;
    rejectionSocket.open();
    const hello = rejectionSocket.sentFrame(0) as any;
    rejectionSocket.message({
      jsonrpc: '2.0',
      id: hello.id,
      error: {
        code: -32001,
        message: 'Pairing rejected',
        data: { schema_version: 1, error_code: 'AUTH_FAILED', retryable: false, external_outcome: 'not_started' },
      },
    });
    expect(rejection.client.state).toMatchObject({ phase: 'needs_pairing', errorCode: 'PAIRING_REJECTED' });
    expect(JSON.stringify(rejection.client.state)).not.toContain(TOKEN);

    const timeout = createFixture();
    timeout.client.start();
    timeout.factory.sockets[0]!.open();
    timeout.scheduler.advance(50);
    expect(timeout.client.state).toMatchObject({ phase: 'needs_pairing', errorCode: 'HELLO_TIMEOUT' });
    expect(timeout.scheduler.activeCount).toBe(0);

    const premature = createFixture();
    premature.client.start();
    const prematureSocket = premature.factory.sockets[0]!;
    prematureSocket.open();
    prematureSocket.message(generateRequest);
    expect(premature.client.state.phase).toBe('protocol_error');
  });

  it('classifies only explicit authentication close reasons as pairing failures', () => {
    const authFailure = createFixture();
    authFailure.client.start();
    const authSocket = authFailure.factory.sockets[0]!;
    authSocket.open();
    authSocket.closed(1008, 'AUTH_FAILED');
    expect(authFailure.client.state).toMatchObject({ phase: 'needs_pairing', errorCode: 'PAIRING_REJECTED' });

    const protocolFailure = createFixture();
    protocolFailure.client.start();
    const protocolSocket = protocolFailure.factory.sockets[0]!;
    protocolSocket.open();
    protocolSocket.closed(1008, 'PROTOCOL_ERROR');
    expect(protocolFailure.client.state).toMatchObject({ phase: 'protocol_error', errorCode: 'PROTOCOL_ERROR' });

    const networkFailure = createFixture();
    networkFailure.client.start();
    const networkSocket = networkFailure.factory.sockets[0]!;
    networkSocket.open();
    networkSocket.error();
    expect(networkFailure.client.state).toMatchObject({ phase: 'retry_wait', errorCode: 'CONNECTION_FAILED' });
  });

  it('rejects a hello response that selects a capability the browser did not offer', () => {
    const fixture = createFixture();
    fixture.client.start();
    const socket = fixture.factory.sockets[0]!;
    socket.open();
    const hello = socket.sentFrame(0) as any;
    socket.message(helloResponse(hello, { ...hello.params.capabilities, reasoning: true }));
    expect(fixture.client.state).toMatchObject({ phase: 'protocol_error', errorCode: 'PROTOCOL_ERROR' });
  });

  it('isolates stale socket callbacks and never creates a second socket for duplicate lifecycle calls', () => {
    const fixture = createFixture();
    fixture.client.start();
    fixture.client.start();
    fixture.client.reconnect();
    const stale = fixture.factory.sockets[0]!;
    expect(fixture.factory.sockets).toHaveLength(1);
    stale.error();
    expect(fixture.client.state.phase).toBe('retry_wait');
    fixture.scheduler.advance(10);
    const current = fixture.factory.sockets[1]!;
    expect(current).toBeDefined();
    expect(fixture.factory.activeSocketCount).toBe(1);

    stale.open();
    stale.message(generateRequest);
    stale.closed(1000);
    expect(fixture.client.state.phase).toBe('connecting');
    expect(current.sent).toHaveLength(0);
    current.open();
    const hello = current.sentFrame(0) as any;
    current.message(helloResponse(hello));
    expect(fixture.client.state.phase).toBe('ready');
    stale.error();
    expect(fixture.client.state.phase).toBe('ready');
  });

  it('uses exponential retry with a hard maximum delay and bounded attempts', () => {
    const fixture = createFixture({
      timing: { ...testTiming(), retryBaseMs: 10, retryMaxMs: 25, maxAttempts: 4 },
    });
    fixture.client.start();
    fixture.factory.sockets[0]!.error();
    expect(fixture.client.state.nextRetryAtMs).toBe(1_010);
    fixture.scheduler.advance(10);
    fixture.factory.sockets[1]!.error();
    expect(fixture.client.state.nextRetryAtMs).toBe(1_030);
    fixture.scheduler.advance(20);
    fixture.factory.sockets[2]!.error();
    expect(fixture.client.state.nextRetryAtMs).toBe(1_055);
    fixture.scheduler.advance(25);
    fixture.factory.sockets[3]!.error();
    expect(fixture.client.state).toMatchObject({ phase: 'offline', attempt: 4, errorCode: 'RETRY_EXHAUSTED' });
    expect(fixture.scheduler.activeCount).toBe(0);
  });

  it('sends bounded heartbeats and stop idempotently clears every timer', () => {
    const fixture = createFixture();
    const socket = makeReady(fixture);
    expect(fixture.scheduler.activeCount).toBe(1);
    fixture.scheduler.advance(20);
    expect(socket.sentFrame(1)).toMatchObject({
      method: 'bridge.heartbeat',
      params: { connection_id: 'connection-test', sent_at_ms: 1_020 },
    });
    expect(fixture.scheduler.activeCount).toBe(1);
    fixture.client.stop();
    fixture.client.stop();
    const sent = socket.sent.length;
    expect(fixture.client.state).toEqual({ phase: 'stopped', attempt: 0 });
    expect(fixture.scheduler.activeCount).toBe(0);
    fixture.scheduler.advance(1_000);
    expect(socket.sent).toHaveLength(sent);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('rebuilds cleanly as a new service-worker instance', () => {
    const sharedFactory = new FakeWebSocketFactory();
    const firstScheduler = new FakeScheduler();
    const first = new HarnessBridgeClient(validConfig(), dependencies(sharedFactory, firstScheduler));
    makeReady({ client: first, factory: sharedFactory, scheduler: firstScheduler });
    first.stop();

    const secondScheduler = new FakeScheduler();
    const second = new HarnessBridgeClient(validConfig(), dependencies(sharedFactory, secondScheduler));
    makeReady({ client: second, factory: sharedFactory, scheduler: secondScheduler }, 1);
    expect(first.state.phase).toBe('stopped');
    expect(second.state.phase).toBe('ready');
    expect(sharedFactory.sockets).toHaveLength(2);
  });

  it('isolates throwing and reentrant state listeners without leaving sockets or timers unmanaged', () => {
    const initialFactory = new FakeWebSocketFactory();
    const initialScheduler = new FakeScheduler();
    let initialCalls = 0;
    const initialThrow = new HarnessBridgeClient(validConfig(), {
      ...dependencies(initialFactory, initialScheduler),
      listenerErrorSink: () => { throw new Error('sink failure must be isolated'); },
    });
    initialThrow.subscribe(() => {
      initialCalls += 1;
      throw new Error('initial observer failure');
    });
    initialThrow.start();
    expect(initialCalls).toBe(1);
    initialThrow.stop();
    expect(initialFactory.activeSocketCount).toBe(0);
    expect(initialScheduler.activeCount).toBe(0);

    const throwingFactory = new FakeWebSocketFactory();
    const throwingScheduler = new FakeScheduler();
    const listenerErrors: string[] = [];
    const throwing = new HarnessBridgeClient(validConfig(), {
      ...dependencies(throwingFactory, throwingScheduler),
      listenerErrorSink: (_error, source) => listenerErrors.push(source),
    });
    let calls = 0;
    throwing.subscribe((state) => {
      calls += 1;
      if (state.phase === 'connecting') throw new Error('observer failed');
    });
    throwing.start();
    expect(listenerErrors).toEqual(['state_listener']);
    expect(calls).toBe(2);
    throwing.stop();
    expect(calls).toBe(2);
    expect(throwingFactory.activeSocketCount).toBe(0);
    expect(throwingScheduler.activeCount).toBe(0);

    const startStop = createFixture();
    startStop.client.subscribe((state) => {
      if (state.phase === 'connecting') startStop.client.stop();
    });
    startStop.client.start();
    expect(startStop.client.state.phase).toBe('stopped');
    expect(startStop.factory.activeSocketCount).toBe(0);
    expect(startStop.scheduler.activeCount).toBe(0);
    startStop.factory.sockets[0]!.open();
    expect(startStop.factory.sockets[0]!.sent).toHaveLength(0);

    const retryStop = createFixture();
    retryStop.client.subscribe((state) => {
      if (state.phase === 'retry_wait') retryStop.client.stop();
    });
    retryStop.client.start();
    retryStop.factory.sockets[0]!.error();
    expect(retryStop.client.state.phase).toBe('stopped');
    expect(retryStop.factory.activeSocketCount).toBe(0);
    expect(retryStop.scheduler.activeCount).toBe(0);
    retryStop.scheduler.advance(1_000);
    expect(retryStop.factory.sockets).toHaveLength(1);

    const readyStop = createFixture();
    readyStop.client.subscribe((state) => {
      if (state.phase === 'ready') readyStop.client.stop();
    });
    readyStop.client.start();
    const readySocket = readyStop.factory.sockets[0]!;
    readySocket.open();
    readySocket.message(helloResponse(readySocket.sentFrame(0)));
    expect(readyStop.client.state.phase).toBe('stopped');
    expect(readyStop.factory.activeSocketCount).toBe(0);
    expect(readyStop.scheduler.activeCount).toBe(0);
  });

  it('reports request handler failures separately and fails the connection closed', () => {
    const factory = new FakeWebSocketFactory();
    const scheduler = new FakeScheduler();
    const errors: string[] = [];
    const client = new HarnessBridgeClient(validConfig(), {
      ...dependencies(factory, scheduler),
      listenerErrorSink: (_error, source) => errors.push(source),
    });
    const fixture = { client, factory, scheduler };
    const socket = makeReady(fixture);
    let secondHandlerCalled = false;
    client.subscribeRequests(() => { throw new Error('adapter failed'); });
    client.subscribeRequests(() => { secondHandlerCalled = true; });
    socket.message(generateRequest);
    expect(client.state).toMatchObject({ phase: 'handler_error', errorCode: 'HANDLER_FAILED' });
    expect(client.state.phase).not.toBe('protocol_error');
    expect(errors).toEqual(['request_listener']);
    expect(secondHandlerCalled).toBe(false);
    expect(factory.activeSocketCount).toBe(0);
    expect(scheduler.activeCount).toBe(0);
  });

  it('hydrates a recovered checkpoint before answering a query in a rebuilt worker', () => {
    const fixture = createFixture();
    const socket = makeReady(fixture);
    const terminal = { type: 'completed', finish_reason: 'stop' } as const;
    fixture.client.hydrateRequestCheckpoint({
      request_id: queryRequest.params.request_id,
      request_digest: queryRequest.params.request_digest,
      status: 'completed',
      last_sequence: 2,
      terminal,
    });
    const received: string[] = [];
    fixture.client.subscribeRequests((frame) => received.push(frame.method));
    socket.message(queryRequest);
    fixture.client.send({
      jsonrpc: '2.0',
      id: queryRequest.id,
      result: {
        schema_version: 1,
        type: 'model.status',
        request_id: queryRequest.params.request_id,
        request_digest: queryRequest.params.request_digest,
        status: 'completed',
        last_sequence: 2,
        terminal,
      },
    });
    expect(received).toEqual(['model.query']);
    expect(fixture.client.state.phase).toBe('ready');

    const notReady = createFixture();
    expect(() => notReady.client.hydrateRequestCheckpoint({
      request_id: 'request-1',
      request_digest: 'a'.repeat(64),
      status: 'accepted',
      last_sequence: 0,
    })).toThrowError(/NOT_READY/);
  });

  it('retries socket send failures instead of misclassifying them as protocol errors', () => {
    const helloFailure = createFixture();
    helloFailure.client.start();
    const helloSocket = helloFailure.factory.sockets[0]!;
    helloSocket.failNextSend = true;
    helloSocket.open();
    expect(helloFailure.client.state).toMatchObject({ phase: 'retry_wait', errorCode: 'SOCKET_SEND_FAILED' });

    const outboundFailure = createFixture();
    const outboundSocket = makeReady(outboundFailure);
    outboundSocket.message(generateRequest);
    outboundSocket.failNextSend = true;
    expect(() => outboundFailure.client.send(acceptedFor(generateRequest))).toThrowError(/SOCKET_SEND_FAILED/);
    expect(outboundFailure.client.state).toMatchObject({ phase: 'retry_wait', errorCode: 'SOCKET_SEND_FAILED' });
  });

  it('strictly rejects invalid ports, tokens, identifiers, timing, and unknown fields', () => {
    expect(() => new HarnessBridgeClient({ ...validConfig(), port: 0 })).toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), pairingToken: 'secret' })).toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), pairingToken: 'A'.repeat(130) }))
      .toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), pairingToken: 'A'.repeat(128) })).not.toThrow();
    expect(() => new HarnessBridgeClient({ ...validConfig(), browserInstanceId: '../bad' })).toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), clientVersion: '' })).toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), timing: { ...testTiming(), retryMaxMs: 9 } }))
      .toThrowError(HarnessBridgeClientError);
    expect(() => new HarnessBridgeClient({ ...validConfig(), arbitraryUrl: 'ws://evil.example' }))
      .toThrowError(HarnessBridgeClientError);
  });
});

interface Fixture {
  readonly client: HarnessBridgeClient;
  readonly factory: FakeWebSocketFactory;
  readonly scheduler: FakeScheduler;
}

function createFixture(overrides: Partial<HarnessBridgeClientConfig> = {}): Fixture {
  const factory = new FakeWebSocketFactory();
  const scheduler = new FakeScheduler();
  const client = new HarnessBridgeClient(
    { ...validConfig(), ...overrides },
    dependencies(factory, scheduler),
  );
  return { client, factory, scheduler };
}

function dependencies(factory: FakeWebSocketFactory, scheduler: FakeScheduler) {
  let id = 0;
  return {
    webSocketFactory: factory.create,
    scheduler,
    clock: scheduler,
    idFactory: () => `id-${++id}`,
  };
}

function validConfig(): HarnessBridgeClientConfig {
  return {
    port: 43_123,
    pairingToken: TOKEN,
    browserInstanceId: 'browser-test-1',
    clientVersion: '1.14.0',
    timing: testTiming(),
    capabilities: { text: true, structured_tool_calls: true, usage: true, cancel: true, query: true },
  };
}

function testTiming() {
  return {
    connectTimeoutMs: 100,
    helloTimeoutMs: 50,
    heartbeatIntervalMs: 20,
    retryBaseMs: 10,
    retryMaxMs: 25,
    maxAttempts: 4,
  };
}

function makeReady(fixture: Fixture, socketIndex = 0): FakeWebSocket {
  fixture.client.start();
  const socket = fixture.factory.sockets[socketIndex]!;
  socket.open();
  const hello = socket.sentFrame(0) as any;
  socket.message(helloResponse(hello));
  expect(fixture.client.state.phase).toBe('ready');
  return socket;
}

function helloResponse(hello: any, capabilities?: BridgeCapabilities) {
  return {
    jsonrpc: '2.0',
    id: hello.id,
    result: {
      schema_version: 1,
      type: 'bridge.hello',
      connection_id: 'connection-test',
      status: 'ready',
      capabilities: capabilities ?? hello.params.capabilities,
    },
  };
}

function acceptedFor(request: typeof generateRequest) {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      schema_version: 1,
      type: 'model.accepted',
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      status: 'accepted',
    },
  };
}

class FakeWebSocketFactory {
  readonly sockets: FakeWebSocket[] = [];
  readonly calls: Array<{ url: string; subprotocol: string }> = [];

  readonly create = (url: string, subprotocol: string): HarnessBridgeSocket => {
    this.calls.push({ url, subprotocol });
    const socket = new FakeWebSocket();
    this.sockets.push(socket);
    return socket;
  };

  get activeSocketCount(): number {
    return this.sockets.filter((socket) => socket.readyState === 0 || socket.readyState === 1).length;
  }
}

class FakeWebSocket implements HarnessBridgeSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners: { [K in keyof HarnessBridgeSocketEventMap]: Array<(event: HarnessBridgeSocketEventMap[K]) => void> } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  readyState = 0;
  failNextSend = false;

  addEventListener<K extends keyof HarnessBridgeSocketEventMap>(
    type: K,
    listener: (event: HarnessBridgeSocketEventMap[K]) => void,
  ): void {
    (this.listeners[type] as Array<(event: HarnessBridgeSocketEventMap[K]) => void>).push(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('SOCKET_NOT_OPEN');
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('SIMULATED_SEND_FAILURE');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    if (this.readyState < 2) this.readyState = 2;
  }

  open(): void {
    if (this.readyState === 0) this.readyState = 1;
    this.emit('open', {});
  }

  message(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : encodeWebModelFrame(frame);
    this.emit('message', { data });
  }

  error(): void {
    this.emit('error', {});
  }

  closed(code: number, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  sentFrame(index: number): WebModelFrame {
    return JSON.parse(this.sent[index] ?? 'null') as WebModelFrame;
  }

  private emit<K extends keyof HarnessBridgeSocketEventMap>(type: K, event: HarnessBridgeSocketEventMap[K]): void {
    for (const listener of this.listeners[type]) listener(event);
  }
}

interface ScheduledTask {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

class FakeScheduler implements HarnessBridgeScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private nextId = 1;
  private nowValue = 1_000;

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { id, at: this.nowValue + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  get activeCount(): number {
    return this.tasks.size;
  }

  advance(milliseconds: number): void {
    const target = this.nowValue + milliseconds;
    for (;;) {
      const next = [...this.tasks.values()]
        .filter((task) => task.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.nowValue = next.at;
      this.tasks.delete(next.id);
      next.callback();
    }
    this.nowValue = target;
  }
}
