export const DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE = "deepseekWebSessionImport" as const;

export interface CompletedSessionImportRequest {
  readonly sourceHome: string;
  readonly rootSessionId: string;
  readonly sourceProcessesStopped: true;
}

export interface CompletedSessionImportReceipt {
  readonly transactionId: string;
  readonly rootSessionId: string;
  readonly sessionIds: readonly string[];
  readonly imported: number;
  readonly idempotent: number;
}

const COMPLETED_SESSION_IMPORT_REQUEST_CODEC = Object.freeze({
  mode: "strict" as const,
  typeSymbol: "@deepseek-pp/dsh-deepseek-web-official-plugin/session-import-contract#CompletedSessionImportRequest",
  schema: Object.freeze({
    parse(value: unknown): CompletedSessionImportRequest {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Completed session import request must be an object");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.join("\0") !== ["rootSessionId", "sourceHome", "sourceProcessesStopped"].join("\0") ||
          typeof record.sourceHome !== "string" || typeof record.rootSessionId !== "string" ||
          record.sourceProcessesStopped !== true) {
        throw new Error("Invalid completed session import request");
      }
      return {
        sourceHome: record.sourceHome,
        rootSessionId: record.rootSessionId,
        sourceProcessesStopped: true,
      };
    },
  }),
});

export const DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze([Object.freeze({
    id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebSessionImport/importCompleted",
    service: "deepseekWebSessionImportRemote",
    namespace: DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE,
    method: "importCompleted",
    invocation: Object.freeze({ kind: "direct" as const }),
    parameters: Object.freeze([
      Object.freeze({
        name: "request",
        wire: "request",
        source: "json" as const,
        codec: COMPLETED_SESSION_IMPORT_REQUEST_CODEC,
      }),
    ]),
    result: Object.freeze({ mode: "src-json" as const }),
  })]),
});
