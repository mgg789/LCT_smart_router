import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchState } from '@/entities/plan';
import { useRequests } from '@/entities/request';
import { cn, formatDayTitle, formatKm, formatRange, formatTime } from '@/shared/lib';
import { Carousel, Monogram } from '@/shared/ui';
import type { EngineerProfile } from '../model/engineerProfile';
import { buildEngineerProfile } from '../model/engineerProfile';

/** One line of the profile's detail list. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-ink/10 border-b py-3 last:border-b-0">
      <span className="text-[16px] text-ink/55">{label}</span>
      <span className="text-right text-[18px] text-ink">{value}</span>
    </div>
  );
}

function lunchText(profile: EngineerProfile): string {
  const lunch = profile.lunch;
  if (!lunch?.enabled) return 'выключен';
  if (lunch.windowStartAt === null || lunch.windowEndAt === null) return 'включён';
  const window = formatRange(lunch.windowStartAt, lunch.windowEndAt);
  return lunch.taken ? `${window} · взят` : window;
}

function baseText(profile: EngineerProfile): string {
  if (profile.baseLat === null || profile.baseLon === null) return 'не задана';
  // The contract carries no address for a crew's base, only its coordinates.
  return `${profile.baseLat.toFixed(4)}, ${profile.baseLon.toFixed(4)}`;
}

/**
 * The crews of the day: one profile in full, and the rest as a deck to switch to.
 *
 * The mockup fronts this screen with photographs. There are none in the data, so
 * every face here is a monogram — the shape of the screen is the drawing's, the
 * content is only what the API actually knows.
 */
export function EngineersPage() {
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const engineers = engineersQuery.data?.engineers ?? [];
  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;

  const activeId = selectedId ?? plan?.routes[0]?.engineerId ?? engineers[0]?.id ?? null;
  const active = engineers.find((engineer) => engineer.id === activeId) ?? null;
  const profile = useMemo(
    () => (active ? buildEngineerProfile(active, plan, requests) : null),
    [active, plan, requests],
  );

  const deck = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? engineers.filter((engineer) => engineer.displayName.toLowerCase().includes(needle))
      : engineers;
    return list.filter((engineer) => engineer.id !== activeId);
  }, [engineers, query, activeId]);

  const failed = engineersQuery.isError || requestsQuery.isError || stateQuery.isError;
  const loading = engineersQuery.isPending || requestsQuery.isPending || stateQuery.isPending;
  const dayAnchor = plan?.planAsOf ?? requests[0]?.windowStartAt ?? null;

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать инженеров. Проверьте, что System Layer запущен.
      </p>
    );
  }

  const progress =
    profile && profile.assignedCount > 0 ? profile.doneCount / profile.assignedCount : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <h1 className="font-display text-[32px] text-ink">
        {dayAnchor === null ? 'День' : formatDayTitle(dayAnchor)}
      </h1>

      {loading ? <p className="pt-10 text-[16px] text-ink/55">Загружаем инженеров…</p> : null}

      {!loading && !profile ? (
        <p className="pt-10 text-[16px] text-ink/55">Инженеров в этом дне нет.</p>
      ) : null}

      {profile ? (
        <section className="mt-[26px] flex gap-8 rounded-[20px] bg-surface p-6">
          <Monogram name={profile.name} shape="tile" size={220} />

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-6">
              <h2 className="font-display text-[32px] text-ink">{profile.name}</h2>
              <div className="min-w-[220px] flex-1">
                <div className="h-[6px] w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-ink"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
                <p className="mt-2 text-[16px] text-ink/55">
                  выполнено {profile.doneCount}/{profile.assignedCount}
                  {profile.distanceKm === null ? '' : ` · ${formatKm(profile.distanceKm)}`}
                </p>
              </div>
            </div>

            <p className="mt-1 text-[16px] text-ink/55">
              {profile.email ?? 'вход не привязан'}
              {profile.availability
                ? ` · ${profile.availability === 'online' ? 'на смене' : 'не на смене'}`
                : ''}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {profile.skills.map((skill) => (
                <span className="rounded-full bg-muted px-4 py-2 text-[16px] text-ink" key={skill}>
                  {skill}
                </span>
              ))}
            </div>

            <div className="mt-6 grid gap-x-10 md:grid-cols-2">
              <div>
                <Detail label="Транспорт" value={profile.transport} />
                <Detail label="Старт смены" value={baseText(profile)} />
                <Detail
                  label="Смена"
                  value={
                    profile.shiftStartAt !== null && profile.shiftEndAt !== null
                      ? formatRange(profile.shiftStartAt, profile.shiftEndAt)
                      : 'не задана'
                  }
                />
                <Detail label="Обед" value={lunchText(profile)} />
              </div>

              <div className="mt-6 md:mt-0">
                {profile.current ? (
                  <>
                    <p className="text-[16px] text-ink/55">Текущий пункт плана</p>
                    <p className="mt-1 font-display text-[24px] text-ink">
                      {profile.current.title}
                    </p>
                    <p className="mt-4 font-semibold text-[48px] text-ink leading-none">
                      {formatTime(profile.current.endAt)}
                    </p>
                    <p className="mt-2 text-[16px] text-ink/55">
                      ожидаемое завершение
                      {profile.nextStartAt === null
                        ? ''
                        : ` · следующая заявка в ${formatTime(profile.nextStartAt)}`}
                    </p>
                  </>
                ) : (
                  <p className="text-[16px] text-ink/55">
                    У этой бригады нет маршрута в применённом плане.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                className="h-[52px] rounded-full bg-accent px-7 text-[18px] font-semibold text-ink disabled:opacity-45"
                disabled
                title="Чаты появятся вместе с контрактом на переписку"
                type="button"
              >
                Перейти в чат
              </button>
              <span className="text-[14px] text-ink/50">
                Чатов пока нет: System Layer не отдаёт переписку.
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {profile && profile.stops.length > 0 ? (
        <section className="mt-8 rounded-[20px] bg-surface p-6">
          <h3 className="font-display text-[24px] text-ink">План дня бригады</h3>
          <ol className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
            {profile.stops.map((stop, index) => (
              <li className="min-w-[220px]" key={stop.sequence}>
                <span className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
                      stop.done
                        ? 'bg-ink text-white'
                        : stop.running
                          ? 'bg-success text-white'
                          : 'bg-muted text-ink',
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="font-semibold text-[20px] text-ink">
                    {formatTime(stop.startAt)}
                  </span>
                </span>
                <p className="mt-1 pl-10 text-[16px] text-ink">{stop.title}</p>
                <p className="pl-10 text-[14px] text-ink/50">
                  {stop.done ? 'выполнено' : stop.running ? 'сейчас' : 'по плану'}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="mt-8 pb-4">
        <div className="flex flex-wrap items-center gap-4">
          <h3 className="font-display text-[24px] text-ink">Найти инженера</h3>
          <label className="flex h-12 items-center gap-3 rounded-full bg-surface pr-1 pl-5">
            <span className="sr-only">Поиск инженера</span>
            <input
              className="w-[240px] bg-transparent text-[16px] text-ink outline-none placeholder:text-ink/40"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Имя бригады"
              type="search"
              value={query}
            />
            <span
              aria-hidden
              className="flex size-10 items-center justify-center rounded-full bg-ink text-white"
            >
              <Search size={20} />
            </span>
          </label>
        </div>

        <Carousel aria-label="Другие бригады" className="mt-5">
          {deck.map((engineer, index) => (
            <div className="shrink-0" key={engineer.id}>
              <button
                className={cn(
                  'flex w-[230px] flex-col items-start gap-3 rounded-[20px] bg-ink p-5 text-left text-white transition-transform',
                  index % 2 === 0 ? '-rotate-2 hover:rotate-0' : 'rotate-2 hover:rotate-0',
                )}
                onClick={() => setSelectedId(engineer.id)}
                type="button"
              >
                <Monogram className="bg-white text-ink" name={engineer.displayName} size={44} />
                <span className="w-full truncate font-display text-[18px]">
                  {engineer.displayName}
                </span>
                <span className="text-[14px] text-white/60">
                  {plan?.routes.find((route) => route.engineerId === engineer.id)?.assignedCount ??
                    0}{' '}
                  заявок
                </span>
              </button>
            </div>
          ))}
          {deck.length === 0 ? <p className="text-[16px] text-ink/55">Никто не найден.</p> : null}
        </Carousel>
      </section>
    </div>
  );
}
