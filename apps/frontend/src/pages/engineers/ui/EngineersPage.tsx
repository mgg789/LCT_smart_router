import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight, Car, Clock, MapPin, Search, Utensils } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchState } from '@/entities/plan';
import { useRequests } from '@/entities/request';
import { cn, formatKm, formatRange, formatTime } from '@/shared/lib';
import { Carousel, Monogram } from '@/shared/ui';
import type { EngineerProfile } from '../model/engineerProfile';
import { buildEngineerProfile } from '../model/engineerProfile';

/** One row of the profile's detail list: icon, label, value. */
function Detail({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-4 border-ink/10 border-b py-4 last:border-b-0">
      <Icon aria-hidden className="shrink-0 text-ink" size={20} />
      <span className="w-[120px] shrink-0 text-[18px] text-ink">{label}</span>
      <span className="text-[18px] text-ink/60">{value}</span>
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
 * The crews of the day: one profile in full, then a deck of the others.
 *
 * The mockup fronts this screen with photographs. There are none in the data, so
 * every face is a monogram — the shape of the screen is the drawing's, the
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
    return needle
      ? engineers.filter((engineer) => engineer.displayName.toLowerCase().includes(needle))
      : engineers;
  }, [engineers, query]);

  const failed = engineersQuery.isError || requestsQuery.isError || stateQuery.isError;
  const loading = engineersQuery.isPending || requestsQuery.isPending || stateQuery.isPending;

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать инженеров. Проверьте, что System Layer запущен.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto pb-6">
      {loading ? <p className="pt-10 text-[16px] text-ink/55">Загружаем инженеров…</p> : null}

      {!loading && !profile ? (
        <p className="pt-10 text-[16px] text-ink/55">Инженеров в этом дне нет.</p>
      ) : null}

      {profile ? (
        <section className="flex overflow-hidden rounded-[20px] bg-surface">
          {/* The drawing bleeds the portrait to the card's edges. */}
          <Monogram
            className="w-[293px] shrink-0 self-stretch"
            name={profile.name}
            shape="fill"
            size={200}
          />

          <div className="flex min-w-0 flex-1 flex-col p-7">
            <div className="flex flex-wrap items-center gap-8">
              <div className="min-w-0">
                <h2 className="truncate font-display text-[36px] text-ink">{profile.name}</h2>
                <p className="mt-1 text-[16px] text-ink/50">
                  {profile.email ?? 'вход не привязан'}
                </p>
              </div>
              <div className="min-w-[240px] flex-1">
                <div className="h-[8px] w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-full rounded-full bg-ink/15" />
                </div>
                <p className="mt-2 flex items-baseline gap-3 text-[16px] text-ink/55">
                  в маршруте {profile.assignedCount} заявок
                  {profile.distanceKm === null ? null : (
                    <span className="font-display text-[20px] text-ink">
                      {formatKm(profile.distanceKm)}
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              {profile.skills.map((skill) => (
                <span className="rounded-full bg-muted px-5 py-2 text-[18px] text-ink" key={skill}>
                  {skill}
                </span>
              ))}
            </div>

            <div className="mt-6 flex flex-1 gap-8">
              <div className="min-w-0 flex-1">
                <Detail icon={Car} label="Транспорт" value={profile.transport} />
                <Detail icon={MapPin} label="Старт смены" value={baseText(profile)} />
                <Detail
                  icon={Clock}
                  label="Смена"
                  value={
                    profile.shiftStartAt !== null && profile.shiftEndAt !== null
                      ? formatRange(profile.shiftStartAt, profile.shiftEndAt)
                      : 'не задана'
                  }
                />
                <Detail icon={Utensils} label="Обед" value={lunchText(profile)} />
              </div>

              <div className="w-px shrink-0 self-stretch bg-ink/10" />

              <div className="min-w-0 flex-1">
                {profile.current ? (
                  <>
                    <h3 className="font-display text-[28px] text-ink">Текущий пункт плана</h3>
                    <p className="mt-1 text-[16px] text-ink/55">{profile.current.title}</p>

                    <div className="mt-5 flex gap-8">
                      <div className="shrink-0">
                        <p className="font-display text-[64px] text-ink leading-none">
                          {formatTime(profile.current.endAt)}
                        </p>
                        <p className="mt-3 text-[16px] text-ink/55">
                          Ожидаемое завершение
                          {profile.nextStartAt === null
                            ? ''
                            : ` · следующая в ${formatTime(profile.nextStartAt)}`}
                        </p>
                      </div>

                      <ol className="flex min-w-0 flex-1 gap-6 overflow-x-auto">
                        {profile.stops.slice(0, 4).map((stop) => (
                          <li className="min-w-[160px] shrink-0" key={stop.sequence}>
                            <div className="relative flex h-4 items-center">
                              <span aria-hidden className="absolute inset-x-0 h-[3px] bg-ink" />
                              <span
                                aria-hidden
                                className={cn(
                                  'relative size-4 rounded-full',
                                  stop.running ? 'bg-success' : 'bg-ink',
                                )}
                              />
                            </div>
                            <p className="mt-3 font-semibold text-[20px] text-ink">
                              {formatTime(stop.startAt)}
                            </p>
                            <p className="mt-1 truncate text-[15px] text-ink">{stop.title}</p>
                            <p className="text-[13px] text-ink/50">
                              {stop.done ? 'выполнено' : stop.running ? 'сейчас' : 'по плану'}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </>
                ) : (
                  <p className="text-[16px] text-ink/55">
                    У этой бригады нет маршрута в применённом плане.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="mt-8 flex flex-col items-center gap-2">
        <button
          className="flex h-[52px] items-center gap-4 rounded-full bg-accent pr-1 pl-7 font-semibold text-[18px] text-ink disabled:opacity-45"
          disabled
          title="Чаты появятся вместе с контрактом на переписку"
          type="button"
        >
          Перейти в чат
          <span className="flex size-11 items-center justify-center rounded-full bg-ink text-white">
            <ArrowUpRight aria-hidden size={20} />
          </span>
        </button>
        <span className="text-[13px] text-ink/45">
          Чатов пока нет: System Layer не отдаёт переписку.
        </span>
      </div>

      <Carousel aria-label="Бригады" className="mt-8 items-center justify-center px-6 py-6">
        {deck.map((engineer, index) => {
          const isActive = engineer.id === activeId;
          const assigned =
            plan?.routes.find((route) => route.engineerId === engineer.id)?.assignedCount ?? 0;
          return (
            <div className="shrink-0" key={engineer.id}>
              <button
                className={cn(
                  'relative flex h-[210px] w-[305px] items-end overflow-hidden rounded-[20px] bg-ink p-6 text-left text-white transition-transform',
                  isActive ? 'z-10 scale-105 rotate-0' : index % 2 === 0 ? '-rotate-6' : 'rotate-6',
                  'hover:rotate-0',
                )}
                onClick={() => setSelectedId(engineer.id)}
                type="button"
              >
                <Monogram
                  className="absolute top-5 right-5 bg-white/15"
                  name={engineer.displayName}
                  size={48}
                />
                <span>
                  <span className="block font-display text-[22px]">{engineer.displayName}</span>
                  <span className="mt-1 block text-[16px] text-white/60">
                    в работе — {assigned} заявок
                  </span>
                </span>
              </button>
            </div>
          );
        })}
        {deck.length === 0 ? <p className="text-[16px] text-ink/55">Никто не найден.</p> : null}
      </Carousel>

      <label className="mt-6 flex items-center justify-center gap-3 text-ink">
        <Search aria-hidden size={26} />
        <span className="sr-only">Найти инженера</span>
        <input
          className="w-[260px] border-ink/20 border-b bg-transparent pb-1 font-display text-[24px] text-ink outline-none placeholder:text-ink"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Найти инженера"
          type="search"
          value={query}
        />
      </label>
    </div>
  );
}
