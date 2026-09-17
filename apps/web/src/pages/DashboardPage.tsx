import { AnimatePresence, motion } from 'framer-motion';
import { HardHat, Map as MapIcon, Plus, ShieldCog } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EquipmentType } from '../api/types';
import { ConnectionBar } from '../components/ConnectionBar';
import { DataUploadModal } from '../components/DataUploadModal';
import { DayMap } from '../components/DayMap';
import { EngineersPage } from '../components/EngineersPage';
import { PolicyComparisonPage } from '../components/PolicyComparisonPage';
import { PolicyModal } from '../components/PolicyModal';
import { RouteTimeline } from '../components/RouteTimeline';
import { engineerSummaries, unassignedRequests } from '../domain/dashboard';
import {
  ALL_REGIONS,
  filterSnapshotByRegion,
  type RegionSelection,
  regionOptions,
} from '../domain/regions';
import { useDashboard } from '../hooks/useDashboard';
import { factorLabel, initials, modeLabel, POLICY_LABELS, reasonDetail } from '../lib/reasons';
import { formatClock, formatDayTitle, formatDurationMin, formatKm } from '../lib/time';

const NAV = [
  { id: 'day', label: 'План дня', icon: MapIcon },
  { id: 'policies', label: 'Политики', icon: ShieldCog },
  { id: 'engineers', label: 'Инженеры', icon: HardHat },
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

  useEffect(() => {
    if (selectedRegion !== ALL_REGIONS && !regions.some((region) => region.id === selectedRegion)) {
      setSelectedRegion(ALL_REGIONS);
      dash.clearFocus();
    }
  }, [dash.clearFocus, regions, selectedRegion]);

  if (!dash.authenticated) {
    return (
      <div>
        <LoginScreen loading={dash.loading} error={dash.error} onSubmit={dash.signIn} />
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
                className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                  activeTab === item.id ? 'bg-ink text-white' : 'text-muted hover:bg-canvas'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={1.8} />
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          title="Загрузить данные"
          aria-label="Загрузить новый регион или заявки"
          disabled={dash.writesDisabled}
          onClick={() => setUploadOpen(true)}
          className="mt-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line text-muted hover:bg-canvas hover:text-ink"
        >
          <Plus className="h-5 w-5" />
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 px-5 py-3 max-sm:flex-wrap">
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

        <ConnectionBar dashboard={dash} />

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
                  {visibleUnassigned.length} без назначения
                </p>
                <p className="text-sm text-muted">
                  План от {formatClock(snapshot.plan.plan?.planAsOf ?? snapshot.nowAt)}
                  {dash.rebuilding ? ' · перестраивается' : ''}
                </p>
                {dash.events[0] ? (
                  <p className="mt-2 text-[12px] text-muted">{dash.events[0].text}</p>
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
                              План: {engineer.assignedCount} заявок · {engineer.transportType}
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
                    <div className="px-1 text-sm">Нет инженера с нужным навыком</div>
                    <ul className="mt-2 space-y-1">
                      {visibleUnassigned.map((request) => {
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
                route={dash.selectedRoute}
                selectedRequestId={dash.selectedRequest?.id ?? null}
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
            onAvailabilityChange={(engineerId, availability) =>
              void dash.updateEngineerAvailability(engineerId, availability)
            }
          />
        ) : null}
      </div>
    </div>
  );
}

interface LoginScreenProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly onSubmit: (email: string, password: string) => Promise<void>;
}

function LoginScreen({ loading, error, onSubmit }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <form
        className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(email, password);
        }}
      >
        <img src="/beeline-symbol.png" alt="Beeline" className="mx-auto h-10 w-10" />
        <h1 className="mt-6 text-center text-2xl font-semibold">План дня</h1>
        <p className="mt-2 text-center text-sm text-muted">
          Войдите как диспетчер, чтобы открыть актуальный план.
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
          onChange={(event) => setEmail(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line px-3 py-2.5 outline-none focus:border-ink"
        />
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
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-full bg-bee py-3 text-sm font-semibold disabled:opacity-50"
        >
          {loading ? 'Входим…' : 'Войти'}
        </button>
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
  const engineer = snapshot.engineers.find((item) => item.id === assignment?.engineerId);
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
              <span className="block text-white/70">
                {reasonDetail(factor.code, factor.detail)}
              </span>
            </li>
          ))}
        </ul>
        {reasons?.alternatives.length ? (
          <details className="mt-4 text-sm text-white/70">
            <summary className="cursor-pointer text-white">Другие кандидаты</summary>
            <ul className="mt-2 space-y-2">
              {reasons.alternatives.map((item) => (
                <li key={item.engineerId}>
                  {snapshot.engineers.find((eng) => eng.id === item.engineerId)?.displayName ??
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

function equipmentLabel(type: EquipmentType): string {
  const labels: Record<EquipmentType, string> = {
    router: 'Роутер',
    set_top_box: 'ТВ-приставка',
    smart_speaker: 'Умная колонка',
  };
  return labels[type];
}
