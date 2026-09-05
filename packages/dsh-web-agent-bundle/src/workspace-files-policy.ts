import type { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as Editor from "@deepseek-ai/dsh-tool-str-replace-editor";
import z from "@deepseek-ai/schemastery";

import { installFileAccessPolicy } from "./file-access-policy.ts";

export const name = "deepseek-web-workspace-files-policy";
export const inject = ["tools", "fs"];
export interface Config {
  workspaceRoot: string;
  maxOutputChars?: number;
}
export const Config = z.object({
  workspaceRoot: z.string().required(),
  maxOutputChars: z.number().default(16_000),
});

/** Publish only the pinned official editor, behind the shared workspace gate. */
export async function apply(ctx: Context, config: Config) {
  await installFileAccessPolicy(ctx, { workspaceRoot: config.workspaceRoot, tool: "str_replace_editor" });
  const privateKey = {};
  const privateScope = createScope(ctx, privateKey);
  const { workspaceRoot: _workspaceRoot, ...editorConfig } = config;
  await privateScope.ctx.plugin(Editor, editorConfig);
  const editor = ctx.tools.get("str_replace_editor", privateKey);
  if (!editor || ctx.tools.schemas(privateKey).map((tool) => tool.name).join(",") !== "str_replace_editor") {
    throw new Error("WORKSPACE_FILES_OFFICIAL_TOOL_COMPOSITION_CHANGED");
  }
  ctx.tools.register(editor);
}
