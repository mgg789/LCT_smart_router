import { motion } from 'framer-motion';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { skillLabel } from '../lib/reasons';
import { ENGINEER_ASSETS } from './assets';
import { arrivalHeadline, formatPlanWindow } from './engineerClock';
import type { EngineerJobItem } from './engineerDay';
import { equipmentLabel } from './engineerRoute';
import { eu } from './engineerScale';

/**
 * Figma REQUEST 78:9734 — back + time-until, map with «Построить маршрут»,
 * contact / window / address / type / equipment chips, on-time and late.
 */
export function RequestDetail({
  item,
  nowMs,
  latePending,
  onTimePending,
  onBack,
  onRoute,
  onLate,
  onOnTime,
}: {
  item: EngineerJobItem;
  nowMs: number;
  latePending: boolean;
  onTimePending: boolean;
  onBack: () => void;
  onRoute: () => void;
  onLate: () => void;
  onOnTime: () => void;
}) {
  const service = item.request.workTypeTitle ?? skillLabel(item.request.requiredSkill);
  const equipment = equipmentLabel(item.request.requiredEquipment);
  const contact = item.request.contactName ?? 'Клиент';

  return (
    <section
      className="flex min-h-dvh flex-col"
      style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
    >
      <header className="flex items-center" style={{ gap: eu(20) }}>
        <motion.button
          type="button"
          aria-label="Назад к списку"
          onClick={onBack}
          whileTap={{ scale: 0.96 }}
          transition={{ duration: 0.16 }}
          className="flex shrink-0 items-center justify-center"
          style={{ width: eu(32), height: eu(32) }}
        >
          <FigmaIcon
            src={ENGINEER_ASSETS.back}
            alt=""
            width={32}
            height={29}
            style={{ width: eu(32), height: eu(29) }}
          />
        </motion.button>
        <h1 className="min-w-0 font-murs tracking-[-0.02em] text-figma-ink" style={{ fontSize: eu(40) }}>
          {arrivalHeadline(item.stop.startAt, nowMs)}
        </h1>
      </header>

      <div
        className="relative overflow-hidden bg-black"
        style={{ marginTop: eu(36), height: eu(287), borderRadius: eu(26) }}
      >
        <img
          alt=""
          src={FIGMA_ASSETS.map}
          className="absolute inset-0 size-full max-w-none object-cover"
        />
        <div
          className="absolute left-1/2 top-[23%] -translate-x-1/2"
          style={{ width: eu(48), height: eu(48) }}
        >
          <FigmaIcon
            src={ENGINEER_ASSETS.pin}
            alt=""
            width={48}
            height={48}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        <motion.button
          type="button"
          onClick={onRoute}
          whileTap={{ scale: 0.98 }}
          className="absolute flex items-center bg-figma-ink"
          style={{
            right: eu(20),
            bottom: eu(20),
            gap: eu(10),
            borderRadius: eu(27),
            padding: `${eu(14)} ${eu(16)} ${eu(14)} ${eu(20)}`,
          }}
        >
          <span className="whitespace-nowrap font-semibold text-white" style={{ fontSize: eu(20) }}>
            Построить маршрут
          </span>
          <FigmaIcon
            src={ENGINEER_ASSETS.route}
            alt=""
            width={43}
            height={43}
            style={{ width: eu(43), height: eu(43) }}
          />
        </motion.button>
      </div>

      <div className="flex flex-col" style={{ marginTop: eu(24), gap: eu(16) }}>
        <div className="flex" style={{ gap: eu(40) }}>
          <Chip>{contact}</Chip>
          <Chip align="center">{formatPlanWindow(item.request.windowStartAt, item.request.windowEndAt)}</Chip>
        </div>
        <Chip>{item.request.addressText}</Chip>
        <Chip>{service}</Chip>
        {equipment ? <Chip>{equipment}</Chip> : null}
      </div>

      <div className="mt-auto flex flex-col" style={{ gap: eu(15), paddingTop: eu(28) }}>
        <motion.button
          type="button"
          onClick={onOnTime}
          whileTap={{ scale: 0.98 }}
          className="flex w-full items-center justify-center bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-60"
          style={{ height: eu(95), borderRadius: eu(23), fontSize: eu(28) }}
        >
          {onTimePending ? 'Отмечено' : 'Буду вовремя'}
        </motion.button>
        <motion.button
          type="button"
          onClick={onLate}
          whileTap={{ scale: 0.98 }}
          className="flex w-full items-center justify-center bg-figma-ink font-semibold tracking-[-0.03em] text-white disabled:opacity-60"
          style={{ height: eu(95), borderRadius: eu(23), fontSize: eu(28) }}
        >
          {latePending ? 'Отмечено' : 'Опаздываю'}
        </motion.button>
      </div>
    </section>
  );
}

function Chip({ children, align = 'start' }: { children: string; align?: 'start' | 'center' }) {
  return (
    <div
      className={`flex min-w-0 flex-1 items-center overflow-hidden bg-[#555] ${
        align === 'center' ? 'justify-center' : ''
      }`}
      style={{
        minHeight: eu(77),
        borderRadius: eu(20),
        padding: `${eu(20)} ${eu(20)}`,
      }}
    >
      <p
        className="min-w-0 font-medium tracking-[-0.03em] text-white"
        style={{ fontSize: eu(24), overflowWrap: 'anywhere' }}
      >
        {children}
      </p>
    </div>
  );
}
