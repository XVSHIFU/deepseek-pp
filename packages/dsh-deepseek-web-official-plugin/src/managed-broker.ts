import {
  BrokerError,
  type BrokerCancelRequest,
  type BrokerCancelResult,
  type BrokerGenerateRequest,
  type BrokerQueryRequest,
  type BrokerQueryResult,
  type DeepSeekWebBroker,
} from "@deepseek-pp/dsh-web-model-transport";
import type { ModelEvent } from "@deepseek-pp/web-model-protocol";

/** Stable broker service whose delegate exists only after pairing is configured. */
export class ManagedDeepSeekWebBroker implements DeepSeekWebBroker {
  private delegate: DeepSeekWebBroker | undefined;

  attach(delegate: DeepSeekWebBroker): void {
    if (this.delegate !== undefined) throw new Error("DEEPSEEK_WEB_BROKER_ALREADY_ATTACHED");
    this.delegate = delegate;
  }

  detach(delegate: DeepSeekWebBroker): void {
    if (this.delegate === delegate) this.delegate = undefined;
  }

  async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    const delegate = this.available();
    yield* delegate.generate(request);
  }

  cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    return this.available().cancel(request);
  }

  query(request: BrokerQueryRequest): Promise<BrokerQueryResult> {
    return this.available().query(request);
  }

  private available(): DeepSeekWebBroker {
    if (this.delegate === undefined) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.delegate;
  }
}
