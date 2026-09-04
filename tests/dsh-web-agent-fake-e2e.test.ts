import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runFakeDshHeadless } from "./fixtures/dsh-web-agent/run-fake-headless.ts";

const TASK = "Complete one deterministic DeepSeek Web Harness turn.";
const ANSWER = "Fake DeepSeek Web completed one Harness turn.";

describe("DeepSeek Web Agent fake-browser process E2E", () => {
  it("runs the actual dsh entry through the loopback model route and durably flushes the session", async () => {
    const result = await runFakeDshHeadless({
      task: TASK,
      answerFragments: ["Fake DeepSeek Web completed ", "one Harness turn."],
      usage: { inputTokens: 31, outputTokens: 9 },
      inheritedEnvironmentProbe: {
        DASHSCOPE_API_KEY: "fixture-only-dashscope",
        AWS_BEDROCK_API_KEY: "fixture-only-bedrock",
        AWS_ACCESS_KEY_ID: "fixture-only-aws-access",
      },
    });

    expect(result.command).toMatchObject({
      executable: process.execPath,
      args: expect.arrayContaining([
        "--profile",
        "deepseek-web-agent",
        "--patch",
        expect.stringMatching(/startup-barrier\.patch\.yml$/),
        TASK,
      ]),
      shell: false,
      windowsHide: true,
    });
    expect(result.command.args[0]).toBe(join(
      resolve(process.cwd(), "node_modules", "@deepseek-ai", "dsh"),
      "lib",
      "bin.js",
    ));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${ANSWER}\n`);
    expect(result.stderr).toBe("");
    expect(result.childEnvironmentKeys).toEqual(expect.arrayContaining([
      "DSH_HOME",
      "DSH_TELEMETRY_DISABLED",
      "DSH_WEB_BROKER_PORT",
      "DSH_WEB_PAIRING_TOKEN",
      "DSH_WEB_ALLOWED_EXTENSION_ORIGINS",
      "DSH_WEB_FAKE_RELEASE_FILE",
    ]));
    expect(result.childEnvironmentKeys).not.toEqual(expect.arrayContaining([
      "DASHSCOPE_API_KEY",
      "AWS_BEDROCK_API_KEY",
      "AWS_ACCESS_KEY_ID",
    ]));
    expect(result.observedRequests).toHaveLength(1);
    expect(result.observedRequests[0]).toMatchObject({
      purpose: "agent",
      model: { provider: "deepseek-web", model_id: "current-web-session" },
      input: {
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: [{ type: "text", text: TASK }] }),
        ]),
      },
      tools: [],
      options: { thinking_enabled: false, search_enabled: false, model_type: "default" },
    });

    expect(result.sessionLogCount).toBe(1);
    expect(result.persistedRaw.endsWith("\n")).toBe(true);
    expect(result.persistedRecords[0]).toMatchObject({
      type: "session",
      id: result.observedRequests[0]?.session_id,
      cwd: result.workspaceCwd,
    });
    const events = result.persistedRecords.slice(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "user/message",
        data: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: TASK }],
        }),
      }),
      expect.objectContaining({
        type: "request/header",
        data: expect.objectContaining({
          header: expect.objectContaining({
            config: { provider: "deepseek-web", model: "current-web-session" },
          }),
        }),
      }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request/context",
        data: expect.objectContaining({ provider: "deepseek-web", model: "current-web-session" }),
      }),
      expect.objectContaining({
        type: "assistant/message",
        data: expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: ANSWER }],
            source: { kind: "model", provider: "deepseek-web", model: "current-web-session" },
          }),
          usage: { inputTokens: 31, outputTokens: 9 },
        }),
      }),
      expect.objectContaining({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
    const eventTypes = events.map((event) => event.type);
    const orderedTypes = [
      "user/message",
      "request/header",
      "request/context",
      "assistant/message",
      "step/end",
      "turn/end",
    ];
    const orderedIndexes = orderedTypes.map((type) => eventTypes.indexOf(type));
    expect(orderedIndexes.every((index) => index >= 0)).toBe(true);
    expect(orderedIndexes).toEqual([...orderedIndexes].sort((left, right) => left - right));
    expect(events.filter((event) => event.type === "request/context")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant/chunk" &&
      (event.data as { chunk?: { type?: string } } | undefined)?.chunk?.type === "text-delta")).toHaveLength(2);

    const durableAndWire = JSON.stringify({
      persistedRecords: result.persistedRecords,
      persistedRaw: result.persistedRaw,
      observedRequests: result.observedRequests,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    expect(durableAndWire).not.toMatch(/reasoning|authorization|cookie|api[_-]?key|pairing[_-]?token/i);
    expect(durableAndWire).not.toContain("fixture-only-");
    expect(result.persistedRaw).not.toMatch(/reasoning|authorization|cookie|api[_-]?key|pairing[_-]?token/i);
    expect(result.portReleased).toBe(true);
    expect(result.tempRootRemoved).toBe(true);
  }, 60_000);
});
