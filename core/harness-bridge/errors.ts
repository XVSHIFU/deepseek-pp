export type HarnessBridgeClientErrorCode =
  | 'CONFIG_INVALID'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'HANDLER_FAILED'
  | 'HELLO_TIMEOUT'
  | 'NOT_READY'
  | 'PAIRING_REJECTED'
  | 'PROTOCOL_ERROR'
  | 'RETRY_EXHAUSTED'
  | 'SOCKET_SEND_FAILED';

export class HarnessBridgeClientError extends Error {
  readonly code: HarnessBridgeClientErrorCode;

  constructor(code: HarnessBridgeClientErrorCode) {
    super(code);
    this.name = 'HarnessBridgeClientError';
    this.code = code;
  }
}
