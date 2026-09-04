import assert from "node:assert/strict";

import { runFakeDshHeadless } from "../tests/fixtures/dsh-web-agent/run-fake-headless.ts";

try {
  const result = await runFakeDshHeadless({
    task: "Complete the deterministic local Harness smoke turn.",
    answerFragments: ["Deterministic Harness ", "smoke complete."],
    usage: { inputTokens: 17, outputTokens: 5 },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "Deterministic Harness smoke complete.\n");
  assert.equal(result.stderr, "");
  assert.equal(result.observedRequests.length, 1);
  assert.equal(result.portReleased, true);
  assert.equal(result.tempRootRemoved, true);
  const assistant = result.persistedRecords.find((record) => record.type === "assistant/message");
  assert.deepEqual(assistant?.data?.message?.content, [{
    type: "text",
    text: "Deterministic Harness smoke complete.",
  }]);
  assert.deepEqual(result.persistedRecords.at(-1), {
    type: "turn/end",
    seq: result.persistedRecords.at(-1)?.seq,
    time: result.persistedRecords.at(-1)?.time,
    data: { turn: 1, reason: { kind: "completed" } },
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    route: "dsh->agent-loop->deepseek-web->loopback->fake-browser",
    modelRequests: 1,
    terminal: "completed",
    durable: true,
  })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "DSH_WEB_AGENT_FAKE_SMOKE_FAILED" })}\n`);
  process.exitCode = 1;
}
