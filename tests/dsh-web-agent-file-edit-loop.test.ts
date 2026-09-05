import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runFakeDshHeadless } from "./fixtures/dsh-web-agent/run-fake-headless.ts";
import {
  assertFileEditLoopEvidence,
  createFileEditLoopScripts,
  EDIT_NONCE_FILE,
  OLD_STATE,
} from "./fixtures/dsh-web-agent/mutation/file-edit-loop.ts";

describe("actual DSH workspace-files profile with a three-step fake web model", () => {
  it("views an unknown fixture nonce, edits once from the actual tool result, and persists the new file", async () => {
    const expectedNonce = randomBytes(16).toString("hex");
    let verifiedContents = "";
    let verificationCount = 0;
    const result = await runFakeDshHeadless({
      task: (workspace) => `FILE_EDIT_TARGET_JSON=${JSON.stringify(join(workspace, EDIT_NONCE_FILE))}\nView this file, replace ${OLD_STATE} with a verified state derived from its nonce, then report completion.`,
      patches: [resolve(process.cwd(), "packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml")],
      generationScripts: createFileEditLoopScripts(),
      async prepareWorkspace(workspace) {
        await writeFile(join(workspace, EDIT_NONCE_FILE), `file-edit-nonce=${expectedNonce}\n${OLD_STATE}\n`, { encoding: "utf8", flag: "wx" });
      },
      async verifyWorkspace(workspace) {
        verifiedContents = await readFile(join(workspace, EDIT_NONCE_FILE), "utf8");
        verificationCount += 1;
      },
    });
    expect(verificationCount).toBe(1);
    assertFileEditLoopEvidence(result, expectedNonce, verifiedContents);
    expect(() => assertFileEditLoopEvidence({
      ...result,
      persistedRecords: result.persistedRecords.filter((event) => event.type !== "tool/result"),
    }, expectedNonce, verifiedContents)).toThrow();
    expect(() => assertFileEditLoopEvidence(result, expectedNonce, `file-edit-nonce=${expectedNonce}\n${OLD_STATE}\n`)).toThrow();

    const [first, second] = createFileEditLoopScripts();
    first(result.observedRequests[0]!);
    const missingViewResult = structuredClone(result.observedRequests[1]!);
    missingViewResult.input.messages = missingViewResult.input.messages.map((message) => ({
      ...message, content: message.content.filter((block) => block.type !== "tool_result"),
    }));
    expect(() => second(missingViewResult)).toThrow();
  }, 45_000);
});
