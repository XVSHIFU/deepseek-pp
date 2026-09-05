import { describe, expect, it } from "vitest";

import { runCliCrashRecovery, type CrashStage } from "./fixtures/harness-bridge/recovery/run-cli-recovery.ts";

describe("actual DSH CLI crash and browser-worker recovery", () => {
  it.each(["before_ack", "accepted", "streaming", "terminal_not_delivered"] satisfies CrashStage[])(
    "queries the original %s request after restart without replaying its lost stream",
    async (stage) => {
      const result = await runCliCrashRecovery(stage);
      expect(result).toMatchObject({
        initialGenerations: 1, restartGenerations: 0, restartedModelCalls: 0,
        journalPreserved: true, portReleased: true, childrenClosed: true, tempRemoved: true,
      });
      expect(result.command).toMatchObject({ args: expect.arrayContaining(["--profile", "deepseek-web-agent"]) });
      const request = result.request as { request_id: string; request_digest: string; session_id: string; purpose: string };
      expect(request.purpose).toBe("agent");
      expect(result.queries).toEqual([{ schema_version: 1, request_id: request.request_id, request_digest: request.request_digest }]);
      expect(result.beforeRestart).toMatchObject({ records: [{
        requestId: request.request_id, requestDigest: request.request_digest, sessionId: request.session_id, generation: 1,
        state: stage === "before_ack" ? "dispatched" : stage === "accepted" ? "accepted" : "streaming",
        sequence: stage === "before_ack" || stage === "accepted" ? 0 : 1,
      }] });
      expect(result.recovered).toMatchObject({ schema_version: 1, records: [{
        requestId: request.request_id, requestDigest: request.request_digest, sessionId: request.session_id,
        generation: 1, state: "ambiguous", remoteStatus: stage === "terminal_not_delivered" ? "completed" : "ambiguous",
      }] });
      expect(result.status).toMatchObject({
        type: "model.status", request_id: request.request_id, request_digest: request.request_digest,
        status: stage === "terminal_not_delivered" ? "completed" : "ambiguous",
      });
      const records = result.persistedRecords as Array<Record<string, unknown>>;
      // A killed stream has no completed DSH turn. Query metadata is never
      // appended as a replacement assistant message or successful terminal.
      expect(records.filter((record) => record.type === "turn/end")).toEqual([]);
      expect(result.firstExit).toMatchObject({ stdout: "" });
      expect(result.secondExit).toMatchObject({ stdout: "" });
    }, 45_000,
  );
});
