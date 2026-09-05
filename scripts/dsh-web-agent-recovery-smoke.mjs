import { join, resolve } from "node:path";

import { runCommand } from "./dsh-web-real-smoke.mjs";

// The existing test runner supplies TypeScript/browser-module loading. Every
// application process still starts through the shipped public DSH CLI.
const root = resolve(import.meta.dirname, "..");
try {
  const result = await runCommand({
    executable: process.execPath,
    args: [join(root, "node_modules/vitest/vitest.mjs"), "run",
      "tests/dsh-web-agent-recovery-e2e.test.ts", "tests/harness-bridge-cancel-e2e.test.ts"],
    cwd: root, env: { ...process.env }, timeoutMs: 55_000, shell: false, windowsHide: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch {
  process.stderr.write('DeepSeek Web recovery smoke failed or exceeded its cleanup deadline.\n');
  process.exitCode = 1;
}
