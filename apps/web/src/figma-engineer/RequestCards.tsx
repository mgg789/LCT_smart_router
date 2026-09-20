import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { skillLabel } from '../lib/reasons';
import { ENGINEER_ASSETS } from './assets';
import { formatMinutesRu, formatPlanTime, formatPlanWindow } from './engineerClock';
import type { EngineerJobItem, EngineerLunchItem } from './engineerDay';
import { eu } from './engineerScale';

const tap = { duration: 0.16 };

/**
 * Three Figma card types for the engineer day list: outlined nearest job,
 * compact lunch row, and a regular stop with a window chip.
 */
export function EngineerListCard({
  item,
  motionOn,
  delay,
  latePending,
  startPending,
  onOpen,
  onRoute,
  onLate,
  onStart,
  actions,
}: {
  item: EngineerJobItem | EngineerLunchItem;
  motionOn: boolean;
  delay: number;
  latePending?: boolean;
  startPending?: boolean;
  onOpen?: () => void;
  onRoute?: () => void;
  onLate?: () => void;
  onStart?: () => void;
  actions?: ReactNode;
}) {
  return (
    <motion.article
      initial={motionOn ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay } : { duration: 0 }}
    >
      {item.kind === 'lunch' ? (
        <LunchCard item={item} />
      ) : item.variant === 'upcoming' ? (
        <UpcomingCard
          item={item}
          latePending={latePending === true}
          startPending={startPending === true}
          onOpen={onOpen}
          onRoute={onRoute}
          onLate={onLate}
          onStart={onStart}
          actions={actions}
        />
      ) : (
        <RegularCard item={item} onOpen={onOpen} onRoute={onRoute} />
      )}
    </motion.article>
  );
}

function stopInside(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function UpcomingCard({
  item,
  latePending,
  startPending,
  onOpen,
  onRoute,
  onLate,
  onStart,
  actions,
}: {
  item: EngineerJobItem;
  latePending: boolean;
  startPending: boolean;
  onOpen?: () => void;
  onRoute?: () => void;
  onLate?: () => void;
  onStart?: () => void;
  actions?: ReactNode;
}) {
  const service = item.request.workTypeTitle ?? skillLabel(item.request.requiredSkill);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, input, select, textarea, form')) return;
        onOpen?.();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen?.();
        }
      }}
      className="overflow-hidden border-solid border-figma-bee bg-white text-left"
      style={{
        borderRadius: eu(20),
        borderWidth: eu(3),
        padding: `${eu(22)} ${eu(24)} ${eu(24)}`,
      }}
    >
      <div className="flex items-start justify-between" style={{ gap: eu(16) }}>
        <div className="min-w-0 flex-1">
          <p
            className="font-murs leading-none tracking-[-0.02em] text-figma-ink"
            style={{ fontSize: eu(40) }}
          >
            {formatPlanTime(item.stop.startAt)}
          </p>
          <p
            className="break-words font-semibold tracking-[-0.02em] text-figma-dim"
            style={{ marginTop: eu(14), fontSize: eu(24) }}
          >
            {item.request.addressText}
          </p>
          <div
            className="flex flex-wrap items-center font-medium tracking-[-0.02em] text-figma-muted"
            style={{ marginTop: eu(12), columnGap: eu(10), rowGap: eu(4), fontSize: eu(20) }}
          >
            <span>{service}</span>
            <FigmaIcon
              src={ENGINEER_ASSETS.dot}
              alt=""
              width={4}
              height={4}
              style={{ width: eu(4), height: eu(4) }}
            />
            <span>{formatMinutesRu(item.request.serviceDurationSec)}</span>
          </div>
        </div>
        <MapThumb onRoute={onRoute} />
      </div>
      {actions !== undefined ? (
        actions
      ) : (
        <div className="flex" style={{ marginTop: eu(20), gap: eu(16) }}>
          <motion.button
            type="button"
            disabled={latePending}
            onClick={(event) => {
              stopInside(event);
              onLate?.();
            }}
            whileTap={{ scale: 0.98 }}
            transition={tap}
            className="flex flex-1 items-center justify-center whitespace-nowrap bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-60"
            style={{
              height: eu(76),
              borderRadius: eu(20),
              paddingInline: eu(16),
              fontSize: eu(28),
            }}
          >
            {latePending ? 'Отмечено' : 'Опаздываю'}
          </motion.button>
          <motion.button
            type="button"
            disabled={startPending}
            onClick={(event) => {
              stopInside(event);
              onStart?.();
            }}
            whileTap={{ scale: 0.98 }}
            transition={tap}
            className="flex flex-1 items-center justify-center whitespace-nowrap bg-figma-ink font-semibold tracking-[-0.03em] text-white disabled:opacity-60"
            style={{
              height: eu(76),
              borderRadius: eu(20),
              paddingInline: eu(16),
              fontSize: eu(28),
            }}
          >
            Приступить
          </motion.button>
        </div>
      )}
    </div>
  );
}

function RegularCard({
  item,
  onOpen,
  onRoute,
}: {
  item: EngineerJobItem;
  onOpen?: () => void;
  onRoute?: () => void;
}) {
  const service = item.request.workTypeTitle ?? skillLabel(item.request.requiredSkill);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen?.();
        }
      }}
      className="flex w-full items-start justify-between overflow-hidden bg-white text-left"
      style={{
        gap: eu(16),
        borderRadius: eu(20),
        padding: `${eu(25)} ${eu(30)}`,
      }}
    >
      <div className="min-w-0 flex-1">
        <p
          className="font-murs leading-none tracking-[-0.02em] text-figma-ink"
          style={{ fontSize: eu(40) }}
        >
          {formatPlanTime(item.stop.startAt)}
        </p>
        <p
          className="break-words font-semibold tracking-[-0.02em] text-figma-dim"
          style={{ marginTop: eu(14), fontSize: eu(24) }}
        >
          {item.request.addressText}
        </p>
        <p
          className="font-medium tracking-[-0.02em] text-figma-muted"
          style={{ marginTop: eu(12), fontSize: eu(20) }}
        >
          {service}
        </p>
        <span
          className="inline-flex items-center rounded-full bg-figma-ink font-semibold text-white"
          style={{
            marginTop: eu(16),
            padding: `${eu(14)} ${eu(24)}`,
            fontSize: eu(22),
          }}
        >
          {formatPlanWindow(item.request.windowStartAt, item.request.windowEndAt)}
        </span>
      </div>
      <MapThumb onRoute={onRoute} />
    </div>
  );
}

function LunchCard({ item }: { item: EngineerLunchItem }) {
  return (
    <div
      className="flex items-center bg-white"
      style={{ height: eu(88), gap: eu(20), borderRadius: eu(20), paddingInline: eu(27) }}
    >
      <FigmaIcon
        src={ENGINEER_ASSETS.lunch}
        alt=""
        width={32}
        height={32}
        style={{ width: eu(32), height: eu(32) }}
      />
      <p className="font-murs tracking-[-0.03em] text-figma-ink" style={{ fontSize: eu(28) }}>
        Обед
      </p>
      <p
        className="font-semibold tracking-[-0.03em] text-figma-dim"
        style={{ fontSize: eu(24), position: 'relative', top: 2 }}
      >
        {formatPlanWindow(item.startAt, item.endAt)}
      </p>
    </div>
  );
}

function MapThumb({ onRoute }: { onRoute?: () => void }) {
  return (
    <button
      type="button"
      aria-label="Построить маршрут"
      onClick={(event) => {
        stopInside(event);
        onRoute?.();
      }}
      className="relative shrink-0 overflow-hidden bg-black"
      style={{ width: eu(170), height: eu(164), borderRadius: eu(20) }}
    >
      <img
        alt=""
        src={FIGMA_ASSETS.map}
        className="absolute inset-0 size-full max-w-none object-cover"
      />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: eu(40), height: eu(40) }}
      >
        <FigmaIcon
          src={ENGINEER_ASSETS.pin}
          alt=""
          width={40}
          height={40}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </button>
  );
}
