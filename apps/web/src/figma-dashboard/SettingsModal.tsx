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
  { id: 'general', label: 'Общее' },
  { id: 'api', label: 'API' },
  { id: 'maps', label: 'Карты' },
  { id: 'ai', label: 'AI' },
] as const;
export type SettingsTab = (typeof TABS)[number]['id'];

const CATEGORY_LABELS: Record<ApiTokenCategory, string> = {
  client: 'Клиентское приложение',
  eng: 'Приложение инженера',
  client_eng: 'Клиент + инженер',
  master: 'Мастер — дашборд и отладка',
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
    setTab(initialTab);
    setError(null);
    setTwogisKey('');
    setYandexKey('');
    setClearTwogis(false);
    setClearYandex(false);
    setDraft(generalFrom(undefined, routerRef.current));
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    if (!token) {
      setServer(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([getDispatcherSettings(token), getMapProvidersStatus(token).catch(() => null)])
      .then(([settings, status]) => {
        if (cancelled) return;
        setServer(settings);
        setMapStatus(status);
        setDraft(generalFrom(settings, routerRef.current));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить настройки');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  const setField = <K extends keyof GeneralDraft>(key: K, value: GeneralDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label="Закрыть настройки" disabled={submitting} onClose={onClose} />
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
            Настройки
          </h2>
          <button
            type="button"
            aria-label="Закрыть"
            disabled={submitting}
            onClick={onClose}
            className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110 disabled:opacity-50"
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
            </span>
          </button>
        </div>

        <TabSwitch tab={tab} motionOn={motionOn} onChange={setTab} />

        <div className="mt-[16px] min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          {loading ? (
            <p className="mt-[24px] font-medium text-[16px] text-figma-muted">
              Загружаем настройки…
            </p>
          ) : null}
          {tab === 'general' ? <GeneralForm draft={draft} setField={setField} /> : null}
          {tab === 'api' ? <ApiTokensTab token={token} /> : null}
          {tab === 'ai' ? <AiForm token={token} /> : null}
          {tab === 'maps' ? (
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
                setError('Конец дня должен быть позже начала.');
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
                setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройки');
              });
            }}
            className={`mt-[16px] flex h-[56px] w-full items-center justify-center rounded-[20px] font-medium text-[18px] transition-transform duration-150 ${
              submitting || loading || !token
                ? 'bg-figma-track text-figma-hint'
                : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
            }`}
          >
            {submitting ? 'Сохраняем…' : 'Сохранить'}
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
}: {
  tab: SettingsTab;
  motionOn: boolean;
  onChange: (tab: SettingsTab) => void;
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
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className="relative z-10 flex h-full items-center justify-center rounded-full"
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
        <Field label="Начало дня" htmlFor="settings-shift-start">
          <input
            id="settings-shift-start"
            type="time"
            value={draft.shiftStart}
            onChange={(event) => setField('shiftStart', event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field label="Конец дня" htmlFor="settings-shift-end">
          <input
            id="settings-shift-end"
            type="time"
            value={draft.shiftEnd}
            onChange={(event) => setField('shiftEnd', event.target.value)}
            className={FIELD}
          />
        </Field>
      </div>
      <Field label="Допустимое опоздание, мин" htmlFor="settings-lateness">
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
      <p className="mt-[20px] font-semibold text-[16px] text-figma-ink">Только alert</p>
      <p className="mt-[4px] font-medium text-[14px] text-figma-muted">
        До этих порогов диспетчер видит предупреждение, план сам не пересчитывается.
      </p>
      <div className="grid grid-cols-2 gap-[16px]">
        <MinuteField
          id="settings-noshow"
          label="Невыход, мин"
          value={draft.noShowMin}
          onChange={(value) => setField('noShowMin', value)}
        />
        <MinuteField
          id="settings-overdue"
          label="Опоздание инженера, мин"
          value={draft.overdueMin}
          onChange={(value) => setField('overdueMin', value)}
        />
        <MinuteField
          id="settings-timerisk"
          label="Риск окна, мин"
          value={draft.timeRiskMin}
          onChange={(value) => setField('timeRiskMin', value)}
        />
        <MinuteField
          id="settings-repeat"
          label="Повтор alert, мин"
          value={draft.repeatAfterMin}
          onChange={(value) => setField('repeatAfterMin', value)}
        />
      </div>
      <p className="mt-[20px] font-semibold text-[16px] text-figma-ink">После этого — пересчёт</p>
      <p className="mt-[4px] font-medium text-[14px] text-figma-muted">
        Пороги Router: раннее окончание и переработка на точке публикуют новый снимок.
      </p>
      <div className="grid grid-cols-2 gap-[16px]">
        <MinuteField
          id="settings-early"
          label="Ранний финиш, мин"
          value={draft.earlyFinishReplanMin}
          onChange={(value) => setField('earlyFinishReplanMin', value)}
        />
        <MinuteField
          id="settings-overrun"
          label="Переработка на точке, мин"
          value={draft.taskOverrunMin}
          onChange={(value) => setField('taskOverrunMin', value)}
        />
        <MinuteField
          id="settings-access"
          label="Буфер доступа, мин"
          value={draft.accessBufferMin}
          onChange={(value) => setField('accessBufferMin', value)}
        />
      </div>
      <div className="mt-[20px] space-y-[12px]">
        <p className="font-semibold text-[16px] text-figma-ink">Максимум оборудования с собой</p>
        <div className="grid grid-cols-3 gap-[12px]">
          <CapacityField
            id="settings-capacity-walk"
            label="Пешком"
            value={draft.equipmentCapacityWalk}
            onChange={(value) => setField('equipmentCapacityWalk', value)}
          />
          <CapacityField
            id="settings-capacity-bike"
            label="Велосипед"
            value={draft.equipmentCapacityBike}
            onChange={(value) => setField('equipmentCapacityBike', value)}
          />
          <CapacityField
            id="settings-capacity-car"
            label="Авто"
            value={draft.equipmentCapacityCar}
            onChange={(value) => setField('equipmentCapacityCar', value)}
          />
        </div>
        <SettingSwitch
          label="Обеды в плане"
          checked={draft.lunchesEnabled}
          onChange={() => setField('lunchesEnabled', !draft.lunchesEnabled)}
        />
        <SettingSwitch
          label="Учитывать оборудование"
          checked={draft.equipmentEnabled}
          onChange={() => setField('equipmentEnabled', !draft.equipmentEnabled)}
        />
        <SettingSwitch
          label="Пробки от карт"
          checked={draft.trafficEnabled}
          onChange={() => setField('trafficEnabled', !draft.trafficEnabled)}
        />
        <SettingSwitch
          label="Маршруты с метро"
          checked={draft.metroEnabled}
          onChange={() => setField('metroEnabled', !draft.metroEnabled)}
        />
        <SettingSwitch
          label="Передача оборудования"
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
        Можно задать оба ключа. Если отвечают оба — берём 2ГИС. Если 2ГИС молчит — Яндекс. Без
        ключей остаются геоцентры и OSRM.
      </p>
      <Field label="Токен 2ГИС" htmlFor="settings-twogis">
        <input
          id="settings-twogis"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={twogisKey}
          placeholder={
            server?.twogisApiKeySet ? `Задан ···${server.twogisApiKeyLast4 ?? ''}` : 'Ключ API'
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
          Удалить ключ 2ГИС
        </label>
      ) : null}
      <Field label="Токен Яндекс" htmlFor="settings-yandex">
        <input
          id="settings-yandex"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={yandexKey}
          placeholder={
            server?.yandexApiKeySet ? `Задан ···${server.yandexApiKeyLast4 ?? ''}` : 'Ключ API'
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
          Удалить ключ Яндекс
        </label>
      ) : null}
      {status ? (
        <div className="mt-[20px] rounded-[20px] bg-figma-canvas px-[18px] py-[16px] font-medium text-[15px] text-figma-ink">
          <p>
            Активный провайдер:{' '}
            {status.active === 'none' ? 'нет' : status.active === 'twogis' ? '2ГИС' : 'Яндекс'}
          </p>
          <p className="mt-[6px] text-figma-muted">2ГИС — {status.twogis.message}</p>
          <p className="mt-[4px] text-figma-muted">Яндекс — {status.yandex.message}</p>
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
      <p className="font-semibold text-[16px] text-figma-ink">Интеграционные ключи</p>
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
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить MCP-настройки');
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
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить MCP-настройки');
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
      setError('Пароль — минимум 6 символов. «Сгенерировать» предложит надёжный.');
      return;
    }
    apply({ enabled: true, pin: value });
  };

  return (
    <section>
      <p className="font-extrabold text-[18px] tracking-[-0.3px] text-figma-ink">
        MCP-сервер дашборда
      </p>
      <p className="mt-[4px] font-medium text-[14px] leading-[1.4] text-figma-muted">
        Подключите своего ИИ-агента к дашборду: он будет работать за диспетчера — следить за
        обстановкой, разбирать алерты, вести день. Пока агент работает, в шапке мигает робот.
      </p>
      <div className="mt-[12px]">
        <SettingSwitch label="Активировать MCP-сервер" checked={enabled} onChange={toggle} />
      </div>
      {enabled ? (
        <div className="mt-[16px] w-full">
          <Field
            label={
              view?.pinSet
                ? `Пароль задан ···${view.pinLast4 ?? ''} — введите новый, чтобы заменить`
                : 'MCP-пароль'
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
                placeholder="По этому паролю агент подключается к дашборду"
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
              Сгенерировать
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
              {busy ? 'Сохраняем…' : 'Сохранить пароль'}
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
              title={pinReady ? undefined : 'Введите пароль ещё раз — сервер хранит только его хеш'}
              className={`ml-auto flex h-[44px] items-center gap-[8px] rounded-full px-[16px] font-semibold text-[15px] transition-transform duration-150 ${
                busy || !pinReady
                  ? 'bg-figma-track text-figma-hint'
                  : 'bg-figma-bee text-figma-ink hover:scale-[1.02]'
              }`}
            >
              Скачать setup.md
            </button>
          </div>
          {view && !view.pinSet ? (
            <p className="mt-[10px] font-medium text-[13px] text-figma-hint">
              Сервер включится вместе с паролем: без него агенту нечем подключиться.
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
              Сейчас с дашбордом работает агент{view.lastToolName ? ` · ${view.lastToolName}` : ''}
            </p>
          ) : null}
          {endpointUrl ? (
            <p className="mt-[10px] break-all font-medium text-[13px] text-figma-hint">
              Endpoint: {endpointUrl}
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
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить токены');
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!token) {
    return (
      <p className="mt-[24px] font-medium text-[16px] text-figma-muted">Нужна сессия диспетчера.</p>
    );
  }

  return (
    <div>
      {error ? (
        <p className="mb-[12px] font-medium text-[15px] text-figma-danger">{error}</p>
      ) : null}
      <div className="grid gap-[12px] md:grid-cols-[1fr_220px]">
        <Field label="Название" htmlFor="token-name">
          <input
            id="token-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="Мобильное приложение"
            className={FIELD}
          />
        </Field>
        <Field label="Права" htmlFor="token-category">
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
          label="Без срока"
          onSelect={() => setExpiryMode('never')}
        />
        <ExpiryChoice
          checked={expiryMode === 'date'}
          label="До даты"
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
              setError('Выберите дату сгорания или оставьте «без срока»');
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
                setError(cause instanceof Error ? cause.message : 'Не удалось создать токен');
              })
              .finally(() => setCreating(false));
          }}
          className="ml-auto flex h-[48px] items-center gap-[8px] rounded-full bg-figma-bee px-[18px] font-semibold text-[16px] disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {creating ? 'Создаём…' : 'Создать'}
        </button>
      </div>
      {created ? (
        <div className="mt-[16px] rounded-[20px] bg-figma-ink px-[18px] py-[16px] text-white">
          <p className="font-semibold">Токен создан — скопируйте сейчас</p>
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
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="mt-[20px] flex items-center justify-between">
        <p className="font-semibold text-[16px] text-figma-ink">Созданные токены</p>
        <button type="button" onClick={reload} className="font-medium text-[13px] text-figma-muted">
          {loading ? 'Обновляем…' : 'Обновить'}
        </button>
      </div>
      {tokens.length === 0 && !loading ? (
        <p className="mt-[12px] font-medium text-[15px] text-figma-muted">
          Пока нет ни одного токена.
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
                  Создан {formatMoscowDate(item.createdAt)} ·{' '}
                  {item.expiresAt === null ? 'без срока' : `до ${formatMoscowDate(item.expiresAt)}`}
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
                  {revokingId === item.id ? 'Точно отозвать?' : 'Отозвать'}
                </button>
              ) : (
                <span className="text-[13px] text-figma-danger">Отозван</span>
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
 * self-training on execution facts on or off; the LLM and Jev endpoints are
 * reserved for a future contour and change nothing yet.
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
          setError(cause instanceof Error ? cause.message : 'Не удалось загрузить AI-настройки');
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
      })
      .catch((cause: unknown) => {
        setEnabled(view?.settings.planCalibrationEnabled ?? false);
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить AI-настройки');
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
    <div className="flex flex-col gap-[16px] pb-[8px]">
      <AiSection
        title="ML"
        note="Проверка плана учится на фактах исполнения. Выключено — остаётся заводская калибровка."
      >
        <SettingSwitch
          label="Дообучение оценки плана"
          checked={enabled}
          onChange={() => {
            const next = !enabled;
            setEnabled(next);
            save({ planCalibrationEnabled: next });
          }}
        />
        <div className="mt-[14px] rounded-[16px] bg-white px-[16px] py-[14px]">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-[16px] text-figma-ink">Точность самонастройки</span>
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
            {loading && !status ? 'Считаем покрытие фактами.' : calibrationCaption(status)}
          </p>
          {status ? (
            <p className="mt-[6px] font-medium text-[13px] text-figma-hint">
              Источник: {status.source === 'learned' ? 'факты исполнения' : 'заводские допущения'}
              {status.computedAt ? ` · обновлено ${formatMoscowDate(status.computedAt)}` : ''}
            </p>
          ) : null}
        </div>
      </AiSection>

      <AiSection
        title="LLM (OpenAI SDK)"
        note="Адрес, модель и токен. Пока контур только хранит значения: живые вызовы читают LLM_PROVIDER/LLM_TOKEN/LLM_BASE_URL из окружения сервера."
      >
        <Field label="URL" htmlFor="ai-llm-url">
          <input
            id="ai-llm-url"
            type="text"
            placeholder="https://api.openai.com/v1"
            value={llmUrl}
            onChange={(event) => setLlmUrl(event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field label="Model" htmlFor="ai-llm-model">
          <input
            id="ai-llm-model"
            type="text"
            placeholder="gpt-4.1-mini"
            value={llmModel}
            onChange={(event) => setLlmModel(event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field
          label={
            view?.settings.llmApiKeySet ? `Token ···${view.settings.llmApiKeyLast4 ?? ''}` : 'Token'
          }
          htmlFor="ai-llm-key"
        >
          <input
            id="ai-llm-key"
            type="password"
            placeholder={
              view?.settings.llmApiKeySet
                ? 'Задан — введите новый, чтобы заменить'
                : 'Токен пока не задан'
            }
            value={llmKey}
            onChange={(event) => setLlmKey(event.target.value)}
            className={FIELD}
          />
        </Field>
      </AiSection>

      <AiSection
        title="System one (Jev API)"
        note="Адрес, модель и токен. Контур пока только хранит значения."
      >
        <Field label="URL" htmlFor="ai-jev-url">
          <input
            id="ai-jev-url"
            type="text"
            placeholder="https://jev.example/v1"
            value={jevUrl}
            onChange={(event) => setJevUrl(event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field label="Model" htmlFor="ai-jev-model">
          <input
            id="ai-jev-model"
            type="text"
            placeholder="jev"
            value={jevModel}
            onChange={(event) => setJevModel(event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field
          label={
            view?.settings.jevApiKeySet ? `Token ···${view.settings.jevApiKeyLast4 ?? ''}` : 'Token'
          }
          htmlFor="ai-jev-key"
        >
          <input
            id="ai-jev-key"
            type="password"
            placeholder={
              view?.settings.jevApiKeySet
                ? 'Задан — введите новый, чтобы заменить'
                : 'Токен пока не задан'
            }
            value={jevKey}
            onChange={(event) => setJevKey(event.target.value)}
            className={FIELD}
          />
        </Field>
      </AiSection>

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
        className={`mt-[20px] flex h-[52px] w-full items-center justify-center rounded-[20px] font-medium text-[17px] transition-transform duration-150 ${
          saving || loading || !token || !dirty
            ? 'bg-figma-track text-figma-hint'
            : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
        }`}
      >
        {saving ? 'Сохраняем…' : 'Сохранить AI-настройки'}
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
  if (!status) return 'Индикатор появится, когда контур ответит.';
  if (!status.syncedToRouter && status.samples.service === 0) {
    return 'Фактов исполнения пока нет — работаем на заводских допущениях.';
  }
  if (status.confidence >= 1) {
    return 'Калибровка полностью построена на фактах исполнения.';
  }
  const parts = [`${status.samples.service} работ`, `${status.samples.legs} переездов`];
  if (status.samples.executionDays > 0)
    parts.push(`${status.samples.executionDays} дн. исполнения`);
  return `Дообучается на фактах: ${parts.join(', ')}.`;
}
