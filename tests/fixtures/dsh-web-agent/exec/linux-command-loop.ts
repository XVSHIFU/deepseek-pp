import assert from "node:assert/strict";

import type { FakeGenerationResponder } from "../../harness-bridge/fake-peer/index.ts";

// @ts-expect-error -- The opt-in executable module has no generated declarations.
import { LINUX_COMMAND, LINUX_INPUT_FILE, LINUX_OUTPUT_FILE } from "../../../../scripts/dsh-web-command-acceptance.mjs";

export { LINUX_COMMAND, LINUX_INPUT_FILE, LINUX_OUTPUT_FILE };
export const LINUX_CALL_ID = "linux-command-once";

/** No filesystem import or expected nonce parameter: only real tool output
 * supplies the answer to this scripted replacement for the remote web model.
 */
export function createLinuxCommandScripts(): readonly [FakeGenerationResponder, FakeGenerationResponder] {
  let sessionId: string | undefined;
  return [
    (request) => {
      sessionId = request.session_id;
      assert.equal(request.purpose, "agent");
      assert.deepEqual(request.model, { provider: "deepseek-web", model_id: "current-web-session" });
      assert.deepEqual(request.tools.map((tool) => tool.name).sort(), ["bash", "skill", "str_replace_editor", "subagent"]);
      assert.equal(request.input.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result").length, 0);
      return { events: [
        { type: "tool_call", tool_call_id: LINUX_CALL_ID, name: "bash", arguments: {
          command: LINUX_COMMAND, description: "Create and check the owned Linux fixture", timeoutMs: 5_000,
        } },
        { type: "completed", finish_reason: "tool_calls" },
      ] };
    },
    (request) => {
      assert.equal(request.session_id, sessionId);
      assert.equal(request.purpose, "agent");
      assert.deepEqual(request.model, { provider: "deepseek-web", model_id: "current-web-session" });
      const content = request.input.messages.flatMap((message) => message.content);
      const calls = content.filter((block) => block.type === "tool_call");
      const results = content.filter((block) => block.type === "tool_result");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.tool_call_id, LINUX_CALL_ID);
      assert.equal(calls[0]?.name, "bash");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.tool_call_id, LINUX_CALL_ID);
      assert.equal(results[0]?.is_error, false);
      const text = results[0]!.content.map((block) => block.text).join("");
      const match = /^DSH_LINUX_COMMAND_OK:([a-f0-9]{32})\n$/.exec(text);
      assert.ok(match, "Successful stdout must come from a real completed command, without exit/timeout/denial markers");
      return { events: [
        { type: "text_delta", text: `Linux command verified: ${match[1]}` },
        { type: "completed", finish_reason: "stop" },
      ] };
    },
  ];
}
