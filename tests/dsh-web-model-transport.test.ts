import { createServer } from "node:http";

import {
  MAX_FRAME_BYTES,
  encodeWebModelFrame,
  type ModelEvent,
  type ModelTerminalEvent,
  type WebModelFrame,
} from "../packages/web-model-protocol/src/index";
import {
  BrokerError,
  DeepSeekWebModelHost,
  WEB_MODEL_SUBPROTOCOL,
  type BrokerGenerateRequest,
  type DeepSeekWebModelHostAddress,
  type DeepSeekWebModelHostOptions,
} from "../packages/dsh-web-model-transport/src/index";
import { generateRequest, helloRequest } from "./fixtures/harness-bridge/protocol-v1/frames";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const TOKEN = "A".repeat(43);
const WRONG_TOKEN = "B".repeat(43);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const DEFAULT_TEST_DEADLINE_MS = 2_000;

const hosts = new Set<DeepSeekWebModelHost>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all([...hosts].map((host) => host.stop()));
  hosts.clear();
});

describe("DSH web model loopback host", () => {
  it("authenticates and carries accepted, streamed events, and one terminal", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    expect(address.host).toBe("127.0.0.1");
    expect(browser.protocol).toBe(WEB_MODEL_SUBPROTOCOL);
    const result = collect(host.generate(generateInput()));
    const request = await nextFrame(browser);
    expect(request).toMatchObject({ method: "model.generate", params: { request_id: "request-1" } });
    sendAccepted(browser, request);
    const events: ModelEvent[] = [
      { type: "text_delta", text: "one" },
      { type: "text_delta", text: "two" },
      { type: "tool_call", tool_call_id: "call-2", name: "read_file", arguments: { path: "README.md" } },
      { type: "usage", input_tokens: 10, output_tokens: 3 },
      { type: "completed", finish_reason: "tool_calls" },
    ];
    events.forEach((event, index) => sendEvent(browser, index + 1, event));
    await expect(result).resolves.toEqual(events);
  });

  it("reports waiting_for_browser when no socket is connected", async () => {
    const { host } = await startHost();
    await expect(collect(host.generate(generateInput()))).rejects.toMatchObject({
      code: "WAITING_FOR_BROWSER",
      externalOutcome: "not_started",
    });
  });

  it("rejects an invalid local generate before sending and permits a corrected retry", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const invalid = {
      ...generateInput(),
      model: { provider: "deepseek-web", model_id: "unsupported-model" },
    } as unknown as BrokerGenerateRequest;
    await expect(collect(host.generate(invalid))).rejects.toMatchObject({
      code: "PROTOCOL_VIOLATION",
      externalOutcome: "not_started",
    });
    await expect(nextFrameOrTimeout(browser, 60)).resolves.toBeUndefined();

    const result = collect(host.generate(generateInput()));
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    sendEvent(browser, 1, { type: "completed", finish_reason: "stop" });
    await expect(result).resolves.toEqual([{ type: "completed", finish_reason: "stop" }]);
  });

  it("settles a synchronous send race as ambiguous and never replays it", async () => {
    const { host, address } = await startHost();
    await connectAndAuthenticate(address);
    const serverSocket = (host as unknown as { connection: { socket: WebSocket } }).connection.socket;
    Object.defineProperty(serverSocket, "send", {
      configurable: true,
      value: (): never => { throw new Error("simulated send race"); },
    });

    await expect(collect(host.generate(generateInput()))).resolves.toEqual([
      { type: "ambiguous", reason: "send_outcome_unknown" },
    ]);
    await expect(collect(host.generate(generateInput()))).rejects.toMatchObject({
      code: "REQUEST_ALREADY_EXISTS",
      externalOutcome: "unknown",
    });
  });

  it("does not dispatch to an unauthenticated peer and reports waiting_for_browser", async () => {
    const { host, address } = await startHost({ authenticationTimeoutMs: 300 });
    const browser = await connect(address);
    const message = nextFrameOrTimeout(browser, 80);
    await expect(collect(host.generate(generateInput()))).rejects.toMatchObject({
      code: "WAITING_FOR_BROWSER",
      externalOutcome: "not_started",
    });
    await expect(message).resolves.toBeUndefined();
  });

  it("rejects wrong token without reflecting it", async () => {
    const { address } = await startHost();
    const browser = await connect(address);
    const closed = waitForClose(browser);
    browser.send(encodeWebModelFrame(helloFor(WRONG_TOKEN)));
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(result.reason).toBe("AUTH_FAILED");
    expect(result.reason).not.toContain(WRONG_TOKEN);

    const malformedHost = await startHost();
    const malformed = await connect(malformedHost.address);
    const malformedClosed = waitForClose(malformed);
    malformed.send(JSON.stringify({ ...helloFor(TOKEN), unknown: true }));
    await expect(malformedClosed).resolves.toMatchObject({ code: 1008, reason: "PROTOCOL_ERROR" });
  });

  it("rejects wildcard or non-extension origin configuration", () => {
    expect(() => new DeepSeekWebModelHost({ pairingToken: TOKEN, allowedOrigins: ["*"] })).toThrow("INVALID_ORIGIN_ALLOWLIST");
    expect(() => new DeepSeekWebModelHost({ pairingToken: TOKEN, allowedOrigins: ["https://example.com"] }))
      .toThrow("INVALID_ORIGIN_ALLOWLIST");
  });

  it.each([
    ["origin", { origin: "https://evil.example" }],
    ["Host", { headers: { Host: "localhost:1" } }],
    ["path", { path: "/wrong" }],
    ["query token", { path: "/web-model/v1?token=secret" }],
    ["subprotocol", { protocol: "wrong.v1" }],
  ] as const)("rejects an invalid %s during upgrade", async (_name, change) => {
    const { address } = await startHost();
    await expect(openRejected(address, change)).resolves.toBe(403);
  });

  it("holds a single pending or authenticated peer lease", async () => {
    const { address } = await startHost();
    const first = await connect(address);
    await expect(openRejected(address, {})).resolves.toBe(409);
    first.terminate();
    await waitForClose(first);
    const authenticated = await connectAndAuthenticate(address);
    await expect(openRejected(address, {})).resolves.toBe(409);
    expect(authenticated.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects binary, oversized, and malformed frames", async () => {
    const binaryHost = await startHost();
    const binary = await connectAndAuthenticate(binaryHost.address);
    const binaryClosed = waitForClose(binary);
    binary.send(Buffer.from("{}"), { binary: true });
    await expect(binaryClosed).resolves.toMatchObject({ code: 1003, reason: "TEXT_REQUIRED" });

    const malformedHost = await startHost();
    const malformed = await connectAndAuthenticate(malformedHost.address);
    const malformedClosed = waitForClose(malformed);
    malformed.send("{");
    await expect(malformedClosed).resolves.toMatchObject({ code: 1008, reason: "PROTOCOL_ERROR" });

    const oversizedHost = await startHost();
    const oversized = await connectAndAuthenticate(oversizedHost.address);
    const oversizedClosed = waitForClose(oversized);
    oversized.send("x".repeat(MAX_FRAME_BYTES + 1));
    await expect(oversizedClosed).resolves.toMatchObject({ code: 1009 });
  });

  it("fails closed on sequence gaps, wrong requests, and response correlation", async () => {
    const gapHost = await startHost();
    const gapBrowser = await connectAndAuthenticate(gapHost.address);
    const gapResult = collect(gapHost.host.generate(generateInput()));
    const gapRequest = await nextFrame(gapBrowser);
    sendAccepted(gapBrowser, gapRequest);
    sendEvent(gapBrowser, 2, { type: "text_delta", text: "gap" });
    await expect(gapResult).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);

    const wrongHost = await startHost();
    const wrongBrowser = await connectAndAuthenticate(wrongHost.address);
    const wrongResult = collect(wrongHost.host.generate(generateInput()));
    const wrongRequest = await nextFrame(wrongBrowser);
    sendAccepted(wrongBrowser, wrongRequest);
    wrongBrowser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      method: "model.event",
      params: {
        schema_version: 1,
        request_id: "wrong-request",
        sequence: 1,
        event: { type: "text_delta", text: "wrong" },
      },
    }));
    await expect(wrongResult).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);

    const correlationHost = await startHost();
    const correlationBrowser = await connectAndAuthenticate(correlationHost.address);
    const correlationResult = collect(correlationHost.host.generate(generateInput()));
    const correlationRequest = await nextFrame(correlationBrowser);
    correlationBrowser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      id: "wrong-rpc",
      result: {
        schema_version: 1,
        type: "model.accepted",
        request_id: "request-1",
        request_digest: "a".repeat(64),
        status: "accepted",
      },
    }));
    await expect(correlationResult).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);

    const digestHost = await startHost();
    const digestBrowser = await connectAndAuthenticate(digestHost.address);
    const digestResult = collect(digestHost.host.generate(generateInput()));
    const digestRequest = await nextFrame(digestBrowser) as any;
    digestBrowser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      id: digestRequest.id,
      result: {
        schema_version: 1,
        type: "model.accepted",
        request_id: "request-1",
        request_digest: "b".repeat(64),
        status: "accepted",
      },
    }));
    await expect(digestResult).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);
  });

  it("ignores a valid terminal sent immediately after a protocol violation", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const result = collect(host.generate(generateInput()));
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    const closed = waitForClose(browser);
    sendEvent(browser, 2, { type: "text_delta", text: "gap" });
    sendEvent(browser, 1, { type: "completed", finish_reason: "stop" });
    await expect(result).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);
    await expect(closed).resolves.toMatchObject({ code: 1008, reason: "PROTOCOL_ERROR" });
  });

  it("closes on late or duplicate terminal events without changing the completed result", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const result = collect(host.generate(generateInput()));
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    const terminal = { type: "completed", finish_reason: "stop" } as const;
    sendEvent(browser, 1, terminal);
    await expect(result).resolves.toEqual([terminal]);
    const closed = waitForClose(browser);
    sendEvent(browser, 2, terminal);
    await expect(closed).resolves.toMatchObject({ code: 1008, reason: "PROTOCOL_ERROR" });
  });

  it("settles an accepted request as ambiguous when the browser disconnects", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const result = collect(host.generate(generateInput()));
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    browser.close();
    await expect(result).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);
  });

  it("settles a sent request as ambiguous when accepted is not received before timeout", async () => {
    const { host, address } = await startHost({ rpcTimeoutMs: 40 });
    const browser = await connectAndAuthenticate(address);
    const result = collect(host.generate(generateInput()));
    await nextFrame(browser);
    await expect(result).resolves.toEqual([{ type: "ambiguous", reason: "accept_timeout" }]);
    await expect(waitForClose(browser)).resolves.toMatchObject({ code: 1008, reason: "REQUEST_TIMEOUT" });
  });

  it("keeps an observable ambiguous terminal when the consumer buffer is full", async () => {
    const { host, address } = await startHost({ maxBufferedEvents: 1 });
    const browser = await connectAndAuthenticate(address);
    const iterator = host.generate(generateInput())[Symbol.asyncIterator]();
    const first = iterator.next();
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    sendEvent(browser, 1, { type: "text_delta", text: "first" });
    sendEvent(browser, 2, { type: "text_delta", text: "buffered" });
    sendEvent(browser, 3, { type: "text_delta", text: "overflow" });
    await expect(first).resolves.toEqual({ done: false, value: { type: "text_delta", text: "first" } });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "ambiguous", reason: "stream_limit_exceeded" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not allow an ambiguous or terminal request identity to be generated again", async () => {
    const disconnectedHost = await startHost();
    let browser = await connectAndAuthenticate(disconnectedHost.address);
    const ambiguousResult = collect(disconnectedHost.host.generate(generateInput()));
    const request = await nextFrame(browser);
    sendAccepted(browser, request);
    const closed = waitForClose(browser);
    browser.close();
    await closed;
    await waitForPeerUnavailable(disconnectedHost.host);
    await expect(ambiguousResult).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);
    browser = await connectAndAuthenticate(disconnectedHost.address);
    await expect(collect(disconnectedHost.host.generate(generateInput()))).rejects.toMatchObject({
      code: "REQUEST_ALREADY_EXISTS",
      externalOutcome: "unknown",
    });
    await expect(nextFrameOrTimeout(browser, 60)).resolves.toBeUndefined();

    const terminalHost = await startHost();
    const terminalBrowser = await connectAndAuthenticate(terminalHost.address);
    const terminalResult = collect(terminalHost.host.generate(generateInput()));
    const terminalRequest = await nextFrame(terminalBrowser);
    sendAccepted(terminalBrowser, terminalRequest);
    sendEvent(terminalBrowser, 1, { type: "completed", finish_reason: "stop" });
    await terminalResult;
    await expect(collect(terminalHost.host.generate(generateInput()))).rejects.toMatchObject({
      code: "REQUEST_ALREADY_EXISTS",
      externalOutcome: "started",
    });
  });

  it("hydrates accepted, streaming, and terminal checkpoints for queries after reconnect", async () => {
    const identity = { request_id: "request-1", request_digest: "a".repeat(64) };

    const acceptedCase = await startHost();
    let browser = await connectAndAuthenticate(acceptedCase.address);
    const acceptedGeneration = collect(acceptedCase.host.generate(generateInput()));
    let request = await nextFrame(browser);
    sendAccepted(browser, request);
    await disconnect(browser, acceptedCase.host);
    await expect(acceptedGeneration).resolves.toEqual([{ type: "ambiguous", reason: "browser_disconnected" }]);
    browser = await connectAndAuthenticate(acceptedCase.address);
    const acceptedQuery = acceptedCase.host.query(identity);
    request = await nextFrame(browser);
    sendStatus(browser, request, { status: "accepted", last_sequence: 0 });
    await expect(acceptedQuery).resolves.toMatchObject({ status: "accepted", last_sequence: 0 });

    const streamingCase = await startHost();
    browser = await connectAndAuthenticate(streamingCase.address);
    const streamingGeneration = collect(streamingCase.host.generate(generateInput()));
    request = await nextFrame(browser);
    sendAccepted(browser, request);
    sendEvent(browser, 1, { type: "text_delta", text: "observed" });
    await disconnect(browser, streamingCase.host);
    await expect(streamingGeneration).resolves.toEqual([
      { type: "text_delta", text: "observed" },
      { type: "ambiguous", reason: "browser_disconnected" },
    ]);
    browser = await connectAndAuthenticate(streamingCase.address);
    const streamingQuery = streamingCase.host.query(identity);
    request = await nextFrame(browser);
    sendStatus(browser, request, { status: "streaming", last_sequence: 1 });
    await expect(streamingQuery).resolves.toMatchObject({ status: "streaming", last_sequence: 1 });

    const terminalCase = await startHost();
    browser = await connectAndAuthenticate(terminalCase.address);
    const terminalGeneration = collect(terminalCase.host.generate(generateInput()));
    request = await nextFrame(browser);
    sendAccepted(browser, request);
    const terminal = { type: "completed", finish_reason: "stop" } as const;
    sendEvent(browser, 1, terminal);
    await expect(terminalGeneration).resolves.toEqual([terminal]);
    await disconnect(browser, terminalCase.host);
    browser = await connectAndAuthenticate(terminalCase.address);
    const terminalQuery = terminalCase.host.query(identity);
    request = await nextFrame(browser);
    sendStatus(browser, request, { status: "completed", last_sequence: 1, terminal });
    await expect(terminalQuery).resolves.toMatchObject({ status: "completed", last_sequence: 1, terminal });
  });

  it("makes cancel idempotent and correlates query results", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const identity = { request_id: "request-1", request_digest: "a".repeat(64) };

    const cancelPromise = host.cancel({ ...identity, reason: "user_requested" });
    const cancelFrame = await nextFrame(browser) as any;
    expect(cancelFrame.method).toBe("model.cancel");
    browser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      id: cancelFrame.id,
      result: {
        schema_version: 1,
        type: "model.cancelled",
        ...identity,
        status: "not_found",
      },
    }));
    const cancelResult = await cancelPromise;
    await expect(host.cancel(identity)).resolves.toEqual(cancelResult);
    await expect(nextFrameOrTimeout(browser, 60)).resolves.toBeUndefined();

    const queryPromise = host.query(identity);
    const queryFrame = await nextFrame(browser) as any;
    expect(queryFrame.method).toBe("model.query");
    browser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      id: queryFrame.id,
      result: {
        schema_version: 1,
        type: "model.status",
        ...identity,
        status: "unknown",
        last_sequence: 0,
      },
    }));
    await expect(queryPromise).resolves.toMatchObject({ status: "unknown", ...identity });
  });

  it("coalesces concurrent duplicate cancel calls into one RPC", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const identity = { request_id: "request-1", request_digest: "a".repeat(64) };
    const first = host.cancel(identity);
    const second = host.cancel(identity);
    const cancelFrame = await nextFrame(browser) as any;
    await expect(nextFrameOrTimeout(browser, 60)).resolves.toBeUndefined();
    browser.send(encodeWebModelFrame({
      jsonrpc: "2.0",
      id: cancelFrame.id,
      result: {
        schema_version: 1,
        type: "model.cancelled",
        ...identity,
        status: "not_found",
      },
    }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "not_found" }),
      expect.objectContaining({ status: "not_found" }),
    ]);
  });

  it("invalidates a cached not_found cancellation when generation starts", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const identity = { request_id: "request-1", request_digest: "a".repeat(64) };
    const firstCancel = host.cancel(identity);
    const firstCancelFrame = await nextFrame(browser);
    sendCancelled(browser, firstCancelFrame, "not_found");
    await expect(firstCancel).resolves.toMatchObject({ status: "not_found" });

    const generation = collect(host.generate(generateInput()));
    const generateFrame = await nextFrame(browser);
    sendAccepted(browser, generateFrame);
    const secondCancel = host.cancel(identity);
    const secondCancelFrame = await nextFrame(browser);
    expect("id" in secondCancelFrame && secondCancelFrame.id).not.toBe("id" in firstCancelFrame && firstCancelFrame.id);
    sendCancelled(browser, secondCancelFrame, "cancel_requested");
    await expect(secondCancel).resolves.toMatchObject({ status: "cancel_requested" });
    sendEvent(browser, 1, { type: "aborted", reason: "cancelled" });
    await expect(generation).resolves.toEqual([{ type: "aborted", reason: "cancelled" }]);
  });

  it("does not let a stale cancel cache bypass a newer generation digest", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const oldIdentity = { request_id: "request-1", request_digest: "a".repeat(64) };
    const oldCancel = host.cancel(oldIdentity);
    const oldCancelFrame = await nextFrame(browser);
    sendCancelled(browser, oldCancelFrame, "not_found");
    await oldCancel;

    const newDigest = "b".repeat(64);
    const generation = collect(host.generate({ ...generateInput(), request_digest: newDigest }));
    const generateFrame = await nextFrame(browser);
    sendAccepted(browser, generateFrame);
    await expect(host.cancel(oldIdentity)).rejects.toMatchObject({
      code: "REQUEST_DIGEST_MISMATCH",
      externalOutcome: "not_started",
    });
    const newCancel = host.cancel({ request_id: "request-1", request_digest: newDigest });
    const newCancelFrame = await nextFrame(browser);
    sendCancelled(browser, newCancelFrame, "cancel_requested");
    await expect(newCancel).resolves.toMatchObject({ status: "cancel_requested", request_digest: newDigest });
    sendEvent(browser, 1, { type: "aborted", reason: "cancelled" });
    await generation;
  });

  it("rejects generation while cancellation for the request id is in flight without poisoning it", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const identity = { request_id: "request-1", request_digest: "a".repeat(64) };
    const cancellation = host.cancel(identity);
    const cancelFrame = await nextFrame(browser);
    await expect(collect(host.generate(generateInput()))).rejects.toMatchObject({
      code: "BROKER_BUSY",
      externalOutcome: "not_started",
    });
    await expect(collect(host.generate({ ...generateInput(), request_digest: "b".repeat(64) }))).rejects.toMatchObject({
      code: "BROKER_BUSY",
      externalOutcome: "not_started",
    });
    await expect(nextFrameOrTimeout(browser, 60)).resolves.toBeUndefined();
    sendCancelled(browser, cancelFrame, "not_found");
    await cancellation;

    const generation = collect(host.generate(generateInput()));
    const generateFrame = await nextFrame(browser);
    sendAccepted(browser, generateFrame);
    sendEvent(browser, 1, { type: "completed", finish_reason: "stop" });
    await expect(generation).resolves.toEqual([{ type: "completed", finish_reason: "stop" }]);
  });

  it("enforces heartbeat timeout", async () => {
    const { address } = await startHost({ heartbeatTimeoutMs: 50 });
    const browser = await connectAndAuthenticate(address);
    await expect(waitForClose(browser, 500)).resolves.toMatchObject({ code: 1008, reason: "HEARTBEAT_TIMEOUT" });
  });

  it("stops all sockets and releases the selected port", async () => {
    const { host, address } = await startHost();
    const browser = await connectAndAuthenticate(address);
    const closed = waitForClose(browser);
    await host.stop();
    hosts.delete(host);
    await closed;
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port: address.port }, resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  });
});

function generateInput(): BrokerGenerateRequest {
  const { schema_version: _schemaVersion, ...request } = generateRequest.params;
  return structuredClone(request) as unknown as BrokerGenerateRequest;
}

async function startHost(overrides: Partial<DeepSeekWebModelHostOptions> = {}) {
  const host = new DeepSeekWebModelHost({
    pairingToken: TOKEN,
    allowedOrigins: [ORIGIN],
    ...overrides,
  });
  hosts.add(host);
  return { host, address: await host.start() };
}

async function connect(address: DeepSeekWebModelHostAddress, options: {
  origin?: string;
  protocol?: string;
  path?: string;
  headers?: Record<string, string>;
} = {}): Promise<WebSocket> {
  const base = `ws://${address.host}:${address.port}`;
  const socket = new WebSocket(`${base}${options.path ?? address.path}`, options.protocol ?? address.subprotocol, {
    origin: options.origin ?? ORIGIN,
    headers: options.headers,
  });
  sockets.add(socket);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function connectAndAuthenticate(address: DeepSeekWebModelHostAddress): Promise<WebSocket> {
  const socket = await connect(address);
  const response = nextFrame(socket);
  socket.send(encodeWebModelFrame(helloFor(TOKEN)));
  await expect(response).resolves.toMatchObject({ result: { type: "bridge.hello", status: "ready" } });
  return socket;
}

function helloFor(token: string) {
  return {
    ...helloRequest,
    params: { ...helloRequest.params, pairing_token: token },
  };
}

async function openRejected(address: DeepSeekWebModelHostAddress, change: {
  origin?: string;
  protocol?: string;
  path?: string;
  headers?: Record<string, string>;
}): Promise<number> {
  const base = `ws://${address.host}:${address.port}`;
  const path = change.path ?? address.path;
  const headers = change.headers?.Host === "localhost:1"
    ? { Host: `localhost:${address.port}` }
    : change.headers;
  const socket = new WebSocket(`${base}${path}`, change.protocol ?? WEB_MODEL_SUBPROTOCOL, {
    origin: change.origin ?? ORIGIN,
    headers,
  });
  sockets.add(socket);
  socket.on("error", () => undefined);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UPGRADE_TIMEOUT")), 500);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => { clearTimeout(timer); reject(new Error("UPGRADE_UNEXPECTEDLY_SUCCEEDED")); });
  });
}

function nextFrame(socket: WebSocket, timeoutMs = DEFAULT_TEST_DEADLINE_MS): Promise<WebModelFrame> {
  return new Promise<WebModelFrame>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      cleanup();
      if (isBinary) return reject(new Error("UNEXPECTED_BINARY"));
      try {
        resolve(JSON.parse(data.toString()) as WebModelFrame);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(new Error(`SOCKET_CLOSED_${code}_${reason.toString()}`));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("SOCKET_ERROR"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("MESSAGE_TIMEOUT"));
    }, timeoutMs);
    socket.once("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function nextFrameOrTimeout(socket: WebSocket, timeoutMs: number): Promise<WebModelFrame | undefined> {
  return new Promise<WebModelFrame | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(undefined);
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      clearTimeout(timer);
      if (isBinary) reject(new Error("UNEXPECTED_BINARY"));
      else resolve(JSON.parse(data.toString()) as WebModelFrame);
    };
    socket.once("message", onMessage);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = DEFAULT_TEST_DEADLINE_MS): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CLOSE_TIMEOUT")), timeoutMs);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function sendAccepted(browser: WebSocket, request: WebModelFrame): void {
  if (!("method" in request) || request.method !== "model.generate") throw new Error("EXPECTED_GENERATE");
  browser.send(encodeWebModelFrame({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      schema_version: 1,
      type: "model.accepted",
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      status: "accepted",
    },
  }));
}

function sendEvent(browser: WebSocket, sequence: number, event: ModelEvent): void {
  browser.send(encodeWebModelFrame({
    jsonrpc: "2.0",
    method: "model.event",
    params: { schema_version: 1, request_id: "request-1", sequence, event },
  }));
}

function sendCancelled(
  browser: WebSocket,
  request: WebModelFrame,
  status: "cancel_requested" | "already_terminal" | "not_found",
): void {
  if (!("method" in request) || request.method !== "model.cancel") throw new Error("EXPECTED_CANCEL");
  browser.send(encodeWebModelFrame({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      schema_version: 1,
      type: "model.cancelled",
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      status,
    },
  }));
}

function sendStatus(
  browser: WebSocket,
  request: WebModelFrame,
  status: { status: "accepted" | "streaming" | "completed" | "aborted" | "failed" | "ambiguous"; last_sequence: number; terminal?: ModelTerminalEvent },
): void {
  if (!("method" in request) || request.method !== "model.query") throw new Error("EXPECTED_QUERY");
  browser.send(encodeWebModelFrame({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      schema_version: 1,
      type: "model.status",
      request_id: request.params.request_id,
      request_digest: request.params.request_digest,
      ...status,
    },
  }));
}

async function disconnect(socket: WebSocket, host: DeepSeekWebModelHost): Promise<void> {
  const closed = waitForClose(socket);
  socket.close();
  await closed;
  await waitForPeerUnavailable(host);
}

async function waitForPeerUnavailable(host: DeepSeekWebModelHost): Promise<void> {
  const deadlineAt = Date.now() + DEFAULT_TEST_DEADLINE_MS;
  while (host.hasAuthenticatedPeer) {
    if (Date.now() >= deadlineAt) throw new Error("PEER_CLOSE_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
