import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { seedProfile } from "../packages/dsh-web-agent-bundle/scripts/seed-profile.mjs";
import {
  RealWebSmokeError, assertExplicitOptIn, assertNoLayeredModelCredentials,
  decodeSessionLog, listSessionLogs, parseProfileDump, readNewFailureCause,
  runCommand, validateLaunchEnvironment, validateProfileManifest, validateProfileRows,
} from "./dsh-web-real-smoke.mjs";

const REPO = resolve(import.meta.dirname, "..");
const DSH = join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const BUNDLE = join(REPO, "packages", "dsh-web-agent-bundle");
const READONLY_PATCH = join(BUNDLE, "cordis.readonly.patch.yml");
const READY_PATCH = join(REPO, "tests", "real", "fixtures", "dsh-web-real-smoke", "browser-ready-barrier.patch.yml");
const PROFILE = "deepseek-web-agent";
const PROVIDER = "deepseek-web";
const MODEL = "current-web-session";
const READONLY_ROWS = new Map([
  ["readonly-sandbox-policy", ["@deepseek-ai/dsh-sandbox-policy", { mode: "read-only", workspaceRoot: { __jsExpr: "process.env.DSH_WEB_WORKSPACE_ROOT" } }]],
  ["readonly-fs-sandbox", ["@deepseek-ai/dsh-fs-sandbox", { cwd: { __jsExpr: "process.env.DSH_WEB_WORKSPACE_ROOT" } }]],
  ["deepseek-web-readonly-policy", ["@deepseek-pp/dsh-web-agent-bundle/readonly-policy", { workspaceRoot: { __jsExpr: "process.env.DSH_WEB_WORKSPACE_ROOT" } }]],
]);

/** Validate the same web-only base profile plus the fixed read-only composition. */
export function validateReadOnlyProfileDump(text) {
  const rows = parseProfileDump(text);
  if (!Array.isArray(rows)) throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  for (const [id, [name, config]] of READONLY_ROWS) {
    const selected = rows.filter((row) => row?.id === id);
    if (selected.length !== 1 || selected[0].name !== name ||
        Object.keys(selected[0]).some((key) => !["id", "name", "config"].includes(key)) ||
        !sameJson(selected[0].config, config)) {
      throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
    }
  }
  validateProfileRows(rows.filter((row) => !READONLY_ROWS.has(row?.id)));
}

/** Check actual Harness tool events, never infer a tool execution from prose. */
export function verifyReadOnlySession(raw, expected) {
  const invalid = () => { throw new RealWebSmokeError("REAL_WEB_TOOL_EVIDENCE_INVALID"); };
  if (!raw.endsWith("\n")) invalid();
  if (/reasoning|authorization|cookie|api[_-]?key|pairing[_-]?token/iu.test(raw) ||
      expected.forbiddenExact.some((value) => value !== "" && raw.includes(value))) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_SENSITIVE_DATA");
  }
  let header, events;
  try { ({ header, events } = decodeSessionLog(raw)); } catch { invalid(); }
  if (header?.type !== "session" || typeof header.id !== "string" || header.cwd !== expected.cwd) invalid();
  const ofType = (type) => events.filter((event) => event.type === type);
  const users = ofType("user/message");
  const starts = ofType("step/start"), ends = ofType("step/end");
  const answers = ofType("assistant/message");
  const calls = ofType("tool/call"), results = ofType("tool/result");
  const requestHeaders = ofType("request/header"), contexts = ofType("request/context");
  if (users.length !== 1 || starts.length !== 2 || ends.length !== 2 || answers.length !== 2 ||
      calls.length !== 1 || results.length !== 1 || ofType("turn/start").length !== 1 || ofType("turn/end").length !== 1 ||
      requestHeaders.length < 1 || contexts.length < 1) invalid();
  if (!sameJson(users[0].data.content, [{ type: "text", text: expected.task }]) ||
      expected.task.includes(expected.nonce) || JSON.stringify(answers[0]).includes(expected.nonce)) invalid();
  if (requestHeaders.some((event) => !sameJson(event.data.header?.config, { provider: PROVIDER, model: MODEL })) ||
      contexts.some((event) => event.data.provider !== PROVIDER || event.data.model !== MODEL)) invalid();
  for (let index = 0; index < 2; index++) {
    if ([starts[index], ends[index], answers[index]].some((event) => event.data.turn !== 1 || event.data.step !== index + 1) ||
        answers[index].data.message?.source?.provider !== PROVIDER || answers[index].data.message?.source?.model !== MODEL) invalid();
  }
  const call = calls[0], result = results[0];
  let args;
  try { args = JSON.parse(call.data.arguments); } catch { invalid(); }
  if (call.data.name !== "read" || typeof call.data.callId !== "string" || !call.data.callId ||
      call.data.turn !== 1 || call.data.step !== 1 || result.data.turn !== 1 || result.data.step !== 1 ||
      typeof args?.file_path !== "string" || !sameFile(expected.cwd, args.file_path, expected.fileName) ||
      Object.keys(args).some((key) => !["file_path", "offset", "limit"].includes(key))) invalid();
  const firstContent = answers[0].data.message?.content;
  if (!Array.isArray(firstContent)) invalid();
  const toolCalls = firstContent.filter((block) => block?.type === "tool-call");
  if (toolCalls.length !== 1 || toolCalls[0].name !== "read" || String(toolCalls[0].id) !== call.data.callId ||
      toolCalls[0].arguments !== call.data.arguments) invalid();
  const toolContent = result.data.message?.content;
  if (result.data.error !== undefined || result.data.message?.source?.kind !== "tool" ||
      !Array.isArray(toolContent) || toolContent.length !== 1 || toolContent[0].type !== "tool-result" ||
      String(toolContent[0].toolCallId) !== call.data.callId || toolContent[0].isError === true ||
      !Array.isArray(toolContent[0].content) || toolContent[0].content.some((block) => block.type !== "text") ||
      !toolContent[0].content.map((block) => block.text).join("").includes(expected.nonce)) invalid();
  if (!sameJson(answers[1].data.message?.content, [{ type: "text", text: expected.finalText }])) invalid();
  const turnStart = ofType("turn/start")[0], terminal = events.at(-1);
  if (turnStart.data.turn !== 1 || terminal?.type !== "turn/end" || terminal.data.turn !== 1 || terminal.data.reason?.kind !== "completed") invalid();
  const ordered = [turnStart, starts[0], users[0], requestHeaders[0], contexts[0], answers[0], call, result, ends[0], starts[1], answers[1], ends[1], terminal];
  if (ordered.some((event, index) => index > 0 && event.seq <= ordered[index - 1].seq)) invalid();
  return { sessionId: header.id, modelSteps: 2, toolCalls: 1 };
}

export async function runReadOnlyAcceptance(options, injected = {}) {
  return runToolAcceptance(options, injected, {
    patch: READONLY_PATCH, prepareFixture, validateProfileDump: validateReadOnlyProfileDump,
    createTask: (fixture) => ({
      task: `Use the read tool exactly once to read ${fixture.fileName}. Its text is proof=<value>. After receiving the tool result, reply with exactly DSH_WEB_TOOLS_OK:<value>, replacing <value> with the value read from the file. Do not guess or use another tool.`,
      finalText: `DSH_WEB_TOOLS_OK:${fixture.nonce}`,
    }),
    verifySession: verifyReadOnlySession,
    verifyFixture: (text, fixture) => {
      if (text !== `proof=${fixture.nonce}\n`) throw new RealWebSmokeError("REAL_WEB_FIXTURE_CHANGED");
      return {};
    },
  });
}

/** Shared opt-in lifecycle; scenarios specify evidence, never a second execution path. */
export async function runToolAcceptance(options, injected, scenario) {
  assertExplicitOptIn(options.args);
  const env = { ...options.env };
  const cwd = resolve(options.cwd);
  const configuration = validateLaunchEnvironment(env, options.nodeVersion ?? process.versions.node);
  const deps = { runCommand, prepareFixture: scenario.prepareFixture, readText: (path) => readFile(path, "utf8"), readOptionalText, listSessionLogs, ...injected };
  await assertNoLayeredModelCredentials(cwd, configuration.home, deps.readOptionalText);
  const command = (args, directory = cwd, timeoutMs = 30_000, commandEnv = env) => ({
    executable: process.execPath, args, cwd: directory, env: commandEnv, timeoutMs, shell: false, windowsHide: true,
  });
  const version = await deps.runCommand(command([DSH, "--version"], cwd, 15_000));
  if (version.exitCode !== 0 || version.stderr !== "" || version.stdout.trim() !== "0.1.2-rc.1") {
    throw new RealWebSmokeError("REAL_WEB_HARNESS_VERSION_MISMATCH");
  }
  const fixture = await deps.prepareFixture(cwd);
  const runEnv = { ...env, DSH_HOME: fixture.home, DSH_WEB_WORKSPACE_ROOT: fixture.workspace, DSH_TELEMETRY_DISABLED: "1" };
  const install = await deps.runCommand(command([DSH, "plugin", "--profile", PROFILE, "add", "--offline", "--workspace-root", BUNDLE], fixture.workspace, 30_000, runEnv));
  if (install.exitCode !== 0) throw new RealWebSmokeError("REAL_WEB_PROFILE_NOT_INSTALLED");
  validateProfileManifest(await deps.readText(join(fixture.home, "profiles", PROFILE, "package.json")));
  const patches = scenario.patches ?? [scenario.patch];
  const baseArgs = [DSH, "--profile", PROFILE, ...patches.flatMap((patch) => ["--patch", patch])];
  const dump = await deps.runCommand(command([...baseArgs, "--dump-config"], fixture.workspace, 30_000, runEnv));
  if (dump.exitCode !== 0 || dump.stderr !== "") throw new RealWebSmokeError("REAL_WEB_PROFILE_INVALID");
  scenario.validateProfileDump(dump.stdout);
  const sessionRoot = join(fixture.home, "sessions");
  const before = await deps.listSessionLogs(sessionRoot);
  const { task, finalText } = scenario.createTask(fixture);
  options.onReadyToConnect?.();
  const actual = await deps.runCommand(command([...baseArgs, "--patch", READY_PATCH, task], fixture.workspace, 180_000, runEnv));
  if (actual.exitCode !== 0) {
    if (/WAITING_FOR_BROWSER|REAL_WEB_BROWSER_NOT_READY/u.test(actual.stderr)) throw new RealWebSmokeError("REAL_WEB_BROWSER_NOT_READY");
    const causeCode = await readNewFailureCause(sessionRoot, before, { cwd: fixture.workspace, task }, deps);
    throw new RealWebSmokeError("REAL_WEB_DSH_FAILED", { causeCode });
  }
  if (actual.stderr !== "") throw new RealWebSmokeError("REAL_WEB_UNEXPECTED_DSH_STDERR");
  if (actual.stdout !== `${finalText}\n`) throw new RealWebSmokeError("REAL_WEB_RESPONSE_INVALID");
  const created = [...await deps.listSessionLogs(sessionRoot)].filter((path) => !before.has(path));
  if (created.length !== 1) throw new RealWebSmokeError("REAL_WEB_TOOL_EVIDENCE_INVALID");
  const evidence = scenario.verifySession(await deps.readText(join(sessionRoot, created[0])), {
    cwd: fixture.workspace, task, finalText, fileName: fixture.fileName, nonce: fixture.nonce,
    forbiddenExact: [configuration.pairingToken, ...configuration.allowedOrigins],
  });
  const fileEvidence = scenario.verifyFixture(await deps.readText(join(fixture.workspace, fixture.fileName)), fixture);
  return { schema_version: 1, ok: true, status: "completed", provider: PROVIDER, model: MODEL,
    run_id: fixture.id, session_id: evidence.sessionId, model_steps: evidence.modelSteps,
    tool_calls: evidence.toolCalls, tool_results: evidence.toolCalls, final_text_sha256: sha256(finalText),
    final_text_bytes: Buffer.byteLength(finalText, "utf8"), ...fileEvidence };
}

async function prepareFixture(cwd) {
  return prepareToolFixture(cwd, { prefix: "readonly", fileName: "proof.txt", initialText: (nonce) => `proof=${nonce}\n` });
}

/** Only creates a new owned fixture; existing files and past evidence are preserved. */
export async function prepareToolFixture(cwd, scenario) {
  const id = `${scenario.prefix}-${randomUUID()}`;
  const root = join(cwd, ".tmp-deepseek-live", `${scenario.prefix}-runs`, id);
  const workspace = join(root, "workspace"), home = join(root, "dsh-home");
  const fileName = scenario.fileName, nonce = randomBytes(16).toString("hex");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, fileName), scenario.initialText(nonce), { encoding: "utf8", flag: "wx" });
  seedProfile(home);
  return { id, root, workspace, home, fileName, nonce };
}

async function readOptionalText(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
// Evidence compares the fixed generated file, not the model's spelling of it.
// Production path admission still belongs exclusively to the DSH policy.
export function sameFile(cwd, actual, expected) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(cwd, actual)) === normalize(resolve(cwd, expected));
}
export function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export async function main(args, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  try {
    const result = await runReadOnlyAcceptance({ args, env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), nodeVersion: options.nodeVersion,
      onReadyToConnect: () => stderr.write("本地只读工具已准备，正在等待浏览器连接；如果扩展显示离线，请在「本机 Harness」再点一次保存。\n"),
    }, options.dependencies);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof RealWebSmokeError ? error.code : "REAL_WEB_ACCEPTANCE_INTERNAL_ERROR";
    stderr.write(`${JSON.stringify({ schema_version: 1, ok: false, status: "failed", error: code,
      ...(error instanceof RealWebSmokeError && error.causeCode ? { cause_code: error.causeCode } : {}) })}\n`);
    return code === "REAL_WEB_CONFIRMATION_REQUIRED" || code === "REAL_WEB_ARGUMENTS_INVALID" ? 2 : 1;
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
