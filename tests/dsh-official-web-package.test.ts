// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { packageOfficialPlugin, verifyOfficialPlugin } = await import(
  new URL("../scripts/package-dsh-official-plugin.mjs", import.meta.url).href
) as {
  packageOfficialPlugin(options: {
    source: string;
    output: string;
    extensions: Record<string, string>;
  }, injected?: { run?: (...args: any[]) => Promise<any> }): Promise<{
    ok: true;
    source_commit: string;
    manifest_sha256: string;
    files: number;
  }>;
  verifyOfficialPlugin(options: { candidate: string; expectedSha256: string }): Promise<{
    ok: true;
    source_commit: string;
    manifest_sha256: string;
    files: number;
  }>;
};

const roots: string[] = [];
const COMMIT = "1".repeat(40);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const integrity = (value: string | Buffer) => `sha512-${createHash("sha512").update(value).digest("base64")}`;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("official DSH plugin candidate package", () => {
  it("packages one self-contained plugin, fixed budget archives and matching browser builds", async () => {
    const fixture = await createFixture();
    const receipt = await packageOfficialPlugin({
      source: process.cwd(),
      output: fixture.output,
      extensions: fixture.extensions,
    }, { run: fixture.run });

    expect(receipt).toMatchObject({ ok: true, source_commit: COMMIT, files: 11 });
    const verified = await verifyOfficialPlugin({
      candidate: fixture.output,
      expectedSha256: receipt.manifest_sha256,
    });
    expect(verified).toEqual(receipt);

    const manifest = JSON.parse(await readFile(join(fixture.output, "manifest.json"), "utf8"));
    expect(manifest.plugin).toMatchObject({
      name: "@deepseek-pp/dsh-deepseek-web-official-plugin",
      version: "0.0.0-private",
    });
    expect(manifest.budget_overrides.map((entry: { name: string }) => entry.name)).toEqual([
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-compaction-basic",
      "@deepseek-ai/dsh-llm-retry",
    ]);
    expect(Object.keys(manifest.extensions)).toEqual(["chrome", "edge", "firefox"]);
    expect(manifest.acceptance).toEqual({ automated_install: "pending", real_web: "pending" });
    expect(manifest.release_eligible).toBe(false);
  });

  it("rejects a changed candidate payload", async () => {
    const fixture = await createFixture();
    const receipt = await packageOfficialPlugin({
      source: process.cwd(),
      output: fixture.output,
      extensions: fixture.extensions,
    }, { run: fixture.run });
    await writeFile(join(fixture.output, "plugin", fixture.pluginFilename), "changed");

    await expect(verifyOfficialPlugin({
      candidate: fixture.output,
      expectedSha256: receipt.manifest_sha256,
    })).rejects.toMatchObject({ code: "OFFICIAL_PACKAGE_FILE_HASH_MISMATCH" });
  });

  it("rejects an arbitrary archive even when its receipt hash matches", async () => {
    const fixture = await createFixture();
    const archive = join(fixture.extensions.chrome, `deepseek-plus-plus-${fixture.version}-chrome.zip`);
    const bytes = Buffer.from("not-a-zip");
    await writeFile(archive, bytes);
    const receiptPath = join(fixture.extensions.chrome, "build.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.archive.sha256 = hash(bytes);
    await writeFile(receiptPath, JSON.stringify(receipt));

    await expect(packageOfficialPlugin({
      source: process.cwd(),
      output: fixture.output,
      extensions: fixture.extensions,
    }, { run: fixture.run })).rejects.toMatchObject({ code: "CANDIDATE_EXTENSION_ZIP_INVALID" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-t7-official-package-"));
  roots.push(root);
  const extensions: Record<string, string> = {};
  const version = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).version;
  const identity = { commit: COMMIT, files: Object.fromEntries(await Promise.all(
    ["package.json", "package-lock.json", "wxt.config.ts"].map(async (file) => [file, hash(await readFile(join(process.cwd(), file)))]),
  )) };
  const require = createRequire(join(process.cwd(), "package.json"));
  const wxtRequire = createRequire(require.resolve("wxt"));
  const JSZip = wxtRequire("jszip");
  const wxtVersion = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"))
    .packages["node_modules/wxt"].version;
  for (const browser of ["chrome", "edge", "firefox"]) {
    const directory = join(root, browser);
    await mkdir(directory);
    const filename = `deepseek-plus-plus-${version}-${browser}.zip`;
    const manifest = {
      manifest_version: 3,
      version,
      name: "__MSG_extension_name__",
      default_locale: "en",
      ...(browser === "firefox" ? { browser_specific_settings: { gecko: { id: "fixture@example.invalid" } } } : {}),
    };
    const contents = new Map([
      ["_locales/en/messages.json", "{}"],
      ["_locales/zh_CN/messages.json", "{}"],
      ["background.js", `// ${browser}`],
      ["manifest.json", JSON.stringify(manifest)],
    ]);
    const zip = new JSZip();
    for (const [path, content] of contents) zip.file(path, content);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(join(directory, filename), bytes);
    await writeFile(join(directory, "build.json"), JSON.stringify({
      schema_version: 1,
      kind: "local-extension-build",
      source: identity,
      browser,
      version,
      wxt_version: wxtVersion,
      archive: { path: filename, sha256: hash(bytes) },
      files: [...contents].map(([path, content]) => ({ path, sha256: hash(content) })),
    }));
    extensions[browser] = directory;
  }
  const output = join(root, "candidate");
  const pluginFilename = "deepseek-pp-dsh-deepseek-web-official-plugin-0.0.0-private.tgz";
  const run = async (executable: string, args: string[]) => {
    if (executable === "git" && args[0] === "rev-parse") return { stdout: `${COMMIT}\n`, stderr: "", code: 0 };
    if (executable === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0 };
    const destination = args.at(-1)!;
    const pluginBytes = "fixture-plugin-tarball";
    await writeFile(join(destination, pluginFilename), pluginBytes);
    return {
      stdout: JSON.stringify([{
        name: "@deepseek-pp/dsh-deepseek-web-official-plugin",
        filename: pluginFilename,
        integrity: integrity(pluginBytes),
        files: ["package.json", "lib/index.js", "lib/index.d.ts", "lib/client.js", "lib/client.d.ts", "lib/session-persistence.js", "lib/session-persistence.d.ts", "cordis.patch.yml"]
          .map((path) => ({ path })),
      }]),
      stderr: "",
      code: 0,
    };
  };
  return { root, output, extensions, pluginFilename, run, version };
}
