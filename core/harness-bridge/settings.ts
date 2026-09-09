import { createSerialOperationQueue } from '../persistence/serial-operation-queue';
import { validateHarnessBridgeClientConfig } from './client';
import {
  DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS,
  HARNESS_BRIDGE_SETTINGS_VERSION,
  MAX_HARNESS_BRIDGE_REQUEST_INTERVAL_MS,
  MIN_HARNESS_BRIDGE_REQUEST_INTERVAL_MS,
  type PublicHarnessBridgeSettings,
} from './contracts';

export {
  DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS,
  HARNESS_BRIDGE_SETTINGS_VERSION,
  MAX_HARNESS_BRIDGE_REQUEST_INTERVAL_MS,
  MIN_HARNESS_BRIDGE_REQUEST_INTERVAL_MS,
  type PublicHarnessBridgeSettings,
} from './contracts';

export const HARNESS_BRIDGE_SETTINGS_STORAGE_KEY = 'deepseek_pp_harness_bridge';
export const DEFAULT_HARNESS_BRIDGE_PORT = 43_123;

export type HarnessBridgeSettingsErrorCode =
  | 'harness_bridge_settings_corrupt'
  | 'harness_bridge_settings_future_version'
  | 'harness_bridge_pairing_token_required';

export class HarnessBridgeSettingsError extends Error {
  readonly code: HarnessBridgeSettingsErrorCode;

  constructor(code: HarnessBridgeSettingsErrorCode) {
    super(code);
    this.name = 'HarnessBridgeSettingsError';
    this.code = code;
  }
}

export interface HarnessBridgeSettings {
  readonly version: typeof HARNESS_BRIDGE_SETTINGS_VERSION;
  readonly enabled: boolean;
  readonly port: number;
  readonly minRequestIntervalMs: number;
  readonly pairingToken: string | null;
}

export interface HarnessBridgeSettingsPatch {
  readonly enabled: boolean;
  readonly port: number;
  /** Omit to preserve the existing minimum interval. */
  readonly minRequestIntervalMs?: number;
  /** Omit to preserve the existing browser-local token. */
  readonly pairingToken?: string;
}

export interface HarnessBridgeSettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface HarnessBridgeSettingsStore {
  read(): Promise<HarnessBridgeSettings>;
  update(patch: HarnessBridgeSettingsPatch): Promise<HarnessBridgeSettings>;
}

const DEFAULT_SETTINGS: HarnessBridgeSettings = Object.freeze({
  version: HARNESS_BRIDGE_SETTINGS_VERSION,
  enabled: false,
  port: DEFAULT_HARNESS_BRIDGE_PORT,
  minRequestIntervalMs: DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS,
  pairingToken: null,
});

export function createHarnessBridgeSettingsStore(
  storage: HarnessBridgeSettingsStorage = createBrowserLocalHarnessBridgeStorage(),
): HarnessBridgeSettingsStore {
  const operations = createSerialOperationQueue();
  const readUnlocked = async (): Promise<HarnessBridgeSettings> => {
    const values = await storage.get(HARNESS_BRIDGE_SETTINGS_STORAGE_KEY);
    return decodeHarnessBridgeSettings(values[HARNESS_BRIDGE_SETTINGS_STORAGE_KEY]);
  };
  return Object.freeze({
    read: () => operations.run(readUnlocked),
    update: (patch: HarnessBridgeSettingsPatch) => operations.run(async () => {
      const current = await readUnlocked();
      const normalized = normalizeHarnessBridgeSettingsPatch(patch);
      const next = Object.freeze({
        version: HARNESS_BRIDGE_SETTINGS_VERSION,
        enabled: normalized.enabled,
        port: normalized.port,
        minRequestIntervalMs: normalized.minRequestIntervalMs ?? current.minRequestIntervalMs,
        pairingToken: normalized.pairingToken ?? current.pairingToken,
      });
      if (next.enabled && next.pairingToken === null) {
        throw new HarnessBridgeSettingsError('harness_bridge_pairing_token_required');
      }
      await storage.set({ [HARNESS_BRIDGE_SETTINGS_STORAGE_KEY]: next });
      return next;
    }),
  });
}

/** Missing means a fresh, disabled install and must never trigger an eager write. */
export function decodeHarnessBridgeSettings(value: unknown): HarnessBridgeSettings {
  if (value === undefined) return DEFAULT_SETTINGS;
  const record = strictRecord(value);
  if (typeof record.version === 'number' && Number.isFinite(record.version) &&
      record.version > HARNESS_BRIDGE_SETTINGS_VERSION) {
    throw new HarnessBridgeSettingsError('harness_bridge_settings_future_version');
  }
  if (record.version !== 0 && record.version !== 1 &&
      record.version !== HARNESS_BRIDGE_SETTINGS_VERSION) corrupt();
  const legacy = record.version === 0 || record.version === 1;
  assertExactKeys(record, legacy
    ? ['version', 'enabled', 'port', 'pairingToken']
    : ['version', 'enabled', 'port', 'minRequestIntervalMs', 'pairingToken']);
  if (typeof record.enabled !== 'boolean') corrupt();
  const port = validatePort(record.port);
  const minRequestIntervalMs = legacy
    ? DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS
    : validateHarnessBridgeMinRequestIntervalMs(record.minRequestIntervalMs);
  const pairingToken = record.pairingToken === null
    ? null
    : validateHarnessBridgePairingToken(record.pairingToken);
  if (record.enabled && pairingToken === null) {
    throw new HarnessBridgeSettingsError('harness_bridge_pairing_token_required');
  }
  // Versions 0 and 1 had the same persisted fields. Returning a fresh v2 value
  // with the default interval is a deterministic, side-effect-free migration;
  // the next authorized update writes v2. Reads never overwrite legacy,
  // corrupt, or future data.
  return Object.freeze({
    version: HARNESS_BRIDGE_SETTINGS_VERSION,
    enabled: record.enabled,
    port,
    minRequestIntervalMs,
    pairingToken,
  });
}

export function normalizeHarnessBridgeSettingsPatch(value: unknown): HarnessBridgeSettingsPatch {
  const record = strictRecord(value);
  assertExactKeys(record, ['enabled', 'port'], ['minRequestIntervalMs', 'pairingToken']);
  if (typeof record.enabled !== 'boolean') corrupt();
  return Object.freeze({
    enabled: record.enabled,
    port: validatePort(record.port),
    ...(record.minRequestIntervalMs === undefined
      ? {}
      : { minRequestIntervalMs: validateHarnessBridgeMinRequestIntervalMs(record.minRequestIntervalMs) }),
    ...(record.pairingToken === undefined
      ? {}
      : { pairingToken: validateHarnessBridgePairingToken(record.pairingToken) }),
  });
}

export function projectHarnessBridgeSettings(
  settings: HarnessBridgeSettings,
): PublicHarnessBridgeSettings {
  return Object.freeze({
    version: HARNESS_BRIDGE_SETTINGS_VERSION,
    enabled: settings.enabled,
    port: settings.port,
    minRequestIntervalMs: settings.minRequestIntervalMs,
    pairingTokenConfigured: settings.pairingToken !== null,
  });
}

function createBrowserLocalHarnessBridgeStorage(): HarnessBridgeSettingsStorage {
  return {
    async get(key) {
      return await chrome.storage.local.get(key) as Record<string, unknown>;
    },
    async set(values) {
      await chrome.storage.local.set(values);
    },
  };
}

function validatePort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) corrupt();
  return value as number;
}

export function validateHarnessBridgeMinRequestIntervalMs(value: unknown): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < MIN_HARNESS_BRIDGE_REQUEST_INTERVAL_MS ||
      (value as number) > MAX_HARNESS_BRIDGE_REQUEST_INTERVAL_MS) corrupt();
  return value as number;
}

export function validateHarnessBridgePairingToken(value: unknown): string {
  try {
    return validateHarnessBridgeClientConfig({
      port: DEFAULT_HARNESS_BRIDGE_PORT,
      pairingToken: value,
      browserInstanceId: 'settings-validation',
      clientVersion: '1',
    }).pairingToken;
  } catch {
    return corrupt();
  }
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return corrupt();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size ||
      keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    corrupt();
  }
}

function corrupt(): never {
  throw new HarnessBridgeSettingsError('harness_bridge_settings_corrupt');
}
