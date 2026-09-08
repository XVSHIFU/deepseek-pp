import { createHash } from 'node:crypto';

// These are fixed local reason codes, never upstream response messages.
const REASONS = new Set([
  'browser_worker_restarted', 'browser_recovery_failed', 'consumer_callback_outcome_unknown',
  'deepseek_turn_outcome_unknown', 'deepseek_stream_incomplete', 'response_message_id_missing',
  'request_message_id_missing', 'deepseek_chain_unverified', 'adapter_state_inconsistent',
  'deepseek_turn_timeout', 'deepseek_dispatch_abort_outcome_unknown', 'generation_timeout',
  'accept_timeout', 'request_timeout', 'browser_disconnected', 'connection_closed', 'connection_lost',
  'host_stopped', 'send_outcome_unknown', 'stream_limit_exceeded',
  'DEEPSEEK_AUTH_REQUIRED', 'DEEPSEEK_PREPARATION_FAILED', 'MODEL_PREPARATION_FAILED',
  'BROKER_BUSY', 'SESSION_QUARANTINED', 'SESSION_BUSY', 'CAPACITY_EXCEEDED',
  'REQUEST_CAPACITY_EXCEEDED', 'DUPLICATE_REQUEST', 'REQUEST_IDENTITY_MISMATCH',
  'REASONING_NOT_NEGOTIATED', 'REASONING_CALLBACK_REQUIRED', 'REQUEST_ABORTED',
  'BROKER_STOPPED', 'CONNECTION_LOST', 'JOURNAL_UNAVAILABLE', 'PROTOCOL_VIOLATION',
  'REQUEST_ALREADY_EXISTS', 'REQUEST_DIGEST_MISMATCH', 'REQUEST_TIMEOUT', 'WAITING_FOR_BROWSER',
  'TOOL_CALL_INVALID', 'MODEL_OUTPUT_BUDGET_EXCEEDED', 'DEEPSEEK_DISPATCH_FAILED',
  'ACCEPTED_CALLBACK_FAILED',
]);

export function diagnosticSuffix(requestId: string, startedAt: number,
  stage: 'browser_terminal' | 'broker_error' | 'cancel_settlement', reason?: string): string {
  const request = createHash('sha256').update(requestId).digest('hex').slice(0, 16);
  const elapsed = Math.max(0, Math.floor(performance.now() - startedAt));
  return ` [web-diag:v1 request=${request} stage=${stage} reason=${reason && REASONS.has(reason) ? reason : 'unknown'} elapsed_ms=${elapsed}]`;
}
