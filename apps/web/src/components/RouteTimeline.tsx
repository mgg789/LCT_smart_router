import { useEffect, useRef, useState } from 'react';
import type { LiveBreak, LiveHistoryItem, LiveRouteProgress } from '../api/live';
import type { DashboardSnapshot, PlanRouteView, RequestView } from '../api/types';
import { requestById, routeVertices } from '../domain/dashboard';
import { engineerColor } from '../lib/reasons';
import { formatClock } from '../lib/time';

interface RouteTimelineProps {
  readonly snapshot: DashboardSnapshot;
  readonly engineerName: string;
  readonly engineerId: string | null;
  readonly route: PlanRouteView | null;
  readonly selectedRequestId: string | null;
  readonly history: readonly LiveHistoryItem[];
  readonly breaks: readonly LiveBreak[];
  /** Factual movement state, independent of the latest solver route revision. */
  readonly progress?: LiveRouteProgress | null;
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
  if (request.completedAt !== null || request.lifecycle === 'completed') {
    return 'выполнена';
  }
  if (request.lifecycle === 'cancelled') {
    return 'отменено';
  }
  if (request.lifecycle === 'in_progress') {
    return 'в работе';
  }
  if (request.assumedCompletedAt !== null && request.assumedCompletedAt !== undefined) {
    return 'по графику';
  }
  return 'запланировано';
}

export function RouteTimeline({
  snapshot,
  engineerName,
  engineerId,
  route,
  selectedRequestId,
  history,
  breaks,
  progress = null,
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

  const focusedEngineerId = route?.engineerId ?? engineerId;
  if (!focusedEngineerId) {
    return (
      <section className="rounded-2xl bg-white px-5 py-4 shadow-sm">
        <h2 className="text-[17px] font-semibold">Общий план дня</h2>
        <p className="mt-1 text-sm text-muted">
          На карте все маршруты. Выберите инженера или заявку, чтобы открыть один путь.
        </p>
      </section>
    );
  }

  const color = engineerColor(focusedEngineerId);
  const vertices = route
    ? routeVertices(route).filter(
        (vertex) =>
          progress === null ||
          progress.anchor.kind === 'start' ||
          (vertex.kind !== 'start' && vertex.requestId !== progress.anchor.requestId),
      )
    : [];
  const plannedRequestIds = new Set(
    vertices.flatMap((vertex) => (vertex.requestId ? [vertex.requestId] : [])),
  );
  const retainedHistory = history.filter(
    (item) => item.engineerId === focusedEngineerId && !plannedRequestIds.has(item.request.id),
  );
  const progressRequestId =
    progress?.phase === 'on_site'
      ? progress.anchor.requestId
      : progress?.phase === 'traveling'
        ? progress.next?.requestId
        : null;
  const progressRequest = progressRequestId ? requestById(snapshot, progressRequestId) : null;

  const scrollBy = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({ left: direction * 220, behavior: 'smooth' });
  };

  return (
    <section className="rounded-2xl bg-white px-5 py-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold">Маршрут {engineerName}</h2>
          <p className="text-sm text-muted">
            LIVE-пайплайн без GPS · {route?.assignedCount ?? 0} заявок ·{' '}
            {(route?.distanceKm ?? 0).toFixed(0)} км
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
          {[
            ...breaks
              .filter((item) => item.engineerId === focusedEngineerId)
              .map((item) => ({
                at: item.startedAt,
                content: (
                  <li
                    key={item.id}
                    className="w-40 shrink-0 rounded-xl border border-line bg-canvas p-3 mr-3"
                  >
                    <p className="text-sm font-semibold">Тех. перерыв</p>
                    <p className="text-xs text-muted">
                      {formatClock(item.startedAt)}–{formatClock(item.endedAt ?? item.plannedEndAt)}
                    </p>
                    <p className="text-xs text-muted">
                      {item.endedAt === null ? 'Идёт сейчас' : 'Завершён'} · 15 мин по плану
                    </p>
                  </li>
                ),
              })),
            ...retainedHistory.map((item) => {
              const selected = item.request.id === selectedRequestId;
              const at = item.terminalAt;
              const label =
                item.outcome === 'assumed_completed'
                  ? 'По графику'
                  : item.outcome === 'cancelled'
                    ? 'Отменена'
                    : 'Выполнена';
              return {
                at,
                content: (
                  <li key={`history-${item.request.id}`} className="w-40 shrink-0">
                    <button
                      type="button"
                      data-current={selected ? 'true' : 'false'}
                      onClick={() => onSelectRequest(item.request.id)}
                      className="flex w-full flex-col items-start pr-3 text-left"
                    >
                      <div className="mb-2 flex w-full items-center">
                        <span
                          className="z-10 h-3 w-3 rounded-full border-2 border-white"
                          style={{
                            background:
                              item.outcome === 'cancelled'
                                ? '#D9534F'
                                : item.outcome === 'assumed_completed'
                                  ? '#A3A3A3'
                                  : '#1F9D68',
                          }}
                        />
                        <span className="h-px flex-1 bg-line" />
                      </div>
                      <span className="text-sm font-semibold">{formatClock(at)}</span>
                      <span className="mt-1 text-[13px] leading-5 text-ink">
                        {item.request.workTypeTitle ?? 'Заявка'}
                      </span>
                      <span className="text-[12px] text-muted">{item.request.addressText}</span>
                      <span className="mt-1 text-[12px] text-muted">{label}</span>
                    </button>
                  </li>
                ),
              };
            }),
            ...vertices.map((vertex, index) => {
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
              return {
                at: vertex.startAt,
                content: (
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
                              : request?.lifecycle === 'completed'
                                ? '#1F9D68'
                                : request?.lifecycle === 'cancelled'
                                  ? '#D9534F'
                                  : vertex.kind === 'lunch'
                                    ? '#E07A2F'
                                    : '#D4D4D4',
                            borderRadius: vertex.kind === 'start' ? '2px' : '999px',
                          }}
                        />
                        {index < vertices.length - 1 ? (
                          <span className="h-px flex-1 bg-line" />
                        ) : null}
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
                ),
              };
            }),
            ...(progress
              ? [
                  {
                    at: progress.occurredAt,
                    content: (
                      <li
                        key={`position-${progress.occurredAt}`}
                        data-current="true"
                        className="w-44 shrink-0 rounded-xl border-2 border-bee bg-amber-50 p-3 mr-3"
                      >
                        <p className="text-xs font-medium uppercase tracking-wide text-amber-800">
                          Текущая позиция
                        </p>
                        <p className="mt-1 text-sm font-semibold">{progressLabel(progress)}</p>
                        {progressRequest ? (
                          <>
                            <p className="mt-1 text-[13px] leading-5 text-ink">
                              {progressRequest.workTypeTitle ?? 'Заявка'}
                            </p>
                            <p className="text-[12px] text-muted">{progressRequest.addressText}</p>
                          </>
                        ) : null}
                        <p className="mt-1 text-xs text-muted">
                          {formatClock(progress.occurredAt)}
                        </p>
                      </li>
                    ),
                  },
                ]
              : []),
          ]
            .sort((a, b) => a.at - b.at)
            .map((item) => item.content)}
        </ol>
      </div>
    </section>
  );
}

/** Text for the factual marker, kept short enough for the horizontal LIVE pipeline. */
function progressLabel(progress: LiveRouteProgress): string {
  if (progress.phase === 'lunch') return 'Обед · на маршруте';
  if (progress.phase === 'traveling') return 'В пути к следующей заявке';
  if (progress.phase === 'on_site') return 'На текущей заявке';
  if (progress.phase === 'finished') return 'Смена завершена';
  return 'Готов к выезду';
}
