import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLinuxCommandScripts, LINUX_CALL_ID, LINUX_COMMAND, LINUX_INPUT_FILE, LINUX_OUTPUT_FILE } from "./fixtures/dsh-web-agent/exec/linux-command-loop.ts";
import { runFakeDshHeadless } from "./fixtures/dsh-web-agent/run-fake-headless.ts";

// @ts-expect-error -- The opt-in executable module has no generated declarations.
import { verifyCommandSession } from "../scripts/dsh-web-command-acceptance.mjs";

describe("DSH CLI owned temporary root selection", () => {
  it.each(["relative-root", join(homedir(), `.dsh-missing-${randomUUID()}`), resolve("AGENTS.md")])(
    "rejects a non-absolute, absent or non-directory root before fixture or process effects: %s", async (temporaryBaseDirectory) => {
      const prepareWorkspace = vi.fn();
      await expect(runFakeDshHeadless({
        task: "Never start", answerFragments: ["never"], usage: { inputTokens: 0, outputTokens: 0 },
        temporaryBaseDirectory, prepareWorkspace,
      })).rejects.toThrow("FAKE_HEADLESS_TEMPORARY_BASE_INVALID");
      expect(prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it("preserves the default OS temporary directory for existing callers", async () => {
    const result = await runFakeDshHeadless({
      task: "Confirm default temporary placement", answerFragments: ["DSH_DEFAULT_TEMP_OK"], usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(dirname(dirname(result.workspaceCwd))).toBe(resolve(tmpdir()));
    expect(result.stdout).toBe("DSH_DEFAULT_TEMP_OK\n");
    expect(result.exitCode).toBe(0);
    expect(result.childClosed && result.portReleased && result.tempRootRemoved).toBe(true);
  }, 45_000);
});

describe.skipIf(process.platform !== "linux")("actual Linux DSH CLI, official sandbox Bash and fake web model", () => {
  it("creates and tests a workspace file through the production command profile before the second model turn", async () => {
    const nonce = randomBytes(16).toString("hex");
    let persistedFile = "";
    let diskVerifications = 0;
    const result = await runFakeDshHeadless({
      // Home placement makes this fixture distinct from the sandbox's private
      // /tmp. No global TMPDIR mutation and no user project files are touched.
      temporaryBaseDirectory: homedir(),
      patches: [
        resolve("packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml"),
        resolve("packages/dsh-web-agent-bundle/cordis.harness-features.patch.yml"),
        resolve("packages/dsh-web-agent-bundle/cordis.linux-commands.patch.yml"),
      ],
      task: `Use bash once to read ${LINUX_INPUT_FILE}, create ${LINUX_OUTPUT_FILE}, test its content and report the command output.`,
      generationScripts: createLinuxCommandScripts(),
      prepareWorkspace: (workspace) => writeFile(join(workspace, LINUX_INPUT_FILE), `${nonce}\n`, { flag: "wx" }),
      async verifyWorkspace(workspace) {
        persistedFile = await readFile(join(workspace, LINUX_OUTPUT_FILE), "utf8");
        expect(await readFile(join(workspace, LINUX_INPUT_FILE), "utf8")).toBe(`${nonce}\n`);
        diskVerifications++;
      },
    });
    expect(dirname(dirname(result.workspaceCwd))).toBe(resolve(homedir()));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Linux command verified: ${nonce}\n`);
    expect(diskVerifications).toBe(1);
    expect(persistedFile).toBe(`command-proof=${nonce}\n`);
    expect(result.observedRequests).toHaveLength(2);
    expect(JSON.stringify(result.observedRequests[0])).not.toContain(nonce);
    expect(new Set(result.observedRequests.map((request) => request.session_id)).size).toBe(1);
    expect(new Set(result.observedRequests.map((request) => request.request_id)).size).toBe(2);
    expect(result.sessionLogCount).toBe(1);
    expect(verifyCommandSession(result.persistedRaw, {
      cwd: result.workspaceCwd, task: result.command.args.at(-1)!, finalText: `Linux command verified: ${nonce}`,
      fileName: LINUX_INPUT_FILE, nonce, forbiddenExact: [],
    })).toEqual({ sessionId: result.observedRequests[0]!.session_id, modelSteps: 2, toolCalls: 1 });
    // runFakeDshHeadless decodes this raw durable JSONL with the official codec;
    // these are actual session records, not invented tool success metadata.
    expect(result.persistedRaw.endsWith("\n")).toBe(true);
    const events = result.persistedRecords.slice(1);
    const calls = events.filter((row) => row.type === "tool/call");
    const results = events.filter((row) => row.type === "tool/result");
    const answers = events.filter((row) => row.type === "assistant/message");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(answers).toHaveLength(2);
    expect(calls[0]).toMatchObject({ data: { turn: 1, step: 1, name: "bash", callId: LINUX_CALL_ID } });
    expect(JSON.parse(String(record(calls[0]!.data).arguments))).toEqual({
      command: LINUX_COMMAND, description: "Create and check the owned Linux fixture", timeoutMs: 5_000,
    });
    expect(results[0]).toMatchObject({ data: { turn: 1, step: 1, message: {
      source: { kind: "tool", callId: LINUX_CALL_ID }, content: [{
        type: "tool-result", toolCallId: LINUX_CALL_ID, isError: false,
        content: [{ type: "text", text: `DSH_LINUX_COMMAND_OK:${nonce}\n` }],
      }],
    } } });
    expect(record(results[0]!.data).error).toBeUndefined();
    expect(answers[1]).toMatchObject({ data: { turn: 1, step: 2, message: {
      source: { kind: "model", provider: "deepseek-web", model: "current-web-session" },
      content: [{ type: "text", text: `Linux command verified: ${nonce}` }],
    } } });
    expect(events.indexOf(calls[0]!)).toBeLessThan(events.indexOf(results[0]!));
    expect(events.indexOf(results[0]!)).toBeLessThan(events.indexOf(answers[1]!));
    expect(events.at(-1)).toMatchObject({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    // The command uses foreground Bash builtins only and waits for completion;
    // the real CLI owner, socket and generated directory must all be gone.
    expect(result.childClosed).toBe(true);
    expect(result.portReleased).toBe(true);
    expect(result.tempRootRemoved).toBe(true);
  }, 45_000);
});

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}
