// @vitest-environment node
import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { BrokerError, type DeepSeekWebBroker } from "@deepseek-pp/dsh-web-model-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_WEB_PAIRING_TOKEN_REF,
  type DeepSeekWebOfficialSettings,
} from "../packages/dsh-deepseek-web-official-plugin/src/config.ts";
import {
  DeepSeekWebConnectionController,
  type DeepSeekWebHost,
} from "../packages/dsh-deepseek-web-official-plugin/src/connection-controller.ts";
import {
  DeepSeekWebConnectionRemote,
} from "../packages/dsh-deepseek-web-official-plugin/src/connection-remote.ts";
import { DEEPSEEK_WEB_REMOTE_CONTRIBUTION } from "../packages/dsh-deepseek-web-official-plugin/src/connection-contract.ts";
import {
  apply as applyClient,
  DeepSeekWebClientController,
} from "../packages/dsh-deepseek-web-official-plugin/src/client.ts";
import { applyRequestedDefault } from "../packages/dsh-deepseek-web-official-plugin/src/index.ts";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});

describe("official DeepSeek Web settings and connection", () => {
  it("restores configured non-secret settings and the protected token after restart", async () => {
    const settings: DeepSeekWebOfficialSettings = {
      browser: "edge",
      chromiumExtensionId: "abcdefghijklmnopabcdefghijklmnop",
      firefoxExtensionOrigin: "",
      port: 43_777,
      makeDefaultForNewSessions: false,
      windowsCommandsEnabled: false,
      windowsApprovalPolicy: "ask",
      powerShellExecutable: "",
    };
    const created: FakeHost[] = [];
    const options = {
      readSettings: () => settings,
      resolvePairingToken: async () => "A".repeat(43),
      createHost: (configuration: ConstructorParameters<typeof FakeHost>[0]) => {
        const host = new FakeHost(configuration);
        created.push(host);
        return host;
      },
    };

    const first = new DeepSeekWebConnectionController(options);
    await first.start();
    expect(created[0]?.configuration).toEqual({
      pairingToken: "A".repeat(43),
      allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop"],
      port: 43_777,
    });
    await first.dispose();

    const restarted = new DeepSeekWebConnectionController(options);
    await restarted.start();
    expect(created[1]?.configuration).toEqual(created[0]?.configuration);
    expect(restarted.status()).toMatchObject({
      phase: "waiting_for_browser",
      configured: true,
      tokenConfigured: true,
      busy: false,
      pendingReconfigure: false,
    });
    created[1]!.authenticated = true;
    expect(restarted.status().phase).toBe("connected");
    await restarted.dispose();
  });

  it("defers a live configuration change until the current broker operation is idle", async () => {
    let settings: DeepSeekWebOfficialSettings = {
      browser: "chrome",
      chromiumExtensionId: "abcdefghijklmnopabcdefghijklmnop",
      firefoxExtensionOrigin: "",
      port: 43_123,
      makeDefaultForNewSessions: false,
      windowsCommandsEnabled: false,
      windowsApprovalPolicy: "ask",
      powerShellExecutable: "",
    };
    const hosts: FakeHost[] = [];
    const controller = new DeepSeekWebConnectionController({
      readSettings: () => settings,
      resolvePairingToken: async () => "B".repeat(43),
      createHost: (configuration) => {
        const host = new FakeHost(configuration);
        hosts.push(host);
        return host;
      },
    });
    await controller.start();

    const iterator = controller.broker.generate({ request_id: "request", request_digest: "digest" } as never)[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();
    await vi.waitFor(() => expect(controller.status().busy).toBe(true));
    settings = { ...settings, port: 43_124 };
    const receipt = await controller.requestReconfigure("settings");
    expect(receipt).toMatchObject({ accepted: true, deferred: true });
    expect(controller.status().pendingReconfigure).toBe(true);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.stopped).toBe(false);

    hosts[0]!.finish();
    await pendingEvent;
    await iterator.next();
    await vi.waitFor(() => expect(hosts).toHaveLength(2));
    expect(hosts[0]?.stopped).toBe(true);
    expect(hosts[1]?.configuration.port).toBe(43_124);
    expect(controller.status().pendingReconfigure).toBe(false);
    await controller.dispose();
  });

  it("keeps the official Web surface available with an explicit redacted connection error", async () => {
    const failure = new Error("fixture bind failure with local detail");
    const reportError = vi.fn();
    const controller = new DeepSeekWebConnectionController({
      readSettings: () => ({
        browser: "chrome",
        chromiumExtensionId: "abcdefghijklmnopabcdefghijklmnop",
        firefoxExtensionOrigin: "",
        port: 43_123,
        makeDefaultForNewSessions: false,
        windowsCommandsEnabled: false,
        windowsApprovalPolicy: "ask",
        powerShellExecutable: "",
      }),
      resolvePairingToken: async () => "C".repeat(43),
      createHost: (configuration) => {
        const host = new FakeHost(configuration);
        host.start = async () => { throw failure; };
        return host;
      },
      reportError,
    });

    await controller.start();
    expect(controller.status()).toMatchObject({ phase: "error", errorCode: "CONNECTION_START_FAILED" });
    expect(JSON.stringify(controller.status())).not.toContain("local detail");
    expect(reportError).toHaveBeenCalledWith(failure);
    await controller.dispose();
  });

  it("contains credential-read failures instead of aborting the official Web host", async () => {
    const failure = new Error("fixture credential backend detail");
    const reportError = vi.fn();
    const controller = new DeepSeekWebConnectionController({
      readSettings: () => ({
        browser: "chrome",
        chromiumExtensionId: "abcdefghijklmnopabcdefghijklmnop",
        firefoxExtensionOrigin: "",
        port: 43_123,
        makeDefaultForNewSessions: false,
        windowsCommandsEnabled: false,
        windowsApprovalPolicy: "ask",
        powerShellExecutable: "",
      }),
      resolvePairingToken: async () => { throw failure; },
      createHost: () => { throw new Error("host must not be created"); },
      reportError,
    });

    await expect(controller.start()).resolves.toBeUndefined();
    expect(controller.status()).toMatchObject({
      phase: "error",
      tokenConfigured: false,
      errorCode: "CONNECTION_START_FAILED",
    });
    expect(JSON.stringify(controller.status())).not.toContain("backend detail");
    expect(reportError).toHaveBeenCalledWith(failure);
    await controller.dispose();
  });

  it("uses write-only credential operations for pairing and never returns the token from ordinary reads", async () => {
    const stored: string[] = [];
    const calls: string[] = [];
    const controller = new DeepSeekWebClientController({
      settings: fakeClientSettings(),
      credentials: {
        async describe(refs) {
          expect(refs).toEqual([DEEPSEEK_WEB_PAIRING_TOKEN_REF]);
          return { ok: true, value: {
            [DEEPSEEK_WEB_PAIRING_TOKEN_REF]: { configured: stored.length > 0, source: "file", writable: true },
          } };
        },
        async set(ref, value) {
          expect(ref).toBe(DEEPSEEK_WEB_PAIRING_TOKEN_REF);
          stored.push(value);
          return { ok: true, value: undefined };
        },
      },
      callConnection: async (method) => {
        calls.push(method);
        const status = connectionView();
        return { ok: true, value: method === "status"
          ? status
          : { accepted: true, deferred: false, status } };
      },
      randomBytes: (length) => Uint8Array.from({ length }, (_value, index) => index),
    });

    await controller.refresh();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("AAAA");
    expect(controller.getSnapshot().credential).toEqual({ configured: false, source: "file", writable: true });

    const firstToken = await controller.pair();
    const secondToken = await controller.rePair();
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(secondToken).toBe(firstToken);
    expect(stored).toEqual([firstToken, secondToken]);
    expect(calls).toEqual(["status", "reconnect", "reconnect"]);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(firstToken);
    controller.dispose();
  });

  it("returns a newly stored one-way token even when the immediate reconnect fails", async () => {
    const controller = new DeepSeekWebClientController({
      settings: fakeClientSettings(),
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
      },
      callConnection: async () => ({ ok: false, error: { message: "fixture reconnect offline" } }),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const token = await controller.pair();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(controller.getSnapshot().error).toContain("Pairing token was stored");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(token);
    controller.dispose();
  });

  it("stages incomplete identity text locally and commits one revision-fenced settings mutation", async () => {
    const mutations: Array<{ ops: readonly unknown[]; revision?: number }> = [];
    const controller = new DeepSeekWebClientController({
      settings: fakeClientSettings(mutations),
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
      },
      callConnection: async () => ({ ok: true, value: connectionView() }),
    });

    controller.editSetting("chromiumExtensionId", "a");
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: true });
    expect(mutations).toHaveLength(0);
    controller.editSetting("chromiumExtensionId", "abcdefghijklmnopabcdefghijklmnop");
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false });
    await controller.saveSettings();
    expect(mutations).toEqual([{
      ops: [{
        op: "set",
        path: ["chromiumExtensionId"],
        value: "abcdefghijklmnopabcdefghijklmnop",
      }],
      revision: 0,
    }]);
    controller.dispose();
  });

  it("mounts the typed Remote contribution in the client fiber and releases every owned handle", async () => {
    const unmount = vi.fn(async () => undefined);
    const unregister = vi.fn();
    let slotCleanup: unknown;
    const mount = vi.fn(async () => unmount);
    const dispose = await applyClient({
      remote: {
        $mount: mount,
        credentials: {
          describe: async () => ({ ok: true, value: {} }),
          set: async () => ({ ok: true, value: undefined }),
        },
        deepseekWebConnection: {
          status: async () => ({ ok: true, value: connectionView() }),
          reconnect: async () => ({ ok: true, value: {
            accepted: true, deferred: false, status: connectionView(),
          } }),
        },
      },
      settingsScope: { bind: () => fakeClientSettings() },
      slots: {
        inject(_name: string, register: () => unknown) { slotCleanup = register(); },
        register: () => unregister,
      },
    } as never);

    expect(mount).toHaveBeenCalledWith(DEEPSEEK_WEB_REMOTE_CONTRIBUTION);
    expect(typeof slotCleanup).toBe("function");
    (slotCleanup as () => void)();
    expect(unregister).toHaveBeenCalledOnce();
    await dispose();
    expect(unmount).toHaveBeenCalledOnce();
  });

  it("exports only redacted live state and refuses reconnect while the broker is busy", async () => {
    let host: FakeHost | undefined;
    const controller = new DeepSeekWebConnectionController({
      readSettings: () => ({
        browser: "firefox",
        chromiumExtensionId: "",
        firefoxExtensionOrigin: "moz-extension://fixture",
        port: 43_123,
        makeDefaultForNewSessions: false,
        windowsCommandsEnabled: false,
        windowsApprovalPolicy: "ask",
        powerShellExecutable: "",
      }),
      resolvePairingToken: async () => "secret-pairing-token-that-must-never-ride-status-123456789",
      createHost: (configuration) => host = new FakeHost(configuration),
    });
    await controller.start();
    const ctx = new Context();
    contexts.push(ctx);
    const remote = new DeepSeekWebConnectionRemote(ctx, controller);
    expect(remoteMethods(remote).map((method) => method.method)).toEqual(["status", "reconnect"]);
    expect(DEEPSEEK_WEB_REMOTE_CONTRIBUTION.descriptors.map((descriptor) => ({
      method: descriptor.method,
      parameters: descriptor.parameters,
      result: descriptor.result,
    }))).toEqual([
      { method: "status", parameters: [], result: { mode: "src-json" } },
      { method: "reconnect", parameters: [], result: { mode: "src-json" } },
    ]);
    const iterator = controller.broker.generate({ request_id: "busy", request_digest: "busy" } as never)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(controller.status().busy).toBe(true));

    expect(JSON.stringify(remote.status())).not.toContain("secret-pairing-token");
    expect(await remote.reconnect()).toMatchObject({ accepted: false, deferred: false, reason: "busy" });
    host!.finish();
    await pending;
    await iterator.next();
    await controller.dispose();
  });

  it("changes the future-session default only through the official authority after explicit opt-in", async () => {
    const saveSelection = vi.fn(async () => undefined);
    const ctx = new Context();
    contexts.push(ctx);
    ctx.provide("agentDefaultModel", { saveSelection } as never);
    const base = {
      browser: "chrome",
      chromiumExtensionId: "",
      firefoxExtensionOrigin: "",
      port: 43_123,
      windowsCommandsEnabled: false,
      windowsApprovalPolicy: "ask" as const,
      powerShellExecutable: "",
    } as const;

    await applyRequestedDefault(ctx, { ...base, makeDefaultForNewSessions: false });
    expect(saveSelection).not.toHaveBeenCalled();
    const consume = vi.fn(async () => undefined);
    await applyRequestedDefault(ctx, { ...base, makeDefaultForNewSessions: true }, consume);
    expect(saveSelection).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
    expect(saveSelection).toHaveBeenCalledWith({
      provider: "deepseek-web",
      model: "current-web-session",
    });
    await applyRequestedDefault(ctx, { ...base, makeDefaultForNewSessions: false }, consume);
    expect(saveSelection).toHaveBeenCalledOnce();
  });
});

class FakeHost implements DeepSeekWebHost {
  authenticated = false;
  stopped = false;
  private complete!: () => void;
  private readonly completion = new Promise<void>((resolve) => { this.complete = resolve; });

  constructor(readonly configuration: {
    readonly pairingToken: string;
    readonly allowedOrigins: readonly string[];
    readonly port: number;
  }) {}

  get hasAuthenticatedPeer(): boolean {
    return this.authenticated;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopped = true;
  }

  finish(): void {
    this.complete();
  }

  async *generate(): AsyncIterable<never> {
    await this.completion;
  }

  async cancel(): Promise<never> {
    throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
  }

  async query(): Promise<never> {
    throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
  }
}

function fakeClientSettings(mutations: Array<{ ops: readonly unknown[]; revision?: number }> = []) {
  const snapshot = {
    status: "ready" as const,
    value: {
      browser: "chrome" as const,
      chromiumExtensionId: "",
      firefoxExtensionOrigin: "",
      port: 43_123,
      makeDefaultForNewSessions: false,
      windowsCommandsEnabled: false,
      windowsApprovalPolicy: "ask" as const,
      powerShellExecutable: "",
    },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: "host" as const,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
    mutate: async (ops: readonly unknown[], revision?: number) => { mutations.push({ ops, revision }); },
  };
}

function connectionView() {
  return {
    phase: "waiting_for_browser" as const,
    configured: true,
    tokenConfigured: true,
    originConfigured: true,
    busy: false,
    pendingReconfigure: false,
    browser: "chrome" as const,
    port: 43_123,
    windows: { kind: "disabled" as const },
  };
}
