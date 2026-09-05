import { describe, expect, it } from "vitest";

import { createReadLoopScripts } from "./fixtures/dsh-web-agent/tool-loop/request-script.ts";
import { assertToolLoopEvidence, runDshToolLoop } from "./fixtures/dsh-web-agent/tool-loop/run-tool-loop.ts";

describe("actual DSH read-only profile tool-loop with fake browser", () => {
  it("executes the official read tool and obtains an unknown nonce through the second broker request", async () => {
    const result = await runDshToolLoop("read");
    expect(result.finalText).toContain(result.expectedNonce);
    const withoutToolEvidence = {
      ...result,
      process: {
        ...result.process,
        persistedRecords: result.process.persistedRecords.filter((event) => event.type !== "tool/result"),
      },
    };
    expect(() => assertToolLoopEvidence(withoutToolEvidence)).toThrow();
    const [firstRound, secondRound] = createReadLoopScripts("read");
    firstRound(result.process.observedRequests[0]!);
    const secondRequest = structuredClone(result.process.observedRequests[1]!);
    secondRequest.input.messages = secondRequest.input.messages.map((message) => ({
      ...message,
      content: message.content.filter((block) => block.type !== "tool_result"),
    }));
    expect(() => secondRound(secondRequest)).toThrow();
  }, 45_000);

  it("returns a real official read error to the model and completes the second round", async () => {
    const result = await runDshToolLoop("read-error");
    expect(result.finalText).toContain("does not exist");
    expect(result.finalText).not.toContain(result.expectedNonce);
  }, 45_000);
});
