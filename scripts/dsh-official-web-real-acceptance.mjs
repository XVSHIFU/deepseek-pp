import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import { foldRequestHeader, SESSION_FORMAT_VERSION, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";

import { decodeSessionLog } from "./dsh-web-real-smoke.mjs";

const MANIFEST_ENV = "DSH_OFFICIAL_WEB_ACCEPTANCE_MANIFEST";
const MANIFEST_KIND = "dsh-official-web-real-acceptance";
const PROVIDER = "deepseek-web";
const DEFAULT_MODEL = "current-web-session";
const EXPERT_MODEL = "current-web-session-expert";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROOF_FILE_BYTES = 1024 * 1024;
const VERIFY_TIMEOUT_MS = 50_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CASES = Object.freeze({
  "default-off": Object.freeze({ provider: PROVIDER, model: DEFAULT_MODEL, reasoning_effort: "off" }),
  "default-on": Object.freeze({ provider: PROVIDER, model: DEFAULT_MODEL, reasoning_effort: "on" }),
  "expert-off": Object.freeze({ provider: PROVIDER, model: EXPERT_MODEL, reasoning_effort: "off" }),
  "expert-on": Object.freeze({ provider: PROVIDER, model: EXPERT_MODEL, reasoning_effort: "on" }),
});

export class OfficialWebAcceptanceError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "OfficialWebAcceptanceError";
    this.code = code;
  }
}

/**
 * Verify already-produced official web-profile evidence. This function opens
 * no socket, starts no child, and reads no credential store. The only inputs
 * are the explicit manifest, its four named Session ids, and proof files below
 * the manifest-owned evidence root.
 */
export async function runOfficialWebAcceptance(options, injected = {}) {
  const manifestPath = resolveManifestPath(options.args, options.env ?? process.env);
  const signal = options.signal ?? AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  const dependencies = {
    readBoundedFile,
    createReader: createOfficialSessionReader,
    ...injected,
  };
  const manifestBytes = await dependencies.readBoundedFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
    signal,
    "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_UNAVAILABLE",
  );
  const manifest = validateManifest(parseJson(decodeUtf8(manifestBytes), "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID"));
  await assertDirectory(manifest.evidence_root, signal);
  await assertDirectory(manifest.sessions_root, signal);
  await Promise.all(manifest.readonly.map((entry) => assertDirectory(entry.workspace, signal)));

  const proofs = await loadProofFiles(manifest, dependencies.readBoundedFile, signal);
  const pwshOutputCreatedAtMs = await fileBirthtimeMs(manifest.pwsh.output_file, signal);
  const reader = await dependencies.createReader(manifest.sessions_root, manifest.compression, signal);
  try {
    const matrix = [];
    const artifacts = new Map();
    for (const entry of manifest.readonly) {
      const artifact = await reader.read(entry.session_id, entry.workspace, signal);
      artifacts.set(entry.session_id, artifact);
      const hasAdditionalTurn = entry.session_id === manifest.editor.session_id ||
        entry.session_id === manifest.pwsh.session_id;
      matrix.push(verifyReadOnlyEvidence(artifact.raw, entry, proofs.get(entry.proof_file), {
        additionalTurns: hasAdditionalTurn ? 1 : 0,
      }));
    }
    const editorArtifact = artifacts.get(manifest.editor.session_id);
    const editor = verifyEditorEvidence(editorArtifact.raw, manifest.editor, {
      before: proofs.get(manifest.editor.before_file),
      after: proofs.get(manifest.editor.after_file),
    });
    const pwshArtifact = artifacts.get(manifest.pwsh.session_id);
    const pwsh = verifyPowerShellEvidence(pwshArtifact.raw, manifest.pwsh, {
      input: proofs.get(manifest.pwsh.input_file),
      output: proofs.get(manifest.pwsh.output_file),
      outputCreatedAtMs: pwshOutputCreatedAtMs,
    });
    return Object.freeze({
      schema_version: 1,
      kind: MANIFEST_KIND,
      ok: true,
      status: "verified",
      physical_encoding: "zstd",
      matrix: Object.freeze(matrix),
      editor,
      pwsh,
    });
  } finally {
    await reader.dispose();
  }
}

export async function main(args, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const result = await runOfficialWebAcceptance({
      args,
      env: options.env ?? process.env,
      signal: options.signal,
    }, options.dependencies);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof OfficialWebAcceptanceError
      ? error.code
      : error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "OFFICIAL_WEB_ACCEPTANCE_TIMEOUT"
        : "OFFICIAL_WEB_ACCEPTANCE_INTERNAL_ERROR";
    const usage = code === "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_REQUIRED" ||
      code === "OFFICIAL_WEB_ACCEPTANCE_ARGUMENTS_INVALID" ||
      code === "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_CONFLICT";
    stderr.write(`${JSON.stringify({
      schema_version: 1,
      kind: MANIFEST_KIND,
      ok: false,
      status: "failed",
      error: code,
      ...(usage ? { usage: `node scripts/dsh-official-web-real-acceptance.mjs --manifest <absolute-manifest.json> (or ${MANIFEST_ENV})` } : {}),
    })}\n`);
    return usage ? 2 : 1;
  }
}

export function resolveManifestPath(args, env) {
  const fromEnv = env?.[MANIFEST_ENV];
  if (args.length === 0) {
    if (typeof fromEnv !== "string" || fromEnv === "") {
      throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_MANIFEST_REQUIRED");
    }
    return validateAbsolutePath(fromEnv, "OFFICIAL_WEB_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  if (args.length !== 2 || args[0] !== "--manifest" || typeof args[1] !== "string" || args[1] === "") {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_ARGUMENTS_INVALID");
  }
  if (typeof fromEnv === "string" && fromEnv !== "") {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_MANIFEST_CONFLICT");
  }
  return validateAbsolutePath(args[1], "OFFICIAL_WEB_ACCEPTANCE_ARGUMENTS_INVALID");
}

export function validateManifest(value) {
  invalidUnless(exactKeys(value, [
    "schema_version", "kind", "evidence_root", "sessions_root", "compression", "readonly", "editor", "pwsh",
  ]));
  invalidUnless(value.schema_version === 1 && value.kind === MANIFEST_KIND && value.compression === "zstd");
  const evidenceRoot = validateAbsolutePath(value.evidence_root);
  const sessionsRoot = validateAbsolutePath(value.sessions_root);
  invalidUnless(basename(sessionsRoot).toLowerCase() === "sessions");
  invalidUnless(platformPathKey(evidenceRoot) !== platformPathKey(sessionsRoot) &&
    !containsPath(evidenceRoot, sessionsRoot) && !containsPath(sessionsRoot, evidenceRoot));
  invalidUnless(Array.isArray(value.readonly) && value.readonly.length === 4);

  const readonly = value.readonly.map((entry) => validateReadOnlyEntry(entry, evidenceRoot));
  const expectedCases = Object.keys(CASES).sort();
  invalidUnless(readonly.map((entry) => entry.case).sort().join("\n") === expectedCases.join("\n"));
  for (const entry of readonly) invalidUnless(sameExpected(entry.expected, CASES[entry.case]));
  const editor = validateEditorEntry(value.editor, evidenceRoot);
  const pwsh = validatePowerShellEntry(value.pwsh, evidenceRoot);

  invalidUnless(new Set(readonly.map((entry) => entry.session_id)).size === readonly.length);
  invalidUnless(new Set(readonly.map((entry) => platformPathKey(entry.workspace))).size === readonly.length);
  invalidUnless(editor.session_id !== pwsh.session_id);
  for (const bound of [editor, pwsh]) {
    const owner = readonly.find((entry) => entry.session_id === bound.session_id);
    invalidUnless(owner !== undefined && platformPathKey(owner.workspace) === platformPathKey(bound.workspace) &&
      sameExpected(owner.expected, bound.expected));
  }
  const proofPaths = [
    ...readonly.map((entry) => entry.proof_file),
    editor.before_file,
    editor.after_file,
    pwsh.input_file,
    pwsh.output_file,
  ];
  invalidUnless(new Set(proofPaths.map(platformPathKey)).size === proofPaths.length);
  return Object.freeze({
    schema_version: 1,
    kind: MANIFEST_KIND,
    evidence_root: evidenceRoot,
    sessions_root: sessionsRoot,
    compression: "zstd",
    readonly: Object.freeze(readonly),
    editor,
    pwsh,
  });
}

function validateReadOnlyEntry(value, evidenceRoot) {
  invalidUnless(exactKeys(value, ["case", "session_id", "workspace", "expected", "proof_file"]));
  invalidUnless(Object.hasOwn(CASES, value.case));
  const workspace = validateWorkspace(value.workspace, evidenceRoot);
  const proofFile = validateEvidencePath(value.proof_file, evidenceRoot);
  invalidUnless(containsPath(workspace, proofFile) && dirname(proofFile) === workspace);
  return Object.freeze({
    case: value.case,
    session_id: validateSessionId(value.session_id),
    workspace,
    expected: validateExpected(value.expected),
    proof_file: proofFile,
  });
}

function validateEditorEntry(value, evidenceRoot) {
  invalidUnless(exactKeys(value, ["session_id", "workspace", "expected", "before_file", "after_file"]));
  const workspace = validateWorkspace(value.workspace, evidenceRoot);
  const beforeFile = validateEvidencePath(value.before_file, evidenceRoot);
  const afterFile = validateEvidencePath(value.after_file, evidenceRoot);
  invalidUnless(platformPathKey(beforeFile) !== platformPathKey(afterFile));
  invalidUnless(containsPath(workspace, afterFile) && dirname(afterFile) === workspace);
  return Object.freeze({
    session_id: validateSessionId(value.session_id),
    workspace,
    expected: validateExpected(value.expected),
    before_file: beforeFile,
    after_file: afterFile,
  });
}

function validatePowerShellEntry(value, evidenceRoot) {
  invalidUnless(exactKeys(value, ["session_id", "workspace", "expected", "input_file", "output_file"]));
  const workspace = validateWorkspace(value.workspace, evidenceRoot);
  const inputFile = validateEvidencePath(value.input_file, evidenceRoot);
  const outputFile = validateEvidencePath(value.output_file, evidenceRoot);
  invalidUnless(platformPathKey(inputFile) !== platformPathKey(outputFile));
  invalidUnless([inputFile, outputFile].every((path) => containsPath(workspace, path) && dirname(path) === workspace));
  invalidUnless([basename(inputFile), basename(outputFile)].every((name) => /^[A-Za-z0-9._-]+$/u.test(name)));
  return Object.freeze({
    session_id: validateSessionId(value.session_id),
    workspace,
    expected: validateExpected(value.expected),
    input_file: inputFile,
    output_file: outputFile,
  });
}

function validateExpected(value) {
  invalidUnless(exactKeys(value, ["provider", "model", "reasoning_effort"]));
  invalidUnless(value.provider === PROVIDER && [DEFAULT_MODEL, EXPERT_MODEL].includes(value.model) &&
    ["off", "on"].includes(value.reasoning_effort));
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    reasoning_effort: value.reasoning_effort,
  });
}

export function verifyReadOnlyEvidence(raw, expected, proofBytes, options = {}) {
  const decoded = decodeEvidence(raw, expected);
  const proofText = decodeProof(proofBytes, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  const witness = deriveWitness(proofText, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  const { events } = decoded;
  const common = verifyRoute(events, expected.expected);
  const additionalTurns = options.additionalTurns ?? 0;
  scenarioUnless(additionalTurns === 0 || additionalTurns === 1, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  const allTurnStarts = ofType(events, "turn/start");
  const allTurnEnds = ofType(events, "turn/end");
  scenarioUnless(allTurnStarts.length === 2 + additionalTurns && allTurnEnds.length === 2 + additionalTurns &&
    allTurnStarts.every((event, index) => event.data.turn === index + 1) &&
    allTurnEnds.every((event, index) => event.data.turn === index + 1),
  "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  const boundary = allTurnEnds[1];
  const readEvents = events.filter((event) => event.seq <= boundary.seq);
  const users = userMessages(readEvents);
  const starts = ofType(readEvents, "step/start");
  const ends = ofType(readEvents, "step/end");
  const answers = ofType(readEvents, "assistant/message");
  const calls = ofType(readEvents, "tool/call");
  const results = ofType(readEvents, "tool/result");
  const turnStarts = ofType(readEvents, "turn/start");
  const turnEnds = ofType(readEvents, "turn/end");
  scenarioUnless(users.length === 2 && starts.length === 3 && ends.length === 3 && answers.length === 3 &&
    calls.length === 1 && results.length === 1 && turnStarts.length === 2 && turnEnds.length === 2,
  "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  scenarioUnless(ofType(readEvents, "user/message").length === users.length &&
    ofType(readEvents, "approval/asked").length === 0 && ofType(readEvents, "approval/decided").length === 0,
  "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  if (additionalTurns === 0) {
    scenarioUnless(ofType(events, "tool/call").length === 1 && ofType(events, "tool/result").length === 1 &&
      ofType(events, "user/message").length === 2 && ofType(events, "approval/asked").length === 0 &&
      ofType(events, "approval/decided").length === 0, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  }
  requireTupleSequence(starts, [[1, 1], [1, 2], [2, 1]], "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  requireTupleSequence(ends, [[1, 1], [1, 2], [2, 1]], "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  requireTupleSequence(answers, [[1, 1], [1, 2], [2, 1]], "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  requireCompletedTurns(turnStarts, turnEnds, [1, 2], "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  scenarioUnless(!jsonContains(users[0].data.content, witness) && !jsonContains(users[1].data.content, witness) &&
    !jsonContains(answers[0].data.message?.content, witness), "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");

  const call = calls[0];
  const args = parseArguments(call, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  scenarioUnless(call.data.name === "read" && validCallId(call.data.callId) && tuple(call, 1, 1) &&
    exactOptionalKeys(args, ["file_path"], ["offset", "limit"]) && validReadWindow(args) &&
    typeof args.file_path === "string" && sameFile(expected.workspace, args.file_path, expected.proof_file),
  "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  requireAssistantCall(answers[0], call, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  const resultText = requireToolResult(results[0], call, "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  scenarioUnless(resultText.includes(witness) && textContent(answers[1].data.message?.content).includes(witness) &&
    textContent(answers[2].data.message?.content).includes(witness) &&
    !hasToolCall(answers[1]) && !hasToolCall(answers[2]) &&
    !readEvents.some((event) => event.type === "tool/call" && event.data.turn === 2),
  "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  requireOrdered([
    turnStarts[0], starts[0], users[0], answers[0], call, results[0], ends[0], starts[1], answers[1], ends[1], turnEnds[0],
    turnStarts[1], starts[2], users[1], answers[2], ends[2], turnEnds[1],
  ], "OFFICIAL_WEB_ACCEPTANCE_READONLY_INVALID");
  return Object.freeze({
    case: expected.case,
    session_id: expected.session_id,
    provider: expected.expected.provider,
    model: expected.expected.model,
    reasoning_effort: expected.expected.reasoning_effort,
    turns: 2,
    model_steps: 3,
    tool_calls: 1,
    followup_tool_calls: 0,
    selection_event_observed: common.selectionObserved,
    proof_sha256: sha256(proofBytes),
    session_sha256: sha256(Buffer.from(raw, "utf8")),
  });
}

export function verifyEditorEvidence(raw, expected, files) {
  const decoded = decodeEvidence(raw, expected);
  const beforeText = decodeProof(files.before, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const afterText = decodeProof(files.after, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const common = verifyRoute(decoded.events, expected.expected);
  const events = eventsForTurn(decoded.events, 3, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const users = userMessages(events);
  const starts = ofType(events, "step/start");
  const ends = ofType(events, "step/end");
  const answers = ofType(events, "assistant/message");
  const calls = ofType(events, "tool/call");
  const results = ofType(events, "tool/result");
  const turnStarts = ofType(events, "turn/start");
  const turnEnds = ofType(events, "turn/end");
  scenarioUnless(users.length === 1 && starts.length === 3 && ends.length === 3 && answers.length === 3 &&
    calls.length === 2 && results.length === 2 && turnStarts.length === 1 && turnEnds.length === 1 &&
    ofType(events, "approval/asked").length === 0 && ofType(events, "approval/decided").length === 0,
  "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const allCalls = ofType(decoded.events, "tool/call");
  scenarioUnless(allCalls.length === 3 && allCalls.map((event) => event.data.name).join("\n") === "read\nread\nedit" &&
    ofType(decoded.events, "tool/result").length === 3 && ofType(decoded.events, "user/message").length === 3 &&
    ofType(decoded.events, "approval/asked").length === 0 && ofType(decoded.events, "approval/decided").length === 0,
  "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  scenarioUnless(ofType(events, "user/message").length === users.length, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireTupleSequence(starts, [[3, 1], [3, 2], [3, 3]], "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireTupleSequence(ends, [[3, 1], [3, 2], [3, 3]], "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireTupleSequence(answers, [[3, 1], [3, 2], [3, 3]], "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireCompletedTurns(turnStarts, turnEnds, [3], "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");

  const readCall = calls[0];
  const editCall = calls[1];
  const readArgs = parseArguments(readCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const editArgs = parseArguments(editCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  scenarioUnless(readCall.data.name === "read" && validCallId(readCall.data.callId) && tuple(readCall, 3, 1) &&
    exactOptionalKeys(readArgs, ["file_path"], []) &&
    typeof readArgs.file_path === "string" &&
    sameFile(expected.workspace, readArgs.file_path, expected.after_file), "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  scenarioUnless(editCall.data.name === "edit" && validCallId(editCall.data.callId) && tuple(editCall, 3, 2) &&
    exactOptionalKeys(editArgs, ["file_path", "old_string", "new_string"], ["replace_all"]) &&
    typeof editArgs.file_path === "string" && sameFile(expected.workspace, editArgs.file_path, expected.after_file) &&
    typeof editArgs.old_string === "string" && editArgs.old_string !== "" &&
    typeof editArgs.new_string === "string" && editArgs.new_string !== editArgs.old_string &&
    (editArgs.replace_all === undefined || editArgs.replace_all === false), "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  scenarioUnless(readCall.data.callId !== editCall.data.callId, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireAssistantCall(answers[0], readCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireAssistantCall(answers[1], editCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const readResult = requireToolResult(results[0], readCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireToolResult(results[1], editCall, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const witness = deriveWitness(beforeText, "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID", [editArgs.old_string, editArgs.new_string]);
  scenarioUnless(!jsonContains(users[0].data.content, witness) && !jsonContains(answers[0].data.message?.content, witness) &&
    readResultCoversFile(readResult, beforeText) && editArgs.new_string.includes(witness),
  "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const first = beforeText.indexOf(editArgs.old_string);
  scenarioUnless(first >= 0 && beforeText.indexOf(editArgs.old_string, first + editArgs.old_string.length) === -1,
    "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  const expectedAfter = beforeText.slice(0, first) + editArgs.new_string + beforeText.slice(first + editArgs.old_string.length);
  scenarioUnless(afterText === expectedAfter && beforeText !== afterText && !hasToolCall(answers[2]),
    "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  requireOrdered([
    turnStarts[0], starts[0], users[0], answers[0], readCall, results[0], ends[0], starts[1], answers[1], editCall,
    results[1], ends[1], starts[2], answers[2], ends[2], turnEnds[0],
  ], "OFFICIAL_WEB_ACCEPTANCE_EDITOR_INVALID");
  return Object.freeze({
    session_id: expected.session_id,
    provider: expected.expected.provider,
    model: expected.expected.model,
    reasoning_effort: expected.expected.reasoning_effort,
    turns: 1,
    model_steps: 3,
    tool_calls: 2,
    selection_event_observed: common.selectionObserved,
    before_sha256: sha256(files.before),
    after_sha256: sha256(files.after),
    session_sha256: sha256(Buffer.from(raw, "utf8")),
  });
}

export function verifyPowerShellEvidence(raw, expected, files) {
  const decoded = decodeEvidence(raw, expected);
  const inputText = decodeProof(files.input, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const outputText = decodeProof(files.output, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const witness = deriveWitness(inputText, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const common = verifyRoute(decoded.events, expected.expected);
  const events = eventsForTurn(decoded.events, 3, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const users = userMessages(events);
  const starts = ofType(events, "step/start");
  const ends = ofType(events, "step/end");
  const answers = ofType(events, "assistant/message");
  const calls = ofType(events, "tool/call");
  const results = ofType(events, "tool/result");
  const asked = ofType(events, "approval/asked");
  const decided = ofType(events, "approval/decided");
  const turnStarts = ofType(events, "turn/start");
  const turnEnds = ofType(events, "turn/end");
  scenarioUnless(users.length === 1 && starts.length === 2 && ends.length === 2 && answers.length === 2 &&
    calls.length === 1 && results.length === 1 && asked.length === 1 && decided.length === 1 &&
    turnStarts.length === 1 && turnEnds.length === 1, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  scenarioUnless(ofType(events, "user/message").length === users.length, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const allCalls = ofType(decoded.events, "tool/call");
  scenarioUnless(allCalls.length === 2 && allCalls[0].data.name === "read" && allCalls[1].data.name === "pwsh" &&
    ofType(decoded.events, "tool/result").length === 2 && ofType(decoded.events, "user/message").length === 3 &&
    ofType(decoded.events, "approval/asked").length === 1 && ofType(decoded.events, "approval/decided").length === 1,
  "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireTupleSequence(starts, [[3, 1], [3, 2]], "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireTupleSequence(ends, [[3, 1], [3, 2]], "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireTupleSequence(answers, [[3, 1], [3, 2]], "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireCompletedTurns(turnStarts, turnEnds, [3], "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");

  const call = calls[0];
  const args = parseArguments(call, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const expectedCommand = `Copy-Item -LiteralPath '.\\${basename(expected.input_file)}' -Destination '.\\${basename(expected.output_file)}'`;
  scenarioUnless(call.data.name === "pwsh" && validCallId(call.data.callId) && tuple(call, 3, 1) &&
    exactOptionalKeys(args, ["command", "description"], ["timeoutMs"]) && args.command === expectedCommand &&
    typeof args.description === "string" && args.description.trim().length >= 5 && args.description.length <= 200 &&
    (args.timeoutMs === undefined || Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0 && args.timeoutMs <= 60_000),
  "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireAssistantCall(answers[0], call, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const commandResult = requireToolResult(results[0], call, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  scenarioUnless(typeof asked[0].data.id === "string" && asked[0].data.id !== "" && asked[0].data.toolName === "pwsh" &&
    asked[0].data.callId === call.data.callId && decided[0].data.id === asked[0].data.id &&
    decided[0].data.outcome === "allowed-once", "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  const outputCreatedAtEventMs = Math.floor(files.outputCreatedAtMs);
  scenarioUnless(typeof files.outputCreatedAtMs === "number" && Number.isFinite(files.outputCreatedAtMs) &&
    outputCreatedAtEventMs >= turnStarts[0].time && outputCreatedAtEventMs <= results[0].time,
  "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  scenarioUnless(!jsonContains(users[0].data.content, witness) && !jsonContains(answers[0].data.message?.content, witness) &&
    inputText === outputText && commandResult.trim() === "(no output)" && !hasToolCall(answers[1]),
  "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  requireOrdered([
    turnStarts[0], starts[0], users[0], answers[0], call, asked[0], decided[0], results[0], ends[0],
    starts[1], answers[1], ends[1], turnEnds[0],
  ], "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
  return Object.freeze({
    session_id: expected.session_id,
    provider: expected.expected.provider,
    model: expected.expected.model,
    reasoning_effort: expected.expected.reasoning_effort,
    turns: 1,
    model_steps: 2,
    tool_calls: 1,
    approvals_asked: 1,
    approvals_allowed_once: 1,
    output_created_during_turn: true,
    selection_event_observed: common.selectionObserved,
    input_sha256: sha256(files.input),
    output_sha256: sha256(files.output),
    session_sha256: sha256(Buffer.from(raw, "utf8")),
  });
}

async function createOfficialSessionReader(root, compression, signal) {
  signal?.throwIfAborted();
  const ctx = new Context();
  const fibers = [];
  try {
    fibers.push(await ctx.plugin(SessionStore));
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root, compression, packChunks: true }));
    const persistence = ctx.sessionPersistence;
    return {
      async read(sessionId, workspace, readSignal) {
        const location = persistence.locate({ id: SessionId(sessionId), cwd: workspace });
        if (basename(location.path) !== "session.jsonl.zstd") {
          throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
        }
        const before = await boundedArtifactStat(location.path, readSignal);
        let artifact;
        try {
          artifact = await persistence.readRaw(SessionId(sessionId), readSignal);
        } catch (cause) {
          throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_UNAVAILABLE", { cause });
        }
        if (artifact === undefined || artifact.meta.id !== sessionId || artifact.meta.cwd !== workspace ||
            artifact.meta.version !== SESSION_FORMAT_VERSION || artifact.meta.agentPreset !== "standard" ||
            artifact.meta.parentSession !== undefined || artifact.meta.origin !== undefined || artifact.meta.isSeeded !== false ||
            artifact.meta.delegationDepth !== 0 || artifact.filename !== "session.jsonl") {
          throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
        }
        const after = await boundedArtifactStat(location.path, readSignal);
        if (!sameStat(before, after) || Buffer.byteLength(artifact.content, "utf8") > MAX_DECOMPRESSED_SESSION_BYTES) {
          throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
        }
        return { raw: artifact.content };
      },
      async dispose() {
        for (const fiber of fibers.reverse()) await fiber.dispose();
      },
    };
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => undefined);
    if (error instanceof OfficialWebAcceptanceError) throw error;
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_UNAVAILABLE", { cause: error });
  }
}

async function boundedArtifactStat(path, signal) {
  signal?.throwIfAborted();
  try {
    await assertCanonicalPath(path, signal, "OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
    const info = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size > BigInt(MAX_SESSION_FILE_BYTES)) {
      throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
    }
    return info;
  } catch (cause) {
    if (cause instanceof OfficialWebAcceptanceError) throw cause;
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_UNAVAILABLE", { cause });
  }
}

async function loadProofFiles(manifest, reader, signal) {
  const paths = [
    ...manifest.readonly.map((entry) => entry.proof_file),
    manifest.editor.before_file,
    manifest.editor.after_file,
    manifest.pwsh.input_file,
    manifest.pwsh.output_file,
  ];
  const entries = await Promise.all(paths.map(async (path) => [
    path,
    await reader(path, MAX_PROOF_FILE_BYTES, signal, "OFFICIAL_WEB_ACCEPTANCE_PROOF_UNAVAILABLE"),
  ]));
  return new Map(entries);
}

async function readBoundedFile(path, maximum, signal, code) {
  signal?.throwIfAborted();
  try {
    await assertCanonicalPath(path, signal, code);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(maximum)) {
      throw new OfficialWebAcceptanceError(code);
    }
    const bytes = await readFile(path, { signal });
    const after = await lstat(path, { bigint: true });
    await assertCanonicalPath(path, signal, code);
    signal?.throwIfAborted();
    if (bytes.byteLength > maximum || bytes.byteLength !== Number(before.size) || !sameStat(before, after)) {
      throw new OfficialWebAcceptanceError(code);
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof OfficialWebAcceptanceError) throw cause;
    throw new OfficialWebAcceptanceError(code, { cause });
  }
}

async function assertDirectory(path, signal) {
  signal?.throwIfAborted();
  try {
    await assertCanonicalPath(path, signal, "OFFICIAL_WEB_ACCEPTANCE_ROOT_INVALID");
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a plain directory");
  } catch (cause) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_ROOT_INVALID", { cause });
  }
}

function decodeEvidence(raw, expected) {
  if (typeof raw !== "string" || !raw.endsWith("\n")) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
  }
  assertNoSensitivePersistence(raw);
  let decoded;
  try {
    decoded = decodeSessionLog(raw);
  } catch (cause) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID", { cause });
  }
  if (decoded.header?.type !== "session" || decoded.header.id !== expected.session_id ||
      decoded.header.cwd !== expected.workspace || decoded.events.length === 0) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SESSION_INVALID");
  }
  assertNoReasoningValue(decoded.events);
  return decoded;
}

function verifyRoute(events, expected) {
  const headers = ofType(events, "request/header");
  const contexts = ofType(events, "request/context");
  const assistants = ofType(events, "assistant/message");
  scenarioUnless(headers.length >= 1 && contexts.length >= 1 && assistants.length >= 1,
    "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID");
  scenarioUnless(assistants.every((assistant) => {
    const prefix = events.filter((event) => event.seq < assistant.seq);
    const header = foldRequestHeader(prefix);
    const context = ofType(prefix, "request/context").at(-1)?.data;
    return matchesHeader(header?.config, expected) && context?.provider === expected.provider &&
      context?.model === expected.model && assistant.data.message?.source?.provider === expected.provider &&
      assistant.data.message?.source?.model === expected.model;
  }), "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID");
  const firstTurn = ofType(events, "turn/start")[0];
  const selections = ofType(events, "model/selection");
  scenarioUnless(firstTurn !== undefined && selections.length >= 1 &&
    selections.every((event) => event.seq < firstTurn.seq),
    "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID");
  const selected = selections.at(-1).data;
  scenarioUnless(selected.provider === expected.provider && selected.model === expected.model &&
    normalizeEffort(selected.reasoningEffort) === expected.reasoning_effort,
  "OFFICIAL_WEB_ACCEPTANCE_ROUTE_INVALID");
  return { selectionObserved: true };
}

function matchesHeader(value, expected) {
  if (!isRecord(value) || value.provider !== expected.provider || value.model !== expected.model ||
      normalizeEffort(value.reasoningEffort) !== expected.reasoning_effort) return false;
  return true;
}

function normalizeEffort(value) {
  return value === undefined ? "off" : value;
}

function requireAssistantCall(answer, call, code) {
  const blocks = answer.data.message?.content;
  const calls = Array.isArray(blocks) ? blocks.filter((block) => block?.type === "tool-call") : [];
  scenarioUnless(calls.length === 1 && calls[0].name === call.data.name &&
    calls[0].id === call.data.callId && calls[0].arguments === call.data.arguments, code);
}

function requireToolResult(result, call, code) {
  const message = result?.data?.message;
  const blocks = message?.content;
  scenarioUnless(tuple(result, call.data.turn, call.data.step) && result.data.error === undefined &&
    message?.source?.kind === "tool" && message.source.callId === call.data.callId &&
    Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === "tool-result" &&
    blocks[0].toolCallId === call.data.callId && blocks[0].isError !== true &&
    Array.isArray(blocks[0].content) && blocks[0].content.every((block) => block?.type === "text" && typeof block.text === "string") &&
    Array.isArray(result.sourceEventSeqs) && result.sourceEventSeqs.includes(call.seq), code);
  return blocks[0].content.map((block) => block.text).join("");
}

function requireTupleSequence(events, expected, code) {
  scenarioUnless(events.length === expected.length && events.every((event, index) =>
    tuple(event, expected[index][0], expected[index][1])), code);
}

function requireCompletedTurns(starts, ends, turns, code) {
  scenarioUnless(starts.length === turns.length && ends.length === turns.length && turns.every((turn, index) =>
    starts[index].data.turn === turn && ends[index].data.turn === turn && ends[index].data.reason?.kind === "completed" &&
    starts[index].seq < ends[index].seq), code);
}

function eventsForTurn(events, turn, code) {
  const starts = ofType(events, "turn/start").filter((event) => event.data.turn === turn);
  const ends = ofType(events, "turn/end").filter((event) => event.data.turn === turn);
  const previousEnds = ofType(events, "turn/end").filter((event) => event.data.turn === turn - 1);
  scenarioUnless(starts.length === 1 && ends.length === 1 && previousEnds.length === 1 &&
    previousEnds[0].seq < starts[0].seq && starts[0].seq < ends[0].seq, code);
  return events.filter((event) => event.seq >= starts[0].seq && event.seq <= ends[0].seq);
}

function requireOrdered(events, code) {
  scenarioUnless(events.every((event, index) => event !== undefined && (index === 0 || event.seq > events[index - 1].seq)), code);
}

function parseArguments(call, code) {
  if (typeof call?.data?.arguments !== "string") throw new OfficialWebAcceptanceError(code);
  try {
    const parsed = JSON.parse(call.data.arguments);
    if (!isRecord(parsed)) throw new TypeError("arguments are not an object");
    return parsed;
  } catch (cause) {
    throw new OfficialWebAcceptanceError(code, { cause });
  }
}

function validCallId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

function validReadWindow(args) {
  return [args.offset, args.limit].every((value) => value === undefined || Number.isSafeInteger(value) && value > 0);
}

function readResultCoversFile(result, fileText) {
  const lines = fileText.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const expected = `${index + 1}: ${lines[index]}`;
    const found = result.indexOf(expected, cursor);
    if (found < 0) return false;
    cursor = found + expected.length;
  }
  return lines.length > 0;
}

async function fileBirthtimeMs(path, signal) {
  signal?.throwIfAborted();
  try {
    await assertCanonicalPath(path, signal, "OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
    const info = await lstat(path);
    signal?.throwIfAborted();
    if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.birthtimeMs) || info.birthtimeMs <= 0) {
      throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID");
    }
    return info.birthtimeMs;
  } catch (cause) {
    if (cause instanceof OfficialWebAcceptanceError) throw cause;
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_POWERSHELL_INVALID", { cause });
  }
}

async function assertCanonicalPath(path, signal, code) {
  signal?.throwIfAborted();
  try {
    const canonical = await realpath(path);
    signal?.throwIfAborted();
    if (platformPathKey(canonical) !== platformPathKey(resolve(path))) {
      throw new OfficialWebAcceptanceError(code);
    }
  } catch (cause) {
    if (cause instanceof OfficialWebAcceptanceError) throw cause;
    throw new OfficialWebAcceptanceError(code, { cause });
  }
}

function assertNoSensitivePersistence(raw) {
  if (/authorization|cookie|api[_-]?key|pairing[_-]?token|\bBearer\s+[A-Za-z0-9._~-]{8,}|"type"\s*:\s*"reasoning(?:[-_/][^"]*)?"/iu.test(raw)) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SENSITIVE_DATA");
  }
}

function assertNoReasoningValue(value) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (["reasoning", "reasoningText", "reasoning_content"].includes(key) && child !== undefined && child !== null && child !== "") {
        throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_SENSITIVE_DATA");
      }
      pending.push(child);
    }
  }
}

function decodeProof(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) throw new OfficialWebAcceptanceError(code);
  try {
    return UTF8.decode(bytes);
  } catch (cause) {
    throw new OfficialWebAcceptanceError(code, { cause });
  }
}

function deriveWitness(text, code, excluded = []) {
  const candidates = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length >= 16) candidates.push(line);
    const separator = Math.max(line.indexOf("="), line.indexOf(":"));
    if (separator >= 0) {
      const suffix = line.slice(separator + 1).trim();
      if (/^[A-Za-z0-9._-]{16,256}$/u.test(suffix)) candidates.unshift(suffix);
    }
  }
  const witness = candidates.find((candidate) => !excluded.some((value) => value === candidate));
  if (witness === undefined || witness.length > 512) throw new OfficialWebAcceptanceError(code);
  return witness;
}

function sameFile(workspace, actual, expected) {
  const resolvedActual = resolve(workspace, actual);
  return platformPathKey(resolvedActual) === platformPathKey(expected) && containsPath(workspace, resolvedActual);
}

function textContent(content) {
  return Array.isArray(content)
    ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
    : "";
}

function hasToolCall(answer) {
  return Array.isArray(answer?.data?.message?.content) && answer.data.message.content.some((block) => block?.type === "tool-call");
}

function userMessages(events) {
  return ofType(events, "user/message").filter((event) => event.data.source?.kind === "user");
}

function ofType(events, type) {
  return events.filter((event) => event.type === type);
}

function tuple(event, turn, step) {
  return event?.data?.turn === turn && event?.data?.step === step;
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function exactOptionalKeys(value, required, optional) {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function sameExpected(left, right) {
  return left.provider === right.provider && left.model === right.model && left.reasoning_effort === right.reasoning_effort;
}

function validateWorkspace(value, root) {
  const path = validateAbsolutePath(value);
  invalidUnless(containsPath(root, path) && platformPathKey(path) !== platformPathKey(root));
  return path;
}

function validateEvidencePath(value, root) {
  const path = validateAbsolutePath(value);
  invalidUnless(containsPath(root, path) && platformPathKey(path) !== platformPathKey(root));
  return path;
}

function validateAbsolutePath(value, code = "OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID") {
  if (typeof value !== "string" || value === "" || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) {
    throw new OfficialWebAcceptanceError(code);
  }
  return resolve(value);
}

function validateSessionId(value) {
  invalidUnless(typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/u.test(value));
  return value;
}

function containsPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function platformPathKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new OfficialWebAcceptanceError(code, { cause });
  }
}

function decodeUtf8(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch (cause) {
    throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID", { cause });
  }
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonContains(value, text) {
  return JSON.stringify(value).includes(text);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidUnless(condition) {
  if (!condition) throw new OfficialWebAcceptanceError("OFFICIAL_WEB_ACCEPTANCE_MANIFEST_INVALID");
}

function scenarioUnless(condition, code) {
  if (!condition) throw new OfficialWebAcceptanceError(code);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
