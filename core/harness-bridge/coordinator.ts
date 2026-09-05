import {
  type JsonRpcErrorResponse,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelRequestCheckpoint,
  type ModelStatus,
  type ModelTerminalEvent,
} from '@deepseek-pp/web-model-protocol';

import type {
  HarnessBridgeClient,
  HarnessBridgeHostRequest,
} from './client';
import type { HarnessBridgeClientState } from './state';
import { DeepSeekTurnAdapterError } from './deepseek-turn-adapter';
import type { WebModelTurnPort } from './model-turn-port';
import {
  HarnessBridgeSettingsError,
  type HarnessBridgeSettings,
  type HarnessBridgeSettingsPatch,
  type HarnessBridgeSettingsStore,
  type PublicHarnessBridgeSettings,
  projectHarnessBridgeSettings,
} from './settings';

const MAX_REQUEST_RECORDS = 1_024;

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
  readonly createClient: (settings: HarnessBridgeSettings) => HarnessBridgeClientPort;
  readonly notifyStatus?: (status: HarnessBridgeStatus) => void | Promise<void>;
  readonly reportError?: (code: string) => void;
}

interface RequestRecord {
  readonly requestDigest: string;
  status: Exclude<ModelStatus, 'unknown'>;
  lastSequence: number;
  terminal?: ModelTerminalEvent;
}

interface ActiveGeneration {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controller: AbortController;
  readonly binding: ClientBinding;
  readonly authorityEpoch: number;
}

interface ClientBinding {
  readonly client: HarnessBridgeClientPort;
  lastPhase: HarnessBridgeClientState['phase'];
  unsubscribeState: () => void;
  unsubscribeRequests: () => void;
}

/** Browser-side composition root for the Web Model Protocol and DeepSeek turn port. */
export class HarnessBridgeCoordinator {
  private readonly dependencies: HarnessBridgeCoordinatorDependencies;
  private readonly records = new Map<string, RequestRecord>();
  private binding: ClientBinding | undefined;
  private active: ActiveGeneration | undefined;
  private settingsValue: HarnessBridgeSettings | undefined;
  private configurationError: string | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | undefined;
  private authorityEpoch = 0;

  constructor(dependencies: HarnessBridgeCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.serialize(async () => {
      try {
        const settings = await this.dependencies.settings.read();
        this.configurationError = undefined;
        this.apply(settings);
      } catch (error) {
        this.configurationError = safeSettingsError(error);
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
        this.configurationError = undefined;
        this.apply(settings);
        result = this.createStatus(settings);
      } catch (error) {
        const code = safeSettingsError(error);
        if (error instanceof HarnessBridgeSettingsError &&
            (error.code === 'harness_bridge_settings_corrupt' ||
             error.code === 'harness_bridge_settings_future_version')) {
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

  private apply(settings: HarnessBridgeSettings): void {
    const previous = this.settingsValue;
    const sameAuthority = previous !== undefined &&
      previous.port === settings.port &&
      previous.pairingToken === settings.pairingToken;
    const unchanged = sameAuthority && previous.enabled === settings.enabled;
    if (!sameAuthority) {
      this.authorityEpoch += 1;
      this.records.clear();
      this.abortActive(undefined, 'bridge_authority_changed');
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
      if (state.phase === 'ready') this.hydrateCheckpoints(binding);
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
    if (this.binding !== binding) return;
    try {
      if (request.method === 'model.generate') {
        await this.handleGenerate(binding, request);
      } else if (request.method === 'model.cancel') {
        this.handleCancel(binding, request);
      } else {
        this.handleQuery(binding, request);
      }
    } catch {
      // All request-local failures are converted to a stable protocol frame by
      // the method handlers. A retired socket must not receive a late response.
    }
  }

  private async handleGenerate(binding: ClientBinding, request: ModelGenerateRequest): Promise<void> {
    if (this.active) {
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest, 'BROKER_BUSY');
      return;
    }
    const prior = this.records.get(request.params.request_id);
    if (prior || this.records.size >= MAX_REQUEST_RECORDS) {
      this.sendError(
        binding,
        request.id,
        request.params.request_id,
        request.params.request_digest,
        prior && prior.requestDigest !== request.params.request_digest
          ? 'REQUEST_IDENTITY_MISMATCH'
          : 'DUPLICATE_REQUEST',
      );
      return;
    }
    const record: RequestRecord = {
      requestDigest: request.params.request_digest,
      status: 'accepted',
      lastSequence: 0,
    };
    const controller = new AbortController();
    const active: ActiveGeneration = {
      requestId: request.params.request_id,
      requestDigest: request.params.request_digest,
      controller,
      binding,
      authorityEpoch: this.authorityEpoch,
    };
    this.active = active;
    let adapterAccepted = false;
    let acceptedSent = false;
    try {
      const terminal = await this.dependencies.turnPort.generate(request.params, {
        onAccepted: (value) => {
          if (this.active !== active) throw new Error('STALE_GENERATION');
          adapterAccepted = true;
          if (this.binding !== binding || controller.signal.aborted) return;
          binding.client.send({
            jsonrpc: '2.0',
            id: request.id,
            result: { schema_version: 1, type: 'model.accepted', ...value },
          });
          acceptedSent = true;
          this.records.set(request.params.request_id, record);
        },
        onTextDelta: (event) => this.sendEvent(active, record, event),
        onToolCall: (event) => this.sendEvent(active, record, event),
        ...(binding.client.state.capabilities?.reasoning === true
          ? { onReasoningDelta: (event: Extract<ModelEvent, { type: 'reasoning_delta' }>) => {
            this.sendEvent(active, record, event);
          } }
          : {}),
      }, {
        signal: controller.signal,
        negotiatedCapabilities: binding.client.state.capabilities,
      });
      if (this.active !== active || !adapterAccepted) throw new Error('TURN_NOT_ACCEPTED');
      if (active.authorityEpoch !== this.authorityEpoch) return;
      this.recordTerminal(record, terminal);
      this.records.set(request.params.request_id, record);
      const currentBinding = this.binding;
      if (currentBinding && currentBinding !== binding && currentBinding.client.state.phase === 'ready') {
        this.hydrateRecord(currentBinding, request.params.request_id, record);
      }
      if (this.binding === binding && acceptedSent && !controller.signal.aborted) {
        binding.client.send(this.eventFrame(active.requestId, record.lastSequence, terminal));
      }
    } catch (error) {
      if (!adapterAccepted) this.records.delete(request.params.request_id);
      if (this.binding === binding && !adapterAccepted && !controller.signal.aborted) {
        this.records.delete(request.params.request_id);
        this.sendError(
          binding,
          request.id,
          request.params.request_id,
          request.params.request_digest,
          safePreparationErrorCode(error),
        );
      }
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private handleCancel(binding: ClientBinding, request: Extract<HarnessBridgeHostRequest, { method: 'model.cancel' }>): void {
    try {
      const result = this.dependencies.turnPort.cancel(request.params);
      binding.client.send({
        jsonrpc: '2.0',
        id: request.id,
        result: { schema_version: 1, type: 'model.cancelled', ...result },
      });
    } catch {
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest, 'CANCEL_FAILED');
    }
  }

  private handleQuery(binding: ClientBinding, request: Extract<HarnessBridgeHostRequest, { method: 'model.query' }>): void {
    const record = this.records.get(request.params.request_id);
    if (record && record.requestDigest !== request.params.request_digest) {
      this.sendError(binding, request.id, request.params.request_id, request.params.request_digest, 'REQUEST_IDENTITY_MISMATCH');
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
        last_sequence: record?.lastSequence ?? 0,
        ...(record?.terminal === undefined ? {} : { terminal: record.terminal }),
      },
    });
  }

  private sendEvent(active: ActiveGeneration, record: RequestRecord, event: ModelEvent): void {
    this.assertActive(active);
    const sequence = record.lastSequence + 1;
    if (isTerminal(event)) {
      // The adapter has established the browser-side outcome. Preserve it
      // before the socket send: a send race must not downgrade known local
      // truth to accepted/streaming on the next authenticated query.
      this.recordTerminal(record, event);
      active.binding.client.send(this.eventFrame(active.requestId, sequence, event));
    } else {
      active.binding.client.send(this.eventFrame(active.requestId, sequence, event));
      record.lastSequence = sequence;
      record.status = 'streaming';
    }
  }

  private eventFrame(requestId: string, sequence: number, event: ModelEvent) {
    return {
      jsonrpc: '2.0' as const,
      method: 'model.event' as const,
      params: { schema_version: 1 as const, request_id: requestId, sequence, event },
    };
  }

  private recordTerminal(record: RequestRecord, terminal: ModelTerminalEvent): void {
    if (record.terminal) return;
    record.lastSequence += 1;
    record.status = terminal.type;
    record.terminal = terminal;
  }

  private sendError(
    binding: ClientBinding,
    id: string,
    requestId: string,
    requestDigest: string,
    errorCode: string,
  ): void {
    if (this.binding !== binding) return;
    const frame: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32_000,
        message: 'Web model request was not started.',
        data: {
          schema_version: 1,
          error_code: errorCode,
          retryable: errorCode !== 'DUPLICATE_REQUEST',
          external_outcome: 'not_started',
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

  private hydrateCheckpoints(binding: ClientBinding): void {
    for (const [requestId, record] of this.records) {
      if (this.binding !== binding) return;
      try {
        this.hydrateRecord(binding, requestId, record);
      } catch {
        this.dependencies.reportError?.('harness_bridge_checkpoint_failed');
        return;
      }
    }
  }

  private hydrateRecord(binding: ClientBinding, requestId: string, record: RequestRecord): void {
    binding.client.hydrateRequestCheckpoint({
      request_id: requestId,
      request_digest: record.requestDigest,
      status: record.status,
      last_sequence: record.lastSequence,
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

function safeSettingsError(error: unknown): string {
  return error instanceof HarnessBridgeSettingsError
    ? error.code
    : 'harness_bridge_storage_unavailable';
}

function isTerminal(event: ModelEvent): event is ModelTerminalEvent {
  return event.type === 'completed' || event.type === 'aborted' ||
    event.type === 'failed' || event.type === 'ambiguous';
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
