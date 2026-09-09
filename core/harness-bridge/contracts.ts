import type { HarnessBridgeClientState } from './state';

export const HARNESS_BRIDGE_SETTINGS_VERSION = 2 as const;
export const DEFAULT_HARNESS_BRIDGE_MIN_REQUEST_INTERVAL_MS = 5_000;
export const MIN_HARNESS_BRIDGE_REQUEST_INTERVAL_MS = 5_000;
export const MAX_HARNESS_BRIDGE_REQUEST_INTERVAL_MS = 30_000;

export interface PublicHarnessBridgeSettings {
  readonly version: typeof HARNESS_BRIDGE_SETTINGS_VERSION;
  readonly enabled: boolean;
  readonly port: number;
  readonly minRequestIntervalMs: number;
  readonly pairingTokenConfigured: boolean;
}

export interface SafeHarnessBridgeState {
  readonly phase: HarnessBridgeClientState['phase'];
  readonly attempt: number;
  readonly nextRetryAtMs?: number;
  readonly errorCode?: string;
}

export interface HarnessBridgeStatus {
  readonly ok: true;
  readonly settings: PublicHarnessBridgeSettings;
  readonly state: SafeHarnessBridgeState;
}

export interface HarnessBridgeStatusFailure {
  readonly ok: false;
  readonly error: string;
}

export type HarnessBridgeStatusResult = HarnessBridgeStatus | HarnessBridgeStatusFailure;
