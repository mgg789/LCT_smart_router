import { useState } from 'react';
import type { EngineerLiveAction, EngineerLiveView } from '../api/live';
import { formatLiveCountdown, moscowTimeInputAt } from '../engineer/live';
import { eu } from './engineerScale';

const button =
  'rounded-[20px] bg-figma-bee px-4 py-3 font-semibold text-figma-ink disabled:opacity-50';
const field = 'w-full rounded-[20px] border border-figma-ink/20 bg-white p-3 text-figma-ink';

/** State-dependent actions shared by the nearest visit and its detail screen. */
export function LiveControls({
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
  const [form, setForm] = useState<'eta' | 'problem' | null>(null);
  const [time, setTime] = useState('');
  const [problem, setProblem] = useState<'delay' | 'missing_equipment' | 'other' | 'impossible'>(
    'delay',
  );
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
      {working ? (
        <>
          <p className={current.overrunAt !== null ? 'text-figma-danger' : 'text-figma-muted'}>
            {current.overrunAt !== null ? 'Превышено время · ' : 'В работе · '}
            {formatLiveCountdown(now - (current.request.startedAt ?? now))}
          </p>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void submit({ kind: 'finish', requestId })}
          >
            Завершить
          </button>
          <button
            type="button"
            className={`${button} bg-figma-ink text-white`}
            disabled={busy}
            onClick={() => setForm('problem')}
          >
            Проблема
          </button>
          {live.engineer.pendingDelayProblem ? (
            <button
              type="button"
              className="text-left text-figma-danger"
              onClick={() => setForm('problem')}
            >
              Задержка: +{Math.round(live.engineer.pendingDelayProblem.additionalDurationSec / 60)}{' '}
              мин · {live.engineer.pendingDelayProblem.note}
            </button>
          ) : null}
        </>
      ) : current.phase === 'awaiting_window' ? (
        <div className="flex gap-3">
          <button
            type="button"
            className={`${button} flex-1`}
            disabled={busy}
            onClick={() => void submit({ kind: 'on_time', requestId })}
          >
            Буду вовремя
          </button>
          <button
            type="button"
            className={`${button} flex-1 bg-figma-ink text-white`}
            disabled={busy}
            onClick={() => setForm('eta')}
          >
            Буду в…
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void submit({ kind: 'start', requestId })}
        >
          Приступить
        </button>
      )}
      {form === 'eta' ? (
        <form
          className="flex flex-col gap-3"
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
          <label>
            Время прибытия (Москва)
            <input
              className={field}
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <button type="submit" className={button} disabled={busy}>
            Сообщить время
          </button>
        </form>
      ) : null}
      {form === 'problem' ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
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
          <label>
            Что случилось
            <select
              className={field}
              value={problem}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'delay' ||
                  value === 'missing_equipment' ||
                  value === 'other' ||
                  value === 'impossible'
                )
                  setProblem(value);
              }}
            >
              <option value="delay">Задержка</option>
              <option value="missing_equipment">Нет оборудования</option>
              <option value="other">Другая проблема</option>
              <option value="impossible">Невозможно выполнить</option>
            </select>
          </label>
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
                  if (value === 'router' || value === 'set_top_box' || value === 'smart_speaker')
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
              required
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="submit" className={button} disabled={busy}>
            {problem === 'delay' ? 'Сообщить задержку' : 'Отменить заявку с причиной'}
          </button>
        </form>
      ) : null}
      {form ? (
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
      {error ? (
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
  if (!pending && !finished && !stop && !live.lunch) return null;
  const end = stop?.plannedEndAt ?? live.lunch?.endAt ?? now;
  return (
    <section
      className="absolute inset-x-0 bottom-0 top-[100px] z-40 flex flex-col items-center justify-center gap-5 overflow-auto bg-figma-canvas p-6 text-center"
      aria-live="polite"
    >
      <h2 className="font-murs text-2xl text-figma-ink">
        {pending
          ? 'Ожидаем начала дня'
          : finished
            ? 'Рабочий день завершён'
            : stop
              ? 'Технический перерыв'
              : 'Обед'}
      </h2>
      {pending ? (
        <p>Диспетчер запустит смену — ваш маршрут появится здесь.</p>
      ) : finished ? (
        <p>
          Выполнено: {live.engineer.stats.completedCount} · по расписанию:{' '}
          {live.engineer.stats.assumedCompletedCount} · отменено:{' '}
          {live.engineer.stats.cancelledCount}
        </p>
      ) : (
        <p className="font-murs text-4xl">{formatLiveCountdown(end - now)}</p>
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
            Завершить перерыв
          </button>
          <button type="button" className={button} disabled>
            Проблема
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
