#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The installed home receives this tiny launcher; all behavior stays in its pinned runtime.
let runtime;
try {
  const args = process.argv.slice(2);
  let implementation = join(import.meta.dirname, "install-runtime.mjs");
  if (!existsSync(implementation)) {
    const home = import.meta.dirname;
    const marker = JSON.parse(readFileSync(join(home, ".deepseek-web-agent-owner.json"), "utf8"));
    if (marker.schema_version !== 1 || marker.product !== "deepseek-pp-web-agent") throw new Error();
    const pointer = join(home, existsSync(join(home, "active.json")) ? "active.json" : "inactive.json");
    if (lstatSync(pointer).isSymbolicLink()) throw new Error();
    const active = JSON.parse(readFileSync(pointer, "utf8"));
    if (active.schema_version !== 1 || !/^[a-f0-9]{64}-[a-f0-9]{16}$/u.test(active.version_directory)) throw new Error();
    implementation = join(home, ".versions", active.version_directory, "runtime/packages/dsh-web-agent-bundle/bin/install-runtime.mjs");
    if (!args.includes("--home")) args.push("--home", home);
  }
  runtime = await import(pathToFileURL(implementation).href);
  await runtime.cli(args);
} catch (error) {
  if (runtime) runtime.reportFailure(error);
  else { process.stderr.write(`${JSON.stringify({ ok: false, error: "INSTALL_LAUNCHER_STATE_INVALID" })}\n`); process.exitCode = 1; }
}
