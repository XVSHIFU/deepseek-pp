// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { LlmRuntime, createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import * as AdapterPlugin from "@deepseek-pp/dsh-llm-deepseek-web";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "../fixtures/harness-bridge/fake-peer/index";
import { collect, securityHost } from "../fixtures/harness-bridge/security/host";

const { validateProfileRows } = await import(new URL("../../scripts/dsh-web-real-smoke.mjs", import.meta.url).href) as {
  validateProfileRows(rows: unknown): void;
};
const { createRuntimeEnvironment } = await import(new URL("../../packages/dsh-web-agent-bundle/bin/install-runtime.mjs", import.meta.url).href) as {
  createRuntimeEnvironment(input: Record<string, string>, owned?: Record<string, string>): Record<string, string>;
};

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function rows() {
  return composeEntries([loadOverlayPatches("security-profile", resolve("packages/dsh-web-agent-bundle/cordis.patch.yml"))]);
}

describe("release web-only profile policy", () => {
  it("the installed launcher omits inherited model and bootstrap routes without reading their values", () => {
    const blocked = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_PROFILE", "MODEL_PROVIDER", "NODE_OPTIONS", "NODE_PATH", "DSH_HOME", "DSH_WEB_PAIRING_TOKEN"];
    const input = new Proxy({ PATH: "synthetic-system-path", ...Object.fromEntries(blocked.map((key) => [key, "synthetic-never-read"])) }, {
      get(target, key, receiver) {
        if (typeof key === "string" && blocked.includes(key)) throw new Error("CREDENTIAL_OR_BOOTSTRAP_READ");
        return Reflect.get(target, key, receiver);
      },
    });
    const env = createRuntimeEnvironment(input, { DSH_HOME: "owned-state", DSH_WEB_PAIRING_TOKEN: "synthetic-owned-pairing" });
    expect(env).toEqual({ PATH: "synthetic-system-path", DSH_HOME: "owned-state", DSH_WEB_PAIRING_TOKEN: "synthetic-owned-pairing", DSH_TELEMETRY_DISABLED: "1" });
  });

  it("runs the existing strict validator over the actual composed shipping profile", () => {
    expect(() => validateProfileRows(rows())).not.toThrow();
  });

  it.each(["provider", "apiKey", "telemetry"])("rejects an added %s fallback row using the existing allowlist", (kind) => {
    const changed = [...rows(), { id: `foreign-${kind}`, name: `untrusted-${kind}`, config: { [kind]: "synthetic" } }];
    expect(() => validateProfileRows(changed)).toThrow("REAL_WEB_PROVIDER_INVALID");
  });

  it("does not read injected model credentials and fails explicitly without the web peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-no-provider-"));
    roots.push(root);
    const journalPath = join(root, "journal");
    const runtime = await securityHost(journalPath);
    const ctx = new Context();
    const originalEnvironment = process.env;
    const credentials = new Map([
      ["DEEPSEEK_API_KEY", "synthetic-deepseek-key-never-read"],
      ["OPENAI_API_KEY", "synthetic-openai-key-never-read"],
      ["ANTHROPIC_API_KEY", "synthetic-anthropic-key-never-read"],
    ]);
    const reads: string[] = [];
    process.env = new Proxy({ ...originalEnvironment, ...Object.fromEntries(credentials) }, {
      get(target, name, receiver) {
        if (typeof name === "string" && credentials.has(name)) reads.push(name);
        return Reflect.get(target, name, receiver);
      },
    });
    // Any accidental fetch fallback fails immediately, without external I/O.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("UNEXPECTED_MODEL_NETWORK"));
    let peer: FakeBrowserPeer | undefined;
    try {
      expect(() => validateProfileRows(rows())).not.toThrow();
      await ctx.plugin(LlmRuntime);
      const unprovide = ctx.provide("deepseekWebBroker", runtime.host);
      await ctx.plugin(AdapterPlugin);
      expect(ctx.llm.listProviders()).toEqual([{ id: "deepseek-web", name: "DeepSeek Web" }]);
      const unavailable = await collect(ctx.llm.stream(options("before-peer")));
      expect(unavailable).toMatchObject([{ type: "finish", reason: { kind: "error", failure: { code: "WAITING_FOR_BROWSER" } } }]);
      peer = await FakeBrowserPeer.connect({ address: runtime.address, pairingToken: runtime.token, origin: FAKE_EXTENSION_ORIGIN });
      peer.enqueueGeneration({ events: [{ type: "text_delta", text: "synthetic private answer" }, { type: "completed", finish_reason: "stop" }] });
      const completed = await collect(ctx.llm.stream(options("with-peer")));
      expect(completed.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
      expect(peer.observedGenerateRequests).toHaveLength(1);
      const wire = JSON.stringify(peer.observedGenerateRequests);
      for (const credential of credentials.values()) expect(wire).not.toContain(credential);
      await peer.close();
      peer = undefined;
      await vi.waitFor(() => expect(runtime.host.hasAuthenticatedPeer).toBe(false));
      const lost = await collect(ctx.llm.stream(options("after-peer")));
      expect(lost).toMatchObject([{ type: "finish", reason: { kind: "error", failure: { code: "WAITING_FOR_BROWSER" } } }]);
      expect(reads).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      const persisted = (await Promise.all((await readdir(journalPath)).map((name) => readFile(join(journalPath, name), "utf8")))).join("\n");
      for (const privateValue of [...credentials.values(), runtime.token, "synthetic private prompt", "synthetic private answer", root]) {
        expect(persisted).not.toContain(privateValue);
        expect(JSON.stringify([...unavailable, ...lost])).not.toContain(privateValue);
      }
      await unprovide();
    } finally {
      process.env = originalEnvironment;
      await peer?.close();
      await ctx.fiber.dispose();
      await runtime.host.stop();
    }
  });
});

function options(session: string): GenerateOptions {
  return {
    provider: "deepseek-web", model: "current-web-session", sessionId: session as GenerateOptions["sessionId"],
    messages: [createUserMessage({ content: [{ type: "text", text: "synthetic private prompt" }], source: { kind: "user" } })],
  };
}
