// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelGenerateRequest } from "@deepseek-pp/web-model-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { OfficialWebProfileFixture } from "./fixtures/t7-official-profile/runtime.ts";

const fixtures: OfficialWebProfileFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe.skipIf(process.platform !== "win32")("official web Profile with the DeepSeek Web plugin", () => {
  it("uses the public Gateway, standard preset and fake browser without executing default-closed PowerShell", async () => {
    const fixture = await OfficialWebProfileFixture.create();
    fixtures.push(fixture);
    const skillSecret = randomBytes(12).toString("hex");
    await fixture.writeSkill("t7-profile-proof", `T7 skill secret: ${skillSecret}. Give it to one child agent.`);
    await fixture.start();

    const profile = fixtureProfile(await fixture.readProfileManifest());
    expect(profile.dsh?.profile?.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@deepseek-pp/dsh-deepseek-web-official-plugin",
    ]);

    const initial = await fixture.waitForConnection("unconfigured");
    expect(initial).toMatchObject({
      configured: false,
      tokenConfigured: false,
      originConfigured: false,
      windows: { kind: "disabled" },
    });
    expect(JSON.stringify(initial)).not.toContain(fixture.pairingToken);
    const unconfiguredReconnect = await fixture.rpc<Record<string, unknown>>(
      "deepseekWebConnection/reconnect",
      {},
    );
    expect(unconfiguredReconnect).toMatchObject({
      ok: true,
      value: { accepted: false, deferred: false, reason: "unconfigured" },
    });

    const modelCatalog = await fixture.rpc<ModelCatalog>("session/modelCatalog", {});
    expect(modelCatalog.ok).toBe(true);
    expect(modelCatalog.value?.default).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    expect(modelCatalog.value?.routableProviders).toContain("deepseek-web");

    // This session exists before native commands are enabled, so its durable
    // per-session policy must stay disabled after the live setting changes.
    const creation = await fixture.rpc<{ sessionId: string; agentPreset?: string }>("session/create", {
      request: {
        cwd: fixture.workspace,
        agentPreset: "standard",
      },
    });
    expect(creation.ok, JSON.stringify(creation)).toBe(true);
    expect(creation.value?.agentPreset).toBe("standard");
    const sessionId = creation.value?.sessionId;
    expect(sessionId).toEqual(expect.any(String));

    await fixture.configureConnection();
    await fixture.connectBrowser();
    const connected = await fixture.waitForStatus((status) =>
      status.phase === "connected" && record(status.windows).kind === "available");
    expect(connected).toMatchObject({
      configured: true,
      tokenConfigured: true,
      originConfigured: true,
      port: fixture.brokerPort,
    });
    expect(JSON.stringify(connected)).not.toContain(fixture.pairingToken);
    expect(connected.windows).toMatchObject({ kind: "available", major: 7 });
    const configuredSettings = await fixture.waitForSettings((description) =>
      namespaceValue(description, "deepseek-web").makeDefaultForNewSessions === false);
    expect(namespaceValue(configuredSettings, "deepseek-web")).toMatchObject({
      makeDefaultForNewSessions: false,
      windowsCommandsEnabled: true,
      windowsApprovalPolicy: "ask",
      powerShellExecutable: "pwsh",
    });
    expect(namespaceValue(configuredSettings, "shell")).toMatchObject({ pwshPath: "pwsh" });
    const changedCatalog = await fixture.rpc<ModelCatalog>("session/modelCatalog", {});
    expect(changedCatalog.value?.default).toEqual({
      provider: "deepseek-web",
      model: "current-web-session",
    });

    const reconnected = await fixture.reconnect();
    expect(reconnected).toMatchObject({
      ok: true,
      value: { accepted: true, deferred: false },
    });
    await fixture.connectBrowser();

    const skills = await fixture.rpc<{ skills: Array<{ name: string }> }>("skills/list", { request: { sessionId } });
    expect(skills.ok).toBe(true);
    expect(skills.value?.skills.map((skill) => skill.name)).toContain("t7-profile-proof");
    const selection = await fixture.rpc<{ selected: { provider: string; model: string } }>("session/selectModel", {
      request: {
        sessionId,
        provider: "deepseek-web",
        model: "current-web-session",
      },
    });
    expect(selection).toMatchObject({
      ok: true,
      value: { selected: { provider: "deepseek-web", model: "current-web-session" } },
    });

    const forbiddenPowerShellProof = join(fixture.workspace, "pwsh-must-not-execute.txt");
    const editorProof = join(fixture.workspace, "standard-preset-proof.txt");
    let learnedSecret = "";
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      const names = request.tools.map((tool) => tool.name);
      for (const required of ["pwsh", "skill", "write", "subagent"]) {
        expect(names).toContain(required);
      }
      expect(JSON.stringify(request)).not.toContain(skillSecret);
      return {
        events: [
          {
            type: "tool_call",
            tool_call_id: "t7-pwsh-denied",
            name: "pwsh",
            arguments: {
              command: `Set-Content -LiteralPath '${forbiddenPowerShellProof.replaceAll("'", "''")}' -Value executed`,
              description: "Write forbidden acceptance sentinel file",
            },
          },
          { type: "completed", finish_reason: "tool_calls" },
        ],
      };
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      const denied = resultFor(request, "t7-pwsh-denied");
      expect(denied?.is_error).toBe(true);
      expect(JSON.stringify(denied)).toContain("WINDOWS_COMMANDS_DISABLED");
      return {
        events: [
          {
            type: "tool_call",
            tool_call_id: "t7-skill-load",
            name: "skill",
            arguments: { name: "t7-profile-proof" },
          },
          { type: "completed", finish_reason: "tool_calls" },
        ],
      };
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      const loaded = resultFor(request, "t7-skill-load");
      expect(loaded?.is_error).toBe(false);
      const match = JSON.stringify(loaded).match(/T7 skill secret: ([a-f0-9]{24})/u);
      learnedSecret = match?.[1] ?? "";
      expect(learnedSecret).toBe(skillSecret);
      return {
        events: [
          {
            type: "tool_call",
            tool_call_id: "t7-subagent",
            name: "subagent",
            arguments: {
              description: "Confirm T7 profile skill secret",
              prompt: `Return CHILD_PROFILE_CONFIRMED=${learnedSecret}`,
              run_in_background: false,
            },
          },
          { type: "completed", finish_reason: "tool_calls" },
        ],
      };
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(request.session_id).not.toBe(sessionId);
      expect(plainText(request)).toContain(`CHILD_PROFILE_CONFIRMED=${skillSecret}`);
      return final(`CHILD_PROFILE_CONFIRMED=${skillSecret}`);
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(request.session_id).toBe(sessionId);
      const delegated = resultFor(request, "t7-subagent");
      expect(delegated?.is_error).toBe(false);
      expect(JSON.stringify(delegated)).toContain(`CHILD_PROFILE_CONFIRMED=${skillSecret}`);
      return {
        events: [
          {
            type: "tool_call",
            tool_call_id: "t7-editor-create",
            name: "write",
            arguments: {
              file_path: editorProof,
              content: `OFFICIAL_PROFILE_CONFIRMED=${skillSecret}\n`,
            },
          },
          { type: "completed", finish_reason: "tool_calls" },
        ],
      };
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(resultFor(request, "t7-editor-create")?.is_error).toBe(false);
      return final(`OFFICIAL_PROFILE_COMPLETE=${skillSecret}\n${"Durable official profile context. ".repeat(2_500)}`);
    });

    const prompted = await fixture.rpc("session/prompt", {
      request: {
        requestId: randomUUID(),
        mode: "queue",
        sessionId,
        content: [{ type: "text", text: "Use the T7 skill, one child, and the editor after proving PowerShell is closed." }],
      },
    });
    expect(prompted.ok).toBe(true);
    await fixture.followUntil(sessionId!, (wire) =>
      wire.includes(`OFFICIAL_PROFILE_COMPLETE=${skillSecret}`) && wire.includes("turn/end"));
    expect(existsSync(forbiddenPowerShellProof)).toBe(false);
    expect(await readFile(editorProof, "utf8")).toBe(`OFFICIAL_PROFILE_CONFIRMED=${skillSecret}\n`);
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(plainText(request)).toContain(`OFFICIAL_PROFILE_COMPLETE=${skillSecret}`);
      return final(`T7_RECENT_TAIL=${skillSecret}\n${"Retain this newer official profile context. ".repeat(1_000)}`);
    });
    expect((await prompt(fixture, sessionId!, "Add a newer completed turn before manual compaction.")).ok).toBe(true);
    await fixture.followUntil(sessionId!, (wire) =>
      wire.includes(`T7_RECENT_TAIL=${skillSecret}`) && wire.includes("turn/end"));

    // The official Remote Event waterfall is the only approval answer path.
    // A new ask-policy session is rejected with no side effect; a second one
    // gets one grant, then a rejection, proving the grant is one-shot.
    const approvals = await fixture.openApprovalResponder(["rejected", "allowed-once", "rejected"]);
    const rejectedSession = await createSelectedSession(fixture);
    const rejectedProof = join(fixture.workspace, "approval-rejected-must-not-execute.txt");
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      return pwshCall("t7-approval-rejected", rejectedProof, "rejected");
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(resultFor(request, "t7-approval-rejected")?.is_error).toBe(true);
      return final("T7_APPROVAL_REJECTED_CONFIRMED");
    });
    expect((await prompt(fixture, rejectedSession, "Request one rejected foreground command.")).ok).toBe(true);
    await fixture.followUntil(rejectedSession, (wire) =>
      wire.includes("T7_APPROVAL_REJECTED_CONFIRMED") && wire.includes("turn/end"));
    await approvals.waitForCount(1);
    expect(existsSync(rejectedProof)).toBe(false);

    const allowedSession = await createSelectedSession(fixture);
    const allowedProof = join(fixture.workspace, "approval-one-shot.txt");
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      return pwshCall("t7-approval-allowed-once", allowedProof, "once");
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(resultFor(request, "t7-approval-allowed-once")?.is_error).toBe(false);
      return pwshCall("t7-approval-second-rejected", allowedProof, "twice");
    });
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(resultFor(request, "t7-approval-second-rejected")?.is_error).toBe(true);
      return final("T7_APPROVAL_ONE_SHOT_CONFIRMED");
    });
    expect((await prompt(fixture, allowedSession, "Run exactly one approved foreground command.")).ok).toBe(true);
    await fixture.followUntil(allowedSession, (wire) =>
      wire.includes("T7_APPROVAL_ONE_SHOT_CONFIRMED") && wire.includes("turn/end"));
    await approvals.waitForCount(3);
    expect(approvals.decisions.map((entry) => entry.outcome)).toEqual([
      "rejected", "allowed-once", "rejected",
    ]);
    for (const decision of approvals.decisions) {
      expect(decision.request).toMatchObject({ toolName: "pwsh" });
      expect(String(decision.request.reason)).toContain("foreground PowerShell 7 command");
    }
    expect((await readFile(allowedProof, "utf8")).trim()).toBe("once");
    await approvals.close();

    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(request.purpose).toBe("compaction");
      expect(plainText(request)).toContain("Use the T7 skill");
      return final(`T7_PROFILE_CHECKPOINT=${skillSecret}`);
    });
    const commands = await fixture.rpc<Array<{ name: string }>>("commands/list", { agentId: sessionId });
    expect(commands.ok).toBe(true);
    expect(commands.value?.map((command) => command.name)).toContain("compact");
    const compacted = await fixture.rpc<{ result: { kind: string; text?: string } }>("commands/execute", {
      agentId: sessionId,
      line: "/compact",
      images: [],
    });
    fixture.peer.throwIfFailed();
    expect(compacted, JSON.stringify(compacted)).toMatchObject({
      ok: true,
      value: { result: { kind: "success" } },
    });

    const requestsBeforeRestart = [...fixture.peer.observedGenerateRequests];
    expect(requestsBeforeRestart.filter((request) => request.purpose === "compaction")).toHaveLength(1);
    expect(requestsBeforeRestart.filter((request) => request.purpose === "agent")).toHaveLength(12);
    for (const request of requestsBeforeRestart) assertWebRoute(request);
    await fixture.restart();
    const restoredStatus = await fixture.waitForConnection("waiting_for_browser");
    expect(restoredStatus).toMatchObject({ configured: true, tokenConfigured: true, originConfigured: true });
    expect(restoredStatus.windows).toMatchObject({ kind: "available", major: 7 });
    expect(JSON.stringify(restoredStatus)).not.toContain(fixture.pairingToken);
    await fixture.connectBrowser();
    fixture.peer.enqueueGeneration((request) => {
      assertWebRoute(request);
      expect(request.session_id).toBe(sessionId);
      expect(plainText(request)).toContain(`T7_PROFILE_CHECKPOINT=${skillSecret}`);
      return final("T7_COLD_RESUME_CONFIRMED");
    });
    const resumed = await fixture.rpc("session/prompt", {
      request: {
        requestId: randomUUID(),
        mode: "queue",
        sessionId,
        content: [{ type: "text", text: "Continue the compacted official profile session." }],
      },
    });
    expect(resumed.ok).toBe(true);
    await fixture.followUntil(sessionId!, (wire) => wire.includes("T7_COLD_RESUME_CONFIRMED") && wire.includes("turn/end"));
    expect(fixture.peer.observedGenerateRequests).toHaveLength(1);
    assertWebRoute(fixture.peer.observedGenerateRequests[0]!);
  }, 50_000);
});

interface ModelCatalog {
  readonly default: { readonly provider: string; readonly model: string };
  readonly routableProviders: readonly string[];
}

interface SettingsDescription {
  readonly namespaces: Array<{ readonly ns: string; readonly value: unknown }>;
}

interface ProfileManifest {
  readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } };
}

function fixtureProfile(value: unknown): ProfileManifest {
  expect(value).toBeTypeOf("object");
  return value as ProfileManifest;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertWebRoute(request: ModelGenerateRequest["params"]): void {
  expect(request.model).toEqual({ provider: "deepseek-web", model_id: "current-web-session" });
}

function resultFor(request: ModelGenerateRequest["params"], callId: string) {
  const found = request.input.messages.flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.tool_call_id === callId);
  return found?.type === "tool_result" ? found : undefined;
}

function plainText(request: ModelGenerateRequest["params"]): string {
  return request.input.messages.flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function final(text: string) {
  return {
    events: [
      { type: "text_delta" as const, text },
      { type: "completed" as const, finish_reason: "stop" as const },
    ],
  };
}

function namespaceValue(description: SettingsDescription | undefined, ns: string): Record<string, unknown> {
  const value = description?.namespaces.find((entry) => entry.ns === ns)?.value;
  expect(value).toBeTypeOf("object");
  return value as Record<string, unknown>;
}

async function createSelectedSession(fixture: OfficialWebProfileFixture): Promise<string> {
  const creation = await fixture.rpc<{ sessionId: string }>("session/create", {
    request: { cwd: fixture.workspace, agentPreset: "standard" },
  });
  expect(creation.ok, JSON.stringify(creation)).toBe(true);
  const sessionId = creation.value?.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  const selection = await fixture.rpc("session/selectModel", {
    request: { sessionId, provider: "deepseek-web", model: "current-web-session" },
  });
  expect(selection.ok, JSON.stringify(selection)).toBe(true);
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

function pwshCall(callId: string, path: string, value: string) {
  return {
    events: [
      {
        type: "tool_call" as const,
        tool_call_id: callId,
        name: "pwsh",
        arguments: {
          command: `Add-Content -LiteralPath '${path.replaceAll("'", "''")}' -Value '${value}'`,
          description: "Append approval acceptance proof line",
        },
      },
      { type: "completed" as const, finish_reason: "tool_calls" as const },
    ],
  };
}
