import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runFakeDshHeadless } from "./fixtures/dsh-web-agent/run-fake-headless.ts";

const FILE_NAME = "profile-created.txt";
const CONTENT = "DSH_PROFILE_EDITOR_CREATED\n";
const FINAL = "DSH_HARNESS_PROFILE_OK";
const CALL_ID = "profile-editor-create";
const SKILL_DESCRIPTION = "Use the profile fixture guide only when this integration fixture asks.";

describe("actual DSH CLI with workspace files and Harness features profiles", () => {
  it("loads both production patches, advertises the disk Skill and performs one original editor create", async () => {
    const skillBodySecret = randomBytes(16).toString("hex");
    let persistedFile = "";
    let diskVerifications = 0;
    const result = await runFakeDshHeadless({
      patches: [
        resolve("packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml"),
        resolve("packages/dsh-web-agent-bundle/cordis.harness-features.patch.yml"),
      ],
      task: (workspace) => `Create the fixture file with the editor, then report completion.\nPROFILE_TARGET_JSON=${JSON.stringify(join(workspace, FILE_NAME))}`,
      async prepareWorkspace(workspace) {
        const skillDir = join(workspace, ".agents", "skills", "profile-fixture-guide");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), `---\nname: profile-fixture-guide\ndescription: ${SKILL_DESCRIPTION}\n---\nLoad-only body: ${skillBodySecret}\n`, { flag: "wx" });
      },
      generationScripts: [
        (request) => {
          expect(request.purpose).toBe("agent");
          expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
          expect(request.tools.map((tool) => tool.name).sort()).toEqual(["skill", "str_replace_editor", "subagent"]);
          expect(JSON.stringify(request)).toContain("profile-fixture-guide");
          expect(JSON.stringify(request)).toContain(SKILL_DESCRIPTION);
          expect(JSON.stringify(request)).not.toContain(skillBodySecret);
          const content = request.input.messages.flatMap((message) => message.content);
          expect(content.filter((block) => block.type === "tool_result")).toHaveLength(0);
          const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          const targetJson = /PROFILE_TARGET_JSON=("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
          expect(targetJson).toBeDefined();
          return { events: [
            { type: "tool_call", tool_call_id: CALL_ID, name: "str_replace_editor", arguments: {
              command: "create", path: JSON.parse(targetJson!), file_text: CONTENT,
            } },
            { type: "completed", finish_reason: "tool_calls" },
          ] };
        },
        (request) => {
          expect(request.purpose).toBe("agent");
          expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
          const content = request.input.messages.flatMap((message) => message.content);
          const results = content.filter((block) => block.type === "tool_result");
          const calls = content.filter((block) => block.type === "tool_call");
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({ tool_call_id: CALL_ID, name: "str_replace_editor", arguments: { command: "create", file_text: CONTENT } });
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({ tool_call_id: CALL_ID, is_error: false });
          expect(results[0]!.content.map((block) => block.text).join("")).toContain("New file created successfully at:");
          return { events: [
            { type: "text_delta", text: FINAL },
            { type: "completed", finish_reason: "stop" },
          ] };
        },
      ],
      async verifyWorkspace(workspace) {
        persistedFile = await readFile(join(workspace, FILE_NAME), "utf8");
        diskVerifications++;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${FINAL}\n`);
    expect(diskVerifications).toBe(1);
    expect(persistedFile).toBe(CONTENT);
    expect(result.observedRequests).toHaveLength(2);
    expect(new Set(result.observedRequests.map((request) => request.session_id)).size).toBe(1);
    expect(new Set(result.observedRequests.map((request) => request.request_id)).size).toBe(2);
    expect(result.sessionLogCount).toBe(1);
    expect(result.persistedRecords.filter((row) => row.type === "tool/call")).toHaveLength(1);
    expect(result.persistedRecords.filter((row) => row.type === "tool/result")).toHaveLength(1);
    expect(result.persistedRecords.at(-1)).toMatchObject({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    expect(result.childClosed).toBe(true);
    expect(result.portReleased).toBe(true);
    expect(result.tempRootRemoved).toBe(true);
  }, 45_000);
});
