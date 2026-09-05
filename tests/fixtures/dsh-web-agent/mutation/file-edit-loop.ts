import assert from "node:assert/strict";

import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";

import type { FakeGenerationResponder } from "../../harness-bridge/fake-peer/index.ts";
import type { FakeHeadlessResult } from "../run-fake-headless.ts";

export const EDIT_NONCE_FILE = "file-edit-proof.txt";
export const VIEW_CALL_ID = "file-edit-view-call";
export const EDIT_CALL_ID = "file-edit-replace-call";
export const OLD_STATE = "state=pending";

// No filesystem import, locator, or nonce/answer argument. The target path must
// arrive through the actual model request; contents arrive through tool results.
export function createFileEditLoopScripts(): readonly [FakeGenerationResponder, FakeGenerationResponder, FakeGenerationResponder] {
  let sessionId: string | undefined;
  return [
    (request) => {
      assert.equal(request.purpose, "agent");
      assert.deepEqual(request.tools.map((tool) => tool.name), ["str_replace_editor"]);
      assert.deepEqual(request.tools[0]?.input_schema.required, ["command", "path"]);
      assert.equal(toolResults(request).length, 0);
      assert.equal(toolCalls(request).length, 0);
      sessionId = request.session_id;
      const taskText = request.input.messages.flatMap((message) => message.content)
        .filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const locators = [...taskText.matchAll(/FILE_EDIT_TARGET_JSON=("(?:[^"\\]|\\.)*")/g)];
      assert.equal(locators.length, 1, "The absolute target path must arrive through the actual task request");
      const path: unknown = JSON.parse(locators[0]![1]!);
      assert.equal(typeof path, "string");
      return { events: [
        { type: "tool_call", tool_call_id: VIEW_CALL_ID, name: "str_replace_editor", arguments: {
          command: "view", path: path as string,
        } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    },
    (request) => {
      assert.ok(sessionId);
      assert.equal(request.session_id, sessionId);
      const calls = toolCalls(request);
      const results = toolResults(request);
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(calls[0]?.tool_call_id, VIEW_CALL_ID);
      assert.equal(results[0]?.tool_call_id, VIEW_CALL_ID);
      assert.equal(results[0]?.is_error, false);
      const viewed = results[0]!.content.map((block) => block.text).join("");
      const matches = [...viewed.matchAll(/file-edit-nonce=([a-f0-9]{32})/g)];
      assert.equal(matches.length, 1, "Actual view result must be the only source of the unknown nonce");
      assert.ok(viewed.includes(OLD_STATE));
      const nonce = matches[0]![1]!;
      const path = record(calls[0]?.arguments).path;
      assert.ok(typeof path === "string");
      return { events: [
        { type: "tool_call", tool_call_id: EDIT_CALL_ID, name: "str_replace_editor", arguments: {
          command: "str_replace", path, old_str: OLD_STATE, new_str: `state=verified-${nonce}`,
        } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    },
    (request) => {
      assert.ok(sessionId);
      assert.equal(request.session_id, sessionId);
      const calls = toolCalls(request);
      const results = toolResults(request);
      assert.equal(calls.length, 2);
      assert.equal(results.length, 2);
      assert.deepEqual(calls.map((call) => call.tool_call_id), [VIEW_CALL_ID, EDIT_CALL_ID]);
      assert.deepEqual(results.map((result) => result.tool_call_id), [VIEW_CALL_ID, EDIT_CALL_ID]);
      assert.equal(results[1]?.is_error, false);
      assert.match(results[1]!.content.map((block) => block.text).join(""), /has been edited successfully/);
      const edited = String(record(calls[1]?.arguments).new_str);
      assert.match(edited, /^state=verified-[a-f0-9]{32}$/);
      const answer = `Edit complete: ${edited}`;
      return { events: [
        { type: "text_delta", text: answer.slice(0, 15) },
        { type: "text_delta", text: answer.slice(15) },
        { type: "completed", finish_reason: "stop" },
      ] };
    },
  ];
}

export function assertFileEditLoopEvidence(result: FakeHeadlessResult, expectedNonce: string, persistedFile: string): void {
  const finalText = `Edit complete: state=verified-${expectedNonce}`;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${finalText}\n`);
  assert.equal(persistedFile, `file-edit-nonce=${expectedNonce}\nstate=verified-${expectedNonce}\n`);
  assert.equal(result.observedRequests.length, 3, "One view, one edit, then one final model step; no mutation replay");
  const [first, second, third] = result.observedRequests;
  assert.ok(first && second && third);
  assert.equal(JSON.stringify(first).includes(expectedNonce), false);
  assert.equal(new Set(result.observedRequests.map((request) => request.request_id)).size, 3);
  assert.equal(new Set(result.observedRequests.map((request) => request.session_id)).size, 1);
  for (const request of result.observedRequests) {
    assert.deepEqual(request.model, { provider: "deepseek-web", model_id: "current-web-session" });
    assert.equal(request.purpose, "agent");
    assert.deepEqual(request.tools.map((tool) => tool.name), ["str_replace_editor"]);
  }
  assert.equal(toolResults(second).length, 1);
  assert.ok(JSON.stringify(toolResults(second)[0]).includes(expectedNonce));
  assert.equal(toolResults(third).length, 2);
  assert.equal(toolResults(third)[1]?.tool_call_id, EDIT_CALL_ID);
  assert.equal(toolResults(third)[1]?.is_error, false);

  assert.equal(result.sessionLogCount, 1);
  assert.equal(result.persistedRecords[0]?.id, first.session_id);
  assert.equal(result.persistedRecords[0]?.cwd, result.workspaceCwd);
  const events = result.persistedRecords.slice(1);
  const steps = events.filter((event) => event.type === "step/start");
  const calls = events.filter((event) => event.type === "tool/call");
  const results = events.filter((event) => event.type === "tool/result");
  const assistants = events.filter((event) => event.type === "assistant/message");
  assert.deepEqual(steps.map((event) => event.data), [{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 1, step: 3 }]);
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(assistants.length, 3);
  assert.deepEqual(calls.map((event) => record(event.data).callId), [VIEW_CALL_ID, EDIT_CALL_ID]);
  const callArgs = calls.map((event) => JSON.parse(String(record(event.data).arguments)) as Record<string, unknown>);
  assert.equal(callArgs[0]?.command, "view");
  assert.equal(callArgs[1]?.command, "str_replace");
  assert.equal(callArgs[1]?.old_str, OLD_STATE);
  assert.equal(callArgs[1]?.new_str, `state=verified-${expectedNonce}`);
  for (let index = 0; index < results.length; index += 1) {
    const blocks = record(record(results[index]?.data).message).content;
    assert.ok(Array.isArray(blocks));
    const block = record(blocks[0]);
    assert.equal(block.type, "tool-result");
    assert.equal(block.isError ?? false, false);
    assert.equal(block.toolCallId, index === 0 ? VIEW_CALL_ID : EDIT_CALL_ID);
    assert.deepEqual(block.content, toolResults(third)[index]?.content);
  }
  const expectedOrder = [steps[0], assistants[0], calls[0], results[0], steps[1], assistants[1], calls[1], results[1], steps[2], assistants[2]];
  const positions = expectedOrder.map((event) => events.indexOf(event!));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)));
  const finalMessage = record(record(assistants[2]?.data).message);
  assert.deepEqual(finalMessage.content, [{ type: "text", text: finalText }]);
  assert.deepEqual(finalMessage.source, { kind: "model", provider: "deepseek-web", model: "current-web-session" });
  assert.equal(events.at(-1)?.type, "turn/end");
  assert.deepEqual(events.at(-1)?.data, { turn: 1, reason: { kind: "completed" } });
  assert.equal(result.childClosed, true);
  assert.equal(result.portReleased, true);
  assert.equal(result.tempRootRemoved, true);
}

function toolResults(request: ModelGenerateRequest["params"]) {
  return request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result");
}

function toolCalls(request: ModelGenerateRequest["params"]) {
  return request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_call");
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
