import { randomUUID } from "node:crypto";

import {
  WebModelSequenceValidator,
  encodeWebModelFrame,
  isTerminalEvent,
  type BridgeCapabilities,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelStatus,
  type ModelTerminalEvent,
  type WebModelFrame,
} from "@deepseek-pp/web-model-protocol";
import {
  WEB_MODEL_PATH,
  WEB_MODEL_SUBPROTOCOL,
  type DeepSeekWebModelHostAddress,
} from "@deepseek-pp/dsh-web-model-transport";
import WebSocket from "ws";

export const FAKE_EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const DEFAULT_TIMEOUT_MS = 2_000;

export interface FakeBrowserPeerOptions {
  readonly address: DeepSeekWebModelHostAddress;
  readonly pairingToken: string;
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly capabilities?: BridgeCapabilities;
}

export interface FakeGenerationScript {
  readonly events?: readonly ModelEvent[];
  readonly delivery?: "immediate" | "after_cancel";
  readonly disconnectAfterAccepted?: boolean;
}

interface FakeRequestRecord {
  readonly requestDigest: string;
  readonly script: FakeGenerationScript;
  status: Exclude<ModelStatus, "unknown">;
  lastSequence: number;
  terminal?: ModelTerminalEvent;
}

export class FakeBrowserPeer {
  private readonly socket: WebSocket;
  private readonly validator = new WebModelSequenceValidator();
  private readonly timeoutMs: number;
  private readonly generationScripts: FakeGenerationScript[] = [];
  private readonly records = new Map<string, FakeRequestRecord>();
  private readonly activityWaiters = new Set<() => void>();
  private readonly ready: Deferred<void> = deferred<void>();
  private failure: Error | undefined;
  private expectedClose = false;
  private connectionId: string | undefined;
  private readonly generateRequests: ModelGenerateRequest["params"][] = [];
  private cancelRequestCountValue = 0;
  private queryRequestCountValue = 0;

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.on("close", () => {
      if (!this.expectedClose && this.connectionId === undefined) this.fail(new Error("FAKE_PEER_CLOSED_DURING_HELLO"));
      this.notifyActivity();
    });
    socket.on("error", () => undefined);
  }

  static async connect(options: FakeBrowserPeerOptions): Promise<FakeBrowserPeer> {
    assertLoopbackAddress(options.address);
    const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const socket = new WebSocket(options.address.url, options.address.subprotocol, {
      origin: options.origin ?? FAKE_EXTENSION_ORIGIN,
    });
    let peer: FakeBrowserPeer | undefined;
    try {
      await waitForOpen(socket, timeoutMs);
      peer = new FakeBrowserPeer(socket, timeoutMs);
      const hello = {
        jsonrpc: "2.0",
        id: `rpc-hello-${randomUUID()}`,
        method: "bridge.hello",
        params: {
          schema_version: 1,
          pairing_token: options.pairingToken,
          browser_instance_id: `fake-browser-${randomUUID()}`,
          client: { name: "DeepSeek++", version: "0.0.0-fake" },
          capabilities: options.capabilities ?? defaultCapabilities(),
        },
      } as const;
      peer.sendFrame(hello);
      await withTimeout(peer.ready.promise, timeoutMs, "FAKE_PEER_HELLO_TIMEOUT");
      peer.throwIfFailed();
      return peer;
    } catch (error) {
      if (peer) peer.expectedClose = true;
      socket.terminate();
      throw error;
    }
  }

  get observedGenerateRequests(): readonly ModelGenerateRequest["params"][] {
    return this.generateRequests;
  }

  get cancelRequestCount(): number {
    return this.cancelRequestCountValue;
  }

  get queryRequestCount(): number {
    return this.queryRequestCountValue;
  }

  enqueueGeneration(script: FakeGenerationScript): void {
    validateScript(script);
    this.generationScripts.push({
      ...script,
      ...(script.events === undefined ? {} : { events: structuredClone(script.events) }),
    });
  }

  async waitForGenerateCount(expected: number): Promise<void> {
    await this.waitFor(() => this.generateRequests.length >= expected, "FAKE_GENERATE_TIMEOUT");
    this.throwIfFailed();
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  async disconnect(): Promise<void> {
    this.expectedClose = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = waitForClose(this.socket, this.timeoutMs);
    this.socket.terminate();
    await closed;
  }

  async close(): Promise<void> {
    this.expectedClose = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = waitForClose(this.socket, this.timeoutMs);
    this.socket.close(1000, "FAKE_PEER_DONE");
    await closed;
  }

  private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    try {
      if (isBinary) throw new Error("FAKE_PEER_EXPECTED_TEXT");
      const frame = this.validator.decodeAndAccept(data.toString(), "host");
      this.routeFrame(frame);
    } catch (error) {
      this.fail(asError(error));
      this.expectedClose = true;
      this.socket.close(1008, "FAKE_PEER_PROTOCOL_ERROR");
    }
  }

  private routeFrame(frame: WebModelFrame): void {
    if (!("method" in frame)) {
      if ("result" in frame && frame.result.type === "bridge.hello") {
        this.connectionId = frame.result.connection_id;
        this.ready.resolve();
        this.notifyActivity();
        return;
      }
      throw new Error("FAKE_PEER_UNEXPECTED_RESPONSE");
    }
    switch (frame.method) {
      case "model.generate":
        this.handleGenerate(frame);
        return;
      case "model.cancel":
        this.handleCancel(frame);
        return;
      case "model.query":
        this.handleQuery(frame);
        return;
      default:
        throw new Error("FAKE_PEER_UNEXPECTED_METHOD");
    }
  }

  private handleGenerate(frame: Extract<WebModelFrame, { method: "model.generate" }>): void {
    const script = this.generationScripts.shift();
    if (!script) throw new Error("FAKE_PEER_SCRIPT_MISSING");
    const record: FakeRequestRecord = {
      requestDigest: frame.params.request_digest,
      script,
      status: "accepted",
      lastSequence: 0,
    };
    this.records.set(frame.params.request_id, record);
    this.generateRequests.push(structuredClone(frame.params));
    this.notifyActivity();
    const accepted = {
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        schema_version: 1,
        type: "model.accepted",
        request_id: frame.params.request_id,
        request_digest: frame.params.request_digest,
        status: "accepted",
      },
    } as const;
    if (script.disconnectAfterAccepted === true) {
      this.sendFrame(accepted, () => {
        this.expectedClose = true;
        this.socket.terminate();
      });
      return;
    }
    this.sendFrame(accepted);
    if ((script.delivery ?? "immediate") === "immediate") this.emitScriptEvents(frame.params.request_id, record);
  }

  private handleCancel(frame: Extract<WebModelFrame, { method: "model.cancel" }>): void {
    this.cancelRequestCountValue += 1;
    this.notifyActivity();
    const record = this.records.get(frame.params.request_id);
    const status = record?.terminal ? "already_terminal" : record ? "cancel_requested" : "not_found";
    this.sendFrame({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        schema_version: 1,
        type: "model.cancelled",
        request_id: frame.params.request_id,
        request_digest: frame.params.request_digest,
        status,
      },
    });
    if (record && status === "cancel_requested" && record.script.delivery === "after_cancel") {
      this.emitScriptEvents(frame.params.request_id, record);
    }
  }

  private handleQuery(frame: Extract<WebModelFrame, { method: "model.query" }>): void {
    this.queryRequestCountValue += 1;
    this.notifyActivity();
    const record = this.records.get(frame.params.request_id);
    this.sendFrame({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        schema_version: 1,
        type: "model.status",
        request_id: frame.params.request_id,
        request_digest: frame.params.request_digest,
        status: record?.status ?? "unknown",
        last_sequence: record?.lastSequence ?? 0,
        ...(record?.terminal === undefined ? {} : { terminal: record.terminal }),
      },
    });
  }

  private emitScriptEvents(requestId: string, record: FakeRequestRecord): void {
    for (const event of record.script.events ?? []) {
      record.lastSequence += 1;
      record.status = isTerminalEvent(event) ? event.type : "streaming";
      if (isTerminalEvent(event)) record.terminal = event;
      this.sendFrame({
        jsonrpc: "2.0",
        method: "model.event",
        params: { schema_version: 1, request_id: requestId, sequence: record.lastSequence, event },
      });
    }
  }

  private sendFrame(frame: unknown, sent?: () => void): void {
    const encoded = encodeWebModelFrame(frame);
    this.validator.accept(frame, "browser");
    try {
      this.socket.send(encoded, (error) => {
        if (error) this.fail(error);
        else sent?.();
      });
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = new Error(error.message);
    this.ready.reject(this.failure);
    this.notifyActivity();
  }

  private notifyActivity(): void {
    for (const waiter of this.activityWaiters) waiter();
  }

  private async waitFor(predicate: () => boolean, code: string): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.activityWaiters.delete(check);
      };
      const check = (): void => {
        if (!predicate() && !this.failure) return;
        cleanup();
        if (this.failure) reject(this.failure);
        else resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(code));
      }, this.timeoutMs);
      this.activityWaiters.add(check);
    });
  }
}

function defaultCapabilities(): BridgeCapabilities {
  return { text: true, structured_tool_calls: true, usage: true, cancel: true, query: true };
}

function validateScript(script: FakeGenerationScript): void {
  const events = script.events ?? [];
  if (script.disconnectAfterAccepted === true) {
    if (events.length > 0 || script.delivery === "after_cancel") throw new Error("INVALID_FAKE_SCRIPT");
    return;
  }
  let terminals = 0;
  for (const event of events) if (isTerminalEvent(event)) terminals += 1;
  if (events.length === 0 || terminals !== 1 || !isTerminalEvent(events[events.length - 1] as ModelEvent)) {
    throw new Error("INVALID_FAKE_SCRIPT");
  }
}

function assertLoopbackAddress(address: DeepSeekWebModelHostAddress): void {
  const url = new URL(address.url);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== WEB_MODEL_PATH ||
      url.search !== "" || url.username !== "" || url.password !== "" ||
      address.path !== WEB_MODEL_PATH || address.subprotocol !== WEB_MODEL_SUBPROTOCOL) {
    throw new Error("FAKE_PEER_REQUIRES_LOOPBACK");
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) throw new Error("INVALID_FAKE_TIMEOUT");
  return value;
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = (): void => { cleanup(); resolve(); };
    const onError = (): void => { cleanup(); reject(new Error("FAKE_PEER_CONNECT_FAILED")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("FAKE_PEER_CONNECT_TIMEOUT")); }, timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function waitForClose(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FAKE_PEER_CLOSE_TIMEOUT")), timeoutMs);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("FAKE_PEER_FAILURE");
}
