import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const EXPECTED_NODE_MAJOR = 24;
const PROBE_DEADLINE_MS = 45_000;
const COMMAND_TIMEOUT_MS = 5_000;
const OUTSIDE_ORIGINAL = "outside fixture must remain unchanged\n";

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireFact(condition, code) {
  if (!condition) throw new ProbeError(code);
}

function errorCode(error, fallback = "LINUX_SANDBOX_PROBE_FAILED") {
  const code = error?.info?.code ?? error?.code;
  if (/^Cannot find (?:the )?native Koffi module/i.test(error?.message ?? "")) return "LINUX_SANDBOX_NATIVE_DEPENDENCY_MISSING";
  // Codes only; never print raw exception messages, paths, env or command text.
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

async function probe() {
  let stage = "platform";
  let root;
  let ctx;
  let restoreSpawn;
  let activeExecution;
  let failure;
  let cleanupFailure;
  let backend;
  let enforcement;
  let interop = { attempted: false, blocks_product_wiring: false };
  const completed = [];
  const handles = [];
  const overall = new AbortController();
  const cancel = new AbortController();
  const deadline = setTimeout(() => overall.abort(), PROBE_DEADLINE_MS);
  deadline.unref();
  try {
    requireFact(process.platform === "linux", "LINUX_SANDBOX_REQUIRES_LINUX");
    requireFact(Number(process.versions.node.split(".")[0]) === EXPECTED_NODE_MAJOR, "LINUX_SANDBOX_REQUIRES_NODE_24");
    requireFact(process.argv.length === 2, "LINUX_SANDBOX_PROBE_ARGUMENTS_INVALID");

    stage = "official_imports";
    const [cordis, sandboxModule, policyModule, subprocessModule, bashModule, toolsModule,
      bashTools, shellEnvModule, promptModule, projectionModule] = await Promise.all([
      import("@deepseek-ai/cordis"),
      import("@deepseek-ai/dsh-sandbox-local"),
      import("@deepseek-ai/dsh-sandbox-policy"),
      import("@deepseek-ai/dsh-subprocess-local"),
      import("@deepseek-ai/dsh-bash-sandbox"),
      import("@deepseek-ai/dsh-tools"),
      import("@deepseek-ai/dsh-tool-bash"),
      import("@deepseek-ai/dsh-shell-env"),
      import("@deepseek-ai/dsh-system-prompt"),
      import("@deepseek-ai/dsh-session-projection"),
    ]);

    stage = "owned_fixture";
    // /tmp is deliberately not used: official bwrap hides it with a private
    // mount, and Landlock grants it write access. A new, uniquely owned home
    // subdirectory keeps the sibling file visible and outside both allowlists.
    root = await mkdtemp(join(homedir(), ".dsh-linux-sandbox-probe-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([workspace, outside].map((path) => mkdir(path)));
    await writeFile(join(outside, "outside.txt"), OUTSIDE_ORIGINAL, { encoding: "utf8", flag: "wx" });

    stage = "official_composition";
    ctx = new cordis.Context();
    await ctx.plugin(promptModule.SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(projectionModule.SessionProjectionRegistry);
    await ctx.plugin(policyModule.SandboxPolicyService, { mode: "workspace-write", workspaceRoot: workspace });
    // No runnerCommand, fake platform, fake probe or unconfined fallback.
    await ctx.plugin(sandboxModule.LocalSandboxProvider, { probeTimeoutMs: 3_000 });
    await ctx.plugin(subprocessModule.LocalSubprocessRuntime);
    await ctx.plugin(bashModule.SandboxBashExecutor, {
      cwd: workspace, timeoutMs: COMMAND_TIMEOUT_MS, maxTimeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: 8_192, maxSpillBytes: 16_384, graceMs: 100,
    });
    await ctx.plugin(shellEnvModule.ShellEnvRegistry, { dshHome: join(root, "dsh-home") });
    await ctx.plugin(toolsModule.ToolRuntime, { mode: "native" });
    await ctx.plugin(bashTools, { enableRunInBackground: false });
    requireFact(ctx.tools.schemas().length === 1 && ctx.tools.schemas()[0].name === "bash", "LINUX_SANDBOX_TOOL_CATALOG_INVALID");

    // Observe the official service's returned host-side handles while delegating
    // every spawn verbatim. A bash $$ is NOT a host PID under bwrap's private
    // PID namespace; the official public handle is the correct cleanup source.
    const subprocess = ctx.subprocess;
    const originalSpawn = subprocess.spawn;
    subprocess.spawn = function observedSpawn(spec) {
      const handle = Reflect.apply(originalSpawn, subprocess, [spec]);
      handles.push(handle);
      const selected = basename(String(spec.argv[0]));
      if (backend === undefined) backend = selected;
      else requireFact(backend === selected, "LINUX_SANDBOX_RUNNER_CHANGED");
      return handle;
    };
    restoreSpawn = () => { subprocess.spawn = originalSpawn; };

    let nextCall = 0;
    async function execute(command, timeoutMs = COMMAND_TIMEOUT_MS, signal = overall.signal) {
      const before = handles.length;
      activeExecution = ctx.tools.execute({
        callId: `linux-sandbox-probe-${++nextCall}`, name: "bash",
        arguments: { command, description: "Run a fixed owned Linux sandbox fixture", timeoutMs },
        signal,
      });
      const result = await activeExecution;
      activeExecution = undefined;
      requireFact(handles.length === before + 1 || result.isError, "LINUX_SANDBOX_EXPECTED_ONE_OFFICIAL_SPAWN");
      return result;
    }

    function requireConfinedResult(result) {
      if (result.isError) throw new ProbeError(errorCode(result.error, "LINUX_SANDBOX_TOOL_FAILED"));
      const value = result.value;
      requireFact(value?.kind === "foreground" && value.sandbox?.mode === "workspace-write", "LINUX_SANDBOX_EXECUTOR_NOT_CONFINED");
      enforcement ??= value.sandbox.enforcement;
      requireFact(value.sandbox.enforcement === enforcement, "LINUX_SANDBOX_ENFORCEMENT_CHANGED");
      // Report partial rather than promote it to the stronger Linux gate.
      requireFact(enforcement === "full", "LINUX_SANDBOX_PARTIAL_ENFORCEMENT");
      return value;
    }

    stage = "harmless_command";
    const normal = requireConfinedResult(await execute("printf 'DSH_LINUX_SANDBOX_OK\\n'"));
    requireFact(normal.exitCode === 0 && normal.stdout.text === "DSH_LINUX_SANDBOX_OK\n" && !normal.sandbox.denied,
      "LINUX_SANDBOX_COMMAND_FAILED");
    await assertQuiescent(handles.at(-1));
    completed.push("harmless_command");

    stage = "wsl_windows_interop";
    const windowsCommand = "/mnt/c/Windows/System32/cmd.exe";
    const isWsl = /microsoft|wsl/i.test(await readFile("/proc/sys/kernel/osrelease", "utf8"));
    if (isWsl && existsSync(windowsCommand)) {
      // Fixed echo only: no Windows file write, installation, configuration or
      // elevation. Linux filesystem enforcement says nothing about interop.
      const interopResult = await execute(`${windowsCommand} /d /c echo DSH_WSL_INTEROP_PROBE`);
      const succeeded = interopResult.isError !== true && interopResult.value?.exitCode === 0 &&
        interopResult.value?.stdout?.text?.split(/\r?\n/).some((line) => line.trim() === "DSH_WSL_INTEROP_PROBE") === true;
      interop = {
        attempted: true, succeeded, blocks_product_wiring: succeeded,
        ...(Number.isInteger(interopResult.value?.exitCode) ? { exit_code: interopResult.value.exitCode } : {}),
        ...(interopResult.isError === true ? { error: errorCode(interopResult.error, "LINUX_SANDBOX_TOOL_FAILED") } : {}),
      };
      await assertQuiescent(handles.at(-1));
      completed.push(succeeded ? "windows_interop_available" : "windows_interop_did_not_succeed");
    }

    stage = "workspace_write";
    const write = requireConfinedResult(await execute("printf 'owned workspace write\\n' > created.txt; cat created.txt"));
    requireFact(write.exitCode === 0 && !write.sandbox.denied, "LINUX_SANDBOX_WORKSPACE_WRITE_FAILED");
    requireFact(await readFile(join(workspace, "created.txt"), "utf8") === "owned workspace write\n", "LINUX_SANDBOX_WORKSPACE_EVIDENCE_INVALID");
    await assertQuiescent(handles.at(-1));
    completed.push("workspace_write");

    stage = "outside_write_denial";
    const denied = requireConfinedResult(await execute("printf 'must not replace\\n' > ../outside/outside.txt"));
    requireFact(await readFile(join(outside, "outside.txt"), "utf8") === OUTSIDE_ORIGINAL, "LINUX_SANDBOX_OUTSIDE_FILE_CHANGED");
    requireFact(denied.exitCode !== 0 && denied.sandbox.denied === true, "LINUX_SANDBOX_OUTSIDE_WRITE_NOT_DENIED");
    await assertQuiescent(handles.at(-1));
    completed.push("outside_write_denied");

    stage = "timeout_cleanup";
    const timeout = requireConfinedResult(await execute("printf 'started\\n' > timeout-started.txt; sleep 20", 1_500));
    requireFact(timeout.timedOut === true && timeout.aborted === false, "LINUX_SANDBOX_TIMEOUT_NOT_OBSERVED");
    requireFact(await readFile(join(workspace, "timeout-started.txt"), "utf8") === "started\n", "LINUX_SANDBOX_TIMEOUT_COMMAND_NOT_STARTED");
    await assertQuiescent(handles.at(-1));
    completed.push("timeout_tree_exited");

    stage = "cancel_cleanup";
    const cancelled = execute("printf 'started\\n' > cancel-started.txt; sleep 20", COMMAND_TIMEOUT_MS,
      AbortSignal.any([overall.signal, cancel.signal]));
    await Promise.race([
      waitForStartedFile(join(workspace, "cancel-started.txt"), overall.signal),
      cancelled.then((result) => {
        throw new ProbeError(result.isError ? errorCode(result.error, "LINUX_SANDBOX_TOOL_FAILED") : "LINUX_SANDBOX_CANCEL_COMMAND_EXITED_EARLY");
      }),
    ]);
    cancel.abort();
    const cancellation = await cancelled;
    requireFact(cancellation.isError === true && errorCode(cancellation.error) === "TOOL_ABORTED", "LINUX_SANDBOX_CANCEL_NOT_OBSERVED");
    await assertQuiescent(handles.at(-1));
    completed.push("cancel_tree_exited");
    stage = "complete";
  } catch (error) {
    failure = { error: errorCode(error), stage };
  } finally {
    clearTimeout(deadline);
    overall.abort();
    cancel.abort();
    try {
      if (activeExecution !== undefined) await activeExecution;
    } catch (error) {
      cleanupFailure = errorCode(error, "LINUX_SANDBOX_PROCESS_CLEANUP_FAILED");
    }
    try {
      try { restoreSpawn?.(); } finally { if (ctx !== undefined) await ctx.fiber.dispose(); }
      for (const handle of handles) await assertQuiescent(handle);
    } catch (error) {
      cleanupFailure ??= errorCode(error, "LINUX_SANDBOX_PROCESS_CLEANUP_FAILED");
    } finally {
      if (root !== undefined) {
        try {
          // This exact path came from mkdtemp above, never a broad home/tmp root.
          await rm(root, { recursive: true, force: true });
          requireFact(!existsSync(root), "LINUX_SANDBOX_FIXTURE_CLEANUP_FAILED");
        } catch (error) {
          cleanupFailure ??= errorCode(error, "LINUX_SANDBOX_FIXTURE_CLEANUP_FAILED");
        }
      }
    }
  }
  const summary = {
    schema_version: 1, ok: failure === undefined && cleanupFailure === undefined,
    node: process.versions.node, platform: process.platform,
    ...(backend === undefined ? {} : { backend }),
    ...(enforcement === undefined ? {} : { enforcement }),
    scope: "filesystem-write-confinement", read_confinement: false, network_confinement: false,
    checks: completed, managed_processes: handles.length,
    cleanup: cleanupFailure === undefined,
    ...(failure ?? {}),
    ...(cleanupFailure === undefined ? {} : { cleanup_error: cleanupFailure }),
    product_acceptance: false,
    wsl_interop: interop,
  };
  if (interop.blocks_product_wiring && failure === undefined) {
    summary.ok = false;
    summary.error = "WSL_WINDOWS_INTEROP_NOT_CONFINED";
    summary.stage = "wsl_windows_interop";
  }
  if (!summary.ok) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function assertQuiescent(handle) {
  requireFact(handle !== undefined && Number.isSafeInteger(handle.pid) && handle.pid > 0, "LINUX_SANDBOX_PROCESS_HANDLE_INVALID");
  await handle.done;
  requireFact(await handle.waitForExit(AbortSignal.timeout(2_000)), "LINUX_SANDBOX_PROCESS_TREE_STILL_ALIVE");
  try {
    process.kill(handle.pid, 0); // observation only; termination remains official
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  throw new ProbeError("LINUX_SANDBOX_PROCESS_PID_STILL_ALIVE");
}

async function waitForStartedFile(path, signal) {
  const until = Date.now() + 3_000;
  while (Date.now() < until && !signal.aborted) {
    if (existsSync(path) && await readFile(path, "utf8") === "started\n") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new ProbeError("LINUX_SANDBOX_CANCEL_COMMAND_NOT_STARTED");
}

await probe();
