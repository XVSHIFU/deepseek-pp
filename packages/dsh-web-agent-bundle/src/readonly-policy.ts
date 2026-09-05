import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-fs";
import { isAbsolute } from "node:path";
import { createScope } from "@deepseek-ai/dsh-scope";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import * as FileTools from "@deepseek-ai/dsh-tool-fs";
import type { ToolExecutionToken } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

export const name = "deepseek-web-readonly-policy";
export const inject = ["tools", "fs", "systemPrompt"];
// Match the pinned tool's choice of WHEN its public canonicalPath helper is
// applied; this is call-site compatibility, not a path-containment algorithm.
const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
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
  if (ctx.fs.sandboxMode !== "read-only") throw new Error("READONLY_FILESYSTEM_REQUIRED");
  if (!isAbsolute(config.workspaceRoot)) throw new Error("READONLY_WORKSPACE_REQUIRED");
  const workspace = await ctx.fs.resolve(config.workspaceRoot);
  if ((await ctx.fs.stat(workspace))?.type !== "directory") throw new Error("READONLY_WORKSPACE_REQUIRED");
  if (ctx.tools.schemas().length !== 0) throw new Error("READONLY_EMPTY_REGISTRY_REQUIRED");

  const privateKey = {};
  const privateScope = createScope(ctx, privateKey);
  const prepared = new Map<ToolExecutionToken, boolean>();
  let active = true;
  ctx.effect(() => () => { active = false; prepared.clear(); });
  // A guard is monotonic and sits after all pre-execute listeners. Missing
  // preparation (including a listener that short-circuits ours) always denies.
  ctx.tools.guard((exec) => {
    const allowed = active && exec.name === "read" && prepared.get(exec.token) === true;
    prepared.delete(exec.token);
    return allowed ? undefined : "READONLY_WORKSPACE_ACCESS_DENIED";
  });
  ctx.on("tools/result", (exec) => { prepared.delete(exec.token); });
  ctx.on("tools/pre-execute", async (exec, next) => {
    prepared.set(exec.token, false);
    if (exec.name === "read" && typeof exec.arguments === "object" && exec.arguments !== null
      && "file_path" in exec.arguments && typeof exec.arguments.file_path === "string") {
      // All path canonicalization and containment remain upstream-owned.
      // Canonicalize a session cwd using the same upstream helper as read.
      // In particular, a junction cwd with ../ must not be checked lexically
      // while the official tool executes relative to its real filesystem cwd.
      // Agentless calls retain the provider's configured resolution default.
      try {
        const sessionCwd = exec.agent?.session.header.cwd;
        const cwd = sessionCwd === undefined ? config.workspaceRoot
          : PARENT_PATH_SEGMENT.test(sessionCwd) || PARENT_PATH_SEGMENT.test(exec.arguments.file_path)
            ? canonicalPath(sessionCwd) : sessionCwd;
        const target = await ctx.fs.resolve(exec.arguments.file_path, {
          cwd,
          signal: exec.signal,
        });
        if (active) prepared.set(exec.token, !exec.signal.aborted && ctx.fs.contains(workspace, target));
      } catch {
        // Resolution failures deny without exposing host paths in policy errors.
        if (active) prepared.set(exec.token, false);
      }
    }
    if (!active) return { kind: "deny", reason: "READONLY_POLICY_STOPPED" };
    return next();
  });
  const { workspaceRoot: _workspaceRoot, ...readConfig } = config;
  await privateScope.ctx.plugin(FileTools, readConfig);
  const read = ctx.tools.get("read", privateKey);
  if (!read || ctx.tools.schemas(privateKey).map((tool) => tool.name).join(",") !== "read,write,edit") {
    throw new Error("READONLY_OFFICIAL_TOOL_COMPOSITION_CHANGED");
  }
  ctx.tools.register(read);
}
