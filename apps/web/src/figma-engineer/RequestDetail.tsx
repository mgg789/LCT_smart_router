import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { RequestMap } from './RequestMap';
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
  onBack,
  onRoute,
  actions,
}: {
  item: EngineerJobItem;
  nowMs: number;
  onBack: () => void;
  onRoute: () => void;
  actions?: ReactNode;
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
        <h1
          className="min-w-0 font-murs tracking-[-0.02em] text-figma-ink"
          style={{ fontSize: eu(40) }}
        >
          {arrivalHeadline(item.stop.startAt, nowMs)}
        </h1>
      </header>

      <div
        className="relative overflow-hidden bg-white"
        style={{ marginTop: eu(36), height: eu(287), borderRadius: eu(26) }}
      >
        <RequestMap
          lat={item.request.lat ?? item.stop.lat}
          lon={item.request.lon ?? item.stop.lon}
        />
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
          <Chip align="center">
            {formatPlanWindow(item.request.windowStartAt, item.request.windowEndAt)}
          </Chip>
        </div>
        <Chip>{item.request.addressText}</Chip>
        <Chip>{service}</Chip>
        {equipment ? <Chip>{equipment}</Chip> : null}
      </div>

      {actions}
      {actions ? null : (
        <button
          type="button"
          disabled
          title="Канал поддержки пока не подключён"
          className="mt-auto rounded-[20px] bg-figma-bee p-4 font-semibold text-figma-ink disabled:opacity-50"
        >
          Написать в поддержку
        </button>
      )}
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
