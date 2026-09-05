import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

import { HarnessBridgeClient } from "../../../../core/harness-bridge/client.ts";
import { HarnessBridgeCoordinator } from "../../../../core/harness-bridge/coordinator.ts";
import type { WebModelTurnPort } from "../../../../core/harness-bridge/model-turn-port.ts";
import type { HarnessBridgeRecoveryStorage } from "../../../../core/harness-bridge/result-cache.ts";
import { createHarnessBridgeSettingsStore, HARNESS_BRIDGE_SETTINGS_STORAGE_KEY } from "../../../../core/harness-bridge/settings.ts";
import { RecoverySockets, waitUntil } from "./socket.ts";

/** Disk-backed substitute for the browser storage boundary, not the cache itself. */
export function recoveryFileStorage(filename: string): HarnessBridgeRecoveryStorage {
  return {
    async read() {
      try { return JSON.parse(await readFile(filename, "utf8")) as unknown; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    async write(value) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
      await rename(temporary, filename);
    },
  };
}

export async function createRecoveryBrowser(options: {
  readonly port: number;
  readonly pairingToken: string;
  readonly cacheFile: string;
  readonly turnPort: WebModelTurnPort;
  readonly sockets?: RecoverySockets;
}) {
  const sockets = options.sockets ?? new RecoverySockets();
  const values: Record<string, unknown> = {
    [HARNESS_BRIDGE_SETTINGS_STORAGE_KEY]: { version: 1, enabled: true, port: options.port, pairingToken: options.pairingToken },
  };
  const settings = createHarnessBridgeSettingsStore({
    get: async () => structuredClone(values),
    set: async (next) => { Object.assign(values, structuredClone(next)); },
  });
  const errors: string[] = [];
  const coordinator = new HarnessBridgeCoordinator({
    settings,
    turnPort: options.turnPort,
    recoveryStorage: recoveryFileStorage(options.cacheFile),
    createClient: () => new HarnessBridgeClient({
      port: options.port, pairingToken: options.pairingToken,
      browserInstanceId: `recovery-browser-${randomUUID()}`, clientVersion: "0.0.0-test",
      capabilities: { text: true, structured_tool_calls: true, usage: true, cancel: true, query: true },
      timing: { connectTimeoutMs: 1000, helloTimeoutMs: 1000, heartbeatIntervalMs: 1000,
        retryBaseMs: 100, retryMaxMs: 100, maxAttempts: 1 },
    }, { webSocketFactory: sockets.factory }),
    reportError: (code) => { errors.push(code); },
  });
  try {
    await coordinator.initialize();
    await waitUntil(async () => {
      const status = await coordinator.getStatus();
      if (!status.ok) throw new Error(status.error);
      return status.state.phase === "ready";
    }, "RECOVERY_BROWSER_NOT_READY");
    return {
      coordinator, sockets, errors,
      async dispose() { coordinator.stop(); await sockets.dispose(); },
    };
  } catch (error) {
    coordinator.stop();
    await sockets.dispose();
    throw error;
  }
}
