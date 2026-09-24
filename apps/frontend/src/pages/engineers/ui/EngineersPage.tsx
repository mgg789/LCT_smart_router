import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight, Car, Clock, MapPin, Search, Utensils } from 'lucide-react';
import type { WheelEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import type { EngineerView } from '@/entities/engineer';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { useRequests } from '@/entities/request';
import { failedWithoutData } from '@/shared/api';
import {
  cn,
  fadeSoft,
  formatKm,
  formatRange,
  formatTime,
  useElementSize,
  useMotionOn,
} from '@/shared/lib';
import { ArcCarousel, initialsOf, Monogram } from '@/shared/ui';
import type { EngineerProfile, ProfileStop } from '../model/engineerProfile';
import { buildEngineerProfile, routeElapsedShare } from '../model/engineerProfile';

/** Distance between two stops on the day's line. */
const STOP_WIDTH = 276;
/** Gutters of the drawing, kept by everything on the canvas except the deck. */
const GUTTER = 'ml-[31px] mr-[34px]';
const SEARCH_PLACEHOLDER = 'Найти инженера';
/** Keeps the field usable while it is empty and the placeholder is short. */
const MIN_SEARCH_WIDTH = 120;

/** One row of the profile's detail list: icon, dark label, grey value. */
function Detail({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex h-[55px] items-center gap-2 border-muted border-b">
      <Icon aria-hidden className="shrink-0 text-ink" size={22} strokeWidth={1.8} />
      <span className="w-[134px] shrink-0 font-semibold text-[19px] text-ink">{label}</span>
      <span className="truncate text-[19px] text-ink-soft">{value}</span>
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
  if (profile.baseLat === null || profile.baseLon === null) return 'не задан';
  // The contract carries no address for a crew's base, only its coordinates.
  return `${profile.baseLat.toFixed(4)}, ${profile.baseLon.toFixed(4)}`;
}

function stopStatus(stop: ProfileStop): string {
  if (stop.outcome === 'cancelled') return 'отменено';
  if (stop.outcome === 'assumed_completed') return 'по расписанию';
  if (stop.done) return 'выполнено';
  if (stop.running) return 'в работе';
  return 'по плану';
}

/** Heading line of the current stop: where, for whom, when the plan expects arrival. */
function currentSubtitle(stop: ProfileStop): string {
  return [
    stop.title,
    stop.contactName ? `клиент «${stop.contactName}»` : null,
    `прибытие по плану в ${formatTime(stop.arrivalAt)}`,
  ]
    .filter(Boolean)
    .join('  •  ');
}

/** Face of a deck card, written in `em` so it scales with the card. */
function CrewCard({ engineer, assigned }: { engineer: EngineerView; assigned: number }) {
  return (
    <span className="relative block h-full w-full bg-ink text-left">
      <span className="absolute inset-0 flex items-center justify-center font-display text-[5.25em] text-white/15">
        {initialsOf(engineer.displayName)}
      </span>
      <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-ink to-transparent" />
      <span className="absolute right-[1.5em] bottom-[1.5em] left-[1.5em] block">
        <span className="block truncate font-display text-[1.375em] text-white">
          {engineer.displayName}
        </span>
        <span className="mt-[0.25em] block text-[0.9375em] text-white/70">
          в работе — {assigned} заявок
        </span>
      </span>
    </span>
  );
}

/** A vertical wheel over a horizontal strip should walk it sideways. */
function wheelAsHorizontal(event: WheelEvent<HTMLDivElement>) {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (delta !== 0) event.currentTarget.scrollLeft += delta;
}

/**
 * The crews of the day: one profile card in full, then the deck of all of them
 * curved along an arc.
 *
 * The mockup fronts this screen with photographs; there are none in the data, so
 * every face is a monogram. Its «выполнено 2/6» tally and the finished stops on
 * the line come from the LIVE day, which keeps each crew's closed visits — the
 * plan itself holds only the work still ahead.
 */
export function EngineersPage() {
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();
  const liveQuery = useDispatchLive();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const motionOn = useMotionOn();

  const sizerRef = useRef<HTMLSpanElement>(null);
  const sizer = useElementSize(sizerRef);

  const engineers = engineersQuery.data?.engineers ?? [];
  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;
  const live = liveQuery.data ?? null;

  const deck = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? engineers.filter((engineer) => engineer.displayName.toLowerCase().includes(needle))
      : engineers;
  }, [engineers, query]);

  // The front card of the deck is the profile: a search that hides the current
  // crew moves the screen to the first match instead of showing an absent one.
  const activeIndex = Math.max(
    0,
    deck.findIndex((engineer) => engineer.id === selectedId),
  );
  const active = deck[activeIndex] ?? null;
  const profile = useMemo(
    () => (active ? buildEngineerProfile(active, plan, requests, live) : null),
    [active, plan, requests, live],
  );

  const elapsed = profile ? routeElapsedShare(profile, Math.floor(Date.now() / 1000)) : 0;
  const current = profile?.current ?? null;
  // The line of the day: what the crew has closed, then what is ahead of the
  // current visit — the drawing shows the finished stops first.
  const line = [
    ...(profile?.stops ?? []).filter((stop) => stop.outcome !== null),
    ...(current
      ? (profile?.stops ?? []).filter(
          (stop) => stop.outcome === null && stop.sequence > current.sequence,
        )
      : []),
  ];

  const failed = [engineersQuery, requestsQuery, stateQuery].some(failedWithoutData);
  const loading = engineersQuery.isPending || requestsQuery.isPending || stateQuery.isPending;

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать инженеров. Проверьте, что System Layer запущен.
      </p>
    );
  }

  return (
    // No fit of its own any more: `ScreenFit` scales the whole board, so this
    // screen is laid out at the drawing's size and inherits that one scale. A
    // second zoom here would square it.
    <div className="-mr-[34px] -ml-[31px] h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="relative flex h-full min-h-0 flex-col">
        {loading ? (
          <p className={cn(GUTTER, 'pt-10 text-[16px] text-ink-soft')}>Загружаем инженеров…</p>
        ) : null}

        {!loading && !profile ? (
          <p className={cn(GUTTER, 'pt-10 text-[16px] text-ink-soft')}>
            {engineers.length === 0 ? 'Инженеров в этом дне нет.' : 'По запросу никто не найден.'}
          </p>
        ) : null}

        {/* The profile turns over with the deck: the old crew lifts away, the new one settles in. */}
        <AnimatePresence initial={false} mode="wait">
          {profile ? (
            <motion.section
              animate={{ opacity: 1, y: 0 }}
              className={cn(GUTTER, 'flex shrink-0 overflow-hidden rounded-[20px] bg-surface')}
              exit={motionOn ? { opacity: 0, y: -8, transition: { duration: 0.12 } } : undefined}
              initial={motionOn ? { opacity: 0, y: 8 } : false}
              key={profile.id}
              transition={fadeSoft}
            >
              {/* The drawing bleeds the portrait to the card's edges. */}
              <Monogram
                className="w-[286px] shrink-0 self-stretch"
                name={profile.name}
                shape="fill"
                size={200}
              />

              <div className="flex min-w-0 flex-1 flex-col pt-7 pr-7 pb-[34px] pl-5">
                <div className="flex items-start gap-8">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-[31px] text-ink leading-none">
                      {profile.name}
                    </h2>
                    <p className="mt-3 truncate text-[17px] text-ink-soft">
                      {profile.email ?? 'вход не привязан'}
                    </p>
                  </div>

                  <div className="mt-4 w-[320px] shrink-0">
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      title={
                        profile.tally
                          ? 'Сколько визитов бригада уже закрыла — из LIVE-дня'
                          : 'LIVE-день не знает эту бригаду: шкала показывает, какая часть маршрута прошла по времени'
                      }
                    >
                      <div
                        className="h-full rounded-full bg-ink transition-[width] duration-500 ease-out"
                        style={{
                          width: `${Math.round(
                            (profile.tally
                              ? profile.tally.total > 0
                                ? profile.tally.done / profile.tally.total
                                : 0
                              : elapsed) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <p className="mt-2 flex items-baseline justify-end gap-3">
                      <span className="text-[15px] text-ink">
                        {profile.tally
                          ? `выполнено ${profile.tally.done}/${profile.tally.total}`
                          : `осталось ${profile.assignedCount} заявок`}
                      </span>
                      <span className="font-display text-[24px] text-ink">
                        {profile.distanceKm === null ? '— км' : formatKm(profile.distanceKm)}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                  {profile.skills.map((skill) => (
                    <span
                      className="flex h-[39px] items-center rounded-full bg-muted px-6 text-[19px] text-ink"
                      key={skill}
                    >
                      {skill}
                    </span>
                  ))}
                </div>

                <div className="mt-3 flex min-h-0 flex-1">
                  <div className="flex-[572_1_0%]">
                    <Detail icon={Car} label="Транспорт" value={profile.transport} />
                    <Detail icon={MapPin} label="Офис" value={baseText(profile)} />
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

                  <div className="mx-5 w-[2px] shrink-0 bg-muted" />

                  <div className="min-w-0 flex-[810_1_0%] pt-1">
                    {current ? (
                      <>
                        <h3 className="truncate font-display text-[32px] text-ink">
                          {current.number ? `Заявка № ${current.number}` : current.title}
                        </h3>
                        <p className="mt-2 truncate text-[18px] text-ink-soft">
                          {currentSubtitle(current)}
                        </p>

                        <div className="mt-6 flex gap-10">
                          <div className="shrink-0">
                            <p className="font-display text-[64px] text-ink leading-[0.8]">
                              {formatTime(current.endAt)}
                            </p>
                            <p className="mt-5 text-[18px] text-ink">
                              Ожидаемое завершение &nbsp;•
                            </p>
                            <p className="mt-1 text-[18px] text-ink">
                              {profile.nextStartAt === null
                                ? 'Следующей заявки в плане нет'
                                : `Следующая заявка в ${formatTime(profile.nextStartAt)}`}
                            </p>
                          </div>

                          {line.length > 0 ? (
                            <div
                              className={cn(
                                'min-w-0 flex-1 overflow-x-auto overscroll-x-contain',
                                '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                              )}
                              onWheel={wheelAsHorizontal}
                              style={{
                                // The day runs on past both ends of the strip.
                                maskImage:
                                  'linear-gradient(to right, transparent, #000 7%, #000 82%, transparent)',
                              }}
                            >
                              <ol className="relative flex w-max">
                                <span
                                  aria-hidden
                                  className="absolute top-[7px] h-[3px] bg-ink"
                                  style={{ left: STOP_WIDTH / 2, right: STOP_WIDTH / 2 }}
                                />
                                {line.map((stop) => (
                                  <li
                                    className="shrink-0 text-center"
                                    key={stop.sequence}
                                    style={{ width: STOP_WIDTH }}
                                  >
                                    <span
                                      aria-hidden
                                      className={cn(
                                        'mx-auto block size-[17px] rounded-full',
                                        stop.running ? 'bg-success' : 'bg-ink',
                                      )}
                                    />
                                    <p className="mt-3 font-semibold text-[24px] text-ink">
                                      {formatTime(stop.startAt)}
                                    </p>
                                    <p className="mt-1 truncate px-2 text-[18px] text-ink">
                                      {stop.title}
                                    </p>
                                    <p className="mt-1 text-[15px] text-ink-faint">
                                      {stopStatus(stop)}
                                    </p>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <p className="text-[18px] text-ink-soft">
                        У этой бригады нет маршрута в применённом плане.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>

        <div className="mt-[67px] flex shrink-0 flex-col items-center gap-2">
          <button
            className="flex h-[47px] items-center gap-4 rounded-full bg-accent pr-[2px] pl-7 font-semibold text-[19px] text-ink transition-transform duration-150 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!active}
            onClick={() =>
              active && navigate(`${ROUTES.chats}?engineer=${encodeURIComponent(active.id)}`)
            }
            title={active ? `Написать: ${active.displayName}` : 'Сначала выберите бригаду'}
            type="button"
          >
            Перейти в чат
            <span className="flex size-[43px] items-center justify-center rounded-full bg-ink text-accent">
              <ArrowUpRight aria-hidden size={22} strokeWidth={2.4} />
            </span>
          </button>
        </div>

        {/*
         * The deck spans the canvas edge to edge, gutters included, and is drawn
         * over everything else: the drawing lets the fan run past the bottom and
         * both sides of the screen rather than sit in a box of its own.
         */}
        <div className="relative z-20 mt-[22px] min-h-0 flex-1">
          <ArcCarousel
            activeIndex={activeIndex}
            aria-label="Бригады"
            height="100%"
            items={deck}
            keyOf={(engineer) => engineer.id}
            labelOf={(engineer) => engineer.displayName}
            onActiveIndexChange={(index) => setSelectedId(deck[index]?.id ?? null)}
            renderCard={(engineer) => (
              <CrewCard
                assigned={
                  plan?.routes.find((route) => route.engineerId === engineer.id)?.assignedCount ?? 0
                }
                engineer={engineer}
              />
            )}
          />
        </div>

        {/*
         * The two soft glows of the drawing (29:694, 29:695): the deck does not
         * stop at a hard edge, it dissolves into the canvas at the bottom
         * corners. Drawn above the cards, so they fade beneath them.
         */}
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-[-520px] left-[-430px] z-30 h-[880px] w-[1067px] rounded-full"
          style={{
            background:
              'radial-gradient(closest-side, rgba(244,244,245,0.92), rgba(244,244,245,0.45) 62%, rgba(244,244,245,0))',
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute right-[-430px] bottom-[-520px] z-30 h-[880px] w-[1067px] rounded-full"
          style={{
            background:
              'radial-gradient(closest-side, rgba(244,244,245,0.92), rgba(244,244,245,0.45) 62%, rgba(244,244,245,0))',
          }}
        />

        <label className="-mt-[38px] relative z-40 flex shrink-0 items-center justify-center gap-4 pb-1 text-ink">
          <Search aria-hidden size={28} strokeWidth={2.2} />
          <span className="sr-only">Найти инженера</span>
          {/*
           * The field is cut to the width of what it holds. A fixed width would
           * leave slack to the right of the text, and the row would read as
           * shifted left however carefully the box itself is centred.
           */}
          <span
            aria-hidden
            className="pointer-events-none absolute whitespace-pre font-display text-[25px] opacity-0"
            ref={sizerRef}
          >
            {query || SEARCH_PLACEHOLDER}
          </span>
          <input
            className="bg-transparent font-display text-[25px] text-ink outline-none placeholder:text-ink"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={SEARCH_PLACEHOLDER}
            style={{ width: Math.max(MIN_SEARCH_WIDTH, Math.ceil(sizer.width) + 2) }}
            type="search"
            value={query}
          />
        </label>
      </div>
    </div>
  );
}
