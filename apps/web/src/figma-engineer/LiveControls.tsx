import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { EngineerLiveAction, EngineerLiveView } from '../api/live';
import { formatLiveCountdown, moscowTimeInputAt } from '../engineer/live';
import { eu } from './engineerScale';
import { shouldEnterLiveLine } from './liveSession';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';

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
  >('other');
  const [minutes, setMinutes] = useState(40);
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
  const submit = async (action: EngineerLiveAction) => {
    setError(null);
    if (await send(action)) setForm(null);
    else setError('Не удалось сохранить. Проверьте связь и повторите.');
  };
  return (
    <div className="flex flex-col gap-3" style={{ marginTop: eu(20), fontSize: eu(24) }}>
      {form !== 'eta' ? (
        <div className="flex" style={{ gap: eu(28), fontSize: eu(28) }}>
          {working ? (
            <button
              type="button"
              aria-label={current.overrunAt !== null ? 'Проблема' : 'Время работы'}
              className={`${button} flex-1 ${current.overrunAt !== null ? 'bg-figma-cancel' : 'bg-figma-ink'} text-white disabled:opacity-100`}
              disabled={busy || current.overrunAt === null}
              onClick={() => setForm('problem')}
            >
              {formatLiveCountdown(now - (current.request.startedAt ?? now))}
            </button>
          ) : (
            <button
              type="button"
              className={`${button} flex-1 ${current.phase !== 'awaiting_window' && now >= (current.stop?.startAt ?? Infinity) ? 'bg-figma-cancel text-white' : ''}`}
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
                ? 'Проблема'
                : 'Опаздываю'}
            </button>
          )}
          {working || current.phase === 'ready_to_start' ? (
            <button
              type="button"
              className={`${button} flex-1 bg-figma-ink text-white`}
              disabled={busy}
              onClick={() => void submit({ kind: working ? 'finish' : 'start', requestId })}
            >
              {working ? 'Завершить' : 'Приступить'}
            </button>
          ) : null}
        </div>
      ) : null}
      {detail ? (
        <button
          type="button"
          className={`${button} bg-figma-ink text-white`}
          disabled={busy}
          onClick={() => setForm('problem')}
        >
          Проблема
        </button>
      ) : null}
      {form === 'eta' ? (
        <form
          className="flex gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const etaAt = moscowTimeInputAt(live.workday.workDate, time);
            if (etaAt === null || etaAt <= now) {
              setError('Укажите будущее время прибытия');
              return;
            }
            void submit({ kind: 'eta', requestId, etaAt });
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-2 inline-flex rounded-full bg-figma-ink px-3 py-1 text-sm text-white">
              Время прибытия
            </span>
            <input
              className={field}
              type="time"
              aria-label="Время прибытия (Москва)"
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
            Установить
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
                aria-label="Проблема с заявкой"
                className="flex max-h-[90dvh] w-full max-w-md flex-col gap-3 overflow-auto rounded-[20px] bg-figma-canvas p-6 text-figma-ink"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (problem === 'eta') {
                    const etaAt = moscowTimeInputAt(live.workday.workDate, time);
                    if (etaAt === null || etaAt <= now) {
                      setError('Укажите будущее время прибытия');
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
                    ...(problem === 'delay' ? { additionalDurationSec: minutes * 60 } : {}),
                    ...(problem === 'missing_equipment' ? { missingEquipment: equipment } : {}),
                  });
                }}
              >
                <button type="button" className="self-end" onClick={() => setForm(null)}>
                  Закрыть
                </button>
                <label>
                  Что случилось
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
                    {working ? <option value="delay">Задержка</option> : null}
                    {!working ? <option value="eta">Опаздываю к заявке</option> : null}
                    <option value="missing_equipment">Нет оборудования</option>
                    <option value="other">Другая проблема</option>
                    <option value="impossible">Невозможно выполнить</option>
                  </select>
                </label>
                {problem === 'eta' ? (
                  <label>
                    Время прибытия
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
                    Нужно ещё минут
                    <input
                      className={field}
                      type="number"
                      min="1"
                      max="720"
                      required
                      value={minutes}
                      onChange={(event) => setMinutes(Number(event.target.value))}
                    />
                  </label>
                ) : null}
                {problem === 'missing_equipment' ? (
                  <label>
                    Какого оборудования нет
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
                      <option value="router">Роутер</option>
                      <option value="set_top_box">ТВ-приставка</option>
                      <option value="smart_speaker">Умная колонка</option>
                    </select>
                  </label>
                ) : null}
                <label>
                  Описание
                  <textarea
                    className={field}
                    required={problem !== 'eta'}
                    maxLength={2000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button type="submit" className={button} disabled={busy}>
                  {problem === 'eta'
                    ? 'Установить время прибытия'
                    : problem === 'delay'
                      ? 'Сообщить задержку'
                      : 'Отменить заявку с причиной'}
                </button>
                {error ? <p role="alert">{error}</p> : null}
              </form>
            </div>,
            document.body,
          )
        : null}
      {form === 'eta' ? (
        <button
          type="button"
          className="text-figma-muted"
          onClick={() => {
            setForm(null);
            setError(null);
          }}
        >
          Закрыть форму
        </button>
      ) : null}
      {error && form !== 'problem' ? (
        <p role="alert" className="text-figma-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Blocking automatic lunch, technical stop, pending day and completed day states. */
export function LiveDayOverlay({
  live,
  now,
  busy,
  send,
}: {
  live: EngineerLiveView;
  now: number;
  busy: boolean;
  send: (action: EngineerLiveAction) => Promise<boolean>;
}) {
  const [error, setError] = useState(false);
  const stop = live.engineer.technicalBreak;
  const pending = live.workday.status === 'pending';
  const finished = live.workday.status === 'finished';
  const entry = shouldEnterLiveLine(live);
  if (!pending && !finished && !stop && !live.lunch && !entry) return null;
  const end = stop?.plannedEndAt ?? live.lunch?.endAt ?? now;
  return (
    <section
      className="absolute inset-x-0 bottom-0 top-[100px] z-40 flex flex-col items-center justify-center gap-5 overflow-auto bg-figma-canvas p-6 text-center"
      aria-live="polite"
    >
      {stop ? (
        <img src={FIGMA_ASSETS.logo} alt="NAVIX" style={{ width: eu(300), marginBottom: eu(60) }} />
      ) : null}
      <h2 className="font-murs text-2xl text-figma-ink">
        {entry
          ? 'Выйти на смену'
          : pending
            ? 'Ожидаем начала дня'
            : finished
              ? 'Рабочий день завершён'
              : stop
                ? 'Технический перерыв'
                : 'Обед'}
      </h2>
      {entry ? (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void send({ kind: 'online' }).then((ok) => setError(!ok))}
        >
          Выйти на линию
        </button>
      ) : pending ? (
        <p>Диспетчер запустит смену — ваш маршрут появится здесь.</p>
      ) : finished ? (
        <p>
          Выполнено: {live.engineer.stats.completedCount} · по расписанию:{' '}
          {live.engineer.stats.assumedCompletedCount} · отменено:{' '}
          {live.engineer.stats.cancelledCount}
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
            Вернуться
          </button>
          {now >= stop.overdueAt ? (
            <p className="text-figma-danger">Перерыв затянулся. Диспетчер уведомлён.</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-figma-danger">
              Не удалось завершить перерыв. Повторите.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
