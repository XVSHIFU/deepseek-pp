import { existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, createRuntimeEnvironment } from "../../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";

const [mode, root] = process.argv.slice(2);
const readyFile = join(root, "child-ready.json");
const flushedFile = join(root, "child-flushed");
const interruptedFile = join(root, "parent-interrupted");
const disposingFile = join(root, "child-disposing");
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const childScript = `
  const fs = require('node:fs');
  const [readyFile, flushedFile, interruptedFile, disposingFile, mode] = process.argv.slice(1);
  let interrupted = false;
  process.on('SIGINT', () => {
    if (mode === 'stalled' || interrupted) return;
    interrupted = true;
    fs.writeFileSync(disposingFile, 'disposing');
    // Hold this disposer open until the second interrupt force-kills it. A
    // startup-relative timer would race Windows taskkill process scheduling.
    if (mode === 'second-interrupt') return;
    setTimeout(() => { fs.writeFileSync(flushedFile, 'disposed'); process.exit(130); }, 100);
  });
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid }));
  // Simulate inherited Windows console delivery to the child too; Windows
  // child.kill('SIGINT') is forceful termination, not graceful signal delivery.
  if (process.platform === 'win32') setInterval(() => {
    if (!interrupted && fs.existsSync(interruptedFile)) process.emit('SIGINT');
  }, 10);
  setInterval(() => {}, 1000);
`;
let abortMessages = 0;
const result = runProcess(process.execPath, ["-e", childScript, readyFile, flushedFile, interruptedFile, disposingFile, mode], {
  cwd: root, env: createRuntimeEnvironment(process.env), timeoutMs: 10000, gracefulInterrupt: true,
  onAbort: () => { abortMessages += 1; writeFileSync(interruptedFile, "interrupt"); },
});
const deadline = Date.now() + 2000;
while (!existsSync(readyFile)) {
  if (Date.now() >= deadline) throw new Error("CANCEL_FIXTURE_CHILD_NOT_READY");
  await new Promise((done) => setTimeout(done, 10));
}
process.emit("SIGINT");
let secondInterruptAt;
if (mode === "second-interrupt") {
  const disposalDeadline = Date.now() + 2000;
  while (!existsSync(disposingFile)) {
    if (Date.now() >= disposalDeadline) throw new Error("CANCEL_FIXTURE_DISPOSER_NOT_READY");
    await new Promise((done) => setTimeout(done, 10));
  }
  secondInterruptAt = Date.now();
  process.emit("SIGINT");
}
const outcome = await result;
const secondInterruptElapsedMs = secondInterruptAt === undefined ? undefined : Date.now() - secondInterruptAt;
const { pid } = JSON.parse(await readFile(readyFile, "utf8"));
let childClosed = false;
try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; childClosed = true; }
const after = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
await writeFile(join(root, "outcome.json"), JSON.stringify({ ...outcome, before, after, abortMessages, childClosed,
  disposing: existsSync(disposingFile), secondInterruptElapsedMs, flushed: existsSync(flushedFile) }));
