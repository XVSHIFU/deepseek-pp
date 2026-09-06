import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { parseTerminalArguments, terminalText } from "./terminal-options.mjs";

export const name = "deepseek-web-terminal-app";
export const inject = ["agents", "sessions", "sessionPersistence", "agentDefaultModel", "cmdlineArgs"];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Checks the official immutable header before the official resume commits. */
export async function validateResumeHeader(header, workspace) {
  if (header.origin === "subagent" || header.parentSession !== undefined || header.isSeeded === true || (header.delegationDepth ?? 0) !== 0) fail("START_RESUME_ROOT_SESSION_REQUIRED");
  if (typeof header.cwd !== "string" || !isAbsolute(header.cwd) || await realpath(header.cwd) !== workspace) fail("START_RESUME_WORKSPACE_MISMATCH");
}

/** Initial product resume is intentionally limited to an empty or completed root. */
export function validateResumeTail(lastEvent, hasPending = false, beforeMarker) {
  // The official Session constructor appends this public lifecycle marker on
  // resume; it is not unfinished work and contains no replay instruction.
  if (lastEvent?.type === "session/end-seed") lastEvent = beforeMarker;
  if (hasPending || lastEvent !== undefined && (lastEvent.type !== "turn/end" || lastEvent.data.reason.kind !== "completed")) fail("START_RESUME_NOT_QUIESCENT");
}

/** A terminal view/controller; every turn, tool call, cancel and disk record is Harness-owned. */
export function apply(ctx) {
  if (!ctx.appReady || !ctx.appExit) fail("START_TERMINAL_LAUNCHER_REQUIRED");
  const options = parseTerminalArguments(ctx.cmdlineArgs.get());
  let input, handle, interrupted = false, stopping = false, completed = false;
  let disposeHandle;
  const disposeAgent = () => disposeHandle ??= handle?.dispose();
  const interrupt = () => {
    if (completed || interrupted) return;
    interrupted = true; stopping = true;
    handle?.agent.cancel({ kind: "user" });
    input?.close();
    ctx.appExit(130);
  };
  ctx.effect(() => {
    process.on("SIGINT", interrupt);
    return async () => {
      stopping = true;
      process.off("SIGINT", interrupt);
      input?.close();
      await disposeAgent();
    };
  });

  const run = async () => {
    const workspace = await realpath(process.cwd());
    const selection = ctx.agentDefaultModel.currentSelection();
    if (selection.provider !== "deepseek-web" || selection.model !== "current-web-session") fail("START_TERMINAL_MODEL_INVALID");
    const setup = async (agentCtx) => {
      if (options.resume !== undefined) {
        const agent = agentCtx.agent;
        await validateResumeHeader(agent.session.header, workspace);
        validateResumeTail(agent.session.seq === 0 ? undefined : agent.session.eventAt(agent.session.seq - 1), agent.inbox.hasPending, agent.session.seq < 2 ? undefined : agent.session.eventAt(agent.session.seq - 2));
      }
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };
    const agentOptions = { provider: selection.provider, model: selection.model };
    if (options.resume !== undefined) {
      const inspection = await ctx.sessionPersistence.inspect(options.resume);
      await validateResumeHeader(inspection.meta, workspace);
      validateResumeTail(inspection.events.at(-1), false, inspection.events.at(-2));
      handle = await ctx.agents.resume({ resumeSessionId: options.resume, agentOptions, setup });
    } else {
      handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: workspace }, agentOptions, setup });
    }
    if (stopping) { await disposeAgent(); return; }
    const agent = handle.agent;
    await agent.whenIdle();
    await ctx.sessionPersistence.ensureMaterialized(agent.session);
    process.stdout.write(`会话：${agent.session.id}\n输入任务后回车；/exit 退出并保留会话，Ctrl+C 取消并退出。\n`);
    ctx.on("session/event", (session, event) => {
      if (session !== agent.session) return;
      if (event.type === "assistant/message") {
        const text = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        if (text) process.stdout.write(`${terminalText(text)}\n`);
      } else if (event.type === "tool/call") {
        process.stderr.write(`工具：${terminalText(event.data.name ?? event.data.toolCall?.name ?? "正在执行")}\n`);
      } else if (event.type === "turn/end" && event.data.reason.kind === "error") {
        const code = event.data.reason.error.code;
        process.stderr.write(`本轮失败：${/^[A-Z][A-Z0-9_]+$/u.test(code) ? code : "HARNESS_TURN_FAILED"}；不会自动重发。\n`);
      }
    });
    // This FIFO only preserves terminal input order. followup/whenIdle are the
    // official inbox/whole-agent lifetime; there is no model or tool loop here.
    let queue = Promise.resolve(), pendingBytes = 0, failure;
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), crlfDelay: Infinity });
    input.setPrompt("你 > ");
    if (input.terminal) input.prompt();
    input.on("SIGINT", interrupt);
    input.on("line", (line) => {
      pendingBytes += Buffer.byteLength(line, "utf8");
      if (line.length > 262144 || pendingBytes > 1048576) {
        failure = Object.assign(new Error("START_INPUT_LIMIT"), { code: "START_INPUT_LIMIT" });
        stopping = true; agent.cancel({ kind: "user" }); input.close(); return;
      }
      queue = queue.then(async () => {
        pendingBytes -= Buffer.byteLength(line, "utf8");
        if (stopping) return;
        if (line.trim() === "/exit") { stopping = true; input.close(); return; }
        if (line.trim()) {
          agent.followup(createUserMessage({ content: [{ type: "text", text: line }], source: { kind: "user" } }));
          await agent.whenIdle();
          await ctx.sessions.flush(agent.session);
        }
        if (!stopping && input.terminal) input.prompt();
      }).catch((error) => { failure = error; stopping = true; input.close(); });
    });
    await new Promise((done) => input.once("close", done));
    await queue; // EOF must not discard lines already admitted by readline.
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    await disposeAgent();
    if (failure !== undefined) throw failure;
    completed = true;
    ctx.appExit(interrupted ? 130 : 0);
  };
  ctx.appReady.onReady(() => {
    run().catch((error) => {
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/u.test(error.code) ? error.code : "START_TERMINAL_FAILED";
      process.stderr.write(`${code}\n`);
      ctx.appExit(1);
    });
  });
}
