import assert from "node:assert/strict";

import {
  DeepSeekWebModelHost,
  createPairingToken,
} from "@deepseek-pp/dsh-web-model-transport";
import {
  FAKE_EXTENSION_ORIGIN,
  FakeBrowserPeer,
} from "../tests/fixtures/harness-bridge/fake-peer/index.ts";

let host;
let peer;

try {
  const pairingToken = createPairingToken();
  host = new DeepSeekWebModelHost({ pairingToken, allowedOrigins: [FAKE_EXTENSION_ORIGIN] });
  const address = await host.start();
  peer = await FakeBrowserPeer.connect({ address, pairingToken });
  const expected = [
    { type: "text_delta", text: "Fake browser model is reachable." },
    { type: "usage", input_tokens: 12, output_tokens: 6 },
    { type: "completed", finish_reason: "stop" },
  ];
  peer.enqueueGeneration({ events: expected });
  const events = [];
  for await (const event of host.generate(createRequest())) events.push(event);
  assert.deepEqual(events, expected);
  assert.equal(peer.observedGenerateRequests.length, 1);
  peer.throwIfFailed();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    route: "host->fake-browser->host",
    event_types: events.map((event) => event.type),
    terminal: events.at(-1)?.type,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
  })}\n`);
  process.exitCode = 1;
} finally {
  if (peer) await peer.close().catch(() => undefined);
  if (host) await host.stop().catch(() => undefined);
}

function createRequest() {
  return {
    request_id: "smoke-request-1",
    session_id: "smoke-session-1",
    request_digest: "d".repeat(64),
    purpose: "agent",
    model: { provider: "deepseek-web", model_id: "current-web-session" },
    input: {
      messages: [{ role: "user", content: [{ type: "text", text: "Return a short smoke response." }] }],
    },
    tools: [],
    options: { thinking_enabled: false, search_enabled: false, model_type: "default" },
  };
}
