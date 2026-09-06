// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { presentationArguments } = await import(new URL("../packages/dsh-web-agent-bundle/bin/web-options.mjs", import.meta.url).href);
const { prepareStart } = await import(new URL("../packages/dsh-web-agent-bundle/bin/install-runtime.mjs", import.meta.url).href);
const bundle = "owned-bundle";

describe("official web presentation entry", () => {
  it("uses official web overlay and flags without terminal/headless input or browser startup barrier", () => {
    expect(presentationArguments({ bundle, surface: "web" })).toEqual(["--patch", join(bundle, "bin/web-app.patch.yml")]);
    expect(presentationArguments({ bundle, surface: "web", port: 3081, noOpen: true })).toEqual([
      "--patch", join(bundle, "bin/web-app.patch.yml"), "--port", "3081", "--no-open",
    ]);
  });
  it("preserves interactive, exact resume and headless entry shapes", () => {
    const wait = ["--patch", join(bundle, "bin/browser-ready.patch.yml")];
    expect(presentationArguments({ bundle })).toEqual([...wait, "--patch", join(bundle, "bin/terminal-app.patch.yml")]);
    expect(presentationArguments({ bundle, resume: "session-fixture" }).slice(-2)).toEqual(["--resume", "session-fixture"]);
    expect(presentationArguments({ bundle, task: "Read README" })).toEqual([...wait, "Read README"]);
  });
  it.each([0, -1, 65536, NaN, 3080.1, "3080"])("rejects invalid web port %s", (port) => {
    expect(() => presentationArguments({ bundle, surface: "web", port })).toThrow("START_WEB_PORT_INVALID");
  });
  it("rejects mixed surfaces and avoids reading installation data for malformed input", async () => {
    expect(() => presentationArguments({ bundle, surface: "web", task: "run" })).toThrow("START_WEB_SESSION_INPUT_REQUIRED");
    expect(() => presentationArguments({ bundle, surface: "web", resume: "session-x" })).toThrow("START_WEB_SESSION_INPUT_REQUIRED");
    expect(() => presentationArguments({ bundle, surface: "web", noOpen: "yes" })).toThrow("START_WEB_ARGUMENTS_INVALID");
    expect(() => presentationArguments({ bundle, surface: "unknown" })).toThrow("START_SURFACE_ARGUMENTS_INVALID");
    expect(() => presentationArguments({ bundle, port: 3080 })).toThrow("START_SURFACE_ARGUMENTS_INVALID");
    await expect(prepareStart({ surface: "web", port: 0 })).rejects.toThrow("START_WEB_PORT_INVALID");
  });
});
