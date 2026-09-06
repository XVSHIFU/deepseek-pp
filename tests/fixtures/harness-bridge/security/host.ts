import { once } from "node:events";
import WebSocket from "ws";
import { DeepSeekWebModelHost, createPairingToken, type DeepSeekWebModelHostAddress } from "@deepseek-pp/dsh-web-model-transport";
import { decodeWebModelFrame, encodeWebModelFrame } from "@deepseek-pp/web-model-protocol";
import { FAKE_EXTENSION_ORIGIN } from "../fake-peer/index";
import { helloRequest } from "../protocol-v1/frames";

/** Only synthetic local peers; production Host, codec and upgrade policy stay authoritative. */
export async function securityHost(journalPath?: string) {
  const token = createPairingToken();
  const host = new DeepSeekWebModelHost({
    port: 0, pairingToken: token, allowedOrigins: [FAKE_EXTENSION_ORIGIN],
    authenticationTimeoutMs: 1_000, rpcTimeoutMs: 1_000, heartbeatTimeoutMs: 10_000,
    ...(journalPath === undefined ? {} : { journalPath }),
  });
  const address = await host.start();
  return { host, address, token };
}

export async function openSocket(address: DeepSeekWebModelHostAddress) {
  const socket = new WebSocket(address.url, address.subprotocol, { origin: FAKE_EXTENSION_ORIGIN });
  socket.on("error", () => undefined);
  await once(socket, "open");
  return socket;
}

export async function authenticate(socket: WebSocket, token: string) {
  const response = once(socket, "message");
  socket.send(encodeWebModelFrame({ ...helloRequest, params: { ...helloRequest.params, pairing_token: token } }));
  const [data] = await response;
  return decodeWebModelFrame(data.toString());
}

export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
