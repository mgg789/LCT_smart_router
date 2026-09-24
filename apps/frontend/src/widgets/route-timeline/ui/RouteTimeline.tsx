import type { PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { cn, formatKm, formatMinutes, formatTime } from '@/shared/lib';

export interface RouteTimelineProps {
  engineerName: string | null;
  route: PlanRouteView | null;
  requestsById: Map<string, RequestView>;
  planAsOf: number | null;
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string) => void;
}

const STOP_KIND_TITLE: Record<string, string> = {
  lunch: 'Обед',
  wait: 'Ожидание',
};

/** Column pitch of the mockup's timeline. */
const COLUMN_WIDTH = 280;

/**
 * The selected crew's day as one line of stops, as the mockup draws it: a single
 * rule running through the dots, the planned time under each, then the address
 * and how that stop is going.
 *
 * Times here are the plan's, not facts: `arrivalAt ≤ startAt ≤ endAt` are what
 * the router computed. What actually happened comes from each request's
 * lifecycle, which is why the caption under a stop can disagree with its clock.
 */
export function RouteTimeline({
  engineerName,
  route,
  requestsById,
  planAsOf,
  selectedRequestId,
  onSelectRequest,
}: RouteTimelineProps) {
  // Only the visits are listed. A `wait` stop shares its coordinates and its
  // place in the day with the job that follows it, so showing both would number
  // the same visit twice — the map now draws them the same way.
  const visits = (route?.stops ?? []).filter(
    (stop) => stop.requestId !== null || stop.kind === 'lunch',
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-[20px] bg-surface p-5">
      <h2 className="font-display text-[24px] text-ink">
        {engineerName ? `Маршрут: ${engineerName}` : 'Маршрут'}
      </h2>
      <p className="mt-1 text-[16px] text-ink/55">
        {planAsOf === null ? 'план ещё не применён' : `план обновлён в ${formatTime(planAsOf)}`}
        {route
          ? ` · ${formatKm(route.distanceKm)} · в дороге ${formatMinutes(route.travelTimeSec)}`
          : ''}
      </p>

      {!route ? (
        <p className="mt-6 text-[15px] text-ink/55">
          {engineerName
            ? 'У этой бригады нет маршрута в применённом плане.'
            : 'Выберите бригаду слева, чтобы увидеть её маршрут.'}
        </p>
      ) : (
        <div
          className="mt-7 min-h-0 overflow-x-auto pb-2 [scrollbar-width:thin]"
          style={{
            // The day runs on past both ends of the strip, as on the crews screen.
            maskImage: 'linear-gradient(to right, transparent, #000 7%, #000 93%, transparent)',
          }}
        >
          <ol className="relative flex w-max">
            {/*
             * One rule behind every dot, stopping half a column short of each end
             * so it starts and finishes under a dot rather than in mid-air — the
             * same line the crews screen draws.
             */}
            <span
              aria-hidden
              className="absolute top-[7px] h-[3px] bg-ink"
              style={{ left: COLUMN_WIDTH / 2, right: COLUMN_WIDTH / 2 }}
            />
            {visits.map((stop, index) => {
              const request = stop.requestId ? requestsById.get(stop.requestId) : undefined;
              const done = request?.lifecycle === 'completed';
              const running = request?.lifecycle === 'in_progress';
              const selected = stop.requestId !== null && stop.requestId === selectedRequestId;

              return (
                <li
                  className="shrink-0 text-center"
                  key={`${stop.sequence}-${stop.requestId ?? index}`}
                  style={{ width: COLUMN_WIDTH }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'relative mx-auto block size-4 rounded-full',
                      running ? 'bg-success' : 'bg-ink',
                    )}
                  />

                  <button
                    className={cn(
                      'mt-4 block w-full px-2 text-center',
                      selected && 'underline decoration-accent decoration-2 underline-offset-4',
                    )}
                    disabled={!stop.requestId}
                    onClick={() => stop.requestId && onSelectRequest(stop.requestId)}
                    type="button"
                  >
                    <span className="block font-semibold text-[26px] text-ink">
                      {formatTime(stop.startAt)}
                    </span>
                    <span className="mt-2 block truncate text-[16px] text-ink">
                      {request?.addressText ?? STOP_KIND_TITLE[stop.kind] ?? stop.kind}
                    </span>
                    <span className="mt-1 block text-[14px] text-ink/50">
                      {done ? 'выполнено' : running ? 'сейчас' : 'по плану'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
