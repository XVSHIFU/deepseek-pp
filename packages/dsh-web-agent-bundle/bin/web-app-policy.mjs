import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { symbols } from "@deepseek-ai/cordis";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";
import { validateResumeHeader, validateResumeTail } from "./terminal-app.mjs";

export const name = "deepseek-web-surface-policy";
export const inject = ["agents", "sessionPersistence", "workspaceRegistry", "agentDefaultModel"];
const denied = (code) => { throw new RemoteError("gateway/bad-request", code, {}); };
const checkSessionId = (id) => {
  if (typeof id !== "string" || !/^session-[A-Za-z0-9-]+$/.test(id)) denied("WEB_SESSION_ID_INVALID");
};

/** Deployment admission only. Official controllers retain execution and storage. */
export async function apply(ctx) {
  const workspace = await realpath(process.env.DSH_WEB_WORKSPACE_ROOT ?? process.cwd());
  const selection = ctx.agentDefaultModel.currentSelection();
  if (selection.provider !== "deepseek-web" || selection.model !== "current-web-session") denied("WEB_MODEL_FIXED");
  const checkPath = async (path) => {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== workspace) denied("WEB_WORKSPACE_FIXED");
  };
  const checkSession = async (id, activate = true) => {
    checkSessionId(id);
    const live = ctx.agents.get(id);
    if (live !== undefined) { await checkPath(live.session.header.cwd); return; }
    const inspection = await ctx.sessionPersistence.inspect(id);
    await checkPath(inspection.meta.cwd);
    if (!activate) return;
    await validateResumeHeader(inspection.meta, workspace);
    // Official user rename metadata is log-only and never queues model work.
    const lifecycle = inspection.events.filter(event => event.type !== "session/title" && event.type !== "session/end-seed");
    validateResumeTail(lifecycle.at(-1), false, lifecycle.at(-2));
    for (const event of inspection.events) {
      const model = event.type === "model/selection" ? event.data : event.type === "request/header" ? event.data.header.config : undefined;
      if (model !== undefined && (model.provider !== "deepseek-web" || model.model !== "current-web-session")) denied("WEB_MODEL_FIXED");
    }
  };
  const checkWorkspace = async (id) => {
    const value = ctx.workspaceRegistry.get(id);
    if (value === undefined) denied("WEB_WORKSPACE_FIXED");
    await checkPath(value.path);
  };
  // Every public Remote lookup (commands and agent-scoped APIs included) must
  // cross the official registry before it can activate a cold session. Guard
  // this seam as well as UI requests; controller-local resolve closures do not
  // necessarily call the public SessionController.resolveAgent method.
  for (const key of ["create", "resume"]) ctx.accessor(`agents.${key}`, { get(receiver) {
    const target = receiver[symbols.original] ?? receiver;
    const method = Reflect.get(target, key);
    return async (options) => {
      const model = options?.agentOptions;
      if (model?.provider !== undefined && model.provider !== "deepseek-web" || model?.model !== undefined && model.model !== "current-web-session") denied("WEB_MODEL_FIXED");
      if (key === "resume") await checkSession(options?.resumeSessionId);
      else await checkPath(options?.meta?.cwd ?? process.cwd());
      return Reflect.apply(method, receiver, [options]);
    };
  } });
  await ctx.workspaceRegistry.create(workspace);
  const guardedMethods = {
    sessionController: ["create", "prompt", "page", "follow", "rename", "cancel", "updateQueue", "resolveAgent", "inspect", "selectModel", "openWorkspacePath", "fork", "attachment"],
    workspaceController: ["create", "rename", "delete", "insertBefore", "insertSessionBefore", "archiveSession"],
    settingsController: ["update", "replace", "mutate", "openSettingsDocument", "openAgentPresetDirectory"],
    credentialsController: ["describe", "set", "unset"],
  };
  // Public Cordis dotted accessors are consulted by the service tracer for both
  // property access AND Context.get(). This keeps original controller identity,
  // Typert binding and official Loader client roster entirely unchanged.
  for (const [service, methods] of Object.entries(guardedMethods)) for (const key of methods) {
    ctx.accessor(`${service}.${key}`, { get(receiver) {
      const target = receiver[symbols.original] ?? receiver;
      const method = Reflect.get(target, key);
      if (service === "settingsController" && key !== "describe" || service === "credentialsController") {
        return () => denied("WEB_CONFIGURATION_FIXED");
      }
      if (service === "sessionController" && ["selectModel", "openWorkspacePath", "fork", "attachment"].includes(key)) {
        return () => denied("WEB_CONFIGURATION_FIXED");
      }
      const admit = async (args) => {
        const request = args[0];
        if (service === "sessionController") {
          if (key === "create") {
            if (request?.agentPreset !== undefined) denied("WEB_PRESET_FIXED");
            if (request?.workspaceId !== undefined) await checkWorkspace(request.workspaceId);
            else await checkPath(request?.cwd ?? process.cwd());
            // An explicit id may adopt a cold session; inspect it first.
            if (request?.sessionId !== undefined) {
              checkSessionId(request.sessionId);
              const inspection = await ctx.sessionPersistence.inspect(request.sessionId).catch(error => {
                if (error instanceof SessionPersistenceNotFoundError) return undefined;
                throw error;
              });
              if (inspection !== undefined) await checkSession(request.sessionId);
            }
          } else await checkSession(typeof request === "string" ? request : request?.sessionId ?? request?.address?.sessionId, key !== "page" && key !== "inspect");
          if (key === "prompt" && request.content?.some(part => part.type !== "text")) denied("WEB_TEXT_ONLY");
        } else {
          if (key === "create") await checkPath(request?.path);
          else {
            if (request?.workspaceId !== undefined) await checkWorkspace(request.workspaceId);
            if (request?.beforeWorkspaceId !== undefined) await checkWorkspace(request.beforeWorkspaceId);
            if (request?.sessionId !== undefined) await checkSession(request.sessionId);
          }
        }
      };
      // Preserve streaming return shape; admission finishes before the original
      // follower can promote a persisted session to an active Agent.
      if (service === "sessionController" && key === "follow") return async function* (...args) {
        await admit(args);
        yield* Reflect.apply(method, target, args);
      };
      return async (...args) => { await admit(args); return Reflect.apply(method, target, args); };
    } });
  }
  ctx.provide("deepseekWebSurfacePolicy", true);
}
