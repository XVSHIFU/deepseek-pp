import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type {
  DeepSeekWebConnectionStatus,
  DeepSeekWebReconnectReceipt,
} from "./connection-contract.ts";
import type { DeepSeekWebConnectionController } from "./connection-controller.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    deepseekWebConnection: DeepSeekWebConnectionRemote;
  }
}

/** Narrow, redacted Host status/control surface discovered by the official Gateway. */
export class DeepSeekWebConnectionRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly controller: DeepSeekWebConnectionController) {
    super(ctx, "deepseekWebConnection");
    for (const initialize of remoteInitializers) initialize.call(this);
  }

  status(): DeepSeekWebConnectionStatus {
    return projectStatus(this.controller.status());
  }

  async reconnect(): Promise<DeepSeekWebReconnectReceipt> {
    const receipt = await this.controller.requestReconfigure("reconnect");
    return Object.freeze({
      accepted: receipt.accepted,
      deferred: receipt.deferred,
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      status: projectStatus(receipt.status),
    });
  }
}

/** Field-by-field wire projection prevents future internal state from riding a response. */
function projectStatus(status: DeepSeekWebConnectionStatus): DeepSeekWebConnectionStatus {
  return Object.freeze({
    phase: status.phase,
    configured: status.configured,
    tokenConfigured: status.tokenConfigured,
    originConfigured: status.originConfigured,
    busy: status.busy,
    pendingReconfigure: status.pendingReconfigure,
    browser: status.browser,
    port: status.port,
    windows: Object.freeze({ ...status.windows }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  });
}

const remoteInitializers: Array<(this: DeepSeekWebConnectionRemote) => void> = [];

markRemote("status");
markRemote("reconnect");

/** Apply the standard decorator without leaving decorator syntax in source-loaded tests. */
function markRemote(method: "status" | "reconnect"): void {
  const decorate = Remote as unknown as (
    value: (...args: never[]) => unknown,
    context: {
      readonly kind: "method";
      readonly name: string;
      readonly static: false;
      readonly private: false;
      addInitializer(initializer: (this: DeepSeekWebConnectionRemote) => void): void;
    },
  ) => void;
  decorate(DeepSeekWebConnectionRemote.prototype[method] as (...args: never[]) => unknown, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    },
  });
}
