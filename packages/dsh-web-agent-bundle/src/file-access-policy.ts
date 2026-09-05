import { isAbsolute } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-fs";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import type { ToolDefinition, ToolExecution, ToolExecutionToken } from "@deepseek-ai/dsh-tools";

type FileTool = "read" | "str_replace_editor";
interface FileAccessConfig {
  workspaceRoot: string;
  tool: FileTool;
  /** Composition-owned definitions, never names supplied by model/config. */
  toolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}
interface Admission {
  readonly arguments: unknown;
  readonly agent: ToolExecution["agent"];
  readonly sessionCwd: string | undefined;
}

const TOOL_RULES = {
  read: {
    mode: "read-only",
    prefix: "READONLY",
    pathField: "file_path",
    fields: new Set(["file_path", "offset", "limit"]),
  },
  str_replace_editor: {
    mode: "workspace-write",
    prefix: "WORKSPACE_FILES",
    pathField: "path",
    fields: new Set(["command", "path", "file_text", "insert_line", "new_str", "old_str", "view_range"]),
  },
} as const;
const EDITOR_COMMANDS = new Set(["view", "create", "str_replace", "insert"]);
// The pinned read tool canonicalizes a session cwd only when cwd or the
// requested path contains a parent segment. Keep that upstream call-site rule.
const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Shared admission for the two deliberately separate file profiles. It owns no
 * filesystem operations: identity, stat and containment all stay with ctx.fs.
 * This is a model-path fence, not isolation from a hostile local path swap.
 */
export async function installFileAccessPolicy(ctx: Context, config: FileAccessConfig): Promise<void> {
  const rules = TOOL_RULES[config.tool];
  if (ctx.fs.sandboxMode !== rules.mode) throw new Error(`${rules.prefix}_FILESYSTEM_REQUIRED`);
  if (!isAbsolute(config.workspaceRoot)) throw new Error(`${rules.prefix}_WORKSPACE_REQUIRED`);
  const workspace = await ctx.fs.resolve(config.workspaceRoot);
  if ((await ctx.fs.stat(workspace))?.type !== "directory") throw new Error(`${rules.prefix}_WORKSPACE_REQUIRED`);
  if (ctx.tools.schemas().length !== 0) throw new Error(`${rules.prefix}_EMPTY_REGISTRY_REQUIRED`);

  const prepared = new Map<ToolExecutionToken, Admission>();
  let active = true;
  const matchesDefinition = (exec: ToolExecution): boolean => {
    if (config.toolDefinitions === undefined) return exec.name === config.tool;
    const definition = config.toolDefinitions.get(exec.name);
    return definition !== undefined && ctx.tools.get(exec.name, exec.agent) === definition;
  };
  ctx.effect(() => () => { active = false; prepared.clear(); });
  // A later allowing listener cannot override a missing or denied admission.
  // Bind the result to the exact runtime-frozen arguments and session as well
  // as its one-shot runtime token; replacing the inputs invalidates the check.
  ctx.tools.guard((exec) => {
    const admission = prepared.get(exec.token);
    prepared.delete(exec.token);
    const allowed = active && !exec.signal.aborted && matchesDefinition(exec)
      && admission !== undefined && admission.arguments === exec.arguments
      && admission.agent === exec.agent && admission.sessionCwd === exec.agent?.session.header.cwd;
    return allowed ? undefined : `${rules.prefix}_WORKSPACE_ACCESS_DENIED`;
  });
  ctx.on("tools/result", (exec) => { prepared.delete(exec.token); });
  ctx.on("tools/pre-execute", async (exec, next) => {
    prepared.delete(exec.token);
    // Only definitions installed and captured by the opt-in composition can
    // use their own non-file policies. A same-name scoped shadow is not that
    // capability. File tools still traverse the unchanged path admission.
    if (exec.name !== config.tool && matchesDefinition(exec) && active && !exec.signal.aborted) {
      prepared.set(exec.token, {
        arguments: exec.arguments,
        agent: exec.agent,
        sessionCwd: exec.agent?.session.header.cwd,
      });
      return next();
    }
    const args = plainArguments(exec.arguments);
    const path = args?.[rules.pathField];
    if (exec.name === config.tool && matchesDefinition(exec) && args !== undefined && typeof path === "string"
      && Object.keys(args).every((field) => rules.fields.has(field))
      && (config.tool !== "str_replace_editor" || (isAbsolute(path)
        && typeof args.command === "string" && EDITOR_COMMANDS.has(args.command)))) {
      const admission: Admission = {
        arguments: exec.arguments,
        agent: exec.agent,
        sessionCwd: exec.agent?.session.header.cwd,
      };
      try {
        const sessionCwd = admission.sessionCwd;
        const cwd = sessionCwd === undefined ? config.workspaceRoot
          : PARENT_PATH_SEGMENT.test(sessionCwd) || PARENT_PATH_SEGMENT.test(path)
            ? canonicalPath(sessionCwd) : sessionCwd;
        const target = await ctx.fs.resolve(path, {
          ...(config.tool === "read" ? { cwd } : {}),
          signal: exec.signal,
        });
        let allowed = ctx.fs.contains(workspace, target);
        if (allowed && config.tool === "str_replace_editor" && args.command === "view") {
          // The official directory view follows child junctions. Until it has
          // an upstream containment seam this profile permits file view only;
          // do not duplicate its walker or replace its filesystem provider.
          allowed = (await ctx.fs.stat(target, exec.signal))?.type === "file";
        }
        if (active && allowed && !exec.signal.aborted) prepared.set(exec.token, admission);
      } catch {
        // An unresolved path never grants access or leaks an upstream path in
        // the policy error. The official tool still owns its value validation.
      }
    }
    if (!active) return { kind: "deny", reason: `${rules.prefix}_POLICY_STOPPED` };
    return next();
  });
}

function plainArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}
