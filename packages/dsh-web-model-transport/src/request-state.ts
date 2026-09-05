import { createHash } from "node:crypto";
import { isTerminalEvent, type ModelEvent, type ModelStatusResponse, type ModelTerminalEvent } from "@deepseek-pp/web-model-protocol";

export type RequestPhase = "planned" | "dispatched" | "accepted" | "streaming" | "completed" | "failed" | "aborted" | "ambiguous";
export interface RequestRecord {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: RequestPhase;
  readonly outcome: "not_started" | "started" | "unknown";
  readonly sequence: number;
  readonly remoteStatus?: Exclude<ModelStatusResponse["result"]["status"], "unknown">;
  readonly terminalDigest?: string;
  readonly cancelRequested: boolean;
  readonly cancelStatus?: "cancel_requested" | "already_terminal" | "not_found";
}
export type RequestAction =
  | { readonly type: "dispatch" | "accept" | "disconnect" | "not_started" | "cancel" }
  | { readonly type: "cancel_ack"; readonly status: NonNullable<RequestRecord["cancelStatus"]> }
  | { readonly type: "event"; readonly sequence: number; readonly event: ModelEvent }
  | { readonly type: "query"; readonly result: ModelStatusResponse["result"] };

export function terminalDigest(event: ModelTerminalEvent): string {
  // Hash the protocol's terminal equality fields in fixed order, never the
  // arbitrary JSON key order used by a later status response.
  const fields = event.type === "completed" ? [event.type, event.finish_reason]
    : event.type === "failed" ? [event.type, event.error.code, event.error.message, event.error.retryable, event.error.external_outcome]
    : [event.type, event.reason];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export function isFinalRecord(record: RequestRecord): boolean {
  return ["completed", "failed", "aborted"].includes(record.state);
}

/** Receiver-owned generation/revision CAS; never derives completion from streamed text. */
export function transitionRequest(record: RequestRecord, generation: number, revision: number, action: RequestAction): RequestRecord {
  if (record.generation !== generation || record.revision !== revision) throw new Error("JOURNAL_CAS_MISMATCH");
  const next = { ...record, revision: revision + 1 };
  switch (action.type) {
    case "dispatch":
      if (record.state !== "planned") break;
      return { ...next, state: "dispatched", outcome: "unknown" };
    case "accept":
      if (record.state !== "dispatched") break;
      return { ...next, state: "accepted", outcome: "started", remoteStatus: "accepted" };
    case "not_started":
      if (record.state !== "dispatched") break;
      return { ...next, state: "failed", outcome: "not_started" };
    case "disconnect":
      if (isFinalRecord(record) || record.state === "ambiguous") return record;
      return { ...next, state: "ambiguous", outcome: "unknown" };
    case "cancel":
      if (record.cancelRequested) return record;
      return { ...next, cancelRequested: true };
    case "cancel_ack":
      if (!record.cancelRequested) break;
      return { ...next, cancelStatus: action.status };
    case "event": {
      if (record.state !== "accepted" && record.state !== "streaming") break;
      if (action.sequence !== record.sequence + 1) throw new Error("JOURNAL_SEQUENCE_MISMATCH");
      const terminal = isTerminalEvent(action.event);
      return { ...next, state: terminal ? action.event.type : "streaming", outcome: "started", sequence: action.sequence,
        remoteStatus: terminal ? action.event.type : "streaming", ...(terminal ? { terminalDigest: terminalDigest(action.event) } : {}) };
    }
    case "query": {
      const result = action.result;
      if (result.request_id !== record.requestId || result.request_digest !== record.requestDigest) break;
      if (result.status === "unknown") return record;
      if (result.last_sequence < record.sequence) throw new Error("JOURNAL_SEQUENCE_MISMATCH");
      if (record.terminalDigest && (!result.terminal || terminalDigest(result.terminal) !== record.terminalDigest || result.last_sequence !== record.sequence)) break;
      // A status index cannot replace a lost stream. Recovery stays ambiguous.
      const lostStream = !isFinalRecord(record) && record.state !== "ambiguous"
        && (result.status !== record.remoteStatus || result.last_sequence !== record.sequence);
      return { ...next, ...(lostStream ? { state: "ambiguous" as const, outcome: "unknown" as const } : {}),
        remoteStatus: result.status, sequence: result.last_sequence,
        ...(result.terminal ? { terminalDigest: terminalDigest(result.terminal) } : {}) };
    }
  }
  throw new Error("JOURNAL_INVALID_TRANSITION");
}
