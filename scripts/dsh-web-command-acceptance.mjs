import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

import { RealWebSmokeError, assertExplicitOptIn, decodeSessionLog, parseProfileDump, validateProfileRows } from "./dsh-web-real-smoke.mjs";
import { prepareToolFixture, runToolAcceptance, sameJson } from "./dsh-web-readonly-acceptance.mjs";

const BUNDLE = resolve(import.meta.dirname, "../packages/dsh-web-agent-bundle");
const PROVIDER = "deepseek-web", MODEL = "current-web-session";
export const COMMAND_PATCHES = ["cordis.workspace-files.patch.yml", "cordis.harness-features.patch.yml", "cordis.linux-commands.patch.yml"]
  .map((name) => join(BUNDLE, name));
export const LINUX_INPUT_FILE = "linux-command-input.txt";
export const LINUX_OUTPUT_FILE = "linux-command-created.txt";
export const LINUX_COMMAND = [
  "set -eu",
  `IFS= read -r nonce < ${LINUX_INPUT_FILE}`,
  'test "${#nonce}" -eq 32',
  'test "$((6 * 7))" -eq 42',
  `printf 'command-proof=%s\\n' "$nonce" > ${LINUX_OUTPUT_FILE}`,
  `IFS= read -r persisted < ${LINUX_OUTPUT_FILE}`,
  'test "$persisted" = "command-proof=$nonce"',
  'printf "DSH_LINUX_COMMAND_OK:%s\\n" "$nonce"',
].join("\n");

/** Match the trusted installed composition, using the official patch merger. */
export function validateCommandProfileDump(text) {
  const base = loadOverlayPatches("command-acceptance-base", join(BUNDLE, "cordis.patch.yml"));
  validateProfileRows(composeEntries([base]));
  const expected = composeEntries([base, ...COMMAND_PATCHES.map((path) => loadOverlayPatches("command-acceptance", path))]);
  if (!sameJson(parseProfileDump(text), expected)) throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
}

export function createCommandTask(fixture) {
  return {
    task: `Use bash exactly once in the already selected workspace. Execute the following fixed command verbatim, using only the command and description fields and optionally timeoutMs: 5000. Do not supply workdir, environment, permissions or background fields. The command reads a fixture value, creates a verification file and runs short checks; the value is intentionally not supplied here. Do not read any other file, call another tool or retry the command. If the tool succeeds, reply with exactly Linux command verified: <value>, replacing <value> only with the value from DSH_LINUX_COMMAND_OK in the tool result. If it fails, stop and report failure.\n\n${LINUX_COMMAND}`,
    finalText: `Linux command verified: ${fixture.nonce}`,
  };
}

/** One real correlated bash call, its exact successful output, then a web final. */
export function verifyCommandSession(raw, expected) {
  const invalid = () => { throw new RealWebSmokeError("REAL_WEB_TOOL_EVIDENCE_INVALID"); };
  if (!raw.endsWith("\n")) invalid();
  if (/reasoning|authorization|cookie|api[_-]?key|pairing[_-]?token/iu.test(raw)
    || expected.forbiddenExact.some((value) => value !== "" && raw.includes(value))) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_SENSITIVE_DATA");
  }
  let header, events;
  try { ({ header, events } = decodeSessionLog(raw)); } catch { invalid(); }
  if (header?.type !== "session" || !header.id || header.cwd !== expected.cwd) invalid();
  const ofType = (type) => events.filter((event) => event.type === type);
  const users = ofType("user/message").filter((event) => event.data.source?.kind === "user");
  const starts = ofType("step/start"), ends = ofType("step/end"), answers = ofType("assistant/message");
  const calls = ofType("tool/call"), results = ofType("tool/result");
  const headers = ofType("request/header"), contexts = ofType("request/context");
  if (users.length !== 1 || starts.length !== 2 || ends.length !== 2 || answers.length !== 2
    || calls.length !== 1 || results.length !== 1 || ofType("turn/start").length !== 1 || ofType("turn/end").length !== 1
    || headers.length < 1 || contexts.length < 1 || expected.task.includes(expected.nonce)
    || !sameJson(users[0].data.content, [{ type: "text", text: expected.task }])) invalid();
  if (headers.some((event) => !sameJson(event.data.header?.config, { provider: PROVIDER, model: MODEL }))
    || contexts.some((event) => event.data.provider !== PROVIDER || event.data.model !== MODEL)) invalid();
  for (let index = 0; index < 2; index++) {
    if ([starts[index], ends[index], answers[index]].some((event) => event.data.turn !== 1 || event.data.step !== index + 1)
      || answers[index].data.message?.source?.provider !== PROVIDER || answers[index].data.message?.source?.model !== MODEL) invalid();
  }
  const call = calls[0], result = results[0];
  let args;
  try { args = JSON.parse(call.data.arguments); } catch { invalid(); }
  if (call.data.name !== "bash" || typeof call.data.callId !== "string" || !call.data.callId
    || call.data.turn !== 1 || call.data.step !== 1 || result.data.turn !== 1 || result.data.step !== 1
    || typeof args?.command !== "string" || args.command.replaceAll("\r\n", "\n").trim() !== LINUX_COMMAND
    || typeof args.description !== "string" || Object.keys(args).some((key) => !["command", "description", "timeoutMs"].includes(key))
    || (args.timeoutMs !== undefined && !(Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 && args.timeoutMs <= 60_000))) invalid();
  const modelCalls = answers[0].data.message?.content?.filter((block) => block.type === "tool-call");
  if (modelCalls?.length !== 1 || modelCalls[0].name !== "bash" || modelCalls[0].id !== call.data.callId
    || modelCalls[0].arguments !== call.data.arguments) invalid();
  const blocks = result.data.message?.content;
  if (result.data.error !== undefined || result.data.message?.source?.kind !== "tool"
    || result.data.message.source.callId !== call.data.callId || !Array.isArray(blocks) || blocks.length !== 1
    || blocks[0].type !== "tool-result" || blocks[0].toolCallId !== call.data.callId || blocks[0].isError === true
    || !Array.isArray(blocks[0].content) || blocks[0].content.some((block) => block.type !== "text" || typeof block.text !== "string")
    || blocks[0].content.map((block) => block.text).join("") !== `DSH_LINUX_COMMAND_OK:${expected.nonce}\n`) invalid();
  // The original Bash renderer appends markers for stderr/non-zero exit,
  // timeout or denial. Exact stdout above therefore rejects those outcomes too.
  if (events.some((event) => event.seq <= call.seq && JSON.stringify(event).includes(expected.nonce))
    || !sameJson(answers[1].data.message?.content, [{ type: "text", text: expected.finalText }])) invalid();
  const start = ofType("turn/start")[0], terminal = events.at(-1);
  if (start.data.turn !== 1 || terminal?.type !== "turn/end" || terminal.data.turn !== 1 || terminal.data.reason?.kind !== "completed") invalid();
  const ordered = [start, starts[0], users[0], headers[0], contexts[0], answers[0], call, result, ends[0], starts[1], answers[1], ends[1], terminal];
  if (ordered.some((event, index) => index > 0 && event.seq <= ordered[index - 1].seq)) invalid();
  return { sessionId: header.id, modelSteps: 2, toolCalls: 1 };
}

export function createCommandAcceptanceScenario() {
  return {
    patches: COMMAND_PATCHES, validateProfileDump: validateCommandProfileDump, createTask: createCommandTask,
    prepareFixture: (cwd) => prepareToolFixture(cwd, { prefix: "command", fileName: LINUX_INPUT_FILE, initialText: (nonce) => `${nonce}\n` }),
    verifySession: verifyCommandSession,
    verifyFixture: (input, fixture) => {
      if (input !== `${fixture.nonce}\n`) throw new RealWebSmokeError("REAL_WEB_FIXTURE_CHANGED");
      let output;
      try { output = readFileSync(join(fixture.workspace, LINUX_OUTPUT_FILE), "utf8"); }
      catch { throw new RealWebSmokeError("REAL_WEB_COMMAND_FILE_NOT_CREATED"); }
      if (output !== `command-proof=${fixture.nonce}\n`) throw new RealWebSmokeError("REAL_WEB_COMMAND_FILE_INVALID");
      return { command_verified: true, file_verified: true, test_verified: true, file_sha256: createHash("sha256").update(output).digest("hex") };
    },
  };
}

export async function runCommandAcceptance(options, injected = {}) {
  assertExplicitOptIn(options.args);
  if (process.platform !== "linux") throw new RealWebSmokeError("REAL_WEB_COMMAND_REQUIRES_LINUX");
  return runToolAcceptance(options, injected, createCommandAcceptanceScenario());
}

export async function main(args, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  try {
    const result = await runCommandAcceptance({ args, env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), nodeVersion: options.nodeVersion,
      onReadyToConnect: () => stderr.write("本地 Linux 命令工具已准备，正在等待浏览器连接；若扩展显示离线，请在「本机 Harness」再点一次保存。\n"),
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
