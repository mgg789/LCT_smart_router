import { motion } from 'framer-motion';
import { Copy, KeyRound, Plus, Wand2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AiView,
  createApiToken,
  getAiSettings,
  getDispatcherSettings,
  getMapProvidersStatus,
  getMcpSettings,
  listApiTokens,
  revokeApiToken,
  saveAiSettings,
  saveMcpSettings,
} from '../api/client';
import type {
  ApiTokenCategory,
  ApiTokenSummary,
  CreatedApiToken,
  DispatcherSettingsView,
  MapProvidersStatus,
  McpSettingsView,
  RouterTechnicalSettings,
} from '../api/types';
import { isNavixOffline } from '../domain/mapAvailability';
import { t } from '../i18n';
import { formatMoscowDate, moscowAt } from '../lib/time';
import { FIGMA_ASSETS } from './assets';
import { clockFromMinutes, minutesFromClock } from './dispatcherSettings';
import { downloadMcpSetupMd, generateMcpPin } from './mcpSetup';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
const CAPSULE_SPRING = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.72 };
const FIELD =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

const TABS = [
  { id: 'general', label: t('figma-dashboard.SettingsModal.b250a3d659') },
  { id: 'api', label: t('figma-dashboard.SettingsModal.c8e5998f6a') },
  { id: 'maps', label: t('figma-dashboard.SettingsModal.ee7e9d92da') },
  { id: 'ai', label: t('figma-dashboard.SettingsModal.11fb682be0') },
] as const;
export type SettingsTab = (typeof TABS)[number]['id'];

const CATEGORY_LABELS: Record<ApiTokenCategory, string> = {
  client: t('figma-dashboard.SettingsModal.726c247ad9'),
  eng: t('figma-dashboard.SettingsModal.db2721208c'),
  client_eng: t('figma-dashboard.SettingsModal.9f42e82072'),
  master: t('figma-dashboard.SettingsModal.8a6fafe349'),
};

type GeneralDraft = {
  shiftStart: string;
  shiftEnd: string;
  latenessMin: number;
  accessBufferMin: number;
  earlyFinishReplanMin: number;
  taskOverrunMin: number;
  noShowMin: number;
  overdueMin: number;
  timeRiskMin: number;
  repeatAfterMin: number;
  lunchesEnabled: boolean;
  metroEnabled: boolean;
  equipmentEnabled: boolean;
  equipmentTransfersEnabled: boolean;
  trafficEnabled: boolean;
  equipmentCapacityWalk: number;
  equipmentCapacityBike: number;
  equipmentCapacityCar: number;
};

/**
 * Dispatcher settings: day clocks, alert/replan thresholds, API tokens and map keys.
 * Every field writes to the live API — nothing stays as a localStorage stub.
 */
export function SettingsModal({
  open,
  motionOn,
  token,
  routerSettings,
  submitting,
  initialTab = 'general',
  onClose,
  onSave,
}: {
  open: boolean;
  motionOn: boolean;
  token: string | null;
  routerSettings?: RouterTechnicalSettings;
  submitting: boolean;
  /** Tab to open on reveal; the header robot deep-links to `api`. */
  initialTab?: SettingsTab;
  onClose: () => void;
  onSave: (input: {
    dispatcher: {
      dayStartMin: number;
      dayEndMin: number;
      noShowSec: number;
      overdueSec: number;
      timeRiskSec: number;
      repeatAfterSec: number;
      equipmentCapacityWalk: number;
      equipmentCapacityBike: number;
      equipmentCapacityCar: number;
      twogisApiKey?: string | null;
      yandexApiKey?: string | null;
    };
    router: RouterTechnicalSettings;
  }) => Promise<void>;
}) {
  const offline = isNavixOffline();
  const [tab, setTab] = useState<SettingsTab>('general');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [server, setServer] = useState<DispatcherSettingsView | null>(null);
  const [draft, setDraft] = useState<GeneralDraft>(() => generalFrom(undefined, undefined));
  const [twogisKey, setTwogisKey] = useState('');
  const [yandexKey, setYandexKey] = useState('');
  const [clearTwogis, setClearTwogis] = useState(false);
  const [clearYandex, setClearYandex] = useState(false);
  const [mapStatus, setMapStatus] = useState<MapProvidersStatus | null>(null);
  const wasOpen = useRef(false);
  const routerRef = useRef(routerSettings);
  routerRef.current = routerSettings;

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setTab(offline && (initialTab === 'ai' || initialTab === 'maps') ? 'general' : initialTab);
    setError(null);
    setTwogisKey('');
    setYandexKey('');
    setClearTwogis(false);
    setClearYandex(false);
    setDraft(generalFrom(undefined, routerRef.current));
  }, [open, initialTab, offline]);

  useEffect(() => {
    if (!open) return;
    if (!token) {
      setServer(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      getDispatcherSettings(token),
      offline ? Promise.resolve(null) : getMapProvidersStatus(token).catch(() => null),
    ])
      .then(([settings, status]) => {
        if (cancelled) return;
        setServer(settings);
        setMapStatus(status);
        setDraft(generalFrom(settings, routerRef.current));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.c265cda846'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, offline]);

  const setField = <K extends keyof GeneralDraft>(key: K, value: GeneralDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim
        label={t('figma-dashboard.SettingsModal.ea43616020')}
        disabled={submitting}
        onClose={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="figma-settings-title"
        className="relative flex h-[860px] w-[880px] flex-col overflow-hidden rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
        initial={motionOn ? { opacity: 0, y: 12, scale: 0.98 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={motionOn ? { opacity: 0, y: 8, scale: 0.98 } : undefined}
        transition={fade}
      >
        <div className="flex items-center justify-between">
          <h2
            id="figma-settings-title"
            className="figma-text figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
          >
            {t('figma-dashboard.SettingsModal.985b5e0f2c')}
          </h2>
          <button
            type="button"
            aria-label={t('figma-dashboard.SettingsModal.a7a4033657')}
            disabled={submitting}
            onClick={onClose}
            className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110 disabled:opacity-50"
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
            </span>
          </button>
        </div>

        <TabSwitch tab={tab} motionOn={motionOn} onChange={setTab} offline={offline} />

        <div
          className={`mt-[16px] min-h-0 flex-1 ${tab === 'ai' ? 'overflow-hidden' : 'overflow-y-auto [scrollbar-width:thin]'}`}
        >
          {loading ? (
            <p className="mt-[24px] font-medium text-[16px] text-figma-muted">
              {t('figma-dashboard.SettingsModal.a709de0bac')}
            </p>
          ) : null}
          {tab === 'general' ? <GeneralForm draft={draft} setField={setField} /> : null}
          {tab === 'api' ? <ApiTokensTab token={token} /> : null}
          {tab === 'ai' ? (
            offline ? (
              <p
                role="status"
                className="rounded-[16px] bg-figma-soft p-[16px] text-[16px] text-figma-muted"
              >
                {t('common.offlineContour')}
              </p>
            ) : (
              <AiForm token={token} />
            )
          ) : null}
          {tab === 'maps' ? (
            offline ? (
              <p
                role="status"
                className="rounded-[16px] bg-figma-soft p-[16px] text-[16px] text-figma-muted"
              >
                {t('common.offlineContour')}
              </p>
            ) : (
              <MapsForm
                server={server}
                twogisKey={twogisKey}
                yandexKey={yandexKey}
                clearTwogis={clearTwogis}
                clearYandex={clearYandex}
                status={mapStatus}
                onTwogisKey={setTwogisKey}
                onYandexKey={setYandexKey}
                onClearTwogis={setClearTwogis}
                onClearYandex={setClearYandex}
              />
            )
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mt-[12px] font-medium text-[15px] text-figma-danger">
            {error}
          </p>
        ) : null}

        {tab !== 'api' && tab !== 'ai' ? (
          <button
            type="button"
            disabled={submitting || loading || !token || !routerSettings}
            onClick={() => {
              if (!routerSettings) return;
              if (minutesFromClock(draft.shiftEnd) <= minutesFromClock(draft.shiftStart)) {
                setError(t('figma-dashboard.SettingsModal.da8f0a2fd2'));
                return;
              }
              setError(null);
              void onSave({
                dispatcher: {
                  dayStartMin: minutesFromClock(draft.shiftStart),
                  dayEndMin: minutesFromClock(draft.shiftEnd),
                  noShowSec: draft.noShowMin * 60,
                  overdueSec: draft.overdueMin * 60,
                  timeRiskSec: draft.timeRiskMin * 60,
                  repeatAfterSec: draft.repeatAfterMin * 60,
                  equipmentCapacityWalk: draft.equipmentCapacityWalk,
                  equipmentCapacityBike: draft.equipmentCapacityBike,
                  equipmentCapacityCar: draft.equipmentCapacityCar,
                  ...(clearTwogis
                    ? { twogisApiKey: null }
                    : twogisKey
                      ? { twogisApiKey: twogisKey }
                      : {}),
                  ...(clearYandex
                    ? { yandexApiKey: null }
                    : yandexKey
                      ? { yandexApiKey: yandexKey }
                      : {}),
                },
                router: {
                  ...routerSettings,
                  lunchesEnabled: draft.lunchesEnabled,
                  metroEnabled: draft.metroEnabled,
                  windowLatenessToleranceSec: draft.latenessMin * 60,
                  departureLatenessToleranceSec: draft.latenessMin * 60,
                  taskStartLatenessToleranceSec: draft.latenessMin * 60,
                  accessBufferSec: draft.accessBufferMin * 60,
                  earlyFinishReplanThresholdSec: draft.earlyFinishReplanMin * 60,
                  taskOverrunToleranceSec: draft.taskOverrunMin * 60,
                  equipmentEnabled: draft.equipmentEnabled,
                  equipmentTransfersEnabled: draft.equipmentTransfersEnabled,
                  trafficEnabled: draft.trafficEnabled,
                },
              }).catch((cause: unknown) => {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : t('figma-dashboard.SettingsModal.6e7ee8b60e'),
                );
              });
            }}
            className={`mt-[16px] flex h-[56px] w-full items-center justify-center rounded-[20px] font-medium text-[18px] transition-transform duration-150 ${
              submitting || loading || !token
                ? 'bg-figma-track text-figma-hint'
                : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
            }`}
          >
            {submitting
              ? t('figma-dashboard.SettingsModal.9c27c381dd')
              : t('figma-dashboard.SettingsModal.b4d30cae52')}
          </button>
        ) : null}
      </motion.div>
    </ModalLayer>
  );
}

function generalFrom(
  settings: DispatcherSettingsView | undefined,
  router: RouterTechnicalSettings | undefined,
): GeneralDraft {
  return {
    shiftStart: clockFromMinutes(settings?.dayStartMin ?? 9 * 60),
    shiftEnd: clockFromMinutes(settings?.dayEndMin ?? 21 * 60),
    latenessMin: Math.round((router?.windowLatenessToleranceSec ?? 0) / 60),
    accessBufferMin: Math.round((router?.accessBufferSec ?? 600) / 60),
    earlyFinishReplanMin: Math.round((router?.earlyFinishReplanThresholdSec ?? 900) / 60),
    taskOverrunMin: Math.round((router?.taskOverrunToleranceSec ?? 600) / 60),
    noShowMin: Math.round((settings?.noShowSec ?? 1800) / 60),
    overdueMin: Math.round((settings?.overdueSec ?? 300) / 60),
    timeRiskMin: Math.round((settings?.timeRiskSec ?? 300) / 60),
    repeatAfterMin: Math.round((settings?.repeatAfterSec ?? 900) / 60),
    lunchesEnabled: router?.lunchesEnabled ?? false,
    metroEnabled: router?.metroEnabled ?? false,
    equipmentEnabled: router?.equipmentEnabled ?? true,
    equipmentTransfersEnabled: router?.equipmentTransfersEnabled ?? false,
    trafficEnabled: router?.trafficEnabled ?? true,
    equipmentCapacityWalk: settings?.equipmentCapacityWalk ?? 5,
    equipmentCapacityBike: settings?.equipmentCapacityBike ?? 12,
    equipmentCapacityCar: settings?.equipmentCapacityCar ?? 30,
  };
}

function TabSwitch({
  tab,
  motionOn,
  onChange,
  offline,
}: {
  tab: SettingsTab;
  motionOn: boolean;
  onChange: (tab: SettingsTab) => void;
  offline: boolean;
}) {
  const index = TABS.findIndex((item) => item.id === tab);
  return (
    <div className="mt-[18px] h-[56px] rounded-full bg-figma-canvas p-[4px]">
      <div className="relative grid h-full grid-cols-4">
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/4 rounded-full bg-figma-ink"
          initial={false}
          animate={{ x: `${index * 100}%` }}
          transition={motionOn ? CAPSULE_SPRING : { duration: 0 }}
        />
        {TABS.map((item) => {
          const active = item.id === tab;
          const disabled = offline && (item.id === 'ai' || item.id === 'maps');
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              title={disabled ? t('common.offlineContour') : undefined}
              onClick={() => {
                if (!disabled) onChange(item.id);
              }}
              className="relative z-10 flex h-full items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span
                className={`font-semibold text-[16px] tracking-[-0.3px] ${
                  active ? 'text-white' : 'text-figma-ink'
                }`}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GeneralForm({
  draft,
  setField,
}: {
  draft: GeneralDraft;
  setField: <K extends keyof GeneralDraft>(key: K, value: GeneralDraft[K]) => void;
}) {
  return (
    <div className="pb-[8px]">
      <div className="grid grid-cols-2 gap-[16px]">
        <Field label={t('figma-dashboard.SettingsModal.cf1dfa079c')} htmlFor="settings-shift-start">
          <input
            id="settings-shift-start"
            type="time"
            value={draft.shiftStart}
            onChange={(event) => setField('shiftStart', event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field label={t('figma-dashboard.SettingsModal.9046545750')} htmlFor="settings-shift-end">
          <input
            id="settings-shift-end"
            type="time"
            value={draft.shiftEnd}
            onChange={(event) => setField('shiftEnd', event.target.value)}
            className={FIELD}
          />
        </Field>
      </div>
      <Field label={t('figma-dashboard.SettingsModal.7e45b15e9d')} htmlFor="settings-lateness">
        <input
          id="settings-lateness"
          type="number"
          min={0}
          max={15}
          step={1}
          value={draft.latenessMin}
          onChange={(event) => setField('latenessMin', Number(event.target.value) || 0)}
          className={FIELD}
        />
      </Field>
      <p className="mt-[20px] font-semibold text-[16px] text-figma-ink">
        {t('figma-dashboard.SettingsModal.91dd7dae26')}
      </p>
      <p className="mt-[4px] font-medium text-[14px] text-figma-muted">
        {t('figma-dashboard.SettingsModal.b6103c4b20')}
      </p>
      <div className="grid grid-cols-2 gap-[16px]">
        <MinuteField
          id="settings-noshow"
          label={t('figma-dashboard.SettingsModal.69b3b8bde2')}
          value={draft.noShowMin}
          onChange={(value) => setField('noShowMin', value)}
        />
        <MinuteField
          id="settings-overdue"
          label={t('figma-dashboard.SettingsModal.9e071f34a7')}
          value={draft.overdueMin}
          onChange={(value) => setField('overdueMin', value)}
        />
        <MinuteField
          id="settings-timerisk"
          label={t('figma-dashboard.SettingsModal.23d02e0526')}
          value={draft.timeRiskMin}
          onChange={(value) => setField('timeRiskMin', value)}
        />
        <MinuteField
          id="settings-repeat"
          label={t('figma-dashboard.SettingsModal.6e57becadd')}
          value={draft.repeatAfterMin}
          onChange={(value) => setField('repeatAfterMin', value)}
        />
      </div>
      <p className="mt-[20px] font-semibold text-[16px] text-figma-ink">
        {t('figma-dashboard.SettingsModal.0f037c1941')}
      </p>
      <p className="mt-[4px] font-medium text-[14px] text-figma-muted">
        {t('figma-dashboard.SettingsModal.85f00bf1c7')}
      </p>
      <div className="grid grid-cols-2 gap-[16px]">
        <MinuteField
          id="settings-early"
          label={t('figma-dashboard.SettingsModal.d6cfb3abcf')}
          value={draft.earlyFinishReplanMin}
          onChange={(value) => setField('earlyFinishReplanMin', value)}
        />
        <MinuteField
          id="settings-overrun"
          label={t('figma-dashboard.SettingsModal.4f35eb760d')}
          value={draft.taskOverrunMin}
          onChange={(value) => setField('taskOverrunMin', value)}
        />
        <MinuteField
          id="settings-access"
          label={t('figma-dashboard.SettingsModal.9f93f2879e')}
          value={draft.accessBufferMin}
          onChange={(value) => setField('accessBufferMin', value)}
        />
      </div>
      <div className="mt-[20px] space-y-[12px]">
        <p className="font-semibold text-[16px] text-figma-ink">
          {t('figma-dashboard.SettingsModal.2753855eb8')}
        </p>
        <div className="grid grid-cols-3 gap-[12px]">
          <CapacityField
            id="settings-capacity-walk"
            label={t('figma-dashboard.SettingsModal.7e072732b4')}
            value={draft.equipmentCapacityWalk}
            onChange={(value) => setField('equipmentCapacityWalk', value)}
          />
          <CapacityField
            id="settings-capacity-bike"
            label={t('figma-dashboard.SettingsModal.06458c4e6b')}
            value={draft.equipmentCapacityBike}
            onChange={(value) => setField('equipmentCapacityBike', value)}
          />
          <CapacityField
            id="settings-capacity-car"
            label={t('figma-dashboard.SettingsModal.8dca2f7831')}
            value={draft.equipmentCapacityCar}
            onChange={(value) => setField('equipmentCapacityCar', value)}
          />
        </div>
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.34d5dfb903')}
          checked={draft.lunchesEnabled}
          onChange={() => setField('lunchesEnabled', !draft.lunchesEnabled)}
        />
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.373981cffc')}
          checked={draft.equipmentEnabled}
          onChange={() => setField('equipmentEnabled', !draft.equipmentEnabled)}
        />
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.4f9c37af69')}
          checked={draft.trafficEnabled}
          onChange={() => setField('trafficEnabled', !draft.trafficEnabled)}
        />
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.33c7521988')}
          checked={draft.metroEnabled}
          onChange={() => setField('metroEnabled', !draft.metroEnabled)}
        />
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.31f207a99a')}
          checked={draft.equipmentTransfersEnabled}
          onChange={() => setField('equipmentTransfersEnabled', !draft.equipmentTransfersEnabled)}
        />
      </div>
    </div>
  );
}

function MapsForm({
  server,
  twogisKey,
  yandexKey,
  clearTwogis,
  clearYandex,
  status,
  onTwogisKey,
  onYandexKey,
  onClearTwogis,
  onClearYandex,
}: {
  server: DispatcherSettingsView | null;
  twogisKey: string;
  yandexKey: string;
  clearTwogis: boolean;
  clearYandex: boolean;
  status: MapProvidersStatus | null;
  onTwogisKey: (value: string) => void;
  onYandexKey: (value: string) => void;
  onClearTwogis: (value: boolean) => void;
  onClearYandex: (value: boolean) => void;
}) {
  return (
    <div>
      <p className="font-medium text-[15px] leading-[22px] text-figma-muted">
        {t('figma-dashboard.SettingsModal.4be473e9ad')}
      </p>
      <Field label={t('figma-dashboard.SettingsModal.39a7f14866')} htmlFor="settings-twogis">
        <input
          id="settings-twogis"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={twogisKey}
          placeholder={
            server?.twogisApiKeySet
              ? t('figma-dashboard.SettingsModal.760d4970f4', {
                  value0: server.twogisApiKeyLast4 ?? '',
                })
              : t('figma-dashboard.SettingsModal.7a63ad80c1')
          }
          onChange={(event) => {
            onClearTwogis(false);
            onTwogisKey(event.target.value.trim());
          }}
          className={FIELD}
        />
      </Field>
      {server?.twogisApiKeySet ? (
        <label className="mt-[8px] flex items-center gap-[8px] font-medium text-[14px] text-figma-muted">
          <input
            type="checkbox"
            checked={clearTwogis}
            onChange={(event) => onClearTwogis(event.target.checked)}
          />
          {t('figma-dashboard.SettingsModal.2a5b098d48')}
        </label>
      ) : null}
      <Field label={t('figma-dashboard.SettingsModal.0cdfc8b6db')} htmlFor="settings-yandex">
        <input
          id="settings-yandex"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={yandexKey}
          placeholder={
            server?.yandexApiKeySet
              ? t('figma-dashboard.SettingsModal.760d4970f4', {
                  value0: server.yandexApiKeyLast4 ?? '',
                })
              : t('figma-dashboard.SettingsModal.7a63ad80c1')
          }
          onChange={(event) => {
            onClearYandex(false);
            onYandexKey(event.target.value.trim());
          }}
          className={FIELD}
        />
      </Field>
      {server?.yandexApiKeySet ? (
        <label className="mt-[8px] flex items-center gap-[8px] font-medium text-[14px] text-figma-muted">
          <input
            type="checkbox"
            checked={clearYandex}
            onChange={(event) => onClearYandex(event.target.checked)}
          />
          {t('figma-dashboard.SettingsModal.c88c6c1528')}
        </label>
      ) : null}
      {status ? (
        <div className="mt-[20px] rounded-[20px] bg-figma-canvas px-[18px] py-[16px] font-medium text-[15px] text-figma-ink">
          <p>
            {t('figma-dashboard.SettingsModal.9286ca49cd')}{' '}
            {status.active === 'none'
              ? t('figma-dashboard.SettingsModal.dc9337ff5b')
              : status.active === 'twogis'
                ? t('figma-dashboard.SettingsModal.b91aab0a1e')
                : t('figma-dashboard.SettingsModal.5ed92773c8')}
          </p>
          <p className="mt-[6px] text-figma-muted">
            {t('figma-dashboard.SettingsModal.0e3de00aa9')}
            {status.twogis.message}
          </p>
          <p className="mt-[4px] text-figma-muted">
            {t('figma-dashboard.SettingsModal.5707c06238')}
            {status.yandex.message}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ApiTokensTab({ token }: { token: string | null }) {
  return (
    <div>
      <McpServerSection token={token} />
      <div className="my-[24px] h-px bg-figma-ink/10" aria-hidden />
      <p className="font-semibold text-[16px] text-figma-ink">
        {t('figma-dashboard.SettingsModal.c99ba6e8a6')}
      </p>
      <ApiTokenList token={token} />
    </div>
  );
}

/**
 * Dashboard MCP server: the activation switch, the pin the agent connects with, and the
 * self-connecting `setup.md` the dispatcher hands to their agent. Mirrors the flow the
 * server enforces: enabling needs a pin, and disabling revokes it everywhere at once.
 */
function McpServerSection({ token }: { token: string | null }) {
  const [view, setView] = useState<McpSettingsView | null>(null);
  const [pin, setPin] = useState('');
  const [pendingOn, setPendingOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    void getMcpSettings(token)
      .then(setView)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.d38f5d18af'),
        );
      });
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const apply = (input: { enabled: boolean; pin?: string }) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    void saveMcpSettings(token, input)
      .then((next) => {
        setView(next);
        // The typed pin stays in the field: setup.md needs it, and the server stores
        // only the hash, so this is the one chance to download a working file.
        setPendingOn(false);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.477e081d11'),
        );
        reload();
        setPendingOn(false);
      })
      .finally(() => setBusy(false));
  };

  if (!token) {
    return null;
  }

  const enabled = view?.enabled === true || pendingOn;
  const pinReady = pin.trim().length > 0;
  const endpointUrl = view ? `${window.location.origin.replace(/\/$/, '')}${view.endpoint}` : '';

  const toggle = () => {
    if (busy) return;
    if (enabled) {
      // A switch-off that has not reached the server yet is just a local cancel.
      if (pendingOn) {
        setPendingOn(false);
        return;
      }
      apply({ enabled: false });
      return;
    }
    if (view?.pinSet) {
      apply({ enabled: true });
      return;
    }
    // No pin yet: reveal the field now; the server is switched on together with it.
    setPendingOn(true);
  };

  const savePin = () => {
    const value = pin.trim();
    if (value.length < 6) {
      setError(t('figma-dashboard.SettingsModal.38c0d438b1'));
      return;
    }
    apply({ enabled: true, pin: value });
  };

  return (
    <section>
      <p className="font-extrabold text-[18px] tracking-[-0.3px] text-figma-ink">
        {t('figma-dashboard.SettingsModal.6ca5b81007')}
      </p>
      <p className="mt-[4px] font-medium text-[14px] leading-[1.4] text-figma-muted">
        {t('figma-dashboard.SettingsModal.4cf1352d97')}
      </p>
      <div className="mt-[12px]">
        <SettingSwitch
          label={t('figma-dashboard.SettingsModal.c072abdfc2')}
          checked={enabled}
          onChange={toggle}
        />
      </div>
      {enabled ? (
        <div className="mt-[16px] w-full">
          <Field
            label={
              view?.pinSet
                ? t('figma-dashboard.SettingsModal.62cc62d08d', { value0: view.pinLast4 ?? '' })
                : t('figma-dashboard.SettingsModal.7ae946cad8')
            }
            htmlFor="settings-mcp-pin"
          >
            <div className="relative">
              <input
                id="settings-mcp-pin"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={pin}
                placeholder={t('figma-dashboard.SettingsModal.c6a812129d')}
                onChange={(event) => {
                  setError(null);
                  setPin(event.target.value);
                }}
                className={FIELD}
              />
            </div>
          </Field>
          <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
            <button
              type="button"
              disabled={busy}
              onClick={() => setPin(generateMcpPin())}
              className="flex h-[44px] items-center gap-[8px] rounded-full border border-figma-ink/15 px-[16px] font-semibold text-[15px] text-figma-ink disabled:opacity-50"
            >
              <Wand2 className="h-4 w-4" />
              {t('figma-dashboard.SettingsModal.ab5e1191a7')}
            </button>
            <button
              type="button"
              disabled={busy || !pinReady}
              onClick={savePin}
              className={`flex h-[44px] items-center rounded-full px-[16px] font-semibold text-[15px] transition-transform duration-150 ${
                busy || !pinReady
                  ? 'bg-figma-track text-figma-hint'
                  : 'bg-figma-ink text-white hover:scale-[1.02]'
              }`}
            >
              {busy
                ? t('figma-dashboard.SettingsModal.9c27c381dd')
                : t('figma-dashboard.SettingsModal.4119dd076a')}
            </button>
            <button
              type="button"
              disabled={busy || !pinReady}
              onClick={() => {
                downloadMcpSetupMd({
                  origin: window.location.origin,
                  endpoint: view?.endpoint ?? '/api/v1/mcp',
                  pin: pin.trim(),
                });
              }}
              title={pinReady ? undefined : t('figma-dashboard.SettingsModal.5a7fe59ad9')}
              className={`ml-auto flex h-[44px] items-center gap-[8px] rounded-full px-[16px] font-semibold text-[15px] transition-transform duration-150 ${
                busy || !pinReady
                  ? 'bg-figma-track text-figma-hint'
                  : 'bg-figma-bee text-figma-ink hover:scale-[1.02]'
              }`}
            >
              {t('figma-dashboard.SettingsModal.e32a62a74c')}
            </button>
          </div>
          {view && !view.pinSet ? (
            <p className="mt-[10px] font-medium text-[13px] text-figma-hint">
              {t('figma-dashboard.SettingsModal.1fcc7add0a')}
            </p>
          ) : null}
          {view?.activeNow ? (
            <p className="mt-[10px] flex items-center gap-[8px] font-medium text-[14px] text-[#2E9BEE]">
              <motion.span
                aria-hidden
                className="inline-block size-[8px] rounded-full bg-[#3BA7FF]"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              />
              {t('figma-dashboard.SettingsModal.e2b61fbdb9')}
              {view.lastToolName ? ` · ${view.lastToolName}` : ''}
            </p>
          ) : null}
          {endpointUrl ? (
            <p className="mt-[10px] break-all font-medium text-[13px] text-figma-hint">
              {t('figma-dashboard.SettingsModal.a6bfdd68b1')}
              {endpointUrl}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-[10px] font-medium text-[14px] text-figma-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ApiTokenList({ token }: { token: string | null }) {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ApiTokenCategory>('client');
  const [expiryMode, setExpiryMode] = useState<'never' | 'date'>('never');
  const [expiryDate, setExpiryDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    setLoading(true);
    void listApiTokens(token)
      .then((items) => {
        setTokens(items);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.1eb6ea9038'),
        );
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!token) {
    return (
      <p className="mt-[24px] font-medium text-[16px] text-figma-muted">
        {t('figma-dashboard.SettingsModal.df8d670234')}
      </p>
    );
  }

  return (
    <div>
      {error ? (
        <p className="mb-[12px] font-medium text-[15px] text-figma-danger">{error}</p>
      ) : null}
      <div className="grid gap-[12px] md:grid-cols-[1fr_220px]">
        <Field label={t('figma-dashboard.SettingsModal.0918b4ba92')} htmlFor="token-name">
          <input
            id="token-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('figma-dashboard.SettingsModal.c5a03502ac')}
            className={FIELD}
          />
        </Field>
        <Field label={t('figma-dashboard.SettingsModal.b2880545f3')} htmlFor="token-category">
          <select
            id="token-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as ApiTokenCategory)}
            className={FIELD}
          >
            {(Object.keys(CATEGORY_LABELS) as ApiTokenCategory[]).map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-[16px] flex flex-wrap items-center gap-[12px]">
        <ExpiryChoice
          checked={expiryMode === 'never'}
          label={t('figma-dashboard.SettingsModal.28c54755b5')}
          onSelect={() => setExpiryMode('never')}
        />
        <ExpiryChoice
          checked={expiryMode === 'date'}
          label={t('figma-dashboard.SettingsModal.4dabc1fe49')}
          onSelect={() => setExpiryMode('date')}
        />
        {expiryMode === 'date' ? (
          <input
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
            className="h-[48px] rounded-[16px] border border-figma-ink/15 bg-white px-[12px] font-medium text-[15px] text-figma-ink"
          />
        ) : null}
        <button
          type="button"
          disabled={creating || !name.trim()}
          onClick={() => {
            if (expiryMode === 'date' && !expiryDate) {
              setError(t('figma-dashboard.SettingsModal.9ec6a0154d'));
              return;
            }
            setCreating(true);
            void createApiToken(token, {
              name: name.trim(),
              category,
              expiresAt: expiryMode === 'date' ? moscowAt(expiryDate, 23, 59, 59) : null,
            })
              .then((secret) => {
                setCreated(secret);
                setCopied(false);
                setName('');
                setExpiryDate('');
                setExpiryMode('never');
                reload();
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : t('figma-dashboard.SettingsModal.bf1eb1fd5f'),
                );
              })
              .finally(() => setCreating(false));
          }}
          className="ml-auto flex h-[48px] items-center gap-[8px] rounded-full bg-figma-bee px-[18px] font-semibold text-[16px] disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {creating
            ? t('figma-dashboard.SettingsModal.c2f23e8321')
            : t('figma-dashboard.SettingsModal.e2be34974a')}
        </button>
      </div>
      {created ? (
        <div className="mt-[16px] rounded-[20px] bg-figma-ink px-[18px] py-[16px] text-white">
          <p className="font-semibold">{t('figma-dashboard.SettingsModal.9adb5d542d')}</p>
          <div className="mt-[10px] flex items-center gap-[8px]">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{created.token}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(created.token);
                setCopied(true);
              }}
              className="flex items-center gap-[6px] rounded-full bg-figma-bee px-[12px] py-[8px] font-semibold text-[14px] text-figma-ink"
            >
              <Copy className="h-4 w-4" />
              {copied
                ? t('figma-dashboard.SettingsModal.d2d08c715e')
                : t('figma-dashboard.SettingsModal.1ecddf40bf')}
            </button>
          </div>
        </div>
      ) : null}
      <div className="mt-[20px] flex items-center justify-between">
        <p className="font-semibold text-[16px] text-figma-ink">
          {t('figma-dashboard.SettingsModal.f6bc2c9735')}
        </p>
        <button type="button" onClick={reload} className="font-medium text-[13px] text-figma-muted">
          {loading
            ? t('figma-dashboard.SettingsModal.33dfa84ce0')
            : t('figma-dashboard.SettingsModal.603e460bf5')}
        </button>
      </div>
      {tokens.length === 0 && !loading ? (
        <p className="mt-[12px] font-medium text-[15px] text-figma-muted">
          {t('figma-dashboard.SettingsModal.a19e4865da')}
        </p>
      ) : (
        <ul className="mt-[12px] space-y-[8px]">
          {tokens.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-[10px] rounded-[18px] border border-figma-ink/10 px-[16px] py-[12px]"
            >
              <div>
                <div className="flex flex-wrap items-center gap-[8px]">
                  <KeyRound className="h-4 w-4 text-figma-muted" />
                  <span className="font-semibold text-[16px] text-figma-ink">{item.name}</span>
                  <span className="rounded-full bg-figma-canvas px-[8px] py-[2px] text-[12px] text-figma-muted">
                    {CATEGORY_LABELS[item.category]}
                  </span>
                </div>
                <p className="mt-[4px] text-[13px] text-figma-muted">
                  {t('figma-dashboard.SettingsModal.763594e637')}
                  {formatMoscowDate(item.createdAt)} ·{' '}
                  {item.expiresAt === null
                    ? t('figma-dashboard.SettingsModal.c05bf056df')
                    : t('figma-dashboard.SettingsModal.66e004d65b', {
                        value0: formatMoscowDate(item.expiresAt),
                      })}
                </p>
              </div>
              {item.revokedAt === null ? (
                <button
                  type="button"
                  onClick={() => {
                    if (revokingId !== item.id) {
                      setRevokingId(item.id);
                      return;
                    }
                    setRevokingId(null);
                    void revokeApiToken(token, item.id).then(reload);
                  }}
                  className="rounded-full border border-figma-ink/15 px-[12px] py-[6px] text-[14px] text-figma-muted"
                >
                  {revokingId === item.id
                    ? t('figma-dashboard.SettingsModal.e5f38c3a60')
                    : t('figma-dashboard.SettingsModal.b66927e0fc')}
                </button>
              ) : (
                <span className="text-[13px] text-figma-danger">
                  {t('figma-dashboard.SettingsModal.c9b3ac9dd9')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MinuteField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        type="number"
        min={0}
        max={1440}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className={FIELD}
      />
    </Field>
  );
}

function CapacityField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block font-medium text-[14px] text-figma-muted" htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        min={0}
        max={1000}
        step={1}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
        className={FIELD}
      />
    </label>
  );
}

function SettingSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-[20px] border border-figma-ink/10 px-[18px] py-[14px]">
      <span className="font-semibold text-[16px] text-figma-ink">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className="relative block h-[29px] w-[59px] shrink-0 overflow-hidden rounded-[14.5px]"
      >
        <span
          className={`absolute inset-0 rounded-[14.5px] transition-colors duration-300 ${
            checked ? 'bg-figma-ink' : 'bg-figma-muted'
          }`}
        />
        <motion.span
          aria-hidden
          className="absolute top-[3px] size-[23px] rounded-full bg-white"
          initial={false}
          animate={{ left: checked ? 33 : 3 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        />
      </button>
    </div>
  );
}

function ExpiryChoice({
  checked,
  label,
  onSelect,
}: {
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    // A visual segment inside the modal's own radiogroup; the button keeps native
    // keyboard focus, aria-checked carries the selection state.
    // biome-ignore lint/a11y/useSemanticElements: styled segmented toggle, not a form radio
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex h-[48px] items-center gap-[10px] rounded-full px-[4px] font-medium text-[15px] text-figma-ink"
    >
      <span
        className={`flex size-[20px] items-center justify-center rounded-full border-2 ${
          checked ? 'border-figma-ink' : 'border-figma-ink/25'
        }`}
      >
        {checked ? <span className="size-[10px] rounded-full bg-figma-ink" /> : null}
      </span>
      {label}
    </button>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label className="mt-[20px] block font-semibold text-[16px] text-figma-ink" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

/**
 * AI contour settings. The calibration switch turns plan-assessment
 * self-training on execution facts on or off. Provider changes apply to subsequent calls.
 */
function AiForm({ token }: { token: string | null }) {
  const [view, setView] = useState<AiView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [llmUrl, setLlmUrl] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [jevUrl, setJevUrl] = useState('');
  const [jevModel, setJevModel] = useState('');
  const [jevKey, setJevKey] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void getAiSettings(token)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setEnabled(next.settings.planCalibrationEnabled);
        setLlmUrl(next.settings.llmApiUrl ?? '');
        setLlmModel(next.settings.llmModel ?? '');
        setJevUrl(next.settings.jevApiUrl ?? '');
        setJevModel(next.settings.jevModel ?? '');
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.cb94f9024a'),
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const save = (patch: Parameters<typeof saveAiSettings>[1]) => {
    if (!token) return;
    setSaving(true);
    setError(null);
    void saveAiSettings(token, patch)
      .then((next) => {
        setView(next);
        setEnabled(next.settings.planCalibrationEnabled);
        setLlmUrl(next.settings.llmApiUrl ?? '');
        setLlmModel(next.settings.llmModel ?? '');
        setJevUrl(next.settings.jevApiUrl ?? '');
        setJevModel(next.settings.jevModel ?? '');
        setLlmKey('');
        setJevKey('');
      })
      .catch((cause: unknown) => {
        setEnabled(view?.settings.planCalibrationEnabled ?? false);
        setError(
          cause instanceof Error ? cause.message : t('figma-dashboard.SettingsModal.7b4f238028'),
        );
      })
      .finally(() => setSaving(false));
  };

  const status = view?.status;
  const percent = Math.round((status?.confidence ?? 0) * 100);
  const dirty =
    enabled !== (view?.settings.planCalibrationEnabled ?? false) ||
    llmUrl !== (view?.settings.llmApiUrl ?? '') ||
    llmModel !== (view?.settings.llmModel ?? '') ||
    llmKey.length > 0 ||
    jevUrl !== (view?.settings.jevApiUrl ?? '') ||
    jevModel !== (view?.settings.jevModel ?? '') ||
    jevKey.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-[16px] overflow-y-auto pb-[16px] [scrollbar-width:thin]">
        <AiSection
          title={t('figma-dashboard.SettingsModal.a5713dc015')}
          note={t('figma-dashboard.SettingsModal.4342e341ae')}
        >
          <SettingSwitch
            label={t('figma-dashboard.SettingsModal.7c215748bf')}
            checked={enabled}
            onChange={() => {
              const next = !enabled;
              setEnabled(next);
              save({ planCalibrationEnabled: next });
            }}
          />
          <div className="mt-[14px] rounded-[16px] bg-white px-[16px] py-[14px]">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold text-[16px] text-figma-ink">
                {t('figma-dashboard.SettingsModal.62e3bdccda')}
              </span>
              <span className="font-extrabold text-[20px] text-figma-ink">
                {loading && !status ? '…' : `${percent}%`}
              </span>
            </div>
            <div className="mt-[10px] h-[12px] w-full overflow-hidden rounded-full bg-figma-track">
              <div
                className="h-full rounded-full bg-figma-bee transition-[width] duration-300"
                style={{ width: `${loading && !status ? 0 : percent}%` }}
              />
            </div>
            <p className="mt-[10px] font-medium text-[14px] leading-[1.4] text-figma-muted">
              {loading && !status
                ? t('figma-dashboard.SettingsModal.27fc294c71')
                : calibrationCaption(status)}
            </p>
            {status ? (
              <p className="mt-[6px] font-medium text-[13px] text-figma-hint">
                {t('figma-dashboard.SettingsModal.f30d1d4879')}
                {status.source === 'learned'
                  ? t('figma-dashboard.SettingsModal.e22e64fdaa')
                  : t('figma-dashboard.SettingsModal.69325aa9f7')}
                {status.computedAt
                  ? t('figma-dashboard.SettingsModal.b8c038e481', {
                      value0: formatMoscowDate(status.computedAt),
                    })
                  : ''}
              </p>
            ) : null}
            <section
              aria-label={t('figma-dashboard.SettingsModal.8d19ebcf17')}
              className="mt-[14px] text-[14px] text-figma-muted"
            >
              <p className="font-semibold text-figma-ink">
                {t('figma-dashboard.SettingsModal.8d19ebcf17')}
              </p>
              <p>
                {status?.weatherCalibration?.status === 'validated'
                  ? t('figma-dashboard.SettingsModal.0b0187f034')
                  : status?.weatherCalibration?.status === 'shadow'
                    ? t('figma-dashboard.SettingsModal.4fd9c369d3')
                    : t('figma-dashboard.SettingsModal.b96c4f0ced')}
              </p>
              <p>
                {status?.weatherCalibration?.reason ??
                  t('figma-dashboard.SettingsModal.a544285aa7')}
              </p>
              {status?.weatherCalibration ? (
                <p>
                  {t('figma-dashboard.SettingsModal.bd6c3aff1a')}
                  {status.weatherCalibration.observationCount}
                  {t('figma-dashboard.SettingsModal.c27df725a6')} {status.weatherCalibration.days}
                  {t('figma-dashboard.SettingsModal.917de06187')}{' '}
                  {status.weatherCalibration.eligibleGroups}
                  {t('figma-dashboard.SettingsModal.6350a14dac')}{' '}
                  {status.weatherCalibration.totalGroups}.
                </p>
              ) : null}
              <p>{t('figma-dashboard.SettingsModal.4eb1d4b516')}</p>
            </section>
          </div>
        </AiSection>

        <AiSection
          title={t('figma-dashboard.SettingsModal.1b196cc1c1')}
          note={t('figma-dashboard.SettingsModal.e9ede6a562')}
        >
          <Field label={t('figma-dashboard.SettingsModal.e7a241deba')} htmlFor="ai-llm-url">
            <input
              id="ai-llm-url"
              autoComplete="off"
              name="ai-llm-url"
              type="text"
              placeholder={t('figma-dashboard.SettingsModal.d9617135d6')}
              value={llmUrl}
              onChange={(event) => setLlmUrl(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field label={t('figma-dashboard.SettingsModal.5e2c614c23')} htmlFor="ai-llm-model">
            <input
              id="ai-llm-model"
              autoComplete="off"
              name="ai-llm-model"
              type="text"
              placeholder={t('figma-dashboard.SettingsModal.13a647d426')}
              value={llmModel}
              onChange={(event) => setLlmModel(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field
            label={
              view?.settings.llmApiKeySet
                ? `Token ···${view.settings.llmApiKeyLast4 ?? ''}`
                : 'Token'
            }
            htmlFor="ai-llm-key"
          >
            <input
              id="ai-llm-key"
              autoComplete="new-password"
              name="ai-llm-key"
              type="password"
              placeholder={
                view?.settings.llmApiKeySet
                  ? t('figma-dashboard.SettingsModal.9e0fbf4f5c')
                  : t('figma-dashboard.SettingsModal.9e058051d7')
              }
              value={llmKey}
              onChange={(event) => setLlmKey(event.target.value)}
              className={FIELD}
            />
          </Field>
        </AiSection>

        <AiSection
          title={t('figma-dashboard.SettingsModal.723ac2d8d7')}
          note={t('figma-dashboard.SettingsModal.ee57da02ec')}
        >
          <Field label={t('figma-dashboard.SettingsModal.e7a241deba')} htmlFor="ai-jev-url">
            <input
              id="ai-jev-url"
              autoComplete="off"
              name="ai-jev-url"
              type="text"
              placeholder={t('figma-dashboard.SettingsModal.f395ea88ec')}
              value={jevUrl}
              onChange={(event) => setJevUrl(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field label={t('figma-dashboard.SettingsModal.5e2c614c23')} htmlFor="ai-jev-model">
            <input
              id="ai-jev-model"
              autoComplete="off"
              name="ai-jev-model"
              type="text"
              placeholder={t('figma-dashboard.SettingsModal.9e66a118b9')}
              value={jevModel}
              onChange={(event) => setJevModel(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field
            label={
              view?.settings.jevApiKeySet
                ? `Token ···${view.settings.jevApiKeyLast4 ?? ''}`
                : 'Token'
            }
            htmlFor="ai-jev-key"
          >
            <input
              id="ai-jev-key"
              autoComplete="new-password"
              name="ai-jev-key"
              type="password"
              placeholder={
                view?.settings.jevApiKeySet
                  ? t('figma-dashboard.SettingsModal.9e0fbf4f5c')
                  : t('figma-dashboard.SettingsModal.9e058051d7')
              }
              value={jevKey}
              onChange={(event) => setJevKey(event.target.value)}
              className={FIELD}
            />
          </Field>
        </AiSection>
      </div>
      <button
        type="button"
        disabled={saving || loading || !token || !dirty}
        onClick={() =>
          save({
            planCalibrationEnabled: enabled,
            ...(llmUrl !== (view?.settings.llmApiUrl ?? '') ? { llmApiUrl: llmUrl || null } : {}),
            ...(llmModel !== (view?.settings.llmModel ?? '') ? { llmModel: llmModel || null } : {}),
            ...(llmKey ? { llmApiKey: llmKey } : {}),
            ...(jevUrl !== (view?.settings.jevApiUrl ?? '') ? { jevApiUrl: jevUrl || null } : {}),
            ...(jevModel !== (view?.settings.jevModel ?? '') ? { jevModel: jevModel || null } : {}),
            ...(jevKey ? { jevApiKey: jevKey } : {}),
          })
        }
        className={`mt-[12px] flex h-[52px] w-full shrink-0 items-center justify-center rounded-[20px] font-medium text-[17px] transition-transform duration-150 ${
          saving || loading || !token || !dirty
            ? 'bg-figma-track text-figma-hint'
            : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
        }`}
      >
        {saving
          ? t('figma-dashboard.SettingsModal.9c27c381dd')
          : t('figma-dashboard.SettingsModal.74d2e58479')}
      </button>
      {error ? (
        <p role="alert" className="mt-[10px] font-medium text-[15px] text-figma-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AiSection({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[24px] bg-figma-canvas px-[18px] py-[16px]">
      <h3 className="font-extrabold text-[18px] tracking-[-0.3px] text-figma-ink">{title}</h3>
      <p className="mt-[4px] font-medium text-[14px] leading-[1.4] text-figma-muted">{note}</p>
      <div className="mt-[12px]">{children}</div>
    </section>
  );
}

function calibrationCaption(status: AiView['status'] | undefined): string {
  if (!status) return t('figma-dashboard.SettingsModal.0249be9639');
  if (!status.syncedToRouter && status.samples.service === 0) {
    return t('figma-dashboard.SettingsModal.6980c4f40d');
  }
  if (status.confidence >= 1) {
    return t('figma-dashboard.SettingsModal.f2379beeb8');
  }
  const parts = [
    t('figma-dashboard.SettingsModal.bde17ef704', { value0: status.samples.service }),
    t('figma-dashboard.SettingsModal.9beb7e60e4', { value0: status.samples.legs }),
  ];
  if (status.samples.executionDays > 0)
    parts.push(
      t('figma-dashboard.SettingsModal.1d3b0a9e8a', { value0: status.samples.executionDays }),
    );
  return t('figma-dashboard.SettingsModal.b66d4d2b21', { value0: parts.join(', ') });
}
