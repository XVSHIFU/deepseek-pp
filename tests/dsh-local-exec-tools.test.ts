import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOfficialPwshFixture, executePwsh, resultText } from "./fixtures/dsh-web-agent/exec/official-pwsh-fixture.ts";

describe.skipIf(process.platform !== "win32")("official Windows PowerShell sandbox composition", () => {
  it("runs a harmless fixed command through the official registry and ACL restricted token", async () => {
    const fixture = await createOfficialPwshFixture("read-only");
    try {
      expect(fixture.ctx.tools.schemas().map((tool) => tool.name)).toEqual(["pwsh"]);
      expect(fixture.ctx.shell.sandboxMode).toBe("read-only");
      expect(Object.keys(fixture.ctx.tools.get("pwsh")!.parameters.properties ?? {}).sort()).toEqual([
        "command", "description", "justification", "sandbox_permissions", "timeoutMs", "workdir",
      ]);
      const result = await executePwsh(fixture.ctx, {
        command: "Write-Output 'DSH_EXEC_FIXTURE_OK'",
        description: "Print a fixed harmless fixture marker",
      });
      expect(result.isError, resultText(result)).toBe(false);
      expect(resultText(result)).toContain("DSH_EXEC_FIXTURE_OK");
      expect(result.value).toMatchObject({
        kind: "foreground", exitCode: 0, timedOut: false, aborted: false,
        sandbox: { mode: "read-only", denied: false, enforcement: "partial" },
      });
    } finally {
      await fixture.dispose();
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);

  it("permits a fixed write inside the owned workspace and removes private runner temp directories", async () => {
    const fixture = await createOfficialPwshFixture();
    try {
      const write = await executePwsh(fixture.ctx, {
        command: "Set-Content -LiteralPath './created.txt' -Value 'DSH_WRITE_FIXTURE_OK'; Get-Content -LiteralPath './created.txt'",
        description: "Write and read an owned fixture file",
      });
      expect(write.isError, resultText(write)).toBe(false);
      expect(write.value).toMatchObject({ kind: "foreground", exitCode: 0,
        sandbox: { mode: "workspace-write", denied: false, enforcement: "partial" } });
      expect(await readFile(join(fixture.workspace, "created.txt"), "utf8")).toContain("DSH_WRITE_FIXTURE_OK");
      // The official grant lock cache stands until our enclosing fixture is
      // removed; no per-command private write-capability directory may remain.
      expect(await readdir(fixture.privateTempRoot)).toEqual(["dsh-acl-locks"]);
    } finally {
      await fixture.dispose();
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);

  // This is an upstream/current-host gap observation, not an accepted product
  // contract or a passing T4.5 containment gate. Do not mount it in production.
  it("T4.5 current-gap: partial ACL enforcement allows the tested sibling fixture write", async () => {
    const fixture = await createOfficialPwshFixture();
    try {
      const outside = await executePwsh(fixture.ctx, {
        command: "$ErrorActionPreference = 'Stop'; Set-Content -LiteralPath '../outside/outside.txt' -Value 'must not replace'",
        description: "Probe the known sibling fixture boundary gap",
      });
      expect(outside.value).toMatchObject({ exitCode: 0,
        sandbox: { mode: "workspace-write", denied: false, enforcement: "partial" } });
      expect((await readFile(join(fixture.outside, "outside.txt"), "utf8")).trim()).toBe("must not replace");
      expect(await readdir(fixture.privateTempRoot)).toEqual(["dsh-acl-locks"]);
    } finally {
      await fixture.dispose();
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);

  it("fails closed on an unapproved wider-mode request through the official ask service", async () => {
    const fixture = await createOfficialPwshFixture("read-only");
    let handle: Awaited<ReturnType<typeof fixture.createIdleAgent>> | undefined;
    try {
      handle = await fixture.createIdleAgent();
      handle.agent.session.append("turn/start", { turn: 1 });
      const result = await executePwsh(fixture.ctx, {
        command: "Set-Content -LiteralPath './unapproved.txt' -Value 'must not create'",
        description: "Attempt an unapproved fixture write escalation",
        sandbox_permissions: "workspace-write",
        justification: "Test the unavailable approval channel without executing the command.",
      }, new AbortController().signal, handle.agent);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("no approval channel is available");
      expect(existsSync(join(fixture.workspace, "unapproved.txt"))).toBe(false);
      const events = handle.agent.session.snapshotEvents();
      expect(events.filter((event) => event.type === "approval/asked")).toHaveLength(1);
      expect(events.filter((event) => event.type === "approval/decided")).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ outcome: "unavailable" }) }),
      ]);
      handle.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    } finally {
      try { await handle?.dispose(); } finally { await fixture.dispose(); }
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);

  it("times out an actual confined PowerShell process and joins the owned process tree", async () => {
    const fixture = await createOfficialPwshFixture();
    try {
      const result = await executePwsh(fixture.ctx, {
        command: "Set-Content -LiteralPath './timeout-pid.txt' -Value $PID; Start-Sleep -Seconds 20",
        description: "Timeout a fixed confined sleeping fixture process",
        timeoutMs: 2_500,
      });
      expect(result.value).toMatchObject({ timedOut: true, aborted: false,
        sandbox: { mode: "workspace-write", enforcement: "partial" } });
      const pid = Number((await readFile(join(fixture.workspace, "timeout-pid.txt"), "utf8")).trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      await fixture.dispose();
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);

  it("cancels an actual confined command and settles only after its process exits", async () => {
    const fixture = await createOfficialPwshFixture();
    const abort = new AbortController();
    let execution: ReturnType<typeof executePwsh> | undefined;
    try {
      execution = executePwsh(fixture.ctx, {
        command: "Set-Content -LiteralPath './cancel-pid.txt' -Value $PID; Start-Sleep -Seconds 20",
        description: "Cancel a fixed confined sleeping fixture process",
      }, abort.signal);
      const pidFile = join(fixture.workspace, "cancel-pid.txt");
      await waitForOwnedFile(pidFile);
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      abort.abort();
      const result = await execution;
      expect(result.isError).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      abort.abort();
      try { await execution; } finally { await fixture.dispose(); }
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 20_000);
});

async function waitForOwnedFile(path: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("OFFICIAL_CONFINED_PROCESS_DID_NOT_CREATE_FIXTURE_PID");
}
