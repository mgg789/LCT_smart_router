import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { unassignedRequests, useRequests } from '@/entities/request';
import { useConversation } from '@/features/ai/ask-assistant';
import { useStartWorkday } from '@/features/live/start-workday';
import { CorrectionReview, useAssistedCorrection } from '@/features/plan/assisted-correction';
import { failedWithoutData } from '@/shared/api';
import { fadeSoft, formatDayTitle, useElementSize, useMotionOn } from '@/shared/lib';
import { Button } from '@/shared/ui';
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
  const startWorkday = useStartWorkday();
  const correction = useAssistedCorrection();

  // Another section can hand the day a request to open — «К заявке» on an alert.
  const [searchParams] = useSearchParams();
  const [selectedEngineerId, setSelectedEngineerId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() =>
    searchParams.get('request'),
  );

  const engineers = engineersQuery.data?.engineers ?? [];
  const requests = requestsQuery.data?.requests ?? [];
  const plan = stateQuery.data?.plan ?? null;

  // «Маршрут» animates to the height of its own contents; this is that height.
  const routeRef = useRef<HTMLDivElement>(null);
  const routeSize = useElementSize(routeRef);

  const requestsById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests],
  );
  const correctionsState = correction.state.data;
  const activePins =
    correctionsState?.constraints.assignments.filter((row) => {
      const request = requestsById.get(row.requestId);
      return request?.lifecycle === 'submitted' && request.startedAt === null;
    }) ?? [];

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
  const selectedRoute =
    plan?.routes.find((route) => route.engineerId === selectedAssignment?.engineerId) ?? null;
  const editableRequestIds = (selectedRoute?.stops ?? []).flatMap((stop) => {
    if (stop.kind !== 'job' || !stop.requestId) return [];
    const request = requestsById.get(stop.requestId);
    return request?.lifecycle === 'submitted' &&
      request.startedAt === null &&
      request.completedAt === null &&
      request.cancelledAt === null &&
      (stateQuery.data?.mode !== 'assisted' ||
        Boolean(correctionsState?.editableRequestIds.includes(stop.requestId)))
      ? [stop.requestId]
      : [];
  });

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

      {correctionsState &&
      (correctionsState.mode === 'assisted' ||
        correctionsState.constraints.assignments.length ||
        correctionsState.pendingProposal ||
        correctionsState.blockers.length) ? (
        <aside
          className="mt-4 rounded-[20px] border border-ink/15 bg-surface p-4 text-[14px]"
          aria-label="Корректировки диспетчера"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 font-medium">
              {correctionsState.mode === 'manual'
                ? 'Аварийный MANUAL: автоматическое применение приостановлено.'
                : correctionsState.mode === 'assisted'
                  ? 'Корректировки включены. Автоматика продолжает планирование.'
                  : 'AUTO учитывает сохранённые закрепления.'}{' '}
              Активных закреплений: {activePins.length}.
            </p>
            {correctionsState.constraints.assignments.length ? (
              <Button
                className="w-auto"
                disabled={correction.busy || correctionsState.mode !== 'assisted'}
                onClick={() => correction.change({ kind: 'release_all' })}
              >
                Снять все закрепления
              </Button>
            ) : null}
          </div>
          {correctionsState.pendingProposal ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p>
                {correctionsState.pendingProposal.state === 'cancelled'
                  ? 'Предложение отклонено. Текущий план сохранён.'
                  : 'Есть предложение плана, ожидающее вашего решения.'}
              </p>
              <Button
                className="w-auto"
                disabled={correction.busy}
                onClick={correction.reviewPending}
              >
                Посмотреть последствия
              </Button>
            </div>
          ) : null}
          {correctionsState.blockers.length ? (
            <div className="mt-3 text-danger" role="alert">
              Закрепления больше не укладываются в доступный расчёт. Текущий план сохранён;
              проверьте доступность инженеров и условия заявок.
              <button
                className="ml-2 underline"
                disabled={correction.busy}
                onClick={() => correction.change({ kind: 'replan' })}
                type="button"
              >
                Пересчитать
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      {correction.busy ? (
        <p className="mt-3 text-[14px] text-ink/65" role="status">
          Проверяем последствия изменения…
        </p>
      ) : null}
      {correction.error && !correction.proposal ? (
        <p className="mt-3 text-[14px] text-danger" role="alert">
          {correction.error}
        </p>
      ) : null}

      {liveQuery.data?.workday.status === 'pending' ? (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-[20px] bg-surface p-4">
          <p className="text-[16px] text-ink">
            {liveQuery.data.workday.requestCount} заявок на сегодня. Смена ещё не запущена.
          </p>
          <button
            className="rounded-xl bg-accent px-5 py-3 text-[16px] font-semibold text-ink disabled:opacity-50"
            disabled={startWorkday.isPending}
            onClick={() => startWorkday.mutate()}
            type="button"
          >
            {startWorkday.isPending ? 'Запускаем день…' : 'Начать рабочий день'}
          </button>
          {startWorkday.isError ? (
            <p className="text-[14px] text-danger" role="alert">
              День не запустился: {startWorkday.error.code}. Проверьте состояние и повторите.
            </p>
          ) : null}
        </div>
      ) : null}

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
             * way, and the block's own bottom edge stays put.
             *
             * It is exactly as tall as what it holds, measured rather than
             * guessed: a fixed height left a band of empty white under the
             * timeline, and reading it off the content is the only way the
             * animation can end on the right number whether the block is showing
             * a full day, one line of text, or a crew with nothing planned.
             */}
            <motion.div
              animate={{ height: routeSize.height || 'auto' }}
              className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              initial={false}
              transition={motionOn ? fadeSoft : { duration: 0 }}
            >
              <div className="shrink-0" ref={routeRef}>
                <RouteTimeline
                  engineerName={activeEngineer?.displayName ?? null}
                  onSelectRequest={(id) => setSelectedRequestId(id)}
                  planAsOf={plan?.planAsOf ?? null}
                  requestsById={requestsById}
                  route={activeRoute}
                  selectedRequestId={selectedRequestId}
                />
              </div>
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
                    assistedBusy={correction.busy}
                    assistedEditable={Boolean(
                      selectedRequestId &&
                        correctionsState?.editableRequestIds.includes(selectedRequestId),
                    )}
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
                    editableRequestIds={editableRequestIds}
                    engineer={assignedEngineer}
                    engineers={engineers}
                    mode={stateQuery.data?.mode ?? null}
                    modeVersion={stateQuery.data?.modeVersion ?? null}
                    onAssistedChange={correction.change}
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
                    pinnedEngineerId={
                      correctionsState?.constraints.assignments.find(
                        (row) => row.requestId === selectedRequestId,
                      )?.engineerId
                    }
                    planRevision={stateQuery.data ? (plan?.revision ?? 0) : null}
                    request={selectedRequest}
                    route={selectedRoute}
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}
      {correction.proposal ? (
        <CorrectionReview
          proposal={correction.proposal}
          requests={requests}
          engineers={engineers}
          busy={correction.busy}
          error={correction.error}
          onConfirm={correction.confirm}
          onCancel={correction.cancel}
          onRecalculate={correction.recalculate}
        />
      ) : null}
    </div>
  );
}
