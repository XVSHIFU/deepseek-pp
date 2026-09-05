import {
  validateWebModelFrame,
  type ModelRequestCheckpoint,
  type ModelTerminalEvent,
} from '@deepseek-pp/web-model-protocol';

import { createSerialOperationQueue } from '../persistence/serial-operation-queue';
import { createSha256Checksum } from '../sync/checksum';

export const HARNESS_BRIDGE_RECOVERY_VERSION = 1 as const;
export const MAX_HARNESS_BRIDGE_RECOVERY_RECORDS = 1_024;

export interface HarnessBridgeRecoveryRecord extends ModelRequestCheckpoint {
  readonly authorityDigest: string;
  readonly sessionId: string;
  readonly cancelRequested: boolean;
}

export interface HarnessBridgeRecoveryIndex {
  readonly version: typeof HARNESS_BRIDGE_RECOVERY_VERSION;
  readonly records: readonly HarnessBridgeRecoveryRecord[];
}

/** Owns one dedicated browser-local key; never settings or sync storage. */
export interface HarnessBridgeRecoveryStorage {
  read(): Promise<unknown>;
  write(value: HarnessBridgeRecoveryIndex): Promise<void>;
}

export class HarnessBridgeRecoveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'HarnessBridgeRecoveryError';
    this.code = code;
  }
}

const RECOVERED_TERMINAL = Object.freeze({ type: 'ambiguous', reason: 'browser_worker_restarted' } as const);
const SAFE_AMBIGUOUS_REASONS = new Set([
  'browser_worker_restarted', 'browser_recovery_failed',
  'consumer_callback_outcome_unknown', 'deepseek_turn_outcome_unknown',
  'deepseek_stream_incomplete', 'response_message_id_missing', 'request_message_id_missing',
  'deepseek_chain_unverified', 'adapter_state_inconsistent', 'deepseek_turn_timeout',
  'deepseek_dispatch_abort_outcome_unknown',
]);
const SAFE_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ACCEPTED_CALLBACK_FAILED: 'The accepted response could not be delivered.',
  DEEPSEEK_DISPATCH_FAILED: 'The DeepSeek request was not dispatched.',
  TOOL_CALL_INVALID: 'DeepSeek returned an invalid structured tool call.',
  MODEL_OUTPUT_BUDGET_EXCEEDED: 'DeepSeek output exceeded the browser adapter budget.',
  WEB_MODEL_FAILED: 'The browser model request failed.',
});

/** Only allowlisted metadata is durable; free-form reasons/messages never are. */
export function recoveryTerminal(event: ModelTerminalEvent): ModelTerminalEvent {
  if (event.type === 'completed') return { type: 'completed', finish_reason: event.finish_reason };
  if (event.type === 'aborted') return { type: 'aborted', reason: 'request_cancelled_before_dispatch' };
  if (event.type === 'ambiguous') return {
    type: 'ambiguous',
    reason: SAFE_AMBIGUOUS_REASONS.has(event.reason) ? event.reason : 'browser_recovery_failed',
  };
  const code = Object.hasOwn(SAFE_FAILURE_MESSAGES, event.error.code) ? event.error.code : 'WEB_MODEL_FAILED';
  return { type: 'failed', error: {
    code, message: SAFE_FAILURE_MESSAGES[code]!, retryable: false,
    external_outcome: event.error.external_outcome,
  } };
}

export async function harnessBridgeAuthorityDigest(port: number, token: string | null): Promise<string> {
  return (await createSha256Checksum(JSON.stringify(['deepseek-harness-recovery-v1', port, token]))).value;
}

/**
 * The coordinator's sole request index. Each operation re-reads inside this
 * store-local FIFO and commits before returning; there is no parallel Map.
 * Capacity exhaustion rejects new work instead of evicting replay tombstones.
 */
export class HarnessBridgeResultCache {
  private readonly operations = createSerialOperationQueue();
  private readonly storage: HarnessBridgeRecoveryStorage;

  constructor(storage: HarnessBridgeRecoveryStorage) { this.storage = storage; }

  private async load(): Promise<unknown> {
    try { return await this.storage.read(); }
    catch { throw new HarnessBridgeRecoveryError('harness_bridge_recovery_unavailable'); }
  }

  initialize(): Promise<void> {
    return this.operations.run(async () => {
      const current = decodeHarnessBridgeRecoveryIndex(await this.load());
      if (current === undefined) return;
      let changed = false;
      const records = current.records.map((record) => {
        if (record.status !== 'accepted' && record.status !== 'streaming') return record;
        changed = true;
        return { ...record, status: 'ambiguous' as const, last_sequence: record.last_sequence + 1, terminal: RECOVERED_TERMINAL };
      });
      if (changed) await this.write({ ...current, records });
    });
  }

  /** Authority switches never erase another authority's replay tombstones. */
  validate(): Promise<void> {
    return this.operations.run(async () => {
      decodeHarnessBridgeRecoveryIndex(await this.load());
    });
  }

  abandon(authorityDigest: string): Promise<void> {
    return this.mutate(authorityDigest, (records) => records.map((record) =>
      record.authorityDigest === authorityDigest && !record.terminal
        ? { ...record, status: 'ambiguous', last_sequence: record.last_sequence + 1, terminal: RECOVERED_TERMINAL }
        : record));
  }

  read(authorityDigest: string): Promise<readonly HarnessBridgeRecoveryRecord[]> {
    return this.operations.run(async () => (await this.readCurrent()).records.filter((record) => record.authorityDigest === authorityDigest));
  }

  reserve(authorityDigest: string, requestId: string, requestDigest: string, sessionId: string): Promise<void> {
    return this.mutate(authorityDigest, (records) => {
      const prior = records.find((record) => record.authorityDigest === authorityDigest && record.request_id === requestId);
      if (prior) throw new HarnessBridgeRecoveryError(prior.request_digest === requestDigest ? 'DUPLICATE_REQUEST' : 'REQUEST_IDENTITY_MISMATCH');
      if (records.some((record) => record.authorityDigest === authorityDigest && record.sessionId === sessionId &&
          (record.status === 'ambiguous' || !record.terminal))) {
        throw new HarnessBridgeRecoveryError('SESSION_QUARANTINED');
      }
      if (records.length >= MAX_HARNESS_BRIDGE_RECOVERY_RECORDS) throw new HarnessBridgeRecoveryError('REQUEST_CAPACITY_EXCEEDED');
      return [...records, { authorityDigest, request_id: requestId, request_digest: requestDigest, sessionId,
        status: 'accepted' as const, last_sequence: 0, cancelRequested: false }];
    });
  }

  releaseUnstarted(authorityDigest: string, requestId: string): Promise<void> {
    return this.mutate(authorityDigest, (records) => records.filter((record) => {
      if (record.authorityDigest !== authorityDigest || record.request_id !== requestId) return true;
      if (record.status !== 'accepted' || record.last_sequence !== 0) throw new HarnessBridgeRecoveryError('REQUEST_PHASE_INVALID');
      return false;
    }));
  }

  advance(authorityDigest: string, requestId: string, terminal?: ModelTerminalEvent): Promise<HarnessBridgeRecoveryRecord> {
    let next!: HarnessBridgeRecoveryRecord;
    return this.mutate(authorityDigest, (records) => records.map((record) => {
      if (record.authorityDigest !== authorityDigest || record.request_id !== requestId) return record;
      if (record.terminal) throw new HarnessBridgeRecoveryError('REQUEST_PHASE_INVALID');
      const safeTerminal = terminal === undefined ? undefined : recoveryTerminal(terminal);
      next = { ...record, status: safeTerminal?.type ?? 'streaming', last_sequence: record.last_sequence + 1,
        ...(safeTerminal === undefined ? {} : { terminal: safeTerminal }) };
      return next;
    }), () => { if (!next) throw new HarnessBridgeRecoveryError('REQUEST_NOT_FOUND'); }).then(() => next);
  }

  requestCancel(authorityDigest: string, requestId: string, requestDigest: string): Promise<HarnessBridgeRecoveryRecord | undefined> {
    let found: HarnessBridgeRecoveryRecord | undefined;
    return this.mutate(authorityDigest, (records) => records.map((record) => {
      if (record.authorityDigest !== authorityDigest || record.request_id !== requestId) return record;
      if (record.request_digest !== requestDigest) throw new HarnessBridgeRecoveryError('REQUEST_IDENTITY_MISMATCH');
      found = record.terminal ? record : { ...record, cancelRequested: true };
      return found;
    })).then(() => found);
  }

  private mutate(
    authorityDigest: string,
    update: (records: readonly HarnessBridgeRecoveryRecord[]) => readonly HarnessBridgeRecoveryRecord[],
    validate?: () => void,
  ): Promise<void> {
    return this.operations.run(async () => {
      const current = await this.readCurrent();
      const records = update(current.records);
      validate?.();
      await this.write({ ...current, records });
    });
  }

  private async readCurrent(): Promise<HarnessBridgeRecoveryIndex> {
    const current = decodeHarnessBridgeRecoveryIndex(await this.load());
    return current ?? { version: 1, records: [] };
  }

  private async write(value: HarnessBridgeRecoveryIndex): Promise<void> {
    const checked = decodeHarnessBridgeRecoveryIndex(value)!;
    try { await this.storage.write(checked); }
    catch { throw new HarnessBridgeRecoveryError('harness_bridge_recovery_unavailable'); }
  }
}

export function decodeHarnessBridgeRecoveryIndex(value: unknown): HarnessBridgeRecoveryIndex | undefined {
  if (value === undefined) return undefined;
  const index = record(value);
  if (typeof index.version === 'number' && Number.isFinite(index.version) && index.version > 1) {
    throw new HarnessBridgeRecoveryError('harness_bridge_recovery_future_version');
  }
  exactKeys(index, ['version', 'records']);
  if (index.version !== 1 ||
      !Array.isArray(index.records) || index.records.length > MAX_HARNESS_BRIDGE_RECOVERY_RECORDS) corrupt();
  const ids = new Set<string>();
  const records = index.records.map((item) => {
    const entry = record(item);
    exactKeys(entry, ['authorityDigest', 'request_id', 'request_digest', 'sessionId', 'status', 'last_sequence', 'cancelRequested'], ['terminal']);
    if (typeof entry.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.authorityDigest) ||
        typeof entry.cancelRequested !== 'boolean' || entry.status === 'unknown') corrupt();
    const { authorityDigest, sessionId, cancelRequested, ...checkpoint } = entry;
    try {
      validateWebModelFrame({ jsonrpc: '2.0', id: 'recovery-index', result: { schema_version: 1, type: 'model.status', ...checkpoint } });
      validateWebModelFrame({ jsonrpc: '2.0', id: 'recovery-session', method: 'model.query', params: {
        schema_version: 1, request_id: sessionId, request_digest: entry.request_digest,
      } });
    } catch { corrupt(); }
    if (entry.terminal !== undefined) {
      const terminal = entry.terminal as ModelTerminalEvent;
      const safe = recoveryTerminal(terminal);
      if (terminal.type === 'failed' && safe.type === 'failed' &&
          (terminal.error.code !== safe.error.code || terminal.error.message !== safe.error.message)) corrupt();
      if ('reason' in terminal && 'reason' in safe && terminal.reason !== safe.reason) corrupt();
    }
    const identity = `${authorityDigest}:${entry.request_id}`;
    if (ids.has(identity)) corrupt();
    ids.add(identity);
    return structuredClone(entry) as unknown as HarnessBridgeRecoveryRecord;
  });
  return { version: 1, records };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) corrupt();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) corrupt();
}
function corrupt(): never { throw new HarnessBridgeRecoveryError('harness_bridge_recovery_corrupt'); }
