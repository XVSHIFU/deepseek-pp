// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { defineContentToolFixture } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POWERSHELL_7_REQUIRED,
  WINDOWS_COMMANDS_DISABLED,
  WINDOWS_COMMAND_DISCLOSURE,
  WINDOWS_SESSION_POLICY_UNAVAILABLE,
  JsonWindowsSessionPolicyStore,
  isFreshWindowsPolicySession,
  installWindowsPowerShellPolicy,
  probePowerShell7,
  resolveWindowsPowerShellConfig,
  windowsSessionPolicyIdentity,
  type WindowsSessionPolicyStore,
} from "../packages/dsh-deepseek-web-official-plugin/src/windows-powershell.ts";
import { createOfficialPowerShellRuntime, resultText } from "./fixtures/t7-powershell/official-runtime.ts";

const runtimes: Awaited<ReturnType<typeof createOfficialPowerShellRuntime>>[] = [];
const ownedPaths: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.allSettled(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("T7 official PowerShell 7 policy", () => {
  it("defaults commands off, defaults enabled commands to ask, and requires explicit auto opt-in", () => {
    expect(resolveWindowsPowerShellConfig({})).toEqual({ enabled: false, approvalPolicy: "ask" });
    expect(resolveWindowsPowerShellConfig({ enabled: true })).toEqual({ enabled: true, approvalPolicy: "ask" });
    expect(resolveWindowsPowerShellConfig({ enabled: true, approvalPolicy: "auto" })).toEqual({
      enabled: true,
      approvalPolicy: "auto",
    });
    expect(WINDOWS_COMMAND_DISCLOSURE).toContain("current Windows user");
    expect(WINDOWS_COMMAND_DISCLOSURE).toContain("cwd is not a sandbox");
  });

  it("accepts PowerShell 7 and rejects missing or legacy executables without fallback", async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSubprocessRuntime);
    try {
      const probe = await probePowerShell7(ctx, "pwsh");
      expect(probe.major).toBeGreaterThanOrEqual(7);
      expect(probe.executable.toLowerCase()).toContain("pwsh");
      await expect(probePowerShell7(ctx, "definitely-not-a-real-powershell-t7.exe"))
        .rejects.toThrow(POWERSHELL_7_REQUIRED);
      const legacy = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      if (existsSync(legacy)) await expect(probePowerShell7(ctx, legacy)).rejects.toThrow(POWERSHELL_7_REQUIRED);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("bounds a hanging PowerShell probe and terminates its managed process", async () => {
    const terminate = vi.fn();
    const waitForExit = vi.fn(async () => true);
    const ctx = {
      subprocess: {
        resolveExecutable: async () => "C:\\fixture\\hanging-pwsh.exe",
        spawn: () => ({
          done: new Promise(() => undefined),
          terminate,
          waitForExit,
          collected: {},
        }),
      },
    } as unknown as Context;
    await expect(probePowerShell7(ctx, "hanging-pwsh", undefined, 20))
      .rejects.toThrow(/POWERSHELL_7_REQUIRED: probe timed out/u);
    expect(terminate).toHaveBeenCalledOnce();
    expect(waitForExit).toHaveBeenCalledWith();
  });

  it("bounds an executable resolver that ignores cancellation", async () => {
    const ctx = {
      subprocess: {
        resolveExecutable: async () => new Promise<string>(() => undefined),
      },
    } as unknown as Context;
    await expect(probePowerShell7(ctx, "hanging-resolver", undefined, 20))
      .rejects.toThrow(/POWERSHELL_7_REQUIRED: probe timed out.*resolving/u);
  });

  it("keeps Web startup alive with an enabled but unavailable PowerShell 7", async () => {
    const runtime = await createOfficialPowerShellRuntime(
      { enabled: true },
      { pwshPath: "definitely-not-a-real-powershell-t7.exe" },
    );
    runtimes.push(runtime);
    expect(runtime.policy.status).toMatchObject({ kind: "unavailable", code: POWERSHELL_7_REQUIRED });
    runtime.agent.session.append("turn/start", { turn: 1 });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './unavailable.txt' -Value 'must-not-run'",
      description: "Try unavailable native command",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(POWERSHELL_7_REQUIRED);
    expect(existsSync(join(runtime.workspace, "unavailable.txt"))).toBe(false);
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("freezes each new session policy across later default changes", async () => {
    const runtime = await createOfficialPowerShellRuntime({ enabled: true });
    runtimes.push(runtime);
    const askAgent = runtime.agent;
    await runtime.policy.flush();
    expect(await runtime.policyStore.get(String(askAgent.session.id), windowsSessionPolicyIdentity(askAgent.session)))
      .toEqual({ enabled: true, approvalPolicy: "ask" });

    await runtime.policy.update({ enabled: true, approvalPolicy: "auto" });
    const autoHandle = await runtime.createAgent();
    await runtime.policy.update({});
    const disabledHandle = await runtime.createAgent();
    await runtime.policy.update({ enabled: true });
    const newAskHandle = await runtime.createAgent();

    await runtime.policy.flush();
    expect(await runtime.policyStore.get(String(askAgent.session.id), windowsSessionPolicyIdentity(askAgent.session)))
      .toEqual({ enabled: true, approvalPolicy: "ask" });
    expect(await runtime.policyStore.get(String(autoHandle.agent.session.id), windowsSessionPolicyIdentity(autoHandle.agent.session)))
      .toEqual({ enabled: true, approvalPolicy: "auto" });
    expect(await runtime.policyStore.get(String(disabledHandle.agent.session.id), windowsSessionPolicyIdentity(disabledHandle.agent.session)))
      .toEqual({ enabled: false, approvalPolicy: "ask" });
    expect(await runtime.policyStore.get(String(newAskHandle.agent.session.id), windowsSessionPolicyIdentity(newAskHandle.agent.session)))
      .toEqual({ enabled: true, approvalPolicy: "ask" });
    for (const agent of [askAgent, autoHandle.agent, disabledHandle.agent, newAskHandle.agent]) {
      expect(agent.session.snapshotEvents().some((event) => event.type.startsWith("deepseek-web/"))).toBe(false);
    }

    autoHandle.agent.session.append("turn/start", { turn: 1 });
    const auto = await runtime.execute({
      command: "Set-Content -LiteralPath './frozen-auto.txt' -Value 'auto'",
      description: "Run frozen automatic session command",
    }, new AbortController().signal, autoHandle.agent);
    expect(auto.isError, resultText(auto)).toBe(false);
    autoHandle.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    disabledHandle.agent.session.append("turn/start", { turn: 1 });
    const disabled = await runtime.execute({
      command: "Set-Content -LiteralPath './frozen-disabled.txt' -Value 'must-not-run'",
      description: "Try frozen disabled session command",
    }, new AbortController().signal, disabledHandle.agent);
    expect(disabled.isError).toBe(true);
    expect(existsSync(join(runtime.workspace, "frozen-disabled.txt"))).toBe(false);
    disabledHandle.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("keeps an imported session disabled even when current defaults are automatic", async () => {
    const sessionId = `t7-imported-${randomUUID()}`;
    const runtime = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      { sessionId, isImportedSessionDenied: (candidate) => candidate === sessionId },
    );
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './imported-must-not-run.txt' -Value denied",
      description: "Imported session must not inherit native command permission",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_COMMANDS_DISABLED);
    expect(existsSync(join(runtime.workspace, "imported-must-not-run.txt"))).toBe(false);
    expect(await runtime.policyStore.get(sessionId, windowsSessionPolicyIdentity(runtime.agent.session))).toBeUndefined();
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("distinguishes a truly new Session from an empty official persistence restore", () => {
    const id = SessionId("t7-empty-restore-boundary");
    const created = Session.create(id);
    const restored = Session.fromRestore(
      id,
      [],
      structuredClone(created.header),
      created.inheritedEventCount,
    );
    expect(created.firstLiveSeq).toBe(0);
    expect(created.eventAt(SessionSeq(0))).toBeUndefined();
    expect(isFreshWindowsPolicySession(created)).toBe(true);
    expect(restored.firstLiveSeq).toBe(0);
    expect(restored.eventAt(SessionSeq(0))?.type).toBe("session/end-seed");
    expect(isFreshWindowsPolicySession(restored)).toBe(false);
  });

  it("keeps a durable empty restored Session disabled when no policy record exists", async () => {
    const owner = await mkdtemp(join(tmpdir(), "dsh-t7-empty-restore-"));
    ownedPaths.push(owner);
    const persistenceRoot = join(owner, "sessions");
    const restoredPolicyPath = join(owner, "restored-policy.json");
    const sessionId = "t7-empty-durable-session";
    const source = await createOfficialPowerShellRuntime({}, {
      persistenceRoot,
      sessionId,
    });
    runtimes.push(source);
    await source.ctx.sessionPersistence.ensureMaterialized(source.agent.session);
    await source.dispose();
    runtimes.splice(runtimes.indexOf(source), 1);

    const restored = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      {
        persistenceRoot,
        resumeSessionId: sessionId,
        policyStorePath: restoredPolicyPath,
      },
    );
    runtimes.push(restored);
    expect(restored.agent.session.firstLiveSeq).toBe(0);
    expect(restored.agent.session.eventAt(SessionSeq(0))?.type).toBe("session/end-seed");
    restored.agent.session.append("turn/start", { turn: 1 });
    const result = await restored.execute({
      command: "Set-Content -LiteralPath './restored-empty.txt' -Value 'must-not-run'",
      description: "Try restored empty session command",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_COMMANDS_DISABLED);
    expect(await restored.policyStore.get(
      sessionId,
      windowsSessionPolicyIdentity(restored.agent.session),
    )).toBeUndefined();
    expect(existsSync(join(restored.workspace, "restored-empty.txt"))).toBe(false);
    restored.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("cold-rebuilds the store and restores policy without writing session events", async () => {
    const storeOwner = await mkdtemp(join(tmpdir(), "dsh-t7-policy-store-"));
    ownedPaths.push(storeOwner);
    const storePath = join(storeOwner, "windows-session-policies.json");
    const sessionId = "t7-cold-restored-session";
    const source = await createOfficialPowerShellRuntime(
      { enabled: true },
      { policyStorePath: storePath, sessionId },
    );
    runtimes.push(source);
    await source.policy.flush();
    const restored = Session.fromRestore(
      source.agent.session.id,
      structuredClone(source.agent.session.snapshotEvents()),
      structuredClone(source.agent.session.header),
      source.agent.session.inheritedEventCount,
    );
    expect(await new JsonWindowsSessionPolicyStore(storePath).get(sessionId, windowsSessionPolicyIdentity(restored)))
      .toEqual({ enabled: true, approvalPolicy: "ask" });
    expect(restored.snapshotEvents().some((event) => event.type.startsWith("deepseek-web/"))).toBe(false);
  });

  it("fails closed when a new session reuses an id owned by a stale policy incarnation", async () => {
    const owner = await mkdtemp(join(tmpdir(), "dsh-t7-stale-policy-"));
    ownedPaths.push(owner);
    const path = join(owner, "windows-session-policies.json");
    const sessionId = "t7-reused-session-id";
    const original = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      { policyStorePath: path, sessionId },
    );
    runtimes.push(original);
    await original.policy.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const replacement = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      { policyStore: new JsonWindowsSessionPolicyStore(path), policyStorePath: path, sessionId },
    );
    runtimes.push(replacement);
    replacement.agent.session.append("turn/start", { turn: 1 });
    const result = await replacement.execute({
      command: "Set-Content -LiteralPath './stale-reuse.txt' -Value 'must-not-run'",
      description: "Try stale policy reuse",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_SESSION_POLICY_UNAVAILABLE);
    expect(existsSync(join(replacement.workspace, "stale-reuse.txt"))).toBe(false);
    replacement.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("samples the committed settings value synchronously when a session is created", async () => {
    let latest: Parameters<typeof createOfficialPowerShellRuntime>[0] = {
      enabled: true,
      approvalPolicy: "auto",
    };
    const runtime = await createOfficialPowerShellRuntime(latest, { readConfig: () => latest });
    runtimes.push(runtime);
    latest = { enabled: false, approvalPolicy: "ask" };
    const createdImmediately = await runtime.createAgent();
    await runtime.policy.flush();
    expect(await runtime.policyStore.get(
      String(createdImmediately.agent.session.id),
      windowsSessionPolicyIdentity(createdImmediately.agent.session),
    )).toEqual({ enabled: false, approvalPolicy: "ask" });
  });

  it("rejects relative and malformed policy-store files", async () => {
    expect(() => new JsonWindowsSessionPolicyStore("relative-policy.json")).toThrow("must be absolute");
    const owner = await mkdtemp(join(tmpdir(), "dsh-t7-malformed-policy-"));
    ownedPaths.push(owner);
    const path = join(owner, "policy.json");
    await writeFile(path, JSON.stringify({ version: 1, sessions: {} }), "utf8");
    await expect(new JsonWindowsSessionPolicyStore(path).get("fixture-session", "0".repeat(64)))
      .rejects.toThrow("exactly {version:2,sessions:{...}}");
  });

  it("keeps imported and legacy seeded sessions disabled when their independent store has no record", async () => {
    const legacy = Session.create(SessionId("t7-legacy-seed"));
    legacy.append("turn/start", { turn: 1 });
    legacy.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const legacyRuntime = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      { seed: legacy.snapshotEvents() },
    );
    runtimes.push(legacyRuntime);
    legacyRuntime.agent.session.append("turn/start", { turn: 2 });
    const result = await legacyRuntime.execute({
      command: "Set-Content -LiteralPath './legacy.txt' -Value 'must-not-run'",
      description: "Try imported legacy session command",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_COMMANDS_DISABLED);
    expect(await legacyRuntime.policyStore.get(
      String(legacyRuntime.agent.session.id),
      windowsSessionPolicyIdentity(legacyRuntime.agent.session),
    )).toBeUndefined();
    expect(existsSync(join(legacyRuntime.workspace, "legacy.txt"))).toBe(false);
    legacyRuntime.agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
  });

  it("fails a new session closed when its durable put fails", async () => {
    const failedStore: WindowsSessionPolicyStore = {
      async get() { return undefined; },
      async putIfAbsent() { throw new Error("fixture durable write failed"); },
      async flush() {},
    };
    const runtime = await createOfficialPowerShellRuntime(
      { enabled: true, approvalPolicy: "auto" },
      { policyStore: failedStore },
    );
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './write-failed.txt' -Value 'must-not-run'",
      description: "Try policy write failure command",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_SESSION_POLICY_UNAVAILABLE);
    expect(existsSync(join(runtime.workspace, "write-failed.txt"))).toBe(false);
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("waits for queued durable writes when flushed", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delayedStore: WindowsSessionPolicyStore = {
      async get() { return undefined; },
      async putIfAbsent(_sessionId, _identity, policy) {
        await blocked;
        return policy;
      },
      async flush() { await blocked; },
    };
    const runtime = await createOfficialPowerShellRuntime(
      { enabled: true },
      { policyStore: delayedStore },
    );
    runtimes.push(runtime);
    let settled = false;
    const flushed = runtime.policy.flush().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await flushed;
    expect(settled).toBe(true);
  });

  it("does not gate or request approval for non-pwsh tools", async () => {
    const runtime = await createOfficialPowerShellRuntime({});
    runtimes.push(runtime);
    runtime.ctx.tools.register(defineContentToolFixture({
      name: "t7_policy_probe",
      description: "Verify unrelated tool policy isolation",
      parameters: {},
      async execute() { return [{ type: "text", text: "UNRELATED_TOOL_OK" }]; },
    }));
    runtime.agent.session.append("turn/start", { turn: 1 });
    let approvals = 0;
    runtime.agent.ctx.on("approval/request", async () => {
      approvals += 1;
      return "rejected" as const;
    });
    const result = await runtime.ctx.tools.execute({
      callId: ToolCallId("t7-unrelated-tool"),
      name: "t7_policy_probe",
      arguments: {},
      agent: runtime.agent,
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain("UNRELATED_TOOL_OK");
    expect(approvals).toBe(0);
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("does not change pwsh admission for an Agent using another model provider", async () => {
    const runtime = await createOfficialPowerShellRuntime({});
    runtimes.push(runtime);
    const other = await runtime.createAgent(undefined, undefined, "deepseek-official");
    other.agent.session.append("turn/start", { turn: 1 });
    let approvals = 0;
    const stop = other.agent.ctx.on("approval/request", async () => {
      approvals += 1;
      return "rejected" as const;
    });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './other-provider.txt' -Value 'sandbox-stack-owned'",
      description: "Run other provider PowerShell command",
    }, new AbortController().signal, other.agent);
    stop();
    expect(result.isError, resultText(result)).toBe(false);
    expect(approvals).toBe(0);
    expect(await readFile(join(runtime.workspace, "other-provider.txt"), "utf8"))
      .toContain("sandbox-stack-owned");
    other.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("keeps disabled commands at zero execution", async () => {
    const runtime = await createOfficialPowerShellRuntime({});
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const target = join(runtime.workspace, "disabled.txt");
    runtime.ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), { prepend: true });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './disabled.txt' -Value 'must-not-run'",
      description: "Try disabled native command",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(WINDOWS_COMMANDS_DISABLED);
    expect(existsSync(target)).toBe(false);
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("asks before every command, rejects without side effects, and grants one execution once", async () => {
    const runtime = await createOfficialPowerShellRuntime({ enabled: true });
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const rejectedTarget = join(runtime.workspace, "rejected.txt");
    let release!: (outcome: "rejected") => void;
    let markAsked!: () => void;
    const pending = new Promise<"rejected">((resolve) => { release = resolve; });
    const asked = new Promise<void>((resolve) => { markAsked = resolve; });
    const stopPending = runtime.agent.ctx.on("approval/request", async () => {
      markAsked();
      return pending;
    });
    const rejected = runtime.execute({
      command: "Set-Content -LiteralPath './rejected.txt' -Value 'must-not-run'",
      description: "Try rejected native command",
    });
    await asked;
    expect(existsSync(rejectedTarget)).toBe(false);
    release("rejected");
    const rejectedResult = await rejected;
    stopPending();
    expect(rejectedResult.isError).toBe(true);
    expect(existsSync(rejectedTarget)).toBe(false);

    let approvals = 0;
    const stopAllow = runtime.agent.ctx.on("approval/request", async () => {
      approvals += 1;
      return "allowed-once" as const;
    });
    const allowed = await runtime.execute({
      command: "Add-Content -LiteralPath './allowed.txt' -Value 'ran-once'",
      description: "Run approved native command",
    });
    stopAllow();
    expect(allowed.isError, resultText(allowed)).toBe(false);
    expect(approvals).toBe(1);
    expect((await readFile(join(runtime.workspace, "allowed.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(["ran-once"]);
    const events = runtime.agent.session.snapshotEvents();
    expect(events.filter((event) => event.type === "approval/asked")).toHaveLength(2);
    expect(events.filter((event) => event.type === "approval/decided")
      .map((event) => event.data.outcome)).toEqual(["rejected", "allowed-once"]);
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("allows automatic foreground execution only after explicit opt-in", async () => {
    const runtime = await createOfficialPowerShellRuntime({ enabled: true, approvalPolicy: "auto" });
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    let approvals = 0;
    const stop = runtime.agent.ctx.on("approval/request", async () => {
      approvals += 1;
      return "rejected" as const;
    });
    const result = await runtime.execute({
      command: "Set-Content -LiteralPath './auto.txt' -Value 'explicit-auto'",
      description: "Run explicit automatic command",
    });
    stop();
    expect(result.isError, resultText(result)).toBe(false);
    expect(approvals).toBe(0);
    expect(await readFile(join(runtime.workspace, "auto.txt"), "utf8")).toContain("explicit-auto");
    expect(runtime.ctx.tools.schemas()[0]?.parameters.properties).not.toHaveProperty("run_in_background");
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("keeps official nonzero and bounded-output result semantics", async () => {
    const runtime = await createOfficialPowerShellRuntime({ enabled: true, approvalPolicy: "auto" });
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const result = await runtime.execute({
      command: "[Console]::Out.Write(('界' * 5000)); exit 7",
      description: "Exercise bounded native command output",
    });
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({
      kind: "foreground",
      exitCode: 7,
      timedOut: false,
      aborted: false,
      stdout: { truncated: true },
    });
    expect(resultText(result)).toContain("[exit code: 7]");
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  });

  it("preserves official timeout/cancel limits and joins descendant process trees", async () => {
    const runtime = await createOfficialPowerShellRuntime({ enabled: true, approvalPolicy: "auto" });
    runtimes.push(runtime);
    runtime.agent.session.append("turn/start", { turn: 1 });
    const timeout = await runtime.execute({
      command: "$c = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20' -PassThru; Set-Content -LiteralPath './timeout-child.pid' -Value $c.Id; Wait-Process -Id $c.Id",
      description: "Timeout owned descendant process tree",
      timeoutMs: 800,
    });
    expect(timeout.value).toMatchObject({ kind: "foreground", timedOut: true, aborted: false });
    const timeoutPid = Number((await readFile(join(runtime.workspace, "timeout-child.pid"), "utf8")).trim());
    expect(() => process.kill(timeoutPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

    const abort = new AbortController();
    const cancelled = runtime.execute({
      command: "$c = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20' -PassThru; Set-Content -LiteralPath './cancel-child.pid' -Value $c.Id; Wait-Process -Id $c.Id",
      description: "Cancel owned descendant process tree",
    }, abort.signal);
    const cancelPidFile = join(runtime.workspace, "cancel-child.pid");
    await waitForFile(cancelPidFile);
    const cancelPid = Number((await readFile(cancelPidFile, "utf8")).trim());
    abort.abort();
    const cancelledResult = await cancelled;
    expect(cancelledResult.isError).toBe(true);
    expect(() => process.kill(cancelPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    runtime.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  }, 20_000);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("T7_POWERSHELL_CHILD_PID_NOT_WRITTEN");
}
