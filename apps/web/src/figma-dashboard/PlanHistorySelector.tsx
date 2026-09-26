import { motion } from 'framer-motion';
import type { PlanView } from '../api/types';

export type PlanHistorySelection = 'previous' | 'current';

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
  onSelect: (selection: PlanHistorySelection) => void;
  onChoose: () => void;
}) {
  return (
    <motion.aside
      data-plan-history-dialog
      role="dialog"
      aria-modal="true"
      aria-label="Выбор плана"
      tabIndex={-1}
      className="absolute bottom-[28px] left-1/2 z-[121] flex w-[760px] -translate-x-1/2 items-center gap-[10px] rounded-full bg-white p-[12px] shadow-[0_18px_44px_rgba(39,41,48,0.22)]"
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
        aria-pressed={selection === 'previous'}
        onClick={() => onSelect('previous')}
        disabled={!canRestore || busy}
        className="min-w-[182px] rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:cursor-not-allowed disabled:opacity-40"
      >
        До · {previous.revision}
      </button>
      <button
        type="button"
        aria-pressed={selection === 'current'}
        onClick={() => onSelect('current')}
        disabled={busy}
        className="min-w-[182px] rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:cursor-not-allowed disabled:opacity-40"
      >
        После · {currentRevision ?? '—'}
      </button>
      <motion.button
        type="button"
        onClick={onChoose}
        disabled={busy || (selection === 'previous' && !canRestore)}
        className="min-w-[220px] rounded-full border border-figma-ink px-[18px] py-[15px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] hover:bg-figma-canvas disabled:cursor-not-allowed disabled:opacity-40"
        whileTap={motionOn ? { scale: 0.97 } : undefined}
      >
        Выбрать этот
      </motion.button>
    </motion.aside>
  );
}
