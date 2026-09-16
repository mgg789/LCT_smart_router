import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { DayMap } from '../components/DayMap';
import { PolicyModal } from '../components/PolicyModal';
import { RouteTimeline } from '../components/RouteTimeline';
import { activityLabel, plannedActivity } from '../domain/dashboard';
import { useDashboard } from '../hooks/useDashboard';
import { factorLabel, initials, POLICY_LABELS } from '../lib/reasons';
import { formatClock, formatDayTitle, formatDurationMin, formatKm } from '../lib/time';

const NAV = [
  { id: 'day', label: 'План дня', active: true },
  { id: 'requests', label: 'Заявки', active: false },
  { id: 'engineers', label: 'Инженеры', active: false },
  { id: 'alerts', label: 'Алерты', active: false },
  { id: 'policy', label: 'Политика', active: false },
  { id: 'chats', label: 'Чаты', active: false },
  { id: 'ai', label: 'AI', active: false },
] as const;

export function DashboardPage() {
  const dash = useDashboard();
  const { snapshot } = dash;
  const [policyOpen, setPolicyOpen] = useState(false);
  const assignedCount = snapshot.requests.length - dash.unassigned.length;

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <aside className="flex w-16 flex-col items-center border-r border-line bg-white py-4">
        <img src="/beeline-symbol.png" alt="Beeline" className="mb-8 h-8 w-8" />
        <nav className="flex flex-1 flex-col gap-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              className={`flex h-10 w-10 items-center justify-center rounded-xl text-[11px] font-semibold ${
                item.active ? 'bg-ink text-white' : 'text-muted hover:bg-canvas'
              }`}
            >
              {item.label.slice(0, 2)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 px-5 py-3">
          <button
            type="button"
            onClick={() => setPolicyOpen(true)}
            className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-sm"
          >
            <span className="text-muted">Политика</span>
            <span className="font-medium">
              {POLICY_LABELS[snapshot.policyId] ?? snapshot.policyId}
            </span>
            <span className="text-muted">· обед {snapshot.lunchesEnabled ? 'вкл' : 'выкл'}</span>
          </button>
          <PolicyModal
            open={policyOpen}
            policyId={snapshot.policyId}
            lunchesEnabled={snapshot.lunchesEnabled}
            policies={snapshot.policies}
            onClose={() => setPolicyOpen(false)}
            onApply={dash.applyRoutingSettings}
          />
          <span className="text-[12px] text-muted">
            План пересобирается сам: новая заявка, смена политики, факт с линии
          </span>
          <span className="rounded-full border border-line bg-white px-3 py-1.5 text-sm">
            {snapshot.plan.mode.toUpperCase()}
          </span>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_360px] gap-4 px-4 pb-4">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
            <h1 className="text-[22px] font-semibold">{formatDayTitle(snapshot.workDate)}</h1>
            <p className="mt-1 text-sm text-muted">
              {snapshot.requests.length} заявки · {assignedCount} назначены ·{' '}
              {dash.unassigned.length} без назначения
            </p>
            <p className="text-sm text-muted">
              План от {formatClock(snapshot.plan.plan?.planAsOf ?? snapshot.nowAt)}
              {dash.rebuilding ? ' · перестраивается' : ''}
            </p>
            {dash.events[0] ? (
              <p className="mt-2 text-[12px] text-muted">{dash.events[0].text}</p>
            ) : null}

            <div className="mt-5 flex items-center justify-between text-sm">
              <span className="font-medium">Инженеры · {dash.engineers.length}</span>
              {dash.selectedEngineerId ? (
                <button
                  type="button"
                  onClick={dash.clearFocus}
                  className="text-[12px] text-muted hover:text-ink"
                >
                  Все маршруты
                </button>
              ) : null}
            </div>
            <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-auto">
              {dash.engineers.map((engineer) => {
                const selected = engineer.engineerId === dash.selectedEngineerId;
                const activity = plannedActivity(snapshot, engineer.engineerId);
                return (
                  <li key={engineer.engineerId}>
                    <button
                      type="button"
                      onClick={() => dash.selectEngineer(engineer.engineerId)}
                      className={`flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left ${
                        selected ? 'bg-canvas' : 'hover:bg-canvas/70'
                      }`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-line text-xs font-semibold">
                        {initials(engineer.displayName)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{engineer.displayName}</span>
                          <span className="text-sm text-muted">
                            {formatKm(engineer.distanceKm)}
                          </span>
                        </span>
                        <span className="block text-[13px] text-muted">
                          {activity ? activityLabel(activity.kind) : 'нет плана'} ·{' '}
                          {engineer.assignedCount} заявок
                        </span>
                        <span className="block text-[12px] text-muted">
                          {engineer.shiftStartAt && engineer.shiftEndAt
                            ? `${formatClock(engineer.shiftStartAt)}–${formatClock(engineer.shiftEndAt)}`
                            : 'смена не задана'}{' '}
                          · выполнено {engineer.doneCount}/{engineer.assignedCount}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {dash.unassigned.length > 0 ? (
              <div className="mt-3 rounded-2xl bg-bee px-3 py-3">
                <div className="px-1 font-semibold">
                  {dash.unassigned.length} заявки без назначения
                </div>
                <div className="px-1 text-sm">Нет инженера с нужным навыком</div>
                <ul className="mt-2 space-y-1">
                  {dash.unassigned.map((request) => {
                    const selected = request.id === dash.selectedRequest?.id;
                    return (
                      <li key={request.id}>
                        <button
                          type="button"
                          onClick={() => dash.selectRequest(request.id)}
                          className={`w-full rounded-xl px-2 py-2 text-left text-sm ${
                            selected ? 'bg-white' : 'hover:bg-white/50'
                          }`}
                        >
                          <span className="font-medium">№{request.id}</span>
                          <span className="block text-[12px]">
                            {request.workTypeTitle} · {request.addressText}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="flex min-h-0 flex-col gap-4">
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-sm">
              <DayMap
                snapshot={snapshot}
                selectedEngineerId={dash.selectedEngineerId}
                selectedRequestId={dash.selectedRequest?.id ?? null}
                onSelectRequest={dash.selectRequest}
              />
              <AnimatePresence>
                {dash.rebuilding ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute left-4 top-4 rounded-full bg-white px-4 py-2 text-sm shadow"
                  >
                    Перестраивается…
                  </motion.div>
                ) : null}
                {dash.pendingDelta ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="absolute left-4 top-4 max-w-md rounded-2xl bg-white p-4 shadow-lg"
                  >
                    <p className="text-sm font-semibold">
                      План пересобран за {dash.pendingDelta.solveMs} мс
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {dash.pendingDelta.transferred} переданы · {dash.pendingDelta.shifted}{' '}
                      сдвинуты · риски SLA {dash.pendingDelta.slaBefore} →{' '}
                      {dash.pendingDelta.slaAfter}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={dash.acceptDelta}
                        className="rounded-full bg-bee px-3 py-1.5 text-sm font-semibold"
                      >
                        Принять
                      </button>
                      <button
                        type="button"
                        onClick={dash.rejectDelta}
                        className="rounded-full border border-line px-3 py-1.5 text-sm"
                      >
                        Отменить
                      </button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <RouteTimeline
              snapshot={snapshot}
              engineerName={dash.selectedEngineer?.displayName ?? 'инженера'}
              route={dash.selectedRoute}
              selectedRequestId={dash.selectedRequest?.id ?? null}
              onSelectRequest={dash.selectRequest}
            />
          </section>

          <RequestPanel dash={dash} />
        </div>
      </div>
    </div>
  );
}

function RequestPanel({ dash }: { readonly dash: ReturnType<typeof useDashboard> }) {
  const request = dash.selectedRequest;
  const assignment = dash.selectedAssignment;
  const engineer = dash.snapshot.engineers.find((item) => item.id === assignment?.engineerId);
  const reasons = assignment?.reasons.assignment;

  if (!request) {
    return (
      <aside className="rounded-2xl bg-panel p-5 text-white">
        <p className="text-[13px] text-white/50">Общий план</p>
        <h2 className="mt-2 text-[22px] font-semibold leading-7">Все маршруты дня</h2>
        <p className="mt-3 text-sm text-white/70">
          На карте все инженеры. Клик по заявке или человеку открывает один маршрут.
        </p>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-panel p-5 text-white">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-white/50">Заявка №{request.id}</p>
          <h2 className="mt-1 text-[22px] font-semibold leading-7">{request.workTypeTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/10 px-2 py-1 text-[12px]">
            {assignment?.status === 'unassigned' ? 'Без назначения' : 'Назначена'}
          </span>
          <button
            type="button"
            onClick={dash.clearFocus}
            aria-label="Закрыть заявку и показать общий план"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-lg leading-none text-white/80 hover:bg-white/20"
          >
            ×
          </button>
        </div>
      </div>
      {dash.unassignedIndex >= 0 ? (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-white/10 px-3 py-2 text-sm">
          <button
            type="button"
            onClick={() => dash.selectUnassignedOffset(-1)}
            className="px-1"
            aria-label="Предыдущая неназначенная"
          >
            ‹
          </button>
          <span>
            {dash.unassignedIndex + 1} из {dash.unassigned.length} без назначения
          </span>
          <button
            type="button"
            onClick={() => dash.selectUnassignedOffset(1)}
            className="px-1"
            aria-label="Следующая неназначенная"
          >
            ›
          </button>
        </div>
      ) : null}

      <div className="mt-4 flex gap-2 text-[12px]">
        <span className="rounded-full bg-white/10 px-3 py-1">{request.workTypeTitle}</span>
        <span className="rounded-full bg-white/10 px-3 py-1">
          {request.priority === 'urgent' ? 'Срочная' : 'Обычная'}
        </span>
      </div>

      <div className="mt-5 space-y-3 text-sm">
        <p>{request.contactName}</p>
        <p className="text-white/70">
          {request.addressText} · {formatClock(request.windowStartAt)}–
          {formatClock(request.windowEndAt)}
        </p>
        <p className="text-white/70">
          Длительность {formatDurationMin(request.serviceDurationSec)}
        </p>
      </div>

      <div className="mt-6 min-h-0 flex-1 overflow-auto">
        <h3 className="text-[17px] font-semibold">
          {assignment?.status === 'unassigned'
            ? 'Почему без назначения'
            : `Почему ${engineer?.displayName.split(' ')[0] ?? 'этот инженер'}?`}
        </h3>
        <ul className="mt-3 space-y-3 text-sm text-white/80">
          {(reasons?.factors ?? []).map((factor) => (
            <li key={factor.code}>
              <span className="font-medium text-white">{factorLabel(factor.code)}</span>
              <span className="block text-white/70">{factor.detail}</span>
            </li>
          ))}
        </ul>
        {reasons?.alternatives.length ? (
          <details className="mt-4 text-sm text-white/70">
            <summary className="cursor-pointer text-white">Другие кандидаты</summary>
            <ul className="mt-2 space-y-2">
              {reasons.alternatives.map((item) => (
                <li key={item.engineerId}>
                  {dash.snapshot.engineers.find((eng) => eng.id === item.engineerId)?.displayName ??
                    item.engineerId}
                  : {item.whyNot}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={() => dash.setMode(dash.snapshot.plan.mode === 'auto' ? 'manual' : 'auto')}
          className="w-full rounded-full bg-bee py-3 text-sm font-semibold text-ink"
        >
          {dash.snapshot.plan.mode === 'auto'
            ? 'Сменить исполнителя — нужен MANUAL'
            : 'Вернуться в AUTO'}
        </button>
        <button
          type="button"
          disabled
          className="w-full rounded-full border border-white/20 py-3 text-sm text-white/40"
        >
          Разобрать с ассистентом — нет API
        </button>
      </div>
    </aside>
  );
}
