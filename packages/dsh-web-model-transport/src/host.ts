import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

import {
  MAX_FRAME_BYTES,
  WebModelSequenceValidator,
  encodeWebModelFrame,
  isTerminalEvent,
  type BridgeCapabilities,
  type BridgeHelloRequest,
  type JsonRpcErrorResponse,
  type ModelAcceptedResponse,
  type ModelCancelledResponse,
  type ModelEvent,
  type ModelEventNotification,
  type ModelRequestCheckpoint,
  type ModelStatusResponse,
  type WebModelFrame,
} from "@deepseek-pp/web-model-protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { AsyncQueue, deferred, type Deferred } from "./async-queue.js";
import {
  BrokerError,
  type BrokerCancelRequest,
  type BrokerCancelResult,
  type BrokerGenerateRequest,
  type BrokerQueryRequest,
  type BrokerQueryResult,
  type DeepSeekWebBroker,
} from "./broker.js";
import {
  LOOPBACK_HOST,
  WEB_MODEL_PATH,
  WEB_MODEL_SUBPROTOCOL,
  assertAllowedOrigins,
  assertPairingToken,
  pairingTokenMatches,
  validateUpgradeRequest,
} from "./security.js";

const DEFAULT_AUTH_TIMEOUT_MS = 2_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 128;
const DEFAULT_MAX_EVENTS = 4_096;

export interface DeepSeekWebModelHostOptions {
  readonly pairingToken: string;
  readonly allowedOrigins: readonly string[];
  readonly port?: number;
  readonly authenticationTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly maxBufferedEvents?: number;
  readonly maxEventsPerGeneration?: number;
}

export interface DeepSeekWebModelHostAddress {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly path: typeof WEB_MODEL_PATH;
  readonly subprotocol: typeof WEB_MODEL_SUBPROTOCOL;
  readonly url: string;
}

interface PeerConnection {
  readonly socket: WebSocket;
  readonly validator: WebModelSequenceValidator;
  readonly connectionId: string;
  authenticated: boolean;
  closing: boolean;
  authenticationTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
}

interface RequestIdentity {
  readonly requestId: string;
  readonly requestDigest: string;
}

interface ActiveGeneration extends RequestIdentity {
  readonly queue: AsyncQueue<ModelEvent>;
  readonly accepted: Deferred<void>;
  eventCount: number;
  terminal: boolean;
  deadlineTimer?: NodeJS.Timeout;
}

interface RequestLedgerEntry {
  readonly requestDigest: string;
  state: "active" | "ambiguous" | "terminal";
  remoteCheckpoint?: ModelRequestCheckpoint;
}

type PendingOperation =
  | { readonly kind: "generate"; readonly identity: RequestIdentity; readonly deferred: Deferred<void>; timer: NodeJS.Timeout }
  | { readonly kind: "cancel"; readonly identity: RequestIdentity; readonly deferred: Deferred<BrokerCancelResult>; timer: NodeJS.Timeout }
  | { readonly kind: "query"; readonly identity: RequestIdentity; readonly deferred: Deferred<BrokerQueryResult>; timer: NodeJS.Timeout };

export class DeepSeekWebModelHost implements DeepSeekWebBroker {
  private readonly pairingToken: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly configuredPort: number;
  private readonly authenticationTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly maxBufferedEvents: number;
  private readonly maxEventsPerGeneration: number;
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });
  private readonly operations = new Map<string, PendingOperation>();
  private readonly cancelResults = new Map<string, BrokerCancelResult>();
  private readonly cancelInFlight = new Map<string, Promise<BrokerCancelResult>>();
  private readonly requestLedger = new Map<string, RequestLedgerEntry>();
  private httpServer: Server | undefined;
  private addressValue: DeepSeekWebModelHostAddress | undefined;
  private connection: PeerConnection | undefined;
  private activeGeneration: ActiveGeneration | undefined;
  private stopping = false;
  private started = false;

  constructor(options: DeepSeekWebModelHostOptions) {
    assertPairingToken(options.pairingToken);
    this.pairingToken = options.pairingToken;
    this.allowedOrigins = assertAllowedOrigins(options.allowedOrigins);
    this.configuredPort = boundedInteger(options.port ?? 0, 0, 65_535, "INVALID_PORT");
    this.authenticationTimeoutMs = boundedInteger(options.authenticationTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, 10, 600_000, "INVALID_TIMEOUT");
    this.heartbeatTimeoutMs = boundedInteger(options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS, 10, 600_000, "INVALID_TIMEOUT");
    this.rpcTimeoutMs = boundedInteger(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, 10, 600_000, "INVALID_TIMEOUT");
    this.maxBufferedEvents = boundedInteger(options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS, 1, 4_096, "INVALID_LIMIT");
    this.maxEventsPerGeneration = boundedInteger(options.maxEventsPerGeneration ?? DEFAULT_MAX_EVENTS, 1, 65_536, "INVALID_LIMIT");
  }

  get address(): DeepSeekWebModelHostAddress {
    if (!this.addressValue) throw new BrokerError(this.stopping ? "BROKER_STOPPED" : "WAITING_FOR_BROWSER", "not_started");
    return this.addressValue;
  }

  get hasAuthenticatedPeer(): boolean {
    return this.connection?.authenticated === true && this.connection.socket.readyState === WebSocket.OPEN;
  }

  async start(): Promise<DeepSeekWebModelHostAddress> {
    if (this.started || this.stopping) throw new BrokerError("BROKER_STOPPED", "not_started");
    this.started = true;
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-length": "0" });
      response.end();
    });
    this.httpServer = server;
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    await listen(server, this.configuredPort);
    const actual = server.address();
    if (actual === null || typeof actual === "string" || actual.address !== LOOPBACK_HOST) {
      await closeHttpServer(server);
      throw new Error("LOOPBACK_BIND_FAILED");
    }
    this.addressValue = Object.freeze({
      host: LOOPBACK_HOST,
      port: actual.port,
      path: WEB_MODEL_PATH,
      subprotocol: WEB_MODEL_SUBPROTOCOL,
      url: `ws://${LOOPBACK_HOST}:${actual.port}${WEB_MODEL_PATH}`,
    });
    return this.addressValue;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const connection = this.connection;
    if (connection) {
      this.settleGenerationAmbiguous("host_stopped");
      connection.closing = true;
      this.clearPeerTimers(connection);
      connection.socket.terminate();
      this.connection = undefined;
    }
    for (const operation of this.operations.values()) {
      clearTimeout(operation.timer);
      if (operation.kind !== "generate") operation.deferred.reject(new BrokerError("BROKER_STOPPED", "unknown"));
    }
    this.operations.clear();
    await closeWebSocketServer(this.webSocketServer);
    if (this.httpServer) await closeHttpServer(this.httpServer);
    this.httpServer = undefined;
    this.addressValue = undefined;
  }

  async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    if (this.hasCancelInFlight(request.request_id)) {
      throw new BrokerError("BROKER_BUSY", "not_started");
    }
    const existing = this.requestLedger.get(request.request_id);
    if (existing) {
      if (existing.requestDigest !== request.request_digest) {
        throw new BrokerError("REQUEST_DIGEST_MISMATCH", "not_started");
      }
      throw new BrokerError("REQUEST_ALREADY_EXISTS", existing.state === "terminal" ? "started" : "unknown");
    }
    if (this.requestLedger.size >= 1_024) throw new BrokerError("BROKER_BUSY", "not_started");
    const peer = this.requirePeer();
    if (this.activeGeneration) throw new BrokerError("BROKER_BUSY", "not_started");
    const active: ActiveGeneration = {
      requestId: request.request_id,
      requestDigest: request.request_digest,
      queue: new AsyncQueue<ModelEvent>(this.maxBufferedEvents),
      accepted: deferred<void>(),
      eventCount: 0,
      terminal: false,
    };
    const rpcId = newRpcId();
    const frame = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "model.generate",
      params: { schema_version: 1, ...request },
    } as const;
    let encoded: string;
    try {
      encoded = this.prepareHostFrame(peer, frame);
    } catch (error) {
      throw stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started");
    }
    this.clearCancelResults(request.request_id);
    this.activeGeneration = active;
    this.requestLedger.set(request.request_id, { requestDigest: request.request_digest, state: "active" });
    try {
      this.trackOperation(rpcId, { kind: "generate", identity: active, deferred: active.accepted });
      this.sendPreparedFrame(peer, encoded);
      const timeoutMs = Math.min(request.options.timeout_ms ?? this.rpcTimeoutMs, 30 * 60 * 1_000);
      active.deadlineTimer = deadline(() => {
        this.settleGenerationAmbiguous("generation_timeout");
        this.closePeer(peer, 1008, "REQUEST_TIMEOUT");
      }, timeoutMs);
      await active.accepted.promise;
      for (;;) {
        const next = await active.queue.next();
        if (next.done) break;
        yield next.value;
      }
    } catch (error) {
      const normalized = stableBrokerError(error, "PROTOCOL_VIOLATION", "not_started");
      const pending = this.operations.get(rpcId);
      if (pending) {
        clearTimeout(pending.timer);
        this.operations.delete(rpcId);
      }
      if (normalized.externalOutcome === "not_started") {
        if (this.activeGeneration === active) {
          this.activeGeneration = undefined;
          active.queue.close();
        }
        this.requestLedger.delete(request.request_id);
        throw normalized;
      }
      if (this.activeGeneration === active) {
        this.settleGenerationAmbiguous("send_outcome_unknown");
        this.closePeer(peer, 1011, "SEND_FAILED");
      } else {
        const ledger = this.requestLedger.get(request.request_id);
        if (ledger) ledger.state = "ambiguous";
      }
      for (;;) {
        const next = await active.queue.next();
        if (next.done) break;
        yield next.value;
      }
      return;
    } finally {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      if (this.activeGeneration === active && !active.terminal) {
        this.settleGenerationAmbiguous("consumer_closed");
        this.closePeer(peer, 1000, "STREAM_CLOSED");
      }
    }
  }

  async cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    const key = identityKey(request.request_id, request.request_digest);
    this.assertLedgerIdentity(request);
    const cached = this.cancelResults.get(key);
    if (cached) return cached;
    const inFlight = this.cancelInFlight.get(key);
    if (inFlight) return inFlight;
    const ledger = this.requestLedger.get(request.request_id);
    if (ledger?.state === "terminal") {
      const terminalResult: BrokerCancelResult = {
        schema_version: 1,
        type: "model.cancelled",
        request_id: request.request_id,
        request_digest: request.request_digest,
        status: "already_terminal",
      };
      this.cancelResults.set(key, terminalResult);
      return terminalResult;
    }
    const pending = this.performCancel(request);
    this.cancelInFlight.set(key, pending);
    try {
      const value = await pending;
      this.cancelResults.set(key, value);
      trimMap(this.cancelResults, 128);
      return value;
    } finally {
      this.cancelInFlight.delete(key);
    }
  }

  private async performCancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    const peer = this.requirePeer();
    const rpcId = newRpcId();
    const result = deferred<BrokerCancelResult>();
    const frame = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "model.cancel",
      params: { schema_version: 1, request_id: request.request_id, request_digest: request.request_digest,
        ...(request.reason === undefined ? {} : { reason: request.reason }) },
    } as const;
    this.sendHostFrame(peer, frame);
    this.trackOperation(rpcId, { kind: "cancel", identity: identityOf(request), deferred: result });
    return result.promise;
  }

  async query(request: BrokerQueryRequest): Promise<BrokerQueryResult> {
    this.assertLedgerIdentity(request);
    const peer = this.requirePeer();
    const checkpoint = this.requestLedger.get(request.request_id)?.remoteCheckpoint;
    if (checkpoint) peer.validator.hydrateRequestCheckpoint(checkpoint);
    const rpcId = newRpcId();
    const result = deferred<BrokerQueryResult>();
    const frame = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "model.query",
      params: { schema_version: 1, request_id: request.request_id, request_digest: request.request_digest },
    } as const;
    this.sendHostFrame(peer, frame);
    this.trackOperation(rpcId, { kind: "query", identity: identityOf(request), deferred: result });
    return result.promise;
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.stopping || !this.addressValue) return rejectUpgrade(socket, 503);
    const rejection = validateUpgradeRequest(request, { port: this.addressValue.port, allowedOrigins: this.allowedOrigins });
    if (rejection) return rejectUpgrade(socket, 403);
    if (this.connection) return rejectUpgrade(socket, 409);
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.attachConnection(webSocket);
      this.webSocketServer.emit("connection", webSocket, request);
    });
  }

  private attachConnection(socket: WebSocket): void {
    const peer: PeerConnection = {
      socket,
      validator: new WebModelSequenceValidator(),
      connectionId: `connection-${randomBytes(16).toString("base64url")}`,
      authenticated: false,
      closing: false,
    };
    this.connection = peer;
    peer.authenticationTimer = deadline(() => this.closePeer(peer, 1008, "AUTH_TIMEOUT"), this.authenticationTimeoutMs);
    socket.on("message", (data, isBinary) => this.handleMessage(peer, data, isBinary));
    socket.on("close", () => this.handleClose(peer));
    socket.on("error", () => undefined);
  }

  private handleMessage(peer: PeerConnection, data: RawData, isBinary: boolean): void {
    if (peer !== this.connection || peer.closing) return;
    try {
      if (isBinary) throw new Error("TEXT_REQUIRED");
      const text = decodeTextFrame(data);
      const frame = peer.validator.decodeAndAccept(text, "browser");
      if (!peer.authenticated) {
        this.authenticate(peer, frame);
        return;
      }
      if ("method" in frame && frame.method === "bridge.heartbeat") {
        this.armHeartbeat(peer);
        return;
      }
      this.routeFrame(peer, frame);
    } catch {
      this.closePeer(peer, isBinary ? 1003 : 1008, isBinary ? "TEXT_REQUIRED" : "PROTOCOL_ERROR");
    }
  }

  private authenticate(peer: PeerConnection, frame: WebModelFrame): void {
    if (!("method" in frame) || frame.method !== "bridge.hello") throw new Error("AUTH_REQUIRED");
    const hello = frame as BridgeHelloRequest;
    if (!pairingTokenMatches(hello.params.pairing_token, this.pairingToken)) throw new Error("AUTH_FAILED");
    const capabilities = negotiateCapabilities(hello.params.capabilities);
    const response = {
      jsonrpc: "2.0",
      id: hello.id,
      result: {
        schema_version: 1,
        type: "bridge.hello",
        connection_id: peer.connectionId,
        status: "ready",
        capabilities,
      },
    } as const;
    this.sendHostFrame(peer, response);
    peer.authenticated = true;
    if (peer.authenticationTimer) clearTimeout(peer.authenticationTimer);
    delete peer.authenticationTimer;
    this.armHeartbeat(peer);
  }

  private routeFrame(peer: PeerConnection, frame: WebModelFrame): void {
    if ("method" in frame) {
      if (frame.method !== "model.event") throw new Error("UNEXPECTED_NOTIFICATION");
      this.handleModelEvent(peer, frame);
      return;
    }
    this.handleRpcResponse(peer, frame);
  }

  private handleModelEvent(peer: PeerConnection, frame: ModelEventNotification): void {
    const active = this.activeGeneration;
    if (!active || frame.params.request_id !== active.requestId) throw new Error("UNKNOWN_REQUEST");
    this.recordRemoteEvent(active, frame.params.sequence, frame.params.event);
    active.eventCount += 1;
    if (active.eventCount > this.maxEventsPerGeneration || !active.queue.push(frame.params.event)) {
      this.settleGenerationAmbiguous("stream_limit_exceeded");
      this.closePeer(peer, 1008, "STREAM_LIMIT");
      return;
    }
    if (isTerminalEvent(frame.params.event)) {
      active.terminal = true;
      active.queue.close();
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      this.activeGeneration = undefined;
      const ledger = this.requestLedger.get(active.requestId);
      if (ledger) ledger.state = "terminal";
    }
  }

  private handleRpcResponse(peer: PeerConnection, frame: Exclude<WebModelFrame, { method: string }>): void {
    if (frame.id === null) throw new Error("UNEXPECTED_RESPONSE");
    const operation = this.operations.get(frame.id);
    if (!operation) throw new Error("UNEXPECTED_RESPONSE");
    clearTimeout(operation.timer);
    this.operations.delete(frame.id);
    if ("error" in frame) {
      this.handleRpcError(peer, operation, frame);
      return;
    }
    if (operation.kind === "generate" && frame.result.type === "model.accepted") {
      const ledger = this.requestLedger.get(operation.identity.requestId);
      if (ledger) {
        ledger.remoteCheckpoint = {
          request_id: operation.identity.requestId,
          request_digest: operation.identity.requestDigest,
          status: "accepted",
          last_sequence: 0,
        };
      }
      operation.deferred.resolve();
      return;
    }
    if (operation.kind === "cancel" && frame.result.type === "model.cancelled") {
      operation.deferred.resolve(frame.result);
      return;
    }
    if (operation.kind === "query" && frame.result.type === "model.status") {
      this.recordRemoteStatus(frame.result);
      operation.deferred.resolve(frame.result);
      return;
    }
    throw new Error("UNEXPECTED_RESPONSE");
  }

  private handleRpcError(peer: PeerConnection, operation: PendingOperation, frame: JsonRpcErrorResponse): void {
    const outcome = frame.error.data.external_outcome;
    const error = new BrokerError("PROTOCOL_VIOLATION", outcome);
    if (operation.kind === "generate") {
      if (outcome === "not_started") {
        if (this.activeGeneration?.requestId === operation.identity.requestId) {
          this.activeGeneration.queue.close();
          if (this.activeGeneration.deadlineTimer) clearTimeout(this.activeGeneration.deadlineTimer);
          this.activeGeneration = undefined;
        }
        this.requestLedger.delete(operation.identity.requestId);
        operation.deferred.reject(error);
      } else {
        const ledger = this.requestLedger.get(operation.identity.requestId);
        if (ledger) ledger.state = "ambiguous";
        this.settleGenerationAmbiguous("remote_outcome_unknown");
        operation.deferred.resolve();
      }
      return;
    }
    operation.deferred.reject(error);
    if (outcome !== "not_started") this.closePeer(peer, 1008, "REQUEST_OUTCOME_UNKNOWN");
  }

  private sendHostFrame(peer: PeerConnection, frame: unknown): void {
    const encoded = this.prepareHostFrame(peer, frame);
    this.sendPreparedFrame(peer, encoded);
  }

  private prepareHostFrame(peer: PeerConnection, frame: unknown): string {
    if (peer !== this.connection || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    }
    const encoded = encodeWebModelFrame(frame);
    peer.validator.accept(frame, "host");
    return encoded;
  }

  private sendPreparedFrame(peer: PeerConnection, encoded: string): void {
    if (peer !== this.connection || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("CONNECTION_LOST", "unknown");
    }
    try {
      peer.socket.send(encoded);
    } catch {
      throw new BrokerError("CONNECTION_LOST", "unknown");
    }
  }

  private trackOperation(
    rpcId: string,
    operation: Omit<Extract<PendingOperation, { kind: "generate" }>, "timer"> |
      Omit<Extract<PendingOperation, { kind: "cancel" }>, "timer"> |
      Omit<Extract<PendingOperation, { kind: "query" }>, "timer">,
  ): void {
    const timer = deadline(() => {
      const pending = this.operations.get(rpcId);
      if (!pending) return;
      this.operations.delete(rpcId);
      if (pending.kind === "generate") {
        this.settleGenerationAmbiguous("accept_timeout");
        pending.deferred.resolve();
      } else {
        pending.deferred.reject(new BrokerError("REQUEST_TIMEOUT", "unknown"));
      }
      if (this.connection) this.closePeer(this.connection, 1008, "REQUEST_TIMEOUT");
    }, this.rpcTimeoutMs);
    this.operations.set(rpcId, { ...operation, timer } as PendingOperation);
  }

  private armHeartbeat(peer: PeerConnection): void {
    if (peer.heartbeatTimer) clearTimeout(peer.heartbeatTimer);
    peer.heartbeatTimer = deadline(() => this.closePeer(peer, 1008, "HEARTBEAT_TIMEOUT"), this.heartbeatTimeoutMs);
  }

  private closePeer(peer: PeerConnection, code: number, reason: string): void {
    if (peer.closing) return;
    peer.closing = true;
    this.clearPeerTimers(peer);
    if (peer === this.connection) {
      this.settleGenerationAmbiguous("browser_disconnected");
      this.rejectPeerOperations();
    }
    if (peer.socket.readyState === WebSocket.CLOSED) return;
    peer.socket.close(code, reason);
    if (!peer.closeTimer) peer.closeTimer = deadline(() => peer.socket.terminate(), 50);
  }

  private handleClose(peer: PeerConnection): void {
    this.clearPeerTimers(peer);
    if (this.connection !== peer) return;
    peer.closing = true;
    this.connection = undefined;
    this.settleGenerationAmbiguous("browser_disconnected");
    this.rejectPeerOperations();
  }

  private settleGenerationAmbiguous(reason: string): void {
    const active = this.activeGeneration;
    if (!active || active.terminal) return;
    active.terminal = true;
    const terminal: ModelEvent = { type: "ambiguous", reason };
    active.queue.finishWith(terminal);
    active.accepted.resolve();
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeGeneration = undefined;
    const ledger = this.requestLedger.get(active.requestId);
    if (ledger) ledger.state = "ambiguous";
  }

  private assertLedgerIdentity(request: { request_id: string; request_digest: string }): void {
    const ledger = this.requestLedger.get(request.request_id);
    if (ledger && ledger.requestDigest !== request.request_digest) {
      throw new BrokerError("REQUEST_DIGEST_MISMATCH", "not_started");
    }
  }

  private hasCancelInFlight(requestId: string): boolean {
    const prefix = `${requestId}\u0000`;
    for (const key of this.cancelInFlight.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private clearCancelResults(requestId: string): void {
    const prefix = `${requestId}\u0000`;
    for (const key of this.cancelResults.keys()) {
      if (key.startsWith(prefix)) this.cancelResults.delete(key);
    }
  }

  private recordRemoteEvent(active: ActiveGeneration, sequence: number, event: ModelEvent): void {
    const ledger = this.requestLedger.get(active.requestId);
    if (!ledger) return;
    ledger.remoteCheckpoint = {
      request_id: active.requestId,
      request_digest: active.requestDigest,
      status: isTerminalEvent(event) ? event.type : "streaming",
      last_sequence: sequence,
      ...(isTerminalEvent(event) ? { terminal: event } : {}),
    };
  }

  private recordRemoteStatus(result: ModelStatusResponse["result"]): void {
    if (result.status === "unknown") return;
    const ledger = this.requestLedger.get(result.request_id);
    if (!ledger) return;
    ledger.remoteCheckpoint = {
      request_id: result.request_id,
      request_digest: result.request_digest,
      status: result.status,
      last_sequence: result.last_sequence,
      ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    };
    if (result.terminal !== undefined) ledger.state = "terminal";
  }

  private rejectPeerOperations(): void {
    for (const [rpcId, operation] of this.operations) {
      clearTimeout(operation.timer);
      this.operations.delete(rpcId);
      if (operation.kind === "generate") operation.deferred.resolve();
      else operation.deferred.reject(new BrokerError("CONNECTION_LOST", "unknown"));
    }
  }

  private clearPeerTimers(peer: PeerConnection): void {
    if (peer.authenticationTimer) clearTimeout(peer.authenticationTimer);
    if (peer.heartbeatTimer) clearTimeout(peer.heartbeatTimer);
    if (peer.closeTimer) clearTimeout(peer.closeTimer);
  }

  private requirePeer(): PeerConnection {
    if (this.stopping) throw new BrokerError("BROKER_STOPPED", "not_started");
    const peer = this.connection;
    if (!peer?.authenticated || peer.closing || peer.socket.readyState !== WebSocket.OPEN) {
      throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    }
    return peer;
  }
}

function negotiateCapabilities(offered: BridgeCapabilities): BridgeCapabilities {
  return {
    ...(offered.text === true ? { text: true as const } : {}),
    structured_tool_calls: true,
    ...(offered.usage === true ? { usage: true as const } : {}),
    cancel: true,
    query: true,
  };
}

function decodeTextFrame(data: RawData): string {
  let bytes: Uint8Array;
  if (Array.isArray(data)) {
    const length = data.reduce((total, part) => total + part.byteLength, 0);
    if (length > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
    bytes = Buffer.concat(data, length);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function identityOf(value: { request_id: string; request_digest: string }): RequestIdentity {
  return { requestId: value.request_id, requestDigest: value.request_digest };
}

function identityKey(requestId: string, requestDigest: string): string {
  return `${requestId}\u0000${requestDigest}`;
}

function newRpcId(): string {
  return `rpc-${randomBytes(16).toString("hex")}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}

function deadline(callback: () => void, milliseconds: number): NodeJS.Timeout {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return timer;
}

function rejectUpgrade(socket: Duplex, status: 403 | 409 | 503): void {
  const reason = status === 409 ? "Conflict" : status === 503 ? "Service Unavailable" : "Forbidden";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function trimMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

function stableBrokerError(error: unknown, fallback: "PROTOCOL_VIOLATION", outcome: "not_started"): BrokerError {
  return error instanceof BrokerError ? error : new BrokerError(fallback, outcome);
}
