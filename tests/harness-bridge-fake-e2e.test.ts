import { createServer } from "node:net";

import {
  DeepSeekWebModelHost,
  createPairingToken,
  type BrokerGenerateRequest,
} from "../packages/dsh-web-model-transport/src/index.ts";
import {
  FAKE_EXTENSION_ORIGIN,
  FakeBrowserPeer,
} from "./fixtures/harness-bridge/fake-peer/index.ts";
import { afterEach, describe, expect, it } from "vitest";

const hosts = new Set<DeepSeekWebModelHost>();
const peers = new Set<FakeBrowserPeer>();

afterEach(async () => {
  await Promise.all([...peers].map((peer) => peer.close()));
  peers.clear();
  await Promise.all([...hosts].map((host) => host.stop()));
  hosts.clear();
});

describe("Harness bridge fake browser vertical slice", () => {
  it("streams text, a tool call, usage, one terminal, and an exact terminal query", async () => {
    const { host, peer } = await startPair();
    const events = [
      { type: "text_delta", text: "Inspecting the workspace." },
      { type: "tool_call", tool_call_id: "call-1", name: "list_files", arguments: { path: "." } },
      { type: "usage", input_tokens: 21, output_tokens: 8 },
      { type: "completed", finish_reason: "tool_calls" },
    ] as const;
    peer.enqueueGeneration({ events });

    await expect(collect(host.generate(generateInput()))).resolves.toEqual(events);
    expect(peer.observedGenerateRequests).toHaveLength(1);
    expect(peer.observedGenerateRequests[0]).toMatchObject({
      request_id: "fake-request-1",
      model: { provider: "deepseek-web", model_id: "current-web-session" },
    });
    await expect(host.query(identity())).resolves.toMatchObject({
      status: "completed",
      last_sequence: 4,
      terminal: events[3],
    });
    expect(peer.queryRequestCount).toBe(1);
    peer.throwIfFailed();
  });

  it("coalesces cancellation and completes the stream with one aborted terminal", async () => {
    const { host, peer } = await startPair();
    peer.enqueueGeneration({
      delivery: "after_cancel",
      events: [
        { type: "text_delta", text: "Stopping." },
        { type: "aborted", reason: "user_requested" },
      ],
    });
    const generation = collect(host.generate(generateInput()));
    await peer.waitForGenerateCount(1);
    const first = host.cancel({ ...identity(), reason: "user_requested" });
    const second = host.cancel(identity());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe("cancel_requested");
    expect(peer.cancelRequestCount).toBe(1);
    await expect(generation).resolves.toEqual([
      { type: "text_delta", text: "Stopping." },
      { type: "aborted", reason: "user_requested" },
    ]);
    peer.throwIfFailed();
  });

  it("turns an authenticated disconnect into ambiguous and refuses replay", async () => {
    const { host, peer } = await startPair();
    peer.enqueueGeneration({ disconnectAfterAccepted: true });
    await expect(collect(host.generate(generateInput()))).resolves.toEqual([
      { type: "ambiguous", reason: "browser_disconnected" },
    ]);
    await expect(collect(host.generate(generateInput()))).rejects.toMatchObject({
      code: "REQUEST_ALREADY_EXISTS",
      externalOutcome: "unknown",
    });
    expect(peer.observedGenerateRequests).toHaveLength(1);
    peer.throwIfFailed();
  });

  it("releases the peer socket, timers, and selected port on stop", async () => {
    const { host, peer, port } = await startPair();
    await host.stop();
    hosts.delete(host);
    await peer.close();
    peers.delete(peer);

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port }, resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  });
});

async function startPair(): Promise<{ host: DeepSeekWebModelHost; peer: FakeBrowserPeer; port: number }> {
  const pairingToken = createPairingToken();
  const host = new DeepSeekWebModelHost({ pairingToken, allowedOrigins: [FAKE_EXTENSION_ORIGIN] });
  hosts.add(host);
  const address = await host.start();
  const peer = await FakeBrowserPeer.connect({ address, pairingToken });
  peers.add(peer);
  return { host, peer, port: address.port };
}

function identity(): { request_id: string; request_digest: string } {
  return { request_id: "fake-request-1", request_digest: "c".repeat(64) };
}

function generateInput(): BrokerGenerateRequest {
  return {
    ...identity(),
    session_id: "fake-session-1",
    purpose: "agent",
    model: { provider: "deepseek-web", model_id: "current-web-session" },
    input: {
      messages: [
        { role: "system", content: [{ type: "text", text: "Use the supplied tools." }] },
        { role: "user", content: [{ type: "text", text: "Inspect this workspace." }] },
      ],
    },
    tools: [{
      name: "list_files",
      description: "List files below the workspace.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
    options: { thinking_enabled: false, search_enabled: false, model_type: "default" },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
