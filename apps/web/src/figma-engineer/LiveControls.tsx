import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type DispatchWeather, loadEngineerWeather } from '../api/client';
import type { EngineerLiveAction, EngineerLiveView } from '../api/live';
import { formatLiveCountdown, moscowTimeInputAt } from '../engineer/live';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { TintIcon } from '../figma-dashboard/TintIcon';
import { t } from '../i18n';
import { formatPlanWindow } from './engineerClock';
import { eu } from './engineerScale';
import { shouldEnterLiveLine } from './liveSession';

const button =
  'min-h-[calc(82*var(--eu))] rounded-[calc(20*var(--eu))] bg-figma-bee px-4 py-3 font-semibold text-figma-ink disabled:opacity-50';
const field = 'w-full rounded-[20px] border border-figma-ink/20 bg-white p-3 text-figma-ink';

/** State-dependent actions shared by the nearest visit and its detail screen. */
export function LiveControls({
  live,
  now,
  busy,
  send,
  detail = false,
}: {
  live: EngineerLiveView;
  now: number;
  busy: boolean;
  send: (action: EngineerLiveAction) => Promise<boolean>;
  detail?: boolean;
}) {
  const [form, setForm] = useState<'eta' | 'problem' | null>(null);
  const [time, setTime] = useState('');
  const [problem, setProblem] = useState<
    'eta' | 'delay' | 'missing_equipment' | 'other' | 'impossible'
  >('delay');
  const [minutes, setMinutes] = useState<number | ''>('');
  const [equipment, setEquipment] = useState<'router' | 'set_top_box' | 'smart_speaker'>('router');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = live.current;
  if (
    !current ||
    live.workday.status !== 'running' ||
    live.engineer.lineStatus !== 'online' ||
    live.lunch
  )
    return null;
  const requestId = current.request.id;
  const working = current.phase === 'in_progress';
  const awaitingEquipment = (live.logistics ?? []).some(
    (entry) =>
      entry.requestId === requestId &&
      entry.kind === 'donor_delivery' &&
      entry.receiverEngineerId === live.engineer.id &&
      ['searching', 'assigned', 'error'].includes(entry.state),
  );
  const submit = async (action: EngineerLiveAction) => {
    setError(null);
    if (await send(action)) setForm(null);
    else setError(t('figma-engineer.LiveControls.7a18948af1'));
  };
  return (
    <div className="flex flex-col gap-3" style={{ marginTop: eu(20), fontSize: eu(24) }}>
      {!working && !detail ? (
        <span
          className="inline-flex self-start whitespace-nowrap rounded-full bg-figma-ink font-semibold text-white"
          style={{ padding: `${eu(7)} ${eu(30)}`, fontSize: eu(22) }}
        >
          {form === 'eta'
            ? t('figma-engineer.LiveControls.f723ae233c')
            : formatPlanWindow(current.request.windowStartAt, current.request.windowEndAt)}
        </span>
      ) : null}
      {form !== 'eta' ? (
        <div className="flex" style={{ gap: eu(28), fontSize: eu(28) }}>
          {working ? (
            <button
              type="button"
              aria-label={t('figma-engineer.LiveControls.40e33f9af4')}
              className={`${button} !rounded-full flex-1 ${current.overrunAt !== null ? 'bg-figma-cancel' : 'bg-figma-ink'} text-white disabled:opacity-100`}
              disabled={busy}
              onClick={() => setForm('problem')}
            >
              {formatLiveCountdown(now - (current.request.startedAt ?? now))}
            </button>
          ) : (
            <button
              type="button"
              className={`${button} !rounded-full flex-1 ${current.phase !== 'awaiting_window' && now >= (current.stop?.startAt ?? Infinity) ? 'bg-figma-cancel text-white' : ''}`}
              disabled={busy}
              onClick={() =>
                setForm(
                  current.phase !== 'awaiting_window' && now >= (current.stop?.startAt ?? Infinity)
                    ? 'problem'
                    : 'eta',
                )
              }
            >
              {current.phase !== 'awaiting_window' && now >= (current.stop?.startAt ?? Infinity)
                ? t('figma-engineer.LiveControls.54a37f55dc')
                : t('figma-engineer.LiveControls.fb13f1838c')}
            </button>
          )}
          {working || current.phase === 'ready_to_start' ? (
            <button
              type="button"
              className={`${button} flex-1 bg-figma-ink text-white`}
              disabled={busy || awaitingEquipment}
              onClick={() => void submit({ kind: working ? 'finish' : 'start', requestId })}
            >
              {awaitingEquipment
                ? t('figma-engineer.LiveControls.c6531f7f17')
                : working
                  ? t('figma-engineer.LiveControls.8be2bbf39a')
                  : t('figma-engineer.LiveControls.90ef4cfbd4')}
            </button>
          ) : null}
        </div>
      ) : null}
      {detail ? (
        <button
          type="button"
          className={`${button} !rounded-full bg-figma-ink text-white`}
          disabled={busy}
          onClick={() => setForm('problem')}
        >
          {t('figma-engineer.LiveControls.54a37f55dc')}
        </button>
      ) : null}
      {form === 'eta' ? (
        <form
          className="flex items-stretch"
          style={{ gap: eu(28) }}
          onSubmit={(event) => {
            event.preventDefault();
            const etaAt = moscowTimeInputAt(live.workday.workDate, time);
            if (etaAt === null || etaAt <= now) {
              setError(t('figma-engineer.LiveControls.9772de74fd'));
              return;
            }
            void submit({ kind: 'eta', requestId, etaAt });
          }}
        >
          <label className="min-w-0 flex-1">
            <input
              className="w-full border border-figma-ink/20 bg-white text-center text-figma-ink"
              style={{
                height: eu(82),
                borderRadius: eu(20),
                fontSize: eu(28),
                paddingInline: eu(16),
              }}
              type="time"
              aria-label={t('figma-engineer.LiveControls.4fad75bb1b')}
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className={`${button} flex-1 bg-figma-ink text-white`}
            disabled={busy}
          >
            {t('figma-engineer.LiveControls.b7cd6fae08')}
          </button>
        </form>
      ) : null}
      {form === 'problem'
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
              role="presentation"
            >
              <form
                role="dialog"
                aria-modal="true"
                aria-label={t('figma-engineer.LiveControls.7de976c239')}
                className="flex max-h-[90dvh] w-full max-w-md flex-col gap-3 overflow-auto rounded-[20px] bg-figma-canvas p-6 text-figma-ink"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (problem === 'eta') {
                    const etaAt = moscowTimeInputAt(live.workday.workDate, time);
                    if (etaAt === null || etaAt <= now) {
                      setError(t('figma-engineer.LiveControls.9772de74fd'));
                      return;
                    }
                    void submit({ kind: 'eta', requestId, etaAt });
                    return;
                  }
                  void submit({
                    kind: 'problem',
                    requestId,
                    problemKind: problem,
                    note: note.trim(),
                    ...(problem === 'delay' ? { additionalDurationSec: Number(minutes) * 60 } : {}),
                    ...(problem === 'missing_equipment' ? { missingEquipment: equipment } : {}),
                  });
                }}
              >
                <button type="button" className="self-end" onClick={() => setForm(null)}>
                  {t('figma-engineer.LiveControls.a7a4033657')}
                </button>
                <label>
                  {t('figma-engineer.LiveControls.725ffd8d26')}
                  <select
                    className={field}
                    value={problem}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === 'eta' ||
                        value === 'delay' ||
                        value === 'missing_equipment' ||
                        value === 'other' ||
                        value === 'impossible'
                      )
                        setProblem(value);
                    }}
                  >
                    <option value="delay">{t('figma-engineer.LiveControls.6e8b02fe93')}</option>
                    {!working ? (
                      <option value="eta">{t('figma-engineer.LiveControls.dd8368fbc2')}</option>
                    ) : null}
                    <option value="missing_equipment">
                      {t('figma-engineer.LiveControls.a66b9a19d5')}
                    </option>
                    <option value="other">{t('figma-engineer.LiveControls.8680ceb2c3')}</option>
                    <option value="impossible">
                      {t('figma-engineer.LiveControls.7832835abd')}
                    </option>
                  </select>
                </label>
                {problem === 'eta' ? (
                  <label>
                    {t('figma-engineer.LiveControls.f723ae233c')}
                    <input
                      type="time"
                      className={field}
                      required
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                ) : null}
                {problem === 'delay' ? (
                  <label>
                    {t('figma-engineer.LiveControls.2b91cf8ab8')}
                    <input
                      className={field}
                      type="number"
                      min="1"
                      max="720"
                      required
                      placeholder={t('figma-engineer.LiveControls.minutesPlaceholder')}
                      value={minutes}
                      onChange={(event) =>
                        setMinutes(event.target.value === '' ? '' : Number(event.target.value))
                      }
                    />
                  </label>
                ) : null}
                {problem === 'missing_equipment' ? (
                  <label>
                    {t('figma-engineer.LiveControls.1d659fd28c')}
                    <select
                      className={field}
                      value={equipment}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (
                          value === 'router' ||
                          value === 'set_top_box' ||
                          value === 'smart_speaker'
                        )
                          setEquipment(value);
                      }}
                    >
                      <option value="router">{t('figma-engineer.LiveControls.4a65bf9c4b')}</option>
                      <option value="set_top_box">
                        {t('figma-engineer.LiveControls.140d6d4877')}
                      </option>
                      <option value="smart_speaker">
                        {t('figma-engineer.LiveControls.cd9e2a8ef6')}
                      </option>
                    </select>
                  </label>
                ) : null}
                {problem === 'eta' || problem === 'delay' ? (
                  <p className="text-sm text-figma-dim">
                    {t('figma-engineer.LiveControls.daea832b9c')}
                  </p>
                ) : null}
                <label>
                  {t('figma-engineer.LiveControls.b3680f2cba')}
                  {problem !== 'eta' ? (
                    <span className="text-figma-dim"> {t('common.requiredMark')}</span>
                  ) : null}
                  <textarea
                    className={field}
                    required={problem !== 'eta'}
                    maxLength={2000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="min-h-12 w-full rounded-[20px] bg-figma-bee px-4 py-3 font-semibold text-figma-ink disabled:opacity-50"
                  disabled={busy}
                >
                  {problem === 'eta'
                    ? t('figma-engineer.LiveControls.b5bf3f1e67')
                    : problem === 'delay'
                      ? t('figma-engineer.LiveControls.d22913c374')
                      : t('figma-engineer.LiveControls.49ae518ec6')}
                </button>
                {error ? <p role="alert">{error}</p> : null}
              </form>
            </div>,
            document.body,
          )
        : null}
      {error && form !== 'problem' ? (
        <p role="alert" className="text-figma-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Office stock the engineer should pick up before the line. */
export function LiveDayOverlay({
  live,
  now,
  busy,
  send,
  token = null,
  equipment = null,
}: {
  live: EngineerLiveView;
  now: number;
  busy: boolean;
  send: (action: EngineerLiveAction) => Promise<boolean>;
  token?: string | null;
  equipment?: { router: number; setTopBox: number; smartSpeaker: number } | null;
}) {
  const [error, setError] = useState(false);
  const [weather, setWeather] = useState<DispatchWeather | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void loadEngineerWeather(token)
      .then((next) => {
        if (!cancelled) setWeather(next);
      })
      .catch(() => {
        if (!cancelled) setWeather(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  const stop = live.engineer.technicalBreak;
  const pending = live.workday.status === 'pending';
  const finished = live.workday.status === 'finished';
  const entry = shouldEnterLiveLine(live);
  if (finished) return null;
  if (!pending && !finished && !stop && !live.lunch && !entry) return null;
  const end = stop?.plannedEndAt ?? live.lunch?.endAt ?? now;
  return (
    <section
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col items-center justify-center gap-5 overflow-auto bg-figma-canvas p-6 text-center"
      // Starts exactly where the header ends -- eu(36) of page padding above an eu(90)
      // burger. The fixed 100px left a strip of whatever screen this covers showing
      // through above it, which on the assistant is the handover banner, cut in half.
      style={{ top: eu(126) }}
      aria-live="polite"
    >
      {stop ? (
        <img
          src={FIGMA_ASSETS.logo}
          alt={t('figma-engineer.LiveControls.d675af9943')}
          style={{ width: eu(300), marginBottom: eu(60) }}
        />
      ) : null}
      <h2 className="font-murs text-2xl text-figma-ink">
        {entry
          ? t('figma-engineer.LiveControls.b38ff0c67c')
          : pending
            ? t('figma-engineer.LiveControls.a5a8a13dee')
            : finished
              ? t('figma-engineer.LiveControls.64556869b6')
              : stop
                ? t('figma-engineer.LiveControls.d358dd229b')
                : t('figma-engineer.LiveControls.69a29fbff8')}
      </h2>
      {entry ? (
        <>
          <OfficeGear stock={equipment} />
          <WeatherHint kind={weather?.kind ?? null} />
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void send({ kind: 'online' }).then((ok) => setError(!ok))}
          >
            {t('figma-engineer.LiveControls.24f07d8dea')}
          </button>
        </>
      ) : pending ? (
        <p>{t('figma-engineer.LiveControls.f2f5a8e88b')}</p>
      ) : finished ? (
        <p>
          {t('figma-engineer.LiveControls.e5d9795f56')}
          {live.engineer.stats.completedCount}
          {t('figma-engineer.LiveControls.7d7e13f555')} {live.engineer.stats.assumedCompletedCount}
          {t('figma-engineer.LiveControls.f1decb68dd')} {live.engineer.stats.cancelledCount}
        </p>
      ) : (
        <p className="font-murs" style={{ fontSize: stop ? eu(125) : eu(64) }}>
          {formatLiveCountdown(end - now)}
        </p>
      )}
      {stop && !finished ? (
        <>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              void send({ kind: 'break_finish' }).then((ok) => setError(!ok));
            }}
          >
            {t('figma-engineer.LiveControls.6c99e7d8fb')}
          </button>
          {now >= stop.overdueAt ? (
            <p className="text-figma-danger">{t('figma-engineer.LiveControls.8effce7ec4')}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-figma-danger">
              {t('figma-engineer.LiveControls.2a8c6b677f')}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const OFFICE_ROWS = [
  {
    key: 'router' as const,
    icon: '/figma/equipment.svg',
    one: t('figma-engineer.LiveControls.4037da5b81'),
    few: t('figma-engineer.LiveControls.6d24787a26'),
    many: t('figma-engineer.LiveControls.76722bf300'),
  },
  {
    key: 'setTopBox' as const,
    icon: '/figma/set-top-box.svg',
    one: t('figma-engineer.LiveControls.75b7976a3b'),
    few: t('figma-engineer.LiveControls.13b2bb209c'),
    many: t('figma-engineer.LiveControls.142ef45d54'),
  },
  {
    key: 'smartSpeaker' as const,
    icon: '/figma/smart-speaker.svg',
    one: t('figma-engineer.LiveControls.24e5c4c34e'),
    few: t('figma-engineer.LiveControls.b320328987'),
    many: t('figma-engineer.LiveControls.f0e5444fd7'),
  },
];

function OfficeGear({
  stock,
}: {
  stock: { router: number; setTopBox: number; smartSpeaker: number } | null;
}) {
  const rows = OFFICE_ROWS.flatMap((row) => {
    const count = stock?.[row.key] ?? 0;
    return count > 0 ? [{ ...row, count }] : [];
  });
  return (
    <div className="w-full max-w-[360px] rounded-[20px] bg-white px-4 py-4 text-left shadow-[0_10px_28px_rgba(39,41,48,0.06)]">
      <p className="font-semibold text-figma-ink" style={{ fontSize: eu(36) }}>
        {t('figma-engineer.LiveControls.f757e34db7')}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 font-medium text-figma-muted" style={{ fontSize: eu(28) }}>
          {t('figma-engineer.LiveControls.7d5e24ef0b')}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-figma-canvas">
                <TintIcon src={row.icon} color="#272930" size={20} />
              </span>
              <span className="font-medium text-figma-ink" style={{ fontSize: eu(28) }}>
                {ruGear(row.count, row.one, row.few, row.many)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeatherHint({ kind }: { kind: DispatchWeather['kind'] | null }) {
  const hint =
    kind === 'rain'
      ? { icon: '/figma/cloud-rain.svg', text: t('figma-engineer.LiveControls.00d8a62971') }
      : kind === 'snow'
        ? { icon: '/figma/snowflake.svg', text: t('figma-engineer.LiveControls.167da009f4') }
        : kind === 'storm'
          ? { icon: '/figma/cloud-storm.svg', text: t('figma-engineer.LiveControls.dd81be3e3a') }
          : null;
  if (!hint) return null;
  return (
    <p className="flex w-full max-w-[360px] items-center gap-3 rounded-[16px] bg-white px-4 py-3 text-left font-medium text-figma-ink shadow-[0_8px_20px_rgba(39,41,48,0.05)]">
      <TintIcon src={hint.icon} color="#272930" size={22} />
      <span style={{ fontSize: eu(28) }}>{hint.text}</span>
    </p>
  );
}

function ruGear(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? one
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? few
        : many;
  return `${count} ${word}`;
}
