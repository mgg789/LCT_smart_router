import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useState } from 'react';
import type { DashboardSnapshot, EngineerView } from '../api/types';
import { DayMap } from '../components/DayMap';
import { RequestPassport } from '../components/passports/PassportDetails';
import { t } from '../i18n';
import { useArtboardStretch } from './artboardStretch';
import { FIGMA_ASSETS } from './assets';
import { Copyable } from './Copyable';
import { ManualRequestControls } from './ManualPlanning';
import { FigmaIcon, FigmaText } from './primitives';
import {
  assignableEngineers,
  type RequestDetailModel,
  requestAssignLabel,
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
  token,
  snapshot,
  requestId,
  motionOn,
  onBack,
  onCancelVisit,
  onAssignEngineer,
}: {
  token?: string;
  snapshot: DashboardSnapshot | null;
  requestId: string;
  motionOn: boolean;
  onBack: () => void;
  onCancelVisit?: () => Promise<void>;
  onAssignEngineer?: (engineerId: string) => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const animate = motionOn && !reduceMotion;
  const { dx, dy } = useArtboardStretch();
  const model =
    (snapshot ? requestDetailFromSnapshot(snapshot, requestId) : null) ?? demoDetail(requestId);
  if (!model) return null;

  return (
    <>
      <div
        className="absolute left-[180px] z-30 flex items-center gap-[17px]"
        style={{ top: DATE_TOP, height: TITLE_ROW_HEIGHT, width: 1194 + dx }}
      >
        <motion.button
          type="button"
          aria-label={t('figma-dashboard.RequestDetailView.d8b45936b2')}
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
        // Spare board width and height go to the map and the panel beside it, the
        // way the requests table already takes them. Pinned at the drawn size they
        // left a band of empty canvas under and beside the screen on anything that
        // is not exactly 16:9.
        style={{ left: 180, top: PANEL_TOP, width: 1194 + dx, height: MAP_HEIGHT + dy }}
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
        className="absolute w-[484px] overflow-hidden rounded-[20px] bg-figma-ink"
        style={{ left: 1406 + dx, top: PANEL_TOP, height: PANEL_HEIGHT + dy }}
        initial={animate ? { opacity: 0, x: 28 } : false}
        animate={{ opacity: 1, x: 0 }}
        transition={animate ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      >
        <motion.button
          type="button"
          aria-label={t('figma-dashboard.RequestDetailView.448d82146d')}
          onClick={onBack}
          className="absolute z-20 flex items-center justify-center rounded-full bg-white"
          style={{ top: CLOSE_INSET, right: CLOSE_INSET, width: CLOSE_SIZE, height: CLOSE_SIZE }}
          whileHover={animate ? { scale: 1.12 } : undefined}
          whileTap={animate ? { scale: 0.94 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <X size={22} strokeWidth={2.25} className="text-figma-ink" />
        </motion.button>
        <RequestDetailPanel
          token={token}
          model={model}
          motionOn={animate}
          candidates={snapshot ? assignableEngineers(snapshot, requestId) : []}
          onCancelVisit={onCancelVisit}
          onAssignEngineer={onAssignEngineer}
        />
      </motion.aside>
    </>
  );
}

function RequestDetailPanel({
  token,
  model,
  motionOn,
  candidates,
  onCancelVisit,
  onAssignEngineer,
}: {
  token?: string;
  model: RequestDetailModel;
  motionOn: boolean;
  candidates: EngineerView[];
  onCancelVisit?: () => Promise<void>;
  onAssignEngineer?: (engineerId: string) => Promise<void>;
}) {
  const facts = [
    { id: 'address', value: model.address },
    { id: 'email', value: model.email ?? '—' },
    { id: 'contact', value: model.contactName ?? '—' },
    { id: 'window', value: model.windowLabel },
    { id: 'engineer', value: model.engineerLabel },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto overflow-x-hidden px-[27px] pt-[24px] pb-[24px]">
      <Copyable
        value={shortRequestId(model.id)}
        label={t('figma-dashboard.RequestDetailView.fd3834086e')}
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
      <ManualRequestControls requestId={model.id} />
      {model.equipmentTags.length > 0 ? (
        <div className="mt-[12px] flex flex-wrap gap-[12px]">
          {model.equipmentTags.map((tag) => (
            <DetailTag key={tag} label={tag} />
          ))}
        </div>
      ) : null}
      <div className="mt-[30px] flex shrink-0 flex-col gap-[16px]">
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
      {token ? <RequestPassport token={token} audience="dispatch" requestId={model.id} /> : null}
      <RequestDetailActions
        model={model}
        motionOn={motionOn}
        candidates={candidates}
        onCancelVisit={onCancelVisit}
        onAssignEngineer={onAssignEngineer}
      />
    </div>
  );
}

function RequestDetailActions({
  model,
  motionOn,
  candidates,
  onCancelVisit,
  onAssignEngineer,
}: {
  model: RequestDetailModel;
  motionOn: boolean;
  candidates: EngineerView[];
  onCancelVisit?: () => Promise<void>;
  onAssignEngineer?: (engineerId: string) => Promise<void>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [engineerId, setEngineerId] = useState(candidates[0]?.id ?? '');
  const [pending, setPending] = useState<'assign' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: 'assign' | 'cancel', work: () => Promise<void>) => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await work();
      setPickerOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('figma-dashboard.RequestDetailView.c4f2454fb5'),
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="mt-auto flex shrink-0 flex-col gap-[16px]">
      <motion.button
        type="button"
        disabled
        aria-disabled
        title={t('figma-dashboard.RequestDetailView.72c299e0d6')}
        className="flex h-[61px] w-[430px] cursor-not-allowed items-center justify-center rounded-[20px] border-[0.5px] border-white bg-figma-ink font-medium text-[20px] text-white opacity-45"
      >
        {t('figma-dashboard.RequestDetailView.b9f2392df4')}
      </motion.button>
      <motion.button
        type="button"
        disabled={!model.assignable || !onAssignEngineer || pending !== null}
        className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-bee font-medium text-[20px] text-figma-ink disabled:opacity-45"
        whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
        whileTap={motionOn ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.16 }}
        onClick={() => {
          setError(null);
          setPickerOpen(true);
          if (!engineerId && candidates[0]) setEngineerId(candidates[0].id);
        }}
      >
        {requestAssignLabel(model.assigned)}
      </motion.button>
      {pickerOpen ? (
        <div className="rounded-[16px] bg-white/10 p-[16px] text-white">
          <label className="block font-medium text-[16px]">
            {t('figma-dashboard.RequestDetailView.88d71676fa')}
            <select
              className="mt-[8px] block w-full rounded-[12px] bg-white p-[10px] text-figma-ink"
              value={engineerId}
              onChange={(event) => setEngineerId(event.target.value)}
            >
              {candidates.length === 0 ? (
                <option value="">{t('figma-dashboard.RequestDetailView.eb014bb3ec')}</option>
              ) : null}
              {candidates.map((engineer) => (
                <option key={engineer.id} value={engineer.id}>
                  {engineer.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-[12px] flex gap-[10px]">
            <button
              type="button"
              disabled={!engineerId || !onAssignEngineer || pending !== null}
              className="rounded-[16px] bg-figma-bee px-[18px] py-[10px] font-semibold text-figma-ink disabled:opacity-45"
              onClick={() => {
                if (!onAssignEngineer || !engineerId) return;
                void run('assign', () => onAssignEngineer(engineerId));
              }}
            >
              {pending === 'assign'
                ? t('figma-dashboard.RequestDetailView.040f8f0bbf')
                : t('figma-dashboard.RequestDetailView.cfd07e716f')}
            </button>
            <button
              type="button"
              className="rounded-[16px] border border-white/40 px-[18px] py-[10px] text-white"
              onClick={() => setPickerOpen(false)}
            >
              {t('figma-dashboard.RequestDetailView.8fbe9b75cb')}
            </button>
          </div>
        </div>
      ) : null}
      <motion.button
        type="button"
        disabled={!model.cancellable || !onCancelVisit || pending !== null}
        className="flex h-[61px] w-[430px] items-center justify-center rounded-[20px] bg-figma-cancel font-medium text-[20px] text-white disabled:opacity-45"
        whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
        whileTap={motionOn ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.16 }}
        onClick={() => {
          if (!onCancelVisit) return;
          void run('cancel', onCancelVisit);
        }}
      >
        {pending === 'cancel'
          ? t('figma-dashboard.RequestDetailView.4ba8a8d87b')
          : t('figma-dashboard.RequestDetailView.63895de5f0')}
      </motion.button>
      {error ? (
        <p role="alert" className="font-medium text-[16px] text-white">
          {error}
        </p>
      ) : null}
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
