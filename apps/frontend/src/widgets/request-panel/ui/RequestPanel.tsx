import { Check, CircleHelp } from 'lucide-react';
import { useState } from 'react';
import type { EngineerView } from '@/entities/engineer';
import type { DispatchMode, PlanAssignmentView, PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { requestStatusTitle, skillTitle } from '@/entities/request';
import { useReassignRequest } from '@/features/plan/reassign-request';
import { cn, formatRange } from '@/shared/lib';
import { explainRequest } from '../model/explainRequest';

export interface RequestPanelProps {
  request: RequestView | null;
  assignment: PlanAssignmentView | null;
  engineer: EngineerView | null;
  route: PlanRouteView | null;
  engineers: EngineerView[];
  mode: DispatchMode | null;
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
export function RequestPanel({
  request,
  assignment,
  engineer,
  route,
  engineers,
  mode,
}: RequestPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const reassign = useReassignRequest();

  if (!request) {
    return (
      <aside className="flex h-full min-w-[320px] shrink basis-[485px] items-center justify-center rounded-[20px] bg-ink p-6 text-center">
        <p className="text-[16px] text-white/60">Выберите заявку на карте или в списке.</p>
      </aside>
    );
  }

  const explanation = explainRequest(request, assignment, engineer, route, engineers);
  const started = request.startedAt !== null;
  const canReassign = mode === 'manual' && !started;
  const reassignHint = started
    ? 'Работа уже начата — переназначение закрыто.'
    : 'Переназначение доступно только в ручном режиме.';

  return (
    <aside className="flex h-full min-w-[320px] shrink basis-[485px] flex-col gap-4 overflow-y-auto rounded-[20px] bg-ink p-6">
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
          {explanation.facts.map((fact) => (
            <li className="flex items-start gap-3 text-[15px] text-white" key={fact}>
              {explanation.fromSearchOnly ? (
                <CircleHelp aria-hidden className="mt-1 shrink-0 text-white/60" size={16} />
              ) : (
                <Check aria-hidden className="mt-1 shrink-0" size={16} />
              )}
              <span>{fact}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[15px] text-white/75">{explanation.influence}</p>
        <p className="mt-3 font-semibold text-[16px] text-white">{explanation.result}</p>
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-2">
        <button
          className="h-[56px] rounded-full bg-accent font-semibold text-[18px] text-ink disabled:opacity-45"
          disabled={!canReassign || reassign.isPending}
          onClick={() => setPickerOpen((open) => !open)}
          title={canReassign ? undefined : reassignHint}
          type="button"
        >
          {reassign.isPending ? 'Переназначаем…' : 'Сменить пользователя'}
        </button>
        {!canReassign ? <p className="text-[13px] text-white/50">{reassignHint}</p> : null}

        {pickerOpen && canReassign ? (
          <ul className="max-h-[220px] overflow-y-auto rounded-2xl bg-white/10 p-2">
            {engineers
              .filter((candidate) => candidate.id !== engineer?.id)
              .map((candidate) => (
                <li key={candidate.id}>
                  <button
                    className="w-full rounded-xl px-3 py-2 text-left text-[15px] text-white hover:bg-white/10"
                    onClick={() => {
                      reassign.mutate({ requestId: request.id, engineerId: candidate.id });
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
            Переназначение не применилось: {reassign.error.code}.
          </p>
        ) : null}

        <button
          className="h-[56px] rounded-full border border-white/70 font-semibold text-[18px] text-white disabled:opacity-45"
          disabled
          title="AI-ассистента нет: контракта на него в System Layer не существует"
          type="button"
        >
          Разобрать с AI ассистентом
        </button>
        <p className="text-[13px] text-white/50">
          AI-ассистента пока нет: System Layer не отдаёт такого контракта.
        </p>
      </div>
    </aside>
  );
}
