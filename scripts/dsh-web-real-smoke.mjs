import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { decodeSeqRanges, decodeStorageRecord } from "@deepseek-ai/dsh-session";
import { JSON_SCHEMA, Type, load as loadYaml } from "js-yaml";

const EXPECTED_DSH_VERSION = "0.1.2-rc.1";
const PROFILE_NAME = "deepseek-web-agent";
const PROVIDER = "deepseek-web";
const MODEL = "current-web-session";
const BUNDLE = "@deepseek-pp/dsh-web-agent-bundle";
const BROWSER_ATTESTATION = "logged-in-and-broker-enabled";
const DEFAULT_BROKER_PORT = 43_123;
const COMMAND_TIMEOUT_MS = 180_000;
const PROCESS_CLEANUP_DEADLINE_MS = 7_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const REAL_WEB_FAILURE_CAUSE_CODES = new Set([
  "BROKER_BUSY",
  "DEEPSEEK_AUTH_REQUIRED",
  "DEEPSEEK_PREPARATION_FAILED",
  "MODEL_PREPARATION_FAILED",
  "TIMEOUT",
  "WAITING_FOR_BROWSER",
  "WEB_MODEL_AMBIGUOUS",
  "WEB_MODEL_TIMEOUT_AMBIGUOUS",
  "WEB_MODEL_DISCONNECTED_AMBIGUOUS",
  "WEB_MODEL_CANCEL_UNCONFIRMED",
  "WEB_MODEL_BROWSER_ABORTED",
  "JOURNAL_UNAVAILABLE",
  "WEB_MODEL_PROTOCOL",
  "WEB_MODEL_TRANSPORT",
]);
const REPO_ROOT = resolve(import.meta.dirname, "..");
const DSH_BIN = join(REPO_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const BROWSER_READY_PATCH = join(
  REPO_ROOT,
  "tests",
  "real",
  "fixtures",
  "dsh-web-real-smoke",
  "browser-ready-barrier.patch.yml",
);

/** Known environment routes capable of selecting a non-web model or supplying model credentials. */
export const MODEL_CREDENTIAL_ENV_NAMES = Object.freeze([
  "ACME_GATEWAY_API_KEY",
  "AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_BEDROCK_ENDPOINT",
  "AWS_BEDROCK_MODEL",
  "AWS_BEDROCK_REGION",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONFIG_FILE",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "COHERE_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GROQ_API_KEY",
  "FIREWORKS_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_PROVIDER",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_PROVIDER",
  "MOONSHOT_API_KEY",
  "OLLAMA_HOST",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
]);

const MODEL_ENV_PREFIX = /^(?:ANTHROPIC|AWS_BEDROCK|AZURE_OPENAI|COHERE|DASHSCOPE|DEEPSEEK|DSH_WEB|FIREWORKS|GEMINI|GOOGLE|GROQ|LLM|MINIMAX|MISTRAL|MODEL|MOONSHOT|OLLAMA|OPENAI|OPENROUTER|TOGETHER|XAI)_/u;
const MODEL_ENV_SUFFIX = /(?:API(?:_|-)?KEY|AUTH(?:_|-)?TOKEN|TOKEN|BASE(?:_|-)?URL|ENDPOINT|HOST|MODEL|PROVIDER)$/u;
const GENERIC_MODEL_CREDENTIAL_SUFFIX = /(?:^|_)(?:API_KEY|AUTH_TOKEN)$/u;
const ALLOWED_BROKER_ENV_NAMES = new Set([
  "DSH_WEB_ALLOWED_EXTENSION_ORIGINS",
  "DSH_WEB_BROKER_PORT",
  "DSH_WEB_PAIRING_TOKEN",
  "DSH_WEB_REAL_BROWSER_ATTESTATION",
]);
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

export class RealWebSmokeError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "RealWebSmokeError";
    this.code = code;
    this.causeCode = options?.causeCode;
  }
}

/**
 * Execute the opt-in real-web single-turn smoke. Tests inject all effects, so
 * the default test suite never opens a socket or contacts a web page.
 */
export async function runRealWebSmoke(options, injected = {}) {
  assertExplicitOptIn(options.args);
  const env = { ...options.env };
  const cwd = resolve(options.cwd);
  const dependencies = { ...defaultDependencies, ...injected };
  const configuration = validateLaunchEnvironment(env, options.nodeVersion ?? process.versions.node);
  await assertNoLayeredModelCredentials(cwd, configuration.home, dependencies.readOptionalText);

  const manifestPath = join(configuration.home, "profiles", PROFILE_NAME, "package.json");
  const manifestText = await safeRead(dependencies.readText, manifestPath, "REAL_WEB_PROFILE_NOT_INSTALLED");
  validateProfileManifest(manifestText);

  const version = await dependencies.runCommand(command([DSH_BIN, "--version"], cwd, env, 15_000));
  if (version.exitCode !== 0 || version.stderr !== "" || version.stdout.trim() !== EXPECTED_DSH_VERSION) {
    throw new RealWebSmokeError("REAL_WEB_HARNESS_VERSION_MISMATCH");
  }

  const dump = await dependencies.runCommand(command([
    DSH_BIN,
    "--profile",
    PROFILE_NAME,
    "--dump-config",
  ], cwd, env, 30_000));
  if (dump.exitCode !== 0 || dump.stderr !== "") {
    throw new RealWebSmokeError("REAL_WEB_PROFILE_INVALID");
  }
  validateProfileDump(dump.stdout);

  const sessionRoot = join(configuration.home, "sessions");
  const priorLogs = await dependencies.listSessionLogs(sessionRoot);
  const requestCorrelation = `web-smoke-${dependencies.randomId()}`;
  const expectedMarker = `DSH_WEB_OK:${requestCorrelation}`;
  const task = [
    "This is a connectivity check. Do not call a tool.",
    `Reply with exactly this single line: ${expectedMarker}`,
  ].join(" ");

  const actual = await dependencies.runCommand(command([
    DSH_BIN,
    "--profile",
    PROFILE_NAME,
    "--patch",
    BROWSER_READY_PATCH,
    task,
  ], cwd, env, COMMAND_TIMEOUT_MS));
  if (actual.exitCode !== 0) {
    if (actual.stderr.includes("WAITING_FOR_BROWSER") || actual.stderr.includes("REAL_WEB_BROWSER_NOT_READY")) {
      throw new RealWebSmokeError("REAL_WEB_BROWSER_NOT_READY");
    }
    const causeCode = await readNewFailureCause(sessionRoot, priorLogs, { cwd, task }, dependencies);
    throw new RealWebSmokeError("REAL_WEB_DSH_FAILED", causeCode === undefined ? undefined : { causeCode });
  }
  if (actual.stderr !== "") throw new RealWebSmokeError("REAL_WEB_UNEXPECTED_DSH_STDERR");
  if (!actual.stdout.endsWith("\n")) throw new RealWebSmokeError("REAL_WEB_RESPONSE_INVALID");
  const finalText = actual.stdout.slice(0, -1);
  if (finalText !== expectedMarker) throw new RealWebSmokeError("REAL_WEB_RESPONSE_INVALID");

  const evidence = await dependencies.readNewSessionEvidence(sessionRoot, priorLogs, {
    cwd,
    task,
    finalText,
    forbiddenExact: [
      configuration.pairingToken,
      ...configuration.allowedOrigins,
    ],
  });
  return Object.freeze({
    schema_version: 1,
    ok: true,
    status: "completed",
    provider: PROVIDER,
    model: MODEL,
    request_correlation: requestCorrelation,
    session_id: evidence.sessionId,
    final_text_sha256: createHash("sha256").update(finalText, "utf8").digest("hex"),
    final_text_bytes: Buffer.byteLength(finalText, "utf8"),
  });
}

export async function main(args, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const result = await runRealWebSmoke({
      args,
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      nodeVersion: options.nodeVersion ?? process.versions.node,
    }, options.dependencies);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof RealWebSmokeError ? error.code : "REAL_WEB_SMOKE_INTERNAL_ERROR";
    const causeCode = error instanceof RealWebSmokeError && isAllowedFailureCauseCode(error.causeCode)
      ? error.causeCode
      : undefined;
    const usageError = code === "REAL_WEB_CONFIRMATION_REQUIRED" || code === "REAL_WEB_ARGUMENTS_INVALID";
    stderr.write(`${JSON.stringify({
      schema_version: 1,
      ok: false,
      status: "failed",
      error: code,
      ...(causeCode === undefined ? {} : { cause_code: causeCode }),
      ...(usageError ? { usage: "node scripts/dsh-web-real-smoke.mjs --confirm-real-web" } : {}),
    })}\n`);
    return usageError ? 2 : 1;
  }
}

export function assertExplicitOptIn(args) {
  if (args.length === 0) throw new RealWebSmokeError("REAL_WEB_CONFIRMATION_REQUIRED");
  if (args.length !== 1 || args[0] !== "--confirm-real-web") {
    throw new RealWebSmokeError("REAL_WEB_ARGUMENTS_INVALID");
  }
}

export function validateLaunchEnvironment(env, nodeVersion) {
  if (Number.parseInt(nodeVersion.split(".")[0] ?? "", 10) !== 24) {
    throw new RealWebSmokeError("REAL_WEB_NODE_VERSION_MISMATCH");
  }
  if (env.DSH_WEB_REAL_BROWSER_ATTESTATION !== BROWSER_ATTESTATION) {
    throw new RealWebSmokeError("REAL_WEB_BROWSER_ATTESTATION_REQUIRED");
  }
  const home = env.DSH_HOME;
  if (typeof home !== "string" || home === "") throw new RealWebSmokeError("REAL_WEB_DSH_HOME_REQUIRED");
  if (!isAbsolute(home)) throw new RealWebSmokeError("REAL_WEB_DSH_HOME_INVALID");
  validateBrokerEnvironment(env);
  if (findModelCredentialEnvironment(env).length > 0) {
    throw new RealWebSmokeError("REAL_WEB_MODEL_CREDENTIAL_PRESENT");
  }
  return {
    home: resolve(home),
    pairingToken: env.DSH_WEB_PAIRING_TOKEN,
    allowedOrigins: env.DSH_WEB_ALLOWED_EXTENSION_ORIGINS.split(","),
  };
}

function validateBrokerEnvironment(env) {
  const token = env.DSH_WEB_PAIRING_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new RealWebSmokeError("REAL_WEB_BROKER_CONFIG_INVALID");
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength < 32 || bytes.toString("base64url") !== token) {
    throw new RealWebSmokeError("REAL_WEB_BROKER_CONFIG_INVALID");
  }
  const origins = env.DSH_WEB_ALLOWED_EXTENSION_ORIGINS?.split(",") ?? [];
  if (origins.length === 0 || origins.some((origin, index) =>
    !/^(?:chrome|moz)-extension:\/\/[A-Za-z0-9_-]+$/u.test(origin) ||
    origin.includes("*") || origins.indexOf(origin) !== index)) {
    throw new RealWebSmokeError("REAL_WEB_BROKER_CONFIG_INVALID");
  }
  const portText = env.DSH_WEB_BROKER_PORT ?? String(DEFAULT_BROKER_PORT);
  const port = Number(portText);
  if (!/^[0-9]+$/u.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RealWebSmokeError("REAL_WEB_BROKER_CONFIG_INVALID");
  }
}

export function findModelCredentialEnvironment(env) {
  const exact = new Set(MODEL_CREDENTIAL_ENV_NAMES);
  return Object.keys(env).filter((name) => {
    const value = env[name];
    if (typeof value !== "string" || value === "") return false;
    const upper = name.toUpperCase();
    if (ALLOWED_BROKER_ENV_NAMES.has(upper)) return false;
    return exact.has(upper) || GENERIC_MODEL_CREDENTIAL_SUFFIX.test(upper) ||
      (MODEL_ENV_PREFIX.test(upper) && MODEL_ENV_SUFFIX.test(upper));
  }).sort();
}

export async function assertNoLayeredModelCredentials(cwd, home, readOptionalText) {
  for (const path of new Set([join(cwd, ".env"), join(home, ".env")])) {
    const text = await readOptionalText(path);
    if (text === undefined) continue;
    let values;
    try {
      values = parseEnv(text);
    } catch (cause) {
      throw new RealWebSmokeError("REAL_WEB_ENV_FILE_INVALID", { cause });
    }
    if (findModelCredentialEnvironment(values).length > 0) {
      throw new RealWebSmokeError("REAL_WEB_MODEL_CREDENTIAL_PRESENT");
    }
  }
}

export function validateProfileManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RealWebSmokeError("REAL_WEB_PROFILE_INVALID", { cause });
  }
  if (!isRecord(value) || value.private !== true || !isRecord(value.dependencies) ||
      Object.keys(value.dependencies).length !== 1 || typeof value.dependencies[BUNDLE] !== "string" ||
      !isRecord(value.dsh) || !isRecord(value.dsh.profile) ||
      value.dsh.profile.patchReload !== "startup" ||
      !Array.isArray(value.dsh.profile.bundles) ||
      value.dsh.profile.bundles.length !== 1 || value.dsh.profile.bundles[0] !== BUNDLE) {
    throw new RealWebSmokeError("REAL_WEB_PROFILE_INVALID");
  }
}

export function parseProfileDump(text) {
  let parsed;
  try {
    parsed = loadYaml(text, { schema: DSH_CONFIG_SCHEMA });
  } catch (cause) {
    throw new RealWebSmokeError("REAL_WEB_PROFILE_INVALID", { cause });
  }
  return parsed;
}

export function validateProfileDump(text) {
  validateProfileRows(parseProfileDump(text));
}

export function validateProfileRows(parsed) {
  if (!Array.isArray(parsed) || parsed.length !== EXPECTED_PROFILE_ROWS.size) {
    throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  }
  const rows = new Map();
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
        rows.has(value.id) || EXPECTED_PROFILE_ROWS.get(value.id) !== value.name ||
        Object.keys(value).some((key) => !["id", "name", "inject", "config"].includes(key))) {
      throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
    }
    rows.set(value.id, value);
  }
  if ([...EXPECTED_PROFILE_ROWS.keys()].some((id) => !rows.has(id))) {
    throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  }
  const selection = rows.get("agent-default-model")?.config;
  if (!isRecord(selection) || !hasExactKeys(selection, ["provider", "model"]) ||
      selection.provider !== PROVIDER || selection.model !== MODEL) {
    throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
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
    throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
  }
  const tools = rows.get("tools")?.config;
  if (!isRecord(tools) || !hasExactKeys(tools, ["mode"]) || tools.mode !== "native") {
    throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
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
      throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
    }
    if (key === "provider" && (rowId !== "agent-default-model" || childPath.join(".") !== "config.provider" || child !== PROVIDER)) {
      throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
    }
    if (key === "model" && (rowId !== "agent-default-model" || childPath.join(".") !== "config.model" || child !== MODEL)) {
      throw new RealWebSmokeError("REAL_WEB_PROVIDER_INVALID");
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

// JSONL rows are storage records, not necessarily individual events: DSH can
// pack many deltas into one row even when file compression is disabled.
export function decodeSessionLog(raw) {
  try {
    const [header, ...records] = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const events = records.flatMap((record) => {
      if (!isRecord(record)) throw new TypeError("Invalid stored session record");
      if (record.sourceEventSeqs !== undefined) {
        if (!Number.isSafeInteger(record.seq) || record.seq < 0) {
          throw new TypeError("Invalid stored session sequence");
        }
        record = { ...record, sourceEventSeqs: decodeSeqRanges(record.sourceEventSeqs, record.seq) };
      }
      return decodeStorageRecord(record);
    });
    if (events.length === 0 || events.some((event, index) => !isRecord(event) || event.seq !== index ||
        !Number.isSafeInteger(event.time) || !isRecord(event.data))) {
      throw new TypeError("Invalid session event sequence");
    }
    return { header, events };
  } catch (cause) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_EVIDENCE_INVALID", { cause });
  }
}

export async function readNewSessionEvidence(root, priorLogs, expected) {
  const after = await listSessionLogs(root);
  const created = [...after].filter((entry) => !priorLogs.has(entry));
  if (created.length !== 1) throw new RealWebSmokeError("REAL_WEB_SESSION_EVIDENCE_INVALID");
  const raw = await readFile(join(root, created[0]), "utf8");
  if (!raw.endsWith("\n")) throw new RealWebSmokeError("REAL_WEB_SESSION_EVIDENCE_INVALID");
  if (/reasoning|authorization|cookie|api[_-]?key|pairing[_-]?token/iu.test(raw) ||
      expected.forbiddenExact.some((value) => value !== "" && raw.includes(value))) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_SENSITIVE_DATA");
  }
  const { header, events } = decodeSessionLog(raw);
  const logicalTypes = [
    "turn/start",
    "step/start",
    "user/message",
    "request/header",
    "request/context",
    "assistant/message",
    "step/end",
    "turn/end",
  ];
  const logical = events.filter((event) => logicalTypes.includes(event.type));
  if (logical.length !== logicalTypes.length ||
      logical.some((event, index) => event.type !== logicalTypes[index]) ||
      events.some((event) => event.type === "tool/call" || event.type === "tool/result")) {
    throw new RealWebSmokeError("REAL_WEB_SESSION_EVIDENCE_INVALID");
  }
  const [turnStart, stepStart, user, requestHeader, requestContext, assistant, stepEnd] = logical;
  const terminal = events.at(-1);
  const turn = turnStart?.data?.turn;
  const step = stepStart?.data?.step;
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string" ||
      header.id.length === 0 || header.cwd !== expected.cwd ||
      !Number.isSafeInteger(turn) || turn !== 1 || stepStart?.data?.turn !== turn ||
      !Number.isSafeInteger(step) || step !== 1 ||
      requestHeader?.data?.header?.config?.provider !== PROVIDER ||
      requestHeader?.data?.header?.config?.model !== MODEL ||
      requestContext?.data?.provider !== PROVIDER || requestContext?.data?.model !== MODEL ||
      !Array.isArray(user?.data?.content) || user.data.content.length !== 1 ||
      user.data.content[0]?.type !== "text" || user.data.content[0].text !== expected.task ||
      assistant?.data?.turn !== turn || assistant?.data?.step !== step ||
      assistant?.data?.message?.source?.provider !== PROVIDER ||
      assistant?.data?.message?.source?.model !== MODEL ||
      !Array.isArray(assistant?.data?.message?.content) || assistant.data.message.content.length !== 1 ||
      assistant.data.message.content[0]?.type !== "text" ||
      assistant.data.message.content[0].text !== expected.finalText ||
      stepEnd?.data?.turn !== turn || stepEnd?.data?.step !== step ||
      events.some((event) => event.type === "assistant/chunk" &&
        (event.data.turn !== turn || event.data.step !== step)) ||
      terminal?.type !== "turn/end" || terminal?.data?.turn !== turn ||
      terminal?.data?.reason?.kind !== "completed") {
    throw new RealWebSmokeError("REAL_WEB_SESSION_EVIDENCE_INVALID");
  }
  return { sessionId: header.id };
}

export async function readNewFailureCause(root, priorLogs, expected, dependencies) {
  try {
    const after = await dependencies.listSessionLogs(root);
    const created = [...after].filter((entry) => !priorLogs.has(entry));
    if (created.length !== 1) return undefined;
    const raw = await dependencies.readText(join(root, created[0]));
    if (!raw.endsWith("\n")) return undefined;
    const { header, events } = decodeSessionLog(raw);
    if (!isRecord(header) || header.type !== "session" || header.cwd !== expected.cwd) return undefined;
    const users = events.filter((event) => event.type === "user/message");
    const requestHeaders = events.filter((event) => event.type === "request/header");
    const terminals = events.filter((event) => event.type === "turn/end");
    const user = users[0];
    const requestHeader = requestHeaders[0];
    const terminal = terminals[0];
    if (users.length !== 1 || requestHeaders.length !== 1 || terminals.length !== 1 ||
        !Array.isArray(user?.data?.content) || user.data.content.length !== 1 ||
        user.data.content[0]?.type !== "text" || user.data.content[0].text !== expected.task ||
        requestHeader?.data?.header?.config?.provider !== PROVIDER ||
        requestHeader?.data?.header?.config?.model !== MODEL ||
        terminal !== events.at(-1) || terminal?.data?.reason?.kind !== "error") return undefined;
    const causeCode = terminal.data.reason.error?.code;
    return isAllowedFailureCauseCode(causeCode) ? causeCode : undefined;
  } catch {
    // Cause enrichment is optional: a missing/corrupt durable record must not
    // replace the original non-zero DSH failure or expose the read/parse error.
    return undefined;
  }
}

function isAllowedFailureCauseCode(value) {
  return typeof value === "string" && REAL_WEB_FAILURE_CAUSE_CODES.has(value);
}

export async function listSessionLogs(root) {
  if (!existsSync(root)) return new Set();
  const entries = await readdir(root, { recursive: true });
  const logs = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.endsWith("session.jsonl")) continue;
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isFile()) logs.push(relative(root, path));
  }
  return new Set(logs);
}

async function safeRead(reader, path, code) {
  try {
    return await reader(path);
  } catch (cause) {
    throw new RealWebSmokeError(code, { cause });
  }
}

function command(args, cwd, env, timeoutMs) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([...args]),
    cwd,
    env,
    timeoutMs,
    shell: false,
    windowsHide: true,
  });
}

export async function runCommand(spec, injected = {}) {
  const terminateTree = injected.terminateOwnedProcessTree ?? terminateOwnedProcessTree;
  const directKill = injected.directKill ?? directKillOwnedProcess;
  const cleanupDeadlineMs = injected.cleanupDeadlineMs ?? PROCESS_CLEANUP_DEADLINE_MS;
  if (!Number.isSafeInteger(cleanupDeadlineMs) || cleanupDeadlineMs < 1 || cleanupDeadlineMs > 30_000) {
    throw new RealWebSmokeError("REAL_WEB_CLEANUP_DEADLINE_INVALID");
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      windowsHide: spec.windowsHide,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let forcedFailure;
    let termination;
    let terminationFailure;
    let settled = false;
    let commandTimer;
    let cleanupTimer;
    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", handleInterrupt);
      process.removeListener("SIGTERM", handleInterrupt);
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (commandTimer !== undefined) clearTimeout(commandTimer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      removeSignalHandlers();
      if (outcome.error !== undefined) rejectCommand(outcome.error);
      else resolveCommand(outcome.result);
    };
    const forcedError = (fallbackCause) => new RealWebSmokeError(
      forcedFailure ?? "REAL_WEB_COMMAND_INTERRUPTED",
      (terminationFailure ?? fallbackCause) === undefined
        ? undefined
        : { cause: terminationFailure ?? fallbackCause },
    );
    const requestTermination = (code) => {
      if (settled) return;
      forcedFailure ??= code;
      if (termination !== undefined) return;
      cleanupTimer = setTimeout(() => {
        let fallbackFailure;
        try {
          directKill(child);
        } catch (error) {
          fallbackFailure = error;
        }
        finish({ error: forcedError(fallbackFailure ?? new Error("PROCESS_CLEANUP_DEADLINE")) });
      }, cleanupDeadlineMs);
      try {
        termination = Promise.resolve(terminateTree(child, spec.env));
      } catch (error) {
        termination = Promise.reject(error);
      }
      void termination.catch((error) => {
        if (settled) return;
        terminationFailure = error;
        try {
          directKill(child);
        } catch (fallbackFailure) {
          terminationFailure = new AggregateError([error, fallbackFailure], "PROCESS_TREE_AND_DIRECT_KILL_FAILED");
        }
      });
    };
    const handleInterrupt = () => requestTermination("REAL_WEB_COMMAND_INTERRUPTED");
    process.once("SIGINT", handleInterrupt);
    process.once("SIGTERM", handleInterrupt);
    const append = (target, chunk) => {
      const next = Buffer.concat([target, chunk]);
      if (next.byteLength > MAX_COMMAND_OUTPUT_BYTES) requestTermination("REAL_WEB_COMMAND_OUTPUT_LIMIT");
      return next.subarray(0, MAX_COMMAND_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, Buffer.from(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, Buffer.from(chunk)); });
    commandTimer = setTimeout(() => requestTermination("REAL_WEB_COMMAND_TIMEOUT"), spec.timeoutMs);
    child.once("error", (cause) => {
      finish({ error: forcedFailure === undefined
        ? new RealWebSmokeError("REAL_WEB_COMMAND_FAILED", { cause })
        : forcedError(cause) });
    });
    child.once("close", (code) => {
      if (forcedFailure !== undefined) {
        finish({ error: forcedError() });
        return;
      }
      finish({
        result: {
          exitCode: code ?? -1,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        },
      });
    });
  });
}

function directKillOwnedProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  if (!child.kill("SIGKILL")) throw new Error("DIRECT_PROCESS_KILL_FAILED");
}

async function terminateOwnedProcessTree(child, env) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return;
  }
  const windowsRoot = env.SystemRoot ?? env.WINDIR;
  if (typeof windowsRoot !== "string" || !isAbsolute(windowsRoot) ||
      basename(resolve(windowsRoot)).toLowerCase() !== "windows") {
    child.kill("SIGKILL");
    throw new Error("INVALID_WINDOWS_SYSTEM_ROOT");
  }
  const taskkill = join(resolve(windowsRoot), "System32", "taskkill.exe");
  if (!existsSync(taskkill)) {
    child.kill("SIGKILL");
    throw new Error("TASKKILL_NOT_FOUND");
  }
  const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
    cwd: resolve(windowsRoot),
    env,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      killer.kill("SIGKILL");
      rejectExit(new Error("TASKKILL_TIMEOUT"));
    }, 5_000);
    killer.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    killer.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    child.kill("SIGKILL");
    throw new Error("TASKKILL_FAILED");
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultDependencies = Object.freeze({
  runCommand,
  readText: (path) => readFile(path, "utf8"),
  readOptionalText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  },
  listSessionLogs,
  readNewSessionEvidence,
  randomId: () => randomBytes(16).toString("hex"),
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
