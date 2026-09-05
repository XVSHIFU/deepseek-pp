import assert from "node:assert/strict";

import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";

import type { FakeGenerationResponder } from "../../harness-bridge/fake-peer/index.ts";

export const TOOL_CALL_ID = "fixture-read-call-1";
export const NONCE_FILE = "nonce.txt";
export const MISSING_FILE = "missing.txt";

// Deliberately no filesystem import, fixture contents, nonce argument, or
// expected-answer argument: the second broker request is the only data source.
export function createReadLoopScripts(
  mode: "read" | "read-error",
): readonly [FakeGenerationResponder, FakeGenerationResponder] {
  let firstRequest: ModelGenerateRequest["params"] | undefined;
  return [
    (request) => {
      assert.equal(request.purpose, "agent");
      assert.equal(request.tools.filter((tool) => tool.name === "read").length, 1);
      const readSchema = request.tools.find((tool) => tool.name === "read")?.input_schema;
      assert.deepEqual(readSchema?.required, ["file_path"]);
      assert.equal(request.input.messages.flatMap((message) => message.content)
        .filter((block) => block.type === "tool_call" || block.type === "tool_result").length, 0);
      firstRequest = request;
      return { events: [
        { type: "tool_call", tool_call_id: TOOL_CALL_ID, name: "read", arguments: {
          file_path: mode === "read" ? NONCE_FILE : MISSING_FILE,
        } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    },
    (request) => {
      assert.ok(firstRequest);
      assert.equal(request.session_id, firstRequest.session_id);
      assert.notEqual(request.request_id, firstRequest.request_id);
      const blocks = request.input.messages.flatMap((message) => message.content);
      const calls = blocks.filter((block) => block.type === "tool_call");
      const results = blocks.filter((block) => block.type === "tool_result");
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(calls[0]?.tool_call_id, TOOL_CALL_ID);
      assert.equal(calls[0]?.name, "read");
      const result = results[0];
      assert.ok(result);
      assert.equal(result.tool_call_id, TOOL_CALL_ID);
      assert.equal(result.is_error, mode === "read-error");
      const text = result.content.map((block) => block.text).join("");
      assert.ok(text.length > 0);
      let answer: string;
      if (mode === "read") {
        const nonces = text.match(/fixture-nonce=[a-f0-9]{32}/g);
        assert.equal(nonces?.length, 1, "Only an actual tool result can supply the fixture nonce");
        answer = `Read complete: ${nonces?.[0]}`;
      } else {
        assert.match(text, /not found|does not exist|no such file/i);
        answer = "Read error handled: the requested fixture does not exist.";
      }
      return { events: [
        { type: "text_delta", text: answer.slice(0, 10) },
        { type: "text_delta", text: answer.slice(10) },
        { type: "completed", finish_reason: "stop" },
      ] };
    },
  ];
}
