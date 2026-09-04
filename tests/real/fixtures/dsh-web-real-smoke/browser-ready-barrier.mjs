export const name = "real-web-browser-ready-barrier";
export const inject = ["deepseekWebBroker"];

export async function apply(ctx) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (ctx.deepseekWebBroker?.hasAuthenticatedPeer === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("REAL_WEB_BROWSER_NOT_READY");
}
