import { JSON_SCHEMA, Type, load as loadYaml } from "js-yaml";

const PROVIDER = "deepseek-web";
const MODEL = "current-web-session";
const BUNDLE = "@deepseek-pp/dsh-web-agent-bundle";
const DSH_CONFIG_SCHEMA = JSON_SCHEMA.extend(new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (value) => typeof value === "string",
  construct: (value) => Object.freeze({ __jsExpr: value }),
}));
const EXPECTED_PROFILE_ROWS = new Map([
  ["headless-startup", "@deepseek-ai/dsh-headless/startup"],
  ["headless-runner", "@deepseek-ai/dsh-headless"],
  ["deepseek-web-model-host", "@deepseek-pp/dsh-web-agent-bundle/host"],
  ["llm", "@deepseek-ai/dsh-llm"],
  ["session", "@deepseek-ai/dsh-session"],
  ["session-projection", "@deepseek-ai/dsh-session-projection"],
  ["system-prompt", "@deepseek-ai/dsh-system-prompt"],
  ["tools", "@deepseek-ai/dsh-tools"],
  ["agent", "@deepseek-ai/dsh-agent"],
  ["agent-default-model", "@deepseek-ai/dsh-agent-default-model"],
  ["session-persistence-jsonl", "@deepseek-ai/dsh-session-persistence-jsonl"],
  ["session-checkpoint-policy", "@deepseek-ai/dsh-session-checkpoint-policy"],
  ["agent-loop", "@deepseek-ai/dsh-agent-loop"],
  ["llm-deepseek-web", "@deepseek-pp/dsh-llm-deepseek-web"],
]);


/** The same strict web-only profile contract is used by installation and real acceptance. */
export function createProfileValidators(createError = (code, options) => Object.assign(new Error(code, options), { code })) {
function validateProfileManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw createError("REAL_WEB_PROFILE_INVALID", { cause });
  }
  if (!isRecord(value) || value.private !== true || !isRecord(value.dependencies) ||
      Object.keys(value.dependencies).length !== 1 || typeof value.dependencies[BUNDLE] !== "string" ||
      !isRecord(value.dsh) || !isRecord(value.dsh.profile) ||
      value.dsh.profile.patchReload !== "startup" ||
      !Array.isArray(value.dsh.profile.bundles) ||
      value.dsh.profile.bundles.length !== 1 || value.dsh.profile.bundles[0] !== BUNDLE) {
    throw createError("REAL_WEB_PROFILE_INVALID");
  }
}

function parseProfileDump(text) {
  let parsed;
  try {
    parsed = loadYaml(text, { schema: DSH_CONFIG_SCHEMA });
  } catch (cause) {
    throw createError("REAL_WEB_PROFILE_INVALID", { cause });
  }
  return parsed;
}

function validateProfileDump(text) {
  validateProfileRows(parseProfileDump(text));
}

function validateProfileRows(parsed) {
  if (!Array.isArray(parsed) || parsed.length !== EXPECTED_PROFILE_ROWS.size) {
    throw createError("REAL_WEB_PROVIDER_INVALID");
  }
  const rows = new Map();
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
        rows.has(value.id) || EXPECTED_PROFILE_ROWS.get(value.id) !== value.name ||
        Object.keys(value).some((key) => !["id", "name", "inject", "config"].includes(key))) {
      throw createError("REAL_WEB_PROVIDER_INVALID");
    }
    rows.set(value.id, value);
  }
  if ([...EXPECTED_PROFILE_ROWS.keys()].some((id) => !rows.has(id))) {
    throw createError("REAL_WEB_PROVIDER_INVALID");
  }
  const selection = rows.get("agent-default-model")?.config;
  if (!isRecord(selection) || !hasExactKeys(selection, ["provider", "model"]) ||
      selection.provider !== PROVIDER || selection.model !== MODEL) {
    throw createError("REAL_WEB_PROVIDER_INVALID");
  }
  const host = rows.get("deepseek-web-model-host")?.config;
  if (!isRecord(host) || !hasExactKeys(host, ["port", "journalPath", "pairingToken", "allowedExtensionOrigins"]) ||
      !isExactJsExpression(host.port, "Number(process.env.DSH_WEB_BROKER_PORT ?? 43123)") ||
      !isExactJsExpression(host.journalPath, "dshHomePath('profiles', 'deepseek-web-agent', 'web-model-journal')") ||
      !isExactJsExpression(host.pairingToken, "process.env.DSH_WEB_PAIRING_TOKEN") ||
      !isExactJsExpression(
        host.allowedExtensionOrigins,
        "(process.env.DSH_WEB_ALLOWED_EXTENSION_ORIGINS ?? '').split(',').filter(Boolean)",
      )) {
    throw createError("REAL_WEB_PROVIDER_INVALID");
  }
  const tools = rows.get("tools")?.config;
  if (!isRecord(tools) || !hasExactKeys(tools, ["mode"]) || tools.mode !== "native") {
    throw createError("REAL_WEB_PROVIDER_INVALID");
  }
  for (const [id, row] of rows) assertNoAlternateModelConfiguration(row, id, []);
}

function assertNoAlternateModelConfiguration(value, rowId, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAlternateModelConfiguration(entry, rowId, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const lower = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (["apikey", "apikeyenv", "authorization", "baseurl", "credential", "credentials", "endpoint", "headers"].includes(lower)) {
      throw createError("REAL_WEB_PROVIDER_INVALID");
    }
    if (key === "provider" && (rowId !== "agent-default-model" || childPath.join(".") !== "config.provider" || child !== PROVIDER)) {
      throw createError("REAL_WEB_PROVIDER_INVALID");
    }
    if (key === "model" && (rowId !== "agent-default-model" || childPath.join(".") !== "config.model" || child !== MODEL)) {
      throw createError("REAL_WEB_PROVIDER_INVALID");
    }
    assertNoAlternateModelConfiguration(child, rowId, childPath);
  }
}

function isExactJsExpression(value, expected) {
  return isRecord(value) && hasExactKeys(value, ["__jsExpr"]) &&
    typeof value.__jsExpr === "string" && normalizeJsExpression(value.__jsExpr) === normalizeJsExpression(expected);
}

function normalizeJsExpression(value) {
  return value.replaceAll(/\s+/gu, "");
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
  return { validateProfileManifest, parseProfileDump, validateProfileDump, validateProfileRows };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const { validateProfileManifest, parseProfileDump, validateProfileDump, validateProfileRows } = createProfileValidators();
