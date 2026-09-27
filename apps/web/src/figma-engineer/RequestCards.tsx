import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { WorkTypeLabel } from '../components/WorkTypeLabel';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { t } from '../i18n';
import { skillLabel } from '../lib/reasons';
import { ENGINEER_ASSETS } from './assets';
import { formatMinutesRu, formatPlanTime, formatPlanWindow } from './engineerClock';
import {
  type EngineerHandoffItem,
  type EngineerJobItem,
  type EngineerLogisticsItem,
  type EngineerLunchItem,
  visibleServiceDurationSec,
} from './engineerDay';
import { engineerMapsUrl } from './engineerRoute';
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
  handoffAction,
  selected,
  logisticsAction,
}: {
  item: EngineerJobItem | EngineerLunchItem | EngineerHandoffItem | EngineerLogisticsItem;
  motionOn: boolean;
  delay: number;
  latePending?: boolean;
  startPending?: boolean;
  onOpen?: () => void;
  onRoute?: () => void;
  onLate?: () => void;
  onStart?: () => void;
  actions?: ReactNode;
  handoffAction?: () => void;
  /** Outlined because it is the one being read, not because it is next. */
  selected?: boolean;
  logisticsAction?: () => void;
}) {
  return (
    <motion.article
      initial={motionOn ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1], delay } : { duration: 0 }}
    >
      {item.kind === 'lunch' ? (
        <LunchCard item={item} />
      ) : item.kind === 'handoff' ? (
        <HandoffCard item={item} onConfirm={handoffAction} />
      ) : item.kind === 'logistics' ? (
        <LogisticsCard item={item} onConfirm={logisticsAction} />
      ) : item.variant === 'upcoming' ? (
        <UpcomingCard
          item={item}
          selected={selected === true}
          latePending={latePending === true}
          startPending={startPending === true}
          onOpen={onOpen}
          onRoute={onRoute}
          onLate={onLate}
          onStart={onStart}
          actions={actions}
        />
      ) : (
        <RegularCard item={item} onOpen={onOpen} onRoute={onRoute} selected={selected === true} />
      )}
    </motion.article>
  );
}

function LogisticsCard({
  item,
  onConfirm,
}: {
  item: EngineerLogisticsItem;
  onConfirm?: () => void;
}) {
  const entry = item.logistics;
  const office = entry.kind === 'office_pickup';
  const equipment = {
    router: t('figma-engineer.RequestCards.4a65bf9c4b'),
    set_top_box: t('figma-engineer.RequestCards.140d6d4877'),
    smart_speaker: t('figma-engineer.RequestCards.cd9e2a8ef6'),
  }[entry.equipmentType];
  return (
    <div className="rounded-[20px] border-2 border-figma-bee bg-white p-6 text-figma-ink">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-murs text-xl">
          {office
            ? t('figma-engineer.RequestCards.238a113959')
            : t('figma-engineer.RequestCards.abbe1ea907')}
        </h3>
        <span className="font-semibold">{formatPlanTime(item.stop.startAt)}</span>
      </div>
      <p className="mt-3 font-medium">
        {equipment}
        {t('figma-engineer.RequestCards.efaf48a440')}
      </p>
      <p className="mt-2 text-figma-muted">
        {office
          ? t('figma-engineer.RequestCards.350eb49b02')
          : t('figma-engineer.RequestCards.33de542a22')}
      </p>
      <p className="mt-2 text-figma-muted">
        {entry.state === 'completed'
          ? t('figma-engineer.RequestCards.c045c25ac4')
          : entry.state === 'cancelled'
            ? t('figma-engineer.RequestCards.23a2a9bfcf')
            : t('figma-engineer.RequestCards.80b3e93473', { value0: entry.requestId.slice(0, 8) })}
      </p>
      {entry.state === 'assigned' ? (
        <a
          href={engineerMapsUrl({
            lat: entry.location.lat,
            lon: entry.location.lon,
            addressText: '',
          })}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block font-semibold underline"
        >
          {t('figma-engineer.RequestCards.5f428defda')}
          {office
            ? t('figma-engineer.RequestCards.3029e27d7a')
            : t('figma-engineer.RequestCards.58b97f7566')}
        </a>
      ) : null}
      {entry.state === 'assigned' ? (
        <button
          type="button"
          disabled={!entry.action?.enabled || !onConfirm}
          onClick={onConfirm}
          className="mt-4 w-full rounded-2xl bg-figma-bee px-4 py-3 font-semibold disabled:opacity-50"
        >
          {office
            ? t('figma-engineer.RequestCards.7e0d88c818')
            : t('figma-engineer.RequestCards.8ae4b5099a')}
        </button>
      ) : null}
    </div>
  );
}

function HandoffCard({ item, onConfirm }: { item: EngineerHandoffItem; onConfirm?: () => void }) {
  const ownConfirmed =
    item.role === 'donor'
      ? item.handoff.donorConfirmedAt !== null
      : item.handoff.receiverConfirmedAt !== null;
  const complete = item.handoff.completedAt !== null;
  const items = [
    item.handoff.items.router
      ? t('figma-engineer.RequestCards.6b2c9456a3', { value0: item.handoff.items.router })
      : null,
    item.handoff.items.set_top_box
      ? t('figma-engineer.RequestCards.ec5d45a6b4', { value0: item.handoff.items.set_top_box })
      : null,
    item.handoff.items.smart_speaker
      ? t('figma-engineer.RequestCards.b1d7e933cd', { value0: item.handoff.items.smart_speaker })
      : null,
  ].filter((value): value is string => value !== null);
  return (
    <div
      className="border-2 border-[#2563EB] bg-white"
      style={{ borderRadius: eu(20), padding: `${eu(20)} ${eu(24)}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-murs text-figma-ink" style={{ fontSize: eu(28) }}>
            {t('figma-engineer.RequestCards.31f207a99a')}
          </p>
          <p
            className="font-medium text-figma-muted"
            style={{ marginTop: eu(8), fontSize: eu(18) }}
          >
            {item.role === 'donor'
              ? t('figma-engineer.RequestCards.1dc58eaa3a')
              : t('figma-engineer.RequestCards.9659ad64c2')}{' '}
            · {items.join(', ')}
          </p>
        </div>
        <span className="font-murs text-[#2563EB]" style={{ fontSize: eu(28) }}>
          {formatPlanTime(item.stop.startAt)}
        </span>
      </div>
      <p className="font-medium text-figma-muted" style={{ marginTop: eu(10), fontSize: eu(18) }}>
        {complete
          ? t('figma-engineer.RequestCards.170fe4bd47')
          : ownConfirmed
            ? t('figma-engineer.RequestCards.adf983000e')
            : t('figma-engineer.RequestCards.130c491174')}
      </p>
      {!complete && !ownConfirmed ? (
        <button
          type="button"
          disabled={!onConfirm}
          onClick={onConfirm}
          className="w-full bg-[#2563EB] font-semibold text-white disabled:opacity-50"
          style={{ marginTop: eu(14), height: eu(64), borderRadius: eu(16), fontSize: eu(20) }}
        >
          {item.role === 'donor'
            ? t('figma-engineer.RequestCards.1dc58eaa3a')
            : t('figma-engineer.RequestCards.9659ad64c2')}
        </button>
      ) : null}
    </div>
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
  selected,
}: {
  item: EngineerJobItem;
  latePending: boolean;
  startPending: boolean;
  selected: boolean;
  onOpen?: () => void;
  onRoute?: () => void;
  onLate?: () => void;
  onStart?: () => void;
  actions?: ReactNode;
}) {
  const service = item.request.workTypeTitle ?? skillLabel(item.request.requiredSkill);
  return (
    // biome-ignore lint/a11y/useSemanticElements: The keyboard-accessible card contains independent action buttons, which cannot be nested in a button.
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
      className={`overflow-hidden border-solid bg-white text-left ${
        selected ? 'border-figma-bee' : 'border-transparent'
      }`}
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
            <span>
              <WorkTypeLabel category={item.request.workCategory}>{service}</WorkTypeLabel>
            </span>
            <FigmaIcon
              src={ENGINEER_ASSETS.dot}
              alt=""
              width={4}
              height={4}
              style={{ width: eu(4), height: eu(4) }}
            />
            <span>{formatMinutesRu(visibleServiceDurationSec(item.request))}</span>
          </div>
          {actions === undefined ? (
            <span
              className="inline-flex rounded-full bg-figma-ink font-semibold text-white"
              style={{ marginTop: eu(16), padding: `${eu(7)} ${eu(30)}`, fontSize: eu(22) }}
            >
              {formatPlanWindow(item.request.windowStartAt, item.request.windowEndAt)}
            </span>
          ) : null}
        </div>
        <MapThumb onRoute={onRoute} />
      </div>
      {actions !== undefined ? (
        actions
      ) : (
        <div className="flex" style={{ marginTop: eu(20), gap: eu(16) }}>
          <motion.button
            type="button"
            disabled={latePending || !onLate}
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
            {latePending
              ? t('figma-engineer.RequestCards.8dc8c1de5b')
              : t('figma-engineer.RequestCards.fb13f1838c')}
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
            {t('figma-engineer.RequestCards.90ef4cfbd4')}
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
  selected,
}: {
  item: EngineerJobItem;
  onOpen?: () => void;
  onRoute?: () => void;
  selected: boolean;
}) {
  const service = item.request.workTypeTitle ?? skillLabel(item.request.requiredSkill);
  return (
    // biome-ignore lint/a11y/useSemanticElements: The keyboard-accessible card contains an independent route button, which cannot be nested in a button.
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
      className={`flex w-full items-start justify-between overflow-hidden border-solid bg-white text-left ${
        selected ? 'border-figma-bee' : 'border-transparent'
      }`}
      style={{
        gap: eu(16),
        borderRadius: eu(20),
        borderWidth: eu(3),
        padding: `${eu(22)} ${eu(27)}`,
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
          <WorkTypeLabel category={item.request.workCategory}>{service}</WorkTypeLabel>
        </p>
        <span
          className="inline-flex items-center rounded-full bg-figma-ink font-semibold text-white"
          style={{
            marginTop: eu(16),
            padding: `${eu(7)} ${eu(30)}`,
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
      <p
        className="font-murs tracking-[-0.03em] text-figma-ink"
        style={{ fontSize: eu(28), position: 'relative', top: 2 }}
      >
        {t('figma-engineer.RequestCards.69a29fbff8')}
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
      aria-label={t('figma-engineer.RequestCards.7007fd4ac5')}
      onClick={(event) => {
        stopInside(event);
        onRoute?.();
      }}
      className="relative flex shrink-0 items-center justify-center overflow-hidden bg-figma-ink"
      style={{ width: eu(170), height: eu(164), borderRadius: eu(20) }}
    >
      <img alt="" src="/figma/eng-navigation.svg" style={{ width: eu(82), height: eu(82) }} />
    </button>
  );
}
