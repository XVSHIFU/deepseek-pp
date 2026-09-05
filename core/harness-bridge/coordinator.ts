import {
  encodeWebModelFrame,
  type JsonRpcErrorResponse,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelRequestCheckpoint,
} from '@deepseek-pp/web-model-protocol';

import type {
  HarnessBridgeClient,
  HarnessBridgeHostRequest,
} from './client';
import type { HarnessBridgeClientState } from './state';
import type {
  HarnessBridgeStatus,
  HarnessBridgeStatusResult,
  SafeHarnessBridgeState,
} from './contracts';
import { DeepSeekTurnAdapterError, WEB_MODEL_TURN_BUDGETS } from './deepseek-turn-adapter';
import type { WebModelTurnPort } from './model-turn-port';
import {
  HarnessBridgeRecoveryError,
  HarnessBridgeResultCache,
  harnessBridgeAuthorityDigest,
  type HarnessBridgeRecoveryRecord,
  type HarnessBridgeRecoveryStorage,
} from './result-cache';
import {
  HarnessBridgeSettingsError,
  type HarnessBridgeSettings,
  type HarnessBridgeSettingsPatch,
  type HarnessBridgeSettingsStore,
  projectHarnessBridgeSettings,
} from './settings';

export type {
  HarnessBridgeStatus,
  HarnessBridgeStatusFailure,
  HarnessBridgeStatusResult,
  SafeHarnessBridgeState,
} from './contracts';

export interface HarnessBridgeClientPort {
  readonly state: HarnessBridgeClientState;
  start(): void;
  stop(): void;
  reconnect(): void;
  send(frame: unknown): void;
  hydrateRequestCheckpoint(checkpoint: ModelRequestCheckpoint): void;
  subscribe(listener: (state: HarnessBridgeClientState) => void): () => void;
  subscribeRequests(listener: (request: HarnessBridgeHostRequest) => void): () => void;
}

export interface HarnessBridgeCoordinatorDependencies {
  readonly settings: HarnessBridgeSettingsStore;
  readonly turnPort: WebModelTurnPort;
  readonly recoveryStorage: HarnessBridgeRecoveryStorage;
  readonly createClient: (settings: HarnessBridgeSettings) => HarnessBridgeClientPort;
  readonly notifyStatus?: (status: HarnessBridgeStatus) => void | Promise<void>;
  readonly reportError?: (code: string) => void;
}

interface ActiveGeneration {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controller: AbortController;
  readonly binding: ClientBinding;
  readonly authorityEpoch: number;
  readonly authorityDigest: string;
  deliveryTail: Promise<void>;
  deliveryError?: unknown;
  queuedEvents: number;
  queuedBytes: number;
}

interface ClientBinding {
  readonly client: HarnessBridgeClientPort;
  lastPhase: HarnessBridgeClientState['phase'];
  unsubscribeState: () => void;
  unsubscribeRequests: () => void;
  hydration: Promise<void>;
}

/** Browser-side composition root for the Web Model Protocol and DeepSeek turn port. */
export class HarnessBridgeCoordinator {
  private readonly dependencies: HarnessBridgeCoordinatorDependencies;
  private readonly records: HarnessBridgeResultCache;
  private binding: ClientBinding | undefined;
  private active: ActiveGeneration | undefined;
  private settingsValue: HarnessBridgeSettings | undefined;
  private configurationError: string | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | undefined;
  private authorityEpoch = 0;
  private authorityDigest: string | undefined;

  constructor(dependencies: HarnessBridgeCoordinatorDependencies) {
    this.dependencies = dependencies;
    this.records = new HarnessBridgeResultCache(dependencies.recoveryStorage);
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.serialize(async () => {
      try {
        const settings = await this.dependencies.settings.read();
        await this.records.initialize();
        this.configurationError = undefined;
        await this.apply(settings);
      } catch (error) {
        this.configurationError = safeConfigurationError(error);
        this.retireClient();
        this.dependencies.reportError?.(this.configurationError);
      }
    });
    return this.initialization;
  }

  async getStatus(): Promise<HarnessBridgeStatusResult> {
    await this.initialize();
    if (this.configurationError) return Object.freeze({ ok: false, error: this.configurationError });
    const settings = this.settingsValue;
    if (!settings) return Object.freeze({ ok: false, error: 'harness_bridge_not_initialized' });
    return this.createStatus(settings);
  }

  updateSettings(patch: HarnessBridgeSettingsPatch): Promise<HarnessBridgeStatusResult> {
    let result: HarnessBridgeStatusResult = Object.freeze({ ok: false, error: 'harness_bridge_update_failed' });
    return this.initialize().then(() => this.serialize(async () => {
      try {
        const settings = await this.dependencies.settings.update(patch);
        await this.records.validate();
        this.configurationError = undefined;
        await this.apply(settings);
        result = this.createStatus(settings);
      } catch (error) {
        const code = safeConfigurationError(error);
        if (error instanceof HarnessBridgeSettingsError &&
            (error.code === 'harness_bridge_settings_corrupt' ||
             error.code === 'harness_bridge_settings_future_version') ||
            error instanceof HarnessBridgeRecoveryError) {
          this.configurationError = code;
          this.retireClient();
        }
        result = Object.freeze({ ok: false, error: code });
      }
    })).then(() => result);
  }

  stop(): void {
    this.retireClient();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async apply(settings: HarnessBridgeSettings): Promise<void> {
    const previous = this.settingsValue;
    const sameAuthority = previous !== undefined &&
      previous.port === settings.port &&
      previous.pairingToken === settings.pairingToken;
    const unchanged = sameAuthority && previous.enabled === settings.enabled;
    if (!sameAuthority) {
      this.authorityEpoch += 1;
      this.abortActive(undefined, 'bridge_authority_changed');
      this.retireClient();
      await this.active?.deliveryTail;
      if (this.authorityDigest) await this.records.abandon(this.authorityDigest);
      this.authorityDigest = await harnessBridgeAuthorityDigest(settings.port, settings.pairingToken);
    }
    this.settingsValue = settings;
    if (!settings.enabled) {
      this.retireClient();
      void this.publishStatus();
      return;
    }
    if (unchanged && this.binding) {
      if (RECONNECTABLE_PHASES.has(this.binding.client.state.phase)) {
        this.binding.client.reconnect();
      }
      return;
    }
    this.retireClient();
    let client: HarnessBridgeClientPort;
    try {
      client = this.dependencies.createClient(settings);
    } catch {
      this.configurationError = 'harness_bridge_client_config_invalid';
      this.dependencies.reportError?.(this.configurationError);
      return;
    }
    const binding: ClientBinding = {
      client,
      lastPhase: client.state.phase,
      unsubscribeState: () => undefined,
      unsubscribeRequests: () => undefined,
      hydration: Promise.resolve(),
    };
    this.binding = binding;
    binding.unsubscribeRequests = client.subscribeRequests((request) => {
      if (this.binding !== binding) return;
      void this.handleRequest(binding, request);
    });
    binding.unsubscribeState = client.subscribe((state) => {
      if (this.binding !== binding) return;
      const wasReady = binding.lastPhase === 'ready';
      binding.lastPhase = state.phase;
      if (wasReady && state.phase !== 'ready') this.abortActive(binding, 'connection_lost');
      if (state.phase === 'ready') binding.hydration = this.hydrateCheckpoints(binding);
      void this.publishStatus();
    });
    client.start();
  }

  private retireClient(): void {
    const binding = this.binding;
    this.binding = undefined;
    this.abortActive(binding, 'bridge_stopped');
    if (!binding) return;
    binding.unsubscribeRequests();
    binding.unsubscribeState();
    binding.client.stop();
  }

  private async handleRequest(binding: ClientBinding, request: HarnessBridgeHostRequest): Promise<void> {
    await binding.hydration;
    if (this.binding !== binding) return;
    try {
      if (request.method === 'model.generate') {
        await this.handleGenerate(binding, request);
      } else if (request.method === 'model.cancel') {
        await this.handleCancel(binding, request);
      } else {
        await this.handleQuery(binding, request);
      }
    } catch (error) {
      if (error instanceof HarnessBridgeRecoveryError) this.recoveryFailed(error);
      // All request-local failures are converted to a stable protocol frame by
      // the method handlers. A retired socket must not receive a late response.
    }
  }

  private async handleGenerate(binding: ClientBinding, request: ModelGenerateRequest): Promise<void> {
    if (this.active) {
      const sameRequest = this.active.requestId === request.params.request_id;
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest,
        sameRequest ? (this.active.requestDigest === request.params.request_digest ? 'DUPLICATE_REQUEST' : 'REQUEST_IDENTITY_MISMATCH') : 'BROKER_BUSY',
        sameRequest ? 'unknown' : 'not_started');
      return;
    }
    const authorityDigest = this.authorityDigest;
    if (!authorityDigest || this.configurationError) return;
    const controller = new AbortController();
    const active: ActiveGeneration = {
      requestId: request.params.request_id,
      requestDigest: request.params.request_digest,
      controller,
      binding,
      authorityEpoch: this.authorityEpoch,
      authorityDigest,
      deliveryTail: Promise.resolve(),
      queuedEvents: 0,
      queuedBytes: 0,
    };
    this.active = active;
    let adapterAccepted = false;
    let acceptedSent = false;
    let reserved = false;
    let terminalCommitted = false;
    let turnInvoked = false;
    try {
      // A crash anywhere in preparation/dispatch must leave a durable replay
      // tombstone, even before the synchronous accepted callback is reached.
      await this.records.reserve(authorityDigest, active.requestId, active.requestDigest, request.params.session_id);
      reserved = true;
      this.assertActive(active);
      turnInvoked = true;
      const terminal = await this.dependencies.turnPort.generate(request.params, {
        onAccepted: (value) => {
          if (this.active !== active) throw new Error('STALE_GENERATION');
          adapterAccepted = true;
          this.queueDelivery(active, async () => {
            this.assertActive(active);
            binding.client.send({
              jsonrpc: '2.0',
              id: request.id,
              result: { schema_version: 1, type: 'model.accepted', ...value },
            });
            acceptedSent = true;
          });
        },
        onTextDelta: (event) => this.sendEvent(active, event),
        onToolCall: (event) => this.sendEvent(active, event),
        ...(binding.client.state.capabilities?.reasoning === true
          ? { onReasoningDelta: (event: Extract<ModelEvent, { type: 'reasoning_delta' }>) => {
            this.sendEvent(active, event);
          } }
          : {}),
      }, {
        signal: controller.signal,
        negotiatedCapabilities: binding.client.state.capabilities,
      });
      if (this.active !== active || !adapterAccepted) throw new Error('TURN_NOT_ACCEPTED');
      await active.deliveryTail;
      if (active.authorityEpoch !== this.authorityEpoch) return;
      if (active.deliveryError instanceof HarnessBridgeRecoveryError) throw active.deliveryError;
      const record = await this.records.advance(authorityDigest, active.requestId, terminal);
      terminalCommitted = true;
      if (active.authorityEpoch !== this.authorityEpoch) return;
      const currentBinding = this.binding;
      if (currentBinding && currentBinding !== binding && currentBinding.client.state.phase === 'ready') {
        this.hydrateRecord(currentBinding, record);
      }
      if (this.binding === binding && acceptedSent && !controller.signal.aborted) {
        binding.client.send(this.eventFrame(active.requestId, record.last_sequence, record.terminal!));
      }
    } catch (error) {
      if (terminalCommitted || active.authorityEpoch !== this.authorityEpoch) return;
      if (error instanceof HarnessBridgeRecoveryError) {
        if (['DUPLICATE_REQUEST', 'REQUEST_IDENTITY_MISMATCH', 'REQUEST_CAPACITY_EXCEEDED', 'SESSION_QUARANTINED'].includes(error.code)) {
          this.sendError(binding, request.id, active.requestId, active.requestDigest, error.code,
            error.code === 'REQUEST_CAPACITY_EXCEEDED' ? 'not_started' : 'unknown');
        } else this.recoveryFailed(error);
        return;
      }
      await active.deliveryTail;
      if (active.deliveryError instanceof HarnessBridgeRecoveryError) {
        this.recoveryFailed(active.deliveryError);
        return;
      }
      const provenUnstarted = !turnInvoked || (!adapterAccepted && error instanceof DeepSeekTurnAdapterError &&
        error.code !== 'DUPLICATE_REQUEST' && error.code !== 'REQUEST_IDENTITY_MISMATCH' && error.code !== 'SESSION_QUARANTINED');
      if (reserved && provenUnstarted) await this.records.releaseUnstarted(authorityDigest, active.requestId);
      else if (reserved) {
        const record = await this.records.advance(authorityDigest, active.requestId, { type: 'ambiguous', reason: 'browser_recovery_failed' });
        if (this.binding === binding && acceptedSent && !controller.signal.aborted) {
          binding.client.send(this.eventFrame(active.requestId, record.last_sequence, record.terminal!));
        }
      }
      if (this.binding === binding && !adapterAccepted && !controller.signal.aborted) {
        this.sendError(
          binding,
          request.id,
          request.params.request_id,
          request.params.request_digest,
          safePreparationErrorCode(error),
          provenUnstarted ? 'not_started' : 'unknown',
        );
      }
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private async handleCancel(binding: ClientBinding, request: Extract<HarnessBridgeHostRequest, { method: 'model.cancel' }>): Promise<void> {
    try {
      const authorityDigest = this.authorityDigest;
      if (!authorityDigest) return;
      const record = await this.records.requestCancel(authorityDigest, request.params.request_id, request.params.request_digest);
      if (this.binding !== binding || authorityDigest !== this.authorityDigest) return;
      // Persist intent before asking the live adapter to abort. After restart,
      // the durable terminal answers idempotently without a recreated turn.
      const result = record?.terminal
        ? { request_id: request.params.request_id, request_digest: request.params.request_digest, status: 'already_terminal' as const }
        : this.dependencies.turnPort.cancel(request.params);
      binding.client.send({
        jsonrpc: '2.0',
        id: request.id,
        result: { schema_version: 1, type: 'model.cancelled', ...result },
      });
    } catch (error) {
      if (error instanceof HarnessBridgeRecoveryError && error.code !== 'REQUEST_IDENTITY_MISMATCH') {
        this.recoveryFailed(error);
        return;
      }
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest,
        error instanceof HarnessBridgeRecoveryError ? error.code : 'CANCEL_FAILED', 'unknown');
    }
  }

  private async handleQuery(binding: ClientBinding, request: Extract<HarnessBridgeHostRequest, { method: 'model.query' }>): Promise<void> {
    const authorityDigest = this.authorityDigest;
    if (!authorityDigest) return;
    await this.active?.deliveryTail;
    const record = (await this.records.read(authorityDigest)).find((item) => item.request_id === request.params.request_id);
    if (this.binding !== binding || authorityDigest !== this.authorityDigest) return;
    if (record && record.request_digest !== request.params.request_digest) {
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest, 'REQUEST_IDENTITY_MISMATCH', 'unknown');
      return;
    }
    binding.client.send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        schema_version: 1,
        type: 'model.status',
        request_id: request.params.request_id,
        request_digest: request.params.request_digest,
        status: record?.status ?? 'unknown',
        last_sequence: record?.last_sequence ?? 0,
        ...(record?.terminal === undefined ? {} : { terminal: record.terminal }),
      },
    });
  }

  private sendEvent(active: ActiveGeneration, event: ModelEvent): void {
    this.assertActive(active);
    const bytes = new TextEncoder().encode(encodeWebModelFrame(this.eventFrame(active.requestId, Number.MAX_SAFE_INTEGER, event))).byteLength;
    this.queueDelivery(active, async () => {
      this.assertActive(active);
      const record = await this.records.advance(active.authorityDigest, active.requestId);
      this.assertActive(active);
      active.binding.client.send(this.eventFrame(active.requestId, record.last_sequence, event));
    }, bytes);
  }

  private eventFrame(requestId: string, sequence: number, event: ModelEvent) {
    return {
      jsonrpc: '2.0' as const,
      method: 'model.event' as const,
      params: { schema_version: 1 as const, request_id: requestId, sequence, event },
    };
  }

  private queueDelivery(active: ActiveGeneration, operation: () => Promise<void>, bytes = 0): void {
    if (active.queuedEvents >= WEB_MODEL_TURN_BUDGETS.events || active.queuedBytes + bytes > WEB_MODEL_TURN_BUDGETS.outputUtf8Bytes) {
      if (!active.controller.signal.aborted) active.controller.abort('bridge_delivery_budget_exceeded');
      throw new Error('BRIDGE_DELIVERY_BUDGET_EXCEEDED');
    }
    active.queuedEvents += 1;
    active.queuedBytes += bytes;
    active.deliveryTail = active.deliveryTail.then(async () => {
      try { if (active.deliveryError === undefined) await operation(); }
      catch (error) {
        active.deliveryError = error;
        if (!active.controller.signal.aborted) active.controller.abort('bridge_delivery_failed');
        if (error instanceof HarnessBridgeRecoveryError) this.recoveryFailed(error);
      } finally {
        active.queuedEvents -= 1;
        active.queuedBytes -= bytes;
      }
    });
  }

  private recoveryFailed(error: HarnessBridgeRecoveryError): void {
    this.configurationError = error.code;
    this.retireClient();
    this.dependencies.reportError?.(error.code);
  }

  private sendError(
    binding: ClientBinding,
    id: string,
    requestId: string,
    requestDigest: string,
    errorCode: string,
    externalOutcome: 'not_started' | 'unknown' = 'not_started',
  ): void {
    if (this.binding !== binding) return;
    const frame: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32_000,
        message: externalOutcome === 'not_started' ? 'Web model request was not started.' : 'Web model request outcome is unknown.',
        data: {
          schema_version: 1,
          error_code: errorCode,
          retryable: externalOutcome === 'not_started',
          external_outcome: externalOutcome,
          request_id: requestId,
          request_digest: requestDigest,
        },
      },
    };
    binding.client.send(frame);
  }

  private assertActive(active: ActiveGeneration): void {
    if (this.active !== active || this.binding !== active.binding || active.controller.signal.aborted) {
      throw new Error('STALE_GENERATION');
    }
  }

  private async hydrateCheckpoints(binding: ClientBinding): Promise<void> {
    const authorityDigest = this.authorityDigest;
    if (!authorityDigest) return;
    try {
      await this.active?.deliveryTail;
      for (const record of await this.records.read(authorityDigest)) {
        if (this.binding !== binding || authorityDigest !== this.authorityDigest) return;
        this.hydrateRecord(binding, record);
      }
    } catch (error) {
      if (error instanceof HarnessBridgeRecoveryError) this.recoveryFailed(error);
      else this.dependencies.reportError?.('harness_bridge_checkpoint_failed');
    }
  }

  private hydrateRecord(binding: ClientBinding, record: HarnessBridgeRecoveryRecord): void {
    binding.client.hydrateRequestCheckpoint({
      request_id: record.request_id,
      request_digest: record.request_digest,
      status: record.status,
      last_sequence: record.last_sequence,
      ...(record.terminal === undefined ? {} : { terminal: record.terminal }),
    });
  }

  private createStatus(settings: HarnessBridgeSettings): HarnessBridgeStatus {
    const state = this.binding?.client.state ?? { phase: 'stopped', attempt: 0 } as const;
    return Object.freeze({
      ok: true,
      settings: projectHarnessBridgeSettings(settings),
      state: projectSafeState(state),
    });
  }

  private async publishStatus(): Promise<void> {
    const status = await this.getStatus();
    if (!status.ok) return;
    try {
      await this.dependencies.notifyStatus?.(status);
    } catch {
      this.dependencies.reportError?.('harness_bridge_status_notify_failed');
    }
  }

  private abortActive(binding: ClientBinding | undefined, reason: string): void {
    const active = this.active;
    if (!active || (binding && active.binding !== binding)) return;
    if (!active.controller.signal.aborted) active.controller.abort(reason);
  }
}

function safePreparationErrorCode(error: unknown): string {
  if (error instanceof DeepSeekTurnAdapterError &&
      (error.code === 'DEEPSEEK_AUTH_REQUIRED' || error.code === 'DEEPSEEK_PREPARATION_FAILED')) {
    return error.code;
  }
  return 'MODEL_PREPARATION_FAILED';
}

export function projectSafeState(state: HarnessBridgeClientState): SafeHarnessBridgeState {
  return Object.freeze({
    phase: state.phase,
    attempt: state.attempt,
    ...(state.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: state.nextRetryAtMs }),
    ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
  });
}

function safeConfigurationError(error: unknown): string {
  return error instanceof HarnessBridgeSettingsError || error instanceof HarnessBridgeRecoveryError
    ? error.code
    : 'harness_bridge_storage_unavailable';
}

const RECONNECTABLE_PHASES = new Set<HarnessBridgeClientState['phase']>([
  'offline',
  'stopped',
  'needs_pairing',
  'protocol_error',
  'handler_error',
]);

// Compile-time check that the concrete client still satisfies the narrow port.
type _ConcreteClientFitsPort = HarnessBridgeClient extends HarnessBridgeClientPort ? true : never;
const _concreteClientFitsPort: _ConcreteClientFitsPort = true;
void _concreteClientFitsPort;
