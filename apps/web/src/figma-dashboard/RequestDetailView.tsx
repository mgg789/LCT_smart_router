import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import type { DashboardSnapshot } from '../api/types';
import { DayMap } from '../components/DayMap';
import { FIGMA_ASSETS } from './assets';
import { Copyable } from './Copyable';
import { FigmaIcon, FigmaText } from './primitives';
import {
  type RequestDetailModel,
  requestDetailFromRow,
  requestDetailFromSnapshot,
} from './requestDetail';
import { DEMO_REQUEST_ROWS, shortRequestId } from './requestsTable';

const HEADER_LIFT = 16;
const DATE_TOP = 100 - HEADER_LIFT;
const TITLE_ROW_HEIGHT = 48;
const PANEL_TOP = 154 - HEADER_LIFT + 10;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
const MAP_HEIGHT = 894 + HEADER_LIFT;
const CLOSE_SIZE = 43;
const CLOSE_INSET = 16;
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Figma REQUET (55:7636): back + work title, map with only this request's pin,
 * ink panel with facts and the three dispatcher actions.
 */
export function RequestDetailView({
  snapshot,
  requestId,
  motionOn,
  onBack,
}: {
  snapshot: DashboardSnapshot | null;
  requestId: string;
  motionOn: boolean;
  onBack: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const animate = motionOn && !reduceMotion;
  const model =
    (snapshot ? requestDetailFromSnapshot(snapshot, requestId) : null) ?? demoDetail(requestId);
  if (!model) return null;

  return (
    <>
      <div
        className="absolute left-[180px] z-30 flex items-center gap-[17px]"
        style={{ top: DATE_TOP, height: TITLE_ROW_HEIGHT, width: 1194 }}
      >
        <motion.button
          type="button"
          aria-label="Назад к заявкам"
          onClick={onBack}
          className="flex size-[43px] shrink-0 items-center justify-center"
          whileHover={animate ? { scale: 1.08 } : undefined}
          whileTap={animate ? { scale: 0.94 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.iconBack} alt="" width={43} height={43} />
        </motion.button>
        <h1
          className="min-w-0 flex-1 truncate font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-figma-ink"
          title={model.title}
        >
          {model.title}
        </h1>
      </div>

      <motion.section
        className="absolute overflow-hidden rounded-[20px] bg-white"
        style={{ left: 180, top: PANEL_TOP, width: 1194, height: MAP_HEIGHT }}
        initial={animate ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={animate ? fadeSoft : { duration: 0 }}
      >
        {snapshot ? (
          <DayMap
            snapshot={snapshot}
            selectedEngineerId={null}
            selectedRequestId={requestId}
            soloRequestId={requestId}
            onSelectRequest={() => undefined}
          />
        ) : (
          <img
            alt=""
            src={FIGMA_ASSETS.map}
            className="absolute inset-0 size-full max-w-none object-cover"
          />
        )}
      </motion.section>

      <motion.aside
        className="absolute left-[1406px] w-[484px] overflow-hidden rounded-[20px] bg-figma-ink"
        style={{ top: PANEL_TOP, height: PANEL_HEIGHT }}
        initial={animate ? { opacity: 0, x: 28 } : false}
        animate={{ opacity: 1, x: 0 }}
        transition={animate ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      >
        <motion.button
          type="button"
          aria-label="Закрыть заявку"
          onClick={onBack}
          className="absolute z-20 flex items-center justify-center rounded-full bg-white"
          style={{ top: CLOSE_INSET, right: CLOSE_INSET, width: CLOSE_SIZE, height: CLOSE_SIZE }}
          whileHover={animate ? { scale: 1.12 } : undefined}
          whileTap={animate ? { scale: 0.94 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <X size={22} strokeWidth={2.25} className="text-figma-ink" />
        </motion.button>
        <RequestDetailPanel model={model} motionOn={animate} />
      </motion.aside>
    </>
  );
}

function RequestDetailPanel({ model, motionOn }: { model: RequestDetailModel; motionOn: boolean }) {
  const facts = [
    { id: 'address', value: model.address },
    { id: 'email', value: model.email ?? '—' },
    { id: 'contact', value: model.contactName ?? '—' },
    { id: 'window', value: model.windowLabel },
    { id: 'engineer', value: model.engineerLabel },
  ];

  return (
    <div className="flex h-full flex-col px-[27px] pt-[24px] pb-[24px]">
      <Copyable
        value={shortRequestId(model.id)}
        label="Скопировать номер заявки"
        className="pr-[52px] text-left"
      >
        <FigmaText
          className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white"
          title={model.id}
        >
          {model.numberLabel}
        </FigmaText>
      </Copyable>
      <div className="mt-[16px] flex flex-wrap gap-[12px]">
        {model.primaryTags.map((tag) => (
          <DetailTag key={tag} label={tag} />
        ))}
      </div>
      {model.equipmentTags.length > 0 ? (
        <div className="mt-[12px] flex flex-wrap gap-[12px]">
          {model.equipmentTags.map((tag) => (
            <DetailTag key={tag} label={tag} />
          ))}
        </div>
      ) : null}
      <div className="mt-[30px] flex flex-col gap-[16px]">
        {facts.map(({ id, value }) => (
          <Copyable
            key={id}
            value={value}
            className="flex h-[67px] w-[430px] items-center rounded-[20px] bg-white/10 px-[20px] text-left transition-colors hover:bg-white/15 disabled:cursor-default disabled:hover:bg-white/10"
          >
            <p className="figma-nowrap overflow-hidden font-medium text-[20px] text-ellipsis text-white">
              {value}
            </p>
          </Copyable>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-[16px]">
        <motion.button
          type="button"
          disabled
          aria-disabled
          title="Скоро"
          className="flex h-[61px] w-[430px] cursor-not-allowed items-center justify-center rounded-[20px] border-[0.5px] border-white bg-figma-ink font-medium text-[20px] text-white opacity-45"
        >
          Написать клиенту
        </motion.button>
        <motion.button
          type="button"
          className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-bee font-medium text-[20px] text-figma-ink"
          whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
          whileTap={motionOn ? { scale: 0.98 } : undefined}
          transition={{ duration: 0.16 }}
        >
          Переназначить инженера
        </motion.button>
        <motion.button
          type="button"
          className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-cancel font-medium text-[20px] text-white"
          whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
          whileTap={motionOn ? { scale: 0.98 } : undefined}
          transition={{ duration: 0.16 }}
        >
          Отменить визит
        </motion.button>
      </div>
    </div>
  );
}

function DetailTag({ label }: { label: string }) {
  return (
    <span className="inline-flex h-[36px] items-center rounded-[20px] bg-white/20 px-[16px] font-medium text-[20px] text-white">
      {label}
    </span>
  );
}

function demoDetail(requestId: string): RequestDetailModel | null {
  const row = DEMO_REQUEST_ROWS.find((item) => item.id === requestId);
  return row ? requestDetailFromRow(row) : null;
}
