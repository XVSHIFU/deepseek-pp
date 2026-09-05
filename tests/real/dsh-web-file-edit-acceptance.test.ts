import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createFileEditLoopScripts, EDIT_NONCE_FILE, OLD_STATE } from "../fixtures/dsh-web-agent/mutation/file-edit-loop.ts";
import { runFakeDshHeadless, type FakeHeadlessResult } from "../fixtures/dsh-web-agent/run-fake-headless.ts";

interface Expected {
  cwd: string; task: string; finalText: string; fileName: string; nonce: string; forbiddenExact: string[];
}
interface CommandSpec {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  timeoutMs: number; shell: false; windowsHide: true;
}
interface Module {
  createFileEditTask(fixture: { workspace: string; fileName: string; nonce: string }): { task: string; finalText: string };
  verifyFileEditSession(raw: string, expected: Expected): { sessionId: string; modelSteps: number; toolCalls: number };
  validateFileEditProfileDump(raw: string): void;
  runFileEditAcceptance(options: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; nodeVersion?: string }, deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
  main(args: string[], options: Record<string, unknown>): Promise<number>;
}
// @ts-expect-error -- CLI module has no generated TypeScript declarations.
const { createFileEditTask, verifyFileEditSession, validateFileEditProfileDump, runFileEditAcceptance, main } = await import("../../scripts/dsh-web-file-edit-acceptance.mjs") as Module;
// @ts-expect-error -- CLI module has no generated TypeScript declarations.
const { runCommand, parseProfileDump } = await import("../../scripts/dsh-web-real-smoke.mjs") as {
  runCommand(spec: CommandSpec): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  parseProfileDump(text: string): Record<string, unknown>[];
};

const REPO = resolve(import.meta.dirname, "../..");
const PATCH = join(REPO, "packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml");
const NONCE = randomBytes(16).toString("hex");
const SECRET = "never-disclose-this-fixture-pairing-secret";
let actual: FakeHeadlessResult;
let expected: Expected;
let persistedFile = "";

describe("real file-edit acceptance offline contract", () => {
  beforeAll(async () => {
    actual = await runFakeDshHeadless({
      task: (workspace) => createFileEditTask({ workspace, fileName: EDIT_NONCE_FILE, nonce: NONCE }).task,
      patches: [PATCH], generationScripts: createFileEditLoopScripts(),
      prepareWorkspace: (workspace) => writeFile(join(workspace, EDIT_NONCE_FILE), `file-edit-nonce=${NONCE}\n${OLD_STATE}\n`, { flag: "wx" }),
      verifyWorkspace: async (workspace) => { persistedFile = await readFile(join(workspace, EDIT_NONCE_FILE), "utf8"); },
    });
    expected = {
      cwd: actual.workspaceCwd, task: actual.command.args.at(-1)!, finalText: `Edit complete: state=verified-${NONCE}`,
      fileName: EDIT_NONCE_FILE, nonce: NONCE, forbiddenExact: [SECRET],
    };
  }, 45_000);

  it("validates actual DSH view → one original editor mutation → final and independently changed file", () => {
    expect(verifyFileEditSession(actual.persistedRaw, expected)).toEqual({
      sessionId: actual.observedRequests[0]!.session_id, modelSteps: 3, toolCalls: 2,
    });
    expect(persistedFile).toBe(`file-edit-nonce=${NONCE}\nstate=verified-${NONCE}\n`);
    expect(actual.observedRequests).toHaveLength(3);
    expect(JSON.stringify(actual.observedRequests[0])).not.toContain(NONCE);
    expect(actual.childClosed && actual.portReleased && actual.tempRootRemoved).toBe(true);
  });

  it.each([
    "missing-result", "wrong-call-id", "wrong-file", "relative-file", "non-editor", "wrong-replacement",
    "wrong-old-string", "failed-edit", "replayed-edit", "early-nonce", "different-model", "wrong-final", "incomplete",
  ])("rejects invalid or replayed evidence: %s", (variant) => {
    const rows = actual.persistedRaw.trimEnd().split("\n").map((line) => JSON.parse(line));
    const calls = rows.filter((row) => row.type === "tool/call");
    const results = rows.filter((row) => row.type === "tool/result");
    const answers = rows.filter((row) => row.type === "assistant/message");
    const edit = calls[1];
    const editArgs = JSON.parse(edit.data.arguments);
    if (variant === "missing-result") results[1].type = "fixture/removed-result";
    if (variant === "wrong-call-id") results[1].data.message.content[0].toolCallId = "wrong-id";
    if (variant === "wrong-file") editArgs.path = join(expected.cwd, "wrong.txt");
    if (variant === "relative-file") editArgs.path = expected.fileName;
    if (variant === "non-editor") edit.data.name = "write";
    if (variant === "wrong-replacement") editArgs.new_str = "state=fabricated";
    if (variant === "wrong-old-string") editArgs.old_str = "pending";
    if (variant === "failed-edit") results[1].data.message.content[0].isError = true;
    if (variant === "replayed-edit") rows.push({ ...edit, seq: rows.at(-1).seq + 1 });
    if (variant === "early-nonce") answers[0].data.message.content.unshift({ type: "text", text: NONCE });
    if (variant === "different-model") answers[2].data.message.source.provider = "other";
    if (variant === "wrong-final") answers[2].data.message.content = [{ type: "text", text: "done" }];
    if (variant === "incomplete") rows.at(-1).data.reason.kind = "cancelled";
    edit.data.arguments = JSON.stringify(editArgs);
    expect(() => verifyFileEditSession(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", expected))
      .toThrow(expect.objectContaining({ code: "REAL_WEB_TOOL_EVIDENCE_INVALID" }));
  });

  it("rejects sensitive durable records and answer-bearing input", () => {
    expect(() => verifyFileEditSession(actual.persistedRaw.replace("Edit complete", SECRET), expected))
      .toThrow(expect.objectContaining({ code: "REAL_WEB_SESSION_SENSITIVE_DATA" }));
    expect(() => verifyFileEditSession(actual.persistedRaw, { ...expected, task: `${expected.task} ${NONCE}` }))
      .toThrow(expect.objectContaining({ code: "REAL_WEB_TOOL_EVIDENCE_INVALID" }));
  });

  it("accepts upstream-supported null placeholders for unused editor arguments", () => {
    const rows = actual.persistedRaw.trimEnd().split("\n").map((line) => JSON.parse(line));
    for (const call of rows.filter((row) => row.type === "tool/call")) {
      const args = JSON.parse(call.data.arguments);
      Object.assign(args, args.command === "view" ? { old_str: null, new_str: null, file_text: null, insert_line: null, view_range: null }
        : { file_text: null, insert_line: null, view_range: null });
      call.data.arguments = JSON.stringify(args);
      const answer = rows.find((row) => row.type === "assistant/message" && row.data.step === call.data.step);
      answer.data.message.content.find((block: { type: string }) => block.type === "tool-call").arguments = call.data.arguments;
    }
    expect(verifyFileEditSession(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", expected)).toMatchObject({ modelSteps: 3, toolCalls: 2 });
  });

  it("has zero preparation, child process, or browser effects without explicit opt-in", async () => {
    const prepareFixture = vi.fn(), child = vi.fn();
    let output = "";
    expect(await main([], {
      cwd: REPO, env: {}, nodeVersion: "24.18.0", dependencies: { prepareFixture, runCommand: child },
      stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { output += value; } },
    })).toBe(2);
    expect(prepareFixture).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    expect(JSON.parse(output).error).toBe("REAL_WEB_CONFIRMATION_REQUIRED");
  });

  it.each(["valid", "unchanged-file", "failed-command"])("independently checks disk and never retries the launched turn: %s", async (variant) => {
    const base = parseProfileDump(await readFile(join(REPO, "tests/real/fixtures/dsh-web-real-smoke/profile-dump.yml"), "utf8"));
    const patch = parseProfileDump(await readFile(PATCH, "utf8"));
    const profile = JSON.stringify([...base, ...(patch.find((row) => Array.isArray(row.insert))!.insert as unknown[])]);
    const home = join(dirname(expected.cwd), "dsh-home");
    const fixture = { id: "file-edit-fixture", workspace: expected.cwd, home, fileName: EDIT_NONCE_FILE, nonce: NONCE };
    const executed: CommandSpec[] = [];
    let enumerations = 0;
    const attempt = runFileEditAcceptance({ args: ["--confirm-real-web"], cwd: REPO, env: cleanEnv(REPO) }, {
      prepareFixture: async () => fixture,
      readOptionalText: async () => undefined,
      listSessionLogs: async () => new Set(enumerations++ === 0 ? [] : ["fixture/session.jsonl"]),
      readText: async (path: string) => path.endsWith("package.json") ? JSON.stringify({
        private: true, dependencies: { "@deepseek-pp/dsh-web-agent-bundle": "file:fixture" },
        dsh: { profile: { patchReload: "startup", bundles: ["@deepseek-pp/dsh-web-agent-bundle"] } },
      }) : path.endsWith("session.jsonl") ? actual.persistedRaw
        : variant === "unchanged-file" ? `file-edit-nonce=${NONCE}\nstate=pending\n` : persistedFile,
      runCommand: async (spec: CommandSpec) => {
        executed.push(spec);
        if (spec.args.includes("--version")) return { exitCode: 0, stdout: "0.1.2-rc.1\n", stderr: "" };
        if (spec.args.includes("--dump-config")) return { exitCode: 0, stdout: profile, stderr: "" };
        if (spec.args.includes("plugin")) return { exitCode: 0, stdout: "", stderr: "" };
        expect(spec.args.at(-1)).toBe(expected.task);
        return variant === "failed-command" ? { exitCode: 1, stdout: "", stderr: "fixture failure" }
          : { exitCode: 0, stdout: `${expected.finalText}\n`, stderr: "" };
      },
    });
    if (variant === "valid") await expect(attempt).resolves.toMatchObject({ ok: true, model_steps: 3, tool_calls: 2, tool_results: 2, file_verified: true, file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    else await expect(attempt).rejects.toMatchObject({ code: variant === "unchanged-file" ? "REAL_WEB_FILE_EDIT_NOT_APPLIED" : "REAL_WEB_DSH_FAILED" });
    expect(executed).toHaveLength(4);
    expect(executed.filter((spec) => spec.args.some((arg) => arg.endsWith("browser-ready-barrier.patch.yml")))).toHaveLength(1);
  });

  it("prepares an actual isolated editor profile without starting a browser or DSH model turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-file-edit-preflight-"));
    const stop = new Error("STOP_BEFORE_MODEL");
    let launch: CommandSpec | undefined;
    let dumpText = "";
    let offlineCommands = 0;
    try {
      await expect(runFileEditAcceptance({ args: ["--confirm-real-web"], cwd, env: cleanEnv(cwd) }, {
        async runCommand(spec: CommandSpec) {
          if (spec.args.some((arg) => arg.endsWith("browser-ready-barrier.patch.yml"))) { launch = spec; throw stop; }
          expect(spec.args.includes("--version") || spec.args.includes("--dump-config") || spec.args.includes("--offline")).toBe(true);
          offlineCommands++;
          const result = await runCommand({ ...spec, timeoutMs: 15_000 });
          if (spec.args.includes("--dump-config")) dumpText = result.stdout;
          return result;
        },
      })).rejects.toBe(stop);
      expect(offlineCommands).toBe(3);
      expect(launch).toBeDefined();
      expect(launch!.args).toContain(PATCH);
      expect(launch!.args.some((arg) => arg.endsWith("cordis.readonly.patch.yml"))).toBe(false);
      expect(launch!.env.DSH_WEB_WORKSPACE_ROOT).toBe(launch!.cwd);
      expect(launch!.env.DSH_HOME).toBe(join(dirname(launch!.cwd), "dsh-home"));
      const text = await readFile(join(launch!.cwd, EDIT_NONCE_FILE), "utf8");
      expect(text).toMatch(/^file-edit-nonce=[a-f0-9]{32}\nstate=pending\n$/);
      expect(launch!.args.at(-1)).not.toContain(text.split("\n")[0]!.split("=")[1]);
      expect(existsSync(join(launch!.env.DSH_HOME!, "sessions"))).toBe(false);
      expect(() => validateFileEditProfileDump(dumpText)).not.toThrow();
      expect(() => validateFileEditProfileDump(dumpText.replace("workspace-write", "danger-full-access")))
        .toThrow(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
      expect(() => validateFileEditProfileDump(dumpText.replace("policy: ask", "policy: always-allow")))
        .toThrow(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
    } finally { await rm(cwd, { recursive: true, force: true }); }
    expect(existsSync(cwd)).toBe(false);
  }, 45_000);
});

function cleanEnv(cwd: string): NodeJS.ProcessEnv {
  const keys = new Set(["path", "pathext", "systemroot", "windir", "comspec", "userprofile", "home", "homedrive", "homepath", "appdata", "localappdata", "temp", "tmp", "tmpdir", "programfiles", "programfiles(x86)", "programw6432", "systemdrive"]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.has(key.toLowerCase()))),
    DSH_HOME: join(cwd, "initial-home"), DSH_WEB_BROKER_PORT: "43123",
    DSH_WEB_PAIRING_TOKEN: randomBytes(32).toString("base64url"),
    DSH_WEB_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    DSH_WEB_REAL_BROWSER_ATTESTATION: "logged-in-and-broker-enabled", DSH_TELEMETRY_DISABLED: "1",
  };
}
