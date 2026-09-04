import {
  MAX_ARRAY_LENGTH,
  MAX_ID_LENGTH,
  MAX_OBJECT_PROPERTIES,
  MAX_STRUCTURE_DEPTH,
  MAX_STRUCTURE_NODES,
} from "./constants";
import type { JsonObject, JsonValue } from "./types";

export type ProtocolValidationCode =
  | "ARRAY_TOO_LONG"
  | "FORBIDDEN_FIELD"
  | "FRAME_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_TYPE"
  | "INVALID_UNICODE"
  | "INVALID_VALUE"
  | "OUT_OF_RANGE"
  | "STRUCTURE_TOO_DEEP"
  | "STRUCTURE_TOO_LARGE"
  | "UNKNOWN_FIELD"
  | "UNSUPPORTED_VERSION";

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationCode;
  readonly path: string;

  constructor(code: ProtocolValidationCode, path = "$") {
    super(`${code} at ${path}`);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}

export function fail(code: ProtocolValidationCode, path: string): never {
  throw new ProtocolValidationError(code, path);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail("INVALID_TYPE", path);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowedCount = required.length + optional.length;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > allowedCount) fail("UNKNOWN_FIELD", path);
  const allowed = new Set([...required, ...optional]);
  for (const key of keys) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail("INVALID_VALUE", `${path}.${key}`);
  }
}

export function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) {
    if (path.endsWith("schema_version") && typeof value === "number") fail("UNSUPPORTED_VERSION", path);
    fail("INVALID_VALUE", path);
  }
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("INVALID_VALUE", path);
}

export function bool(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail("INVALID_TYPE", path);
}

export function integer(value: unknown, minimum: number, maximum: number, path: string): asserts value is number {
  if (!Number.isSafeInteger(value)) fail("INVALID_TYPE", path);
  if ((value as number) < minimum || (value as number) > maximum) fail("OUT_OF_RANGE", path);
}

export function finiteNumber(value: unknown, minimum: number, maximum: number, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("INVALID_TYPE", path);
  if (value < minimum || value > maximum) fail("OUT_OF_RANGE", path);
}

export function stringValue(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  path: string,
): asserts value is string {
  if (typeof value !== "string") fail("INVALID_TYPE", path);
  if (value.length < minimumLength || value.length > maximumLength) fail("OUT_OF_RANGE", path);
  assertWellFormedUnicode(value, path);
}

export function identifier(value: unknown, path: string): asserts value is string {
  stringValue(value, 1, MAX_ID_LENGTH, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail("INVALID_VALUE", path);
}

export function arrayValue(value: unknown, maximum: number, path: string): unknown[] {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path);
  if (value.length > Math.min(maximum, MAX_ARRAY_LENGTH)) fail("ARRAY_TOO_LONG", path);
  return value;
}

export function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_UNICODE", path);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("INVALID_UNICODE", path);
    }
  }
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_UNICODE", "$frame");
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("INVALID_UNICODE", "$frame");
    } else bytes += 3;
  }
  return bytes;
}

export function assertJsonStructure(value: unknown): asserts value is JsonValue {
  const queue: Array<{ value: unknown; depth: number; path: string }> = [{ value, depth: 0, path: "$" }];
  let cursor = 0;
  let nodes = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES) fail("STRUCTURE_TOO_LARGE", current.path);
    if (current.depth > MAX_STRUCTURE_DEPTH) fail("STRUCTURE_TOO_DEEP", current.path);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("INVALID_TYPE", current.path);
      continue;
    }
    if (typeof item === "string") {
      assertWellFormedUnicode(item, current.path);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length > MAX_ARRAY_LENGTH) fail("ARRAY_TOO_LONG", current.path);
      for (let index = 0; index < item.length; index += 1) {
        queue.push({ value: item[index], depth: current.depth + 1, path: `${current.path}[${index}]` });
      }
      continue;
    }
    if (!isRecord(item)) fail("INVALID_TYPE", current.path);
    const entries = Object.entries(item);
    if (entries.length > MAX_OBJECT_PROPERTIES) fail("STRUCTURE_TOO_LARGE", current.path);
    for (const [key, child] of entries) {
      assertWellFormedUnicode(key, current.path);
      queue.push({ value: child, depth: current.depth + 1, path: `${current.path}.${key}` });
    }
  }
}

export function jsonObject(value: unknown, path: string): asserts value is JsonObject {
  if (!isRecord(value)) fail("INVALID_TYPE", path);
}
