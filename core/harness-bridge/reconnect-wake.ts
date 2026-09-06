import type { HarnessBridgeStatusResult } from './contracts';

export const HARNESS_BRIDGE_RECONNECT_ALARM = 'deepseek_pp_harness_bridge_reconnect';
export const HARNESS_BRIDGE_RECONNECT_MINUTES = 0.5;

/** Browser-owned alarms survive MV3 worker suspension; connection retries stay client-owned. */
export interface HarnessBridgeReconnectAlarms {
  get(name: string): Promise<{ readonly periodInMinutes?: number } | undefined>;
  create(name: string, options: { periodInMinutes: number }): Promise<void> | void;
  clear(name: string): Promise<boolean>;
  readonly onAlarm: {
    addListener(listener: (alarm: { readonly name: string }) => void): void;
    removeListener(listener: (alarm: { readonly name: string }) => void): void;
  };
}

export class HarnessBridgeReconnectWake {
  private started = false;
  private waking = false;
  private desired = false;
  private statusRevision = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: {
    readonly alarms: HarnessBridgeReconnectAlarms;
    readonly wake: () => Promise<HarnessBridgeStatusResult>;
    readonly reportError: (code: string) => void;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // Register synchronously, before asynchronous configuration reads on a worker wake.
    this.dependencies.alarms.onAlarm.addListener(this.onAlarm);
  }

  update(status: HarnessBridgeStatusResult): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.statusRevision += 1;
    this.desired = status.ok && status.settings.enabled && status.settings.pairingTokenConfigured &&
      (status.state.phase === 'connecting' || status.state.phase === 'authenticating' ||
       status.state.phase === 'retry_wait' ||
       status.state.phase === 'offline' && status.state.errorCode === 'RETRY_EXHAUSTED');
    return this.reconcile();
  }

  stop(): Promise<void> {
    if (this.started) this.dependencies.alarms.onAlarm.removeListener(this.onAlarm);
    this.started = false;
    this.desired = false;
    return this.reconcile();
  }

  private readonly onAlarm = (alarm: { readonly name: string }): void => {
    if (!this.started || alarm.name !== HARNESS_BRIDGE_RECONNECT_ALARM || this.waking) return;
    this.waking = true;
    const revision = this.statusRevision;
    void this.dependencies.wake()
      .then((status) => {
        // A newer settings/connection notification owns the alarm state.
        if (revision === this.statusRevision) return this.update(status);
      })
      .catch(() => this.dependencies.reportError('harness_bridge_reconnect_wake_failed'))
      .finally(() => { this.waking = false; });
  };

  private reconcile(): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (!this.started || !this.desired) {
        await this.dependencies.alarms.clear(HARNESS_BRIDGE_RECONNECT_ALARM);
        return;
      }
      const alarm = await this.dependencies.alarms.get(HARNESS_BRIDGE_RECONNECT_ALARM);
      // Disable/dispose may arrive while the browser alarm lookup is pending.
      if (!this.started || !this.desired) {
        await this.dependencies.alarms.clear(HARNESS_BRIDGE_RECONNECT_ALARM);
      } else if (alarm?.periodInMinutes !== HARNESS_BRIDGE_RECONNECT_MINUTES) {
        await this.dependencies.alarms.create(HARNESS_BRIDGE_RECONNECT_ALARM, {
          periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES,
        });
      }
    }).catch(() => this.dependencies.reportError('harness_bridge_reconnect_alarm_failed'));
    return this.tail;
  }
}
