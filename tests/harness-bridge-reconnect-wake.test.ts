import { describe, expect, it, vi } from 'vitest';
import type { HarnessBridgeStatus, HarnessBridgeStatusResult } from '../core/harness-bridge/contracts';
import {
  HARNESS_BRIDGE_RECONNECT_ALARM,
  HARNESS_BRIDGE_RECONNECT_MINUTES,
  HarnessBridgeReconnectWake,
} from '../core/harness-bridge/reconnect-wake';

describe('Harness bridge reconnect alarm', () => {
  it('registers synchronously and preserves the existing periodic alarm across worker wake/status updates', async () => {
    const fixture = makeFixture();
    fixture.service.start();
    fixture.service.start();
    expect(fixture.listeners.size).toBe(1);
    await fixture.service.update(waiting());
    await fixture.service.update(waiting('retry_wait'));
    await fixture.service.update(waiting('connecting'));
    expect(fixture.alarms.create).toHaveBeenCalledExactlyOnceWith(HARNESS_BRIDGE_RECONNECT_ALARM, {
      periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES,
    });

    const restarted = makeFixture({ periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES });
    restarted.service.start();
    await restarted.service.update(waiting());
    expect(restarted.alarms.create).not.toHaveBeenCalled();
  });

  it.each(['ready', 'needs_pairing', 'protocol_error', 'handler_error', 'stopped'] as const)(
    'clears wakeups for %s without creating a new timer', async (phase) => {
      const fixture = makeFixture();
      fixture.service.start();
      await fixture.service.update(waiting());
      await fixture.service.update(waiting(phase));
      expect(fixture.alarm).toBeUndefined();
      expect(fixture.alarms.create).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ok: false, error: 'harness_bridge_settings_corrupt' },
    { ...waiting(), settings: { version: 1, enabled: false, port: 43123, pairingTokenConfigured: true } },
    { ...waiting(), settings: { version: 1, enabled: true, port: 43123, pairingTokenConfigured: false } },
  ] satisfies HarnessBridgeStatusResult[])('clears disabled or unusable configuration %#', async (status) => {
    const fixture = makeFixture({ periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES });
    fixture.service.start();
    await fixture.service.update(status);
    expect(fixture.alarm).toBeUndefined();
    expect(fixture.alarms.create).not.toHaveBeenCalled();
  });

  it('ignores unrelated alarms and coalesces concurrent wake events', async () => {
    const fixture = makeFixture();
    let finish!: (status: HarnessBridgeStatusResult) => void;
    fixture.wake.mockImplementation(() => new Promise<HarnessBridgeStatusResult>((resolve) => { finish = resolve; }));
    fixture.service.start();
    fixture.fire('another-feature-alarm');
    expect(fixture.wake).not.toHaveBeenCalled();
    fixture.fire();
    fixture.fire();
    expect(fixture.wake).toHaveBeenCalledOnce();
    finish(waiting());
    await flush();
    fixture.fire();
    expect(fixture.wake).toHaveBeenCalledTimes(2);
    finish(waiting());
    await fixture.service.stop();
  });

  it.each(['disable', 'dispose'] as const)('does not recreate an alarm after concurrent %s during lookup', async (action) => {
    const fixture = makeFixture();
    let finish!: (value: undefined) => void;
    fixture.alarms.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fixture.service.start();
    const updating = fixture.service.update(waiting());
    await flush();
    const stopping = action === 'dispose'
      ? fixture.service.stop()
      : fixture.service.update({ ok: false, error: 'disabled' });
    finish(undefined);
    await Promise.all([updating, stopping]);
    expect(fixture.alarms.create).not.toHaveBeenCalled();
    expect(fixture.alarm).toBeUndefined();
    if (action === 'dispose') {
      expect(fixture.listeners.size).toBe(0);
      fixture.fire();
      await fixture.service.update(waiting());
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(fixture.alarms.create).not.toHaveBeenCalled();
    }
  });

  it('reports a failed browser alarm operation and allows a later configuration event to retry', async () => {
    const fixture = makeFixture();
    fixture.alarms.create.mockRejectedValueOnce(new Error('browser unavailable'));
    fixture.service.start();
    await fixture.service.update(waiting());
    expect(fixture.reportError).toHaveBeenCalledWith('harness_bridge_reconnect_alarm_failed');
    await fixture.service.update(waiting());
    expect(fixture.alarm).toEqual({ periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES });
  });

  it('clears a persisted wake alarm when the coordinator returns a configuration failure', async () => {
    const fixture = makeFixture({ periodInMinutes: HARNESS_BRIDGE_RECONNECT_MINUTES });
    fixture.wake.mockResolvedValue({ ok: false, error: 'harness_bridge_settings_corrupt' });
    fixture.service.start();
    fixture.fire();
    await flush();
    expect(fixture.alarm).toBeUndefined();
  });

  it('does not restore an outdated waiting state over a newer disabled notification', async () => {
    const fixture = makeFixture();
    let finish!: (status: HarnessBridgeStatusResult) => void;
    fixture.wake.mockImplementation(() => new Promise<HarnessBridgeStatusResult>((resolve) => { finish = resolve; }));
    fixture.service.start();
    await fixture.service.update(waiting());
    fixture.fire();
    await fixture.service.update(waiting('stopped'));
    finish(waiting());
    await flush();
    expect(fixture.alarm).toBeUndefined();
    expect(fixture.alarms.create).toHaveBeenCalledOnce();
  });
});

function makeFixture(initial?: { periodInMinutes: number }) {
  let alarm: { periodInMinutes: number } | undefined = initial;
  const listeners = new Set<(value: { name: string }) => void>();
  const alarms = {
    get: vi.fn(async (_name: string): Promise<{ periodInMinutes: number } | undefined> => alarm),
    create: vi.fn(async (_name: string, options: { periodInMinutes: number }) => { alarm = options; }),
    clear: vi.fn(async (_name: string) => { const existed = alarm !== undefined; alarm = undefined; return existed; }),
    onAlarm: {
      addListener: (listener: (value: { name: string }) => void) => { listeners.add(listener); },
      removeListener: (listener: (value: { name: string }) => void) => { listeners.delete(listener); },
    },
  };
  const wake = vi.fn(async (): Promise<HarnessBridgeStatusResult> => waiting());
  const reportError = vi.fn();
  return {
    service: new HarnessBridgeReconnectWake({ alarms, wake, reportError }),
    alarms, listeners, wake, reportError,
    get alarm() { return alarm; },
    fire(name = HARNESS_BRIDGE_RECONNECT_ALARM) { for (const listener of listeners) listener({ name }); },
  };
}

function waiting(phase: 'offline' | 'connecting' | 'retry_wait' | 'ready' | 'needs_pairing' |
  'protocol_error' | 'handler_error' | 'stopped' = 'offline'): HarnessBridgeStatus {
  return {
    ok: true,
    settings: { version: 1, enabled: true, port: 43123, pairingTokenConfigured: true },
    state: { phase, attempt: 6, ...(phase === 'offline' ? { errorCode: 'RETRY_EXHAUSTED' } : {}) },
  };
}

async function flush() { for (let count = 0; count < 15; count += 1) await Promise.resolve(); }
