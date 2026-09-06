export const name = "deepseek-web-browser-ready";
export const inject = ["deepseekWebBroker"];

function stopWaiting(ctx, code, exitCode, message) {
  // Missing host exit support is a genuine composition error, not permission to
  // release the startup barrier and accidentally begin a model request.
  if (typeof ctx.appExit !== "function") throw Object.assign(new Error(code), { code });
  process.stderr.write(`${code}: ${message}\n`);
  // Public DSH lifecycle: dispose the whole application before recording exit.
  // No exception is needed for an expected, recoverable browser-unavailable state.
  ctx.appExit(exitCode);
}

/** Holds official Loader settlement, not the Agent loop, until a real authenticated peer is ready. */
export async function apply(ctx) {
  const wait = Number(process.env.DSH_WEB_BROWSER_WAIT_MS ?? 60000);
  if (!Number.isInteger(wait) || wait < 100 || wait > 60000) throw new Error("START_BROWSER_WAIT_INVALID");
  const deadline = Date.now() + wait;
  let aborted = false;
  // The CLI's own signal handler already owns shutdown. Report synchronously:
  // its disposer can complete before the next polling tick runs.
  const abort = () => {
    if (aborted) return;
    aborted = true;
    process.stderr.write("BROWSER_WAIT_CANCELLED: 已取消等待浏览器；未开始任务。\n");
  };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    while (!ctx.deepseekWebBroker.hasAuthenticatedPeer) {
      if (aborted) return;
      if (Date.now() >= deadline) return stopWaiting(ctx, "WAITING_FOR_BROWSER", 1, "等待浏览器连接超时；请打开已登录的 DeepSeek 网页，在扩展「本机 Harness」保存连接设置，然后重新运行本条命令。");
      await new Promise((resume) => setTimeout(resume, Math.min(50, deadline - Date.now())));
    }
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
