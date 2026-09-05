import { validateWebModelFrame, type ModelTerminalEvent } from "@deepseek-pp/web-model-protocol";
import type {
  WebModelTurnCallbacks, WebModelTurnContext, WebModelTurnPort, WebModelTurnRequest,
} from "../../../../core/harness-bridge/model-turn-port.ts";

/** Only the webpage/model boundary is scripted; host, client, cache and coordinator are real. */
export class ControlledModelTurn implements WebModelTurnPort {
  readonly turns: ControlledTurn[] = [];
  cancelCount = 0;
  abortCount = 0;
  onCancel: ((turn: ControlledTurn) => void) | undefined;

  generate(request: unknown, callbacks: WebModelTurnCallbacks, context?: WebModelTurnContext): Promise<ModelTerminalEvent> {
    const frame = validateWebModelFrame({ jsonrpc: "2.0", id: "fixture-generate", method: "model.generate", params: request });
    if (!("method" in frame) || frame.method !== "model.generate") throw new Error("FIXTURE_REQUEST_INVALID");
    return new Promise((resolve) => {
      const turn = new ControlledTurn(frame.params, callbacks, resolve);
      this.turns.push(turn);
      context?.signal?.addEventListener("abort", () => { this.abortCount += 1; }, { once: true });
    });
  }

  cancel(request: unknown) {
    const frame = validateWebModelFrame({ jsonrpc: "2.0", id: "fixture-cancel", method: "model.cancel", params: request });
    if (!("method" in frame) || frame.method !== "model.cancel") throw new Error("FIXTURE_CANCEL_INVALID");
    this.cancelCount += 1;
    const turn = this.turns.find((value) => value.request.request_id === frame.params.request_id);
    if (turn && turn.request.request_digest !== frame.params.request_digest) throw new Error("FIXTURE_DIGEST_MISMATCH");
    const status = turn?.terminal ? "already_terminal" as const : turn ? "cancel_requested" as const : "not_found" as const;
    if (turn && status === "cancel_requested") this.onCancel?.(turn);
    return { request_id: frame.params.request_id, request_digest: frame.params.request_digest, status };
  }

  dispose(): void {
    for (const turn of this.turns) turn.finish({ type: "ambiguous", reason: "deepseek_dispatch_abort_outcome_unknown" });
  }
}

export class ControlledTurn {
  terminal: ModelTerminalEvent | undefined;
  accepted = false;
  readonly request: WebModelTurnRequest;
  private readonly callbacks: WebModelTurnCallbacks;
  private readonly resolve: (terminal: ModelTerminalEvent) => void;
  constructor(
    request: WebModelTurnRequest,
    callbacks: WebModelTurnCallbacks,
    resolve: (terminal: ModelTerminalEvent) => void,
  ) { this.request = request; this.callbacks = callbacks; this.resolve = resolve; }

  accept(): void {
    this.accepted = true;
    this.callbacks.onAccepted({ request_id: this.request.request_id, request_digest: this.request.request_digest, status: "accepted" });
  }

  text(text: string): void { this.callbacks.onTextDelta({ type: "text_delta", text }); }

  finish(terminal: ModelTerminalEvent): void {
    if (this.terminal !== undefined) return;
    this.terminal = terminal;
    this.resolve(terminal);
  }
}
