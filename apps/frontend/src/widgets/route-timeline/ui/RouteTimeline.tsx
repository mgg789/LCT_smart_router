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

/**
 * The selected crew's day as a line of stops.
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
  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-[20px] bg-surface p-5">
      <h2 className="font-display text-[24px] text-ink">
        {engineerName ? `Маршрут: ${engineerName}` : 'Маршрут'}
      </h2>
      <p className="mt-1 text-[14px] text-ink/55">
        {planAsOf === null ? 'план ещё не применён' : `план обновлён в ${formatTime(planAsOf)}`}
        {route
          ? ` · ${formatKm(route.distanceKm)} · в дороге ${formatMinutes(route.travelTimeSec)}`
          : ''}
      </p>

      {!route ? (
        <p className="mt-6 text-[15px] text-ink/55">
          У этой бригады нет маршрута в применённом плане.
        </p>
      ) : (
        <ol className="mt-5 flex gap-8 overflow-x-auto pb-2">
          {route.stops.map((stop) => {
            const request = stop.requestId ? requestsById.get(stop.requestId) : undefined;
            const done = request?.lifecycle === 'completed';
            const running = request?.lifecycle === 'in_progress';
            const selected = stop.requestId !== null && stop.requestId === selectedRequestId;

            return (
              <li className="min-w-[180px] shrink-0" key={`${stop.sequence}-${stop.requestId}`}>
                <div className="flex items-center">
                  <span
                    className={cn(
                      'size-[14px] shrink-0 rounded-full',
                      done ? 'bg-ink' : running ? 'bg-success' : 'bg-ink/25',
                    )}
                  />
                  <span className="h-[2px] w-full bg-ink/15" />
                </div>
                <button
                  className={cn(
                    'mt-3 block text-left',
                    selected && 'underline decoration-accent decoration-2 underline-offset-4',
                  )}
                  disabled={!stop.requestId}
                  onClick={() => stop.requestId && onSelectRequest(stop.requestId)}
                  type="button"
                >
                  <span className="block font-semibold text-[20px] text-ink">
                    {formatTime(stop.startAt)}
                  </span>
                  <span className="mt-1 block text-[14px] text-ink">
                    {request?.addressText ?? STOP_KIND_TITLE[stop.kind] ?? stop.kind}
                  </span>
                  <span className="mt-1 block text-[13px] text-ink/50">
                    {done ? 'выполнено' : running ? 'сейчас' : 'по плану'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
