import { useState } from 'react';
import type { DashboardSnapshot, EquipmentType } from '../api/types';
import { equipmentLoadout } from '../domain/dashboard';
import { initials, skillLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';

interface EngineersPageProps {
  readonly snapshot: DashboardSnapshot;
  readonly pendingEngineerId: string | null;
  readonly rebuilding: boolean;
  readonly writesDisabled: boolean;
  readonly onAvailabilityChange: (engineerId: string, availability: 'online' | 'offline') => void;
  readonly onLinkAccount: (engineerId: string, email: string) => Promise<void>;
  readonly onUnlinkAccount: (engineerId: string) => Promise<void>;
}

/** Shows the day roster, issued equipment, and live engineer availability controls. */
export function EngineersPage({
  snapshot,
  pendingEngineerId,
  rebuilding,
  writesDisabled,
  onAvailabilityChange,
  onLinkAccount,
  onUnlinkAccount,
}: EngineersPageProps) {
  const engineers = [...snapshot.engineers].sort(
    (left, right) => left.inputOrder - right.inputOrder,
  );
  const teamEquipment = engineers.flatMap((engineer) => equipmentLoadout(snapshot, engineer.id));
  const totals = (['router', 'set_top_box', 'smart_speaker'] as const).map((type) => {
    const lines = teamEquipment.filter((line) => line.type === type);
    return {
      type,
      stock: lines.reduce((sum, line) => sum + line.stock, 0),
      demand: lines.reduce((sum, line) => sum + line.demand, 0),
    };
  });

  return (
    <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <section className="mx-auto max-w-[1440px] rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted">Состав смены и утренняя загрузка</p>
            <h1 className="mt-1 text-2xl font-semibold">Инженеры</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              Выключение инженера публикует новый снимок и ждёт реального плана Router. Комплекты
              закреплены за инженером на день: обмен между инженерами в v0 не выполняется.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {totals.map((item) => (
              <EquipmentTotal
                key={item.type}
                type={item.type}
                stock={item.stock}
                demand={item.demand}
              />
            ))}
          </div>
        </div>

        {engineers.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted">
            В рабочем дне пока нет инженеров.
          </div>
        ) : (
          <ul className="mt-6 grid gap-3 xl:grid-cols-2">
            {engineers.map((engineer) => {
              const day = engineer.day;
              const isOnline = day?.availability === 'online';
              const isPending = pendingEngineerId === engineer.id;
              const loadout = equipmentLoadout(snapshot, engineer.id);
              return (
                <li key={engineer.id} className="rounded-2xl border border-line p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-semibold">
                      {initials(engineer.displayName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h2 className="font-semibold">{engineer.displayName}</h2>
                          <p className="mt-0.5 text-[12px] text-muted">
                            {transportLabel(engineer.transportType)} ·{' '}
                            {day
                              ? `${formatClock(day.shiftStartAt)}–${formatClock(day.shiftEndAt)}`
                              : 'смена не задана'}
                          </p>
                        </div>
                        <label className="flex cursor-pointer items-center gap-3 rounded-full bg-canvas px-3 py-2 text-sm">
                          <span>
                            {isPending
                              ? 'Перестраиваем…'
                              : isOnline
                                ? 'На линии'
                                : availabilityLabel(day?.availability ?? 'offline')}
                          </span>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-checked={isOnline}
                            aria-label={`${isOnline ? 'Отключить' : 'Включить'} ${engineer.displayName}`}
                            checked={isOnline}
                            disabled={!day || rebuilding}
                            onChange={(event) =>
                              onAvailabilityChange(
                                engineer.id,
                                event.target.checked ? 'online' : 'offline',
                              )
                            }
                            className="h-4 w-4 accent-black disabled:opacity-50"
                          />
                        </label>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {engineer.skills.map((skill) => (
                          <span
                            key={skill}
                            className="rounded-full bg-canvas px-2.5 py-1 text-[12px]"
                          >
                            {skillLabel(skill)}
                          </span>
                        ))}
                      </div>
                      <EngineerLoginField
                        engineerId={engineer.id}
                        email={engineer.email}
                        disabled={writesDisabled}
                        onLinkAccount={onLinkAccount}
                        onUnlinkAccount={onUnlinkAccount}
                      />
                    </div>
                  </div>

                  <div className="mt-4 border-t border-line pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-muted">Оборудование на утро</p>
                      <p className="text-[11px] text-muted">
                        {day?.equipmentIssuedAt
                          ? `Зафиксировано в ${formatClock(day.equipmentIssuedAt)} по правилу n+1`
                          : 'Выдача ещё не зафиксирована'}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {loadout.map((line) => (
                        <div key={line.type} className="rounded-xl bg-canvas px-3 py-2">
                          <p className="text-[12px] text-muted">{equipmentLabel(line.type)}</p>
                          <p className="mt-1 text-lg font-semibold">{line.stock}</p>
                          <p className="text-[11px] text-muted">
                            {line.demand} нужно сейчас · {line.spare} осталось
                          </p>
                          {line.shortage > 0 ? (
                            <p className="mt-1 text-[11px] text-red-700">
                              Не хватает {line.shortage}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function EngineerLoginField({
  engineerId,
  email,
  disabled,
  onLinkAccount,
  onUnlinkAccount,
}: {
  readonly engineerId: string;
  readonly email: string | null;
  readonly disabled: boolean;
  readonly onLinkAccount: (engineerId: string, email: string) => Promise<void>;
  readonly onUnlinkAccount: (engineerId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (email) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-muted">Вход: {email}</p>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void onUnlinkAccount(engineerId)
              .catch((cause) => {
                setError(cause instanceof Error ? cause.message : 'Не удалось снять почту');
              })
              .finally(() => setBusy(false));
          }}
          className="text-[12px] text-muted underline disabled:opacity-50"
        >
          Снять почту
        </button>
        {error ? <p className="w-full text-[12px] text-red-700">{error}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void onLinkAccount(engineerId, draft)
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : 'Не удалось привязать почту');
          })
          .finally(() => setBusy(false));
      }}
    >
      <input
        type="email"
        required
        value={draft}
        disabled={disabled || busy}
        placeholder="Почта бригады"
        onChange={(event) => setDraft(event.target.value)}
        className="min-w-48 flex-1 rounded-xl border border-line px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={disabled || busy || draft.length === 0}
        className="rounded-full bg-bee px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
      >
        Привязать
      </button>
      {error ? <p className="w-full text-[12px] text-red-700">{error}</p> : null}
    </form>
  );
}

function EquipmentTotal({
  type,
  stock,
  demand,
}: {
  readonly type: EquipmentType;
  readonly stock: number;
  readonly demand: number;
}) {
  return (
    <div className="min-w-24 rounded-2xl bg-canvas px-3 py-2">
      <p className="text-[11px] text-muted">{equipmentLabel(type)}</p>
      <p className="mt-0.5 font-semibold">{stock}</p>
      <p className="text-[11px] text-muted">нужно {demand}</p>
    </div>
  );
}

function equipmentLabel(type: EquipmentType): string {
  const labels: Record<EquipmentType, string> = {
    router: 'Роутеры',
    set_top_box: 'ТВ-приставки',
    smart_speaker: 'Умные колонки',
  };
  return labels[type];
}

function transportLabel(transport: string): string {
  const labels: Record<string, string> = {
    car: 'Автомобиль',
    walk: 'Пешком',
    bike: 'Велосипед',
    transit: 'Общественный транспорт',
  };
  return labels[transport] ?? transport;
}

function availabilityLabel(availability: string): string {
  if (availability === 'technical_break') {
    return 'Техперерыв';
  }
  return 'Не на линии';
}
