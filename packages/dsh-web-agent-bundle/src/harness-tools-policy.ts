import type { Context } from "@deepseek-ai/cordis";
import * as SkillTool from "@deepseek-ai/dsh-tool-skill";
import * as SubagentTool from "@deepseek-ai/dsh-tool-subagent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { installFileAccessPolicy } from "./file-access-policy.ts";
import { Config, mountWorkspaceEditor } from "./workspace-files-policy.ts";

export { Config };
export const name = "deepseek-web-harness-tools-policy";
export const inject = ["tools", "fs", "agents", "skills", "subagents", "systemPrompt", "sessionProjections"];

/**
 * Opt-in official editor/skill/child-agent composition. No configured tool-name
 * exemption: the gate captures only the exact definitions this owner mounts.
 * Skills stay in root scope so their official per-agent catalog lifecycle runs.
 */
export async function apply(ctx: Context, config: Config) {
  const definitions = new Map<string, ToolDefinition>();
  await installFileAccessPolicy(ctx, {
    workspaceRoot: config.workspaceRoot,
    tool: "str_replace_editor",
    toolDefinitions: definitions,
  });
  await mountHarnessToolDefinitions(ctx, config, definitions);
}

/** Shared fixed official definitions for the explicitly composed tool profiles. */
export async function mountHarnessToolDefinitions(ctx: Context, config: Config, definitions: Map<string, ToolDefinition>) {
  definitions.set("str_replace_editor", await mountWorkspaceEditor(ctx, config));
  await ctx.plugin(SkillTool);
  const skill = ctx.tools.get("skill");
  if (skill === undefined) throw new Error("HARNESS_TOOLS_OFFICIAL_COMPOSITION_CHANGED");
  definitions.set("skill", skill);

  await ctx.plugin(SubagentTool, {
    provider: "spawn",
    toolName: "subagent",
    modelSelectionSettings: false,
    enableRunInBackground: false,
    backgroundMode: "one-shot",
    maxDepth: 1,
    agentOptions: { provider: "deepseek-web", model: "current-web-session" },
    toolFilter: { deny: ["subagent"] },
  });
  const subagent = ctx.tools.get("subagent");
  if (subagent === undefined
    || ctx.tools.schemas().map((tool) => tool.name).sort().join(",") !== "skill,str_replace_editor,subagent") {
    throw new Error("HARNESS_TOOLS_OFFICIAL_COMPOSITION_CHANGED");
  }
  definitions.set("subagent", subagent);
  ctx.effect(() => () => { definitions.clear(); });
}
