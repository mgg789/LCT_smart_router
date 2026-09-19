import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { formatDayTitle } from '@/shared/lib';
import { DayBoard } from '@/widgets/day-board';
import { RequestPanel } from '@/widgets/request-panel';
import { RouteTimeline } from '@/widgets/route-timeline';

/** Column widths measured off the mockup frame, which is drawn at 1:1. */
const MAP_PLACEHOLDER =
  'Карта появится следующим шагом: нужно решить, на какой подложке её рисовать.';

export function PlanPage() {
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();

  const [selectedEngineerId, setSelectedEngineerId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const engineers = engineersQuery.data?.engineers ?? [];
  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;

  const requestsById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests],
  );

  // Nothing is chosen for the dispatcher: the first crew of the plan is simply
  // the one whose route is on screen until they pick another.
  const activeEngineerId = selectedEngineerId ?? plan?.routes[0]?.engineerId ?? null;
  const activeEngineer = engineers.find((engineer) => engineer.id === activeEngineerId) ?? null;
  const activeRoute = plan?.routes.find((route) => route.engineerId === activeEngineerId) ?? null;

  const selectedRequest = selectedRequestId ? (requestsById.get(selectedRequestId) ?? null) : null;
  const selectedAssignment =
    plan?.assignments.find((assignment) => assignment.requestId === selectedRequestId) ?? null;
  const assignedEngineer =
    engineers.find((engineer) => engineer.id === selectedAssignment?.engineerId) ?? null;

  const loading = engineersQuery.isPending || requestsQuery.isPending || stateQuery.isPending;
  const failed = engineersQuery.isError || requestsQuery.isError || stateQuery.isError;

  const dayAnchor = plan?.planAsOf ?? requests[0]?.windowStartAt ?? null;

  const showFirstUnassigned = () => {
    const first = unassignedRequests(requests)[0];
    if (first) setSelectedRequestId(first.id);
  };

  if (failed) {
    return (
      <p className="pt-10 text-[16px] text-danger">
        Не удалось прочитать день. Проверьте, что System Layer запущен.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="font-display text-[32px] text-ink">
        {dayAnchor === null ? 'День' : formatDayTitle(dayAnchor)}
      </h1>

      {loading ? (
        <p className="pt-10 text-[16px] text-ink/55">Загружаем день…</p>
      ) : (
        <div className="mt-[26px] flex min-h-0 flex-1 gap-8">
          <DayBoard
            engineers={engineers}
            onSelectEngineer={(id) => setSelectedEngineerId(id)}
            onShowUnassigned={showFirstUnassigned}
            plan={plan}
            requests={requests}
            selectedEngineerId={activeEngineerId}
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-8">
            <div className="grid min-h-[280px] flex-1 place-items-center rounded-[20px] bg-surface p-6 text-center">
              <p className="max-w-[420px] text-[15px] text-ink/55">{MAP_PLACEHOLDER}</p>
            </div>

            <RouteTimeline
              engineerName={activeEngineer?.displayName ?? null}
              onSelectRequest={(id) => setSelectedRequestId(id)}
              planAsOf={plan?.planAsOf ?? null}
              requestsById={requestsById}
              route={activeRoute}
              selectedRequestId={selectedRequestId}
            />
          </div>

          <RequestPanel
            assignment={selectedAssignment}
            engineer={assignedEngineer}
            request={selectedRequest}
          />
        </div>
      )}
    </div>
  );
}
