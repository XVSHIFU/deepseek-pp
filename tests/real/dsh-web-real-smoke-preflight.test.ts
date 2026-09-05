import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { encodeSeqRanges, packChunkRuns, SessionSeq } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";

interface SmokeModule {
  findModelCredentialEnvironment(env: NodeJS.ProcessEnv): string[];
  main(args: readonly string[], options?: {
    stdout?: { write(value: string): unknown };
    stderr?: { write(value: string): unknown };
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    nodeVersion?: string;
    dependencies?: Record<string, unknown>;
  }): Promise<number>;
  runCommand(spec: CommandSpec, injected?: {
    terminateOwnedProcessTree?: (...args: unknown[]) => Promise<void>;
    directKill?: (...args: unknown[]) => void;
    cleanupDeadlineMs?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  runRealWebSmoke(options: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    nodeVersion?: string;
  }, dependencies?: Record<string, unknown>): Promise<Record<string, unknown>>;
  validateProfileDump(text: string): void;
}

// The executable remains plain .mjs so users can run it directly with Node.
// @ts-expect-error -- TypeScript does not synthesize declarations for that CLI module.
const smokeModule = await import("../../scripts/dsh-web-real-smoke.mjs") as SmokeModule;
const {
  findModelCredentialEnvironment,
  main,
  runCommand,
  runRealWebSmoke,
  validateProfileDump,
} = smokeModule;

const CONFIRM = ["--confirm-real-web"];
const PROFILE = "deepseek-web-agent";
const BUNDLE = "@deepseek-pp/dsh-web-agent-bundle";
const PROFILE_DUMP = await readFile(resolve(
  process.cwd(),
  "tests",
  "real",
  "fixtures",
  "dsh-web-real-smoke",
  "profile-dump.yml",
), "utf8");
const BARRIER = await readFile(resolve(
  process.cwd(),
  "tests",
  "real",
  "fixtures",
  "dsh-web-real-smoke",
  "browser-ready-barrier.mjs",
), "utf8");
const HANGING_CHILD = resolve(
  process.cwd(),
  "tests",
  "real",
  "fixtures",
  "dsh-web-real-smoke",
  "hanging-child.mjs",
);
const TOKEN = "A".repeat(43);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CORRELATION = "00112233445566778899aabbccddeeff";
const FINAL_TEXT = `DSH_WEB_OK:web-smoke-${CORRELATION}`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real DeepSeek Web smoke offline preflight", () => {
  it("refuses a default invocation before reading a profile or starting DSH", async () => {
    const effects = inertEffects();
    const output = captureOutput();

    await expect(main([], {
      ...output.options,
      cwd: process.cwd(),
      env: {},
      nodeVersion: "24.18.0",
      dependencies: effects.dependencies,
    })).resolves.toBe(2);

    expect(effects.readText).not.toHaveBeenCalled();
    expect(effects.runCommand).not.toHaveBeenCalled();
    expect(output.stdout()).toBe("");
    expect(JSON.parse(output.stderr())).toEqual({
      schema_version: 1,
      ok: false,
      status: "failed",
      error: "REAL_WEB_CONFIRMATION_REQUIRED",
      usage: "node scripts/dsh-web-real-smoke.mjs --confirm-real-web",
    });
  });

  it("rejects model credentials and missing browser attestation before any DSH process", async () => {
    const effects = inertEffects();
    const home = resolve("C:/isolated-dsh-home");
    const base = validEnvironment(home);

    await expect(runRealWebSmoke({
      args: CONFIRM,
      cwd: process.cwd(),
      env: { ...base, OPENAI_API_KEY: "must-not-leak" },
      nodeVersion: "24.18.0",
    }, effects.dependencies)).rejects.toMatchObject({ code: "REAL_WEB_MODEL_CREDENTIAL_PRESENT" });

    await expect(runRealWebSmoke({
      args: CONFIRM,
      cwd: process.cwd(),
      env: { ...base, DSH_WEB_REAL_BROWSER_ATTESTATION: undefined },
      nodeVersion: "24.18.0",
    }, effects.dependencies)).rejects.toMatchObject({ code: "REAL_WEB_BROWSER_ATTESTATION_REQUIRED" });

    expect(effects.readText).not.toHaveBeenCalled();
    expect(effects.runCommand).not.toHaveBeenCalled();
    expect(findModelCredentialEnvironment({
      DSH_WEB_PAIRING_TOKEN: TOKEN,
      DSH_WEB_API_KEY: "secret-c",
      DEEPSEEK_API_KEY: "secret-a",
      openrouter_api_key: "secret-b",
      GITHUB_TOKEN: "not-a-model-route",
    })).toEqual(["DEEPSEEK_API_KEY", "DSH_WEB_API_KEY", "openrouter_api_key"]);
    expect(findModelCredentialEnvironment({
      ACME_GATEWAY_API_KEY: "custom",
      AWS_ACCESS_KEY_ID: "aws-a",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-token",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "C:/container-token",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/credentials",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials",
      AWS_CONFIG_FILE: "C:/aws-config",
      AWS_SECRET_ACCESS_KEY: "aws-b",
      AWS_SESSION_TOKEN: "aws-c",
      AWS_SHARED_CREDENTIALS_FILE: "C:/aws-credentials",
      AWS_WEB_IDENTITY_TOKEN_FILE: "C:/web-identity-token",
      DASHSCOPE_API_KEY: "dashscope",
      FIREWORKS_API_KEY: "fireworks",
      GOOGLE_APPLICATION_CREDENTIALS: "C:/credentials.json",
      MOONSHOT_API_KEY: "moonshot",
      TOGETHER_API_KEY: "together",
      XAI_API_KEY: "xai",
    })).toHaveLength(18);
  });

  it("rejects a non-Node-24 runtime or invalid Broker inputs before touching the profile", async () => {
    const effects = inertEffects();
    const base = validEnvironment(resolve("C:/isolated-dsh-home"));
    await expect(runRealWebSmoke({
      args: CONFIRM,
      cwd: process.cwd(),
      env: base,
      nodeVersion: "22.22.0",
    }, effects.dependencies)).rejects.toMatchObject({ code: "REAL_WEB_NODE_VERSION_MISMATCH" });
    await expect(runRealWebSmoke({
      args: CONFIRM,
      cwd: process.cwd(),
      env: { ...base, DSH_WEB_PAIRING_TOKEN: "short" },
      nodeVersion: "24.18.0",
    }, effects.dependencies)).rejects.toMatchObject({ code: "REAL_WEB_BROKER_CONFIG_INVALID" });
    expect(effects.readText).not.toHaveBeenCalled();
    expect(effects.runCommand).not.toHaveBeenCalled();
  });

  it("rejects model credentials discovered in the DSH layered .env files", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.cwd, ".env"), "OPENAI_API_KEY=must-not-leak\n", "utf8");
    await expect(runWith(fixture)).rejects.toMatchObject({ code: "REAL_WEB_MODEL_CREDENTIAL_PRESENT" });
    expect(fixture.runCommand).not.toHaveBeenCalled();
  });

  it("fails loudly for an absent/invalid profile, wrong Harness version, or non-web provider", async () => {
    const missing = await makeFixture();
    missing.readText.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(runWith(missing)).rejects.toMatchObject({ code: "REAL_WEB_PROFILE_NOT_INSTALLED" });

    const invalidProfile = await makeFixture({ manifest: { ...profileManifest(), dependencies: {} } });
    await expect(runWith(invalidProfile)).rejects.toMatchObject({ code: "REAL_WEB_PROFILE_INVALID" });

    const versionMismatch = await makeFixture({ version: "0.1.3\n" });
    await expect(runWith(versionMismatch)).rejects.toMatchObject({ code: "REAL_WEB_HARNESS_VERSION_MISMATCH" });

    const providerMismatch = await makeFixture({
      dump: PROFILE_DUMP.replace("provider: deepseek-web", "provider: deepseek"),
    });
    await expect(runWith(providerMismatch)).rejects.toMatchObject({ code: "REAL_WEB_PROVIDER_INVALID" });

    expect(() => validateProfileDump(`${PROFILE_DUMP}\n- name: '@deepseek-ai/dsh-llm-pi-ai'\n`))
      .toThrowError(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
    expect(() => validateProfileDump(PROFILE_DUMP.replace(
      "    mode: native",
      "    mode: native\n    headers:\n      Authorization: Bearer secret",
    ))).toThrowError(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
    expect(() => validateProfileDump(PROFILE_DUMP.replace(
      "  name: '@deepseek-pp/dsh-llm-deepseek-web'",
      "  name: '@deepseek-ai/dsh-llm-deepseek'",
    ))).toThrowError(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
    expect(() => validateProfileDump(PROFILE_DUMP.replace(
      "pairingToken: !!js process.env.DSH_WEB_PAIRING_TOKEN",
      "pairingToken: !!js process.env.DSH_WEB_PAIRING_TOKEN || process.env.DEEPSEEK_API_KEY",
    ))).toThrowError(expect.objectContaining({ code: "REAL_WEB_PROVIDER_INVALID" }));
    expect(() => validateProfileDump("- id: [unterminated"))
      .toThrowError(expect.objectContaining({ code: "REAL_WEB_PROFILE_INVALID" }));
  });

  it("classifies a missing authenticated browser as a real failure, never a skip", async () => {
    const fixture = await makeFixture({
      actual: { exitCode: 1, stdout: "\n", stderr: "dsh: WAITING_FOR_BROWSER: unavailable\n" },
      writeEvidence: false,
    });
    const output = captureOutput();

    await expect(main(CONFIRM, {
      ...output.options,
      cwd: fixture.cwd,
      env: fixture.env,
      nodeVersion: "24.18.0",
      dependencies: fixture.dependencies,
    })).resolves.toBe(1);

    expect(JSON.parse(output.stderr())).toEqual({
      schema_version: 1,
      ok: false,
      status: "failed",
      error: "REAL_WEB_BROWSER_NOT_READY",
    });
    expect(output.stderr()).not.toMatch(/skip/i);
    expect(BARRIER).toContain("hasAuthenticatedPeer");
    expect(BARRIER).not.toMatch(/WebSocket|fetch\(|playwright|cookie|authorization|cdp/i);
  });

  it("reports an allowlisted durable failure code without exposing DSH or session details", async () => {
    const privateFailure = [
      "The DeepSeek Web browser broker rejected the request contract.",
      TOKEN,
      ORIGIN,
      "cookie=private authorization=private C:/private/home",
    ].join(" ");
    const fixture = await makeFixture({
      actual: { exitCode: 1, stdout: "", stderr: privateFailure },
      failureSession: { code: "WEB_MODEL_PROTOCOL", message: privateFailure },
    });
    const output = captureOutput();

    await expect(main(CONFIRM, {
      ...output.options,
      cwd: fixture.cwd,
      env: fixture.env,
      nodeVersion: "24.18.0",
      dependencies: fixture.dependencies,
    })).resolves.toBe(1);

    expect(JSON.parse(output.stderr())).toEqual({
      schema_version: 1,
      ok: false,
      status: "failed",
      error: "REAL_WEB_DSH_FAILED",
      cause_code: "WEB_MODEL_PROTOCOL",
    });
    expect(output.stderr()).not.toContain(privateFailure);
    expect(output.stderr()).not.toContain(TOKEN);
    expect(output.stderr()).not.toContain(ORIGIN);
    expect(output.stderr()).not.toContain(fixture.cwd);
  });

  it("keeps the generic failure when the durable cause is unknown or belongs to another task", async () => {
    for (const failureSession of [
      { code: "WEB_MODEL_PROTOCOL\",\"leak\":\"private", message: "private" },
      { code: "WEB_MODEL_PROTOCOL", message: "private", association: "wrong-task" as const },
      { code: "WEB_MODEL_PROTOCOL", message: "private", association: "wrong-cwd" as const },
    ]) {
      const fixture = await makeFixture({
        actual: { exitCode: 1, stdout: "", stderr: "private stderr" },
        failureSession,
      });
      const output = captureOutput();
      await expect(main(CONFIRM, {
        ...output.options,
        cwd: fixture.cwd,
        env: fixture.env,
        nodeVersion: "24.18.0",
        dependencies: fixture.dependencies,
      })).resolves.toBe(1);
      expect(JSON.parse(output.stderr())).toEqual({
        schema_version: 1,
        ok: false,
        status: "failed",
        error: "REAL_WEB_DSH_FAILED",
      });
      expect(output.stderr()).not.toContain("private");
    }
  });

  it("uses fixed shell-free DSH commands and emits only redacted success evidence", async () => {
    const fixture = await makeFixture();
    const output = captureOutput();
    const exitCode = await main(CONFIRM, {
      ...output.options,
      cwd: fixture.cwd,
      env: fixture.env,
      nodeVersion: "24.18.0",
      dependencies: fixture.dependencies,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const evidence = JSON.parse(output.stdout()) as Record<string, unknown>;
    expect(evidence).toEqual({
      schema_version: 1,
      ok: true,
      status: "completed",
      provider: "deepseek-web",
      model: "current-web-session",
      request_correlation: `web-smoke-${CORRELATION}`,
      session_id: "session-real-smoke",
      final_text_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      final_text_bytes: Buffer.byteLength(FINAL_TEXT, "utf8"),
    });

    expect(fixture.commands).toHaveLength(3);
    for (const command of fixture.commands) {
      expect(command).toMatchObject({ executable: process.execPath, shell: false, windowsHide: true });
      expect(command.args[0]).toMatch(/[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
      expect(command.args).not.toContain(TOKEN);
      expect(command.args).not.toContain(ORIGIN);
    }
    expect(fixture.commands[0]?.args.slice(1)).toEqual(["--version"]);
    expect(fixture.commands[1]?.args.slice(1)).toEqual(["--profile", PROFILE, "--dump-config"]);
    expect(fixture.commands[2]?.args.slice(1, 5)).toEqual([
      "--profile",
      PROFILE,
      "--patch",
      expect.stringMatching(/browser-ready-barrier\.patch\.yml$/),
    ]);
    const serialized = `${output.stdout()}${output.stderr()}`;
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ORIGIN);
    expect(serialized).not.toContain(fixture.home);
    expect(serialized).not.toContain(FINAL_TEXT);
    expect(serialized).not.toContain("This is a connectivity check");
    expect(serialized).not.toMatch(/cookie|authorization|reasoning|api[_-]?key/i);
  });

  it("accepts mixed ordinary events and officially packed text chunks with encoded source sequences", async () => {
    const fixture = await makeFixture({ sessionStorage: "packed" });

    await expect(runWith(fixture)).resolves.toMatchObject({
      ok: true,
      status: "completed",
      session_id: "session-real-smoke",
      final_text_bytes: Buffer.byteLength(FINAL_TEXT, "utf8"),
    });

    const records = await readFixtureSession(fixture.home);
    expect(records.find((record) => record.type === "text-chunks")).toEqual({
      type: "text-chunks",
      seq0: 5,
      time0: 1_788_480_000_005,
      data: {
        turn: 1,
        step: 1,
        index: 0,
        dt: [1, 1],
        texts: [FINAL_TEXT.slice(0, 8), FINAL_TEXT.slice(8, 20), FINAL_TEXT.slice(20)],
      },
    });
    expect(records.find((record) => record.type === "request/context")).toMatchObject({ seq: 4 });
    expect(records.find((record) => record.type === "assistant/message")).toMatchObject({
      seq: 8,
      sourceEventSeqs: [[5, 7]],
    });
    expect(records.at(-1)).toMatchObject({ type: "turn/end", seq: 10 });
  });

  it("rejects malformed packed rows, decoded sequence gaps, and invalid source-sequence ranges", async () => {
    for (const sessionStorage of ["malformed-chunks", "sequence-gap", "invalid-source-seqs"] as const) {
      const fixture = await makeFixture({ sessionStorage });
      await expect(runWith(fixture)).rejects.toMatchObject({ code: "REAL_WEB_SESSION_EVIDENCE_INVALID" });
    }
  });

  it("preserves the allowlisted failure cause after officially packed text was already streamed", async () => {
    const fixture = await makeFixture({
      sessionStorage: "packed",
      actual: { exitCode: 1, stdout: "partial response", stderr: "private model failure" },
      failureSession: { code: "WEB_MODEL_PROTOCOL", message: "private model failure" },
    });
    const output = captureOutput();

    await expect(main(CONFIRM, {
      ...output.options,
      cwd: fixture.cwd,
      env: fixture.env,
      nodeVersion: "24.18.0",
      dependencies: fixture.dependencies,
    })).resolves.toBe(1);

    expect(JSON.parse(output.stderr())).toEqual({
      schema_version: 1,
      ok: false,
      status: "failed",
      error: "REAL_WEB_DSH_FAILED",
      cause_code: "WEB_MODEL_PROTOCOL",
    });
    expect(output.stdout()).toBe("");
    expect(output.stderr()).not.toMatch(/partial response|private model failure/);
    expect((await readFixtureSession(fixture.home)).some((record) => record.type === "text-chunks")).toBe(true);
  });

  it("settles and removes signal handlers when tree cleanup rejects or never settles", async () => {
    for (const cleanup of ["reject", "hang"] as const) {
      const root = await mkdtemp(join(tmpdir(), `dsh-real-smoke-cleanup-${cleanup}-`));
      roots.push(root);
      const pidFile = join(root, "child.pid");
      const beforeSigint = process.listenerCount("SIGINT");
      const beforeSigterm = process.listenerCount("SIGTERM");
      const spec: CommandSpec = {
        executable: process.execPath,
        args: [HANGING_CHILD, pidFile],
        cwd: root,
        env: { ...process.env },
        timeoutMs: 300,
        shell: false,
        windowsHide: true,
      };
      const terminateOwnedProcessTree = cleanup === "reject"
        ? async () => { throw new Error("injected cleanup rejection"); }
        : () => new Promise<void>(() => undefined);
      await expect(runCommand(spec, {
        terminateOwnedProcessTree,
        cleanupDeadlineMs: 50,
      })).rejects.toMatchObject({ code: "REAL_WEB_COMMAND_TIMEOUT" });
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      await expectPidToExit(pid);
      expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
      expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
    }
  });

  it("rejects reasoning or pairing material found in the durable session", async () => {
    const reasoning = await makeFixture({ sessionLeak: "reasoning" });
    await expect(runWith(reasoning)).rejects.toMatchObject({ code: "REAL_WEB_SESSION_SENSITIVE_DATA" });
    const pairing = await makeFixture({ sessionLeak: "pairing" });
    await expect(runWith(pairing)).rejects.toMatchObject({ code: "REAL_WEB_SESSION_SENSITIVE_DATA" });
  });

  it("rejects malformed sequence, duplicate model events, and reordered durable evidence", async () => {
    for (const sessionVariant of ["bad-seq", "duplicate-context", "duplicate-assistant", "wrong-order"] as const) {
      const fixture = await makeFixture({ sessionVariant });
      await expect(runWith(fixture)).rejects.toMatchObject({ code: "REAL_WEB_SESSION_EVIDENCE_INVALID" });
    }
  });
});

interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly shell: false;
  readonly windowsHide: true;
}

interface FixtureOptions {
  readonly manifest?: Record<string, unknown>;
  readonly version?: string;
  readonly dump?: string;
  readonly actual?: { exitCode: number; stdout: string; stderr: string };
  readonly writeEvidence?: boolean;
  readonly sessionLeak?: "reasoning" | "pairing";
  readonly sessionVariant?: "bad-seq" | "duplicate-context" | "duplicate-assistant" | "wrong-order";
  readonly sessionStorage?: "packed" | "malformed-chunks" | "sequence-gap" | "invalid-source-seqs";
  readonly failureSession?: {
    readonly code: string;
    readonly message: string;
    readonly association?: "wrong-task" | "wrong-cwd";
  };
}

async function makeFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-real-smoke-offline-"));
  roots.push(root);
  const home = join(root, "dsh-home");
  const cwd = join(root, "workspace");
  const profileDir = join(home, "profiles", PROFILE);
  await mkdir(profileDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    `${JSON.stringify(options.manifest ?? profileManifest())}\n`,
    "utf8",
  );

  const commands: CommandSpec[] = [];
  const runCommand = vi.fn(async (spec: CommandSpec) => {
    commands.push(spec);
    if (spec.args.includes("--version")) {
      return { exitCode: 0, stdout: options.version ?? "0.1.2-rc.1\n", stderr: "" };
    }
    if (spec.args.includes("--dump-config")) {
      return { exitCode: 0, stdout: options.dump ?? PROFILE_DUMP, stderr: "" };
    }
    const task = spec.args.at(-1) ?? "";
    if (options.writeEvidence !== false) {
      await writeSession(
        home,
        cwd,
        task,
        FINAL_TEXT,
        options.sessionLeak,
        options.sessionVariant,
        options.failureSession,
        options.sessionStorage,
      );
    }
    return options.actual ?? { exitCode: 0, stdout: `${FINAL_TEXT}\n`, stderr: "" };
  });
  const readText = vi.fn((path: string) => readFile(path, "utf8"));
  return {
    home,
    cwd,
    env: validEnvironment(home),
    commands,
    readText,
    runCommand,
    dependencies: { readText, runCommand, randomId: () => CORRELATION },
  };
}

async function runWith(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return runRealWebSmoke({
    args: CONFIRM,
    cwd: fixture.cwd,
    env: fixture.env,
    nodeVersion: "24.18.0",
  }, fixture.dependencies);
}

function inertEffects() {
  const readText = vi.fn(async () => "");
  const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  return { readText, runCommand, dependencies: { readText, runCommand } };
}

function validEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    DSH_HOME: home,
    DSH_WEB_BROKER_PORT: "43123",
    DSH_WEB_PAIRING_TOKEN: TOKEN,
    DSH_WEB_ALLOWED_EXTENSION_ORIGINS: ORIGIN,
    DSH_WEB_REAL_BROWSER_ATTESTATION: "logged-in-and-broker-enabled",
  };
}

function profileManifest(): Record<string, unknown> {
  return {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: { [BUNDLE]: "link:C:/checkout/packages/dsh-web-agent-bundle" },
    dsh: { profile: { bundles: [BUNDLE], patchReload: "startup" } },
  };
}

async function writeSession(
  home: string,
  cwd: string,
  task: string,
  finalText: string,
  leak?: "reasoning" | "pairing",
  variant?: "bad-seq" | "duplicate-context" | "duplicate-assistant" | "wrong-order",
  failure?: {
    readonly code: string;
    readonly message: string;
    readonly association?: "wrong-task" | "wrong-cwd";
  },
  storage?: FixtureOptions["sessionStorage"],
) {
  const directory = join(home, "sessions", "2026", "09", "04", "session-real-smoke");
  await mkdir(directory, { recursive: true });
  const eventBodies = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", data: { content: [{ type: "text", text: failure?.association === "wrong-task" ? `${task}-other` : task }] } },
    { type: "request/header", data: { header: { config: { provider: "deepseek-web", model: "current-web-session" } } } },
    { type: "request/context", data: { provider: "deepseek-web", model: "current-web-session" } },
    ...(storage === undefined ? [] : [finalText.slice(0, 8), finalText.slice(8, 20), finalText.slice(20)].map((text) => ({
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text } },
    }))),
    ...(failure === undefined ? [{
      type: "assistant/message",
      data: {
        message: {
          content: [{ type: "text", text: finalText }],
          source: { kind: "model", provider: "deepseek-web", model: "current-web-session" },
        },
        turn: 1,
        step: 1,
      },
    }] : [{
      type: "assistant/chunk",
      data: {
        chunk: { type: "finish", reason: { kind: "error", failure: { code: failure.code, message: failure.message } } },
        turn: 1,
        step: 1,
      },
    }]),
    ...(leak === "reasoning"
      ? [{ type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", text: "private" } } }]
      : leak === "pairing"
        ? [{ type: "debug", data: { value: TOKEN } }]
        : []),
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: failure === undefined
      ? { kind: "completed" }
      : { kind: "error", error: { code: failure.code, message: failure.message } } } },
  ];
  if (variant === "duplicate-context") {
    eventBodies.splice(5, 0, { type: "request/context", data: { provider: "deepseek-web", model: "current-web-session" } });
  } else if (variant === "duplicate-assistant") {
    eventBodies.splice(6, 0, structuredClone(eventBodies[5]!));
  } else if (variant === "wrong-order") {
    [eventBodies[3], eventBodies[4]] = [eventBodies[4]!, eventBodies[3]!];
  }
  const events = eventBodies.map((event, seq) => ({ ...event, seq, time: 1_788_480_000_000 + seq }));
  if (variant === "bad-seq") events[3]!.seq = 2;
  // The preflight fixtures intentionally omit unrelated event fields. The
  // complete text-delta envelopes above are packed by DSH's production codec.
  const packedEvents = storage === undefined
    ? undefined
    : packChunkRuns(events as unknown as Parameters<typeof packChunkRuns>[0]);
  const packedRow = packedEvents?.find((event) => event.type === "text-chunks");
  if (packedRow !== undefined) {
    if (storage === "malformed-chunks") packedRow.data.dt.pop();
    if (storage === "sequence-gap") packedRow.seq0 = SessionSeq(packedRow.seq0 + 1);
  }
  const storageRecords: Record<string, unknown>[] = packedEvents ?? events;
  const assistant = storageRecords.find((event) => event.type === "assistant/message");
  if (storage !== undefined && assistant !== undefined) {
    assistant.sourceEventSeqs = storage === "invalid-source-seqs"
      ? [[7, 5]]
      : encodeSeqRanges([SessionSeq(5), SessionSeq(6), SessionSeq(7)]);
  }
  const records = [{
    type: "session",
    id: "session-real-smoke",
    cwd: failure?.association === "wrong-cwd" ? `${cwd}-other` : cwd,
  }, ...storageRecords];
  await writeFile(join(directory, "session.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

async function readFixtureSession(home: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(home, "sessions", "2026", "09", "04", "session-real-smoke", "session.jsonl"), "utf8");
  return raw.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function captureOutput() {
  let out = "";
  let error = "";
  return {
    options: {
      stdout: { write: (value: string) => { out += value; return true; } },
      stderr: { write: (value: string) => { error += value; return true; } },
    },
    stdout: () => out,
    stderr: () => error,
  };
}

async function expectPidToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can exit between the final probe and cleanup signal.
  }
  throw new Error(`owned child ${pid} did not exit after cleanup fallback`);
}
