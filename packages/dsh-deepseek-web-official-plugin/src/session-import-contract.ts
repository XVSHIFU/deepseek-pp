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

export const DEEPSEEK_WEB_SESSION_IMPORT_REMOTE_CONTRIBUTION = Object.freeze({
  package: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  descriptors: Object.freeze([Object.freeze({
    id: "@deepseek-pp/dsh-deepseek-web-official-plugin#deepseekWebSessionImport/importCompleted",
    service: "deepseekWebSessionImportRemote",
    namespace: DEEPSEEK_WEB_SESSION_IMPORT_NAMESPACE,
    method: "importCompleted",
    invocation: Object.freeze({ kind: "direct" as const }),
    parameters: Object.freeze([
      Object.freeze({ mode: "src-json" as const }),
    ]),
    result: Object.freeze({ mode: "src-json" as const }),
  })]),
});
