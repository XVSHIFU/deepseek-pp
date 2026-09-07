import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type {
  CompletedSessionImportReceipt,
  CompletedSessionImportRequest,
} from "./session-import-contract.ts";
import type { SessionImportService } from "./session-import.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebSessionImportRemote: DeepSeekWebSessionImportRemote;
  }
}
/** Explicit local-only settings action; no import is triggered at startup. */
export class DeepSeekWebSessionImportRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly importer: SessionImportService) {
    super(ctx, "deepseekWebSessionImportRemote");
    for (const initialize of remoteInitializers) initialize.call(this);
  }

  async importCompleted(request: CompletedSessionImportRequest): Promise<CompletedSessionImportReceipt> {
    if (!isRecord(request) || typeof request.sourceHome !== "string" || typeof request.rootSessionId !== "string" ||
        request.sourceProcessesStopped !== true || Object.keys(request).sort().join("\0") !==
          ["rootSessionId", "sourceHome", "sourceProcessesStopped"].sort().join("\0")) {
      throw new Error("SESSION_IMPORT_REQUEST_INVALID");
    }
    return this.importer.importCompleted(request);
  }
}

const remoteInitializers: Array<(this: DeepSeekWebSessionImportRemote) => void> = [];

const decorate = Remote as unknown as (
  value: (...args: never[]) => unknown,
  context: {
    readonly kind: "method";
    readonly name: string;
    readonly static: false;
    readonly private: false;
    addInitializer(initializer: (this: DeepSeekWebSessionImportRemote) => void): void;
  },
) => void;
decorate(DeepSeekWebSessionImportRemote.prototype.importCompleted as (...args: never[]) => unknown, {
  kind: "method",
  name: "importCompleted",
  static: false,
  private: false,
  addInitializer(initializer) { remoteInitializers.push(initializer); },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
