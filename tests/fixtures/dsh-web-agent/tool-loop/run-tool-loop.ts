import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { runFakeDshHeadless, type FakeHeadlessResult } from "../run-fake-headless.ts";
import { createReadLoopScripts, MISSING_FILE, NONCE_FILE, TOOL_CALL_ID } from "./request-script.ts";

export interface ToolLoopResult {
  readonly process: FakeHeadlessResult;
  readonly expectedNonce: string;
  readonly finalText: string;
  readonly mode: "read" | "read-error";
}

/** Actual DSH registry and the same read-only profile used by product acceptance. */
export async function runDshToolLoop(mode: "read" | "read-error"): Promise<ToolLoopResult> {
  const expectedNonce = `fixture-nonce=${randomBytes(16).toString("hex")}`;
  const result = await runFakeDshHeadless({
    task: mode === "read"
      ? `Read ${NONCE_FILE} with the read tool and report the fixture nonce from its contents.`
      : `Read ${MISSING_FILE} with the read tool and explain the result.`,
    patches: [resolve(import.meta.dirname, "../../../../packages/dsh-web-agent-bundle/cordis.readonly.patch.yml")],
    generationScripts: createReadLoopScripts(mode),
    async prepareWorkspace(workspace) {
      await writeFile(join(workspace, NONCE_FILE), `${expectedNonce}\n`, { encoding: "utf8", flag: "wx" });
    },
  });
  const finalText = mode === "read"
    ? `Read complete: ${expectedNonce}`
    : "Read error handled: the requested fixture does not exist.";
  const evidence = { process: result, expectedNonce, finalText, mode };
  assertToolLoopEvidence(evidence);
  return evidence;
}

export function assertToolLoopEvidence({ process: result, expectedNonce, finalText, mode }: ToolLoopResult): void {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${finalText}\n`);
  assert.equal(result.observedRequests.length, 2);
  const [first, second] = result.observedRequests;
  assert.ok(first && second);
  assert.equal(first.session_id, second.session_id);
  assert.notEqual(first.request_id, second.request_id);
  assert.equal(JSON.stringify(first).includes(expectedNonce), false);
  assert.equal(first.input.messages.flatMap((message) => message.content)
    .some((block) => block.type === "tool_call" || block.type === "tool_result"), false);
  for (const request of result.observedRequests) {
    assert.deepEqual(request.model, { provider: "deepseek-web", model_id: "current-web-session" });
    assert.equal(request.purpose, "agent");
    assert.deepEqual(request.tools.map((tool) => tool.name), ["read"]);
  }
  const results = second.input.messages.flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.tool_call_id, TOOL_CALL_ID);
  assert.equal(results[0]?.is_error, mode === "read-error");
  const toolText = results[0]?.content.map((block) => block.text).join("") ?? "";
  assert.equal(toolText.includes(expectedNonce), mode === "read");

  assert.equal(result.sessionLogCount, 1);
  assert.equal(result.persistedRecords[0]?.type, "session");
  assert.equal(result.persistedRecords[0]?.id, first.session_id);
  assert.equal(result.persistedRecords[0]?.cwd, result.workspaceCwd);
  const events = result.persistedRecords.slice(1);
  assert.ok(events.length > 0);
  for (let index = 0; index < events.length; index += 1) assert.equal(events[index]?.seq, index);
  const calls = events.filter((event) => event.type === "tool/call");
  const toolResults = events.filter((event) => event.type === "tool/result");
  const contexts = events.filter((event) => event.type === "request/context");
  const assistants = events.filter((event) => event.type === "assistant/message");
  assert.equal(calls.length, 1);
  assert.equal(toolResults.length, 1);
  // DSH persists request/context only when the model epoch changes. Two
  // requests in one epoch share it; actual requests and step IDs prove loops.
  assert.equal(contexts.length, 1);
  assert.equal(assistants.length, 2);
  const steps = events.filter((event) => event.type === "step/start");
  assert.deepEqual(steps.map((event) => event.data), [{ turn: 1, step: 1 }, { turn: 1, step: 2 }]);
  const call = record(calls[0]?.data);
  assert.equal(call.name, "read");
  assert.equal(call.callId, TOOL_CALL_ID);
  assert.deepEqual(JSON.parse(String(call.arguments)), { file_path: mode === "read" ? NONCE_FILE : MISSING_FILE });
  const resultData = record(toolResults[0]?.data);
  const toolMessage = record(resultData.message);
  assert.ok(Array.isArray(toolMessage.content));
  assert.equal(toolMessage.content.length, 1);
  const block = record(toolMessage.content[0]);
  assert.equal(block.type, "tool-result");
  assert.equal(block.toolCallId, TOOL_CALL_ID);
  assert.equal(block.isError ?? false, mode === "read-error");
  assert.deepEqual(block.content, results[0]?.content);
  assert.equal(resultData.turn, call.turn);
  assert.equal(resultData.step, call.step);
  const expectedOrder = [contexts[0], assistants[0], calls[0], toolResults[0], steps[1], assistants[1]];
  const positions = expectedOrder.map((event) => events.indexOf(event as Record<string, unknown>));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1))));
  const finalMessage = record(record(assistants[1]?.data).message);
  assert.equal(record(assistants[1]?.data).step, 2);
  assert.deepEqual(finalMessage.content, [{ type: "text", text: finalText }]);
  assert.deepEqual(finalMessage.source, { kind: "model", provider: "deepseek-web", model: "current-web-session" });
  assert.equal(events.at(-1)?.type, "turn/end");
  assert.deepEqual(events.at(-1)?.data, { turn: 1, reason: { kind: "completed" } });
  assert.equal(result.childClosed, true);
  assert.equal(result.portReleased, true);
  assert.equal(result.tempRootRemoved, true);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
