import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { encodeSeqRanges, packChunkRuns, SessionSeq } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";

import { NONCE_FILE } from "../fixtures/dsh-web-agent/tool-loop/request-script.ts";
import { runDshToolLoop } from "../fixtures/dsh-web-agent/tool-loop/run-tool-loop.ts";

interface ReadOnlyExpected {
  cwd: string;
  task: string;
  finalText: string;
  fileName: string;
  nonce: string;
  forbiddenExact: string[];
}

interface AcceptanceModule {
  verifyReadOnlySession(raw: string, expected: ReadOnlyExpected): {
    sessionId: string;
    modelSteps: 2;
    toolCalls: 1;
  };
  runReadOnlyAcceptance(options: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    nodeVersion?: string;
  }, dependencies?: Record<string, unknown>): Promise<Record<string, unknown>>;
  main(args: readonly string[], options?: {
    stdout?: { write(value: string): unknown };
    stderr?: { write(value: string): unknown };
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    dependencies?: Record<string, unknown>;
  }): Promise<number>;
}

interface CommandSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell: false;
  windowsHide: true;
}

// @ts-expect-error -- The executable .mjs has no generated TypeScript declarations.
const { verifyReadOnlySession, runReadOnlyAcceptance, main } = await import("../../scripts/dsh-web-readonly-acceptance.mjs") as AcceptanceModule;
// @ts-expect-error -- The executable .mjs has no generated TypeScript declarations.
const { runCommand: realRunCommand } = await import("../../scripts/dsh-web-real-smoke.mjs") as {
  runCommand(spec: CommandSpec): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const NONCE = "readonly-nonce-00112233445566778899aabbccddeeff";
const TOKEN = "fixture-pairing-secret-not-for-model-output";
const FILE_NAME = "proof.txt";
const TASK = `Read ${FILE_NAME} with the read tool and return READ_OK: followed by its content.`;
const FINAL = `READ_OK:${NONCE}`;
const MODEL_SOURCE = { kind: "model", provider: "deepseek-web", model: "current-web-session" };

type Variant = "valid" | "relative-file" | "absolute-file" | "task-nonce" | "assistant-nonce" | "missing-result" | "wrong-call-id" |
  "wrong-file" | "non-read" | "wrong-final" | "missing-step-two" | "corrupt-packed" |
  "secret" | "alternate-model";

describe("real read-only acceptance offline evidence", () => {
  it("installs and validates the actual isolated profile but refuses to start its web-model command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-readonly-runner-preflight-"));
    const stopped = new Error("TEST_STOP_BEFORE_WEB_MODEL_START");
    const executed: CommandSpec[] = [];
    const intercepted: CommandSpec[] = [];
    const systemKeys = new Set([
      "path", "pathext", "systemroot", "windir", "comspec", "userprofile", "home", "homedrive", "homepath",
      "appdata", "localappdata", "temp", "tmp", "tmpdir", "programfiles", "programfiles(x86)", "programw6432", "systemdrive",
    ]);
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase()))),
      DSH_HOME: join(cwd, "initial-home"),
      DSH_WEB_BROKER_PORT: "43123",
      DSH_WEB_PAIRING_TOKEN: randomBytes(32).toString("base64url"),
      DSH_WEB_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      DSH_WEB_REAL_BROWSER_ATTESTATION: "logged-in-and-broker-enabled",
      DSH_TELEMETRY_DISABLED: "1",
    };
    try {
      await expect(runReadOnlyAcceptance({
        args: ["--confirm-real-web"], cwd, env, nodeVersion: process.versions.node,
      }, {
        async runCommand(spec: CommandSpec) {
          if (spec.args.some((arg) => arg.endsWith("browser-ready-barrier.patch.yml"))) {
            intercepted.push(spec);
            throw stopped;
          }
          // Only these actual offline commands may execute. No DSH agent or
          // broker is ever started by this test's runReadOnlyAcceptance call.
          expect(spec.args.includes("--version") || spec.args.includes("--dump-config") ||
            (spec.args.includes("plugin") && spec.args.includes("--offline"))).toBe(true);
          executed.push(spec);
          const result = await realRunCommand({ ...spec, timeoutMs: 15_000 });
          expect(result.exitCode).toBe(0);
          return result;
        },
      })).rejects.toBe(stopped);
      expect(executed).toHaveLength(3);
      expect(executed[0]?.args).toContain("--version");
      expect(executed[1]?.args).toEqual(expect.arrayContaining(["plugin", "add", "--offline"]));
      expect(executed[2]?.args).toContain("--dump-config");
      expect(intercepted).toHaveLength(1);
      const launch = intercepted[0]!;
      expect(launch.env.DSH_WEB_WORKSPACE_ROOT).toBe(launch.cwd);
      expect(launch.env.DSH_HOME).not.toBe(env.DSH_HOME);
      expect(launch.env.DSH_HOME).toBe(join(dirname(launch.cwd), "dsh-home"));
      expect(relative(cwd, launch.cwd).startsWith("..")).toBe(false);
      const proof = await readFile(join(launch.cwd, "proof.txt"), "utf8");
      expect(proof).toMatch(/^proof=[a-f0-9]{32}\n$/);
      const nonce = proof.slice("proof=".length).trimEnd();
      const task = launch.args.at(-1)!;
      expect(task).toContain("proof.txt");
      expect(task).not.toContain(nonce);
      expect(task).not.toContain(env.DSH_WEB_PAIRING_TOKEN);
      expect(launch.args).toEqual(expect.arrayContaining([
        "--patch", expect.stringMatching(/cordis\.readonly\.patch\.yml$/),
      ]));
      expect(existsSync(join(launch.env.DSH_HOME!, "sessions"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    expect(existsSync(cwd)).toBe(false);
  }, 45_000);

  it("validates raw durable evidence produced by the actual DSH CLI and official read registry", async () => {
    const run = await runDshToolLoop("read");
    const task = run.process.command.args.at(-1);
    expect(typeof task).toBe("string");
    expect(verifyReadOnlySession(run.process.persistedRaw, {
      cwd: run.process.workspaceCwd,
      task: task!,
      finalText: run.finalText,
      fileName: NONCE_FILE,
      nonce: run.expectedNonce,
      forbiddenExact: [],
    })).toEqual({
      sessionId: run.process.observedRequests[0]?.session_id,
      modelSteps: 2,
      toolCalls: 1,
    });
    expect(run.process.portReleased).toBe(true);
    expect(run.process.childClosed).toBe(true);
    expect(run.process.tempRootRemoved).toBe(true);
  }, 45_000);

  it("accepts an official packed two-step read session with one model epoch record", () => {
    const { raw, expected } = fixture();
    expect(raw).toContain('"type":"text-chunks"');
    expect(raw.match(/"type":"request\/header"/g)).toHaveLength(1);
    expect(raw.match(/"type":"request\/context"/g)).toHaveLength(1);
    expect(expected.task).not.toContain(expected.nonce);
    expect(verifyReadOnlySession(raw, expected)).toEqual({
      sessionId: "session-readonly-fixture",
      modelSteps: 2,
      toolCalls: 1,
    });
  });

  it.each(["relative-file", "absolute-file"] as const)("accepts a legitimate spelling of the same fixture file: %s", (variant) => {
    const { raw, expected } = fixture(variant);
    expect(verifyReadOnlySession(raw, expected)).toEqual({
      sessionId: "session-readonly-fixture",
      modelSteps: 2,
      toolCalls: 1,
    });
  });

  it("refuses an unconfirmed run before fixture creation or any child process", async () => {
    const runCommand = vi.fn();
    const prepareFixture = vi.fn();
    let stdout = "";
    let stderr = "";
    await expect(main([], {
      cwd: process.cwd(),
      env: {},
      nodeVersion: "24.18.0",
      dependencies: { runCommand, prepareFixture },
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    })).resolves.toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(prepareFixture).not.toHaveBeenCalled();
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, error: "REAL_WEB_CONFIRMATION_REQUIRED" });
  });

  it.each(["task-nonce", "assistant-nonce"] as const)("rejects a nonce disclosed before the read: %s", (variant) => {
    const { raw, expected } = fixture(variant);
    expect(() => verifyReadOnlySession(raw, expected)).toThrow(expect.objectContaining({
      code: "REAL_WEB_TOOL_EVIDENCE_INVALID",
    }));
  });

  it.each(["missing-result", "wrong-call-id", "wrong-file", "non-read"] as const)(
    "requires the exact real read and its correlated result: %s", (variant) => {
      const { raw, expected } = fixture(variant);
      expect(() => verifyReadOnlySession(raw, expected)).toThrow(expect.objectContaining({
        code: "REAL_WEB_TOOL_EVIDENCE_INVALID",
      }));
    },
  );

  it.each(["wrong-final", "missing-step-two", "alternate-model"] as const)(
    "does not substitute a final reply or a different model for the second step: %s", (variant) => {
      const { raw, expected } = fixture(variant);
      expect(() => verifyReadOnlySession(raw, expected)).toThrow(expect.objectContaining({
        code: "REAL_WEB_TOOL_EVIDENCE_INVALID",
      }));
    },
  );

  it("rejects corrupt packed storage instead of treating it as one ordinary event", () => {
    const { raw, expected } = fixture("corrupt-packed");
    expect(() => verifyReadOnlySession(raw, expected)).toThrow(expect.objectContaining({
      code: "REAL_WEB_TOOL_EVIDENCE_INVALID",
    }));
  });

  it("rejects the original pairing token anywhere in the durable evidence", () => {
    const { raw, expected } = fixture("secret");
    expect(() => verifyReadOnlySession(raw, expected)).toThrow(expect.objectContaining({
      code: "REAL_WEB_SESSION_SENSITIVE_DATA",
    }));
  });
});

function fixture(variant: Variant = "valid"): { raw: string; expected: ReadOnlyExpected } {
  const task = variant === "task-nonce" ? `${TASK} ${NONCE}` : TASK;
  const calledFile = variant === "wrong-file" ? "not-the-created-file.txt"
    : variant === "relative-file" ? `./${FILE_NAME}`
      : variant === "absolute-file" ? resolve("C:/fixture-only-readonly-workspace", FILE_NAME)
        : FILE_NAME;
  const calledTool = variant === "non-read" ? "write" : "read";
  const call = { type: "tool-call", id: "fixture-call-1", name: calledTool, arguments: JSON.stringify({ file_path: calledFile }) };
  const toolResult = {
    type: "tool-result",
    toolCallId: variant === "wrong-call-id" ? "unrelated-call" : call.id,
    content: [{ type: "text", text: `<content>\n1: ${NONCE}${variant === "secret" ? ` ${TOKEN}` : ""}\n</content>` }],
    isError: false,
  };
  const finalText = variant === "wrong-final" ? "A fabricated result without the nonce." : FINAL;
  const eventBodies = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", data: { role: "user", id: "user-1", source: { kind: "user" }, content: [{ type: "text", text: task }] } },
    { type: "request/header", data: { header: { config: { provider: "deepseek-web", model: "current-web-session" } } } },
    { type: "request/context", data: { provider: "deepseek-web", model: "current-web-session" } },
    {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: {
        id: "assistant-1", role: "assistant", source: MODEL_SOURCE,
        content: variant === "assistant-nonce" ? [{ type: "text", text: NONCE }, call] : [call],
      } },
    },
    { type: "tool/call", data: { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments } },
    ...(variant === "missing-result" ? [] : [{
      type: "tool/result", data: { turn: 1, step: 1, message: {
        id: "tool-result-1", role: "user", source: { kind: "tool", callId: toolResult.toolCallId }, content: [toolResult],
      } },
    }]),
    { type: "step/end", data: { turn: 1, step: 1 } },
    ...(variant === "missing-step-two" ? [] : [{ type: "step/start", data: { turn: 1, step: 2 } }]),
    ...[finalText.slice(0, 7), finalText.slice(7, 16), finalText.slice(16)].map((text) => ({
      type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text } },
    })),
    {
      type: "assistant/message", data: { turn: 1, step: 2, message: {
        id: "assistant-2", role: "assistant", content: [{ type: "text", text: finalText }],
        source: variant === "alternate-model" ? { ...MODEL_SOURCE, provider: "other-provider" } : MODEL_SOURCE,
      } },
    },
    { type: "step/end", data: { turn: 1, step: 2 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const events = eventBodies.map((event, seq) => ({ ...event, seq, time: 1_788_480_000_000 + seq }));
  const sourceSeqs = events.filter((event) => event.type === "assistant/chunk").map((event) => SessionSeq(event.seq));
  const rows = packChunkRuns(events as unknown as Parameters<typeof packChunkRuns>[0]);
  const chunkRun = rows.find((event) => event.type === "text-chunks");
  if (variant === "corrupt-packed" && chunkRun !== undefined) chunkRun.data.dt.pop();
  const storage: Record<string, unknown>[] = rows;
  const lastAssistant = storage.findLast((row) => row.type === "assistant/message");
  if (lastAssistant !== undefined) lastAssistant.sourceEventSeqs = encodeSeqRanges(sourceSeqs);
  const expected: ReadOnlyExpected = {
    cwd: resolve("C:/fixture-only-readonly-workspace"), task, finalText: FINAL,
    fileName: FILE_NAME, nonce: NONCE, forbiddenExact: [TOKEN],
  };
  const raw = [{ type: "session", id: "session-readonly-fixture", cwd: expected.cwd }, ...storage]
    .map((row) => JSON.stringify(row)).join("\n") + "\n";
  return { raw, expected };
}
