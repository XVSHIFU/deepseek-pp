// Cross-platform fixture: deliver SIGINT inside only this spawned CLI process.
// Windows child.kill('SIGINT') forcibly terminates; it cannot exercise handlers.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const marker = process.env.DSH_TERMINAL_TEST_SIGNAL_FILE;
if (!marker || !isAbsolute(marker)) throw new Error("TERMINAL_TEST_SIGNAL_MARKER_REQUIRED");
const timer = setInterval(() => {
  if (!existsSync(marker)) return;
  clearInterval(timer);
  process.emit("SIGINT");
}, 10);
timer.unref();
