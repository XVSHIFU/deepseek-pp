import { join } from "node:path";
import { validateStartInput } from "./terminal-options.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Selects only the presentation layer; agent/model/tool composition is shared. */
export function presentationArguments({ bundle, surface = "terminal", task, resume, port, noOpen } = {}) {
  if (surface === "web") {
    if (task !== undefined || resume !== undefined) fail("START_WEB_SESSION_INPUT_REQUIRED");
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) fail("START_WEB_PORT_INVALID");
    if (noOpen !== undefined && typeof noOpen !== "boolean") fail("START_WEB_ARGUMENTS_INVALID");
    return ["--patch", join(bundle, "bin/web-app.patch.yml"), ...(port === undefined ? [] : ["--port", String(port)]), ...(noOpen ? ["--no-open"] : [])];
  }
  if (surface !== "terminal" || port !== undefined || noOpen !== undefined) fail("START_SURFACE_ARGUMENTS_INVALID");
  const { interactive } = validateStartInput({ task, resume });
  return ["--patch", join(bundle, "bin/browser-ready.patch.yml"), ...(interactive
    ? ["--patch", join(bundle, "bin/terminal-app.patch.yml"), ...(resume === undefined ? [] : ["--resume", resume])]
    : [task])];
}
