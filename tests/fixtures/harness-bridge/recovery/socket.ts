import WebSocket from "ws";

import { decodeWebModelFrame, type WebModelFrame } from "@deepseek-pp/web-model-protocol";
import type { HarnessBridgeWebSocketFactory } from "../../../../core/harness-bridge/client.ts";
import { FAKE_EXTENSION_ORIGIN } from "../fake-peer/index.ts";

/** Faults stay at the real socket boundary; the production client owns validation. */
export class RecoverySockets {
  readonly incoming: WebModelFrame[] = [];
  readonly outgoing: WebModelFrame[] = [];
  readonly sockets: WebSocket[] = [];
  intercept: ((frame: WebModelFrame) => "drop" | "suppress" | undefined) | undefined;

  readonly factory: HarnessBridgeWebSocketFactory = (url, protocol) => {
    const socket = new WebSocket(url, protocol, { origin: FAKE_EXTENSION_ORIGIN });
    this.sockets.push(socket);
    socket.on("message", (bytes) => { this.incoming.push(decodeWebModelFrame(bytes.toString())); });
    socket.on("error", () => undefined);
    return {
      get readyState() { return socket.readyState; },
      send: (data) => {
        const frame = decodeWebModelFrame(data);
        // Pairing hello remains ephemeral and is not part of evidence assertions.
        if (!("method" in frame && frame.method === "bridge.hello")) this.outgoing.push(frame);
        const fault = this.intercept?.(frame);
        if (fault === "drop") {
          socket.terminate();
          return;
        }
        if (fault === "suppress") return;
        socket.send(data);
      },
      close: (code, reason) => socket.close(code, reason),
      addEventListener: socket.addEventListener.bind(socket),
    };
  };

  async disconnect(): Promise<void> {
    const socket = this.sockets.at(-1);
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    socket.terminate();
    await waitUntil(() => socket.readyState === WebSocket.CLOSED, "RECOVERY_SOCKET_DID_NOT_CLOSE");
  }

  async dispose(): Promise<void> {
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    await waitUntil(() => this.sockets.every((socket) => socket.readyState === WebSocket.CLOSED), "RECOVERY_SOCKETS_NOT_CLOSED");
  }

  get generateCount(): number {
    return this.incoming.filter((frame) => "method" in frame && frame.method === "model.generate").length;
  }
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, code: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(code);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
