import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronLeft, ChevronRight, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import type { EngineerView } from '@/entities/engineer';
import type { DispatchMode, PlanAssignmentView, PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { requestStatusTitle, skillTitle } from '@/entities/request';
import { useReassignRequest } from '@/features/plan/reassign-request';
import { useReorderRequest } from '@/features/plan/reorder-request';
import { cn, EASE_OUT, formatRange, useMotionOn } from '@/shared/lib';
import { explainRequest } from '../model/explainRequest';

export interface RequestPanelProps {
  request: RequestView | null;
  assignment: PlanAssignmentView | null;
  engineer: EngineerView | null;
  route: PlanRouteView | null;
  engineers: EngineerView[];
  mode: DispatchMode | null;
  modeVersion: number | null;
  planRevision: number | null;
  /** Editable jobs only, in the currently applied queue order. */
  editableRequestIds: string[];
  /**
   * Asks the explain agent about this request. Passed in rather than called here
   * so the panel stays a view: where the answer is read is the page's business.
   */
  onExplain?: () => void;
  /**
   * The requests either side of this one, and how to reach them. Which list that
   * is — the crew's queue or the unassigned pile — is the page's call, so the
   * panel only says where in it this request sits.
   */
  beside?: {
    index: number;
    total: number;
    of: 'queue' | 'unassigned';
    onStep: (delta: -1 | 1) => void;
  };
}

/** What the arrows are walking through, named so the labels read as Russian. */
const BESIDE_NOUN: Record<'queue' | 'unassigned', string> = {
  queue: 'заявка в очереди бригады',
  unassigned: 'заявка без назначения',
};

/** One round arrow beside the heading. */
function StepButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-9 items-center justify-center rounded-full bg-white/15 text-white transition-[background-color,transform] duration-150 hover:bg-white/25 active:scale-[0.94]"
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden size={20} strokeWidth={2.2} />
    </button>
  );
}

/** Inner tile of the dark panel. */
function Tile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl bg-white/15 px-5 py-4 text-[18px] text-white', className)}>
      {children}
    </div>
  );
}

/**
 * Right panel of the day: the selected request and why the router placed it the
 * way it did.
 *
 * The explanation is assembled from the snapshot — the request, the crew, the
 * route and the solver's reason codes — never from a stock phrase, and it says
 * plainly when a reason is the outcome of a limited search rather than a checked
 * constraint.
 */
export function RequestPanel(props: RequestPanelProps) {
  const motionOn = useMotionOn();
  // A newly picked request slides in from the right, the way `apps/web` brings a
  // request forward; the old one steps back out first.
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        animate={{ opacity: 1, x: 0 }}
        className="flex h-full min-w-[320px] shrink basis-[485px]"
        exit={
          motionOn
            ? { opacity: 0, x: 24, transition: { duration: 0.14, ease: EASE_OUT } }
            : undefined
        }
        initial={motionOn ? { opacity: 0, x: 48 } : false}
        key={props.request?.id ?? 'none'}
        transition={{ duration: 0.28, ease: EASE_OUT }}
      >
        <RequestPanelBody {...props} />
      </motion.div>
    </AnimatePresence>
  );
}

function RequestPanelBody({
  request,
  assignment,
  engineer,
  route,
  engineers,
  mode,
  modeVersion,
  planRevision,
  editableRequestIds,
  onExplain,
  beside,
}: RequestPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const reassign = useReassignRequest();
  const reorder = useReorderRequest();

  if (!request) {
    return (
      <aside className="flex h-full w-full items-center justify-center rounded-[20px] bg-ink p-6 text-center">
        <p className="text-[16px] text-white/60">Выберите заявку на карте или в списке.</p>
      </aside>
    );
  }

  const explanation = explainRequest(request, assignment, engineer, route, engineers);
  const started = request.startedAt !== null;
  const canReassign =
    mode === 'manual' &&
    request.lifecycle === 'submitted' &&
    !started &&
    modeVersion !== null &&
    planRevision !== null;
  const editableIndex = editableRequestIds.indexOf(request.id);
  const canReorder = canReassign && route !== null && editableIndex !== -1;
  const moveInQueue = (delta: -1 | 1) => {
    if (!canReorder || modeVersion === null || planRevision === null || !route) return;
    const nextIndex = editableIndex + delta;
    if (nextIndex < 0 || nextIndex >= editableRequestIds.length) return;
    const nextOrder = [...editableRequestIds];
    const current = nextOrder[editableIndex];
    const neighbor = nextOrder[nextIndex];
    if (!current || !neighbor) return;
    nextOrder[editableIndex] = neighbor;
    nextOrder[nextIndex] = current;
    reorder.mutate({
      engineerId: route.engineerId,
      requestIds: nextOrder,
      expectedModeVersion: modeVersion,
      expectedPlanRevision: planRevision,
    });
  };
  const reassignHint = started
    ? 'Работа уже начата — переназначение закрыто.'
    : 'Переназначение доступно только в ручном режиме.';

  return (
    <aside className="flex h-full w-full flex-col gap-4 overflow-y-auto rounded-[20px] bg-ink p-6">
      <div>
        <h2 className="flex items-center gap-3 font-display text-[28px] text-white">
          Заявка
          <span
            aria-hidden
            className={cn(
              'size-3 rounded-full',
              request.lifecycle === 'in_progress' ? 'bg-success' : 'bg-white/30',
            )}
          />
          {beside ? (
            <span className="ml-auto flex items-center gap-2">
              <StepButton
                icon={ChevronLeft}
                label={`Предыдущая ${BESIDE_NOUN[beside.of]}`}
                onClick={() => beside.onStep(-1)}
              />
              <span className="text-[16px] text-white/60 tabular-nums">
                {beside.index + 1}/{beside.total}
              </span>
              <StepButton
                icon={ChevronRight}
                label={`Следующая ${BESIDE_NOUN[beside.of]}`}
                onClick={() => beside.onStep(1)}
              />
            </span>
          ) : null}
        </h2>
        <p className="mt-1 text-[18px] text-white/70">{request.workTypeTitle}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-white/15 px-4 py-2 text-[15px] text-white">
          {skillTitle(request.requiredSkill)}
        </span>
        {request.priority === 'urgent' ? (
          <span className="rounded-full bg-accent px-4 py-2 font-semibold text-[15px] text-ink">
            Срочная
          </span>
        ) : null}
        <span className="rounded-full bg-white/15 px-4 py-2 text-[15px] text-white">
          {requestStatusTitle(request)}
        </span>
      </div>

      <Tile>{request.addressText}</Tile>
      <div className="grid grid-cols-2 gap-4">
        <Tile>{formatRange(request.windowStartAt, request.windowEndAt)}</Tile>
        <Tile>{request.region}</Tile>
      </div>

      <div className="rounded-2xl bg-white/10 p-5">
        <h3 className="font-display text-[20px] text-white">{explanation.title}</h3>

        <ul className="mt-3 space-y-2">
          {explanation.points.map((point) => (
            <li className="flex items-center gap-3 text-[15px] text-white" key={point}>
              {explanation.fromSearchOnly ? (
                <CircleHelp aria-hidden className="shrink-0 text-white/60" size={16} />
              ) : (
                <Check aria-hidden className="shrink-0" size={16} />
              )}
              <span>{point}</span>
            </li>
          ))}
        </ul>

        {explanation.note ? (
          <p className="mt-4 text-[13px] text-white/60">{explanation.note}</p>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-2">
        {mode === 'manual' && route && editableIndex !== -1 ? (
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-xl border border-white/70 px-3 py-2 text-[15px] text-white disabled:opacity-45"
              disabled={!canReorder || reorder.isPending || editableIndex === 0}
              onClick={() => moveInQueue(-1)}
              type="button"
            >
              Переместить раньше
            </button>
            <button
              className="flex-1 rounded-xl border border-white/70 px-3 py-2 text-[15px] text-white disabled:opacity-45"
              disabled={
                !canReorder || reorder.isPending || editableIndex === editableRequestIds.length - 1
              }
              onClick={() => moveInQueue(1)}
              type="button"
            >
              Переместить позже
            </button>
          </div>
        ) : null}

        {reorder.isError ? (
          <p className="text-[13px] text-danger" role="alert">
            {reorder.error.code === 'VERSION_CONFLICT'
              ? 'План изменился. Проверьте новый порядок и повторите действие.'
              : `Порядок не изменился: ${reorder.error.code}.`}
          </p>
        ) : null}

        {/*
         * The reason a disabled button is disabled belongs to that button, not to
         * a line of its own under it — and a disabled control receives no pointer
         * events, so the wrapper is what listens for the hover.
         */}
        <div className="group relative">
          <button
            className="h-[56px] w-full rounded-full bg-accent font-semibold text-[18px] text-ink transition-[transform,filter] duration-150 enabled:hover:scale-[1.02] enabled:hover:brightness-105 enabled:active:scale-[0.98] disabled:opacity-45"
            disabled={!canReassign || reassign.isPending}
            onClick={() => setPickerOpen((open) => !open)}
            type="button"
          >
            {reassign.isPending ? 'Переназначаем…' : 'Сменить пользователя'}
          </button>
          {!canReassign ? (
            <span
              className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-[260px] -translate-x-1/2 rounded-xl bg-white px-3 py-2 text-[13px] text-ink opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
              role="tooltip"
            >
              {reassignHint}
            </span>
          ) : null}
        </div>

        {pickerOpen && canReassign ? (
          <ul className="max-h-[220px] overflow-y-auto rounded-2xl bg-white/10 p-2">
            {engineers
              .filter((candidate) => candidate.id !== engineer?.id)
              .map((candidate) => (
                <li key={candidate.id}>
                  <button
                    className="w-full rounded-xl px-3 py-2 text-left text-[15px] text-white hover:bg-white/10"
                    onClick={() => {
                      if (modeVersion === null || planRevision === null) return;
                      reassign.mutate({
                        requestId: request.id,
                        engineerId: candidate.id,
                        expectedModeVersion: modeVersion,
                        expectedPlanRevision: planRevision,
                      });
                      setPickerOpen(false);
                    }}
                    type="button"
                  >
                    {candidate.displayName}
                    <span className="block text-[13px] text-white/50">
                      {candidate.skills.map(skillTitle).join(', ')}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        ) : null}

        {reassign.isError ? (
          <p className="text-[13px] text-danger" role="alert">
            {reassign.error.code === 'VERSION_CONFLICT'
              ? 'План изменился. Проверьте новый порядок и повторите перенос.'
              : `Переназначение не применилось: ${reassign.error.code}.`}
          </p>
        ) : null}

        <button
          className={cn(
            'h-[56px] rounded-full border border-white/70 font-semibold text-[18px] text-white',
            'transition-transform duration-150 enabled:active:scale-[0.99] disabled:opacity-45',
          )}
          disabled={!onExplain}
          onClick={onExplain}
          type="button"
        >
          Разобрать с AI ассистентом
        </button>
      </div>
    </aside>
  );
}
