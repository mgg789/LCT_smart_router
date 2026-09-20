import { motion } from 'framer-motion';
import { useEffect, useId, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import {
  ADD_TAB_LABEL,
  ADD_TABS,
  ALERT_TYPE_OPTIONS,
  SKILL_OPTIONS,
  TRANSPORT_OPTIONS,
  WORK_TYPE_OPTIONS,
  addSessionOffice,
  addSessionRegion,
  alertTypeLabel,
  officesForRegion,
  selectableRegions,
  type AddTab,
  type SkillId,
  type TransportId,
  useAddedEntities,
  validateAlertDraft,
  validateEngineerDraft,
  validateOfficeDraft,
  validateRegionDraft,
  validateRequestDraft,
  windowFromClocks,
} from './addEntity';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';
import { pushToast } from './toasts';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
/** Tall enough for the engineer tab; shorter tabs keep the empty canvas. */
const DIALOG_HEIGHT = 800;
const CAPSULE_SPRING = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.72 };

const FIELD =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

/**
 * Header «plus» dialog: request / engineer / region+office / alert.
 * Height is fixed to the tallest tab; shorter tabs keep empty canvas.
 * The primary action stays pinned to the bottom except on Region (two submits).
 * Request and engineer call live dispatch APIs; region, office and alert stay
 * session-local until those contracts exist.
 */
export function AddEntityModal({
  open,
  snapshot,
  motionOn,
  live,
  submitting,
  onClose,
  onCreateRequest,
  onCreateEngineer,
}: {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  motionOn: boolean;
  live: boolean;
  submitting: boolean;
  onClose: () => void;
  onCreateRequest: (input: {
    workType: string;
    addressText: string;
    windowStartAt: number;
    windowEndAt: number;
  }) => Promise<void>;
  onCreateEngineer: (input: {
    displayName: string;
    skills: SkillId[];
    transportType: TransportId;
    region: string;
    email: string | null;
  }) => Promise<void>;
}) {
  const [tab, setTab] = useState<AddTab>('request');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab('request');
    setError(null);
    setStatus(null);
  }, [open]);

  return (
    <ModalLayer open={open} motionOn={motionOn}>
          <ModalScrim label="Закрыть добавление" disabled={submitting} onClose={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="figma-add-entity-title"
            className="relative flex w-[800px] flex-col overflow-hidden rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
            style={{ height: DIALOG_HEIGHT }}
            initial={motionOn ? { opacity: 0, y: 12, scale: 0.98 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: 8, scale: 0.98 } : undefined}
            transition={fade}
          >
            <div className="flex items-center justify-between">
              <h2
                id="figma-add-entity-title"
                className="figma-text figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
              >
                Добавить
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

            <TabSwitch
              tab={tab}
              motionOn={motionOn}
              onChange={(next) => {
                setTab(next);
                setError(null);
                setStatus(null);
              }}
            />

            <div className="mt-[24px] min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
              {tab === 'request' ? (
                <RequestForm
                  workDate={snapshot?.workDate ?? todayMoscow()}
                  live={live}
                  onError={setError}
                  onStatus={setStatus}
                  onSubmit={onCreateRequest}
                />
              ) : null}
              {tab === 'engineer' ? (
                <EngineerForm
                  snapshot={snapshot}
                  live={live}
                  onError={setError}
                  onStatus={setStatus}
                  onSubmit={onCreateEngineer}
                />
              ) : null}
              {tab === 'region' ? (
                <RegionOfficeForm snapshot={snapshot} onError={setError} onStatus={setStatus} />
              ) : null}
              {tab === 'alert' ? (
                <AlertForm onError={setError} onStatus={setStatus} />
              ) : null}
            </div>

            {tab !== 'region' || error || status ? (
            <div className="shrink-0 pt-[16px]">
              {error ? (
                <p role="alert" className="mb-[12px] font-medium text-[15px] text-figma-danger">
                  {error}
                </p>
              ) : null}
              {status ? (
                <p role="status" className="mb-[12px] font-medium text-[15px] text-figma-muted">
                  {status}
                </p>
              ) : null}
              {tab !== 'region' ? (
                <SubmitRow
                  submitting={submitting}
                  label={
                    tab === 'request' ? 'Создать заявку' : tab === 'engineer' ? 'Добавить инженера' : 'Создать алёрт'
                  }
                  formId={`add-form-${tab}`}
                />
              ) : null}
            </div>
            ) : null}
          </motion.div>
    </ModalLayer>
  );
}

function TabSwitch({
  tab,
  motionOn,
  onChange,
}: {
  tab: AddTab;
  motionOn: boolean;
  onChange: (tab: AddTab) => void;
}) {
  const index = ADD_TABS.indexOf(tab);
  return (
    <div className="mt-[22px] h-[56px] rounded-full bg-figma-canvas p-[4px]">
      <div className="relative grid h-full grid-cols-4">
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/4 rounded-full bg-figma-ink"
        initial={false}
        animate={{ x: `${index * 100}%` }}
        transition={motionOn ? CAPSULE_SPRING : { duration: 0 }}
      />
      {ADD_TABS.map((item) => {
        const active = item === tab;
        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className="relative z-10 flex h-full items-center justify-center rounded-full"
          >
            <span
              className={`font-semibold text-[16px] tracking-[-0.3px] transition-colors duration-300 ease-out ${
                active ? 'text-white' : 'text-figma-ink'
              }`}
            >
              {ADD_TAB_LABEL[item]}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}

function RequestForm({
  workDate,
  live,
  onError,
  onStatus,
  onSubmit,
}: {
  workDate: string;
  live: boolean;
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
  onSubmit: (input: {
    workType: string;
    addressText: string;
    windowStartAt: number;
    windowEndAt: number;
  }) => Promise<void>;
}) {
  const [workType, setWorkType] = useState<string>(WORK_TYPE_OPTIONS[0].code);
  const [addressText, setAddressText] = useState('');
  const [startClock, setStartClock] = useState('09:00');
  const [endClock, setEndClock] = useState('12:00');

  return (
    <form
      id="add-form-request"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        onStatus(null);
        const issue = validateRequestDraft({ workType, addressText, startClock, endClock });
        if (issue) {
          onError(issue);
          return;
        }
        const window = windowFromClocks(workDate, startClock, endClock);
        if (typeof window === 'string') {
          onError(window);
          return;
        }
        void onSubmit({ workType, addressText: addressText.trim(), ...window })
          .then(() => {
            setAddressText('');
            onStatus(live ? 'Заявка создана и ушла в план дня.' : 'Заявка сохранена только в этом сеансе — живой API недоступен.');
          })
          .catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : 'Не удалось создать заявку');
          });
      }}
    >
      <Field label="Тип" htmlFor="add-request-type">
        <select id="add-request-type" value={workType} onChange={(event) => setWorkType(event.target.value)} className={FIELD}>
          {WORK_TYPE_OPTIONS.map((item) => (
            <option key={item.code} value={item.code}>
              {item.title}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-[20px] grid grid-cols-2 gap-[16px]">
        <Field label="Начало окна" htmlFor="add-request-start">
          <input
            id="add-request-start"
            type="time"
            value={startClock}
            onChange={(event) => setStartClock(event.target.value)}
            className={FIELD}
          />
        </Field>
        <Field label="Конец окна" htmlFor="add-request-end">
          <input
            id="add-request-end"
            type="time"
            value={endClock}
            onChange={(event) => setEndClock(event.target.value)}
            className={FIELD}
          />
        </Field>
      </div>
      <Field label="Адрес" htmlFor="add-request-address">
        <input
          id="add-request-address"
          value={addressText}
          onChange={(event) => setAddressText(event.target.value)}
          placeholder="Город, улица, дом"
          className={FIELD}
        />
      </Field>
    </form>
  );
}

function EngineerForm({
  snapshot,
  live,
  onError,
  onStatus,
  onSubmit,
}: {
  snapshot: DashboardSnapshot | null;
  live: boolean;
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
  onSubmit: (input: {
    displayName: string;
    skills: SkillId[];
    transportType: TransportId;
    region: string;
    email: string | null;
  }) => Promise<void>;
}) {
  const added = useAddedEntities();
  const regions = selectableRegions(snapshot);
  const [displayName, setDisplayName] = useState('');
  const [transportType, setTransportType] = useState<TransportId>('car');
  const [skills, setSkills] = useState<SkillId[]>(['connection']);
  const [region, setRegion] = useState(regions[0]?.id ?? '');
  const [officeId, setOfficeId] = useState('');
  const [email, setEmail] = useState('');
  const offices = officesForRegion(region);

  useEffect(() => {
    if (region && !regions.some((item) => item.id === region)) {
      setRegion(regions[0]?.id ?? '');
    }
  }, [region, regions]);

  useEffect(() => {
    if (!offices.some((item) => item.id === officeId)) {
      setOfficeId(offices[0]?.id ?? '');
    }
  }, [officeId, offices]);

  return (
    <form
      id="add-form-engineer"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        onStatus(null);
        const issue = validateEngineerDraft({
          displayName,
          skills,
          transportType,
          region,
          officeId,
          email,
        });
        if (issue) {
          onError(issue);
          return;
        }
        void onSubmit({
          displayName: displayName.trim(),
          skills,
          transportType,
          region,
          email: email.trim() || null,
        })
          .then(() => {
            setDisplayName('');
            setEmail('');
            onStatus(live ? 'Инженер добавлен в снимок дня.' : 'Инженер сохранён только в этом сеансе — живой API недоступен.');
          })
          .catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : 'Не удалось добавить инженера');
          });
      }}
    >
      <Field label="Имя" htmlFor="add-engineer-name">
        <input
          id="add-engineer-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Иван Петров"
          className={FIELD}
        />
      </Field>
      <fieldset className="mt-[20px]">
        <legend className="font-semibold text-[16px] text-figma-ink">Транспорт</legend>
        <div className="mt-[10px] flex flex-wrap gap-[10px]">
          {TRANSPORT_OPTIONS.map((item) => (
            <Chip
              key={item.id}
              active={transportType === item.id}
              onClick={() => setTransportType(item.id)}
            >
              {item.label}
            </Chip>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-[20px]">
        <legend className="font-semibold text-[16px] text-figma-ink">Навыки</legend>
        <div className="mt-[10px] flex flex-wrap gap-[10px]">
          {SKILL_OPTIONS.map((item) => {
            const active = skills.includes(item.id);
            return (
              <Chip
                key={item.id}
                active={active}
                onClick={() =>
                  setSkills((current) =>
                    current.includes(item.id)
                      ? current.filter((skill) => skill !== item.id)
                      : [...current, item.id],
                  )
                }
              >
                {item.label}
              </Chip>
            );
          })}
        </div>
      </fieldset>
      <Field label="Регион" htmlFor="add-engineer-region">
        <select
          id="add-engineer-region"
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          className={FIELD}
        >
          {regions.length === 0 ? <option value="">Сначала добавьте регион</option> : null}
          {regions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Адрес офиса" htmlFor="add-engineer-office">
        <select
          id="add-engineer-office"
          value={officeId}
          onChange={(event) => setOfficeId(event.target.value)}
          className={FIELD}
        >
          {offices.length === 0 ? (
            <option value="">Добавьте офис во вкладке «Регион»</option>
          ) : null}
          {offices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.addressText}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Email (необязательно)" htmlFor="add-engineer-email">
        <input
          id="add-engineer-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="можно добавить позже"
          className={FIELD}
        />
      </Field>
      <p className="mt-[10px] font-medium text-[14px] text-figma-muted">
        {added.offices.length === 0
          ? 'Список офисов появится после добавления во вкладке «Регион».'
          : null}
      </p>
    </form>
  );
}

function RegionOfficeForm({
  snapshot,
  onError,
  onStatus,
}: {
  snapshot: DashboardSnapshot | null;
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
}) {
  const added = useAddedEntities();
  const regions = selectableRegions(snapshot);
  const [regionName, setRegionName] = useState('');
  const [officeRegion, setOfficeRegion] = useState(regions[0]?.id ?? '');
  const [officeAddress, setOfficeAddress] = useState('');

  useEffect(() => {
    if (officeRegion && !regions.some((item) => item.id === officeRegion)) {
      setOfficeRegion(regions[0]?.id ?? '');
    }
  }, [officeRegion, regions]);

  return (
    <div className="flex flex-col gap-[28px]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onError(null);
          onStatus(null);
          const issue = validateRegionDraft(regionName);
          if (issue) {
            onError(issue);
            return;
          }
          const created = addSessionRegion(regionName);
          setOfficeRegion(created.id);
          setRegionName('');
          onStatus(`Регион «${created.label}» добавлен. Контракта POST /dispatch/regions пока нет.`);
        }}
      >
        <p className="font-bold text-[20px] tracking-[-0.34px] text-figma-ink">Новый регион</p>
        <p className="mt-[6px] font-medium text-[14px] text-figma-muted">
          Только название — регион связывает заявки и инженеров, без своих координат.
        </p>
        <Field label="Название" htmlFor="add-region-name">
          <input
            id="add-region-name"
            value={regionName}
            onChange={(event) => setRegionName(event.target.value)}
            placeholder="Северный округ"
            className={FIELD}
          />
        </Field>
        <SubmitRow submitting={false} label="Добавить регион" />
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onError(null);
          onStatus(null);
          const issue = validateOfficeDraft(officeRegion, officeAddress);
          if (issue) {
            onError(issue);
            return;
          }
          const created = addSessionOffice(officeRegion, officeAddress);
          setOfficeAddress('');
          onStatus(`Офис «${created.addressText}» добавлен. Контракта POST /dispatch/depots пока нет.`);
        }}
      >
        <p className="font-bold text-[20px] tracking-[-0.34px] text-figma-ink">Новый офис</p>
        <p className="mt-[6px] font-medium text-[14px] text-figma-muted">
          Адрес базы и регион привязки — отдельная сущность, в этой вкладке рядом с регионом.
        </p>
        <Field label="Регион привязки" htmlFor="add-office-region">
          <select
            id="add-office-region"
            value={officeRegion}
            onChange={(event) => setOfficeRegion(event.target.value)}
            className={FIELD}
          >
            {regions.length === 0 ? <option value="">Сначала добавьте регион</option> : null}
            {regions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Адрес" htmlFor="add-office-address">
          <input
            id="add-office-address"
            value={officeAddress}
            onChange={(event) => setOfficeAddress(event.target.value)}
            placeholder="Москва, Варшавское шоссе, 18"
            className={FIELD}
          />
        </Field>
        {added.offices.length > 0 ? (
          <ul className="mt-[16px] space-y-[8px] font-medium text-[15px] text-figma-muted">
            {added.offices.map((item) => (
              <li key={item.id}>
                {item.addressText} · {regions.find((region) => region.id === item.region)?.label ?? item.region}
              </li>
            ))}
          </ul>
        ) : null}
        <SubmitRow submitting={false} label="Добавить офис" />
      </form>
    </div>
  );
}

function AlertForm({
  onError,
  onStatus,
}: {
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
}) {
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [type, setType] = useState(ALERT_TYPE_OPTIONS[0].id);
  const [reason, setReason] = useState('');

  return (
    <form
      id="add-form-alert"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        onStatus(null);
        const issue = validateAlertDraft({ title, type, reason });
        if (issue) {
          onError(issue);
          return;
        }
        const named = title.trim().replace(/^./u, (letter) => letter.toLocaleUpperCase('ru-RU'));
        const id = `manual-alert-${Date.now()}`;
        pushToast({
          id,
          kind: 'alert',
          title: named,
          body: reason.trim(),
        });
        setTitle('');
        setReason('');
        onStatus(`Алёрт «${alertTypeLabel(type)}» появился во вкладке «Алерты». POST /dispatch/alerts ещё нет.`);
      }}
    >
      <Field label="Название" htmlFor={titleId}>
        <input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Окно не закрывается"
          className={FIELD}
        />
      </Field>
      <Field label="Тип" htmlFor="add-alert-type">
        <select id="add-alert-type" value={type} onChange={(event) => setType(event.target.value as typeof type)} className={FIELD}>
          {ALERT_TYPE_OPTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Причина" htmlFor="add-alert-reason">
        <textarea
          id="add-alert-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
          placeholder="Что требует решения диспетчера"
          className={`${FIELD} h-auto min-h-[120px] py-[16px]`}
        />
      </Field>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-[20px] block font-semibold text-[16px] text-figma-ink" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[42px] items-center rounded-full px-[20px] font-medium text-[16px] tracking-[-0.3px] transition-colors duration-200 ${
        active ? 'bg-figma-ink text-white' : 'bg-figma-track text-figma-ink'
      }`}
    >
      {children}
    </button>
  );
}

function SubmitRow({
  submitting,
  label,
  formId,
}: {
  submitting: boolean;
  label: string;
  formId?: string;
}) {
  return (
    <button
      type="submit"
      form={formId}
      disabled={submitting}
      className={`flex h-[56px] w-full items-center justify-center rounded-[20px] font-semibold text-[18px] tracking-[-0.4px] transition-transform duration-150 ${
        formId ? '' : 'mt-[28px] '
      }${
        submitting ? 'bg-figma-track text-figma-hint' : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
      }`}
    >
      {submitting ? 'Сохраняем…' : label}
    </button>
  );
}

function todayMoscow(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
