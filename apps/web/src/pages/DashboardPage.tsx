import { AnimatePresence, motion } from 'framer-motion';
import { BellRing, HardHat, Map as MapIcon, Plus, Settings, ShieldCog } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { LiveEngineerState, LiveWorkday } from '../api/live';
import type { EquipmentType } from '../api/types';
import { AlertsPage } from '../components/AlertsPage';
import { AlertToasts } from '../components/AlertToasts';
import { ApiTokensPage } from '../components/ApiTokensPage';
import { DataUploadModal } from '../components/DataUploadModal';
import { DayMap } from '../components/DayMap';
import { EngineersPage } from '../components/EngineersPage';
import { PolicyComparisonPage } from '../components/PolicyComparisonPage';
import { PolicyModal } from '../components/PolicyModal';
import { RouteTimeline } from '../components/RouteTimeline';
import { isOpenAlert } from '../domain/alerts';
import {
  assignmentFor,
  engineerSummaries,
  regionalDistanceKm,
  unassignedRequests,
} from '../domain/dashboard';
import {
  ALL_REGIONS,
  filterSnapshotByRegion,
  type RegionSelection,
  regionOptions,
} from '../domain/regions';
import { useDashboard } from '../hooks/useDashboard';
import { type CaseExplanation, explainSelection } from '../lib/explanations';
import {
  factorLabel,
  initials,
  modeLabel,
  POLICY_LABELS,
  skillLabel,
  transportLabel,
} from '../lib/reasons';
import { formatClock, formatDayTitle, formatDurationMin, formatKm } from '../lib/time';

const NAV = [
  { id: 'day', label: 'План дня', icon: MapIcon },
  { id: 'policies', label: 'Политики', icon: ShieldCog },
  { id: 'engineers', label: 'Инженеры', icon: HardHat },
  { id: 'alerts', label: 'Алерты', icon: BellRing },
  { id: 'settings', label: 'Настройки', icon: Settings },
] as const;

type DashboardTab = (typeof NAV)[number]['id'];

export function DashboardPage() {
  const dash = useDashboard();
  const { snapshot } = dash;
  const [policyOpen, setPolicyOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>('day');
  const [selectedRegion, setSelectedRegion] = useState<RegionSelection>(ALL_REGIONS);

  const regions = useMemo(() => (snapshot ? regionOptions(snapshot) : []), [snapshot]);
  const visibleSnapshot = useMemo(
    () => (snapshot ? filterSnapshotByRegion(snapshot, selectedRegion) : null),
    [selectedRegion, snapshot],
  );
  const liveEngineers = useMemo(
    () => new Map(dash.liveWorkday?.engineers.map((engineer) => [engineer.id, engineer]) ?? []),
    [dash.liveWorkday],
  );

  useEffect(() => {
    if (selectedRegion !== ALL_REGIONS && !regions.some((region) => region.id === selectedRegion)) {
      setSelectedRegion(ALL_REGIONS);
      dash.clearFocus();
    }
  }, [dash.clearFocus, regions, selectedRegion]);

  if (!dash.authenticated) {
    return (
      <div>
        <LoginScreen
          loading={dash.loading}
          error={dash.error}
          onPassword={dash.signIn}
          onRequestCode={dash.requestLoginCode}
          onCode={dash.signInWithCode}
        />
        <div className="fixed bottom-8 inset-x-0 text-center">
          <button
            type="button"
            onClick={() => dash.selectDemoScenario('initial')}
            className="rounded-full bg-bee px-5 py-3 font-semibold"
          >
            Открыть автономный демо-сценарий
          </button>
        </div>
      </div>
    );
  }

  if (dash.liveLoading && !dash.liveWorkday) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-sm text-muted">
        Загружаем состояние рабочего дня…
      </div>
    );
  }

  if (dash.liveWorkday?.workday.status === 'pending') {
    return (
      <>
        <WorkdayStartScreen
          workday={dash.liveWorkday.workday}
          loading={dash.startingWorkday}
          error={dash.error}
          onStart={() => void dash.startWorkday()}
          onPrepare={() => setUploadOpen(true)}
          onSignOut={() => void dash.signOut()}
        />
        <DataUploadModal
          open={uploadOpen}
          submitting={dash.uploadingData}
          existingRegions={regions.map((region) => region.id)}
          onClose={() => setUploadOpen(false)}
          onUpload={dash.uploadDataset}
          onImportOfficial={dash.importOfficialTzDataset}
        />
      </>
    );
  }

  if (!snapshot || !visibleSnapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-sm text-muted">
        {dash.error ? (
          <div className="max-w-md rounded-2xl bg-white p-6 text-center shadow-sm">
            <p className="text-ink">Не удалось загрузить рабочий день</p>
            <p className="mt-2">{dash.error}</p>
            <button
              type="button"
              onClick={() => void dash.refresh()}
              className="mt-4 rounded-full bg-bee px-4 py-2 font-semibold text-ink"
            >
              Повторить
            </button>
            <button
              type="button"
              onClick={() => dash.selectDemoScenario('initial')}
              className="mt-4 ml-3 underline"
            >
              Открыть демо
            </button>
          </div>
        ) : (
          'Загружаем рабочий день…'
        )}
      </div>
    );
  }

  const assignedCount =
    visibleSnapshot.plan.plan?.assignments.filter((item) => item.status === 'assigned').length ?? 0;
  const projectedCoordinateCount = visibleSnapshot.requests.filter(
    (request) => request.geocodeQuality === 'district_centroid_projection',
  ).length;
  const visibleEngineers = engineerSummaries(visibleSnapshot);
  const visibleUnassigned = unassignedRequests(visibleSnapshot);
  const regionMileageKm = regionalDistanceKm(visibleEngineers);

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <aside className="flex w-16 flex-col items-center border-r border-line bg-white py-4">
        <img src="/beeline-symbol.png" alt="Beeline" className="mb-8 h-8 w-8" />
        <nav className="flex flex-1 flex-col gap-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                title={item.label}
                aria-label={item.label}
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => {
                  setActiveTab(item.id);
                  if (item.id === 'policies') {
                    void dash.refreshPolicyComparison();
                  }
                }}
                className={`relative flex h-10 w-10 items-center justify-center rounded-xl ${
                  activeTab === item.id ? 'bg-ink text-white' : 'text-muted hover:bg-canvas'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={1.8} />
                {item.id === 'alerts' && snapshot.alerts.some(isOpenAlert) && (
                  <span className="absolute -right-1 -top-1 rounded-full bg-bee px-1 text-xs font-semibold text-ink">
                    {snapshot.alerts.filter(isOpenAlert).length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          title="Загрузить данные или датасет из ТЗ"
          aria-label="Загрузить датасет из ТЗ или свой файл"
          disabled={dash.writesDisabled}
          onClick={() => setUploadOpen(true)}
          className="mt-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line text-muted hover:bg-canvas hover:text-ink"
        >
          <Plus className="h-5 w-5" />
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 px-5 py-3 max-sm:flex-wrap">
          {dash.liveWorkday?.workday.status === 'running' ? (
            <div className="mr-auto flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              LIVE · {formatClock(dash.liveWorkday.workday.liveNow)}
              {dash.liveWorkday.workday.speedDurationSec ? ' · ускоренный день' : ''}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setPolicyOpen(true)}
            disabled={dash.writesDisabled}
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
            routerSettings={snapshot.routerSettings}
            policies={snapshot.policies}
            onClose={() => setPolicyOpen(false)}
            onApply={dash.applyRoutingSettings}
          />
          <DataUploadModal
            open={uploadOpen}
            submitting={dash.uploadingData}
            existingRegions={regions.map((region) => region.id)}
            onClose={() => setUploadOpen(false)}
            onUpload={dash.uploadDataset}
            onImportOfficial={dash.importOfficialTzDataset}
          />
          <button
            type="button"
            disabled={dash.rebuilding || dash.writesDisabled}
            title={
              snapshot.plan.mode === 'auto'
                ? 'Перейти в ручной режим'
                : 'Вернуть автоматический режим'
            }
            onClick={() => void dash.setMode(snapshot.plan.mode === 'auto' ? 'manual' : 'auto')}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {modeLabel(snapshot.plan.mode)}
          </button>
          <button
            type="button"
            onClick={() => void dash.signOut()}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-sm text-muted"
          >
            Выйти
          </button>
        </header>

        {dash.error ? (
          <div className="mx-4 mb-3 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">
            {dash.error}
          </div>
        ) : null}

        {activeTab === 'day' ? (
          <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_360px] gap-4 px-4 pb-4 max-xl:grid-cols-1 max-xl:auto-rows-[minmax(420px,auto)] max-xl:overflow-y-auto">
            <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <label htmlFor="region-select" className="text-[12px] font-medium text-muted">
                  Регион
                </label>
                <select
                  id="region-select"
                  value={selectedRegion}
                  onChange={(event) => {
                    setSelectedRegion(event.target.value);
                    dash.clearFocus();
                  }}
                  className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm font-medium outline-none focus:border-ink"
                >
                  <option value={ALL_REGIONS}>
                    Все регионы · {snapshot.requests.length} заявок
                  </option>
                  {regions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label} · {region.requestCount} заявок
                    </option>
                  ))}
                </select>
                <fieldset className="mt-2 flex flex-wrap gap-1.5" aria-label="Цвета регионов">
                  {regions.map((region) => (
                    <span
                      key={region.id}
                      className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1 text-[11px] text-muted"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: region.color }}
                      />
                      {region.label}
                    </span>
                  ))}
                </fieldset>
                <h1 className="mt-4 text-[22px] font-semibold">
                  {formatDayTitle(snapshot.workDate)}
                </h1>
                <p className="mt-1 text-sm text-muted">
                  {visibleSnapshot.requests.length} заявки · {assignedCount} назначены ·{' '}
                  {visibleUnassigned.length} без назначения · {formatKm(regionMileageKm)} суммарный
                  пробег
                </p>
                <p className="text-sm text-muted">
                  План от {formatClock(snapshot.plan.plan?.planAsOf ?? snapshot.nowAt)}
                  {dash.rebuilding ? ' · перестраивается' : ''}
                </p>
                {dash.events.length > 0 ? (
                  <div className="mt-2 space-y-1" aria-live="polite">
                    {dash.events.slice(0, 3).map((event) => (
                      <p key={event.id} className="text-[12px] text-muted">
                        {event.text}
                      </p>
                    ))}
                  </div>
                ) : null}
                {projectedCoordinateCount > 0 ? (
                  <div className="mt-3 rounded-xl bg-canvas px-3 py-2 text-[12px] leading-5 text-muted">
                    <span className="font-medium text-ink">
                      {projectedCoordinateCount} точек по центроидам районов.
                    </span>{' '}
                    Это расчётные координаты набора, а не подтверждённые адресные точки.
                  </div>
                ) : null}

                <div className="mt-5 flex items-center justify-between text-sm">
                  <span className="font-medium">Инженеры · {visibleEngineers.length}</span>
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
                <ul className="mt-2 space-y-1">
                  {visibleEngineers.map((engineer) => {
                    const selected = engineer.engineerId === dash.selectedEngineerId;
                    const liveState = liveEngineers.get(engineer.engineerId);
                    const completedCount = dash.liveWorkday
                      ? dash.liveWorkday.history.filter(
                          (item) =>
                            item.engineerId === engineer.engineerId && item.outcome === 'completed',
                        ).length
                      : engineer.doneCount;
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
                              План: {engineer.assignedCount} заявок ·{' '}
                              {transportLabel(engineer.transportType)}
                            </span>
                            <span className="block text-[12px] text-muted">
                              Навыки: {engineer.skills.map(skillLabel).join(', ') || 'не указаны'}
                            </span>
                            <span className="block text-[12px] text-muted">
                              {engineer.shiftStartAt && engineer.shiftEndAt
                                ? `${formatClock(engineer.shiftStartAt)}–${formatClock(engineer.shiftEndAt)}`
                                : 'смена не задана'}{' '}
                              · выполнено {completedCount}
                            </span>
                            {liveState ? <LiveEngineerPipeline state={liveState} /> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {visibleEngineers.length === 0 ? (
                  <div className="mt-3 rounded-2xl bg-canvas px-3 py-4 text-sm text-muted">
                    В выбранном регионе пока нет инженеров.
                  </div>
                ) : null}

                {visibleUnassigned.length > 0 ? (
                  <div className="mt-3 rounded-2xl bg-bee px-3 py-3">
                    <div className="px-1 font-semibold">
                      {visibleUnassigned.length} заявки без назначения
                    </div>
                    <div className="px-1 text-sm">Точная причина — в карточке заявки</div>
                    <ul className="mt-2 space-y-1">
                      {visibleUnassigned.map((request) => {
                        const selected = request.id === dash.selectedRequest?.id;
                        const reasonCode = assignmentFor(visibleSnapshot, request.id)?.reasons
                          .assignment?.factors[0]?.code;
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
                              {reasonCode ? (
                                <span className="mt-1 block text-[12px] text-ink/70">
                                  {factorLabel(reasonCode)}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="flex min-h-0 flex-col gap-4 max-xl:min-h-[560px]">
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-sm">
                <DayMap
                  snapshot={visibleSnapshot}
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
                        {dash.isDemo
                          ? 'Изменения между записанными сценариями'
                          : `План пересобран за ${dash.pendingDelta.solveMs} мс`}
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        {dash.pendingDelta.transferred} переданы · {dash.pendingDelta.shifted}{' '}
                        сдвинуты · риски окон {dash.pendingDelta.slaBefore} →{' '}
                        {dash.pendingDelta.slaAfter}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={dash.acceptDelta}
                          className="rounded-full bg-bee px-3 py-1.5 text-sm font-semibold"
                        >
                          Просмотрено
                        </button>
                        {dash.canRejectDelta ? (
                          <button
                            type="button"
                            onClick={dash.rejectDelta}
                            className="rounded-full border border-line px-3 py-1.5 text-sm"
                          >
                            Вернуть прежние настройки
                          </button>
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <RouteTimeline
                snapshot={visibleSnapshot}
                engineerName={dash.selectedEngineer?.displayName ?? 'инженера'}
                engineerId={dash.selectedEngineerId}
                route={dash.selectedRoute}
                selectedRequestId={dash.selectedRequest?.id ?? null}
                history={dash.liveWorkday?.history ?? []}
                breaks={dash.liveWorkday?.breaks ?? []}
                onSelectRequest={dash.selectRequest}
              />
            </section>

            <RequestPanel dash={dash} />
          </div>
        ) : activeTab === 'policies' ? (
          <PolicyComparisonPage
            recorded={dash.isDemo}
            readOnly={dash.source === 'cached'}
            snapshot={snapshot}
            comparison={dash.policyComparison}
            loading={dash.policyComparisonLoading}
            error={dash.policyComparisonError}
            onRefresh={() => void dash.refreshPolicyComparison()}
          />
        ) : activeTab === 'engineers' ? (
          <EngineersPage
            snapshot={snapshot}
            pendingEngineerId={dash.availabilityPendingId}
            rebuilding={dash.rebuilding || dash.writesDisabled}
            writesDisabled={dash.writesDisabled}
            liveStates={dash.liveWorkday?.engineers ?? []}
            onAvailabilityChange={(engineerId, availability) =>
              void dash.updateEngineerAvailability(engineerId, availability)
            }
            onLinkAccount={(engineerId, email) => dash.linkEngineerLogin(engineerId, email)}
            onUnlinkAccount={(engineerId) => dash.unlinkEngineerLogin(engineerId)}
            onAttendanceOptOut={dash.setAttendanceOptOut}
          />
        ) : activeTab === 'alerts' ? (
          <AlertsPage
            snapshot={snapshot}
            writesDisabled={dash.writesDisabled || dash.busy}
            onResolve={dash.resolveAlert}
            onSeen={dash.markNoticeSeen}
            onCloseShift={dash.closeShift}
          />
        ) : activeTab === 'settings' ? (
          <ApiTokensPage token={dash.token} />
        ) : null}
      </div>
      {dash.source === 'live' && (
        <AlertToasts
          alerts={snapshot.alerts}
          scope={snapshot.workDate}
          onOpen={() => setActiveTab('alerts')}
        />
      )}
    </div>
  );
}

function WorkdayStartScreen({
  workday,
  loading,
  error,
  onStart,
  onPrepare,
  onSignOut,
}: {
  readonly workday: LiveWorkday;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onStart: () => void;
  readonly onPrepare: () => void;
  readonly onSignOut: () => void;
}) {
  return (
    <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <section className="w-full max-w-xl rounded-3xl bg-white p-8 shadow-sm">
        <span className="inline-flex rounded-full bg-bee/20 px-3 py-1 text-sm font-medium">
          Диспетчерская
        </span>
        <h1 className="mt-5 text-3xl font-semibold">Рабочий день готов к запуску</h1>
        <p className="mt-3 text-lg text-muted">
          {formatDayTitle(workday.workDate)} · {formatClock(workday.liveNow)}
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-canvas p-4">
            <span className="block text-[12px] font-medium uppercase tracking-wide text-muted">
              Заявки сегодня
            </span>
            <strong className="mt-1 block text-3xl">{workday.requestCount}</strong>
          </div>
          <div className="rounded-2xl bg-canvas p-4">
            <span className="block text-[12px] font-medium uppercase tracking-wide text-muted">
              Плановый старт
            </span>
            <strong className="mt-1 block text-3xl">{formatClock(workday.logicalStartAt)}</strong>
          </div>
        </div>
        <p className="mt-5 text-sm leading-6 text-muted">
          После запуска включится единое время дня. У инженеров будет 30 минут планового времени,
          чтобы выйти на линию; далее не вышедшие будут исключены из следующей перестройки.
        </p>
        {error ? (
          <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={onStart}
            className="rounded-full bg-bee px-5 py-3 font-semibold disabled:opacity-50"
          >
            {loading ? 'Запускаем…' : 'Начать рабочий день'}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onPrepare}
            className="rounded-full border border-line px-5 py-3 text-sm font-medium disabled:opacity-50"
          >
            Подготовить данные
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onSignOut}
            className="px-3 py-3 text-sm text-muted underline disabled:opacity-50"
          >
            Выйти
          </button>
        </div>
      </section>
    </main>
  );
}

function LiveEngineerPipeline({ state }: { readonly state: LiveEngineerState }) {
  const pipeline = livePipelineLabel(state);
  return (
    <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] ${pipeline.className}`}>
      {pipeline.label}
    </span>
  );
}

function livePipelineLabel(state: LiveEngineerState): { label: string; className: string } {
  if (state.pendingDelayProblem) {
    return { label: 'Проблема: задержка', className: 'bg-red-50 text-red-700' };
  }
  if (state.lineStatus === 'technical_break') {
    return { label: 'Тех. перерыв', className: 'bg-amber-50 text-amber-800' };
  }
  if (state.lineStatus === 'no_show_offline') {
    return { label: 'Не вышел на линию', className: 'bg-red-50 text-red-700' };
  }
  if (state.activeRequestId) {
    return {
      label: `В заявке №${state.activeRequestId}`,
      className: 'bg-emerald-50 text-emerald-800',
    };
  }
  if (state.lineStatus === 'online') {
    return { label: 'На линии · по плану', className: 'bg-emerald-50 text-emerald-800' };
  }
  return { label: 'Ожидает выхода на линию', className: 'bg-canvas text-muted' };
}

interface LoginScreenProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly onPassword: (email: string, password: string) => Promise<void>;
  readonly onRequestCode: (
    email: string,
  ) => Promise<{ email: string; expiresAt: number; devCode?: string } | null>;
  readonly onCode: (email: string, code: string) => Promise<void>;
}

function LoginScreen({ loading, error, onPassword, onRequestCode, onCode }: LoginScreenProps) {
  const [method, setMethod] = useState<'password' | 'code'>('code');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{ email: string; devCode?: string } | null>(null);

  return (
    <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <form
        className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (method === 'password') {
            void onPassword(email, password);
            return;
          }
          if (issued) {
            void onCode(issued.email, code);
            return;
          }
          void onRequestCode(email).then((next) => {
            if (next) {
              setIssued({
                email: next.email,
                ...(next.devCode ? { devCode: next.devCode } : {}),
              });
            }
          });
        }}
      >
        <img src="/beeline-symbol.png" alt="Beeline" className="mx-auto h-10 w-10" />
        <h1 className="mt-6 text-center text-2xl font-semibold">План дня</h1>
        <p className="mt-2 text-center text-sm text-muted">
          {method === 'code'
            ? 'Код придёт на почту диспетчера. Пароль остаётся запасным входом.'
            : 'Войдите как диспетчер, чтобы открыть актуальный план.'}
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="dispatcher-email">
          Email
        </label>
        <input
          id="dispatcher-email"
          type="email"
          required
          autoComplete="username"
          value={email}
          disabled={method === 'code' && issued !== null}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line px-3 py-2.5 outline-none focus:border-ink disabled:opacity-60"
        />
        {method === 'password' ? (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="dispatcher-password">
              Пароль
            </label>
            <input
              id="dispatcher-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-xl border border-line px-3 py-2.5 outline-none focus:border-ink"
            />
          </>
        ) : issued ? (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="dispatcher-code">
              Код из письма
            </label>
            <input
              id="dispatcher-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="mt-2 w-full rounded-xl border border-line px-3 py-2.5 tracking-widest outline-none focus:border-ink"
            />
            {issued.devCode ? (
              <p className="mt-2 text-xs text-muted">Код для локальной отладки: {issued.devCode}</p>
            ) : null}
          </>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-full bg-bee py-3 text-sm font-semibold disabled:opacity-50"
        >
          {loading ? 'Входим…' : method === 'password' || issued ? 'Войти' : 'Получить код'}
        </button>
        {method === 'code' && issued ? (
          <button
            type="button"
            onClick={() => {
              setIssued(null);
              setCode('');
            }}
            className="mt-3 w-full text-sm text-muted underline"
          >
            Другая почта
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setMethod(method === 'code' ? 'password' : 'code');
              setIssued(null);
              setCode('');
              setPassword('');
            }}
            className="mt-3 w-full text-sm text-muted underline"
          >
            {method === 'code' ? 'Войти паролем' : 'Войти по коду из письма'}
          </button>
        )}
      </form>
    </main>
  );
}

function RequestPanel({ dash }: { readonly dash: ReturnType<typeof useDashboard> }) {
  const snapshot = dash.snapshot;
  if (!snapshot) {
    return null;
  }
  const request = dash.selectedRequest;
  const assignment = dash.selectedAssignment;
  const engineer =
    snapshot.engineers.find((item) => item.id === assignment?.engineerId) ?? dash.selectedEngineer;
  const route = dash.selectedRoute;
  const explanation = explainSelection(snapshot, request, assignment, engineer, route);

  if (!request) {
    return (
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-panel p-5 text-white">
        <p className="text-[13px] text-white/50">
          {engineer ? engineer.displayName : 'Общий план'}
        </p>
        <h2 className="mt-2 text-[22px] font-semibold leading-7">
          {engineer
            ? route?.assignedCount
              ? 'Маршрут смены'
              : 'Смена без заявок'
            : 'Все маршруты дня'}
        </h2>
        {explanation ? (
          <ExplanationBlock explanation={explanation} />
        ) : (
          <p className="mt-3 text-sm text-white/70">
            На карте все инженеры. Клик по заявке или человеку открывает один маршрут.
          </p>
        )}
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

      <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
        <span className="rounded-full bg-white/10 px-3 py-1">{request.workTypeTitle}</span>
        <span className="rounded-full bg-white/10 px-3 py-1">
          Навык: {skillLabel(request.requiredSkill)}
        </span>
        <span className="rounded-full bg-white/10 px-3 py-1">
          {request.priority === 'urgent' ? 'Срочная' : 'Обычная'}
        </span>
        <span className="rounded-full bg-white/10 px-3 py-1">
          {request.requiredEquipment
            ? equipmentLabel(request.requiredEquipment)
            : 'Без оборудования'}
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

      {explanation ? <ExplanationBlock explanation={explanation} /> : null}

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={() => dash.setMode(snapshot.plan.mode === 'auto' ? 'manual' : 'auto')}
          className="w-full rounded-full bg-bee py-3 text-sm font-semibold text-ink"
        >
          {snapshot.plan.mode === 'auto'
            ? 'Сменить исполнителя — нужен ручной режим'
            : 'Вернуть автоматический режим'}
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

function ExplanationBlock({ explanation }: { readonly explanation: CaseExplanation }) {
  return (
    <div className="mt-6 min-h-0 flex-1 overflow-auto">
      <h3 className="text-[17px] font-semibold">{explanation.title}</h3>
      <section className="mt-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-white/50">
          Факты, которые повлияли
        </p>
        <ul className="mt-2 list-disc space-y-2 pl-4 text-sm text-white/80">
          {explanation.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>
      <section className="mt-4">
        <p className="text-[12px] font-medium uppercase tracking-wide text-white/50">
          Как они влияют
        </p>
        <p className="mt-2 text-sm text-white/80">{explanation.influence}</p>
      </section>
      <section className="mt-4">
        <p className="text-[12px] font-medium uppercase tracking-wide text-white/50">Результат</p>
        <p className="mt-2 text-sm text-white">{explanation.result}</p>
      </section>
    </div>
  );
}

function equipmentLabel(type: EquipmentType): string {
  const labels: Record<EquipmentType, string> = {
    router: 'Роутер',
    set_top_box: 'ТВ-приставка',
    smart_speaker: 'Умная колонка',
  };
  return labels[type];
}
