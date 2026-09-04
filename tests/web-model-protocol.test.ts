import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_ARRAY_LENGTH,
  MAX_FRAME_BYTES,
  ProtocolSequenceError,
  ProtocolValidationError,
  WebModelSequenceValidator,
  decodeWebModelFrame,
  encodeWebModelJsonLines,
  encodeWebModelFrame,
  isEphemeralModelEvent,
  validateWebModelFrame,
} from "../packages/web-model-protocol/src/index";
import {
  acceptedResponse,
  cancelRequest,
  cancelResponse,
  eventFrames,
  generateRequest,
  heartbeat,
  helloRequest,
  helloResponse,
  helloWithReasoningRequest,
  helloWithReasoningResponse,
  queryRequest,
  queryResponse,
  standardError,
  successSequenceFrames,
  validFrames,
} from "./fixtures/harness-bridge/protocol-v1/frames";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Web Model Protocol v1 codec", () => {
  it("round-trips every golden frame through strict JSON-RPC 2.0 validation", () => {
    for (const frame of validFrames) {
      const encoded = encodeWebModelFrame(frame);
      expect(decodeWebModelFrame(encoded)).toEqual(frame);
    }
  });

  it("matches the fixed UTF-8 JSONL golden byte-for-byte and decodes every line", () => {
    const encoded = encodeWebModelJsonLines(successSequenceFrames);
    const goldenPath = resolve(process.cwd(), "tests/fixtures/harness-bridge/protocol-v1/success-sequence.jsonl");
    expect(readFileSync(goldenPath)).toEqual(Buffer.from(encoded, "utf8"));
    expect(encoded).not.toContain('"reasoning":true');
    expect(encoded).not.toContain('"reasoning_delta"');
    const lines = encoded.slice(0, -1).split("\n");
    expect(lines.map(decodeWebModelFrame)).toEqual(successSequenceFrames);
  });

  it("rejects malformed and oversized frames before parsing", () => {
    expect(() => decodeWebModelFrame("{"))
      .toThrowError(ProtocolValidationError);
    const oversized = " ".repeat(MAX_FRAME_BYTES + 1);
    expect(() => decodeWebModelFrame(oversized)).toThrowError(/FRAME_TOO_LARGE/);
  });

  it("rejects unknown fields and future schema versions at every typed boundary", () => {
    const root = { ...helloRequest, surprise: true };
    expect(() => validateWebModelFrame(root)).toThrowError(/UNKNOWN_FIELD/);

    const nested = clone(generateRequest) as any;
    nested.params.options.future_option = true;
    expect(() => validateWebModelFrame(nested)).toThrowError(/UNKNOWN_FIELD/);

    const future = clone(heartbeat) as any;
    future.params.schema_version = 2;
    expect(() => validateWebModelFrame(future)).toThrowError(/UNSUPPORTED_VERSION/);
  });

  it("validates ids, digest, purpose, options, and tool schemas", () => {
    const badDigest = clone(generateRequest) as any;
    badDigest.params.request_digest = "A".repeat(64);
    expect(() => validateWebModelFrame(badDigest)).toThrowError(/INVALID_VALUE/);

    const badPurpose = clone(generateRequest) as any;
    badPurpose.params.purpose = "session_title";
    expect(() => validateWebModelFrame(badPurpose)).toThrowError(/INVALID_VALUE/);

    const badOptions = clone(generateRequest) as any;
    badOptions.params.options.temperature = 0;
    expect(() => validateWebModelFrame(badOptions)).toThrowError(/UNKNOWN_FIELD/);

    const badSchema = clone(generateRequest) as any;
    badSchema.params.tools[0].input_schema = [];
    expect(() => validateWebModelFrame(badSchema)).toThrowError(/INVALID_TYPE/);

    const historicalReasoning = clone(generateRequest) as any;
    historicalReasoning.params.input.messages[2].content.unshift({ type: "reasoning", text: "private" });
    expect(() => validateWebModelFrame(historicalReasoning)).toThrowError(/INVALID_VALUE/);

    const retainedText = clone(eventFrames[1]) as any;
    retainedText.params.event.retention = "ephemeral";
    expect(() => validateWebModelFrame(retainedText)).toThrowError(/UNKNOWN_FIELD/);

    const missingRetention = clone(eventFrames[0]) as any;
    delete missingRetention.params.event.retention;
    expect(() => validateWebModelFrame(missingRetention)).toThrowError(/INVALID_VALUE|UNKNOWN_FIELD/);
  });

  it("enforces structural, array, and UTF-16 bounds", () => {
    const tooManyTools = clone(generateRequest) as any;
    tooManyTools.params.tools = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, () => ({
      name: "tool",
      description: "tool",
      input_schema: { type: "object" },
    }));
    expect(() => validateWebModelFrame(tooManyTools)).toThrowError(/ARRAY_TOO_LONG/);

    const tooDeep = clone(generateRequest) as any;
    let cursor = tooDeep.params.tools[0].input_schema;
    for (let index = 0; index < 40; index += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(() => validateWebModelFrame(tooDeep)).toThrowError(/STRUCTURE_TOO_DEEP/);

    const invalidUnicode = clone(eventFrames[1]) as any;
    // Build this at runtime: some TS transforms normalize a source-level lone
    // surrogate before the validator can observe it.
    invalidUnicode.params.event.text = String.fromCharCode(0xd800);
    expect(() => encodeWebModelFrame(invalidUnicode)).toThrowError(/INVALID_UNICODE/);

    const invalidNumber = clone(eventFrames[3]) as any;
    invalidNumber.params.event.input_tokens = Number.NaN;
    expect(() => encodeWebModelFrame(invalidNumber)).toThrowError(/INVALID_TYPE/);
  });

  it("rejects credential, browser-control, and unrelated fields on typed DTOs", () => {
    for (const forbidden of ["Cookie", "Authorization", "api_key", "CDP", "MCP"]) {
      const frame = clone(generateRequest) as any;
      frame.params[forbidden] = "secret";
      expect(() => validateWebModelFrame(frame), forbidden).toThrowError(/UNKNOWN_FIELD/);
    }
    const arbitraryToolSchema = clone(generateRequest) as any;
    arbitraryToolSchema.params.tools[0].input_schema.properties.authorization = { type: "string" };
    expect(validateWebModelFrame(arbitraryToolSchema)).toEqual(arbitraryToolSchema);
  });

  it("accepts standard JSON-RPC errors but rejects ambiguous response envelopes", () => {
    expect(validateWebModelFrame(standardError)).toEqual(standardError);
    expect(() => validateWebModelFrame({ ...standardError, result: {} })).toThrowError(/UNKNOWN_FIELD|INVALID_RESPONSE/);

    const badError = clone(standardError) as any;
    badError.error.data.schema_version = 9;
    expect(() => validateWebModelFrame(badError)).toThrowError(/UNSUPPORTED_VERSION/);

    const ambiguousRetry = clone(standardError) as any;
    ambiguousRetry.error.data.retryable = true;
    ambiguousRetry.error.data.external_outcome = "unknown";
    expect(() => validateWebModelFrame(ambiguousRetry)).toThrowError(/INVALID_VALUE/);

    const missingOutcome = clone(standardError) as any;
    delete missingOutcome.error.data.external_outcome;
    expect(() => validateWebModelFrame(missingOutcome)).toThrowError(/INVALID_VALUE|UNKNOWN_FIELD/);

    const missingData = clone(standardError) as any;
    delete missingData.error.data;
    expect(() => validateWebModelFrame(missingData)).toThrowError(/INVALID_VALUE|UNKNOWN_FIELD/);

    const replayableFailure = clone(eventFrames[4]) as any;
    replayableFailure.params.event = {
      type: "failed",
      error: {
        code: "WEB_FAILURE",
        message: "Outcome may have started.",
        retryable: true,
        external_outcome: "unknown",
      },
    };
    expect(() => validateWebModelFrame(replayableFailure)).toThrowError(/INVALID_VALUE/);

    const nonReplayableFailure = clone(replayableFailure);
    nonReplayableFailure.params.event.error.retryable = false;
    nonReplayableFailure.params.event.error.external_outcome = "started";
    expect(validateWebModelFrame(nonReplayableFailure)).toEqual(nonReplayableFailure);
  });

  it("marks only reasoning deltas as ephemeral", () => {
    expect(isEphemeralModelEvent(eventFrames[0].params.event)).toBe(true);
    for (const frame of eventFrames.slice(1)) {
      expect(isEphemeralModelEvent(frame.params.event), frame.params.event.type).toBe(false);
    }
    expect(isEphemeralModelEvent({ type: "aborted", reason: "cancelled" })).toBe(false);
    expect(isEphemeralModelEvent({
      type: "failed",
      error: { code: "FAILED", message: "failed", retryable: false, external_outcome: "started" },
    })).toBe(false);
    expect(isEphemeralModelEvent({ type: "ambiguous", reason: "outcome unknown" })).toBe(false);
  });
});

describe("Web Model Protocol v1 sequence validator", () => {
  it("hydrates only exact post-handshake request checkpoints without permitting gaps", () => {
    const checkpoint = {
      request_id: "request-1",
      request_digest: "a".repeat(64),
      status: "accepted",
      last_sequence: 0,
    } as const;
    expect(() => new WebModelSequenceValidator().hydrateRequestCheckpoint(checkpoint))
      .toThrowError(/HANDSHAKE_INCOMPLETE/);

    const hydrated = new WebModelSequenceValidator();
    hydrated.accept(helloRequest, "browser");
    hydrated.accept(helloResponse, "host");
    hydrated.hydrateRequestCheckpoint(checkpoint);
    hydrated.hydrateRequestCheckpoint(checkpoint);
    hydrated.accept({ ...eventFrames[1], params: { ...eventFrames[1].params, sequence: 1 } }, "browser");

    const terminal = new WebModelSequenceValidator();
    terminal.accept(helloRequest, "browser");
    terminal.accept(helloResponse, "host");
    const { schema_version: _schemaVersion, type: _type, ...terminalCheckpoint } = queryResponse.result;
    terminal.hydrateRequestCheckpoint(terminalCheckpoint);
    terminal.accept(queryRequest, "host");
    terminal.accept(queryResponse, "browser");

    const gap = new WebModelSequenceValidator();
    gap.accept(helloRequest, "browser");
    gap.accept(helloResponse, "host");
    gap.hydrateRequestCheckpoint(checkpoint);
    expect(() => gap.accept({ ...eventFrames[1], params: { ...eventFrames[1].params, sequence: 2 } }, "browser"))
      .toThrowError(/SEQUENCE_GAP/);
    expect(() => gap.hydrateRequestCheckpoint({ ...checkpoint, future: true } as any))
      .toThrowError(/UNKNOWN_FIELD/);
  });

  it("accepts hello, generation, streaming, one terminal, cancellation, query, and heartbeat", () => {
    const sequence = new WebModelSequenceValidator();
    sequence.accept(helloWithReasoningRequest, "browser");
    sequence.accept(helloWithReasoningResponse, "host");
    sequence.accept(generateRequest, "host");
    sequence.accept(acceptedResponse, "browser");
    for (const event of eventFrames) sequence.accept(event, "browser");
    sequence.accept(cancelRequest, "host");
    sequence.accept(cancelResponse, "browser");
    sequence.accept(queryRequest, "host");
    sequence.accept(queryResponse, "browser");
    sequence.accept(heartbeat, "browser");
  });

  it("requires bridge.hello to be the browser's first frame and correlates its response", () => {
    expect(() => new WebModelSequenceValidator().accept(generateRequest, "host"))
      .toThrowError(ProtocolSequenceError);

    const sequence = new WebModelSequenceValidator();
    sequence.accept(helloRequest, "browser");
    expect(() => sequence.accept({ ...helloResponse, id: "wrong" }, "host")).toThrowError(/RPC_ID_MISMATCH/);
  });

  it("rejects key frames sent in the reverse direction", () => {
    expect(() => new WebModelSequenceValidator().accept(helloRequest, "host")).toThrowError(/DIRECTION_MISMATCH/);

    const handshake = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      return sequence;
    };
    const wrongHelloResponse = new WebModelSequenceValidator();
    wrongHelloResponse.accept(helloRequest, "browser");
    expect(() => wrongHelloResponse.accept(helloResponse, "browser")).toThrowError(/DIRECTION_MISMATCH/);
    expect(() => handshake().accept(generateRequest, "browser")).toThrowError(/DIRECTION_MISMATCH/);

    const wrongAccepted = handshake();
    wrongAccepted.accept(generateRequest, "host");
    expect(() => wrongAccepted.accept(acceptedResponse, "host")).toThrowError(/DIRECTION_MISMATCH/);

    const wrongEvent = handshake();
    wrongEvent.accept(generateRequest, "host");
    wrongEvent.accept(acceptedResponse, "browser");
    expect(() => wrongEvent.accept(eventFrames[0], "host")).toThrowError(/DIRECTION_MISMATCH/);
    expect(() => handshake().accept(cancelRequest, "browser")).toThrowError(/DIRECTION_MISMATCH/);
    expect(() => handshake().accept(queryRequest, "browser")).toThrowError(/DIRECTION_MISMATCH/);
    expect(() => handshake().accept(heartbeat, "host")).toThrowError(/DIRECTION_MISMATCH/);
  });

  it("rejects wrong request ids, non-monotonic sequence, duplicate terminals, and post-terminal events", () => {
    const setup = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      sequence.accept(generateRequest, "host");
      sequence.accept(acceptedResponse, "browser");
      return sequence;
    };

    const wrongRequest = clone(eventFrames[0]) as any;
    wrongRequest.params.request_id = "wrong";
    expect(() => setup().accept(wrongRequest, "browser")).toThrowError(/UNKNOWN_REQUEST/);

    const nonMonotonic = setup();
    nonMonotonic.accept(eventFrames[0], "browser");
    expect(() => nonMonotonic.accept(eventFrames[0], "browser")).toThrowError(/NON_MONOTONIC_SEQUENCE/);

    const terminal = setup();
    for (const event of eventFrames) terminal.accept(event, "browser");
    expect(() => terminal.accept({
      ...eventFrames[4],
      params: { ...eventFrames[4].params, sequence: 6 },
    }, "browser")).toThrowError(/EVENT_AFTER_TERMINAL/);
    expect(() => terminal.accept({
      ...eventFrames[1],
      params: { ...eventFrames[1].params, sequence: 7 },
    }, "browser")).toThrowError(/EVENT_AFTER_TERMINAL/);
  });

  it("rejects live and query gaps while allowing exact query confirmation", () => {
    const setup = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      sequence.accept(generateRequest, "host");
      sequence.accept(acceptedResponse, "browser");
      sequence.accept(eventFrames[0], "browser");
      return sequence;
    };

    expect(() => setup().accept(eventFrames[2], "browser")).toThrowError(/SEQUENCE_GAP/);

    const gap = setup();
    gap.accept(queryRequest, "host");
    expect(() => gap.accept({
      ...queryResponse,
      result: {
        schema_version: 1,
        type: "model.status",
        request_id: "request-1",
        request_digest: "a".repeat(64),
        status: "streaming",
        last_sequence: 3,
      },
    }, "browser")).toThrowError(/SEQUENCE_GAP/);

    const confirmed = setup();
    confirmed.accept(queryRequest, "host");
    expect(() => confirmed.accept({
      ...queryResponse,
      result: {
        schema_version: 1,
        type: "model.status",
        request_id: "request-1",
        request_digest: "a".repeat(64),
        status: "streaming",
        last_sequence: 1,
      },
    }, "browser")).not.toThrow();
    expect(() => confirmed.accept(eventFrames[1], "browser")).not.toThrow();

    const terminalCheckpoint = setup();
    terminalCheckpoint.accept(queryRequest, "host");
    expect(() => terminalCheckpoint.accept({
      ...queryResponse,
      result: {
        schema_version: 1,
        type: "model.status",
        request_id: "request-1",
        request_digest: "a".repeat(64),
        status: "completed",
        last_sequence: 2,
        terminal: { type: "completed", finish_reason: "stop" },
      },
    }, "browser")).not.toThrow();

    const reconnect = new WebModelSequenceValidator();
    reconnect.accept(helloRequest, "browser");
    reconnect.accept(helloResponse, "host");
    reconnect.accept(queryRequest, "host");
    expect(() => reconnect.accept(queryResponse, "browser")).toThrowError(/SEQUENCE_GAP/);
  });

  it("enforces optional streaming capabilities", () => {
    const noReasoning = clone(helloRequest) as any;
    delete noReasoning.params.capabilities.reasoning;
    const sequence = new WebModelSequenceValidator();
    const negotiated = clone(helloResponse) as any;
    delete negotiated.result.capabilities.reasoning;
    sequence.accept(noReasoning, "browser");
    sequence.accept(negotiated, "host");
    sequence.accept(generateRequest, "host");
    sequence.accept(acceptedResponse, "browser");
    expect(() => sequence.accept(eventFrames[0], "browser")).toThrowError(/CAPABILITY_NOT_ADVERTISED/);

    const optedIn = new WebModelSequenceValidator();
    optedIn.accept(helloWithReasoningRequest, "browser");
    optedIn.accept(helloWithReasoningResponse, "host");
    optedIn.accept(generateRequest, "host");
    optedIn.accept(acceptedResponse, "browser");
    expect(isEphemeralModelEvent(eventFrames[0].params.event)).toBe(true);
    expect(() => optedIn.accept(eventFrames[0], "browser")).not.toThrow();
  });

  it("rejects negotiated capabilities that were not offered and uses only the negotiated subset", () => {
    const offer = clone(helloRequest) as any;
    delete offer.params.capabilities.reasoning;
    const sequence = new WebModelSequenceValidator();
    sequence.accept(offer, "browser");
    expect(() => sequence.accept(helloWithReasoningResponse, "host")).toThrowError(/CAPABILITY_NOT_OFFERED/);

    const subset = clone(helloResponse) as any;
    delete subset.result.capabilities.reasoning;
    const subsetSequence = new WebModelSequenceValidator();
    subsetSequence.accept(helloWithReasoningRequest, "browser");
    subsetSequence.accept(subset, "host");
    subsetSequence.accept(generateRequest, "host");
    subsetSequence.accept(acceptedResponse, "browser");
    expect(() => subsetSequence.accept(eventFrames[0], "browser")).toThrowError(/CAPABILITY_NOT_ADVERTISED/);
  });

  it("binds accepted, cancel, query, and model errors to request id plus digest", () => {
    const handshake = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      return sequence;
    };

    const accepted = handshake();
    accepted.accept(generateRequest, "host");
    const wrongAccepted = clone(acceptedResponse) as any;
    wrongAccepted.result.request_digest = "b".repeat(64);
    expect(() => accepted.accept(wrongAccepted, "browser")).toThrowError(/REQUEST_DIGEST_MISMATCH/);

    const cancel = handshake();
    cancel.accept(generateRequest, "host");
    cancel.accept(acceptedResponse, "browser");
    const wrongCancel = clone(cancelRequest) as any;
    wrongCancel.params.request_digest = "b".repeat(64);
    expect(() => cancel.accept(wrongCancel, "host")).toThrowError(/REQUEST_DIGEST_MISMATCH/);

    const query = handshake();
    query.accept(queryRequest, "host");
    const wrongQuery = clone(queryResponse) as any;
    wrongQuery.result.request_digest = "b".repeat(64);
    expect(() => query.accept(wrongQuery, "browser")).toThrowError(/REQUEST_DIGEST_MISMATCH/);

    const failed = handshake();
    failed.accept(generateRequest, "host");
    const modelError = clone(standardError) as any;
    modelError.id = "rpc-generate";
    modelError.error.data.request_digest = "b".repeat(64);
    expect(() => failed.accept(modelError, "browser")).toThrowError(/REQUEST_DIGEST_MISMATCH/);
  });

  it("releases only a definitely not-started generate after an error", () => {
    const handshake = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      sequence.accept(generateRequest, "host");
      return sequence;
    };
    const modelError = (outcome: "not_started" | "started" | "unknown") => {
      const error = clone(standardError) as any;
      error.id = "rpc-generate";
      error.error.data.external_outcome = outcome;
      return error;
    };

    const notStarted = handshake();
    notStarted.accept(modelError("not_started"), "browser");
    expect(() => notStarted.accept(generateRequest, "host")).not.toThrow();

    for (const outcome of ["started", "unknown"] as const) {
      const uncertain = handshake();
      uncertain.accept(modelError(outcome), "browser");
      const retry = clone(generateRequest) as any;
      retry.id = `rpc-generate-${outcome}`;
      expect(() => uncertain.accept(retry, "host"), outcome).toThrowError(/DUPLICATE_REQUEST/);
      expect(() => uncertain.accept(queryRequest, "host"), outcome).not.toThrow();
    }
  });

  it("requires a terminal query to repeat exact status, sequence, and payload", () => {
    const setup = () => {
      const sequence = new WebModelSequenceValidator();
      sequence.accept(helloWithReasoningRequest, "browser");
      sequence.accept(helloWithReasoningResponse, "host");
      sequence.accept(generateRequest, "host");
      sequence.accept(acceptedResponse, "browser");
      for (const event of eventFrames) sequence.accept(event, "browser");
      sequence.accept(queryRequest, "host");
      return sequence;
    };

    const changedStatus = clone(queryResponse) as any;
    changedStatus.result.status = "aborted";
    changedStatus.result.terminal = { type: "aborted", reason: "changed" };
    expect(() => setup().accept(changedStatus, "browser")).toThrowError(/TERMINAL_MISMATCH/);

    const changedSequence = clone(queryResponse) as any;
    changedSequence.result.last_sequence = 6;
    expect(() => setup().accept(changedSequence, "browser")).toThrowError(/TERMINAL_MISMATCH/);

    const changedPayload = clone(queryResponse) as any;
    changedPayload.result.terminal.finish_reason = "stop";
    expect(() => setup().accept(changedPayload, "browser")).toThrowError(/TERMINAL_MISMATCH/);

    expect(() => setup().accept(queryResponse, "browser")).not.toThrow();
  });

  it("correlates accepted, cancel, query, and error responses by JSON-RPC id", () => {
    const sequence = new WebModelSequenceValidator();
    sequence.accept(helloRequest, "browser");
    sequence.accept(helloResponse, "host");
    sequence.accept(generateRequest, "host");
    expect(() => sequence.accept({ ...acceptedResponse, id: "wrong" }, "browser")).toThrowError(/RPC_ID_MISMATCH/);

    const errorSequence = new WebModelSequenceValidator();
    errorSequence.accept(helloRequest, "browser");
    errorSequence.accept(helloResponse, "host");
    errorSequence.accept(queryRequest, "host");
    expect(() => errorSequence.accept({ ...standardError, id: "wrong" }, "browser")).toThrowError(/RPC_ID_MISMATCH/);
    errorSequence.accept(standardError, "browser");
  });

  it("does not reserve a request id when query reports unknown", () => {
    const sequence = new WebModelSequenceValidator();
    sequence.accept(helloRequest, "browser");
    sequence.accept(helloResponse, "host");
    sequence.accept(queryRequest, "host");
    sequence.accept({
      ...queryResponse,
      result: {
        schema_version: 1,
        type: "model.status",
        request_id: "request-1",
        request_digest: "a".repeat(64),
        status: "unknown",
        last_sequence: 0,
      },
    }, "browser");
    expect(() => sequence.accept(generateRequest, "host")).not.toThrow();
  });
});

describe("package boundary", () => {
  it("has no runtime dependencies or environment-specific imports", () => {
    const root = resolve(process.cwd(), "packages/web-model-protocol");
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
    for (const file of ["constants.ts", "types.ts", "validation.ts", "codec.ts", "sequence-validator.ts", "index.ts"]) {
      const source = readFileSync(resolve(root, "src", file), "utf8");
      expect(source).not.toMatch(/from ["'](?:node:|wxt|@modelcontextprotocol|@mariozechner|deepseek-harness)/);
      expect(source).not.toMatch(/\b(?:Window|Document|WebSocket|HTMLElement|Buffer|process)\b/);
    }
  });
});
