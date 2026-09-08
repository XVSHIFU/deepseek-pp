// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import * as OfficialPlugin from "@deepseek-pp/dsh-deepseek-web-official-plugin";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const PACKAGE_ROOT = resolve(ROOT, "packages", "dsh-deepseek-web-official-plugin");
const PACKAGE_MANIFEST = resolve(PACKAGE_ROOT, "package.json");
const PATCH_PATH = resolve(PACKAGE_ROOT, "cordis.patch.yml");
const CLIENT_BUNDLE = resolve(PACKAGE_ROOT, "lib", "client.js");
const CLIENT_TYPES = resolve(PACKAGE_ROOT, "lib", "client.d.ts");
const BASE_PATCH = resolve(ROOT, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml");
const WEB_PATCH = resolve(ROOT, "node_modules", "@deepseek-ai", "dsh-web-app", "cordis.patch.yml");
const DSH_MANIFEST = resolve(ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json");
const DSH_BIN = resolve(dirname(DSH_MANIFEST), "lib", "bin.js");
const installRuntime = await import(new URL(
  "../packages/dsh-web-agent-bundle/bin/install-runtime.mjs",
  import.meta.url,
).href);
const ReactModule = await import("react");

const contexts: Context[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  for (const root of tempRoots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "dsh-t7-official-"))) {
      throw new Error(`refusing to remove unexpected temporary path: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("official DeepSeek Web incremental plugin", () => {
  it("declares an installable web client bundle without replacing the official profile", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_MANIFEST, "utf8")) as PackageManifest;
    expect(manifest.dsh).toEqual({
      bundle: { patch: "./cordis.patch.yml" },
      client: {
        platform: "web",
        inject: ["@deepseek-ai/dsh-client-ui-settings-plugins"],
      },
    });
    expect(manifest.exports?.["./client"]).toEqual({
      types: "./lib/client.d.ts",
      default: "./lib/client.js",
    });

    const bundle = await readFile(CLIENT_BUNDLE, "utf8");
    const clientTypes = await readFile(CLIENT_TYPES, "utf8");
    expect(bundle).toContain('id: "@deepseek-pp/dsh-deepseek-web-official-plugin"');
    expect(bundle).toContain('name: "settings.plugin.item"');
    expect(bundle).toContain("key: DEEPSEEK_WEB_SETTINGS_NAMESPACE");
    expect([...bundle.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])).toEqual(["react"]);
    expect(clientTypes).toContain('readonly ["slots", "locale", "settingsScope", "remote"]');
    expect(clientTypes).toContain("Promise<() => Promise<void>>");

    let loaded: ClientRegistration | undefined;
    runInNewContext(bundle, {
      window: { __ModuleLoader__: { load(value: ClientRegistration) { loaded = value; } } },
      AbortController,
      setInterval,
      clearInterval,
    });
    expect(loaded?.id).toBe("@deepseek-pp/dsh-deepseek-web-official-plugin");
    const client = loaded?.factory((specifier) => {
      if (specifier !== "react") throw new Error(`unexpected client external: ${specifier}`);
      return ReactModule;
    });
    let card: { key?: string; component?: unknown } | undefined;
    let slotCleanup: (() => void) | undefined;
    expect(typeof client?.apply).toBe("function");
    const unmount = async () => undefined;
    let injectedDisposed = false;
    const dictionaries = new Map<string, Record<string, string>>();
    const clientContext: Record<string, unknown> = {
      effect(register: () => unknown) { register(); },
      locale: {
        register: (_namespace: string, values: { zh: Record<string, string> }) => {
          dictionaries.set("zh", values.zh);
          return () => undefined;
        },
        bind: () => (key: string) => dictionaries.get("zh")?.[key] ?? key,
        getSnapshot: () => ({ active: "zh", revision: 0 }),
        subscribe: () => () => undefined,
      },
      remote: {
        $mount: async () => unmount,
        credentials: {
          describe: async () => ({ ok: true, value: {} }),
          set: async () => ({ ok: true, value: undefined }),
        },
        deepseekWebConnection: {
          status: async () => ({ ok: true, value: undefined }),
          reconnect: async () => ({ ok: true, value: undefined }),
        },
        deepseekWebReasoning: {
          async *follow(signal: AbortSignal) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
        deepseekWebSessionImport: {
          importCompleted: async () => ({ ok: true, value: {
            transactionId: "fixture",
            rootSessionId: "root",
            sessionIds: ["root"],
            imported: 1,
            idempotent: 0,
          } }),
        },
      },
      settingsScope: {
        bind: () => ({
          getSnapshot: () => ({ status: "unavailable", value: undefined, writable: false }),
          subscribe: () => () => undefined,
          set: async () => undefined,
          unset: async () => undefined,
          mutate: async () => undefined,
        }),
      },
      slots: {
        inject(name: string, register: () => unknown) {
          expect(["settings.plugin.item", "conversation.input.dock"]).toContain(name);
          const cleanup = register() as (() => void) | undefined;
          if (name === "settings.plugin.item") slotCleanup = cleanup;
        },
        register(options: { name?: string; key?: string }, component: () => unknown) {
          if (options.name === "settings.plugin.item") card = { key: options.key, component };
          return () => undefined;
        },
      },
    };
    clientContext.inject = (dependencies: readonly string[], callback: (ctx: unknown) => void) => {
      expect(dependencies).toEqual([
        "slots",
        "locale",
        "settingsScope",
        "remote.credentials",
        "remote.deepseekWebConnection",
        "remote.deepseekWebReasoning",
        "remote.deepseekWebSessionImport",
      ]);
      callback(clientContext);
      return Object.assign(Promise.resolve(), {
        dispose: async () => { injectedDisposed = true; },
      });
    };
    const disposeClient = await client?.apply?.(clientContext);
    expect(card?.key).toBe("deepseek-web");
    expect(typeof card?.component).toBe("function");
    slotCleanup?.();
    await disposeClient?.();
    expect(injectedDisposed).toBe(true);
  });

  it("adds only its persistence and Host rows to the official web composition", () => {
    const base = loadOverlayPatches("t7-base", BASE_PATCH);
    const web = loadOverlayPatches("t7-web", WEB_PATCH);
    const plugin = loadOverlayPatches("t7-plugin", PATCH_PATH);
    const before = composeEntries([base, web]) as Row[];
    const after = composeEntries([base, web, plugin]) as Row[];

    const beforeById = new Map(before.map((row) => [row.id, row]));
    const added = after.filter((row) => !beforeById.has(row.id));
    expect(added.map((row) => [row.id, row.name])).toEqual([
      ["deepseek-web-session-persistence", "@deepseek-pp/dsh-deepseek-web-official-plugin/session-persistence"],
      ["deepseek-web-official", "@deepseek-pp/dsh-deepseek-web-official-plugin"],
    ]);
    expect(after.some((row) => row.id === "llm-deepseek-web" ||
      row.name === "@deepseek-pp/dsh-llm-deepseek-web")).toBe(false);
    for (const row of after) {
      const previous = beforeById.get(row.id);
      if (previous === undefined) continue;
      if (row.id === "session-persistence-jsonl") {
        expect(row).toEqual({ ...previous, disabled: true });
      } else {
        expect(row).toEqual(previous);
      }
    }
  });

  it("installs through the real dsh web profile without replacing official bundles or defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-t7-official-"));
    tempRoots.push(root);
    const home = join(root, "dsh-home");
    const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" };
    const installed = await installRuntime.runProcess(process.execPath, [
      DSH_BIN,
      "plugin",
      "--profile",
      "web",
      "add",
      "--offline",
      "--workspace-root",
      PACKAGE_ROOT,
    ], { cwd: ROOT, env, timeoutMs: 15_000 });
    expect(installed.code, installed.stderr).toBe(0);

    const profile = JSON.parse(await readFile(join(home, "profiles", "web", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[]; patchReload?: string } };
    };
    expect(profile.dsh?.profile).toEqual({
      bundles: [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-pp/dsh-deepseek-web-official-plugin",
      ],
      patchReload: "live",
    });
    expect(profile.dependencies?.["@deepseek-pp/dsh-deepseek-web-official-plugin"])
      .toMatch(/^(?:file|link):/u);

    const dumped = await installRuntime.runProcess(process.execPath, [
      DSH_BIN,
      "web",
      "--dump-default-config",
    ], { cwd: ROOT, env, timeoutMs: 10_000 });
    expect(dumped.code, dumped.stderr).toBe(0);
    expect(dumped.stdout).toContain("provider: deepseek-official");
    expect(dumped.stdout).toContain("model: deepseek-v4-flash");
    expect(dumped.stdout.match(/name: '@deepseek-pp\/dsh-deepseek-web-official-plugin'/gu)).toHaveLength(1);
    expect(dumped.stdout.match(/name: '@deepseek-pp\/dsh-llm-deepseek-web'/gu)).toBeNull();

    const page = await readUnpairedWebBoot(env);
    expect(page).toContain("@deepseek-pp/dsh-deepseek-web-official-plugin");
    expect(page).toContain("@deepseek-ai/dsh-client-ui-settings-general");
  }, 45_000);

  it("registers the settings namespace and model while unpaired, without changing the default", async () => {
    const ctx = new Context();
    contexts.push(ctx);
    const registrations: Array<{ ns: string; applies?: string; value: unknown }> = [];
    ctx.provide("settings", {
      register(ns: string, schema: (value: unknown) => unknown, options?: { applies?: string }) {
        const value = schema({});
        registrations.push({ ns, applies: options?.applies, value });
        return { get: () => value, watch: () => () => undefined };
      },
    } as never);
    ctx.provide("credentials", {
      resolve: async () => undefined,
    } as never);
    ctx.provide("tools", { guard: () => undefined } as never);

    await ctx.plugin(LlmRuntime);
    const dispose = await OfficialPlugin.apply(ctx);

    expect(registrations).toEqual([{
      ns: "deepseek-web",
      applies: "live",
      value: {
        browser: "chrome",
        chromiumExtensionId: "",
        firefoxExtensionOrigin: "",
        port: 43_123,
        webModelMode: "default",
        thinkingEnabled: false,
        makeDefaultForNewSessions: false,
        windowsCommandsEnabled: false,
        windowsApprovalPolicy: "ask",
        powerShellExecutable: "",
      },
    }]);
    expect(ctx.llm.listProviders().filter((provider) => provider.id === "deepseek-web")).toEqual([
      { id: "deepseek-web", name: "DeepSeek Web" },
    ]);
    expect(await collect(ctx.llm.stream(generateOptions()))).toEqual([{
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          code: "WAITING_FOR_BROWSER",
          message: expect.stringMatching(/^Waiting for an authenticated DeepSeek\+\+ browser broker\. \[web-diag:v1 request=[a-f0-9]{16} stage=broker_error reason=WAITING_FOR_BROWSER elapsed_ms=\d+\]$/),
        },
      },
    }]);
    await dispose();
    expect(ctx.get("deepseekWebBroker")).toBeUndefined();
  });
});

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function generateOptions(): GenerateOptions {
  return {
    provider: "deepseek-web",
    model: "current-web-session",
    messages: [createUserMessage({
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    })],
    sessionId: "session-t7-unpaired" as GenerateOptions["sessionId"],
  };
}

interface PackageManifest {
  exports?: Record<string, unknown>;
  dsh?: unknown;
}

interface Row {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

interface ClientRegistration {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => {
    readonly apply?: (ctx: unknown) => Promise<() => Promise<void>>;
  };
}

async function readUnpairedWebBoot(env: NodeJS.ProcessEnv): Promise<string> {
  const port = await reserveLoopbackPort();
  const child = spawn(process.execPath, [DSH_BIN, "web", "--no-open", "--port", String(port)], {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childClosed = new Promise<boolean>((resolveClosed) => {
    child.once("close", () => resolveClosed(true));
  });
  let output = "";
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error("T7_WEB_START_TIMEOUT")), 10_000);
      const inspect = (chunk: Buffer): void => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u);
        if (match?.[0] !== undefined) {
          clearTimeout(timer);
          resolveUrl(match[0]);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (/token=/u.test(output)) return;
        clearTimeout(timer);
        reject(new Error(`T7_WEB_EXITED_${code ?? "UNKNOWN"}`));
      });
    });
    const authenticated = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    expect(authenticated.status).toBeGreaterThanOrEqual(300);
    expect(authenticated.status).toBeLessThan(400);
    const cookie = authenticated.headers.get("set-cookie")?.split(";", 1)[0];
    const location = authenticated.headers.get("location");
    if (cookie === undefined || location === null) throw new Error("T7_WEB_AUTH_COOKIE_MISSING");
    const response = await fetch(new URL(location, url), {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    return await response.text();
  } finally {
    child.kill();
    const closed = await Promise.race([
      childClosed,
      delay(5_000, false, { ref: false }),
    ]);
    if (!closed && child.pid !== undefined) {
      if (process.platform === "win32") {
        spawnSync(resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
      } else {
        child.kill("SIGKILL");
      }
    }
    await assertPortCanBind(port);
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("EXPECTED_TCP_ADDRESS");
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
  return port;
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolveListening);
  });
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}
