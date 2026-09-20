import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import {
  ADD_TAB_LABEL,
  ADD_TABS,
  SKILL_OPTIONS,
  TRANSPORT_OPTIONS,
  WORK_TYPE_OPTIONS,
  officesForRegion,
  selectableRegions,
  type AddTab,
  type SkillId,
  type TransportId,
  useAddedEntities,
  validateEngineerDraft,
  validateRequestDraft,
  windowFromClocks,
} from './addEntity';
import { AddressPointField } from './AddressPointField';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
/** Tall enough for the engineer tab; shorter tabs keep the empty canvas. */
const DIALOG_HEIGHT = 800;
const CAPSULE_SPRING = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.72 };

const FIELD =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

/**
 * Header «plus» dialog: request / engineer / region.
 * Request and engineer call live dispatch APIs. Region/office create is
 * temporarily disabled; alert create is removed.
 */
export function AddEntityModal({
  open,
  snapshot,
  motionOn,
  live,
  token,
  submitting,
  onClose,
  onCreateRequest,
  onCreateEngineer,
}: {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  motionOn: boolean;
  live: boolean;
  token: string | null;
  submitting: boolean;
  onClose: () => void;
  onCreateRequest: (input: {
    workType: string;
    addressText: string;
    windowStartAt: number;
    windowEndAt: number;
    lat?: number | null;
    lon?: number | null;
  }) => Promise<void>;
  onCreateEngineer: (input: {
    displayName: string;
    skills: SkillId[];
    transportType: TransportId;
    region: string;
    email: string | null;
    homeLat?: number | null;
    homeLon?: number | null;
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
                  token={token}
                  onError={setError}
                  onStatus={setStatus}
                  onSubmit={onCreateRequest}
                />
              ) : null}
              {tab === 'engineer' ? (
                <EngineerForm
                  snapshot={snapshot}
                  live={live}
                  token={token}
                  onError={setError}
                  onStatus={setStatus}
                  onSubmit={onCreateEngineer}
                />
              ) : null}
              {tab === 'region' ? (
                <p className="mt-[24px] font-medium text-[16px] leading-[24px] text-figma-muted">
                  Создание офиса и региона временно отключено.
                </p>
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
                  label={tab === 'request' ? 'Создать заявку' : 'Добавить инженера'}
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
      <div className="relative grid h-full grid-cols-3">
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/3 rounded-full bg-figma-ink"
        initial={false}
        animate={{ x: `${index * 100}%` }}
        transition={motionOn ? CAPSULE_SPRING : { duration: 0 }}
      />
      {ADD_TABS.map((item) => {
        const active = item === tab;
        const disabled = item === 'region';
        return (
          <button
            key={item}
            type="button"
            disabled={disabled}
            title={disabled ? 'Временно недоступно' : undefined}
            onClick={() => {
              if (!disabled) onChange(item);
            }}
            className="relative z-10 flex h-full items-center justify-center rounded-full disabled:cursor-not-allowed"
          >
            <span
                className={`font-semibold text-[16px] tracking-[-0.3px] transition-colors duration-300 ease-out ${
                  disabled ? 'text-figma-hint' : active ? 'text-white' : 'text-figma-ink'
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
  token,
  onError,
  onStatus,
  onSubmit,
}: {
  workDate: string;
  live: boolean;
  token: string | null;
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
  onSubmit: (input: {
    workType: string;
    addressText: string;
    windowStartAt: number;
    windowEndAt: number;
    lat?: number | null;
    lon?: number | null;
  }) => Promise<void>;
}) {
  const [workType, setWorkType] = useState<string>(WORK_TYPE_OPTIONS[0].code);
  const [addressText, setAddressText] = useState('');
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [startClock, setStartClock] = useState('09:00');
  const [endClock, setEndClock] = useState('12:00');

  return (
    <form
      id="add-form-request"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        onStatus(null);
        const issue = validateRequestDraft({ workType, addressText, startClock, endClock, lat, lon });
        if (issue) {
          onError(issue);
          return;
        }
        const window = windowFromClocks(workDate, startClock, endClock);
        if (typeof window === 'string') {
          onError(window);
          return;
        }
        void onSubmit({ workType, addressText: addressText.trim(), lat, lon, ...window })
          .then(() => {
            setAddressText('');
            setLat(null);
            setLon(null);
            onStatus(live ? 'Заявка создана и попала в план дня.' : 'Заявка сохранена только в этом сеансе.');
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
      <AddressPointField
        id="add-request-address"
        label="Адрес"
        token={token}
        addressText={addressText}
        lat={lat}
        lon={lon}
        onAddressChange={(value) => {
          setAddressText(value);
          setLat(null);
          setLon(null);
        }}
        onResolved={(hit) => {
          setAddressText(hit.displayName);
          setLat(hit.lat);
          setLon(hit.lon);
        }}
        onMapPick={(nextLat, nextLon) => {
          setLat(nextLat);
          setLon(nextLon);
          if (!addressText.trim()) {
            setAddressText(`${nextLat.toFixed(5)}, ${nextLon.toFixed(5)}`);
          }
        }}
      />
    </form>
  );
}

function EngineerForm({
  snapshot,
  live,
  token,
  onError,
  onStatus,
  onSubmit,
}: {
  snapshot: DashboardSnapshot | null;
  live: boolean;
  token: string | null;
  onError: (value: string | null) => void;
  onStatus: (value: string | null) => void;
  onSubmit: (input: {
    displayName: string;
    skills: SkillId[];
    transportType: TransportId;
    region: string;
    email: string | null;
    homeLat?: number | null;
    homeLon?: number | null;
  }) => Promise<void>;
}) {
  const [homeLat, setHomeLat] = useState<number | null>(null);
  const [homeLon, setHomeLon] = useState<number | null>(null);
  const [homeAddress, setHomeAddress] = useState('');
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
          homeLat,
          homeLon,
        })
          .then(() => {
            setDisplayName('');
            setEmail('');
            setHomeAddress('');
            setHomeLat(null);
            setHomeLon(null);
            onStatus(live ? 'Профиль инженера создан и поставлен в смену.' : 'Инженер сохранён только в этом сеансе.');
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
      <AddressPointField
        id="add-engineer-home"
        label="Точка старта"
        token={token}
        addressText={homeAddress}
        lat={homeLat}
        lon={homeLon}
        onAddressChange={setHomeAddress}
        onResolved={(hit) => {
          setHomeAddress(hit.displayName);
          setHomeLat(hit.lat);
          setHomeLon(hit.lon);
        }}
        onMapPick={(nextLat, nextLon) => {
          setHomeLat(nextLat);
          setHomeLon(nextLon);
          setHomeAddress(`${nextLat.toFixed(5)}, ${nextLon.toFixed(5)}`);
        }}
      />
      <Field label="Адрес офиса" htmlFor="add-engineer-office">
        <select
          id="add-engineer-office"
          value={officeId}
          onChange={(event) => setOfficeId(event.target.value)}
          className={FIELD}
        >
          {offices.length === 0 ? (
            <option value="">Офис можно привязать позже</option>
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
          ? 'Пока сохраняется регион; офис можно привязать после появления API.'
          : null}
      </p>
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
