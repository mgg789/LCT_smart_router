import { useEffect, useRef, useState } from 'react';
import type { LiveBreak, LiveHistoryItem, LiveRouteProgress } from '../api/live';
import type { DashboardSnapshot, PlanRouteView, RequestView } from '../api/types';
import { requestById } from '../domain/dashboard';
import { projectLiveGraph, segmentKey } from '../domain/liveGraph';
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
    return 'начало дня';
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
  const graph = projectLiveGraph(route, progress);
  const vertices = graph.timelineNodes;
  const visibleRequestIds = new Set(
    vertices.flatMap((vertex) => (vertex.requestId ? [vertex.requestId] : [])),
  );
  const retainedHistory = history.filter(
    (item) => item.engineerId === focusedEngineerId && !visibleRequestIds.has(item.request.id),
  );
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
                rank: 1,
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
                rank: 1,
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
              const active = graph.activeNodeKeys.has(vertex.key);
              const following = vertices[index + 1];
              const activeConnector =
                following !== undefined &&
                graph.activeSegmentKeys.has(segmentKey(vertex, following));
              const title =
                vertex.kind === 'start'
                  ? 'Начало дня'
                  : vertex.kind === 'lunch'
                    ? 'Обед'
                    : (request?.workTypeTitle ?? 'Остановка');
              return {
                rank: vertex.kind === 'start' ? 0 : 1,
                at: vertex.at,
                content: (
                  <li key={vertex.key} className="w-40 shrink-0">
                    <button
                      type="button"
                      data-current={active || selected ? 'true' : 'false'}
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
                            background:
                              active || selected
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
                        {following !== undefined ? (
                          <span
                            className={
                              activeConnector ? 'h-1 flex-1 bg-bee' : 'h-px flex-1 bg-line'
                            }
                          />
                        ) : null}
                      </div>
                      <span className={active ? 'text-sm font-bold' : 'text-sm font-semibold'}>
                        {formatClock(vertex.at)}
                      </span>
                      <span
                        className={
                          active
                            ? 'mt-1 text-[13px] leading-5 font-bold text-ink'
                            : 'mt-1 text-[13px] leading-5 text-ink'
                        }
                      >
                        {title}
                      </span>
                      <span className="text-[12px] text-muted">
                        {vertex.kind === 'start' ? 'точка выезда' : request?.addressText}
                      </span>
                      <span className="mt-1 text-[12px] text-muted">
                        {stopStatus(request, vertex.kind)}
                      </span>
                    </button>
                  </li>
                ),
              };
            }),
          ]
            .sort((a, b) => a.rank - b.rank || a.at - b.at)
            .map((item) => item.content)}
        </ol>
      </div>
    </section>
  );
}
