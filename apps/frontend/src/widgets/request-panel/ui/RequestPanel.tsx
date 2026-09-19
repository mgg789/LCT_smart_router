import { Check, CircleHelp } from 'lucide-react';
import type { EngineerView } from '@/entities/engineer';
import type { PlanAssignmentView } from '@/entities/plan';
import { reasonIsProof, reasonText } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { requestStatusTitle, skillTitle } from '@/entities/request';
import { formatRange } from '@/shared/lib';

export interface RequestPanelProps {
  request: RequestView | null;
  assignment: PlanAssignmentView | null;
  engineer: EngineerView | null;
}

/** Inner tile of the dark panel. */
function Field({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl bg-white/15 px-5 py-4 text-[18px] text-white">{children}</div>;
}

/**
 * Right panel of the day: the selected request and why the router placed it the
 * way it did.
 *
 * The explanation is assembled from the solver's reason codes, never written by
 * hand, and it says plainly when a reason is the outcome of a limited search
 * rather than a checked constraint.
 */
export function RequestPanel({ request, assignment, engineer }: RequestPanelProps) {
  if (!request) {
    return (
      <aside className="flex h-full shrink basis-[485px] min-w-[320px] items-center justify-center rounded-[20px] bg-ink p-6 text-center">
        <p className="text-[16px] text-white/60">Выберите заявку на карте или в списке.</p>
      </aside>
    );
  }

  const reasons = assignment?.reasons ?? [];
  const unassigned = request.assignmentState === 'unassigned';

  return (
    <aside className="flex h-full shrink basis-[485px] min-w-[320px] flex-col gap-4 overflow-y-auto rounded-[20px] bg-ink p-6">
      <div>
        <h2 className="font-display text-[28px] text-white">Заявка</h2>
        <p className="mt-1 text-[18px] text-white/70">{request.workTypeTitle}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-white/15 px-4 py-2 text-[15px] text-white">
          {skillTitle(request.requiredSkill)}
        </span>
        {request.priority === 'urgent' ? (
          <span className="rounded-full bg-accent px-4 py-2 text-[15px] font-semibold text-ink">
            Срочная
          </span>
        ) : null}
        <span className="rounded-full bg-white/15 px-4 py-2 text-[15px] text-white">
          {requestStatusTitle(request)}
        </span>
      </div>

      <Field>{request.addressText}</Field>
      <Field>{formatRange(request.windowStartAt, request.windowEndAt)}</Field>

      <div className="rounded-2xl bg-white/10 p-5">
        <h3 className="font-display text-[20px] text-white">
          {unassigned
            ? 'Почему без назначения?'
            : `Почему ${engineer?.displayName ?? 'эта бригада'}?`}
        </h3>

        {reasons.length === 0 ? (
          <p className="mt-3 text-[15px] text-white/60">
            Решатель не прислал причин для этой заявки.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {reasons.map((reason) => (
              <li className="flex items-start gap-3 text-[16px] text-white" key={reason.code}>
                {reasonIsProof(reason) ? (
                  <Check aria-hidden className="mt-1 shrink-0" size={18} />
                ) : (
                  <CircleHelp aria-hidden className="mt-1 shrink-0 text-white/60" size={18} />
                )}
                <span>
                  {reasonText(reason)}
                  {reasonIsProof(reason) ? null : (
                    <span className="block text-[13px] text-white/50">
                      исход ограниченного поиска, не доказательство
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
