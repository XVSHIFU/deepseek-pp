import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, createRuntimeEnvironment } from "../../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";

const [mode, root] = process.argv.slice(2);
const readyFile = join(root, "child-ready.json");
const flushedFile = join(root, "child-flushed");
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const childScript = `
  const fs = require('node:fs');
  const [readyFile, flushedFile, mode] = process.argv.slice(1);
  let interrupted = false;
  process.on('SIGINT', () => {
    if (mode === 'stalled' || interrupted) return;
    interrupted = true;
    setTimeout(() => { fs.writeFileSync(flushedFile, 'disposed'); process.exit(130); }, 100);
  });
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid }));
  // Simulate inherited Windows console delivery to the child too; Windows
  // child.kill('SIGINT') is forceful termination, not graceful signal delivery.
  if (process.platform === 'win32' && mode !== 'stalled') setTimeout(() => process.emit('SIGINT'), 200);
  setInterval(() => {}, 1000);
`;
let abortMessages = 0;
const result = runProcess(process.execPath, ["-e", childScript, readyFile, flushedFile, mode], {
  cwd: root, env: createRuntimeEnvironment(process.env), timeoutMs: 10000, gracefulInterrupt: true,
  onAbort: () => { abortMessages += 1; },
});
const deadline = Date.now() + 2000;
while (!existsSync(readyFile)) {
  if (Date.now() >= deadline) throw new Error("CANCEL_FIXTURE_CHILD_NOT_READY");
  await new Promise((done) => setTimeout(done, 10));
}
process.emit("SIGINT");
if (mode === "second-interrupt") process.emit("SIGINT");
const outcome = await result;
const { pid } = JSON.parse(await readFile(readyFile, "utf8"));
let childClosed = false;
try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; childClosed = true; }
const after = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
await writeFile(join(root, "outcome.json"), JSON.stringify({ ...outcome, before, after, abortMessages, childClosed, flushed: existsSync(flushedFile) }));
