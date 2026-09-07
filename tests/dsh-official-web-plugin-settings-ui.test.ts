// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT,
  DeepSeekWebReasoningStore,
  apply,
} from "../packages/dsh-deepseek-web-official-plugin/src/client.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("DeepSeek Web settings card", () => {
  let root: Root | undefined;
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    await dispose?.();
    root = undefined;
    dispose = undefined;
  });

  it("uses the active Chinese locale, retains collapsed drafts, and collapses only after a successful save", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let component: (() => React.ReactElement) | undefined;
    let revision = 0;
    let failSave = true;
    let value = settingsValue();
    let settingsSnapshot = { status: "ready", value, revision, writable: true } as const;
    const localeSnapshot = { active: "zh", revision: 0 } as const;
    const settingsListeners = new Set<() => void>();
    const localeListeners = new Set<() => void>();
    let dictionary: Record<string, string> = {};
    const unregister = vi.fn();
    const context: Record<string, unknown> = {
      effect(register: () => unknown) { register(); },
      locale: {
        register: (_namespace: string, dictionaries: { zh: Record<string, string> }) => {
          dictionary = dictionaries.zh;
          return unregister;
        },
        bind: () => (key: string) => dictionary[key] ?? key,
        getSnapshot: () => localeSnapshot,
        subscribe: (listener: () => void) => {
          localeListeners.add(listener);
          return () => localeListeners.delete(listener);
        },
      },
      remote: {
        $mount: async () => async () => undefined,
        credentials: {
          describe: async () => ({ ok: true, value: { "deepseek-web/pairing-token": {
            configured: true, writable: true,
          } } }),
          set: async () => ({ ok: true, value: undefined }),
        },
        deepseekWebConnection: {
          status: async () => ({ ok: true, value: connectionValue() }),
          reconnect: async () => ({ ok: true, value: {
            accepted: true, deferred: false, status: connectionValue(),
          } }),
        },
        deepseekWebReasoning: {
          async *follow(signal: AbortSignal) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
        deepseekWebSessionImport: {
          importCompleted: async () => ({ ok: true, value: {
            transactionId: "fixture", rootSessionId: "root", sessionIds: ["root"], imported: 1, idempotent: 0,
          } }),
        },
      },
      settingsScope: {
        bind: () => ({
          getSnapshot: () => settingsSnapshot,
          subscribe: (listener: () => void) => {
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
          },
          set: async () => undefined,
          unset: async () => undefined,
          mutate: async (ops: readonly { op: "set" | "unset"; path: readonly string[]; value?: unknown }[]) => {
            if (failSave) throw new Error("fixture save failed");
            value = { ...value };
            for (const op of ops) {
              if (op.op === "set") (value as Record<string, unknown>)[op.path[0]!] = op.value;
            }
            revision += 1;
            settingsSnapshot = { status: "ready", value, revision, writable: true };
            for (const listener of settingsListeners) listener();
          },
        }),
      },
      slots: {
        inject: (_name: string, register: () => unknown) => { register(); },
        register: (_options: unknown, render: () => React.ReactElement) => {
          component = render;
          return () => undefined;
        },
      },
    };
    context.inject = (dependencies: readonly string[], callback: (ctx: unknown) => void) => {
      expect(dependencies).toEqual(DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT);
      callback(context);
      return Object.assign(Promise.resolve(), { dispose: async () => undefined });
    };
    dispose = await apply(context as never);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(component!)); });

    const disclosure = button(container, "展开: DeepSeek 网页模型");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("已连接");
    expect(container.querySelector("input")).toBeNull();

    await click(disclosure);
    const mode = [...container.querySelectorAll("select")].find((select) =>
      select.querySelector("option[value='expert']") !== null) as HTMLSelectElement;
    await act(async () => {
      mode.value = "expert";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("未保存");
    await click(button(container, "收起: DeepSeek 网页模型"));
    await click(button(container, "展开: DeepSeek 网页模型"));
    expect(([...container.querySelectorAll("select")].find((select) =>
      select.querySelector("option[value='expert']") !== null) as HTMLSelectElement).value).toBe("expert");

    await click(button(container, "保存设置"));
    expect(container.textContent).toContain("fixture save failed");
    expect(button(container, "收起: DeepSeek 网页模型").getAttribute("aria-expanded")).toBe("true");

    failSave = false;
    await click(button(container, "保存设置"));
    expect(button(container, "展开: DeepSeek 网页模型").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps reasoning only in bounded browser memory and clears it on disposal", async () => {
    const store = new DeepSeekWebReasoningStore();
    await store.start({
      async *follow() {
        yield { phase: "start" as const, sessionId: "session-a", requestId: "request-a" };
        yield { phase: "delta" as const, sessionId: "session-a", requestId: "request-a", text: "live thought" };
        yield { phase: "end" as const, sessionId: "session-a", requestId: "request-a" };
      },
    });
    expect(store.getSnapshot().sessions.get("session-a")).toEqual({
      requestId: "request-a", text: "live thought", active: false,
    });
    store.dispose();
    expect(store.getSnapshot().sessions.size).toBe(0);
  });
});

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent === name);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`button not found: ${name}`);
  return result;
}

function settingsValue(): Record<string, unknown> {
  return {
    browser: "chrome",
    chromiumExtensionId: "hkbbonaaeefjangiikmfoailidcbkhec",
    firefoxExtensionOrigin: "",
    port: 43_123,
    webModelMode: "default",
    thinkingEnabled: false,
    makeDefaultForNewSessions: false,
    windowsCommandsEnabled: false,
    windowsApprovalPolicy: "ask",
    powerShellExecutable: "",
  };
}

function connectionValue(): Record<string, unknown> {
  return {
    phase: "connected",
    configured: true,
    tokenConfigured: true,
    originConfigured: true,
    busy: false,
    pendingReconfigure: false,
    browser: "chrome",
    port: 43_123,
    windows: { kind: "disabled" },
  };
}
