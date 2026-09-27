import { motion } from 'framer-motion';
import type { PlanView } from '../api/types';

const restoreReasons: Readonly<Record<string, string>> = {
  NO_CURRENT_PLAN: 'Текущий план ещё не построен.',
  NO_PREVIOUS_PLAN: 'Предыдущего плана пока нет.',
  SCHEDULE_IN_THE_PAST:
    'В предыдущем плане есть визиты, время начала которых уже прошло. Вернуть этот план нельзя.',
  REQUEST_SET_CHANGED: 'Состав заявок изменился после построения предыдущего плана.',
  ROUTER_CONTEXT_CHANGED:
    'Условия расчёта маршрутов изменились. Предыдущий план больше не соответствует им.',
  ROUTER_CONTEXT_UNAVAILABLE:
    'Не удалось проверить актуальные условия маршрутов. Попробуйте позже.',
  ROUTER_CONTEXT_MUTATION_PENDING: 'Условия маршрутов сейчас обновляются. Дождитесь завершения.',
  MANUAL_DECISIONS_ACTIVE:
    'Сначала сбросьте ручные решения: прошлый план не учитывает текущие приоритеты.',
  EXECUTION_FACTS_CHANGED:
    'После построения предыдущего плана изменились фактические статусы выполнения заявок.',
  SNAPSHOT_UNAVAILABLE: 'Исходные данные предыдущего плана недоступны для проверки.',
  INPUT_CONDITIONS_CHANGED: 'Изменились заявки, смены инженеров или границы рабочего дня.',
  EQUIPMENT_ISSUED_ASSIGNMENT_CHANGED:
    'Оборудование уже выдано, а предыдущий план назначает связанные заявки другим инженерам.',
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
  const unavailableReason =
    (restoreUnavailableReason && restoreReasons[restoreUnavailableReason]) ||
    (restoreUnavailableReason && !/^[A-Z_]+$/.test(restoreUnavailableReason)
      ? restoreUnavailableReason.trim()
      : null) ||
    'Предыдущий план сейчас недоступен для восстановления. Обновите данные и попробуйте снова.';
  return (
    <motion.aside
      data-plan-history-dialog
      role="dialog"
      aria-modal="true"
      aria-label="Выбор плана"
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
      <span
        className="group relative inline-flex min-w-[182px] justify-self-start"
        tabIndex={!canRestore ? 0 : undefined}
        title={!canRestore ? unavailableReason : undefined}
        data-plan-history-tooltip={!canRestore ? true : undefined}
        data-plan-history-previous
      >
        <button
          type="button"
          aria-pressed={selection === 'previous'}
          onClick={() => onSelect('previous')}
          disabled={!canRestore || busy}
          className="min-w-[182px] rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:cursor-not-allowed disabled:opacity-40"
        >
          До · {previous.revision}
        </button>
        {!canRestore ? (
          <span
            role="tooltip"
            className="pointer-events-none invisible absolute bottom-[calc(100%+12px)] left-1/2 z-10 w-[300px] -translate-x-1/2 rounded-[16px] border border-figma-ink/20 bg-white p-[12px] text-center text-[14px] leading-[1.35] text-figma-ink opacity-0 shadow-xl transition-[opacity,visibility] duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
          >
            {unavailableReason}
          </span>
        ) : null}
      </span>
      <motion.button
        type="button"
        data-plan-history-confirm
        onClick={onChoose}
        disabled={busy || (selection === 'previous' && !canRestore)}
        className="min-w-[220px] rounded-full border border-figma-ink px-[18px] py-[15px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] hover:bg-figma-canvas disabled:cursor-not-allowed disabled:opacity-40"
        whileTap={motionOn ? { scale: 0.97 } : undefined}
      >
        Выбрать этот
      </motion.button>
      <button
        type="button"
        data-plan-history-current
        aria-pressed={selection === 'current'}
        onClick={() => onSelect('current')}
        disabled={busy}
        className="min-w-[182px] justify-self-end rounded-full px-[18px] py-[16px] text-[20px] font-semibold text-figma-ink transition-[background-color,transform] duration-150 hover:scale-[1.02] aria-pressed:bg-figma-bee disabled:cursor-not-allowed disabled:opacity-40"
      >
        После · {currentRevision ?? '—'}
      </button>
    </motion.aside>
  );
}
