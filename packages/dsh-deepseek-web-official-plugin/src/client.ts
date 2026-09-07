import type { Context } from "@deepseek-ai/cordis";
import React from "react";

const SETTINGS_NAMESPACE = "deepseek-web";

export const inject = ["slots"] as const;

function DeepSeekWebSettingsCard(): React.ReactElement {
  return React.createElement(
    "section",
    {
      "aria-label": "DeepSeek Web",
      "data-dsh-plugin-card": SETTINGS_NAMESPACE,
      style: {
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "12px",
        padding: "16px",
      },
    },
    React.createElement("h3", { style: { margin: 0 } }, "DeepSeek Web"),
    React.createElement(
      "p",
      { style: { marginBottom: 0, color: "var(--dsw-alias-label-tertiary)" } },
      "Uses the signed-in DeepSeek++ browser session. Configure pairing and connection details here before starting a model request.",
    ),
  );
}

export function apply(ctx: Context): void {
  const slots = (ctx as Context & ClientSlotsContext).slots;
  slots.inject("settings.plugin.item", () => slots.register({
    name: "settings.plugin.item",
    key: "deepseek-web",
  }, DeepSeekWebSettingsCard));
}

interface ClientSlotsContext {
  readonly slots: {
    inject(name: string, register: () => unknown): void;
    register(options: { readonly name: string; readonly key: string }, component: unknown): unknown;
  };
}
