// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { OfficialWebProfileFixture } from "./fixtures/t7-official-profile/runtime.ts";

const DSH_BIN = join(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const installRuntime = await import(new URL(
  "../packages/dsh-web-agent-bundle/bin/install-runtime.mjs",
  import.meta.url,
).href);

const fixtures: OfficialWebProfileFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe.skipIf(process.platform !== "win32")("official web Profile native PowerShell composition", () => {
  it("isolates native pwsh to DeepSeek Web and preserves foreground lifecycle semantics", async () => {
    const fixture = await OfficialWebProfileFixture.create();
    fixtures.push(fixture);
    const dumped = await installRuntime.runProcess(process.execPath, [
      DSH_BIN,
      "--profile",
      "web",
      "--dump-default-config",
    ], { cwd: fixture.workspace, env: fixture.environment, timeoutMs: 5_000 });
    expect(dumped.code, dumped.stderr).toBe(0);
    expect(dumped.stdout).toMatch(/id: pwsh-sandbox[\s\S]*name: '@deepseek-ai\/dsh-pwsh-sandbox'/u);
    expect(dumped.stdout).toMatch(/id: session-persistence-jsonl[\s\S]*name: '@deepseek-ai\/dsh-session-persistence-jsonl'[\s\S]*disabled: true/u);
    expect(dumped.stdout).toMatch(/id: deepseek-web-session-persistence[\s\S]*name: '@deepseek-pp\/dsh-deepseek-web-official-plugin\/session-persistence'/u);
    await fixture.start();
    await fixture.configureConnection();
    await fixture.connectBrowser();

    // The ask-policy command writes outside the session workspace. The base
    // workspace-write sandbox would deny this exact effect, so success proves
    // the DeepSeek Web Agent saw the isolated official pwsh-local definition.
    const askSession = await createSelectedSession(fixture);
    const askProof = join(fixture.root, "native-ask-outside-workspace.txt");
    const approvals = await fixture.openApprovalResponder(["allowed-once"]);
    fixture.peer.enqueueGeneration((request) => {
      assertForegroundOnlyNativeSchema(request);
      return pwshCall("t7-native-ask", askProof, "approved-native");
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(resultFor(request, "t7-native-ask")?.is_error).toBe(false);
      return final("T7_NATIVE_ASK_COMPLETE");
    });
    expect((await prompt(fixture, askSession, "Run one approved native PowerShell command.")).ok).toBe(true);
    await fixture.followUntil(askSession, (wire) => wire.includes("T7_NATIVE_ASK_COMPLETE") && wire.includes("turn/end"));
    await approvals.waitForCount(1);
    expect(approvals.decisions[0]?.request).toMatchObject({ toolName: "pwsh" });
    expect(String(approvals.decisions[0]?.request.reason)).toContain("current Windows user");
    expect((await readFile(askProof, "utf8")).trim()).toBe("approved-native");
    await approvals.close();

    await setWindowsApprovalPolicy(fixture, "auto");
    const autoSession = await createSelectedSession(fixture);
    const timeoutPidFile = join(fixture.workspace, "native-timeout-child.pid");
    const autoProof = join(fixture.root, "native-auto-outside-workspace.txt");
    const unexpectedApproval = await fixture.openApprovalResponder([]);
    fixture.peer.enqueueGeneration((request) => {
      assertForegroundOnlyNativeSchema(request);
      return {
        events: [
          {
            type: "tool_call" as const,
            tool_call_id: "t7-native-timeout",
            name: "pwsh",
            arguments: {
              command: childWaitCommand(timeoutPidFile),
              description: "Timeout native descendant process tree",
              timeoutMs: 800,
            },
          },
          { type: "completed" as const, finish_reason: "tool_calls" as const },
        ],
      };
    });
    fixture.peer.enqueueGeneration((request) => {
      const timeout = resultFor(request, "t7-native-timeout");
      expect(timeout?.is_error).toBe(false);
      expect(JSON.stringify(timeout)).toContain("timed out after 800ms");
      return pwshCall("t7-native-auto", autoProof, "explicit-auto-native");
    });
    fixture.peer.enqueueGeneration((request) => {
      expect(resultFor(request, "t7-native-auto")?.is_error).toBe(false);
      return final("T7_NATIVE_AUTO_COMPLETE");
    });
    expect((await prompt(fixture, autoSession, "Verify timeout then explicit automatic execution.")).ok).toBe(true);
    await fixture.followUntil(autoSession, (wire) => wire.includes("T7_NATIVE_AUTO_COMPLETE") && wire.includes("turn/end"));
    await unexpectedApproval.close();
    expect((await readFile(autoProof, "utf8")).trim()).toBe("explicit-auto-native");
    const timeoutPid = Number((await readFile(timeoutPidFile, "utf8")).trim());
    await waitForProcessExit(timeoutPid);

    const cancelSession = await createSelectedSession(fixture);
    const cancelPidFile = join(fixture.workspace, "native-cancel-child.pid");
    fixture.peer.enqueueGeneration({
      events: [
        {
          type: "tool_call",
          tool_call_id: "t7-native-cancel",
          name: "pwsh",
          arguments: {
            command: childWaitCommand(cancelPidFile),
            description: "Cancel native descendant process tree",
          },
        },
        { type: "completed", finish_reason: "tool_calls" },
      ],
    });
    expect((await prompt(fixture, cancelSession, "Start the cancellable native command.")).ok).toBe(true);
    await waitForFile(cancelPidFile);
    const cancelPid = Number((await readFile(cancelPidFile, "utf8")).trim());
    const cancelled = await fixture.rpc("session/cancel", { request: { sessionId: cancelSession } });
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    const cancelledWire = await fixture.followUntil(cancelSession, (wire) => wire.includes("turn/end"));
    expect(cancelledWire).toContain("tool call aborted");
    await waitForProcessExit(cancelPid);
  }, 50_000);
});

function assertForegroundOnlyNativeSchema(request: ModelGenerateRequest["params"]): void {
  expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
  const pwsh = request.tools.find((tool) => tool.name === "pwsh");
  expect(pwsh).toBeDefined();
  expect(pwsh?.input_schema.properties).not.toHaveProperty("run_in_background");
  expect(pwsh?.input_schema.properties).not.toHaveProperty("sandbox_permissions");
  expect(pwsh?.description).toContain("Background execution is not available");
}

function resultFor(request: ModelGenerateRequest["params"], callId: string) {
  const found = request.input.messages.flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.tool_call_id === callId);
  return found?.type === "tool_result" ? found : undefined;
}

function final(text: string) {
  return {
    events: [
      { type: "text_delta" as const, text },
      { type: "completed" as const, finish_reason: "stop" as const },
    ],
  };
}

function pwshCall(callId: string, path: string, value: string) {
  return {
    events: [
      {
        type: "tool_call" as const,
        tool_call_id: callId,
        name: "pwsh",
        arguments: {
          command: `Set-Content -LiteralPath '${path.replaceAll("'", "''")}' -Value '${value}'`,
          description: "Write native PowerShell acceptance proof",
        },
      },
      { type: "completed" as const, finish_reason: "tool_calls" as const },
    ],
  };
}

function childWaitCommand(pidFile: string): string {
  const escaped = pidFile.replaceAll("'", "''");
  return `$c = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '${escaped}' -Value $c.Id; Wait-Process -Id $c.Id`;
}

async function createSelectedSession(fixture: OfficialWebProfileFixture): Promise<string> {
  const creation = await fixture.rpc<{ sessionId: string }>("session/create", {
    request: { cwd: fixture.workspace, agentPreset: "standard" },
  });
  expect(creation.ok, JSON.stringify(creation)).toBe(true);
  const sessionId = creation.value?.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  const selected = await fixture.rpc("session/selectModel", {
    request: { sessionId, provider: "deepseek-web", model: "current-web-session" },
  });
  expect(selected.ok, JSON.stringify(selected)).toBe(true);
  return sessionId!;
}

function prompt(fixture: OfficialWebProfileFixture, sessionId: string, text: string) {
  return fixture.rpc("session/prompt", {
    request: {
      requestId: randomUUID(),
      mode: "queue",
      sessionId,
      content: [{ type: "text", text }],
    },
  });
}

async function setWindowsApprovalPolicy(
  fixture: OfficialWebProfileFixture,
  policy: "ask" | "auto",
): Promise<void> {
  const described = await fixture.rpc<{ namespaces: Array<{ ns: string; revision: number }> }>(
    "settings/describe",
    {},
  );
  const section = described.value?.namespaces.find((entry) => entry.ns === "deepseek-web");
  expect(section).toBeDefined();
  const mutated = await fixture.rpc("settings/mutate", {
    ns: "deepseek-web",
    ops: [{ op: "set", path: ["windowsApprovalPolicy"], value: policy }],
    expectedRevision: section!.revision,
  });
  expect(mutated.ok, JSON.stringify(mutated)).toBe(true);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`T7_NATIVE_CHILD_PID_NOT_WRITTEN: ${dirname(path)}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`T7_NATIVE_CHILD_PROCESS_STILL_RUNNING:${pid}`);
}
