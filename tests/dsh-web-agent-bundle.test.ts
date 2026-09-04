import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import {
  composeEntries,
  healProfilesModuleFallback,
  loadOverlayPatches,
  loadProfile,
} from "@deepseek-ai/dsh-app-boot";
import {
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import * as DeepSeekWebAdapterPlugin from "@deepseek-pp/dsh-llm-deepseek-web";
import {
  DeepSeekWebModelHost,
  createPairingToken,
} from "@deepseek-pp/dsh-web-model-transport";
import * as HostPlugin from "@deepseek-pp/dsh-web-agent-bundle/host";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(process.cwd(), "packages", "dsh-web-agent-bundle");
const PACKAGE_MANIFEST = join(PACKAGE_ROOT, "package.json");
const PATCH_PATH = join(PACKAGE_ROOT, "cordis.patch.yml");
const SEED_SCRIPT = join(PACKAGE_ROOT, "scripts", "seed-profile.mjs");
const DSH_MANIFEST = resolve(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "package.json");
const DSH_BIN = join(dirname(DSH_MANIFEST), "lib", "bin.js");
const PROFILE_NAME = "deepseek-web-agent";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DeepSeek Web Agent standalone bundle", () => {
  it("declares one complete allowlisted tree with an immutable web-only model selection", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_MANIFEST, "utf8")) as BundleManifest;
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    const patches = loadOverlayPatches("dsh-web-agent-bundle-test", PATCH_PATH);
    const rows = composeEntries([patches]) as BundleRow[];

    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ["headless-startup", "@deepseek-ai/dsh-headless/startup"],
      ["headless-runner", "@deepseek-ai/dsh-headless"],
      ["deepseek-web-model-host", "@deepseek-pp/dsh-web-agent-bundle/host"],
      ["llm", "@deepseek-ai/dsh-llm"],
      ["session", "@deepseek-ai/dsh-session"],
      ["session-projection", "@deepseek-ai/dsh-session-projection"],
      ["system-prompt", "@deepseek-ai/dsh-system-prompt"],
      ["tools", "@deepseek-ai/dsh-tools"],
      ["agent", "@deepseek-ai/dsh-agent"],
      ["agent-default-model", "@deepseek-ai/dsh-agent-default-model"],
      ["session-persistence-jsonl", "@deepseek-ai/dsh-session-persistence-jsonl"],
      ["session-checkpoint-policy", "@deepseek-ai/dsh-session-checkpoint-policy"],
      ["agent-loop", "@deepseek-ai/dsh-agent-loop"],
      ["llm-deepseek-web", "@deepseek-pp/dsh-llm-deepseek-web"],
    ]);
    expect(rows.find((row) => row.id === "agent-default-model")?.config).toEqual({
      provider: "deepseek-web",
      model: "current-web-session",
    });
    expect(rows.find((row) => row.id === "agent-loop")?.config).toEqual({
      maxParallelToolCalls: 1,
      agents: [],
    });
    expect(rows.find((row) => row.id === "tools")?.config).toEqual({ mode: "native" });

    const rowPackages = rows.map((row) => row.name);
    expect(rowPackages).not.toContain("@deepseek-ai/dsh-base");
    expect(rowPackages).not.toContain("@deepseek-ai/dsh-sdk-jsonrpc-server");
    expect(rowPackages).not.toContain("@deepseek-ai/dsh-llm-deepseek");
    expect(rowPackages).not.toContain("@deepseek-ai/dsh-llm-pi-ai");
    expect(rowPackages.some((name) => /credential|settings|telemetry|web-search|tool-(?:bash|pwsh)|subagent|skill/.test(name))).toBe(false);

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@deepseek-ai/dsh-")) expect(version).toBe("0.1.2-rc.1");
    }
  });

  it("starts and stops the production Host with the Cordis fiber and exposes no provider fallback", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    const requestedPort = await reserveLoopbackPort();
    const hostFiber = ctx.plugin(HostPlugin, {
      pairingToken: createPairingToken(),
      allowedExtensionOrigins: [ORIGIN],
      port: requestedPort,
    });
    await hostFiber;
    const broker = ctx.deepseekWebBroker;
    const port = (broker as DeepSeekWebModelHost).address.port;
    const adapterFiber = ctx.plugin(DeepSeekWebAdapterPlugin);
    await adapterFiber;

    expect(ctx.llm.listProviders()).toEqual([{ id: "deepseek-web", name: "DeepSeek Web" }]);
    const chunks = await collect(ctx.llm.stream(generateOptions()));
    expect(chunks).toEqual([{
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          code: "WAITING_FOR_BROWSER",
          message: "Waiting for an authenticated DeepSeek++ browser broker.",
        },
      },
    }]);

    await hostFiber.dispose();
    expect(ctx.get("deepseekWebBroker")).toBeUndefined();
    const replacement = new DeepSeekWebModelHost({
      pairingToken: createPairingToken(),
      allowedOrigins: [ORIGIN],
      port,
    });
    await expect(replacement.start()).resolves.toMatchObject({ host: "127.0.0.1", port });
    await replacement.stop();
    await ctx.fiber.dispose();
  });

  it("rejects invalid Host data before binding a listener", async () => {
    expect(HostPlugin.Config.dict?.pairingToken?.meta.role).toBe("secret");
    expect(() => new HostPlugin.Config({
      pairingToken: createPairingToken(),
      allowedExtensionOrigins: [ORIGIN],
      port: 0,
    } as never)).toThrow();
    expect(() => new HostPlugin.Config({
      pairingToken: createPairingToken(),
      allowedExtensionOrigins: [],
      port: 43_123,
    })).toThrow();
    const invalidTokenContext = new Context();
    const invalidToken = invalidTokenContext.plugin(HostPlugin, {
      pairingToken: "short",
      allowedExtensionOrigins: [ORIGIN],
      port: await reserveLoopbackPort(),
    });
    await expect(invalidToken).rejects.toThrow("INVALID_PAIRING_TOKEN");
    await invalidTokenContext.fiber.dispose();
    const invalidOriginContext = new Context();
    const invalidOrigin = invalidOriginContext.plugin(HostPlugin, {
      pairingToken: createPairingToken(),
      allowedExtensionOrigins: ["https://example.com"],
      port: await reserveLoopbackPort(),
    });
    await expect(invalidOrigin).rejects.toThrow("INVALID_ORIGIN_ALLOWLIST");
    await invalidOriginContext.fiber.dispose();
  });

  it("stops the Host even when service removal throws", async () => {
    const port = await reserveLoopbackPort();
    const dispose = await HostPlugin.apply({
      provide: () => async () => { throw new Error("unprovide failed"); },
    } as unknown as Context, {
      pairingToken: createPairingToken(),
      allowedExtensionOrigins: [ORIGIN],
      port,
    });
    await expect(dispose()).rejects.toThrow("unprovide failed");
    const replacement = new DeepSeekWebModelHost({
      pairingToken: createPairingToken(),
      allowedOrigins: [ORIGIN],
      port,
    });
    await expect(replacement.start()).resolves.toMatchObject({ host: "127.0.0.1", port });
    await replacement.stop();
  });

  it("seeds an empty profile, installs the checkout through dsh plugin, and resolves the real bundle", async () => {
    const tempRoot = await makeTempRoot();
    const home = join(tempRoot, "dsh-home");
    const env = cleanModelEnvironment({ ...process.env, DSH_HOME: home });

    const seeded = await execFileAsync(process.execPath, [SEED_SCRIPT, "--home", home], {
      cwd: process.cwd(),
      env,
      timeout: 10_000,
      windowsHide: true,
    });
    expect(resolve(seeded.stdout.trim())).toBe(join(home, "profiles", PROFILE_NAME));

    await execFileAsync(process.execPath, [DSH_BIN, "plugin", "--profile", PROFILE_NAME, "add", PACKAGE_ROOT], {
      cwd: process.cwd(),
      env,
      timeout: 30_000,
      windowsHide: true,
    });

    const profile = loadProfile("dsh-test", PROFILE_NAME, DSH_MANIFEST, home, { userLayer: false });
    expect(profile.patchReload).toBe("startup");
    expect(profile.layers.map((layer) => layer.packageName)).toEqual(["@deepseek-pp/dsh-web-agent-bundle"]);
    const profileManifest = JSON.parse(await readFile(join(profile.dir, "package.json"), "utf8")) as ProfileManifest;
    expect(profileManifest.dsh?.profile?.bundles).toEqual(["@deepseek-pp/dsh-web-agent-bundle"]);
    expect(profileManifest.dependencies).toEqual(expect.objectContaining({
      "@deepseek-pp/dsh-web-agent-bundle": expect.stringMatching(/^(?:file|link):/),
    }));

    await healProfilesModuleFallback({ installAnchor: DSH_MANIFEST, profile, home });
    const probe = join(profile.dir, "probe.mjs");
    await writeFile(probe, [
      "import * as host from '@deepseek-pp/dsh-web-agent-bundle/host'",
      "import * as adapter from '@deepseek-pp/dsh-llm-deepseek-web'",
      "process.stdout.write(JSON.stringify({ host: host.name, adapter: adapter.name }))",
      "",
    ].join("\n"), "utf8");
    const imported = await execFileAsync(process.execPath, [probe], {
      cwd: profile.dir,
      env,
      timeout: 10_000,
      windowsHide: true,
    });
    expect(JSON.parse(imported.stdout)).toEqual({
      host: "deepseek-web-model-host",
      adapter: "llm-deepseek-web",
    });

    const dumped = await execFileAsync(process.execPath, [
      DSH_BIN,
      "--profile",
      PROFILE_NAME,
      "--dump-default-config",
    ], {
      cwd: process.cwd(),
      env,
      timeout: 20_000,
      windowsHide: true,
    });
    expect(dumped.stdout).toContain("@deepseek-pp/dsh-llm-deepseek-web");
    expect(dumped.stdout).toContain("provider: deepseek-web");
    expect(dumped.stdout).not.toContain("@deepseek-ai/dsh-base");
    expect(dumped.stdout).not.toContain("@deepseek-ai/dsh-llm-deepseek\n");
    expect(dumped.stdout).not.toContain("@deepseek-ai/dsh-llm-pi-ai");
    expect(dumped.stdout).not.toContain("DEEPSEEK_API_KEY");

    const unavailableEnv = {
      ...env,
      DSH_WEB_BROKER_PORT: String(await reserveLoopbackPort()),
      DSH_WEB_PAIRING_TOKEN: createPairingToken(),
      DSH_WEB_ALLOWED_EXTENSION_ORIGINS: ORIGIN,
    };
    await expect(execFileAsync(process.execPath, [
      DSH_BIN,
      "--profile",
      PROFILE_NAME,
      "hello",
    ], {
      cwd: process.cwd(),
      env: unavailableEnv,
      timeout: 20_000,
      windowsHide: true,
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("WAITING_FOR_BROWSER"),
    });
  }, 60_000);

  it("refuses to seed over an existing non-standalone profile", async () => {
    const tempRoot = await makeTempRoot();
    const home = join(tempRoot, "dsh-home");
    const seed = await import(pathToFileURL(SEED_SCRIPT).href) as { seedProfile(home: string): string };
    const profileDir = seed.seedProfile(home);
    const manifestPath = join(profileDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfileManifest;
    manifest.dsh!.profile!.bundles = ["@deepseek-ai/dsh-base"];
    await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
    expect(() => seed.seedProfile(home)).toThrow("PROFILE_ALREADY_CONFIGURED");
  });
});

interface BundleManifest {
  readonly dependencies?: Record<string, string>;
  readonly dsh?: { readonly bundle?: { readonly patch?: string } };
}

interface ProfileManifest {
  readonly dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[]; patchReload?: string } };
}

interface BundleRow {
  readonly id: string;
  readonly name: string;
  readonly config?: Record<string, unknown>;
}

function generateOptions(): GenerateOptions {
  return {
    provider: "deepseek-web",
    model: "current-web-session",
    sessionId: "bundle-test-session" as GenerateOptions["sessionId"],
    messages: [createUserMessage({
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    })],
  };
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function makeTempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dsh-web-agent-bundle-"));
  tempRoots.push(path);
  return path;
}

function cleanModelEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY/i.test(key)) delete clean[key];
  }
  return clean;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("EXPECTED_TCP_ADDRESS");
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
  return address.port;
}
