import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessBridgeStatusResult } from '../../../core/harness-bridge/coordinator';
import { validateHarnessBridgePairingToken } from '../../../core/harness-bridge/settings';
import { decodeHarnessBridgeStatusResult } from '../../../core/messaging/deepseek-runtime-contracts';
import type { LocaleMessageKey } from '../../../core/i18n';
import PageIntro from '../components/PageIntro';
import RouteFallback from '../components/RouteFallback';
import {
  SettingsSection,
  SkeletonList,
  StatusMessage,
  SubTabs,
  TextField,
  ToggleRow,
} from '../components/settings/primitives';
import { useSettingsController } from '../controllers/useSettingsController';
import { useI18n } from '../i18n';
import { sidepanelRuntimeClient } from '../runtime-client';

const GeneralSubPage = lazy(() => import('../components/settings/GeneralSubPage'));
const ApiSubPage = lazy(() => import('../components/settings/ApiSubPage'));
const PromptSubPage = lazy(() => import('../components/settings/PromptSubPage'));
const VoiceSubPage = lazy(() => import('../components/settings/VoiceSubPage'));
const AppearanceSubPage = lazy(() => import('../components/settings/AppearanceSubPage'));
const UsageSubPage = lazy(() => import('../components/settings/UsageSubPage'));
const DataSubPage = lazy(() => import('../components/settings/DataSubPage'));
const ProjectFilesSubPage = lazy(() => import('../components/settings/ProjectFilesSubPage'));
const AboutSubPage = lazy(() => import('../components/settings/AboutSubPage'));

type SubTab = 'general' | 'api' | 'harness' | 'prompt' | 'voice' | 'appearance' | 'usage' | 'data' | 'projectFiles' | 'about';

const SUB_TABS: { key: SubTab; labelKey: LocaleMessageKey }[] = [
  { key: 'general', labelKey: 'sidepanel.settings.tabs.general' },
  { key: 'api', labelKey: 'sidepanel.settings.tabs.api' },
  { key: 'harness', labelKey: 'sidepanel.settings.tabs.harness' },
  { key: 'prompt', labelKey: 'sidepanel.settings.tabs.prompt' },
  { key: 'voice', labelKey: 'sidepanel.settings.tabs.voice' },
  { key: 'appearance', labelKey: 'sidepanel.settings.tabs.appearance' },
  { key: 'usage', labelKey: 'sidepanel.settings.tabs.usage' },
  { key: 'data', labelKey: 'sidepanel.settings.tabs.data' },
  { key: 'projectFiles', labelKey: 'sidepanel.settings.tabs.projectFiles' },
  { key: 'about', labelKey: 'sidepanel.settings.tabs.about' },
];

const SUB_DESCRIPTION_KEY: Record<SubTab, LocaleMessageKey> = {
  general: 'sidepanel.settings.generalDescription',
  api: 'sidepanel.settings.apiDescription',
  harness: 'sidepanel.settings.harnessDescription',
  prompt: 'sidepanel.settings.promptDescription',
  voice: 'sidepanel.settings.voiceDescription',
  appearance: 'sidepanel.settings.appearanceDescription',
  usage: 'sidepanel.settings.usageDescription',
  data: 'sidepanel.settings.dataDescription',
  projectFiles: 'sidepanel.settings.projectFilesDescription',
  about: 'sidepanel.settings.aboutTagline',
};

export default function SettingsPage() {
  const { t } = useI18n();
  const [sub, setSub] = useState<SubTab>('general');
  const state = useSettingsController();

  return (
    <div className="ds-settings-shell">
      <div className="px-4 pt-4 pb-2">
        <PageIntro
          title={t('sidepanel.settings.title')}
          description={t(SUB_DESCRIPTION_KEY[sub])}
          meta={state.version ? `v${state.version}` : undefined}
        />
      </div>

      <SubTabs
        tabs={SUB_TABS.map((tab) => ({ key: tab.key, label: t(tab.labelKey) }))}
        value={sub}
        onChange={setSub}
        ariaLabel={t('sidepanel.settings.navLabel')}
      />

      <div className="ds-settings-content">
        {state.loading ? (
          <SkeletonList rows={3} />
        ) : (
          <Suspense fallback={<RouteFallback />}>
            {sub === 'general' && <GeneralSubPage state={state} />}
            {sub === 'api' && <ApiSubPage state={state} />}
            {sub === 'harness' && <HarnessBridgeSubPage />}
            {sub === 'prompt' && <PromptSubPage />}
            {sub === 'voice' && <VoiceSubPage />}
            {sub === 'appearance' && <AppearanceSubPage state={state} />}
            {sub === 'usage' && <UsageSubPage />}
            {sub === 'data' && <DataSubPage state={state} />}
            {sub === 'projectFiles' && <ProjectFilesSubPage />}
            {sub === 'about' && <AboutSubPage state={state} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}

export function HarnessBridgeSubPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<HarnessBridgeStatusResult | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState('43123');
  const [pairingToken, setPairingToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const requestGeneration = useRef(0);

  const applyStatus = useCallback((next: HarnessBridgeStatusResult) => {
    setStatus(next);
    if (next.ok) {
      setEnabled(next.settings.enabled);
      setPort(String(next.settings.port));
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const next = await sidepanelRuntimeClient.request(
        { type: 'GET_HARNESS_BRIDGE_STATUS' },
        { acceptFailure: true, decode: decodeHarnessBridgeStatusResult },
      );
      if (generation === requestGeneration.current) applyStatus(next);
    } catch {
      if (generation === requestGeneration.current) {
        setStatus({ ok: false, error: 'harness_bridge_status_unavailable' });
      }
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    const listener = (messageValue: unknown) => {
      const next = readHarnessBridgeStatusNotification(messageValue);
      if (next) {
        requestGeneration.current += 1;
        applyStatus(next);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [applyStatus, refresh]);

  const save = async (nextEnabled = enabled) => {
    if (!/^[0-9]+$/.test(port)) {
      setMessage({ tone: 'error', text: t('sidepanel.settings.harnessPortInvalid') });
      return;
    }
    const numericPort = Number(port);
    if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
      setMessage({ tone: 'error', text: t('sidepanel.settings.harnessPortInvalid') });
      return;
    }
    if (pairingToken) {
      try {
        validateHarnessBridgePairingToken(pairingToken);
      } catch {
        setMessage({ tone: 'error', text: t('sidepanel.settings.harnessTokenInvalid') });
        return;
      }
    }
    const generation = ++requestGeneration.current;
    setBusy(true);
    setMessage(null);
    try {
      const next = await sidepanelRuntimeClient.request({
        type: 'UPDATE_HARNESS_BRIDGE_SETTINGS',
        payload: {
          enabled: nextEnabled,
          port: numericPort,
          ...(pairingToken ? { pairingToken } : {}),
        },
      }, { acceptFailure: true, decode: decodeHarnessBridgeStatusResult });
      if (generation !== requestGeneration.current) return;
      applyStatus(next);
      if (next.ok) {
        setPairingToken('');
        setMessage({
          tone: 'success',
          text: t(nextEnabled
            ? 'sidepanel.settings.harnessSaved'
            : 'sidepanel.settings.harnessDisconnected'),
        });
      } else {
        setMessage({ tone: 'error', text: harnessBridgeErrorText(next.error, t) });
      }
    } catch {
      setMessage({ tone: 'error', text: t('sidepanel.settings.harnessOperationFailed') });
    } finally {
      setBusy(false);
    }
  };

  const configurationBlocked = status?.ok === false &&
    (status.error === 'harness_bridge_settings_corrupt' ||
     status.error === 'harness_bridge_settings_future_version');
  const phase = status?.ok ? status.state.phase : 'offline';
  return (
    <SettingsSection
      title={t('sidepanel.settings.harnessSection')}
      description={t('sidepanel.settings.harnessSectionDescription')}
    >
      <ToggleRow
        title={t('sidepanel.settings.harnessEnabled')}
        description={t('sidepanel.settings.harnessEnabledDescription')}
        enabled={enabled}
        disabled={busy || configurationBlocked}
        onToggle={setEnabled}
      />
      <TextField
        label={t('sidepanel.settings.harnessPort')}
        hint={t('sidepanel.settings.harnessPortHint')}
        value={port}
        disabled={busy || configurationBlocked}
        onChange={setPort}
      />
      <TextField
        label={t('sidepanel.settings.harnessPairingToken')}
        hint={status?.ok && status.settings.pairingTokenConfigured
          ? t('sidepanel.settings.harnessTokenConfigured')
          : t('sidepanel.settings.harnessTokenHint')}
        type="password"
        autoComplete="new-password"
        value={pairingToken}
        disabled={busy || configurationBlocked}
        onChange={setPairingToken}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
          {t('sidepanel.settings.harnessStatus')}: {t(HARNESS_BRIDGE_PHASE_KEYS[phase])}
        </span>
        <div className="flex gap-2">
          <button type="button" className="ds-button-secondary" disabled={busy} onClick={() => void refresh()}>
            {t('sidepanel.settings.harnessRefresh')}
          </button>
          {status?.ok && status.settings.enabled && (
            <button type="button" className="ds-button-secondary" disabled={busy} onClick={() => void save(false)}>
              {t('sidepanel.settings.harnessDisconnect')}
            </button>
          )}
          <button type="button" className="ds-button-primary" disabled={busy || configurationBlocked} onClick={() => void save()}>
            {t('sidepanel.settings.harnessSave')}
          </button>
        </div>
      </div>
      {!status?.ok && status !== null && (
        <StatusMessage tone="error">{harnessBridgeErrorText(status.error, t)}</StatusMessage>
      )}
      {message && <StatusMessage tone={message.tone}>{message.text}</StatusMessage>}
    </SettingsSection>
  );
}

function readHarnessBridgeStatusNotification(value: unknown): HarnessBridgeStatusResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'HARNESS_BRIDGE_STATUS_CHANGED') return null;
  if (Object.keys(message).length !== 2 || !Object.hasOwn(message, 'payload')) return null;
  try {
    return decodeHarnessBridgeStatusResult(message.payload);
  } catch {
    return null;
  }
}

const HARNESS_BRIDGE_PHASE_KEYS = {
  offline: 'sidepanel.settings.harnessPhaseOffline',
  connecting: 'sidepanel.settings.harnessPhaseConnecting',
  authenticating: 'sidepanel.settings.harnessPhaseAuthenticating',
  ready: 'sidepanel.settings.harnessPhaseReady',
  retry_wait: 'sidepanel.settings.harnessPhaseRetryWait',
  needs_pairing: 'sidepanel.settings.harnessPhaseNeedsPairing',
  handler_error: 'sidepanel.settings.harnessPhaseHandlerError',
  protocol_error: 'sidepanel.settings.harnessPhaseProtocolError',
  stopped: 'sidepanel.settings.harnessPhaseStopped',
} as const satisfies Record<
  Exclude<import('../../../core/harness-bridge/state').HarnessBridgeClientPhase, never>,
  LocaleMessageKey
>;

function harnessBridgeErrorText(
  error: string,
  t: (key: LocaleMessageKey) => string,
): string {
  if (error === 'harness_bridge_pairing_token_required') {
    return t('sidepanel.settings.harnessTokenRequired');
  }
  if (error === 'harness_bridge_settings_corrupt' || error === 'harness_bridge_settings_future_version') {
    return t('sidepanel.settings.harnessConfigInvalid');
  }
  return t('sidepanel.settings.harnessOperationFailed');
}
