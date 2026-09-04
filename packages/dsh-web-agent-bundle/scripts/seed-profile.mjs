import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROFILE_NAME = "deepseek-web-agent";

const PROFILE_MANIFEST = `${JSON.stringify({
  name: `dsh-profile-${PROFILE_NAME}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [], patchReload: "startup" } },
}, undefined, 2)}\n`;
const PROFILE_PATCH = "[]\n";
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

export function seedProfile(home) {
  if (typeof home !== "string" || !isAbsolute(home)) {
    throw new Error("PROFILE_HOME_MUST_BE_ABSOLUTE");
  }
  const profileDir = join(resolve(home), "profiles", PROFILE_NAME);
  const files = new Map([
    ["package.json", PROFILE_MANIFEST],
    ["cordis.patch.yml", PROFILE_PATCH],
    ["pnpm-workspace.yaml", PROFILE_WORKSPACE],
  ]);
  for (const [name, expected] of files) {
    const path = join(profileDir, name);
    if (existsSync(path) && readFileSync(path, "utf8") !== expected) {
      throw new Error(`PROFILE_ALREADY_CONFIGURED:${path}`);
    }
  }
  mkdirSync(profileDir, { recursive: true });
  for (const [name, content] of files) {
    const path = join(profileDir, name);
    if (!existsSync(path)) writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  }
  return profileDir;
}

function parseHome(args) {
  if (args.length !== 2 || args[0] !== "--home") {
    throw new Error("usage: node scripts/seed-profile.mjs --home <absolute-dsh-home>");
  }
  return args[1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${seedProfile(parseHome(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
