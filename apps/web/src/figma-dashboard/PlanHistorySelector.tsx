import { motion } from 'framer-motion';
import { useRef } from 'react';
import type { PlanView } from '../api/types';
import { useModalFocus } from '../components/useModalFocus';
import { t } from '../i18n';

const restoreReasons: Readonly<Record<string, string>> = {
  NO_CURRENT_PLAN: t('figma-dashboard.PlanHistorySelector.f19c2fb211'),
  NO_PREVIOUS_PLAN: t('figma-dashboard.PlanHistorySelector.f9ea326841'),
  SCHEDULE_IN_THE_PAST: t('figma-dashboard.PlanHistorySelector.2bcd6dd1ef'),
  REQUEST_SET_CHANGED: t('figma-dashboard.PlanHistorySelector.5e4ca74dec'),
  ROUTER_CONTEXT_CHANGED: t('figma-dashboard.PlanHistorySelector.3fdd1d1864'),
  ROUTER_CONTEXT_UNAVAILABLE: t('figma-dashboard.PlanHistorySelector.b152863010'),
  ROUTER_CONTEXT_MUTATION_PENDING: t('figma-dashboard.PlanHistorySelector.1ea0a04908'),
  MANUAL_DECISIONS_ACTIVE: t('figma-dashboard.PlanHistorySelector.2e5c23135b'),
  EXECUTION_FACTS_CHANGED: t('figma-dashboard.PlanHistorySelector.3b502831a9'),
  SNAPSHOT_UNAVAILABLE: t('figma-dashboard.PlanHistorySelector.e011a71fc0'),
  INPUT_CONDITIONS_CHANGED: t('figma-dashboard.PlanHistorySelector.0788241a34'),
  EQUIPMENT_ISSUED_ASSIGNMENT_CHANGED: t('figma-dashboard.PlanHistorySelector.34c71e6198'),
};

export type PlanHistorySelection = 'previous' | 'current';

export interface PlanHistoryAnchor {
  /** Horizontal center in the dashboard artboard coordinate space. */
  readonly left: number;
  /** Distance from the dashboard artboard bottom to the chooser. */
  readonly bottom: number;
}

/**
 * Bottom-centered plan history chooser. The parent supplies a modal veil so every
 * dashboard action stays unavailable until the dispatcher chooses a plan.
 */
export function PlanHistorySelector({
  previous,
  currentRevision,
  selection,
  canRestore,
  busy,
  motionOn,
  error,
  restoreUnavailableReason,
  anchor,
  onSelect,
  onChoose,
}: {
  previous: PlanView;
  currentRevision: number | null;
  selection: PlanHistorySelection;
  canRestore: boolean;
  busy: boolean;
  motionOn: boolean;
  error?: string | null;
  restoreUnavailableReason?: string | null;
  anchor?: PlanHistoryAnchor;
  onSelect: (selection: PlanHistorySelection) => void;
  onChoose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  // This chooser requires an explicit current/previous choice; Escape never applies a plan.
  useModalFocus(dialogRef, true, () => {});
  const unavailableReason =
    (restoreUnavailableReason && restoreReasons[restoreUnavailableReason]) ||
    (restoreUnavailableReason && !/^[A-Z_]+$/.test(restoreUnavailableReason)
      ? restoreUnavailableReason.trim()
      : null) ||
    t('figma-dashboard.PlanHistorySelector.c4c23a77e6');
  return (
    <motion.aside
      ref={dialogRef}
      data-plan-history-dialog
      role="dialog"
      aria-modal="true"
      aria-label={t('figma-dashboard.PlanHistorySelector.0b1929917f')}
      tabIndex={-1}
      className="absolute z-[121] grid w-[760px] -translate-x-1/2 grid-cols-[1fr_auto_1fr] items-center gap-[10px] rounded-full bg-white p-[12px] shadow-[0_18px_44px_rgba(39,41,48,0.22)]"
      style={anchor ? { left: anchor.left, bottom: anchor.bottom } : { left: '50%', bottom: 28 }}
      initial={motionOn ? { opacity: 0, y: 18, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={motionOn ? { opacity: 0, y: 18, scale: 0.97 } : undefined}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      {error ? (
        <p
          role="alert"
          className="absolute bottom-full left-0 mb-[12px] w-full rounded-[20px] bg-white p-[16px] text-center text-[16px] text-figma-ink"
        >
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-plan-history-previous
        aria-pressed={selection === 'previous'}
        onClick={() => onSelect('previous')}
        disabled={busy}
        className="min-w-[182px] justify-self-start rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:opacity-40"
      >
        {t('figma-dashboard.PlanHistorySelector.ac331d91ca')}
        {previous.revision}
      </button>
      <span
        className="group relative inline-flex"
        tabIndex={selection === 'previous' && !canRestore ? 0 : undefined}
        title={selection === 'previous' && !canRestore ? unavailableReason : undefined}
        data-plan-history-tooltip={selection === 'previous' && !canRestore ? true : undefined}
      >
        <motion.button
          type="button"
          data-plan-history-confirm
          onClick={onChoose}
          disabled={busy || (selection === 'previous' && !canRestore)}
          className="min-w-[220px] rounded-full border border-figma-ink px-[18px] py-[15px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] hover:bg-figma-canvas disabled:cursor-not-allowed disabled:opacity-40"
          whileTap={motionOn ? { scale: 0.97 } : undefined}
        >
          {t('figma-dashboard.PlanHistorySelector.7c5aa14cc0')}
        </motion.button>
        {selection === 'previous' && !canRestore ? (
          <span
            role="tooltip"
            className="pointer-events-none invisible absolute bottom-[calc(100%+12px)] left-1/2 z-10 w-[300px] -translate-x-1/2 rounded-[16px] border border-figma-ink/20 bg-white p-[12px] text-center text-[14px] leading-[1.35] text-figma-ink opacity-0 shadow-xl transition-[opacity,visibility] duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
          >
            {unavailableReason}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        data-plan-history-current
        aria-pressed={selection === 'current'}
        onClick={() => onSelect('current')}
        disabled={busy}
        className="min-w-[182px] justify-self-end rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('figma-dashboard.PlanHistorySelector.cfb7e81534')}
        {currentRevision ?? '—'}
      </button>
    </motion.aside>
  );
}
