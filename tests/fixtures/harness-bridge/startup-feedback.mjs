import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export const name = "startup-feedback-fixture";

/** Original-CLI fixture; no browser, model request, or product user home. */
export async function apply(ctx) {
  const mode = process.env.DSH_FEEDBACK_FIXTURE_MODE;
  const marker = join(process.cwd(), "lifecycle.json");
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await writeFile(marker, JSON.stringify({ pid: process.pid, port, closed: false, ready: false }));
  let ready = false;
  const cancelReady = ctx.appReady.onReady(() => {
    ready = true;
    if (mode === "stdio") {
      process.stdout.write("\u001b[32m网页模型终答：\u001b[0m\n");
      process.stdin.once("data", (data) => { process.stdout.write(data); ctx.appExit(0); });
      process.stdin.resume();
    } else ctx.appExit(0);
  });
  let cancelTimer;
  ctx.effect(() => async () => {
    clearTimeout(cancelTimer);
    cancelReady();
    process.stdin.pause();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    await writeFile(marker, JSON.stringify({ pid: process.pid, port, closed: true, ready }));
  }, "feedback-fixture-server");
  ctx.provide("deepseekWebBroker", {
    get hasAuthenticatedPeer() {
      if (mode === "unknown") throw new Error("UNEXPECTED_FIXTURE_FAILURE");
      return mode === "stdio";
    },
  });
  // Node's own event path exercises SIGINT on Windows as well as Unix.
  // OS console Ctrl+C delivery itself remains a real terminal acceptance item.
  if (mode === "cancel") cancelTimer = setTimeout(() => process.emit("SIGINT"), 120);
}
