import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { useConversation } from '@/features/ai/ask-assistant';
import { failedWithoutData } from '@/shared/api';
import { formatDayTitle } from '@/shared/lib';
import { DayBoard } from '@/widgets/day-board';
import { DayMap } from '@/widgets/day-map';
import { RequestPanel } from '@/widgets/request-panel';
import { RouteTimeline } from '@/widgets/route-timeline';

export function PlanPage() {
  const navigate = useNavigate();
  const { explain } = useConversation();
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();
  // Optional: without the LIVE day the crews simply show what is ahead of them,
  // so its failure does not take the day screen down with it.
  const liveQuery = useDispatchLive();

  // Another section can hand the day a request to open — «К заявке» on an alert.
  const [searchParams] = useSearchParams();
  const [selectedEngineerId, setSelectedEngineerId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() =>
    searchParams.get('request'),
  );

  const engineers = engineersQuery.data?.engineers ?? [];
  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;

  const requestsById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests],
  );

  // Nothing is chosen for the dispatcher. The day opens showing every request and
  // no route; a crew becomes active only when it is picked, and picking it again
  // clears it.
  const activeEngineerId = selectedEngineerId;
  const activeEngineer = engineers.find((engineer) => engineer.id === activeEngineerId) ?? null;
  const activeRoute = plan?.routes.find((route) => route.engineerId === activeEngineerId) ?? null;

  const selectedRequest = selectedRequestId ? (requestsById.get(selectedRequestId) ?? null) : null;
  const selectedAssignment =
    plan?.assignments.find((assignment) => assignment.requestId === selectedRequestId) ?? null;
  const assignedEngineer =
    engineers.find((engineer) => engineer.id === selectedAssignment?.engineerId) ?? null;

  const loading = engineersQuery.isPending || requestsQuery.isPending || stateQuery.isPending;
  const failed = [engineersQuery, requestsQuery, stateQuery].some(failedWithoutData);

  const dayAnchor = plan?.planAsOf ?? requests[0]?.windowStartAt ?? null;

  /**
   * The requests the arrows walk through, in the order the dispatcher sees them.
   *
   * Which list that is follows the request itself: one a crew is carrying belongs
   * to that crew's queue, in route order; one nobody took belongs to the
   * unassigned pile. Mixing them would let a step jump between two different
   * readings of the day.
   */
  const siblings = useMemo(() => {
    if (!selectedRequest) return [];
    // The plan lists a row for unassigned work too, with no engineer on it, so
    // the crew — not the presence of a row — is what says there is a queue.
    const carriedBy = selectedAssignment?.engineerId ?? null;
    if (carriedBy === null) return unassignedRequests(requests).map((request) => request.id);
    const route = plan?.routes.find((candidate) => candidate.engineerId === carriedBy);
    return (route?.stops ?? [])
      .filter((stop) => stop.kind === 'job' && stop.requestId !== null)
      .map((stop) => stop.requestId as string);
  }, [selectedRequest, selectedAssignment, plan, requests]);

  /** Moves to the next or previous sibling, wrapping so the ends meet. */
  const stepRequest = (delta: -1 | 1) => {
    if (siblings.length === 0) return;
    const at = siblings.indexOf(selectedRequestId ?? '');
    const next = at < 0 ? 0 : (at + delta + siblings.length) % siblings.length;
    setSelectedRequestId(siblings[next] ?? null);
  };

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
            live={liveQuery.data ?? null}
            onSelectEngineer={(id) =>
              setSelectedEngineerId((current) => (current === id ? null : id))
            }
            onShowUnassigned={showFirstUnassigned}
            plan={plan}
            requests={requests}
            selectedEngineerId={activeEngineerId}
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-8">
            <DayMap
              onSelectRequest={(id) => setSelectedRequestId(id)}
              requests={requests}
              route={activeRoute}
              selectedRequestId={selectedRequestId}
            />

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
            beside={
              siblings.length > 1
                ? {
                    index: Math.max(0, siblings.indexOf(selectedRequestId ?? '')),
                    total: siblings.length,
                    of: selectedAssignment?.engineerId ? 'queue' : 'unassigned',
                    onStep: stepRequest,
                  }
                : undefined
            }
            engineer={assignedEngineer}
            engineers={engineers}
            mode={stateQuery.data?.mode ?? null}
            onExplain={
              selectedRequest
                ? () => {
                    void explain(
                      { scope: 'request', requestId: selectedRequest.id },
                      `Разобрать заявку: ${selectedRequest.addressText ?? selectedRequest.id}`,
                    );
                    navigate(ROUTES.ai);
                  }
                : undefined
            }
            request={selectedRequest}
            route={
              plan?.routes.find((route) => route.engineerId === selectedAssignment?.engineerId) ??
              null
            }
          />
        </div>
      )}
    </div>
  );
}
