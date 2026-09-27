import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandoffView, LiveRouteProgress } from '../api/live';
import { DayMap } from '../components/DayMap';
import type { RegionSelection } from '../domain/regions';
import { useDashboard } from '../hooks/useDashboard';
import { useArtboardStretch } from './artboardStretch';
import { FIGMA_ASSETS } from './assets';
import {
  type EngineerCard,
  isCompletedStop,
  type RouteStop,
  routeStopStatusLabel,
  truncateEnd,
} from './fixtures';
import { PlanHistoryMap } from './PlanHistoryMap';
import type { PlanHistorySelection } from './PlanHistorySelector';
import { FigmaText } from './primitives';
import { RegionSwitch } from './RegionSwitch';
import { routeProgressMarker } from './routeProgress';
import { WeatherBadge } from './WeatherBadge';

const ROUTE_CARD_LEFT = 623;
const ROUTE_CARD_TOP = 768;
const ROUTE_CARD_WIDTH = 751;
const ROUTE_STOP_WIDTH = 260;
const ROUTE_TOPIC_WIDTH = 240;
const ROUTE_DOT_SIZE = 20;
const ROUTE_DOT_LEFT = (ROUTE_TOPIC_WIDTH - ROUTE_DOT_SIZE) / 2;
const ROUTE_LINE_LEFT = 30 + ROUTE_DOT_LEFT + ROUTE_DOT_SIZE / 2;
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

/** Renders the route map frame and keeps historical-plan controls beside the map. */
export function MapCard({
  snapshot,
  previousPlan,
  historyOpen,
  historySelection,
  selectedEngineerId,
  selectedRequestId,
  progressByEngineer,
  completedByEngineer,
  handoffs,
  frame,
  regionLabel,
  regions,
  selectedRegion,
  regionOpen,
  motionOn,
  onSelectRequest,
  onToggleRegion,
  onSelectRegion,
  token,
}: {
  snapshot: ReturnType<typeof useDashboard>['snapshot'];
  previousPlan: ReturnType<typeof useDashboard>['previousPlan'];
  historyOpen: boolean;
  historySelection: PlanHistorySelection;
  selectedEngineerId: string | null;
  selectedRequestId: string | null;
  progressByEngineer: NonNullable<Parameters<typeof DayMap>[0]['progressByEngineer']>;
  completedByEngineer: ReadonlyMap<string, number>;
  handoffs: NonNullable<Parameters<typeof DayMap>[0]['handoffs']>;
  frame: { left: number; top: number; width: number; height: number };
  regionLabel: string;
  regions: { id: RegionSelection; label: string }[];
  selectedRegion: RegionSelection;
  regionOpen: boolean;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  onToggleRegion: () => void;
  onSelectRegion: (id: RegionSelection) => void;
  token: string | null;
}) {
  return (
    <motion.section
      className="absolute overflow-visible rounded-[20px] bg-white"
      initial={false}
      animate={frame}
      transition={motionOn ? { duration: 0.45, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <div className="absolute inset-0 overflow-clip rounded-[20px]">
        {snapshot ? (
          <PlanHistoryMap
            previous={previousPlan}
            historyOpen={historyOpen}
            historySelection={historySelection}
            snapshot={snapshot}
            selectedEngineerId={selectedEngineerId}
            selectedRequestId={selectedRequestId}
            progressByEngineer={progressByEngineer}
            completedByEngineer={completedByEngineer}
            handoffs={handoffs}
            onSelectRequest={onSelectRequest}
          />
        ) : (
          <motion.img
            alt="Карта Москвы"
            src={FIGMA_ASSETS.map}
            className="absolute inset-0 size-full max-w-none object-cover"
            initial={motionOn ? { opacity: 0.72, scale: 1.012 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={fadeSoft}
          />
        )}
      </div>
      <WeatherBadge token={token} />
      <RegionSwitch
        open={regionOpen}
        label={regionLabel}
        regions={regions}
        selectedId={selectedRegion}
        motionOn={motionOn}
        onToggle={onToggleRegion}
        onSelect={onSelectRegion}
      />
    </motion.section>
  );
}

/** Renders the selected engineer's horizontally draggable route timeline. */
export function RouteCard({
  engineer,
  progress,
  motionOn,
  onSelectRequest,
  handoffs,
  engineerNames,
}: {
  engineer: EngineerCard;
  progress: LiveRouteProgress | null;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  handoffs: readonly HandoffView[];
  engineerNames: ReadonlyMap<string, string>;
}) {
  // Named apart from the drag delta below, which is also called `dx`.
  const { dx: spareX, dy: spareY } = useArtboardStretch();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const skipClick = useRef(false);
  const liveMarker = routeProgressMarker(engineer.stops, progress);
  const drag = useRef<{
    kind: 'panel' | 'thumb';
    startX: number;
    startScroll: number;
    scale: number;
    overflow: number;
    track: number;
    thumbWidth: number;
  } | null>(null);
  const [thumb, setThumb] = useState({ left: 174, width: 321, visible: false });
  const [grabbing, setGrabbing] = useState(false);
  const [selectedHandoff, setSelectedHandoff] = useState<HandoffView | null>(null);

  const updateThumb = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0 || engineer.stops.length === 0) {
      setThumb({ left: 174, width: 321, visible: false });
      return;
    }
    const track = 691;
    const width = Math.max(96, Math.round((el.clientWidth / el.scrollWidth) * track));
    const left = 30 + (el.scrollLeft / overflow) * (track - width);
    setThumb({ left, width, visible: true });
  }, [engineer.stops.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const refresh = () => {
      el.style.overflowX = 'hidden';
      void el.offsetWidth;
      el.style.overflowX = 'auto';
      updateThumb();
    };
    refresh();
    const frame = window.requestAnimationFrame(refresh);
    const later = window.setTimeout(refresh, 420);
    el.addEventListener('scroll', updateThumb, { passive: true });
    const observer = new ResizeObserver(updateThumb);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(later);
      el.removeEventListener('scroll', updateThumb);
      observer.disconnect();
    };
  }, [updateThumb]);

  const beginDrag = (kind: 'panel' | 'thumb', clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return false;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) return false;
    const scale = el.getBoundingClientRect().width / el.offsetWidth || 1;
    skipClick.current = false;
    drag.current = {
      kind,
      startX: clientX,
      startScroll: el.scrollLeft,
      scale,
      overflow,
      track: 691,
      thumbWidth: thumb.width,
    };
    setGrabbing(true);
    return true;
  };

  useEffect(() => {
    if (!grabbing) return;
    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      const el = scrollerRef.current;
      if (!state || !el) return;
      const dx = (event.clientX - state.startX) / state.scale;
      if (Math.abs(dx) > 4) skipClick.current = true;
      if (state.kind === 'thumb') {
        const travel = state.track - state.thumbWidth;
        el.scrollLeft = state.startScroll + (dx / Math.max(1, travel)) * state.overflow;
      } else {
        el.scrollLeft = state.startScroll - dx;
      }
    };
    const onUp = () => {
      drag.current = null;
      setGrabbing(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [grabbing]);

  return (
    <motion.section
      className={`absolute h-[279px] overflow-hidden rounded-[20px] bg-white ${
        grabbing ? 'cursor-grabbing select-none' : thumb.visible ? 'cursor-grab' : ''
      }`}
      style={{
        left: ROUTE_CARD_LEFT,
        top: ROUTE_CARD_TOP + spareY,
        width: ROUTE_CARD_WIDTH + spareX,
      }}
      initial={motionOn ? { opacity: 0, y: 20 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={motionOn ? { opacity: 0, y: 28 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('[data-route-thumb]')) return;
        if (beginDrag('panel', event.clientX)) event.preventDefault();
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={engineer.id}
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          exit={motionOn ? { opacity: 0, y: -8 } : undefined}
          transition={fadeSoft}
          className="absolute inset-0"
        >
          <FigmaText
            className="figma-text-keep-descenders figma-nowrap pointer-events-none absolute left-[30px] right-[30px] top-[30px] overflow-hidden font-bold text-[28px] tracking-[-0.476px] text-ellipsis text-figma-ink"
            title={`Маршрут ${engineer.name}`}
          >
            Маршрут {truncateEnd(engineer.name, 22)}
          </FigmaText>
          <FigmaText className="figma-text-keep-descenders figma-nowrap pointer-events-none absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
            {engineer.routeUpdated}
          </FigmaText>
          <div
            ref={scrollerRef}
            className="route-scroll absolute inset-x-0 top-[110px] bottom-[22px] overflow-x-auto"
          >
            <div
              className="relative px-[30px]"
              style={{ width: 60 + engineer.stops.length * ROUTE_STOP_WIDTH }}
            >
              <div
                className="absolute top-[19px] h-[3px] bg-figma-ink"
                style={{
                  left: ROUTE_LINE_LEFT,
                  width: Math.max(0, (engineer.stops.length - 1) * ROUTE_STOP_WIDTH),
                }}
              />
              {liveMarker ? (
                <div
                  className="absolute top-[19px] h-[3px] bg-figma-bee"
                  style={{
                    left: ROUTE_LINE_LEFT + liveMarker.fromIndex * ROUTE_STOP_WIDTH,
                    width: (liveMarker.toIndex - liveMarker.fromIndex) * ROUTE_STOP_WIDTH,
                  }}
                />
              ) : null}
              <div className="flex">
                {engineer.stops.map((stop, index) => (
                  <RouteStopTopic
                    key={`${engineer.id}-${stop.requestId ?? stop.place}-${stop.time}`}
                    stop={stop}
                    index={index}
                    motionOn={motionOn}
                    onSelectRequest={(requestId) => {
                      if (skipClick.current) return;
                      onSelectRequest(requestId);
                    }}
                    onSelectHandoff={(handoffId) => {
                      if (skipClick.current) return;
                      setSelectedHandoff(handoffs.find((item) => item.id === handoffId) ?? null);
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
      {selectedHandoff ? (
        <div className="absolute left-[30px] right-[30px] top-[158px] z-20 rounded-[16px] border-2 border-[#2563EB] bg-white px-[16px] py-[10px] text-[14px] text-figma-ink shadow-lg">
          <div className="flex items-center justify-between gap-3">
            <strong>Передача оборудования</strong>
            <button
              type="button"
              onClick={() => setSelectedHandoff(null)}
              aria-label="Закрыть детали передачи"
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-figma-muted">
            {engineerNames.get(selectedHandoff.donorEngineerId) ?? selectedHandoff.donorEngineerId}
            {' → '}
            {engineerNames.get(selectedHandoff.receiverEngineerId) ??
              selectedHandoff.receiverEngineerId}
          </p>
          <p className="mt-1 text-figma-muted">{handoffItemsLabel(selectedHandoff.items)}</p>
        </div>
      ) : null}
    </motion.section>
  );
}

function RouteStopTopic({
  stop,
  index,
  motionOn,
  onSelectRequest,
  onSelectHandoff,
}: {
  stop: RouteStop;
  index: number;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  onSelectHandoff: (handoffId: string) => void;
}) {
  const clickable = Boolean(stop.requestId || stop.handoffId);
  const handoff = stop.kind === 'handoff';
  return (
    <motion.button
      type="button"
      disabled={!clickable}
      onClick={() => {
        if (stop.handoffId) onSelectHandoff(stop.handoffId);
        else if (stop.requestId) onSelectRequest(stop.requestId);
      }}
      className={`relative shrink-0 text-left ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ width: ROUTE_STOP_WIDTH }}
      initial={motionOn ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...fadeSoft, delay: index * 0.04 }}
    >
      <span
        className={`absolute top-[10px] rounded-full ${handoff ? 'bg-[#2563EB]' : stop.failed || stop.status === 'отменено' ? 'bg-figma-cancel' : stop.active ? 'bg-figma-bee ring-4 ring-figma-ink' : stop.completed ? 'bg-figma-done' : 'bg-figma-ink'}`}
        style={{ left: ROUTE_DOT_LEFT, width: ROUTE_DOT_SIZE, height: ROUTE_DOT_SIZE }}
      />
      <FigmaText className="figma-nowrap absolute left-0 top-[46px] w-[240px] text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
        {stop.time}
      </FigmaText>
      <p className="absolute left-0 top-[78px] h-[44px] w-[240px] overflow-hidden text-center font-semibold text-[18px] leading-[22px] tracking-[-0.306px] text-figma-muted line-clamp-2">
        {stop.place}
      </p>
      <FigmaText
        className={`absolute left-0 top-[126px] w-[240px] text-center font-semibold text-[16px] tracking-[-0.272px] ${
          stop.failed || stop.status === 'отменено'
            ? 'text-figma-cancel uppercase'
            : isCompletedStop(stop.status)
              ? 'text-figma-done'
              : 'text-figma-hint'
        }`}
      >
        {handoff ? 'ПЕРЕДАЧА' : routeStopStatusLabel(stop.status)}
      </FigmaText>
    </motion.button>
  );
}

function handoffItemsLabel(items: HandoffView['items']): string {
  const labels = [
    items.router ? `роутер ×${items.router}` : null,
    items.set_top_box ? `ТВ-приставка ×${items.set_top_box}` : null,
    items.smart_speaker ? `умная колонка ×${items.smart_speaker}` : null,
  ].filter((item): item is string => item !== null);
  return labels.join(', ') || 'Оборудование не указано';
}
