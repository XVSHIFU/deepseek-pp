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

const hostOutput = await build({
  entryPoints: [resolve(packageRoot, "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  write: false,
  legalComments: "none",
  sourcemap: false,
});
const hostBody = hostOutput.outputFiles?.[0]?.text;
if (hostBody === undefined) throw new Error("DeepSeek Web Host bundle produced no JavaScript output");
await writeFile(resolve(packageRoot, "lib", "index.js"), hostBody, "utf8");
