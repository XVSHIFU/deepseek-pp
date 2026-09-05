import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { DeepSeekWebAdapter } from "@deepseek-pp/dsh-llm-deepseek-web";
import { DeepSeekWebModelHost, createPairingToken, type BrokerGenerateRequest } from "@deepseek-pp/dsh-web-model-transport";
import { afterEach, describe, expect, it } from "vitest";

import { FAKE_EXTENSION_ORIGIN } from "./fixtures/harness-bridge/fake-peer/index.ts";
import { createRecoveryBrowser } from "./fixtures/harness-bridge/recovery/browser.ts";
import { ControlledModelTurn } from "./fixtures/harness-bridge/recovery/model.ts";
import { waitUntil } from "./fixtures/harness-bridge/recovery/socket.ts";
import { canBindLoopback } from "./fixtures/dsh-web-agent/run-fake-headless.ts";

const fixtures: Awaited<ReturnType<typeof startFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

describe("real Harness adapter/Host/browser cancellation", () => {
  it("never creates a journal request or socket generation for an already-aborted caller", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    controller.abort("user_requested");
    expect(await collect(fixture.adapter.stream(options(controller.signal)))).toEqual([{
      type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "DeepSeek Web request aborted by caller." } },
    }]);
    expect(fixture.browser.sockets.generateCount).toBe(0);
    expect((await fixture.journal()).records).toEqual([]);
  });

  it.each(["accepted", "streaming"] as const)("keeps %s cancellation reentrant and a late completion cannot succeed", async (phase) => {
    const fixture = await setup();
    const controller = new AbortController();
    const chunks: StreamChunk[] = [];
    const generation = collect(fixture.adapter.stream(options(controller.signal)), chunks);
    await waitUntil(() => fixture.model.turns.length === 1, "MODEL_NOT_CALLED");
    const turn = fixture.model.turns[0]!;
    turn.accept();
    await waitUntil(() => fixture.browser.sockets.outgoing.some((frame) => "result" in frame && frame.result.type === "model.accepted"), "ACK_NOT_SENT");
    if (phase === "streaming") {
      turn.text("partial output, not completion");
      await waitUntil(() => chunks.some((chunk) => chunk.type === "text-delta"), "FIRST_CHUNK_NOT_CONSUMED");
    }
    fixture.model.onCancel = () => { controller.abort("reentrant_cancel"); };
    controller.abort("user_requested");
    controller.abort("duplicate_cancel");
    await waitUntil(() => fixture.model.cancelCount === 1, "CANCEL_DID_NOT_REACH_BROWSER");
    turn.finish({ type: "completed", finish_reason: "stop" });
    const result = await generation;
    expect(result.filter((chunk) => chunk.type === "finish")).toHaveLength(1);
    expect(result.at(-1)).toMatchObject({
      type: "finish", reason: { kind: "error", failure: { code: "WEB_MODEL_CANCEL_UNCONFIRMED" } },
    });
    expect(fixture.model.cancelCount).toBe(1);
    expect(fixture.browser.sockets.generateCount).toBe(1);
    expect((await fixture.journal()).records).toEqual([expect.objectContaining({
      requestId: turn.request.request_id, requestDigest: turn.request.request_digest,
      sessionId: turn.request.session_id, cancelRequested: true,
    })]);
    const cache = await fixture.cache();
    expect(cache.records).toEqual([expect.objectContaining({ request_id: turn.request.request_id, cancelRequested: true })]);
  });

  it("bounds an unacknowledged cancel and leaves its persisted request un-replayable", async () => {
    const fixture = await setup(500);
    fixture.browser.sockets.intercept = (frame) => "result" in frame && frame.result.type === "model.cancelled" ? "suppress" : undefined;
    const request = brokerRequest();
    const generation = collect(fixture.host.generate(request));
    await waitUntil(() => fixture.model.turns.length === 1, "MODEL_NOT_CALLED");
    fixture.model.turns[0]!.accept();
    await waitUntil(() => fixture.journal().records[0]?.state === "accepted", "HOST_ACK_NOT_COMMITTED");
    await expect(fixture.host.cancel({ request_id: request.request_id, request_digest: request.request_digest }))
      .rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect((await fixture.journal()).records[0]).toMatchObject({ cancelRequested: true });
    fixture.model.turns[0]!.finish({ type: "ambiguous", reason: "deepseek_dispatch_abort_outcome_unknown" });
    const events = await generation;
    expect(events.filter((event) => ["completed", "failed", "aborted", "ambiguous"].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("ambiguous");
    await expect(collect(fixture.host.generate(request))).rejects.toMatchObject({ code: "REQUEST_ALREADY_EXISTS" });
    expect(fixture.browser.sockets.generateCount).toBe(1);
  });

  it("keeps cancellation after a completed stream idempotent without a second browser cancel", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    const generation = collect(fixture.adapter.stream(options(controller.signal)));
    await waitUntil(() => fixture.model.turns.length === 1, "MODEL_NOT_CALLED");
    const turn = fixture.model.turns[0]!;
    turn.accept();
    turn.text("complete output");
    turn.finish({ type: "completed", finish_reason: "stop" });
    const chunks = await generation;
    controller.abort("too_late");
    const identity = { request_id: turn.request.request_id, request_digest: turn.request.request_digest };
    const [first, second] = await Promise.all([fixture.host.cancel(identity), fixture.host.cancel(identity)]);
    expect(first).toEqual(second);
    expect(first.status).toBe("already_terminal");
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
    expect(fixture.model.cancelCount).toBe(0);
  });
});

async function setup(rpcTimeoutMs = 1000) {
  const fixture = await startFixture(rpcTimeoutMs);
  fixtures.push(fixture);
  return fixture;
}

async function startFixture(rpcTimeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), "dsh-cancel-e2e-"));
  const journalDirectory = join(root, "journal");
  const cacheFile = join(root, "browser-cache.json");
  const pairingToken = createPairingToken();
  const host = new DeepSeekWebModelHost({ pairingToken, allowedOrigins: [FAKE_EXTENSION_ORIGIN], journalPath: journalDirectory, rpcTimeoutMs });
  const model = new ControlledModelTurn();
  let browser: Awaited<ReturnType<typeof createRecoveryBrowser>> | undefined;
  try {
    const address = await host.start();
    browser = await createRecoveryBrowser({ port: address.port, pairingToken, cacheFile, turnPort: model });
    await waitUntil(() => host.hasAuthenticatedPeer, "HOST_NOT_READY");
    const ownedBrowser = browser;
    return {
      host, browser: ownedBrowser, model,
      adapter: new DeepSeekWebAdapter({ broker: host, abortSettleTimeoutMs: 500 }),
      journal: () => JSON.parse(readFileSync(join(journalDirectory, "journal.json"), "utf8")) as { records: Array<Record<string, unknown>> },
      cache: async () => JSON.parse(await readFile(cacheFile, "utf8")) as { records: Array<Record<string, unknown>> },
      async dispose() {
        model.dispose();
        await ownedBrowser.dispose();
        await host.stop();
        expect(await canBindLoopback(address.port)).toBe(true);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    model.dispose();
    await browser?.dispose();
    await host.stop();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function options(signal?: AbortSignal): GenerateOptions {
  return { provider: "deepseek-web", model: "current-web-session", sessionId: SessionId("cancel-session"),
    messages: [createUserMessage({ content: [{ type: "text", text: "Cancel fixture model turn." }], source: { kind: "user" } })],
    ...(signal === undefined ? {} : { signal }) };
}

function brokerRequest(): BrokerGenerateRequest {
  return { request_id: "cancel-timeout-request", request_digest: "c".repeat(64), session_id: "cancel-timeout-session", purpose: "agent",
    model: { provider: "deepseek-web", model_id: "current-web-session" }, tools: [],
    input: { messages: [{ role: "user", content: [{ type: "text", text: "Cancel timeout fixture" }] }] },
    options: { thinking_enabled: false, search_enabled: false, model_type: "default", timeout_ms: 3000 } };
}

async function collect<T>(source: AsyncIterable<T>, values: T[] = []): Promise<T[]> {
  for await (const value of source) values.push(value);
  return values;
}
