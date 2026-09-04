import { decodeWebModelFrame, isTerminalEvent, validateWebModelFrame } from "./codec";
import type {
  BridgeCapabilities,
  ModelEvent,
  ModelStatus,
  ModelTerminalEvent,
  WebModelFrame,
} from "./types";

export type ProtocolSender = "browser" | "host";

export type ProtocolSequenceCode =
  | "CAPABILITY_NOT_ADVERTISED"
  | "CAPABILITY_NOT_OFFERED"
  | "DIRECTION_MISMATCH"
  | "DUPLICATE_REQUEST"
  | "EVENT_AFTER_TERMINAL"
  | "FIRST_FRAME_MUST_BE_HELLO"
  | "HANDSHAKE_INCOMPLETE"
  | "NON_MONOTONIC_SEQUENCE"
  | "REQUEST_DIGEST_MISMATCH"
  | "RPC_ID_MISMATCH"
  | "SEQUENCE_GAP"
  | "TERMINAL_MISMATCH"
  | "UNEXPECTED_FRAME"
  | "UNKNOWN_REQUEST";

export class ProtocolSequenceError extends Error {
  readonly code: ProtocolSequenceCode;

  constructor(code: ProtocolSequenceCode) {
    super(code);
    this.name = "ProtocolSequenceError";
    this.code = code;
  }
}

interface PendingRpc {
  method: "bridge.hello" | "model.generate" | "model.cancel" | "model.query";
  sender: ProtocolSender;
  requestId?: string;
  requestDigest?: string;
}

interface RequestState {
  requestDigest: string;
  accepted: boolean;
  status: Exclude<ModelStatus, "unknown">;
  lastSequence: number;
  terminal?: ModelTerminalEvent;
}

/** Validates an ordered bidirectional stream; transport supplies sender identity. */
export class WebModelSequenceValidator {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly requests = new Map<string, RequestState>();
  private readonly retryableGenerateDigests = new Map<string, string>();
  private firstFrameSeen = false;
  private ready = false;
  private helloId: string | undefined;
  private offeredCapabilities: BridgeCapabilities | undefined;
  private negotiatedCapabilities: BridgeCapabilities | undefined;
  private connectionId: string | undefined;

  accept(input: unknown, sender: ProtocolSender): WebModelFrame {
    if (sender !== "browser" && sender !== "host") throw new ProtocolSequenceError("DIRECTION_MISMATCH");
    const frame = validateWebModelFrame(input);
    if (!this.firstFrameSeen) {
      if (!("method" in frame) || frame.method !== "bridge.hello") {
        throw new ProtocolSequenceError("FIRST_FRAME_MUST_BE_HELLO");
      }
      if (sender !== "browser") throw new ProtocolSequenceError("DIRECTION_MISMATCH");
    }
    this.assertDirection(frame, sender);
    this.firstFrameSeen = true;
    if ("method" in frame) {
      if ("id" in frame) this.acceptRequest(frame, sender);
      else this.acceptNotification(frame);
    } else {
      this.acceptResponse(frame);
    }
    return frame;
  }

  decodeAndAccept(serialized: string, sender: ProtocolSender): WebModelFrame {
    return this.accept(decodeWebModelFrame(serialized), sender);
  }

  private assertDirection(frame: WebModelFrame, sender: ProtocolSender): void {
    if ("method" in frame) {
      const expected: ProtocolSender = frame.method === "bridge.hello" || frame.method === "model.event" || frame.method === "bridge.heartbeat"
        ? "browser"
        : "host";
      if (sender !== expected) throw new ProtocolSequenceError("DIRECTION_MISMATCH");
      return;
    }
    if (frame.id === null) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    const expected: ProtocolSender = pending.sender === "browser" ? "host" : "browser";
    if (sender !== expected) throw new ProtocolSequenceError("DIRECTION_MISMATCH");
  }

  private acceptRequest(frame: Extract<WebModelFrame, { method: string; id: string }>, sender: ProtocolSender): void {
    if (this.pending.has(frame.id)) throw new ProtocolSequenceError("DUPLICATE_REQUEST");
    if (frame.method === "bridge.hello") {
      if (this.helloId !== undefined || this.ready) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
      this.helloId = frame.id;
      this.offeredCapabilities = frame.params.capabilities;
      this.pending.set(frame.id, { method: "bridge.hello", sender });
      return;
    }
    this.assertReady();
    const current = this.requests.get(frame.params.request_id);
    if (frame.method === "model.generate") {
      if (current) throw new ProtocolSequenceError("DUPLICATE_REQUEST");
      const retryableDigest = this.retryableGenerateDigests.get(frame.params.request_id);
      if (retryableDigest !== undefined && retryableDigest !== frame.params.request_digest) {
        throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
      }
      this.retryableGenerateDigests.delete(frame.params.request_id);
      this.requests.set(frame.params.request_id, {
        requestDigest: frame.params.request_digest,
        accepted: false,
        status: "accepted",
        lastSequence: 0,
      });
    } else if (current && current.requestDigest !== frame.params.request_digest) {
      throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
    }
    this.pending.set(frame.id, {
      method: frame.method,
      sender,
      requestId: frame.params.request_id,
      requestDigest: frame.params.request_digest,
    });
  }

  private acceptNotification(frame: Extract<WebModelFrame, { method: string }> & { id?: never }): void {
    this.assertReady();
    if (frame.method === "bridge.heartbeat") {
      if (frame.params.connection_id !== this.connectionId) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
      return;
    }
    if (frame.method !== "model.event") throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    const state = this.requests.get(frame.params.request_id);
    if (!state || !state.accepted) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
    if (state.terminal !== undefined) throw new ProtocolSequenceError("EVENT_AFTER_TERMINAL");
    if (frame.params.sequence <= state.lastSequence) throw new ProtocolSequenceError("NON_MONOTONIC_SEQUENCE");
    if (frame.params.sequence !== state.lastSequence + 1) throw new ProtocolSequenceError("SEQUENCE_GAP");
    this.assertEventCapability(frame.params.event);
    state.lastSequence = frame.params.sequence;
    if (isTerminalEvent(frame.params.event)) {
      state.terminal = frame.params.event;
      state.status = frame.params.event.type;
    } else {
      state.status = "streaming";
    }
  }

  private acceptResponse(frame: Exclude<WebModelFrame, { method: string }>): void {
    if (frame.id === null) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
    const pending = this.pending.get(frame.id);
    if (!pending) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
    if ("error" in frame) {
      const data = frame.error.data;
      if (pending.method === "bridge.hello") {
        if (data.request_id !== undefined || data.request_digest !== undefined) {
          throw new ProtocolSequenceError("UNEXPECTED_FRAME");
        }
      } else {
        if (data.request_id !== pending.requestId) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
        if (data.request_digest !== pending.requestDigest) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
        if (pending.method === "model.generate" && pending.requestId !== undefined && pending.requestDigest !== undefined) {
          if (data.external_outcome === "not_started") {
            this.requests.delete(pending.requestId);
            this.retryableGenerateDigests.set(pending.requestId, pending.requestDigest);
          }
        }
      }
      this.pending.delete(frame.id);
      return;
    }
    const expectedType = {
      "bridge.hello": "bridge.hello",
      "model.generate": "model.accepted",
      "model.cancel": "model.cancelled",
      "model.query": "model.status",
    }[pending.method];
    if (frame.result.type !== expectedType) throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    if (pending.method === "bridge.hello" && frame.result.type === "bridge.hello") {
      if (frame.id !== this.helloId) throw new ProtocolSequenceError("RPC_ID_MISMATCH");
      this.assertNegotiatedSubset(frame.result.capabilities);
      this.negotiatedCapabilities = frame.result.capabilities;
      this.connectionId = frame.result.connection_id;
      this.ready = true;
    } else if (pending.method === "model.generate" && frame.result.type === "model.accepted") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
      const state = this.requests.get(frame.result.request_id);
      if (!state) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
      state.accepted = true;
    } else if (pending.method === "model.cancel" && frame.result.type === "model.cancelled") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
    } else if (pending.method === "model.query" && frame.result.type === "model.status") {
      this.assertRequestIdentity(frame.result.request_id, frame.result.request_digest, pending);
      this.observeQueryResult(
        frame.result.request_id,
        frame.result.request_digest,
        frame.result.status,
        frame.result.last_sequence,
        frame.result.terminal,
      );
    } else {
      throw new ProtocolSequenceError("UNEXPECTED_FRAME");
    }
    this.pending.delete(frame.id);
  }

  private assertRequestIdentity(requestId: string, requestDigest: string, pending: PendingRpc): void {
    if (requestId !== pending.requestId) throw new ProtocolSequenceError("UNKNOWN_REQUEST");
    if (requestDigest !== pending.requestDigest) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
  }

  private observeQueryResult(
    requestId: string,
    requestDigest: string,
    status: ModelStatus,
    lastSequence: number,
    terminal?: ModelTerminalEvent,
  ): void {
    const current = this.requests.get(requestId);
    if (current && current.requestDigest !== requestDigest) throw new ProtocolSequenceError("REQUEST_DIGEST_MISMATCH");
    if (current?.terminal) {
      if (status !== current.status || lastSequence !== current.lastSequence || terminal === undefined || !sameTerminal(current.terminal, terminal)) {
        throw new ProtocolSequenceError("TERMINAL_MISMATCH");
      }
      return;
    }
    if (!current) {
      if (status === "unknown") return;
      if (status !== "accepted" || lastSequence !== 0 || terminal !== undefined) {
        throw new ProtocolSequenceError("SEQUENCE_GAP");
      }
      this.requests.set(requestId, {
        requestDigest,
        accepted: true,
        status: "accepted",
        lastSequence: 0,
      });
      return;
    }
    if (status === current.status && lastSequence === current.lastSequence && terminal === undefined) {
      current.accepted = true;
      return;
    }
    if (terminal !== undefined && lastSequence === current.lastSequence + 1 && status === terminal.type) {
      current.accepted = true;
      current.status = status;
      current.lastSequence = lastSequence;
      current.terminal = terminal;
      return;
    }
    throw new ProtocolSequenceError("SEQUENCE_GAP");
  }

  private assertNegotiatedSubset(negotiated: BridgeCapabilities): void {
    const offered = this.offeredCapabilities;
    if (!offered) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
    for (const capability of ["text", "reasoning", "structured_tool_calls", "usage", "cancel", "query"] as const) {
      if (negotiated[capability] === true && offered[capability] !== true) {
        throw new ProtocolSequenceError("CAPABILITY_NOT_OFFERED");
      }
    }
  }

  private assertReady(): void {
    if (!this.ready) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
  }

  private assertEventCapability(event: ModelEvent): void {
    const supported = this.negotiatedCapabilities;
    if (!supported) throw new ProtocolSequenceError("HANDSHAKE_INCOMPLETE");
    if (event.type === "text_delta" && supported.text !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "reasoning_delta" && supported.reasoning !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "usage" && supported.usage !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
    if (event.type === "tool_call" && supported.structured_tool_calls !== true) throw new ProtocolSequenceError("CAPABILITY_NOT_ADVERTISED");
  }
}

function sameTerminal(left: ModelTerminalEvent, right: ModelTerminalEvent): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "completed":
      return right.type === "completed" && left.finish_reason === right.finish_reason;
    case "aborted":
    case "ambiguous":
      return right.type === left.type && left.reason === right.reason;
    case "failed":
      return right.type === "failed" && left.error.code === right.error.code && left.error.message === right.error.message &&
        left.error.retryable === right.error.retryable && left.error.external_outcome === right.error.external_outcome;
  }
}
