import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientOutput = await build({
  entryPoints: [resolve(packageRoot, "src", "client.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  // React is one of the official Web shell's frozen platform modules. Keeping
  // the request external makes this bundle use the shell's React 18 identity.
  external: ["react"],
  write: false,
  legalComments: "none",
  sourcemap: false,
});
const body = clientOutput.outputFiles?.[0]?.text;
if (body === undefined) throw new Error("DeepSeek Web client bundle produced no JavaScript output");
const wrapped = [
  "window.__ModuleLoader__.load({",
  '  id: "@deepseek-pp/dsh-deepseek-web-official-plugin",',
  "  factory: (require) => {",
  "    var module = { exports: {} };",
  "    var exports = module.exports;",
  body.split("\n").map((line) => line === "" ? "" : `    ${line}`).join("\n").trimEnd(),
  "    return module.exports;",
  "  }",
  "});",
  "",
].join("\n");
const target = resolve(packageRoot, "lib", "client.js");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, wrapped, "utf8");
await writeFile(resolve(packageRoot, "lib", "client.d.ts"), [
  'import type { Context } from "@deepseek-ai/cordis";',
  "",
  'export declare const inject: readonly ["slots", "locale", "settingsScope", "remote"];',
  "export declare function apply(ctx: Context): Promise<() => Promise<void>>;",
  "",
].join("\n"), "utf8");

const hostOutput = await build({
  entryPoints: [resolve(packageRoot, "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // Public Harness services must keep the official profile's singleton
  // identities. Private @deepseek-pp workspaces are bundled so the resulting
  // npm tarball can be installed without the source checkout. `ws` remains an
  // exact public dependency because its CommonJS Node entry uses dynamic
  // built-in requires that cannot execute inside an ESM bundle wrapper.
  external: ["@deepseek-ai/*", "ws"],
  write: false,
  legalComments: "none",
  sourcemap: false,
});
const hostBody = hostOutput.outputFiles?.[0]?.text;
if (hostBody === undefined) throw new Error("DeepSeek Web Host bundle produced no JavaScript output");
await writeFile(resolve(packageRoot, "lib", "index.js"), hostBody, "utf8");
await writeFile(resolve(packageRoot, "lib", "index.d.ts"), [
  'import type { Context } from "@deepseek-ai/cordis";',
  "",
  'export declare const name = "deepseek-web-official";',
  'export declare const inject: readonly ["settings", "credentials", "agentDefaultModel", "llm", "tools", "subprocess", "shell", "deepseekWebSessionImport"];',
  "export declare function apply(ctx: Context): Promise<() => Promise<void>>;",
  "",
].join("\n"), "utf8");

const persistenceOutput = await build({
  entryPoints: [resolve(packageRoot, "src", "session-persistence.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["@deepseek-ai/*"],
  write: false,
  legalComments: "none",
  sourcemap: false,
});
const persistenceBody = persistenceOutput.outputFiles?.[0]?.text;
if (persistenceBody === undefined) throw new Error("DeepSeek Web persistence bundle produced no JavaScript output");
await writeFile(resolve(packageRoot, "lib", "session-persistence.js"), persistenceBody, "utf8");
await writeFile(resolve(packageRoot, "lib", "session-persistence.d.ts"), [
  'import type { Context } from "@deepseek-ai/cordis";',
  "",
  "export interface Config {",
  "  readonly root: string;",
  "  readonly importRoot: string;",
  '  readonly compression?: "none" | "zstd";',
  "  readonly packChunks?: boolean;",
  "  readonly preparedSessionCacheSize?: number;",
  "  readonly writeBatchMaxDelayMs?: number;",
  "}",
  'export declare const inject: readonly ["sessions"];',
  "export declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;",
  "",
].join("\n"), "utf8");
