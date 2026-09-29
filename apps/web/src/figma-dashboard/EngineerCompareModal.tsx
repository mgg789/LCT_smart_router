import { motion } from 'framer-motion';
import type { DashboardSnapshot, PlanLegView, PlanRouteView, PlanStopView } from '../api/types';
import { t } from '../i18n';
import { formatClock } from '../lib/time';
import { FIGMA_ASSETS } from './assets';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';
import { TintIcon } from './TintIcon';
import { TRANSPORT_ICONS } from './transport';

const NAME_W = 196;
const ROW_H = 68;
const HEADER_H = 44;
const HALF_HOUR = 30 * 60;
const PX_PER_HALF = 132;
const BLOCK_H = 36;

type BlockKind = 'job' | 'done' | 'cancelled' | 'lunch' | 'road' | 'handoff' | 'other';

interface GanttBlock {
  readonly start: number;
  readonly end: number;
  readonly kind: BlockKind;
  readonly label: string;
}

interface GanttRow {
  readonly id: string;
  readonly first: string;
  readonly rest: string;
  readonly shiftStart: number;
  readonly shiftEnd: number;
  readonly transportIcon: string | null;
  readonly blocks: readonly GanttBlock[];
}

/** First token on the first line, the rest on the second. A one-word name still keeps the second line. */
function splitName(name: string): readonly [string, string] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ['', ''];
  if (parts.length === 1) return [parts[0] ?? '', ''];
  return [parts[0] ?? '', parts.slice(1).join(' ')];
}

function overlapSec(start: number, end: number, otherStart: number, otherEnd: number): number {
  return Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
}

function jobTone(
  lifecycle: string | undefined,
  assignment: string | undefined,
): 'job' | 'done' | 'cancelled' {
  if (lifecycle === 'cancelled') return 'cancelled';
  if (lifecycle === 'completed' || assignment === 'done') return 'done';
  return 'job';
}

function stopBlock(
  stop: PlanStopView,
  titles: ReadonlyMap<string, string>,
  requests: ReadonlyMap<string, { lifecycle: string; assignmentState: string }>,
): GanttBlock | null {
  if (stop.endAt <= stop.startAt) return null;
  if (stop.kind === 'start' || stop.kind === 'wait') return null;
  if (stop.kind === 'job') {
    const request = stop.requestId ? requests.get(stop.requestId) : undefined;
    return {
      start: stop.startAt,
      end: stop.endAt,
      kind: jobTone(request?.lifecycle, request?.assignmentState),
      label:
        (stop.requestId && titles.get(stop.requestId)) || t('figma-dashboard.EngineerCompare.job'),
    };
  }
  if (stop.kind === 'lunch') {
    return {
      start: stop.startAt,
      end: stop.endAt,
      kind: 'lunch',
      label: t('figma-dashboard.EngineerCompare.lunch'),
    };
  }
  if (stop.kind === 'handoff' || stop.kind === 'delivery') {
    return {
      start: stop.startAt,
      end: stop.endAt,
      kind: 'handoff',
      label: t('figma-dashboard.EngineerCompare.handoff'),
    };
  }
  return {
    start: stop.startAt,
    end: stop.endAt,
    kind: 'other',
    label: t('figma-dashboard.EngineerCompare.depot'),
  };
}

function roadBlock(leg: PlanLegView, occupied: readonly GanttBlock[]): GanttBlock | null {
  if (leg.arrivalAt <= leg.departureAt || leg.travelTimeSec <= 0) return null;
  const span = leg.arrivalAt - leg.departureAt;
  const covered = occupied.reduce(
    (sum, block) => sum + overlapSec(leg.departureAt, leg.arrivalAt, block.start, block.end),
    0,
  );
  if (covered > span * 0.6) return null;
  return {
    start: leg.departureAt,
    end: leg.arrivalAt,
    kind: 'road',
    label: t('figma-dashboard.EngineerCompare.road'),
  };
}

function blocksOf(
  route: PlanRouteView | undefined,
  titles: ReadonlyMap<string, string>,
  requests: ReadonlyMap<string, { lifecycle: string; assignmentState: string }>,
): GanttBlock[] {
  if (!route) return [];
  const occupied = route.stops
    .map((stop) => stopBlock(stop, titles, requests))
    .filter((block): block is GanttBlock => block !== null);
  const roads = route.legs
    .map((leg) => roadBlock(leg, occupied))
    .filter((block): block is GanttBlock => block !== null);
  return [...occupied, ...roads].sort((left, right) => left.start - right.start);
}

/** One row per engineer who has a shift today, in roster order. */
export function compareRows(snapshot: DashboardSnapshot | null): {
  readonly rows: readonly GanttRow[];
  readonly origin: number;
  readonly end: number;
} {
  if (!snapshot) return { rows: [], origin: 0, end: 0 };
  const titles = new Map(
    snapshot.requests.map((request) => [
      request.id,
      request.workTypeTitle?.trim() || t('figma-dashboard.EngineerCompare.job'),
    ]),
  );
  const routes = new Map(
    (snapshot.plan.plan?.routes ?? []).map((route) => [route.engineerId, route]),
  );
  const requests = new Map(
    snapshot.requests.map((request) => [
      request.id,
      { lifecycle: request.lifecycle, assignmentState: request.assignmentState },
    ]),
  );
  const rows: GanttRow[] = snapshot.engineers
    .filter((engineer) => engineer.day)
    .slice()
    .sort((left, right) => left.inputOrder - right.inputOrder)
    .map((engineer) => {
      const day = engineer.day;
      const [first, rest] = splitName(engineer.displayName);
      return {
        id: engineer.id,
        first,
        rest,
        shiftStart: day?.shiftStartAt ?? 0,
        shiftEnd: day?.shiftEndAt ?? 0,
        transportIcon: TRANSPORT_ICONS[engineer.transportType] ?? null,
        blocks: blocksOf(routes.get(engineer.id), titles, requests),
      };
    });
  const marks = rows.flatMap((row) => [
    row.shiftStart,
    row.shiftEnd,
    ...row.blocks.flatMap((block) => [block.start, block.end]),
  ]);
  if (marks.length === 0) return { rows, origin: 0, end: 0 };
  const origin = Math.floor(Math.min(...marks) / HALF_HOUR) * HALF_HOUR;
  const end = Math.ceil(Math.max(...marks) / HALF_HOUR) * HALF_HOUR;
  return { rows, origin, end: Math.max(end, origin + HALF_HOUR) };
}

function blockFace(kind: BlockKind): string {
  if (kind === 'job') return 'bg-figma-bee text-figma-ink';
  if (kind === 'done') return 'bg-figma-done text-white';
  if (kind === 'cancelled') return 'bg-figma-cancel text-white';
  if (kind === 'handoff') return 'bg-[#2f6fed] text-white';
  return 'bg-[#eceef1] text-figma-ink';
}

function xOf(at: number, origin: number): number {
  return ((at - origin) / HALF_HOUR) * PX_PER_HALF;
}

/**
 * Shift Gantt for every engineer on the day. The name column stays put while the
 * timeline scrolls sideways; the clock stays put while the list scrolls down.
 */
export function EngineerCompareModal({
  open,
  motionOn,
  snapshot,
  onClose,
}: {
  open: boolean;
  motionOn: boolean;
  snapshot: DashboardSnapshot | null;
  onClose: () => void;
}) {
  const { rows, origin, end } = compareRows(open ? snapshot : null);
  const ticks: number[] = [];
  for (let at = origin; at <= end; at += HALF_HOUR) ticks.push(at);
  const track = Math.max(PX_PER_HALF, xOf(end, origin));
  const now = snapshot?.nowAt;
  const nowX = now != null && now >= origin && now <= end ? xOf(now, origin) : null;

  return (
    <ModalLayer open={open} motionOn={motionOn} zClass="z-[120]">
      <ModalScrim label={t('figma-dashboard.SettingsModal.a7a4033657')} onClose={onClose} />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="engineer-compare-title"
        className="relative flex flex-col overflow-hidden rounded-[20px] bg-white"
        style={{ width: 'calc(100% - 72px)', height: 'calc(100% - 56px)' }}
        initial={motionOn ? { opacity: 0, y: 16, scale: 0.98 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={motionOn ? { opacity: 0, y: 10, scale: 0.98 } : undefined}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center justify-between px-[28px] pt-[22px] pb-[12px]">
          <h2
            id="engineer-compare-title"
            className="font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
          >
            {t('figma-dashboard.EngineerCompare.title')}
          </h2>
          <button
            type="button"
            aria-label={t('figma-dashboard.SettingsModal.a7a4033657')}
            onClick={onClose}
            className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110"
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
            </span>
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="px-[28px] font-semibold text-[18px] text-figma-muted">
            {t('figma-dashboard.EngineerCompare.empty')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto pb-[16px]">
            <div style={{ width: NAME_W + track + 48 }}>
              <div className="sticky top-0 z-20 flex bg-white" style={{ height: HEADER_H }}>
                <div
                  className="sticky left-0 z-30 shrink-0 border-r border-[#e3e3e4] bg-white"
                  style={{ width: NAME_W, height: HEADER_H }}
                />
                <div className="relative" style={{ width: track, height: HEADER_H }}>
                  {ticks.map((at) => (
                    <span
                      key={at}
                      className="absolute top-[14px] font-semibold text-[13px] text-[#727478]"
                      style={{ left: xOf(at, origin) }}
                    >
                      {formatClock(at)}
                    </span>
                  ))}
                  {nowX != null ? (
                    <span
                      aria-hidden
                      className="absolute top-0 bottom-0 z-[4] w-[2px] bg-figma-done"
                      style={{ left: nowX }}
                    />
                  ) : null}
                </div>
              </div>
              {rows.map((row) => (
                <div key={row.id} className="flex" style={{ height: ROW_H }}>
                  <div
                    className="sticky left-0 z-20 flex shrink-0 flex-col justify-center border-r border-[#e3e3e4] bg-white pr-[12px] pl-[16px]"
                    style={{
                      width: NAME_W,
                      height: ROW_H,
                      borderBottom: '1px solid #e3e3e4',
                    }}
                  >
                    <span className="truncate font-murs text-[16px] leading-[20px] text-figma-ink">
                      {row.first}
                    </span>
                    <span className="h-[20px] truncate font-semibold text-[15px] leading-[20px] text-[#727478]">
                      {row.rest}
                    </span>
                  </div>
                  <div
                    className="relative"
                    style={{ width: track, height: ROW_H, borderBottom: '1px solid #e3e3e4' }}
                  >
                    {ticks.map((at) => (
                      <span
                        key={at}
                        aria-hidden
                        className="absolute top-0 bottom-0 border-l border-dashed border-[#d5d6d8]"
                        style={{ left: xOf(at, origin) }}
                      />
                    ))}
                    <span
                      aria-hidden
                      className="absolute z-[2] w-[3px] rounded-full bg-figma-ink"
                      style={{
                        left: xOf(row.shiftStart, origin),
                        top: 10,
                        height: ROW_H - 20,
                      }}
                    />
                    <span
                      aria-hidden
                      className="absolute z-[2] w-[3px] rounded-full bg-figma-ink"
                      style={{
                        left: xOf(row.shiftEnd, origin),
                        top: 10,
                        height: ROW_H - 20,
                      }}
                    />
                    {nowX != null ? (
                      <span
                        aria-hidden
                        className="absolute top-0 bottom-0 z-[4] w-[2px] bg-figma-done"
                        style={{ left: nowX }}
                      />
                    ) : null}
                    {row.blocks.map((block) => {
                      const shiftGap = 8;
                      const startBar = xOf(row.shiftStart, origin);
                      const endBar = xOf(row.shiftEnd, origin);
                      let left = xOf(block.start, origin);
                      let right = xOf(block.end, origin);
                      if (left < startBar + 3 + shiftGap && right > startBar) {
                        left = Math.max(left, startBar + 3 + shiftGap);
                      }
                      if (right > endBar - shiftGap && left < endBar) {
                        right = Math.min(right, endBar - shiftGap);
                      }
                      const width = Math.max(6, right - left);
                      const icon =
                        block.kind === 'road'
                          ? row.transportIcon
                          : block.kind === 'handoff'
                            ? FIGMA_ASSETS.router
                            : null;
                      const iconColor = block.kind === 'handoff' ? '#ffffff' : '#272930';
                      return (
                        <span
                          key={`${block.kind}-${block.start}-${block.label}`}
                          className={`absolute z-[3] flex items-center overflow-hidden font-semibold ${blockFace(block.kind)}`}
                          style={{
                            left,
                            width,
                            top: (ROW_H - BLOCK_H) / 2,
                            height: BLOCK_H,
                            borderRadius: 10,
                            paddingInline: width > 36 ? 8 : 0,
                            gap: 6,
                            fontSize: 14,
                          }}
                          title={block.label}
                        >
                          {icon && width > 28 ? (
                            <TintIcon src={icon} color={iconColor} size={16} />
                          ) : null}
                          {width > 48 ? <span className="truncate">{block.label}</span> : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </ModalLayer>
  );
}
