import type { BridgeCapabilities } from '@deepseek-pp/web-model-protocol';

import type { HarnessBridgeClientErrorCode } from './errors';

export type HarnessBridgeClientPhase =
  | 'offline'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'retry_wait'
  | 'needs_pairing'
  | 'handler_error'
  | 'protocol_error'
  | 'stopped';

export interface HarnessBridgeClientState {
  readonly phase: HarnessBridgeClientPhase;
  readonly attempt: number;
  readonly nextRetryAtMs?: number;
  readonly errorCode?: HarnessBridgeClientErrorCode;
  readonly capabilities?: BridgeCapabilities;
}

export type HarnessBridgeStateListener = (state: HarnessBridgeClientState) => void;

export function createHarnessBridgeState(
  phase: HarnessBridgeClientPhase,
  attempt: number,
  options: {
    nextRetryAtMs?: number;
    errorCode?: HarnessBridgeClientErrorCode;
    capabilities?: BridgeCapabilities;
  } = {},
): HarnessBridgeClientState {
  return Object.freeze({
    phase,
    attempt,
    ...(options.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: options.nextRetryAtMs }),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    ...(options.capabilities === undefined ? {} : { capabilities: Object.freeze({ ...options.capabilities }) }),
  });
}
