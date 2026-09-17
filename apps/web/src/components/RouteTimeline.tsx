import { useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot, PlanRouteView, RequestView } from '../api/types';
import { requestById, routeVertices } from '../domain/dashboard';
import { engineerColor } from '../lib/reasons';
import { formatClock } from '../lib/time';

interface RouteTimelineProps {
  readonly snapshot: DashboardSnapshot;
  readonly engineerName: string;
  readonly route: PlanRouteView | null;
  readonly selectedRequestId: string | null;
  readonly onSelectRequest: (requestId: string) => void;
}

function stopStatus(request: RequestView | null, kind: string): string {
  if (kind === 'start') {
    return 'старт смены';
  }
  if (kind === 'lunch') {
    return 'обед';
  }
  if (kind === 'wait') {
    return 'ожидание окна';
  }
  if (!request) {
    return '';
  }
  if (request.lifecycle === 'completed') {
    return 'выполнено';
  }
  if (request.lifecycle === 'in_progress') {
    return 'в работе';
  }
  return 'запланировано';
}

export function RouteTimeline({
  snapshot,
  engineerName,
  route,
  selectedRequestId,
  onSelectRequest,
}: RouteTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !route) {
      return;
    }
    const update = () => setCanScroll(node.scrollWidth - node.clientWidth > 8);
    update();
    node.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [route]);

  const scrollToken = `${route?.engineerId ?? ''}:${selectedRequestId ?? ''}`;
  useEffect(() => {
    if (!scrollToken) {
      return;
    }
    const selected = scrollerRef.current?.querySelector('[data-current="true"]');
    selected?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [scrollToken]);

  if (!route) {
    return (
      <section className="rounded-2xl bg-white px-5 py-4 shadow-sm">
        <h2 className="text-[17px] font-semibold">Общий план дня</h2>
        <p className="mt-1 text-sm text-muted">
          На карте все маршруты. Выберите инженера или заявку, чтобы открыть один путь.
        </p>
      </section>
    );
  }

  const color = engineerColor(route.engineerId);
  const vertices = routeVertices(route);

  const scrollBy = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({ left: direction * 220, behavior: 'smooth' });
  };

  return (
    <section className="rounded-2xl bg-white px-5 py-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold">Маршрут {engineerName}</h2>
          <p className="text-sm text-muted">
            План без live-позиции · {route.assignedCount} заявок · {route.distanceKm.toFixed(0)} км
          </p>
        </div>
        {canScroll ? (
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Прокрутить маршрут влево"
              onClick={() => scrollBy(-1)}
              className="h-8 w-8 rounded-full border border-line text-sm"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Прокрутить маршрут вправо"
              onClick={() => scrollBy(1)}
              className="h-8 w-8 rounded-full border border-line text-sm"
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      <div ref={scrollerRef} className="relative overflow-x-auto pb-1 [scrollbar-width:thin]">
        <ol className="flex w-max gap-0">
          {vertices.map((vertex, index) => {
            const request = vertex.requestId ? requestById(snapshot, vertex.requestId) : null;
            const selected = vertex.requestId !== null && vertex.requestId === selectedRequestId;
            const title =
              vertex.kind === 'start'
                ? 'Старт смены'
                : vertex.kind === 'lunch'
                  ? 'Обед'
                  : vertex.kind === 'wait'
                    ? 'Ожидание'
                    : (request?.workTypeTitle ?? 'Остановка');
            return (
              <li key={`${vertex.kind}-${vertex.sequence}`} className="w-40 shrink-0">
                <button
                  type="button"
                  data-current={selected ? 'true' : 'false'}
                  onClick={() => {
                    if (vertex.requestId) {
                      onSelectRequest(vertex.requestId);
                    }
                  }}
                  className="flex w-full flex-col items-start pr-3 text-left"
                >
                  <div className="mb-2 flex w-full items-center">
                    <span
                      className="z-10 h-3 w-3 rounded-full border-2 border-white"
                      style={{
                        background: selected
                          ? color
                          : vertex.kind === 'lunch'
                            ? '#E07A2F'
                            : '#D4D4D4',
                        borderRadius: vertex.kind === 'start' ? '2px' : '999px',
                      }}
                    />
                    {index < vertices.length - 1 ? <span className="h-px flex-1 bg-line" /> : null}
                  </div>
                  <span className="text-sm font-semibold">{formatClock(vertex.startAt)}</span>
                  <span className="mt-1 text-[13px] leading-5 text-ink">{title}</span>
                  <span className="text-[12px] text-muted">
                    {vertex.kind === 'start'
                      ? 'точка выезда'
                      : vertex.kind === 'wait'
                        ? 'до начала окна'
                        : request?.addressText}
                  </span>
                  <span className="mt-1 text-[12px] text-muted">
                    {stopStatus(request, vertex.kind)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
