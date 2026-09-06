export const name = "deepseek-web-browser-ready";
export const inject = ["deepseekWebBroker"];

/** Holds official Loader settlement, not the Agent loop, until a real authenticated peer is ready. */
export async function apply(ctx) {
  const wait = Number(process.env.DSH_WEB_BROWSER_WAIT_MS ?? 60000);
  if (!Number.isInteger(wait) || wait < 100 || wait > 60000) throw new Error("START_BROWSER_WAIT_INVALID");
  const deadline = Date.now() + wait;
  let aborted = false;
  const abort = () => { aborted = true; };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    while (!ctx.deepseekWebBroker.hasAuthenticatedPeer) {
      if (aborted) throw new Error("BROWSER_WAIT_CANCELLED");
      if (Date.now() >= deadline) throw new Error("WAITING_FOR_BROWSER");
      await new Promise((resume) => setTimeout(resume, Math.min(50, deadline - Date.now())));
    }
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
