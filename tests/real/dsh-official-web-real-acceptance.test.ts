import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const spawnSpy = vi.hoisted(() => vi.fn(() => { throw new Error("A read-only verifier must not spawn a child"); }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnSpy,
}));

interface Route {
  provider: "deepseek-web";
  model: "current-web-session" | "current-web-session-expert";
  reasoning_effort: "off" | "on";
}
interface ReadEntry {
  case: string; session_id: string; workspace: string; expected: Route; proof_file: string;
}
interface ToolEntry {
  session_id: string; workspace: string; expected: Route;
  before_file?: string; after_file?: string; input_file?: string; output_file?: string;
}
interface AcceptanceModule {
  runOfficialWebAcceptance(options: { args: string[]; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  validateManifest(value: unknown): Record<string, unknown>;
  verifyReadOnlyEvidence(
    raw: string,
    expected: ReadEntry,
    proof: Buffer,
    options?: { additionalTurns?: number },
  ): Record<string, unknown>;
  verifyEditorEvidence(raw: string, expected: ToolEntry, files: { before: Buffer; after: Buffer }): Record<string, unknown>;
  verifyPowerShellEvidence(raw: string, expected: ToolEntry, files: {
    input: Buffer;
    output: Buffer;
    outputCreatedAtMs: number;
  }): Record<string, unknown>;
  main(args: string[], options?: {
    env?: NodeJS.ProcessEnv;
    stdout?: { write(value: string): unknown };
    stderr?: { write(value: string): unknown };
  }): Promise<number>;
}

// @ts-expect-error -- Executable CLI module has no generated TypeScript declaration.
const acceptance = await import("../../scripts/dsh-official-web-real-acceptance.mjs") as AcceptanceModule;

const ENV_NAME = "DSH_OFFICIAL_WEB_ACCEPTANCE_MANIFEST";
const DEFAULT: Route = { provider: "deepseek-web", model: "current-web-session", reasoning_effort: "off" };
const MATRIX: Array<[string, Route]> = [
  ["default-off", DEFAULT],
  ["default-on", { ...DEFAULT, reasoning_effort: "on" }],
  ["expert-off", { ...DEFAULT, model: "current-web-session-expert" }],
  ["expert-on", { ...DEFAULT, model: "current-web-session-expert", reasoning_effort: "on" }],
];

interface BuiltFixture {
  root: string;
  manifestPath: string;
  manifest: {
    schema_version: number; kind: string; evidence_root: string; sessions_root: string; compression: string;
    readonly: ReadEntry[];
    editor: Required<ToolEntry>;
    pwsh: Required<ToolEntry>;
  };
  raw: Map<string, string>;
  proof: Map<string, Buffer>;
  nonce: string;
}

let fixture: BuiltFixture;

beforeAll(async () => {
  fixture = await buildFixture();
}, 20_000);

afterAll(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("official web real-acceptance read-only verifier", () => {
  it("reads official concatenated-zstd artifacts and returns only a safe projection", async () => {
    const beforeTree = await snapshotTree(fixture.root);
    const result = await acceptance.runOfficialWebAcceptance({
      args: ["--manifest", fixture.manifestPath],
      env: {},
    });
    expect(await snapshotTree(fixture.root)).toEqual(beforeTree);
    expect(result).toMatchObject({
      schema_version: 1,
      kind: "dsh-official-web-real-acceptance",
      ok: true,
      status: "verified",
      physical_encoding: "zstd",
      matrix: MATRIX.map(([caseName, route]) => ({
        case: caseName,
        session_id: `readonly-${caseName}`,
        provider: route.provider,
        model: route.model,
        reasoning_effort: route.reasoning_effort,
        turns: 2,
        model_steps: 3,
        tool_calls: 1,
        followup_tool_calls: 0,
        selection_event_observed: true,
        proof_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        session_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })),
      editor: {
        session_id: "readonly-default-off",
        tool_calls: 2,
        before_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        after_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      pwsh: {
        session_id: "readonly-expert-off",
        tool_calls: 1,
        approvals_asked: 1,
        approvals_allowed_once: 1,
        output_created_during_turn: true,
        input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const projection = JSON.stringify(result);
    expect(projection).not.toContain(fixture.root);
    expect(projection).not.toContain(fixture.nonce);
    expect(projection).not.toContain("Copy-Item");
    expect(projection).not.toContain("proof_file");
    expect(spawnSpy).not.toHaveBeenCalled();

    const projectDirs = await import("node:fs/promises").then(({ readdir }) => readdir(fixture.manifest.sessions_root));
    expect(projectDirs).toHaveLength(4);
    for (const projectDir of projectDirs) {
      const sessionDirs = await import("node:fs/promises")
        .then(({ readdir }) => readdir(join(fixture.manifest.sessions_root, projectDir)));
      expect(sessionDirs).toHaveLength(1);
    }
    const firstPhysical = await findFirstSessionArtifact(fixture.manifest.sessions_root, projectDirs[0]!);
    const magic = (await readFile(firstPhysical)).readUInt32LE(0);
    expect(magic).toBe(0xfd2fb528);
  });

  it("accepts one explicit environment manifest path and rejects ambiguous or absent inputs before effects", async () => {
    let stdout = "";
    let stderr = "";
    expect(await acceptance.main([], {
      env: { [ENV_NAME]: fixture.manifestPath },
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: "verified" });
    expect(stderr).toBe("");

    stdout = "";
    stderr = "";
    expect(await acceptance.main([], {
      env: {},
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    })).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, error: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_REQUIRED" });

    stderr = "";
    expect(await acceptance.main(["--manifest", fixture.manifestPath], {
      env: { [ENV_NAME]: fixture.manifestPath },
      stderr: { write(value) { stderr += value; } },
      stdout: { write() {} },
    })).toBe(2);
    expect(JSON.parse(stderr).error).toBe("OFFICIAL_WEB_ACCEPTANCE_MANIFEST_CONFLICT");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects a manifest reached through an intermediate symlink or junction", async () => {
    const target = await mkdtemp(join(tmpdir(), "dsh-official-web-manifest-target-"));
    const alias = join(fixture.root, "manifest-alias");
    const targetManifest = join(target, "manifest.json");
    await writeFile(targetManifest, JSON.stringify(fixture.manifest), "utf8");
    try {
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(acceptance.runOfficialWebAcceptance({
        args: ["--manifest", join(alias, "manifest.json")],
        env: {},
      })).rejects.toMatchObject({ code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_UNAVAILABLE" });
    } finally {
      await unlink(alias).catch(() => undefined);
      await rm(target, { recursive: true, force: true });
    }
  });

  it("requires the exact four model/thinking cells, isolated sessions, roots and evidence paths", () => {
    expect(() => acceptance.validateManifest(fixture.manifest)).not.toThrow();
    const missing = structuredClone(fixture.manifest);
    missing.readonly.pop();
    expect(() => acceptance.validateManifest(missing)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const wrongCell = structuredClone(fixture.manifest);
    wrongCell.readonly[3]!.expected.reasoning_effort = "off";
    expect(() => acceptance.validateManifest(wrongCell)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const duplicate = structuredClone(fixture.manifest);
    duplicate.readonly[1]!.session_id = duplicate.readonly[0]!.session_id;
    expect(() => acceptance.validateManifest(duplicate)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const unbound = structuredClone(fixture.manifest);
    unbound.editor.expected = unbound.readonly[1]!.expected;
    expect(() => acceptance.validateManifest(unbound)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const sharedTail = structuredClone(fixture.manifest);
    sharedTail.pwsh.session_id = sharedTail.editor.session_id;
    sharedTail.pwsh.workspace = sharedTail.editor.workspace;
    sharedTail.pwsh.expected = sharedTail.editor.expected;
    expect(() => acceptance.validateManifest(sharedTail)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const unknown = { ...structuredClone(fixture.manifest), pairing_token: "must-never-be-accepted" };
    expect(() => acceptance.validateManifest(unknown)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const broadRoot = structuredClone(fixture.manifest);
    broadRoot.sessions_root = fixture.root;
    expect(() => acceptance.validateManifest(broadRoot)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
    const overlappingRoots = structuredClone(fixture.manifest);
    overlappingRoots.evidence_root = overlappingRoots.sessions_root;
    expect(() => acceptance.validateManifest(overlappingRoots)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID",
    }));
  });

  it("requires a correlated read in turn one and a tool-free contextual follow-up", () => {
    const entry = fixture.manifest.readonly[1]!;
    const raw = fixture.raw.get(entry.session_id)!;
    const proof = fixture.proof.get(entry.proof_file)!;
    expect(acceptance.verifyReadOnlyEvidence(raw, entry, proof)).toMatchObject({
      case: "default-on",
      turns: 2,
      tool_calls: 1,
      followup_tool_calls: 0,
    });

    const followupTool = editRaw(raw, (rows) => {
      const answer = rows.find((row) => row.type === "assistant/message" && row.data.turn === 2)!;
      answer.data.message.content.push({ type: "tool-call", id: "unrecorded", name: "read", arguments: "{}" });
    });
    expect(() => acceptance.verifyReadOnlyEvidence(followupTool, entry, proof)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID",
    }));

    const wrongEffort = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "request/header")!.data.header.config.reasoningEffort = "off";
    });
    expect(() => acceptance.verifyReadOnlyEvidence(wrongEffort, entry, proof)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID",
    }));
    const canonicalExtra = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "request/header")!.data.header.config.maxTokens = 4096;
    });
    expect(() => acceptance.verifyReadOnlyEvidence(canonicalExtra, entry, proof)).not.toThrow();
    const missingSelection = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "model/selection")!.type = "model/options";
    });
    expect(() => acceptance.verifyReadOnlyEvidence(missingSelection, entry, proof)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID",
    }));
    const selectionTrail = insertEvent(raw, selection(DEFAULT));
    expect(() => acceptance.verifyReadOnlyEvidence(selectionTrail, entry, proof)).not.toThrow();
  });

  it("rejects durable secrets and reasoning values without printing their contents", () => {
    const entry = fixture.manifest.readonly[3]!;
    const raw = fixture.raw.get(entry.session_id)!;
    const proof = fixture.proof.get(entry.proof_file)!;
    const secret = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "assistant/message" && row.data.turn === 2)!
        .data.message.content[0].text += " pairing_token";
    });
    expect(() => acceptance.verifyReadOnlyEvidence(secret, entry, proof)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_SENSITIVE_DATA",
    }));
    const reasoning = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "assistant/message" && row.data.turn === 2)!
        .data.message.reasoning = "private model trace";
    });
    expect(() => acceptance.verifyReadOnlyEvidence(reasoning, entry, proof)).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_SENSITIVE_DATA",
    }));
  });

  it("proves read-before-edit correlation and derives the exact final bytes from the official edit call", () => {
    const entry = fixture.manifest.editor;
    const raw = fixture.raw.get(entry.session_id)!;
    const before = fixture.proof.get(entry.before_file)!;
    const after = fixture.proof.get(entry.after_file)!;
    expect(acceptance.verifyEditorEvidence(raw, entry, { before, after })).toMatchObject({
      session_id: "readonly-default-off",
      model_steps: 3,
      tool_calls: 2,
    });
    expect(() => acceptance.verifyEditorEvidence(raw, entry, {
      before,
      after: Buffer.from(after.toString("utf8").replace("state=verified", "state=fabricated")),
    })).toThrow(expect.objectContaining({ code: "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID" }));
    const replayed = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "tool/call" && row.data.name === "edit")!.data.name = "write";
    });
    expect(() => acceptance.verifyEditorEvidence(replayed, entry, { before, after })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID",
    }));
    const partialRead = editRaw(raw, (rows) => {
      const result = rows.find((row) => row.type === "tool/result" && row.data.turn === 3 && row.data.step === 1)!;
      result.data.message.content[0].content[0].text = `<content>\n1: editor-nonce=${fixture.nonce}\n</content>`;
    });
    expect(() => acceptance.verifyEditorEvidence(partialRead, entry, { before, after })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID",
    }));
    const limitedRead = editRaw(raw, (rows) => {
      const call = rows.find((row) => row.type === "tool/call" && row.data.name === "read" && row.data.turn === 3)!;
      const args = { ...JSON.parse(call.data.arguments), limit: 1 };
      call.data.arguments = JSON.stringify(args);
      rows.find((row) => row.type === "assistant/message" && row.data.turn === 3 && row.data.step === 1)!
        .data.message.content[0].arguments = call.data.arguments;
    });
    expect(() => acceptance.verifyEditorEvidence(limitedRead, entry, { before, after })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID",
    }));
    const changedTailRoute = editRaw(raw, (rows) => {
      rows.findLast((row) => row.type === "request/header")!.data.header.config.model = "current-web-session-expert";
    });
    expect(() => acceptance.verifyEditorEvidence(changedTailRoute, entry, { before, after })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID",
    }));
  });

  it("requires one newly created foreground pwsh copy and its one-shot allowed-once decision", async () => {
    const entry = fixture.manifest.pwsh;
    const raw = fixture.raw.get(entry.session_id)!;
    const input = fixture.proof.get(entry.input_file)!;
    const output = fixture.proof.get(entry.output_file)!;
    const outputCreatedAtMs = (await stat(entry.output_file)).birthtimeMs;
    expect(acceptance.verifyPowerShellEvidence(raw, entry, { input, output, outputCreatedAtMs })).toMatchObject({
      session_id: "readonly-expert-off",
      tool_calls: 1,
      approvals_asked: 1,
      approvals_allowed_once: 1,
    });
    const rejected = editRaw(raw, (rows) => {
      rows.find((row) => row.type === "approval/decided")!.data.outcome = "rejected";
    });
    expect(() => acceptance.verifyPowerShellEvidence(rejected, entry, { input, output, outputCreatedAtMs })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID",
    }));
    const background = editRaw(raw, (rows) => {
      const call = rows.find((row) => row.type === "tool/call" && row.data.name === "pwsh")!;
      const args = JSON.parse(call.data.arguments);
      args.run_in_background = true;
      call.data.arguments = JSON.stringify(args);
      rows.find((row) => row.type === "assistant/message" && row.data.turn === 3 && row.data.step === 1)!
        .data.message.content[0].arguments = call.data.arguments;
    });
    expect(() => acceptance.verifyPowerShellEvidence(background, entry, { input, output, outputCreatedAtMs })).toThrow(expect.objectContaining({
      code: "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID",
    }));
    expect(() => acceptance.verifyPowerShellEvidence(raw, entry, {
      input,
      output: Buffer.from("not-the-input\n"),
      outputCreatedAtMs,
    }))
      .toThrow(expect.objectContaining({ code: "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID" }));
    const turnStart = JSON.parse(raw.split("\n").find((line) => line.includes('"type":"turn/start"') &&
      line.includes('"turn":3'))!).time as number;
    expect(() => acceptance.verifyPowerShellEvidence(raw, entry, {
      input,
      output,
      outputCreatedAtMs: turnStart - 1,
    })).toThrow(expect.objectContaining({ code: "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID" }));
    const resultTime = JSON.parse(raw.split("\n").find((line) => line.includes('"type":"tool/result"') &&
      line.includes('"turn":3'))!).time as number;
    expect(() => acceptance.verifyPowerShellEvidence(raw, entry, {
      input,
      output,
      outputCreatedAtMs: resultTime + 0.75,
    })).not.toThrow();
  });
});

async function buildFixture(): Promise<BuiltFixture> {
  const root = await mkdtemp(join(tmpdir(), "official-web-real-verifier-"));
  const evidenceRoot = join(root, "evidence");
  const sessionsRoot = join(root, "dsh-home", "sessions");
  await Promise.all([mkdir(evidenceRoot, { recursive: true }), mkdir(sessionsRoot, { recursive: true })]);
  const nonce = "8f31c20a7bd94b95a77e14c6a5d191ef";
  const readonly: ReadEntry[] = [];
  const raw = new Map<string, string>();
  const proof = new Map<string, Buffer>();
  const stored: Array<{ id: string; cwd: string; events: Array<Record<string, any>> }> = [];
  const eventsBySession = new Map<string, Array<Record<string, any>>>();

  for (const [caseName, route] of MATRIX) {
    const workspace = join(evidenceRoot, `workspace-${caseName}`);
    const proofFile = join(workspace, "read-proof.txt");
    const sessionId = `readonly-${caseName}`;
    const text = `proof=${caseName}-${nonce}\n`;
    await mkdir(workspace, { recursive: true });
    await writeFile(proofFile, text, { flag: "wx" });
    const entry = { case: caseName, session_id: sessionId, workspace, expected: route, proof_file: proofFile };
    readonly.push(entry);
    proof.set(proofFile, Buffer.from(text));
    eventsBySession.set(sessionId, readEvents(route, basename(proofFile), `${caseName}-${nonce}`));
  }

  const editorOwner = readonly[0]!;
  const editorWorkspace = editorOwner.workspace;
  const editorBefore = join(evidenceRoot, "editor-before.snapshot.txt");
  const editorAfter = join(editorWorkspace, "editor-target.txt");
  const editorBeforeText = `editor-nonce=${nonce}\nstate=pending\n`;
  const editorAfterText = `editor-nonce=${nonce}\nstate=verified-${nonce}\n`;
  await Promise.all([
    writeFile(editorBefore, editorBeforeText, { flag: "wx" }),
    writeFile(editorAfter, editorAfterText, { flag: "wx" }),
  ]);
  proof.set(editorBefore, Buffer.from(editorBeforeText));
  proof.set(editorAfter, Buffer.from(editorAfterText));
  const editor = {
    session_id: editorOwner.session_id,
    workspace: editorWorkspace,
    expected: editorOwner.expected,
    before_file: editorBefore,
    after_file: editorAfter,
    input_file: "",
    output_file: "",
  };
  eventsBySession.set(editor.session_id, sequence([
    ...eventsBySession.get(editor.session_id)!,
    ...editorTurnEvents(editor.expected, basename(editorAfter), nonce, editorBeforeText),
  ]));

  const pwshOwner = readonly[2]!;
  const pwshWorkspace = pwshOwner.workspace;
  const pwshInput = join(pwshWorkspace, "pwsh-input.txt");
  const pwshOutput = join(pwshWorkspace, "pwsh-output.txt");
  const pwshText = `pwsh-proof=${nonce}\n`;
  await Promise.all([
    writeFile(pwshInput, pwshText, { flag: "wx" }),
    writeFile(pwshOutput, pwshText, { flag: "wx" }),
  ]);
  proof.set(pwshInput, Buffer.from(pwshText));
  proof.set(pwshOutput, Buffer.from(pwshText));
  const pwsh = {
    session_id: pwshOwner.session_id,
    workspace: pwshWorkspace,
    expected: pwshOwner.expected,
    input_file: pwshInput,
    output_file: pwshOutput,
    before_file: "",
    after_file: "",
  };
  const pwshEvents = sequence([
    ...eventsBySession.get(pwsh.session_id)!,
    ...powerShellTurnEvents(pwsh.expected, basename(pwshInput), basename(pwshOutput)),
  ]);
  alignTurnAroundCreation(pwshEvents, 3, (await stat(pwshOutput)).birthtimeMs);
  eventsBySession.set(pwsh.session_id, pwshEvents);
  for (const entry of readonly) {
    const events = eventsBySession.get(entry.session_id)!;
    stored.push({ id: entry.session_id, cwd: entry.workspace, events });
    raw.set(entry.session_id, rawSession(entry.session_id, entry.workspace, events));
  }
  await writeStoredSessions(sessionsRoot, stored);

  const manifest = {
    schema_version: 1,
    kind: "dsh-official-web-real-acceptance",
    evidence_root: evidenceRoot,
    sessions_root: sessionsRoot,
    compression: "zstd",
    readonly,
    editor: stripEmpty(editor) as Required<ToolEntry>,
    pwsh: stripEmpty(pwsh) as Required<ToolEntry>,
  };
  const manifestPath = join(root, "acceptance-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { root, manifestPath, manifest, raw, proof, nonce };
}

async function writeStoredSessions(root: string, sessions: Array<{ id: string; cwd: string; events: Array<Record<string, any>> }>) {
  const ctx = new Context();
  const fibers = [await ctx.plugin(SessionStore)];
  try {
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root, compression: "zstd", packChunks: true }));
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence;
    for (const session of sessions) {
      await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId(session.id),
        createdAt: 1_788_480_000_000,
        cwd: session.cwd,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: "standard",
      });
      await persistence.append(SessionId(session.id), session.events as never);
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}

function readEvents(route: Route, fileName: string, witness: string) {
  const source = modelSource(route);
  const call = toolBlock("read-call", "read", { file_path: fileName });
  const rows = [
    selection(route),
    event("turn/start", { turn: 1 }),
    event("step/start", { turn: 1, step: 1 }),
    user("Read read-proof.txt exactly once and report its proof value."),
    requestHeader(route),
    requestContext(route),
    assistant(1, 1, source, [call]),
    event("tool/call", { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments }),
    toolResult(1, 1, call.id, `<content>\n1: proof=${witness}\n</content>`),
    event("step/end", { turn: 1, step: 1 }),
    event("step/start", { turn: 1, step: 2 }),
    ...chunks(1, 2, `READ_OK:${witness}`),
    assistant(1, 2, source, [{ type: "text", text: `READ_OK:${witness}` }]),
    event("step/end", { turn: 1, step: 2 }),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }),
    event("turn/start", { turn: 2 }),
    event("step/start", { turn: 2, step: 1 }),
    user("Without using a tool, repeat the proof value from the prior turn."),
    assistant(2, 1, source, [{ type: "text", text: `FOLLOWUP_OK:${witness}` }]),
    event("step/end", { turn: 2, step: 1 }),
    event("turn/end", { turn: 2, reason: { kind: "completed" } }),
  ];
  return sequence(rows);
}

function editorTurnEvents(route: Route, fileName: string, nonce: string, beforeText: string) {
  const source = modelSource(route);
  const readCall = toolBlock("editor-read", "read", { file_path: fileName });
  const editCall = toolBlock("editor-edit", "edit", {
    file_path: fileName,
    old_string: "state=pending",
    new_string: `state=verified-${nonce}`,
  });
  return [
    event("turn/start", { turn: 3 }), event("step/start", { turn: 3, step: 1 }),
    user("Read the editor target, then make the requested one literal edit."), requestHeader(route, "series"), requestContext(route),
    assistant(3, 1, source, [readCall]),
    event("tool/call", { turn: 3, step: 1, callId: readCall.id, name: readCall.name, arguments: readCall.arguments }),
    toolResult(3, 1, readCall.id, `<content>\n${numberedFile(beforeText)}\n\n(End of file)\n</content>`),
    event("step/end", { turn: 3, step: 1 }),
    event("step/start", { turn: 3, step: 2 }), assistant(3, 2, source, [editCall]),
    event("tool/call", { turn: 3, step: 2, callId: editCall.id, name: editCall.name, arguments: editCall.arguments }),
    toolResult(3, 2, editCall.id, `The file ${fileName} has been updated successfully.`),
    event("step/end", { turn: 3, step: 2 }), event("step/start", { turn: 3, step: 3 }),
    assistant(3, 3, source, [{ type: "text", text: "Editor proof completed." }]),
    event("step/end", { turn: 3, step: 3 }), event("turn/end", { turn: 3, reason: { kind: "completed" } }),
  ];
}

function powerShellTurnEvents(route: Route, inputName: string, outputName: string) {
  const source = modelSource(route);
  const command = `Copy-Item -LiteralPath '.\\${inputName}' -Destination '.\\${outputName}'`;
  const call = toolBlock("pwsh-call", "pwsh", {
    command,
    description: "Copy isolated acceptance proof file",
    timeoutMs: 30_000,
  });
  return [
    event("turn/start", { turn: 3 }), event("step/start", { turn: 3, step: 1 }),
    user("Run the one foreground PowerShell copy command exactly once."), requestHeader(route, "series"), requestContext(route),
    assistant(3, 1, source, [call]),
    event("tool/call", { turn: 3, step: 1, callId: call.id, name: call.name, arguments: call.arguments }),
    event("approval/asked", { id: "approval-one", toolName: "pwsh", callId: call.id, reason: "Approve this one foreground PowerShell 7 command." }),
    event("approval/decided", { id: "approval-one", outcome: "allowed-once" }),
    toolResult(3, 1, call.id, "(no output)"), event("step/end", { turn: 3, step: 1 }),
    event("step/start", { turn: 3, step: 2 }), assistant(3, 2, source, [{ type: "text", text: "PowerShell proof completed." }]),
    event("step/end", { turn: 3, step: 2 }), event("turn/end", { turn: 3, reason: { kind: "completed" } }),
  ];
}

function sequence(rows: Array<Record<string, any>>) {
  const events: Array<Record<string, any> & { seq: number; time: number }> = rows
    .map((row, seq) => ({ ...row, seq, time: 1_788_480_000_000 + seq }));
  for (const result of events.filter((row) => row.type === "tool/result")) {
    const call = events.find((row) => row.type === "tool/call" && row.data.callId === result.data.message.source.callId);
    result.sourceEventSeqs = [call!.seq];
  }
  return events;
}

function selection(route: Route) {
  return event("model/selection", {
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoning_effort,
  });
}

function requestHeader(route: Route, reason = "initial") {
  return event("request/header", { reason, header: { config: {
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoning_effort,
  } } });
}

function numberedFile(text: string) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${index + 1}: ${line}`).join("\n");
}

function alignTurnAroundCreation(events: Array<Record<string, any>>, turn: number, createdAtMs: number) {
  const start = events.findIndex((row) => row.type === "turn/start" && row.data.turn === turn);
  const result = events.findIndex((row) => row.type === "tool/result" && row.data.turn === turn);
  if (start < 0 || result <= start) throw new Error("invalid fixture turn");
  const resultTime = Math.ceil(createdAtMs);
  for (let index = start; index < events.length; index += 1) {
    events[index]!.time = resultTime + index - result;
  }
}

function requestContext(route: Route) {
  return event("request/context", { provider: route.provider, model: route.model });
}

function modelSource(route: Route) {
  return { kind: "model", provider: route.provider, model: route.model };
}

function user(text: string) {
  return event("user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
}

function assistant(turn: number, step: number, source: Record<string, string>, content: unknown[]) {
  return event("assistant/message", { turn, step, message: { role: "assistant", source, content } });
}

function toolBlock(id: string, name: string, args: Record<string, unknown>) {
  return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}

function toolResult(turn: number, step: number, callId: string, text: string) {
  return event("tool/result", { turn, step, message: {
    role: "user",
    source: { kind: "tool", callId },
    content: [{ type: "tool-result", toolCallId: callId, isError: false, content: [{ type: "text", text }] }],
  } });
}

function chunks(turn: number, step: number, text: string) {
  const width = Math.ceil(text.length / 3);
  return [text.slice(0, width), text.slice(width, width * 2), text.slice(width * 2)].map((part) =>
    event("assistant/chunk", { turn, step, chunk: { type: "text-delta", index: 0, text: part } }));
}

function event(type: string, data: Record<string, unknown>) {
  return { type, data };
}

function rawSession(id: string, cwd: string, events: Array<Record<string, any>>) {
  const header = {
    type: "session",
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1_788_480_000_000,
    cwd,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  return `${[header, ...events].map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function editRaw(raw: string, edit: (rows: Array<Record<string, any>>) => void) {
  const rows = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
  edit(rows.slice(1));
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function insertEvent(raw: string, added: Record<string, any>) {
  const rows = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
  const header = rows.shift()!;
  const bare = rows.map(({ seq: _seq, time: _time, sourceEventSeqs: _sourceEventSeqs, ...row }) => row);
  return rawSession(header.id, header.cwd, sequence([added, ...bare]));
}

function stripEmpty(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== ""));
}

async function findFirstSessionArtifact(root: string, project: string) {
  const { readdir } = await import("node:fs/promises");
  const sessions = await readdir(join(root, project));
  return join(root, project, sessions[0]!, "session.jsonl.zstd");
}

async function snapshotTree(root: string) {
  const { readdir, stat } = await import("node:fs/promises");
  const rows: string[] = [];
  async function visit(path: string, relativePath: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const relativeChild = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        rows.push(`d:${relativeChild}`);
        await visit(child, relativeChild);
      } else {
        const [bytes, metadata] = await Promise.all([readFile(child), stat(child, { bigint: true })]);
        rows.push(`f:${relativeChild}:${metadata.size}:${metadata.mtimeNs}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  }
  await visit(root, "");
  return rows.sort();
}
