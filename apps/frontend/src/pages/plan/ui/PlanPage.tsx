import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { useConversation } from '@/features/ai/ask-assistant';
import { failedWithoutData } from '@/shared/api';
import { fadeSoft, formatDayTitle, useMotionOn } from '@/shared/lib';
import { DayBoard } from '@/widgets/day-board';
import { DayMap } from '@/widgets/day-map';
import { RequestPanel } from '@/widgets/request-panel';
import { RouteTimeline } from '@/widgets/route-timeline';

export function PlanPage() {
  const navigate = useNavigate();
  const { explain } = useConversation();
  const motionOn = useMotionOn();
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

  /**
   * A request that a crew is carrying brings that crew with it.
   *
   * The two selections are one thought for the dispatcher — «эта заявка, вон у
   * той бригады» — so choosing the request and then hunting for its crew in the
   * list would be work the screen can do itself. An unassigned request leaves
   * the crew alone: there is none to show.
   */
  const carriedBy = selectedAssignment?.engineerId ?? null;
  useEffect(() => {
    if (carriedBy !== null) setSelectedEngineerId(carriedBy);
  }, [carriedBy]);

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

  /** Clicking bare map puts the board back to nothing chosen. */
  const clearSelection = () => {
    setSelectedRequestId(null);
    setSelectedEngineerId(null);
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
              onClearSelection={clearSelection}
              onSelectRequest={(id) => setSelectedRequestId(id)}
              requests={requests}
              route={activeRoute}
              selectedRequestId={selectedRequestId}
            />

            {/*
             * «Маршрут» grows upward when a crew is chosen: the map above gives
             * way, and the block's own bottom edge stays put. Keyed on the crew
             * rather than on its route — a crew with nothing planned still opens
             * the taller block, which then says so instead of staying shut.
             *
             * With nobody chosen it hugs its own content instead of holding a
             * fixed height: a line of text does not need a tall white box under
             * it, and reserving one only looks like something failed to load.
             */}
            <motion.div
              animate={{ height: activeEngineerId ? 360 : 'auto' }}
              className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              initial={false}
              transition={motionOn ? fadeSoft : { duration: 0 }}
            >
              <RouteTimeline
                engineerName={activeEngineer?.displayName ?? null}
                onSelectRequest={(id) => setSelectedRequestId(id)}
                planAsOf={plan?.planAsOf ?? null}
                requestsById={requestsById}
                route={activeRoute}
                selectedRequestId={selectedRequestId}
              />
            </motion.div>
          </div>

          {/*
           * The panel is not there until a request is: an empty dark column
           * would be a promise of something to read. It opens by width, so the
           * map and «Маршрут» are pushed aside rather than covered, and it is
           * keyed on nothing but its own presence — switching between requests
           * changes what it holds without replaying the slide.
           */}
          <AnimatePresence initial={false}>
            {selectedRequest ? (
              <motion.div
                animate={{ width: 420, opacity: 1 }}
                className="min-h-0 shrink-0 overflow-hidden"
                exit={{ width: 0, opacity: 0 }}
                initial={motionOn ? { width: 0, opacity: 0 } : false}
                key="request-panel"
                transition={motionOn ? fadeSoft : { duration: 0 }}
              >
                <div className="h-full w-[420px]">
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
                      plan?.routes.find(
                        (route) => route.engineerId === selectedAssignment?.engineerId,
                      ) ?? null
                    }
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
