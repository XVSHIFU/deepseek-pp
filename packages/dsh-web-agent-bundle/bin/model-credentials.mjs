import { join } from "node:path";
import { parseEnv } from "node:util";

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

export async function assertNoLayeredModelCredentials(cwd, home, readOptionalText, { createError = credentialError } = {}) {
  for (const path of new Set([join(cwd, ".env"), join(home, ".env")])) {
    const text = await readOptionalText(path);
    if (text === undefined) continue;
    let values;
    try {
      values = parseEnv(text);
    } catch (cause) {
      throw createError("REAL_WEB_ENV_FILE_INVALID", { cause });
    }
    if (findModelCredentialEnvironment(values).length > 0) {
      throw createError("REAL_WEB_MODEL_CREDENTIAL_PRESENT");
    }
  }
}

function credentialError(code, options) {
  return Object.assign(new Error(code, options), { code });
}
