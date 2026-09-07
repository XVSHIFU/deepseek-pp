import {
  BrokerError,
  DeepSeekWebModelHost,
  type BrokerCancelRequest,
  type BrokerCancelResult,
  type BrokerGenerateRequest,
  type BrokerQueryRequest,
  type BrokerQueryResult,
  type DeepSeekWebBroker,
  type DeepSeekWebModelHostOptions,
} from "@deepseek-pp/dsh-web-model-transport";
import type { ModelEvent } from "@deepseek-pp/web-model-protocol";

import {
  type DeepSeekWebConnectionStatus,
  type DeepSeekWebOfficialSettings,
  type DeepSeekWebReconnectReceipt,
  type DeepSeekWebWindowsStatus,
} from "./connection-contract.ts";
import { extensionOrigin } from "./config.ts";

export interface DeepSeekWebHost extends DeepSeekWebBroker {
  readonly hasAuthenticatedPeer: boolean;
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

export interface DeepSeekWebConnectionControllerOptions {
  readonly readSettings: () => DeepSeekWebOfficialSettings;
  readonly resolvePairingToken: () => Promise<string | undefined>;
  readonly createHost: (options: DeepSeekWebHostConfiguration) => DeepSeekWebHost;
  readonly readWindowsStatus?: () => DeepSeekWebWindowsStatus;
  readonly reportError?: (error: unknown) => void;
}

export interface DeepSeekWebHostConfiguration {
  readonly pairingToken: string;
  readonly allowedOrigins: readonly string[];
  readonly port: number;
}

export type ReconfigureReason = "settings" | "credential" | "reconnect";

/** Owns the one live Host and swaps it only while every broker operation is idle. */
export class DeepSeekWebConnectionController {
  readonly broker: DeepSeekWebBroker;
  private host: DeepSeekWebHost | undefined;
  private readonly cleanupHosts = new Set<DeepSeekWebHost>();
  private activeOperations = 0;
  private tokenConfigured = false;
  private pendingReconfigure = false;
  private stopped = false;
  private lastErrorCode: "CONNECTION_START_FAILED" | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DeepSeekWebConnectionControllerOptions) {
    this.broker = new TrackedBroker(this);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    await this.queueReconfigure();
  }

  status(): DeepSeekWebConnectionStatus {
    const settings = this.options.readSettings();
    const originConfigured = extensionOrigin(settings) !== undefined;
    const configured = originConfigured && this.tokenConfigured;
    const busy = this.activeOperations > 0;
    let phase: DeepSeekWebConnectionStatus["phase"];
    if (this.lastErrorCode !== undefined) phase = "error";
    else if (!configured || this.host === undefined) phase = "unconfigured";
    else if (busy) phase = "busy";
    else if (this.host.hasAuthenticatedPeer) phase = "connected";
    else phase = "waiting_for_browser";
    return Object.freeze({
      phase,
      configured,
      tokenConfigured: this.tokenConfigured,
      originConfigured,
      busy,
      pendingReconfigure: this.pendingReconfigure,
      browser: settings.browser,
      port: settings.port,
      windows: this.options.readWindowsStatus?.() ?? { kind: "disabled" as const },
      ...(this.lastErrorCode === undefined ? {} : { errorCode: this.lastErrorCode }),
    });
  }

  async requestReconfigure(reason: ReconfigureReason): Promise<DeepSeekWebReconnectReceipt> {
    if (this.stopped) throw new Error("DEEPSEEK_WEB_CONNECTION_STOPPED");
    if (this.activeOperations > 0) {
      if (reason === "reconnect") {
        return { accepted: false, deferred: false, reason: "busy", status: this.status() };
      }
      this.pendingReconfigure = true;
      return { accepted: true, deferred: true, status: this.status() };
    }
    await this.queueReconfigure();
    const status = this.status();
    return {
      accepted: status.configured,
      deferred: false,
      ...(status.configured ? {} : { reason: "unconfigured" as const }),
      status,
    };
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.pendingReconfigure = false;
    await this.tail;
    const host = this.host;
    this.host = undefined;
    if (host !== undefined) this.cleanupHosts.add(host);
    const failures: unknown[] = [];
    for (const candidate of this.cleanupHosts) {
      try {
        await candidate.stop();
        this.cleanupHosts.delete(candidate);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DeepSeek Web connection cleanup failed");
  }

  delegate(): DeepSeekWebHost {
    if (this.host === undefined) throw new BrokerError("WAITING_FOR_BROWSER", "not_started");
    return this.host;
  }

  operationStarted(): void {
    this.activeOperations += 1;
  }

  operationFinished(): void {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0 || !this.pendingReconfigure || this.stopped) return;
    this.pendingReconfigure = false;
    void this.queueReconfigure().catch((error) => {
      this.lastErrorCode = "CONNECTION_START_FAILED";
      this.options.reportError?.(error);
    });
  }

  private queueReconfigure(): Promise<void> {
    const next = this.tail.then(() => this.reconfigure());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async reconfigure(): Promise<void> {
    if (this.stopped) return;
    if (this.activeOperations > 0) {
      this.pendingReconfigure = true;
      return;
    }
    const previous = this.host;
    this.host = undefined;
    this.lastErrorCode = undefined;
    if (previous !== undefined) {
      this.cleanupHosts.add(previous);
      try {
        await previous.stop();
        this.cleanupHosts.delete(previous);
      } catch (error) {
        this.connectionFailed(error);
        return;
      }
    }
    let next: DeepSeekWebHost | undefined;
    try {
      const settings = this.options.readSettings();
      const origin = extensionOrigin(settings);
      const pairingToken = await this.options.resolvePairingToken();
      this.tokenConfigured = pairingToken !== undefined;
      if (origin === undefined || pairingToken === undefined) return;
      next = this.options.createHost({
        pairingToken,
        allowedOrigins: [origin],
        port: settings.port,
      });
      this.cleanupHosts.add(next);
      await next.start();
      if (this.stopped) {
        await next.stop();
        this.cleanupHosts.delete(next);
        return;
      }
      this.host = next;
      this.cleanupHosts.delete(next);
    } catch (error) {
      let reported: unknown = error;
      if (next !== undefined) {
        try {
          await next.stop();
          this.cleanupHosts.delete(next);
        } catch (cleanupError) {
          reported = new AggregateError([error, cleanupError], "DeepSeek Web connection startup cleanup failed");
        }
      }
      this.tokenConfigured = false;
      this.connectionFailed(reported);
    }
  }

  private connectionFailed(error: unknown): void {
    this.lastErrorCode = "CONNECTION_START_FAILED";
    this.options.reportError?.(error);
  }
}

export function createDeepSeekWebModelHost(options: DeepSeekWebModelHostOptions): DeepSeekWebHost {
  return new DeepSeekWebModelHost(options);
}

class TrackedBroker implements DeepSeekWebBroker {
  constructor(private readonly owner: DeepSeekWebConnectionController) {}

  async *generate(request: BrokerGenerateRequest): AsyncIterable<ModelEvent> {
    this.owner.operationStarted();
    try {
      yield* this.owner.delegate().generate(request);
    } finally {
      this.owner.operationFinished();
    }
  }

  async cancel(request: BrokerCancelRequest): Promise<BrokerCancelResult> {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().cancel(request);
    } finally {
      this.owner.operationFinished();
    }
  }

  async query(request: BrokerQueryRequest): Promise<BrokerQueryResult> {
    this.owner.operationStarted();
    try {
      return await this.owner.delegate().query(request);
    } finally {
      this.owner.operationFinished();
    }
  }
}
