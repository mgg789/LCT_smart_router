import { motion, useReducedMotion } from 'framer-motion';
import type { DashboardSnapshot } from '../api/types';
import { DayMap } from '../components/DayMap';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon, FigmaText } from './primitives';
import {
  requestDetailFromRow,
  requestDetailFromSnapshot,
  type RequestDetailModel,
} from './requestDetail';
import { DEMO_REQUEST_ROWS } from './requestsTable';

const HEADER_LIFT = 16;
const DATE_TOP = 100 - HEADER_LIFT;
const TITLE_TOP = DATE_TOP + 8;
const PANEL_TOP = 154 - HEADER_LIFT;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
const MAP_HEIGHT = 894 + HEADER_LIFT;
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
    (snapshot ? requestDetailFromSnapshot(snapshot, requestId) : null) ??
    demoDetail(requestId);
  if (!model) return null;

  return (
    <>
      <motion.button
        type="button"
        aria-label="Назад к заявкам"
        onClick={onBack}
        className="absolute left-[180px] z-20 flex size-[43px] items-center justify-center"
        style={{ top: TITLE_TOP }}
        whileHover={animate ? { scale: 1.08 } : undefined}
        whileTap={animate ? { scale: 0.94 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <FigmaIcon src={FIGMA_ASSETS.iconBack} alt="" width={43} height={43} />
      </motion.button>
      <FigmaText
        className="figma-nowrap absolute left-[240px] max-w-[1040px] overflow-hidden font-murs text-[32px] tracking-[-0.544px] text-ellipsis text-figma-ink"
        style={{ top: TITLE_TOP }}
        title={model.title}
      >
        {model.title}
      </FigmaText>

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
        <RequestDetailPanel model={model} />
      </motion.aside>
    </>
  );
}

function RequestDetailPanel({ model }: { model: RequestDetailModel }) {
  const facts = [
    model.address,
    model.email ?? '—',
    model.contactName ?? '—',
    model.windowLabel,
    model.engineerLabel,
  ];

  return (
    <div className="flex h-full flex-col px-[27px] pt-[24px] pb-[24px]">
      <FigmaText
        className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white"
        title={model.id}
      >
        {model.numberLabel}
      </FigmaText>
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
        {facts.map((value, index) => (
          <div
            key={`${index}-${value}`}
            className="flex h-[67px] w-[430px] items-center rounded-[20px] bg-white/10 px-[20px]"
          >
            <p className="figma-nowrap overflow-hidden font-medium text-[20px] text-ellipsis text-white">
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-[16px]">
        <button
          type="button"
          disabled={!model.email}
          className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] border-[0.5px] border-white bg-figma-ink font-medium text-[20px] text-white disabled:opacity-50"
        >
          Написать клиенту
        </button>
        <button
          type="button"
          className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-bee font-medium text-[20px] text-figma-ink"
        >
          Переназначить инженера
        </button>
        <button
          type="button"
          className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-cancel font-medium text-[20px] text-white"
        >
          Отменить визит
        </button>
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
