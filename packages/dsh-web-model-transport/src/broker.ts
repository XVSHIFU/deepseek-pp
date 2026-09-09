import type {
  ModelCancelledResponse,
  ModelEvent,
  ModelGenerateRequest,
  ModelStatusResponse,
} from "@deepseek-pp/web-model-protocol";

export type BrokerGenerateRequest = Omit<ModelGenerateRequest["params"], "schema_version">;
export type BrokerCancelRequest = Omit<ModelCancelledResponse["result"], "schema_version" | "type" | "status"> & {
  reason?: string;
};
export type BrokerQueryRequest = Pick<BrokerCancelRequest, "request_id" | "request_digest">;
export type BrokerCancelResult = ModelCancelledResponse["result"];
export type BrokerQueryResult = ModelStatusResponse["result"];

export interface DeepSeekWebBroker {
  generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent>;
  cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult>;
  query(request: BrokerQueryRequest): Promise<BrokerQueryResult>;
}

export type BrokerErrorCode =
  | "BROKER_BUSY"
  | "BROKER_STOPPED"
  | "CONNECTION_LOST"
  | "JOURNAL_UNAVAILABLE"
  | "DEEPSEEK_AUTH_REQUIRED"
  | "DEEPSEEK_PREPARATION_FAILED"
  | "MODEL_PREPARATION_FAILED"
  | "SESSION_QUARANTINED"
  | "PROTOCOL_VIOLATION"
  | "REQUEST_ALREADY_EXISTS"
  | "REQUEST_DIGEST_MISMATCH"
  | "REQUEST_TIMEOUT"
  | "WAITING_FOR_BROWSER";

export type ExternalOutcome = "not_started" | "started" | "unknown";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly externalOutcome: ExternalOutcome;
  readonly remoteCode?: string;

  constructor(code: BrokerErrorCode, externalOutcome: ExternalOutcome, remoteCode?: string) {
    super(code);
    this.name = "BrokerError";
    this.code = code;
    this.externalOutcome = externalOutcome;
    // Remote strings are untrusted; never retain arbitrary error text or tokens.
    if (remoteCode && [
      'DEEPSEEK_AUTH_REQUIRED', 'DEEPSEEK_PREPARATION_FAILED', 'MODEL_PREPARATION_FAILED',
      'BROKER_BUSY', 'SESSION_QUARANTINED', 'SESSION_BUSY', 'CAPACITY_EXCEEDED',
      'REQUEST_CAPACITY_EXCEEDED', 'DUPLICATE_REQUEST', 'REQUEST_IDENTITY_MISMATCH',
      'REASONING_NOT_NEGOTIATED', 'REASONING_CALLBACK_REQUIRED', 'REQUEST_ABORTED',
    ].includes(remoteCode)) this.remoteCode = remoteCode;
  }
}
