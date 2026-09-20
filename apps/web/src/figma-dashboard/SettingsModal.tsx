import { motion } from 'framer-motion';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  createApiToken,
  getDispatcherSettings,
  getMapProvidersStatus,
  listApiTokens,
  revokeApiToken,
} from '../api/client';
import type {
  ApiTokenCategory,
  ApiTokenSummary,
  CreatedApiToken,
  DispatcherSettingsView,
  MapProvidersStatus,
  RouterTechnicalSettings,
} from '../api/types';
import { formatMoscowDate, moscowAt } from '../lib/time';
import { FIGMA_ASSETS } from './assets';
import { clockFromMinutes, minutesFromClock } from './dispatcherSettings';
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
] as const;
type SettingsTab = (typeof TABS)[number]['id'];

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
  equipmentEnabled: boolean;
  trafficEnabled: boolean;
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
  onClose,
  onSave,
}: {
  open: boolean;
  motionOn: boolean;
  token: string | null;
  routerSettings?: RouterTechnicalSettings;
  submitting: boolean;
  onClose: () => void;
  onSave: (input: {
    dispatcher: {
      dayStartMin: number;
      dayEndMin: number;
      noShowSec: number;
      overdueSec: number;
      timeRiskSec: number;
      repeatAfterSec: number;
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
    setTab('general');
    setError(null);
    setTwogisKey('');
    setYandexKey('');
    setClearTwogis(false);
    setClearYandex(false);
    setDraft(generalFrom(undefined, routerRef.current));
  }, [open]);

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

        {tab !== 'api' ? (
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
                  windowLatenessToleranceSec: draft.latenessMin * 60,
                  departureLatenessToleranceSec: draft.latenessMin * 60,
                  taskStartLatenessToleranceSec: draft.latenessMin * 60,
                  accessBufferSec: draft.accessBufferMin * 60,
                  earlyFinishReplanThresholdSec: draft.earlyFinishReplanMin * 60,
                  taskOverrunToleranceSec: draft.taskOverrunMin * 60,
                  equipmentEnabled: draft.equipmentEnabled,
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
    equipmentEnabled: router?.equipmentEnabled ?? true,
    trafficEnabled: router?.trafficEnabled ?? true,
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
      <div className="relative grid h-full grid-cols-3">
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 rounded-full bg-figma-ink"
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
      <div className="mt-[16px] flex flex-wrap items-end gap-[12px]">
        <label className="flex items-center gap-[8px] font-medium text-[15px] text-figma-ink">
          <input
            type="radio"
            checked={expiryMode === 'never'}
            onChange={() => setExpiryMode('never')}
          />
          Без срока
        </label>
        <label className="flex items-center gap-[8px] font-medium text-[15px] text-figma-ink">
          <input
            type="radio"
            checked={expiryMode === 'date'}
            onChange={() => setExpiryMode('date')}
          />
          До даты
        </label>
        {expiryMode === 'date' ? (
          <input
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
            className="h-[48px] rounded-[16px] border border-figma-ink/15 px-[12px]"
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
        onClick={onChange}
        className={`flex h-[28px] w-[48px] items-center rounded-full p-[2px] ${
          checked ? 'justify-end bg-figma-bee' : 'justify-start bg-figma-track'
        }`}
      >
        <span className="size-[24px] rounded-full bg-white shadow" />
      </button>
    </div>
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
