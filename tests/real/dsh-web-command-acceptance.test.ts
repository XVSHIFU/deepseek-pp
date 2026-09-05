import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it, vi } from "vitest";

interface Expected { cwd: string; task: string; finalText: string; fileName: string; nonce: string; forbiddenExact: string[] }
interface CommandSpec { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; shell: false; windowsHide: true }
interface Fixture { workspace: string; home: string; fileName: string; nonce: string; id: string }
interface Scenario {
  patches: string[];
  prepareFixture(cwd: string): Promise<Fixture>;
  verifyFixture(input: string, fixture: Fixture): Record<string, unknown>;
}
interface Module {
  COMMAND_PATCHES: string[]; LINUX_INPUT_FILE: string; LINUX_OUTPUT_FILE: string; LINUX_COMMAND: string;
  createCommandTask(fixture: Pick<Fixture, "nonce">): { task: string; finalText: string };
  createCommandAcceptanceScenario(): Scenario;
  verifyCommandSession(raw: string, expected: Expected): { sessionId: string; modelSteps: number; toolCalls: number };
  validateCommandProfileDump(text: string): void;
  main(args: string[], options: Record<string, unknown>): Promise<number>;
}
// @ts-expect-error -- Executable CLI module has no generated declarations.
const command = await import("../../scripts/dsh-web-command-acceptance.mjs") as Module;
// @ts-expect-error -- The shared CLI lifecycle has no generated declarations.
const { runToolAcceptance } = await import("../../scripts/dsh-web-readonly-acceptance.mjs") as {
  runToolAcceptance(options: Record<string, unknown>, deps: Record<string, unknown>, scenario: Scenario): Promise<Record<string, unknown>>;
};
const REPO = resolve(import.meta.dirname, "../..");
const NONCE = "00112233445566778899aabbccddeeff00";

describe("Linux command acceptance offline contracts (no real web)", () => {
  it("does nothing without explicit confirmation and rejects native Windows before preparing a fixture", async () => {
    const child = vi.fn(), prepareFixture = vi.fn();
    let output = "";
    const options = { dependencies: { runCommand: child, prepareFixture },
      stdout: { write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { output += text; } } };
    expect(await command.main([], options)).toBe(2);
    expect(JSON.parse(output).error).toBe("REAL_WEB_CONFIRMATION_REQUIRED");
    if (process.platform !== "linux") {
      output = "";
      expect(await command.main(["--confirm-real-web"], options)).toBe(1);
      expect(JSON.parse(output).error).toBe("REAL_WEB_COMMAND_REQUIRES_LINUX");
    }
    expect(child).not.toHaveBeenCalled();
    expect(prepareFixture).not.toHaveBeenCalled();
  });

  it("validates the exact three-patch web-only composition, not a raw or alternate shell profile", () => {
    expect(command.COMMAND_PATCHES.map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      "cordis.workspace-files.patch.yml", "cordis.harness-features.patch.yml", "cordis.linux-commands.patch.yml",
    ]);
    const rows = profile();
    expect(() => command.validateCommandProfileDump(JSON.stringify(rows))).not.toThrow();
    const changed = structuredClone(rows);
    changed.find((row) => row.id === "workspace-sandbox-policy")!.config.mode = "danger-full-access";
    expect(() => command.validateCommandProfileDump(JSON.stringify(changed))).toThrow();
    const missing = rows.filter((row) => row.id !== "linux-command-policy");
    expect(() => command.validateCommandProfileDump(JSON.stringify(missing))).toThrow();
    expect(() => command.validateCommandProfileDump(JSON.stringify([...rows, { id: "raw-shell", name: "@deepseek-ai/dsh-bash-local" }]))).toThrow();
  });

  it("validates a synthetic correlated command record without claiming real command execution", () => {
    const { raw, expected } = evidence();
    expect(expected.task).not.toContain(NONCE);
    expect(command.verifyCommandSession(raw, expected)).toEqual({ sessionId: "command-unit-session", modelSteps: 2, toolCalls: 1 });
  });

  it.each(["nonzero", "wrong-correlation", "replay", "changed-command", "early-nonce", "alternate-model", "incomplete"])(
    "rejects invalid durable command evidence: %s", (variant) => {
      const fixture = evidence();
      const rows = fixture.raw.trimEnd().split("\n").map((line) => JSON.parse(line));
      const call = rows.find((row) => row.type === "tool/call");
      const result = rows.find((row) => row.type === "tool/result");
      const answer = rows.find((row) => row.type === "assistant/message");
      if (variant === "nonzero") result.data.message.content[0].content[0].text += "[exit code: 1]";
      if (variant === "wrong-correlation") result.data.message.content[0].toolCallId = "unrelated";
      if (variant === "replay") rows.push({ ...call, seq: rows.length - 1 });
      if (variant === "changed-command") {
        const args = JSON.parse(call.data.arguments);
        args.command += "\nprintf fabricated";
        call.data.arguments = JSON.stringify(args);
        answer.data.message.content[0].arguments = call.data.arguments;
      }
      if (variant === "early-nonce") answer.data.message.content.push({ type: "text", text: NONCE });
      if (variant === "alternate-model") answer.data.message.source.provider = "other";
      if (variant === "incomplete") rows.at(-1).data.reason.kind = "aborted";
      expect(() => command.verifyCommandSession(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", fixture.expected))
        .toThrow(expect.objectContaining({ code: "REAL_WEB_TOOL_EVIDENCE_INVALID" }));
    },
  );

  it("creates only an owned fixture and independently validates the created file's real bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "command-acceptance-unit-"));
    try {
      const scenario = command.createCommandAcceptanceScenario();
      const fixture = await scenario.prepareFixture(root);
      expect(fixture.workspace.startsWith(join(root, ".tmp-deepseek-live", "command-runs"))).toBe(true);
      const input = await readFile(join(fixture.workspace, command.LINUX_INPUT_FILE), "utf8");
      expect(input).toMatch(/^[a-f0-9]{32}\n$/);
      expect(command.createCommandTask(fixture).task).not.toContain(fixture.nonce);
      expect(() => scenario.verifyFixture(input, fixture)).toThrow(expect.objectContaining({ code: "REAL_WEB_COMMAND_FILE_NOT_CREATED" }));
      await writeFile(join(fixture.workspace, command.LINUX_OUTPUT_FILE), "fabricated\n", { flag: "wx" });
      expect(() => scenario.verifyFixture(input, fixture)).toThrow(expect.objectContaining({ code: "REAL_WEB_COMMAND_FILE_INVALID" }));
      await writeFile(join(fixture.workspace, command.LINUX_OUTPUT_FILE), `command-proof=${fixture.nonce}\n`);
      expect(scenario.verifyFixture(input, fixture)).toMatchObject({ command_verified: true, file_verified: true, test_verified: true, file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(() => scenario.verifyFixture("changed\n", fixture)).toThrow(expect.objectContaining({ code: "REAL_WEB_FIXTURE_CHANGED" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("uses the shared lifecycle, preserves patch order and never replays a failed turn (failed=%s)", async (failed) => {
    const root = await mkdtemp(join(tmpdir(), "command-lifecycle-unit-"));
    try {
      const scenario = command.createCommandAcceptanceScenario();
      const fixture = await scenario.prepareFixture(root);
      const expected = evidence(fixture.workspace, fixture.nonce);
      const executions: CommandSpec[] = [];
      let lists = 0;
      const env = {
        DSH_HOME: join(root, "initial-home"), DSH_WEB_BROKER_PORT: "43123", DSH_WEB_PAIRING_TOKEN: randomBytes(32).toString("base64url"),
        DSH_WEB_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", DSH_WEB_REAL_BROWSER_ATTESTATION: "logged-in-and-broker-enabled",
      };
      const attempt = runToolAcceptance({ args: ["--confirm-real-web"], env, cwd: root, nodeVersion: "24.18.0" }, {
        prepareFixture: async () => fixture, readOptionalText: async () => undefined,
        listSessionLogs: async () => new Set(lists++ === 0 ? [] : ["fixture/session.jsonl"]),
        readText: async (path: string) => path.endsWith("package.json") ? JSON.stringify({ private: true,
          dependencies: { "@deepseek-pp/dsh-web-agent-bundle": "file:fixture" }, dsh: { profile: { patchReload: "startup", bundles: ["@deepseek-pp/dsh-web-agent-bundle"] } },
        }) : path.endsWith("session.jsonl") ? expected.raw : readFile(path, "utf8"),
        runCommand: async (spec: CommandSpec) => {
          executions.push(spec);
          expect(spec.shell).toBe(false);
          if (spec.args.includes("--version")) return { exitCode: 0, stdout: "0.1.2-rc.1\n", stderr: "" };
          if (spec.args.includes("plugin")) {
            expect(spec.args).toContain("--workspace-root");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (spec.args.includes("--dump-config")) return { exitCode: 0, stdout: JSON.stringify(profile()), stderr: "" };
          expect(spec.args.at(-1)).toBe(expected.expected.task);
          await writeFile(join(fixture.workspace, command.LINUX_OUTPUT_FILE), `command-proof=${fixture.nonce}\n`, { flag: "wx" });
          return failed ? { exitCode: 1, stdout: "", stderr: "fixture failure" }
            : { exitCode: 0, stdout: expected.expected.finalText + "\n", stderr: "" };
        },
      }, scenario);
      if (failed) await expect(attempt).rejects.toMatchObject({ code: "REAL_WEB_DSH_FAILED" });
      else await expect(attempt).resolves.toMatchObject({ ok: true, model_steps: 2, tool_calls: 1, command_verified: true, test_verified: true });
      expect(executions).toHaveLength(4);
      for (const spec of executions.filter((entry) => !entry.args.includes("--version") && !entry.args.includes("plugin"))) {
        const patches = spec.args.flatMap((arg, index) => arg === "--patch" ? [spec.args[index + 1]] : []);
        expect(patches.slice(0, 3)).toEqual(command.COMMAND_PATCHES);
      }
      expect(executions.filter((entry) => entry.args.some((arg) => arg.endsWith("browser-ready-barrier.patch.yml")))).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function profile() {
  return composeEntries([resolve(REPO, "packages/dsh-web-agent-bundle/cordis.patch.yml"), ...command.COMMAND_PATCHES]
    .map((path) => loadOverlayPatches("command-unit", path)));
}

function evidence(cwd = resolve("command-fixture-workspace"), nonce = NONCE) {
  const { task, finalText } = command.createCommandTask({ nonce });
  const source = { kind: "model", provider: "deepseek-web", model: "current-web-session" };
  const call = { type: "tool-call", id: "command-unit-call", name: "bash", arguments: JSON.stringify({ command: command.LINUX_COMMAND, description: "Verify the owned command fixture", timeoutMs: 5000 }) };
  const rows = [
    { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: task }] } },
    { type: "request/header", data: { header: { config: { provider: source.provider, model: source.model } } } },
    { type: "request/context", data: { provider: source.provider, model: source.model } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: { source, content: [call] } } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments } },
    { type: "tool/result", data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: call.id }, content: [
      { type: "tool-result", toolCallId: call.id, isError: false, content: [{ type: "text", text: `DSH_LINUX_COMMAND_OK:${nonce}\n` }] },
    ] } } },
    { type: "step/end", data: { turn: 1, step: 1 } }, { type: "step/start", data: { turn: 1, step: 2 } },
    { type: "assistant/message", data: { turn: 1, step: 2, message: { source, content: [{ type: "text", text: finalText }] } } },
    { type: "step/end", data: { turn: 1, step: 2 } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ].map((row, seq) => ({ ...row, seq, time: 1_788_480_000_000 + seq }));
  return {
    raw: [{ type: "session", id: "command-unit-session", cwd }, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n",
    expected: { cwd, task, finalText, fileName: command.LINUX_INPUT_FILE, nonce, forbiddenExact: [] },
  };
}
