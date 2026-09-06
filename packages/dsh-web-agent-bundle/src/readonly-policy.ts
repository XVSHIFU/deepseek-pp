import type { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as FileTools from "@deepseek-ai/dsh-tool-fs";
import z from "@deepseek-ai/schemastery";

import { installFileAccessPolicy } from "./file-access-policy.ts";

export const name = "deepseek-web-readonly-policy";
export const inject = ["tools", "fs", "systemPrompt"];
export interface Config {
  workspaceRoot: string;
  readLimit?: number;
  readMaxLineLength?: number;
  readMaxBytes?: number;
  readStreamMinSize?: number;
}
export const Config = z.object({
  workspaceRoot: z.string().required(),
  readLimit: z.number().default(200),
  readMaxLineLength: z.number().default(2_000),
  readMaxBytes: z.number().default(16_384),
  readStreamMinSize: z.number().default(65_536),
});

/**
 * Narrow policy composition over the pinned official tools, not a filesystem
 * implementation. The private scope owns the complete upstream registration;
 * only its exact read definition is published to this profile's real registry.
 *
 * Containment is model-path admission through the official provider's canonical
 * resolver, NOT OS isolation against a hostile local process swapping paths
 * between admission and the upstream read. Real acceptance uses an owned fixture.
 */
export async function apply(ctx: Context, config: Config) {
  await installFileAccessPolicy(ctx, { workspaceRoot: config.workspaceRoot, tool: "read" });
  const privateKey = {};
  const privateScope = createScope(ctx, privateKey);
  const { workspaceRoot: _workspaceRoot, ...readConfig } = config;
  await privateScope.ctx.plugin(FileTools, readConfig);
  const read = ctx.tools.get("read", privateKey);
  const privateCatalog = ctx.tools.schemas(privateKey).map((tool) => tool.name).join(",");
  // Official Web needs its attachment store for SessionController. The pinned
  // filesystem plugin then adds read_image inside this private scope; it is
  // never published to the text-only web model's public tool registry.
  if (!read || privateCatalog !== "read,write,edit" &&
      !(ctx.get("attachments") !== undefined && privateCatalog === "read,write,edit,read_image")) {
    throw new Error("READONLY_OFFICIAL_TOOL_COMPOSITION_CHANGED");
  }
  ctx.tools.register(read);
}
