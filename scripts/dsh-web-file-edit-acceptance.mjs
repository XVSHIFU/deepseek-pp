import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { RealWebSmokeError, decodeSessionLog, parseProfileDump, validateProfileRows } from "./dsh-web-real-smoke.mjs";
import { isExpectedWebConfig, prepareToolFixture, runToolAcceptance, sameFile, sameJson } from "./dsh-web-readonly-acceptance.mjs";

const PROVIDER = "deepseek-web", MODEL = "current-web-session";
const PATCH = resolve(import.meta.dirname, "../packages/dsh-web-agent-bundle/cordis.workspace-files.patch.yml");
const ROOT_EXPRESSION = { __jsExpr: "process.env.DSH_WEB_WORKSPACE_ROOT" };
const FILE_ROWS = [
  { id: "workspace-sandbox-policy", name: "@deepseek-ai/dsh-sandbox-policy", config: { mode: "workspace-write", workspaceRoot: ROOT_EXPRESSION } },
  { id: "workspace-fs-sandbox", name: "@deepseek-ai/dsh-fs-sandbox", config: { cwd: ROOT_EXPRESSION } },
  { id: "workspace-fs-observation-policy", name: "@deepseek-ai/dsh-fs-observation-policy" },
  { id: "workspace-user-approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: "ask" } },
  { id: "deepseek-web-workspace-files-policy", name: "@deepseek-pp/dsh-web-agent-bundle/workspace-files-policy", config: { workspaceRoot: ROOT_EXPRESSION } },
];

export function validateFileEditProfileDump(text) {
  const rows = parseProfileDump(text);
  if (!Array.isArray(rows)) throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  for (const expected of FILE_ROWS) {
    const matches = rows.filter((row) => row?.id === expected.id);
    if (matches.length !== 1 || !sameJson(matches[0], expected)) throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  }
  validateProfileRows(rows.filter((row) => !FILE_ROWS.some((expected) => expected.id === row?.id)));
}

export function createFileEditTask(fixture) {
  return {
    task: `Use str_replace_editor only. FILE_EDIT_TARGET_JSON=${JSON.stringify(join(fixture.workspace, fixture.fileName))}\nFirst use command view exactly once on this absolute path. Its contents contain file-edit-nonce=<value> and state=pending. After the view result, use command str_replace exactly once on the same file with old_str equal to state=pending and new_str equal to state=verified-<value>, taking <value> only from the view result. Do not modify the nonce line or any other file. After the successful edit result, reply with exactly Edit complete: state=verified-<value>. Do not retry an edit or use any other command.`,
    finalText: `Edit complete: state=verified-${fixture.nonce}`,
  };
}

/** Requires actual correlated view and edit results; a plausible final alone is not acceptance. */
export function verifyFileEditSession(raw, expected) {
  const invalid = () => { throw new RealWebSmokeError("REAL_WEB_TOOL_EVIDENCE_INVALID"); };
  if (!raw.endsWith("\n")) invalid();
  if (/authorization|cookie|api[_-]?key|pairing[_-]?token|"type"\s*:\s*"reasoning(?:-delta)?"/iu.test(raw) ||
      expected.forbiddenExact.some((value) => value !== "" && raw.includes(value))) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_SENSITIVE_DATA");
  }
  let header, events;
  try { ({ header, events } = decodeSessionLog(raw)); } catch { invalid(); }
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id || header.cwd !== expected.cwd) invalid();
  const ofType = (type) => events.filter((event) => event.type === type);
  const users = ofType("user/message"), starts = ofType("step/start"), ends = ofType("step/end");
  const answers = ofType("assistant/message"), calls = ofType("tool/call"), results = ofType("tool/result");
  const requestHeaders = ofType("request/header"), contexts = ofType("request/context");
  if (users.length !== 1 || starts.length !== 3 || ends.length !== 3 || answers.length !== 3 ||
      calls.length !== 2 || results.length !== 2 || ofType("turn/start").length !== 1 || ofType("turn/end").length !== 1 ||
      requestHeaders.length < 1 || contexts.length < 1) invalid();
  if (!sameJson(users[0].data.content, [{ type: "text", text: expected.task }]) || expected.task.includes(expected.nonce) ||
      JSON.stringify(answers[0]).includes(expected.nonce)) invalid();
  if (requestHeaders.some((event) => !isExpectedWebConfig(event.data.header?.config, PROVIDER, MODEL)) ||
      contexts.some((event) => event.data.provider !== PROVIDER || event.data.model !== MODEL)) invalid();
  for (let index = 0; index < 3; index++) {
    if ([starts[index], ends[index], answers[index]].some((event) => event.data.turn !== 1 || event.data.step !== index + 1) ||
        answers[index].data.message?.source?.provider !== PROVIDER || answers[index].data.message?.source?.model !== MODEL) invalid();
  }
  if (calls[0].data.callId === calls[1].data.callId) invalid();
  for (let index = 0; index < 2; index++) {
    const call = calls[index], result = results[index];
    let args;
    try { args = JSON.parse(call.data.arguments); } catch { invalid(); }
    const expectedArgs = index === 0 ? { command: "view", path: args?.path }
      : { command: "str_replace", path: args?.path, old_str: "state=pending", new_str: `state=verified-${expected.nonce}` };
    // The official editor accepts null placeholders for unused schema fields.
    // Preserve those legitimate calls instead of forcing model-specific spelling.
    const unused = index === 0 ? ["old_str", "new_str", "file_text", "insert_line", "view_range"]
      : ["file_text", "insert_line", "view_range"];
    const normalizedArgs = args && typeof args === "object" && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args).filter(([key, value]) => !(unused.includes(key) && value === null))) : args;
    if (call.data.name !== "str_replace_editor" || typeof call.data.callId !== "string" || !call.data.callId ||
        call.data.turn !== 1 || call.data.step !== index + 1 || result.data.turn !== 1 || result.data.step !== index + 1 ||
        !sameJson(normalizedArgs, expectedArgs) || typeof args?.path !== "string" || !isAbsolute(args.path) ||
        !sameFile(expected.cwd, args.path, expected.fileName)) invalid();
    const content = answers[index].data.message?.content;
    if (!Array.isArray(content)) invalid();
    const blocks = content.filter((block) => block?.type === "tool-call");
    if (blocks.length !== 1 || blocks[0].name !== call.data.name || String(blocks[0].id) !== call.data.callId ||
        blocks[0].arguments !== call.data.arguments) invalid();
    const toolContent = result.data.message?.content;
    if (result.data.error !== undefined || result.data.message?.source?.kind !== "tool" ||
        result.data.message?.source?.callId !== call.data.callId || !Array.isArray(toolContent) || toolContent.length !== 1 ||
        toolContent[0].type !== "tool-result" || String(toolContent[0].toolCallId) !== call.data.callId ||
        toolContent[0].isError === true || !Array.isArray(toolContent[0].content) ||
        toolContent[0].content.some((block) => block.type !== "text" || typeof block.text !== "string")) invalid();
    const text = toolContent[0].content.map((block) => block.text).join("");
    if (index === 0 && (!text.includes(`file-edit-nonce=${expected.nonce}`) || !text.includes("state=pending"))) invalid();
    // The pinned editor returns a success marker, not a post-edit snippet.
    // The independently read file below is the authority for the actual bytes.
    if (index === 1 && !text.includes("has been edited successfully")) invalid();
  }
  if (!sameJson(answers[2].data.message?.content, [{ type: "text", text: expected.finalText }])) invalid();
  const turnStart = ofType("turn/start")[0], terminal = events.at(-1);
  if (turnStart.data.turn !== 1 || terminal?.type !== "turn/end" || terminal.data.turn !== 1 || terminal.data.reason?.kind !== "completed") invalid();
  const ordered = [turnStart, starts[0], users[0], requestHeaders[0], contexts[0], answers[0], calls[0], results[0], ends[0],
    starts[1], answers[1], calls[1], results[1], ends[1], starts[2], answers[2], ends[2], terminal];
  if (ordered.some((event, index) => index > 0 && event.seq <= ordered[index - 1].seq)) invalid();
  return { sessionId: header.id, modelSteps: 3, toolCalls: 2 };
}

export async function runFileEditAcceptance(options, injected = {}) {
  return runToolAcceptance(options, injected, {
    patch: PATCH, validateProfileDump: validateFileEditProfileDump, createTask: createFileEditTask,
    prepareFixture: (cwd) => prepareToolFixture(cwd, {
      prefix: "file-edit", fileName: "file-edit-proof.txt", initialText: (nonce) => `file-edit-nonce=${nonce}\nstate=pending\n`,
    }),
    verifySession: verifyFileEditSession,
    verifyFixture: (text, fixture) => {
      if (text !== `file-edit-nonce=${fixture.nonce}\nstate=verified-${fixture.nonce}\n`) {
        throw new RealWebSmokeError("REAL_WEB_FILE_EDIT_NOT_APPLIED");
      }
      return { file_verified: true, file_sha256: createHash("sha256").update(text).digest("hex") };
    },
  });
}

export async function main(args, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  try {
    const result = await runFileEditAcceptance({ args, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env,
      nodeVersion: options.nodeVersion,
      onReadyToConnect: () => stderr.write("本地文件编辑工具已准备，正在等待浏览器连接；如果扩展显示离线，请在「本机 Harness」再点一次保存。\n"),
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
