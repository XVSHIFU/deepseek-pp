import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1" as const;
export const WEB_MODEL_PATH = "/web-model/v1" as const;
export const WEB_MODEL_SUBPROTOCOL = "deepseek-web-model.v1" as const;

const MINIMUM_TOKEN_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const EXTENSION_ORIGIN_PATTERN = /^(?:chrome|moz)-extension:\/\/[A-Za-z0-9_-]+$/u;

export function createPairingToken(): string {
  return randomBytes(MINIMUM_TOKEN_BYTES).toString("base64url");
}

export function assertPairingToken(token: string): void {
  if (!BASE64URL_PATTERN.test(token)) throw new Error("INVALID_PAIRING_TOKEN");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength < MINIMUM_TOKEN_BYTES || decoded.toString("base64url") !== token) {
    throw new Error("INVALID_PAIRING_TOKEN");
  }
}

export function pairingTokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function assertAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) throw new Error("INVALID_ORIGIN_ALLOWLIST");
  const result = new Set<string>();
  for (const origin of origins) {
    if (!EXTENSION_ORIGIN_PATTERN.test(origin) || origin.includes("*") || result.has(origin)) {
      throw new Error("INVALID_ORIGIN_ALLOWLIST");
    }
    result.add(origin);
  }
  return result;
}

export function hasSingleHeader(request: Pick<IncomingMessage, "rawHeaders">, name: string): boolean {
  const expected = name.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expected) count += 1;
  }
  return count === 1;
}

export interface UpgradePolicy {
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
}

export type UpgradeRejection = "REMOTE" | "HOST" | "ORIGIN" | "METHOD" | "PATH" | "SUBPROTOCOL";

export function validateUpgradeRequest(request: IncomingMessage, policy: UpgradePolicy): UpgradeRejection | null {
  if (request.socket.remoteAddress !== LOOPBACK_HOST) return "REMOTE";
  if (!hasSingleHeader(request, "host") || request.headers.host !== `${LOOPBACK_HOST}:${policy.port}`) return "HOST";
  if (!hasSingleHeader(request, "origin") || typeof request.headers.origin !== "string" ||
      !policy.allowedOrigins.has(request.headers.origin)) return "ORIGIN";
  if (request.method !== "GET") return "METHOD";
  if (request.url !== WEB_MODEL_PATH) return "PATH";
  if (!hasSingleHeader(request, "sec-websocket-protocol") ||
      request.headers["sec-websocket-protocol"] !== WEB_MODEL_SUBPROTOCOL) return "SUBPROTOCOL";
  return null;
}
