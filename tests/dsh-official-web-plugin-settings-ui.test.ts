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

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

describe("DeepSeek Web settings card", () => {
  let root: Root | undefined;
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    await dispose?.();
    vi.restoreAllMocks();
    if (originalClipboardDescriptor === undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
    document.body.replaceChildren();
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
    const effectCleanups: (() => void)[] = [];
    const slotCleanups: (() => void)[] = [];
    let dictionary: Record<string, string> = {};
    const unregister = vi.fn();
    const context: Record<string, unknown> = {
      effect(register: () => unknown) {
        const cleanup = register();
        if (typeof cleanup === "function") effectCleanups.push(cleanup as () => void);
      },
      locale: {
        currentSnapshot: localeSnapshot,
        listeners: localeListeners,
        register: (_namespace: string, dictionaries: { zh: Record<string, string> }) => {
          dictionary = dictionaries.zh;
          return unregister;
        },
        bind: () => (key: string) => dictionary[key] ?? key,
        getSnapshot(this: { currentSnapshot: typeof localeSnapshot }) { return this.currentSnapshot; },
        subscribe(this: { listeners: Set<() => void> }, listener: () => void) {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
      },
      remote: {
        $mount: async () => async () => undefined,
        credentials: {
          describe: async () => ({ ok: true, value: { DSH_WEB_PAIRING_TOKEN: {
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
        inject: (_name: string, register: () => unknown) => {
          const cleanup = register();
          if (typeof cleanup === "function") slotCleanups.push(cleanup as () => void);
        },
        register: (_options: unknown, render: () => React.ReactElement) => {
          component = render;
          return () => undefined;
        },
      },
    };
    context.inject = (dependencies: readonly string[], callback: (ctx: unknown) => void) => {
      expect(dependencies).toEqual(DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT);
      callback(context);
      return Object.assign(Promise.resolve(), {
        dispose: async () => {
          for (const cleanup of slotCleanups.reverse()) cleanup();
          for (const cleanup of effectCleanups.reverse()) cleanup();
        },
      });
    };
    dispose = await apply(context as never);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(component!)); });

    const disclosure = button(container, "展开: DeepSeek 网页模型");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(describedText(disclosure)).toContain("连接：已连接");
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
    expect(describedText(button(container, "展开: DeepSeek 网页模型"))).toContain("未保存");
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

  it("matches the official five-section card, control, action, and responsive style contracts", async () => {
    const mounted = await mountSettingsCard();
    root = mounted.root;
    dispose = mounted.dispose;

    await click(button(mounted.container, "展开: DeepSeek 网页模型"));

    const sections = [...mounted.container.querySelectorAll("section.dsh-deepseek-web-section")];
    expect(sections.map((section) => section.getAttribute("data-section"))).toEqual([
      "connection",
      "model",
      "windows",
      "pairing",
      "import",
    ]);
    for (const section of sections) {
      const labelledBy = section.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      expect(section.querySelector(`h4#${labelledBy}`)).not.toBeNull();
    }

    const stylesheet = document.head.querySelector<HTMLStyleElement>(
      'style[data-plugin-css="@deepseek-pp/dsh-deepseek-web-official-plugin/client.css"]',
    );
    expect(stylesheet).not.toBeNull();
    const css = stylesheet!.textContent ?? "";
    expect(css).toContain("var(--dsw-alias-bg-layer-3)");
    expect(css).toContain("var(--dsw-alias-bg-layer-2)");
    expect(css).toContain("var(--dsw-alias-border-l4)");
    expect(css).toContain("var(--dsw-alias-border-l2)");
    expect(css).toContain("var(--dsw-alias-brand-primary)");
    expect(css).toContain("var(--dsw-alias-state-error-primary)");
    expect(css).not.toContain("--dsw-alias-status-warning");
    expect(css).not.toContain("--dsw-alias-label-error");
    expect(css).toMatch(/@media \(max-width:\s*520px\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toMatch(/\.dsh-deepseek-web-toggle\s*\{[\s\S]*?display:\s*flex;/u);

    const switches = [...mounted.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    expect(switches).toHaveLength(3);
    for (const toggle of switches) {
      expectClasses(toggle, "dsh-deepseek-web-toggle");
      expect(toggle.querySelector(":scope > .dsh-deepseek-web-toggle-label")).not.toBeNull();
      expect(toggle.querySelector(":scope > .dsh-deepseek-web-switch")).not.toBeNull();
      expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    }
    expect(switches[0]!.getAttribute("aria-checked")).toBe("false");
    await click(switches[0]!);
    expect(switches[0]!.getAttribute("aria-checked")).toBe("true");

    const selects = [...mounted.container.querySelectorAll<HTMLSelectElement>("select")];
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const select of selects) {
      expectClasses(select, "dsh-deepseek-web-control", "dsh-deepseek-web-select-control");
      expect(select.getAttribute("aria-describedby")).toBe(`${select.id}-hint`);
    }
    const port = mounted.container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(port).not.toBeNull();
    expectClasses(port!, "dsh-deepseek-web-control");
    await changeInput(port!, "0");
    expect(port!.getAttribute("aria-invalid")).toBe("true");
    expectClasses(mounted.container.querySelector(`#${port!.id}-hint`)!, "dsh-deepseek-web-error");

    expectClasses(button(mounted.container, "保存设置"),
      "dsh-deepseek-web-button",
      "dsh-deepseek-web-button-primary",
    );
    expectClasses(button(mounted.container, "放弃更改"), "dsh-deepseek-web-button-secondary");
    expectClasses(button(mounted.container, "重新连接"), "dsh-deepseek-web-button-secondary");
    expectClasses(button(mounted.container, "重新配对"), "dsh-deepseek-web-button-caution");

    await dispose();
    dispose = undefined;
    expect(document.head.querySelector(
      'style[data-plugin-css="@deepseek-pp/dsh-deepseek-web-official-plugin/client.css"]',
    )).toBeNull();
  });

  it("keeps a generated pairing token in temporary component state and never sends it through settings", async () => {
    const mounted = await mountSettingsCard();
    root = mounted.root;
    dispose = mounted.dispose;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: ArrayBufferView) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0x5a);
      return array;
    }) as Crypto["getRandomValues"]);
    const clipboardWrite = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    await click(button(mounted.container, "展开: DeepSeek 网页模型"));
    const repair = button(mounted.container, "重新配对");
    expect(repair.disabled).toBe(false);
    await click(repair);

    expect(mounted.credentialSet).toHaveBeenCalledTimes(1);
    const [credentialRef, token] = mounted.credentialSet.mock.calls[0]!;
    expect(credentialRef).toBe("DSH_WEB_PAIRING_TOKEN");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(mounted.settingsMutate).not.toHaveBeenCalled();
    expect(mounted.settingsSet).not.toHaveBeenCalled();
    expect(mounted.settingsUnset).not.toHaveBeenCalled();
    expect(JSON.stringify(mounted.currentSettings())).not.toContain(token);

    const output = mounted.container.querySelector<HTMLOutputElement>('output[aria-label="新配对令牌"]');
    expect(output).not.toBeNull();
    expectClasses(output!, "dsh-deepseek-web-token-value");
    expect(output!.textContent).toContain(token);
    await click(button(mounted.container, "复制"));
    expect(clipboardWrite).toHaveBeenCalledWith(token);
    expect(mounted.container.textContent).toContain("已复制");

    await click(button(mounted.container, "收起: DeepSeek 网页模型"));
    expect(mounted.container.textContent).not.toContain(token);
    await click(button(mounted.container, "展开: DeepSeek 网页模型"));
    expect(mounted.container.querySelector('output[aria-label="新配对令牌"]')?.textContent).toContain(token);

    await act(async () => { root?.unmount(); });
    root = undefined;
    expect(mounted.container.textContent).not.toContain(token);
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

async function changeInput(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function expectClasses(target: Element, ...names: string[]): void {
  for (const name of names) expect(target.classList.contains(name)).toBe(true);
}

function describedText(target: Element): string {
  return (target.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

async function mountSettingsCard() {
  const container = document.createElement("div");
  document.body.append(container);
  let component: (() => React.ReactElement) | undefined;
  let revision = 0;
  let value = settingsValue();
  let settingsSnapshot: {
    readonly status: "ready";
    readonly value: Record<string, unknown>;
    readonly revision: number;
    readonly writable: boolean;
  } = { status: "ready", value, revision, writable: true };
  const settingsListeners = new Set<() => void>();
  const localeListeners = new Set<() => void>();
  const effectCleanups: (() => void)[] = [];
  const slotCleanups: (() => void)[] = [];
  let dictionary: Record<string, string> = {};
  const settingsSet = vi.fn(async () => undefined);
  const settingsUnset = vi.fn(async () => undefined);
  const settingsMutate = vi.fn(async (
    ops: readonly { op: "set" | "unset"; path: readonly string[]; value?: unknown }[],
  ) => {
    value = { ...value };
    for (const op of ops) {
      if (op.op === "set") value[op.path[0]!] = op.value;
      else delete value[op.path[0]!];
    }
    revision += 1;
    settingsSnapshot = { status: "ready", value, revision, writable: true };
    for (const listener of settingsListeners) listener();
  });
  const credentialSet = vi.fn(async (_ref: string, _value: string) => ({
    ok: true,
    value: undefined,
  }));
  const context: Record<string, unknown> = {
    effect(register: () => unknown) {
      const cleanup = register();
      if (typeof cleanup === "function") effectCleanups.push(cleanup as () => void);
    },
    locale: {
      currentSnapshot: { active: "zh", revision: 0 },
      listeners: localeListeners,
      register: (_namespace: string, dictionaries: { zh: Record<string, string> }) => {
        dictionary = dictionaries.zh;
        return () => undefined;
      },
      bind: () => (key: string) => dictionary[key] ?? key,
      getSnapshot(this: { currentSnapshot: unknown }) { return this.currentSnapshot; },
      subscribe(this: { listeners: Set<() => void> }, listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    },
    remote: {
      $mount: async () => async () => undefined,
      credentials: {
        describe: async () => ({ ok: true, value: { DSH_WEB_PAIRING_TOKEN: {
          configured: true,
          writable: true,
        } } }),
        set: credentialSet,
      },
      deepseekWebConnection: {
        status: async () => ({ ok: true, value: connectionValue() }),
        reconnect: async () => ({ ok: true, value: {
          accepted: true,
          deferred: false,
          status: connectionValue(),
        } }),
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
        getSnapshot: () => settingsSnapshot,
        subscribe: (listener: () => void) => {
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        },
        set: settingsSet,
        unset: settingsUnset,
        mutate: settingsMutate,
      }),
    },
    slots: {
      inject: (_name: string, register: () => unknown) => {
        const cleanup = register();
        if (typeof cleanup === "function") slotCleanups.push(cleanup as () => void);
      },
      register: (options: { readonly name?: string }, render: () => React.ReactElement) => {
        if (options.name === "settings.plugin.item") component = render;
        return () => undefined;
      },
    },
  };
  let fiberDisposed = false;
  context.inject = (dependencies: readonly string[], callback: (ctx: unknown) => void) => {
    expect(dependencies).toEqual(DEEPSEEK_WEB_SETTINGS_CLIENT_INJECT);
    callback(context);
    return Object.assign(Promise.resolve(), {
      dispose: async () => {
        if (fiberDisposed) return;
        fiberDisposed = true;
        for (const cleanup of slotCleanups.reverse()) cleanup();
        for (const cleanup of effectCleanups.reverse()) cleanup();
      },
    });
  };
  const appDispose = await apply(context as never);
  if (component === undefined) throw new Error("DeepSeek Web settings card was not registered");
  const mountedRoot = createRoot(container);
  await act(async () => { mountedRoot.render(React.createElement(component!)); });
  return {
    container,
    root: mountedRoot,
    dispose: appDispose,
    credentialSet,
    settingsMutate,
    settingsSet,
    settingsUnset,
    currentSettings: () => value,
  };
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
