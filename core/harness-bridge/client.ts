import {
  WebModelSequenceValidator,
  encodeWebModelFrame,
  type BridgeCapabilities,
  type ModelCancelRequest,
  type ModelGenerateRequest,
  type ModelQueryRequest,
  type ModelRequestCheckpoint,
  type WebModelFrame,
} from '@deepseek-pp/web-model-protocol';

import { HarnessBridgeClientError, type HarnessBridgeClientErrorCode } from './errors';
import {
  createHarnessBridgeState,
  type HarnessBridgeClientState,
  type HarnessBridgeStateListener,
} from './state';

export const HARNESS_BRIDGE_PATH = '/web-model/v1' as const;
export const HARNESS_BRIDGE_SUBPROTOCOL = 'deepseek-web-model.v1' as const;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const DEFAULT_TIMING: HarnessBridgeClientTiming = Object.freeze({
  connectTimeoutMs: 5_000,
  helloTimeoutMs: 2_000,
  heartbeatIntervalMs: 10_000,
  retryBaseMs: 250,
  retryMaxMs: 10_000,
  maxAttempts: 6,
});

export interface HarnessBridgeClientTiming {
  readonly connectTimeoutMs: number;
  readonly helloTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly maxAttempts: number;
}

export interface HarnessBridgeClientConfig {
  readonly port: number;
  readonly pairingToken: string;
  readonly browserInstanceId: string;
  readonly clientVersion: string;
  readonly timing: HarnessBridgeClientTiming;
  readonly capabilities: BridgeCapabilities;
}

export interface HarnessBridgeSocketEventMap {
  open: object;
  message: { readonly data: unknown };
  error: object;
  close: { readonly code: number; readonly reason: string };
}

export interface HarnessBridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof HarnessBridgeSocketEventMap>(
    type: K,
    listener: (event: HarnessBridgeSocketEventMap[K]) => void,
  ): void;
}

export type HarnessBridgeWebSocketFactory = (url: string, subprotocol: string) => HarnessBridgeSocket;

export interface HarnessBridgeClock {
  now(): number;
}

export interface HarnessBridgeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HarnessBridgeClientDependencies {
  readonly webSocketFactory?: HarnessBridgeWebSocketFactory;
  readonly clock?: HarnessBridgeClock;
  readonly scheduler?: HarnessBridgeScheduler;
  readonly idFactory?: () => string;
  readonly listenerErrorSink?: HarnessBridgeListenerErrorSink;
}

export type HarnessBridgeListenerErrorSource = 'state_listener' | 'request_listener';
export type HarnessBridgeListenerErrorSink = (error: unknown, source: HarnessBridgeListenerErrorSource) => void;

export type HarnessBridgeHostRequest = ModelGenerateRequest | ModelCancelRequest | ModelQueryRequest;
export type HarnessBridgeRequestListener = (request: HarnessBridgeHostRequest) => void;

interface ConnectionGeneration {
  readonly number: number;
  readonly attempt: number;
  readonly socket: HarnessBridgeSocket;
  readonly validator: WebModelSequenceValidator;
  connectTimer?: unknown;
  helloTimer?: unknown;
  heartbeatTimer?: unknown;
  connectionId?: string;
}

export class HarnessBridgeClient {
  private readonly config: HarnessBridgeClientConfig;
  private readonly webSocketFactory: HarnessBridgeWebSocketFactory;
  private readonly clock: HarnessBridgeClock;
  private readonly scheduler: HarnessBridgeScheduler;
  private readonly idFactory: () => string;
  private readonly listenerErrorSink: HarnessBridgeListenerErrorSink | undefined;
  private readonly stateListeners = new Set<HarnessBridgeStateListener>();
  private readonly requestListeners = new Set<HarnessBridgeRequestListener>();
  private stateValue: HarnessBridgeClientState = createHarnessBridgeState('offline', 0);
  private connection: ConnectionGeneration | undefined;
  private retryTimer: unknown;
  private generationCounter = 0;
  private running = false;

  constructor(config: unknown, dependencies: HarnessBridgeClientDependencies = {}) {
    this.config = validateHarnessBridgeClientConfig(config);
    this.webSocketFactory = dependencies.webSocketFactory ?? defaultWebSocketFactory;
    this.clock = dependencies.clock ?? { now: () => Date.now() };
    this.scheduler = dependencies.scheduler ?? defaultScheduler;
    this.idFactory = dependencies.idFactory ?? defaultIdFactory;
    this.listenerErrorSink = dependencies.listenerErrorSink;
  }

  get state(): HarnessBridgeClientState {
    return this.stateValue;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clearRetryTimer();
    this.connect(1);
  }

  stop(): void {
    if (!this.running && this.stateValue.phase === 'stopped') return;
    this.running = false;
    this.clearRetryTimer();
    this.retireConnection(this.connection);
    this.publish(createHarnessBridgeState('stopped', 0));
  }

  reconnect(): void {
    if (!this.running) {
      this.start();
      return;
    }
    if (this.stateValue.phase === 'connecting' || this.stateValue.phase === 'authenticating' ||
        this.stateValue.phase === 'ready') return;
    this.clearRetryTimer();
    this.connect(1);
  }

  subscribe(listener: HarnessBridgeStateListener): () => void {
    this.stateListeners.add(listener);
    try {
      listener(this.stateValue);
    } catch (error) {
      this.stateListeners.delete(listener);
      this.reportListenerError(error, 'state_listener');
    }
    return () => this.stateListeners.delete(listener);
  }

  subscribeRequests(listener: HarnessBridgeRequestListener): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  send(frame: unknown): void {
    const connection = this.requireReadyConnection();
    let encoded: string;
    try {
      encoded = encodeWebModelFrame(frame);
      const accepted = connection.validator.accept(frame, 'browser');
      if (!isApplicationOutboundFrame(accepted)) throw new Error('UNEXPECTED_OUTBOUND_FRAME');
    } catch (error) {
      if (this.isCurrent(connection)) this.failProtocol(connection);
      if (error instanceof HarnessBridgeClientError) throw error;
      throw new HarnessBridgeClientError('PROTOCOL_ERROR');
    }
    try {
      connection.socket.send(encoded);
    } catch {
      this.scheduleRetry(connection, 0, 'SOCKET_SEND_FAILED');
      throw new HarnessBridgeClientError('SOCKET_SEND_FAILED');
    }
  }

  hydrateRequestCheckpoint(checkpoint: ModelRequestCheckpoint): void {
    const connection = this.requireReadyConnection();
    try {
      connection.validator.hydrateRequestCheckpoint(checkpoint);
    } catch {
      this.failProtocol(connection);
      throw new HarnessBridgeClientError('PROTOCOL_ERROR');
    }
  }

  private connect(attempt: number): void {
    if (!this.running) return;
    this.clearRetryTimer();
    this.retireConnection(this.connection);
    const generation = ++this.generationCounter;
    const url = createHarnessBridgeUrl(this.config.port);
    let socket: HarnessBridgeSocket;
    try {
      socket = this.webSocketFactory(url, HARNESS_BRIDGE_SUBPROTOCOL);
    } catch {
      this.scheduleRetry(undefined, attempt, 'CONNECTION_FAILED');
      return;
    }
    const connection: ConnectionGeneration = {
      number: generation,
      attempt,
      socket,
      validator: new WebModelSequenceValidator(),
    };
    this.connection = connection;
    socket.addEventListener('open', () => this.onOpen(connection));
    socket.addEventListener('message', (event) => this.onMessage(connection, event.data));
    socket.addEventListener('error', () => this.onError(connection));
    socket.addEventListener('close', (event) => this.onClose(connection, event.code, event.reason));
    connection.connectTimer = this.scheduler.setTimeout(
      () => this.onConnectTimeout(connection),
      this.config.timing.connectTimeoutMs,
    );
    this.publish(createHarnessBridgeState('connecting', attempt));
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'connecting') return;
    if (socket.readyState === OPEN) this.onOpen(connection);
  }

  private onOpen(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'connecting') return;
    this.clearConnectionTimer(connection, 'connectTimer');
    this.publish(createHarnessBridgeState('authenticating', connection.attempt));
    if (!this.isCurrent(connection) || !this.hasPhase('authenticating')) return;
    const hello = {
      jsonrpc: '2.0',
      id: `hello-${connection.number}-${this.idFactory()}`,
      method: 'bridge.hello',
      params: {
        schema_version: 1,
        pairing_token: this.config.pairingToken,
        browser_instance_id: this.config.browserInstanceId,
        client: { name: 'DeepSeek++', version: this.config.clientVersion },
        capabilities: this.config.capabilities,
      },
    } as const;
    let encoded: string;
    try {
      encoded = encodeWebModelFrame(hello);
      connection.validator.accept(hello, 'browser');
    } catch {
      this.failProtocol(connection);
      return;
    }
    try {
      connection.socket.send(encoded);
    } catch {
      this.scheduleRetry(connection, connection.attempt, 'SOCKET_SEND_FAILED');
      return;
    }
    if (!this.isCurrent(connection) || !this.hasPhase('authenticating')) return;
    connection.helloTimer = this.scheduler.setTimeout(
      () => this.onHelloTimeout(connection),
      this.config.timing.helloTimeoutMs,
    );
  }

  private onMessage(connection: ConnectionGeneration, data: unknown): void {
    if (!this.isCurrent(connection)) return;
    let frame: WebModelFrame;
    try {
      if (typeof data !== 'string') throw new Error('TEXT_FRAME_REQUIRED');
      frame = connection.validator.decodeAndAccept(data, 'host');
      if (this.stateValue.phase === 'authenticating') {
        this.acceptHelloResponse(connection, frame);
        return;
      }
      if (this.stateValue.phase !== 'ready' || !isHostRequest(frame)) throw new Error('UNEXPECTED_HOST_FRAME');
    } catch {
      this.failProtocol(connection);
      return;
    }
    for (const listener of [...this.requestListeners]) {
      try {
        listener(frame as HarnessBridgeHostRequest);
      } catch (error) {
        this.requestListeners.delete(listener);
        this.failHandler(connection);
        this.reportListenerError(error, 'request_listener');
        return;
      }
      if (!this.isCurrent(connection) || this.stateValue.phase !== 'ready') return;
    }
  }

  private acceptHelloResponse(connection: ConnectionGeneration, frame: WebModelFrame): void {
    if ('error' in frame) {
      if (frame.error.data.error_code === 'AUTH_FAILED') {
        this.enterNeedsPairing(connection, 'PAIRING_REJECTED');
        return;
      }
      if (frame.error.data.error_code === 'AUTH_TIMEOUT') {
        this.enterNeedsPairing(connection, 'HELLO_TIMEOUT');
        return;
      }
      throw new Error('HELLO_PROTOCOL_ERROR');
    }
    if ('method' in frame || frame.result.type !== 'bridge.hello') throw new Error('HELLO_RESPONSE_REQUIRED');
    this.clearConnectionTimer(connection, 'helloTimer');
    connection.connectionId = frame.result.connection_id;
    this.publish(createHarnessBridgeState('ready', 0, { capabilities: frame.result.capabilities }));
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'ready') return;
    this.scheduleHeartbeat(connection);
  }

  private onError(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection)) return;
    this.scheduleRetry(connection, this.stateValue.phase === 'ready' ? 0 : connection.attempt, 'CONNECTION_FAILED');
  }

  private onClose(connection: ConnectionGeneration, code: number, reason: string): void {
    if (!this.isCurrent(connection)) return;
    if (this.stateValue.phase === 'authenticating') {
      if (reason === 'AUTH_FAILED') {
        this.enterNeedsPairing(connection, 'PAIRING_REJECTED');
        return;
      }
      if (reason === 'AUTH_TIMEOUT') {
        this.enterNeedsPairing(connection, 'HELLO_TIMEOUT');
        return;
      }
      if (code === 1008) {
        this.failProtocol(connection);
        return;
      }
    }
    this.scheduleRetry(connection, this.stateValue.phase === 'ready' ? 0 : connection.attempt, 'CONNECTION_FAILED');
  }

  private onConnectTimeout(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'connecting') return;
    this.scheduleRetry(connection, connection.attempt, 'CONNECTION_TIMEOUT');
  }

  private onHelloTimeout(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'authenticating') return;
    this.enterNeedsPairing(connection, 'HELLO_TIMEOUT');
  }

  private enterNeedsPairing(connection: ConnectionGeneration, code: HarnessBridgeClientErrorCode): void {
    if (!this.isCurrent(connection)) return;
    this.retireConnection(connection);
    this.publish(createHarnessBridgeState('needs_pairing', connection.attempt, { errorCode: code }));
  }

  private failProtocol(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection)) return;
    this.retireConnection(connection);
    this.publish(createHarnessBridgeState('protocol_error', connection.attempt, { errorCode: 'PROTOCOL_ERROR' }));
  }

  private failHandler(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection)) return;
    this.retireConnection(connection);
    this.publish(createHarnessBridgeState('handler_error', connection.attempt, { errorCode: 'HANDLER_FAILED' }));
  }

  private scheduleRetry(
    connection: ConnectionGeneration | undefined,
    failedAttempt: number,
    errorCode: HarnessBridgeClientErrorCode,
  ): void {
    if (!this.running) return;
    if (connection && !this.isCurrent(connection)) return;
    this.retireConnection(connection);
    const nextAttempt = failedAttempt + 1;
    if (nextAttempt > this.config.timing.maxAttempts) {
      this.publish(createHarnessBridgeState('offline', failedAttempt, { errorCode: 'RETRY_EXHAUSTED' }));
      return;
    }
    const delay = calculateRetryDelay(failedAttempt, this.config.timing);
    this.publish(createHarnessBridgeState('retry_wait', failedAttempt, {
      errorCode,
      nextRetryAtMs: safeNow(this.clock) + delay,
    }));
    if (!this.running || this.stateValue.phase !== 'retry_wait') return;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running && this.stateValue.phase === 'retry_wait') this.connect(nextAttempt);
    }, delay);
  }

  private scheduleHeartbeat(connection: ConnectionGeneration): void {
    if (!this.isCurrent(connection) || this.stateValue.phase !== 'ready') return;
    this.clearConnectionTimer(connection, 'heartbeatTimer');
    connection.heartbeatTimer = this.scheduler.setTimeout(() => {
      if (!this.isCurrent(connection) || this.stateValue.phase !== 'ready' || !connection.connectionId) return;
      const heartbeat = {
        jsonrpc: '2.0',
        method: 'bridge.heartbeat',
        params: {
          schema_version: 1,
          connection_id: connection.connectionId,
          nonce: `heartbeat-${this.idFactory()}`,
          sent_at_ms: safeNow(this.clock),
        },
      } as const;
      let encoded: string;
      try {
        encoded = encodeWebModelFrame(heartbeat);
        connection.validator.accept(heartbeat, 'browser');
      } catch {
        this.failProtocol(connection);
        return;
      }
      try {
        connection.socket.send(encoded);
      } catch {
        this.scheduleRetry(connection, 0, 'SOCKET_SEND_FAILED');
        return;
      }
      this.scheduleHeartbeat(connection);
    }, this.config.timing.heartbeatIntervalMs);
  }

  private requireReadyConnection(): ConnectionGeneration {
    const connection = this.connection;
    if (!this.running || this.stateValue.phase !== 'ready' || !connection || connection.socket.readyState !== OPEN) {
      throw new HarnessBridgeClientError('NOT_READY');
    }
    return connection;
  }

  private isCurrent(connection: ConnectionGeneration): boolean {
    return this.running && this.connection === connection && this.generationCounter === connection.number;
  }

  private hasPhase(phase: HarnessBridgeClientState['phase']): boolean {
    return this.stateValue.phase === phase;
  }

  private retireConnection(connection: ConnectionGeneration | undefined): void {
    if (!connection) return;
    this.clearConnectionTimer(connection, 'connectTimer');
    this.clearConnectionTimer(connection, 'helloTimer');
    this.clearConnectionTimer(connection, 'heartbeatTimer');
    if (this.connection === connection) this.connection = undefined;
    if (connection.socket.readyState === CONNECTING || connection.socket.readyState === OPEN) {
      connection.socket.close(1000, 'CLIENT_GENERATION_RETIRED');
    }
  }

  private clearConnectionTimer(
    connection: ConnectionGeneration,
    key: 'connectTimer' | 'helloTimer' | 'heartbeatTimer',
  ): void {
    const timer = connection[key];
    if (timer !== undefined) this.scheduler.clearTimeout(timer);
    delete connection[key];
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private publish(state: HarnessBridgeClientState): void {
    this.stateValue = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (error) {
        this.stateListeners.delete(listener);
        this.reportListenerError(error, 'state_listener');
      }
      if (this.stateValue !== state) return;
    }
  }

  private reportListenerError(error: unknown, source: HarnessBridgeListenerErrorSource): void {
    try {
      this.listenerErrorSink?.(error, source);
    } catch {
      // Observer failures must never escape into the connection state machine.
    }
  }
}

export function validateHarnessBridgeClientConfig(value: unknown): HarnessBridgeClientConfig {
  const config = strictRecord(value, ['port', 'pairingToken', 'browserInstanceId', 'clientVersion'], ['timing', 'capabilities']);
  const timingValue = config.timing === undefined
    ? DEFAULT_TIMING
    : validateTiming(config.timing);
  const capabilities = config.capabilities === undefined
    ? defaultCapabilities()
    : validateCapabilities(config.capabilities);
  return Object.freeze({
    port: boundedInteger(config.port, 1, 65_535),
    pairingToken: validatePairingToken(config.pairingToken),
    browserInstanceId: validateIdentifier(config.browserInstanceId, 128),
    clientVersion: validateText(config.clientVersion, 1, 64),
    timing: timingValue,
    capabilities,
  });
}

export function createHarnessBridgeUrl(port: number): string {
  return `ws://127.0.0.1:${boundedInteger(port, 1, 65_535)}${HARNESS_BRIDGE_PATH}`;
}

export function calculateRetryDelay(failedAttempt: number, timing: HarnessBridgeClientTiming): number {
  const exponent = Math.max(0, Math.min(failedAttempt - 1, 30));
  return Math.min(timing.retryBaseMs * (2 ** exponent), timing.retryMaxMs);
}

function isHostRequest(frame: WebModelFrame): frame is HarnessBridgeHostRequest {
  return 'method' in frame && (frame.method === 'model.generate' || frame.method === 'model.cancel' || frame.method === 'model.query');
}

function isApplicationOutboundFrame(frame: WebModelFrame): boolean {
  if ('method' in frame) return frame.method === 'model.event';
  return true;
}

function validateTiming(value: unknown): HarnessBridgeClientTiming {
  const timing = strictRecord(value, [
    'connectTimeoutMs',
    'helloTimeoutMs',
    'heartbeatIntervalMs',
    'retryBaseMs',
    'retryMaxMs',
    'maxAttempts',
  ], []);
  const retryBaseMs = boundedInteger(timing.retryBaseMs, 1, 600_000);
  const retryMaxMs = boundedInteger(timing.retryMaxMs, retryBaseMs, 600_000);
  return Object.freeze({
    connectTimeoutMs: boundedInteger(timing.connectTimeoutMs, 10, 600_000),
    helloTimeoutMs: boundedInteger(timing.helloTimeoutMs, 10, 600_000),
    heartbeatIntervalMs: boundedInteger(timing.heartbeatIntervalMs, 10, 600_000),
    retryBaseMs,
    retryMaxMs,
    maxAttempts: boundedInteger(timing.maxAttempts, 1, 20),
  });
}

function validateCapabilities(value: unknown): BridgeCapabilities {
  const capabilities = strictRecord(value, ['structured_tool_calls', 'cancel', 'query'], ['text', 'reasoning', 'usage']);
  if (capabilities.structured_tool_calls !== true || capabilities.cancel !== true || capabilities.query !== true) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  for (const optional of ['text', 'reasoning', 'usage'] as const) {
    if (capabilities[optional] !== undefined && capabilities[optional] !== true) {
      throw new HarnessBridgeClientError('CONFIG_INVALID');
    }
  }
  return Object.freeze({
    ...(capabilities.text === true ? { text: true as const } : {}),
    ...(capabilities.reasoning === true ? { reasoning: true as const } : {}),
    structured_tool_calls: true,
    ...(capabilities.usage === true ? { usage: true as const } : {}),
    cancel: true,
    query: true,
  });
}

function defaultCapabilities(): BridgeCapabilities {
  return Object.freeze({ text: true, structured_tool_calls: true, usage: true, cancel: true, query: true });
}

function validatePairingToken(value: unknown): string {
  const token = validateText(value, 43, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(token) || token.length % 4 === 1) throw new HarnessBridgeClientError('CONFIG_INVALID');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalValue = alphabet.indexOf(token[token.length - 1] ?? '');
  const remainder = token.length % 4;
  if (finalValue < 0 || (remainder === 2 && (finalValue & 15) !== 0) || (remainder === 3 && (finalValue & 3) !== 0) ||
      Math.floor(token.length * 6 / 8) < 32) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  return token;
}

function validateIdentifier(value: unknown, maximum: number): string {
  const result = validateText(value, 1, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw new HarnessBridgeClientError('CONFIG_INVALID');
  return result;
}

function validateText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || hasLoneSurrogate(value)) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  return value as number;
}

function strictRecord(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size || keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new HarnessBridgeClientError('CONFIG_INVALID');
  }
  return record;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function safeNow(clock: HarnessBridgeClock): number {
  const now = Math.floor(clock.now());
  if (!Number.isSafeInteger(now) || now < 0) throw new HarnessBridgeClientError('PROTOCOL_ERROR');
  return now;
}

const defaultScheduler: HarnessBridgeScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultWebSocketFactory(url: string, subprotocol: string): HarnessBridgeSocket {
  if (typeof globalThis.WebSocket !== 'function') throw new HarnessBridgeClientError('CONNECTION_FAILED');
  return new globalThis.WebSocket(url, subprotocol) as unknown as HarnessBridgeSocket;
}

function defaultIdFactory(): string {
  return globalThis.crypto.randomUUID();
}
