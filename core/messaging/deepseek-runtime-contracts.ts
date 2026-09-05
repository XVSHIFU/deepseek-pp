import type { OfficialApiChatConfig } from '../chat/official-api-config-contract';
import type { DeepSeekUploadedFile } from '../deepseek/contracts';
import type {
  ConversationExportErrorResult,
  ConversationExportRequest,
  ConversationExportResult,
} from '../export/types';
import type {
  MultimodalMediaAnalyzeResponse,
} from '../multimodal/media';
import type { MultimodalSettingsStatus } from '../multimodal/settings-contracts';
import type { MessageAction } from '../types';
import type { HarnessBridgeStatusResult } from '../harness-bridge/contracts';
import type { HarnessBridgeSettingsPatch } from '../harness-bridge/settings';

type DeclaredRuntimeRequest<TType extends MessageAction['type']> = Extract<
  MessageAction,
  { type: TType }
>;

type Ack = { ok: true };
type DomainFailure = { ok: false; error: string };

export interface ChatAuthStatus {
  ok: true;
  available: boolean;
  provider: 'official-api' | 'deepseek-web' | null;
  hasApiKey: boolean;
  hasToken: boolean;
}

export interface ChatSubmitPromptPayload {
  text: string;
  config?: Partial<OfficialApiChatConfig>;
  refFileIds?: unknown;
}

export interface DeepSeekImageUploadPayload {
  dataUrl: string;
  name?: string;
  mimeType?: string;
  type?: string;
  sizeBytes?: number;
  size?: number;
}

export type DeepSeekImageUploadResponse =
  | { ok: true; file: DeepSeekUploadedFile }
  | DomainFailure;

export interface ConversationExportCommandPayload {
  exportId?: string;
  request?: unknown;
}

export interface NormalizedConversationExportCommand {
  exportId?: string;
  request: ConversationExportRequest;
}

export interface DeepSeekRuntimeCommandContracts {
  GET_HARNESS_BRIDGE_STATUS: {
    request: { type: 'GET_HARNESS_BRIDGE_STATUS' };
    response: HarnessBridgeStatusResult;
  };
  UPDATE_HARNESS_BRIDGE_SETTINGS: {
    request: { type: 'UPDATE_HARNESS_BRIDGE_SETTINGS'; payload: HarnessBridgeSettingsPatch };
    response: HarnessBridgeStatusResult;
  };
  GET_DEEPSEEK_API_KEY_STATUS: {
    request: { type: 'GET_DEEPSEEK_API_KEY_STATUS' };
    response: { ok: true; configured: boolean };
  };
  SAVE_DEEPSEEK_API_KEY: {
    request: { type: 'SAVE_DEEPSEEK_API_KEY'; payload: { apiKey: string } };
    response: { ok: true; configured: true };
  };
  CLEAR_DEEPSEEK_API_KEY: {
    request: { type: 'CLEAR_DEEPSEEK_API_KEY' };
    response: { ok: true; configured: false };
  };
  GET_MULTIMODAL_SETTINGS_STATUS: {
    request: DeclaredRuntimeRequest<'GET_MULTIMODAL_SETTINGS_STATUS'>;
    response: { ok: true } & MultimodalSettingsStatus;
  };
  SAVE_MULTIMODAL_SETTINGS: {
    request: DeclaredRuntimeRequest<'SAVE_MULTIMODAL_SETTINGS'>;
    response: { ok: true } & MultimodalSettingsStatus;
  };
  CLEAR_MULTIMODAL_SETTINGS: {
    request: DeclaredRuntimeRequest<'CLEAR_MULTIMODAL_SETTINGS'>;
    response: { ok: true } & MultimodalSettingsStatus;
  };
  ANALYZE_MULTIMODAL_MEDIA: {
    request: DeclaredRuntimeRequest<'ANALYZE_MULTIMODAL_MEDIA'>;
    response: MultimodalMediaAnalyzeResponse;
  };
  CHAT_SUBMIT_PROMPT: {
    request: { type: 'CHAT_SUBMIT_PROMPT'; payload: ChatSubmitPromptPayload };
    response: Ack | DomainFailure;
  };
  UPLOAD_DEEPSEEK_IMAGE: {
    request: { type: 'UPLOAD_DEEPSEEK_IMAGE'; payload: DeepSeekImageUploadPayload };
    response: DeepSeekImageUploadResponse;
  };
  CHAT_NEW_SESSION: {
    request: { type: 'CHAT_NEW_SESSION' };
    response: Ack;
  };
  GET_AUTH_STATUS: {
    request: { type: 'GET_AUTH_STATUS' };
    response: ChatAuthStatus;
  };
  GET_OFFICIAL_API_CHAT_CONFIG: {
    request: DeclaredRuntimeRequest<'GET_OFFICIAL_API_CHAT_CONFIG'>;
    response: OfficialApiChatConfig;
  };
  SAVE_OFFICIAL_API_CHAT_CONFIG: {
    request: DeclaredRuntimeRequest<'SAVE_OFFICIAL_API_CHAT_CONFIG'>;
    response: OfficialApiChatConfig;
  };
  EXPORT_DEEPSEEK_CONVERSATIONS: {
    request: { type: 'EXPORT_DEEPSEEK_CONVERSATIONS'; payload?: ConversationExportCommandPayload };
    response: ConversationExportResult | ConversationExportErrorResult;
  };
  CANCEL_DEEPSEEK_EXPORT: {
    request: { type: 'CANCEL_DEEPSEEK_EXPORT'; payload: { exportId?: string } };
    response: Ack | DomainFailure;
  };
  AUTH_STATUS_CHANGED: {
    request: { type: 'AUTH_STATUS_CHANGED' };
    response: Ack;
  };
}

const HARNESS_BRIDGE_PHASES = new Set([
  'offline',
  'connecting',
  'authenticating',
  'ready',
  'retry_wait',
  'needs_pairing',
  'handler_error',
  'protocol_error',
  'stopped',
]);

/** Strict client-side decoder shared by direct responses and status broadcasts. */
export function decodeHarnessBridgeStatusResult(value: unknown): HarnessBridgeStatusResult {
  const root = exactRecord(value, ['ok'], ['settings', 'state', 'error']);
  if (root.ok === false) {
    assertExactRuntimeKeys(root, ['ok', 'error']);
    return Object.freeze({ ok: false, error: boundedRuntimeString(root.error, 1, 128) });
  }
  if (root.ok !== true) invalidHarnessStatus();
  assertExactRuntimeKeys(root, ['ok', 'settings', 'state']);
  const settings = exactRecord(root.settings, [
    'version', 'enabled', 'port', 'pairingTokenConfigured',
  ]);
  if (settings.version !== 1 || typeof settings.enabled !== 'boolean' ||
      typeof settings.pairingTokenConfigured !== 'boolean' ||
      !Number.isSafeInteger(settings.port) || (settings.port as number) < 1 ||
      (settings.port as number) > 65_535) invalidHarnessStatus();
  const state = exactRecord(root.state, ['phase', 'attempt'], ['nextRetryAtMs', 'errorCode']);
  if (typeof state.phase !== 'string' || !HARNESS_BRIDGE_PHASES.has(state.phase) ||
      !Number.isSafeInteger(state.attempt) || (state.attempt as number) < 0 ||
      (state.attempt as number) > 20) invalidHarnessStatus();
  if (state.nextRetryAtMs !== undefined &&
      (!Number.isSafeInteger(state.nextRetryAtMs) || (state.nextRetryAtMs as number) < 0)) {
    invalidHarnessStatus();
  }
  if (state.errorCode !== undefined) boundedRuntimeString(state.errorCode, 1, 128);
  return Object.freeze({
    ok: true,
    settings: Object.freeze({
      version: 1,
      enabled: settings.enabled,
      port: settings.port,
      pairingTokenConfigured: settings.pairingTokenConfigured,
    }),
    state: Object.freeze({
      phase: state.phase,
      attempt: state.attempt,
      ...(state.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: state.nextRetryAtMs }),
      ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
    }),
  }) as HarnessBridgeStatusResult;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalidHarnessStatus();
  }
  const record = value as Record<string, unknown>;
  assertExactRuntimeKeys(record, required, optional);
  return record;
}

function assertExactRuntimeKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size ||
      keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    invalidHarnessStatus();
  }
}

function boundedRuntimeString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    return invalidHarnessStatus();
  }
  return value;
}

function invalidHarnessStatus(): never {
  throw new Error('Invalid Harness bridge status response.');
}
