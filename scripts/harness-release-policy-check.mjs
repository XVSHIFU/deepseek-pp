#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { validateProfileRows } from "./dsh-web-real-smoke.mjs";

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const PRIVATE_ENTRY = /(?:^|\/)(?:\.git|\.dsh|\.release|\.tmp(?:-[^/]*)?|\.env(?:\.[^/]*)?|node_modules|sessions|web-model-journal|logs|test-results|credentials\.json|pairing\.json|owner\.lock)(?:\/|$)|\.(?:jsonl|sqlite(?:3)?|db|log|har)$/iu;
const PRIVATE_HOME = /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/(?:home|Users)\/[^/\s"'<>]+)/u;
const PRIVATE_LITERAL = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{12,}|["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["'][^"'\r\n=]+=[^"'\r\n]+["']|["']?(?:pairing_token|pairingToken|DSH_WEB_PAIRING_TOKEN|api_key|apiKey|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)["']?\s*[:=]\s*["'][A-Za-z0-9_./+=:-]{12,}["']/iu;

export class HarnessReleasePolicyError extends Error {
  constructor(code) { super(code); this.name = "HarnessReleasePolicyError"; this.code = code; }
}

/** Additional payload policy only. Distribution identity/inventory has one owner: readDistribution. */
export function assertPayloadPolicy(relativePath, bytes) {
  if (typeof relativePath !== "string" || PRIVATE_ENTRY.test(relativePath.replaceAll("\\", "/"))) {
    throw new HarnessReleasePolicyError("HARNESS_POLICY_PRIVATE_ENTRY");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PAYLOAD_BYTES) {
    throw new HarnessReleasePolicyError("HARNESS_POLICY_PAYLOAD_LIMIT");
  }
  let payload = bytes;
  if (relativePath.endsWith(".tgz")) {
    try { payload = gunzipSync(bytes, { maxOutputLength: MAX_PAYLOAD_BYTES }); }
    catch { throw new HarnessReleasePolicyError("HARNESS_POLICY_ARCHIVE_INVALID"); }
  }
  // Fixed vendor archives are authenticated by readDistribution before here.
  // Inspect decompressed tar bytes in memory; never extract them to disk.
  const text = payload.toString("utf8").replaceAll("\\\\", "\\");
  if (PRIVATE_HOME.test(text)) throw new HarnessReleasePolicyError("HARNESS_POLICY_PRIVATE_HOME");
  if (PRIVATE_LITERAL.test(text)) throw new HarnessReleasePolicyError("HARNESS_POLICY_CREDENTIAL_LITERAL");
  return payload.length;
}

export async function checkDistributionPolicy(directory, options = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory) || !/^[a-f0-9]{64}$/u.test(options.expectedSha256 ?? "")) {
    throw new HarnessReleasePolicyError("HARNESS_POLICY_DISTRIBUTION_REQUIRED");
  }
  let distribution;
  try {
    const { readDistribution } = await import("../packages/dsh-web-agent-bundle/bin/install-runtime.mjs");
    distribution = await readDistribution(directory, { expectedSha256: options.expectedSha256 });
  } catch {
    // Never include a manifest-controlled filename, filesystem path, or cause.
    throw new HarnessReleasePolicyError("HARNESS_POLICY_DISTRIBUTION_INVALID");
  }
  let totalBytes = 0;
  for (const record of distribution.manifest.files) {
    let bytes;
    try { bytes = await readFile(join(directory, record.path)); }
    catch { throw new HarnessReleasePolicyError("HARNESS_POLICY_PAYLOAD_UNREADABLE"); }
    totalBytes += assertPayloadPolicy(record.path, bytes);
    if (totalBytes > MAX_TOTAL_BYTES) throw new HarnessReleasePolicyError("HARNESS_POLICY_PAYLOAD_LIMIT");
  }
  try {
    const patches = loadOverlayPatches("harness-distribution-policy", join(directory, "packages/dsh-web-agent-bundle/cordis.patch.yml"));
    validateProfileRows(composeEntries([patches]));
  } catch { throw new HarnessReleasePolicyError("HARNESS_POLICY_PROFILE_INVALID"); }
  return {
    schema_version: 1, ok: true, kind: distribution.manifest.kind,
    source_commit: distribution.manifest.source_commit,
    distribution_sha256: distribution.sha256,
    files_checked: distribution.manifest.files.length, payload_bytes_checked: totalBytes,
    // Passing source-distribution policy is not candidate installation/real-web acceptance.
    release_candidate_verified: false,
  };
}

export async function main(args, output = process.stdout) {
  try {
    if (args.length !== 4 || args[0] !== "--distribution"
      || args[2] !== "--sha256" || !/^[a-f0-9]{64}$/u.test(args[3])) {
      throw new HarnessReleasePolicyError("HARNESS_POLICY_DISTRIBUTION_REQUIRED");
    }
    const result = await checkDistributionPolicy(args[1], { expectedSha256: args[3] });
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof HarnessReleasePolicyError ? error.code : "HARNESS_POLICY_FAILED";
    output.write(`${JSON.stringify({ schema_version: 1, ok: false, error: code })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
