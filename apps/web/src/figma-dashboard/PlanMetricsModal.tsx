import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { predictSituation, type SituationPredictionView } from '../api/client';
import type { DashboardSnapshot, PolicyComparisonResponse } from '../api/types';
import {
  planQualityAdvice,
  unroutedPlanAdvice,
  type AdviceLine,
  type PlanQualityAdvice,
} from '../domain/planQuality';
import { recommendPolicy, type PolicyRecommendation } from '../domain/policyRecommend';
import { formatDurationMin, formatKm } from '../lib/time';
import { shortRequestId } from './requestsTable';
import { FIGMA_ASSETS } from './assets';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

const BAND_CLASS = {
  green: 'bg-figma-work-bg text-figma-work',
  yellow: 'bg-[#fff4cc] text-figma-ink',
  red: 'bg-[#ffe8e8] text-figma-danger',
} as const;

/**
 * Plan metrics plus the dry reliability reading. Opening the dialog is what
 * starts the check; nothing here writes a plan.
 */
export function PlanMetricsModal({
  open,
  motionOn,
  snapshot,
  comparison,
  token,
  onOpenRequest,
  onClose,
}: {
  open: boolean;
  motionOn: boolean;
  snapshot: DashboardSnapshot | null;
  comparison: PolicyComparisonResponse | null;
  token: string | null;
  onOpenRequest: (requestId: string) => void;
  onClose: () => void;
}) {
  const [prediction, setPrediction] = useState<SituationPredictionView | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const identity = snapshot?.plan.appliedResult;
  const plan = snapshot?.plan.plan ?? null;
  const inputHash = identity?.inputHash ?? '';
  const revision = plan?.revision ?? -1;

  useEffect(() => {
    if (!open || !snapshot || !token || !identity || !plan) {
      setPrediction(null);
      setPending(false);
      setFailed(false);
      return;
    }
    const routes = visitOrders(plan.routes);
    if (Object.keys(routes).length === 0) {
      setPrediction(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    setFailed(false);
    void predictSituation(token, {
      inputHash: identity.inputHash,
      routerContextVersion: identity.routerContextVersion,
      routes,
      asOf: snapshot.nowAt,
    })
      .then((next) => {
        if (!cancelled) setPrediction(next);
      })
      .catch(() => {
        if (!cancelled) {
          setPrediction(null);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
    // Refresh only when the applied plan identity changes, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token, inputHash, revision]);

  const metrics = plan ? planTotals(plan) : null;
  const routed = plan ? Object.keys(visitOrders(plan.routes)).length > 0 : false;
  const offline = rosterIsOffline(snapshot);
  const advice =
    prediction && snapshot
      ? planQualityAdvice({
          plan: {
            expectedLate: prediction.expectedLate,
            expectedLateShare: prediction.expectedLateShare,
            visitsTotal: prediction.visitsTotal,
          },
          unassignedCount: metrics?.unassigned ?? 0,
          activePolicy: snapshot.policyId,
          requests: riskyRequests(snapshot, prediction),
          engineers: overrunEngineers(snapshot, prediction),
        })
      : plan && !routed
        ? unroutedPlanAdvice({
            unassignedCount: metrics?.unassigned ?? 0,
            rosterOffline: offline,
          })
        : null;
  const recommendation = snapshot
    ? recommendPolicy({
        active: snapshot.policyId,
        unassignedCount: metrics?.unassigned ?? 0,
        robustness: prediction?.robustness ?? null,
        rosterOffline: offline,
        maxBreach: maxBreach(prediction),
        maxOverrun: maxOverrun(prediction),
        rows: comparison?.rows,
      })
    : null;

  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label="Закрыть метрики плана" onClose={onClose} />
      <motion.div
        role="dialog"
        aria-labelledby="plan-metrics-title"
        className="relative z-10 w-[560px] rounded-[28px] bg-white px-[28px] py-[24px] shadow-[0_22px_48px_rgba(39,41,48,0.18)]"
        initial={motionOn ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={motionOn ? { opacity: 0 } : undefined}
        transition={fade}
      >
        <div className="flex items-center justify-between">
          <h2
            id="plan-metrics-title"
            className="figma-text font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
          >
            Метрики плана
          </h2>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110"
          >
            <span className="-rotate-45">
              <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
            </span>
          </button>
        </div>
        <QualityCard
          advice={advice}
          pending={pending}
          failed={failed}
          hasPlan={plan !== null}
          onOpenRequest={onOpenRequest}
        />
        {metrics ? (
          <dl className="mt-[18px] grid grid-cols-2 gap-[10px]">
            <Metric label="Без назначения" value={String(metrics.unassigned)} />
            <Metric label="Инженеры в маршруте" value={String(metrics.engineers)} />
            <Metric label="Пробег" value={formatKm(metrics.distanceKm)} />
            <Metric label="В пути" value={formatDurationMin(metrics.travelSec)} />
            <Metric
              label="Ожидаемые опоздания"
              value={prediction ? String(prediction.expectedLate).replace('.', ',') : '…'}
            />
            <Metric
              label="Худшая задержка"
              value={prediction ? formatDurationMin(prediction.p95MaxLateSec) : '…'}
            />
            {recommendation ? <Recommendation recommendation={recommendation} /> : null}
          </dl>
        ) : (
          <p className="mt-[18px] text-[16px] text-figma-muted">План ещё не применён.</p>
        )}
      </motion.div>
    </ModalLayer>
  );
}

function QualityCard({
  advice,
  pending,
  failed,
  hasPlan,
  onOpenRequest,
}: {
  advice: PlanQualityAdvice | null;
  pending: boolean;
  failed: boolean;
  hasPlan: boolean;
  onOpenRequest: (requestId: string) => void;
}) {
  if (!hasPlan) return null;
  if (pending && !advice) {
    return (
      <div className="mt-[18px] rounded-[20px] bg-figma-soft px-[18px] py-[16px] text-[16px] text-figma-muted">
        Проверяем, как день переживёт разный трафик и длительности…
      </div>
    );
  }
  if (failed || !advice) {
    return (
      <div className="mt-[18px] rounded-[20px] bg-figma-soft px-[18px] py-[16px] text-[16px] text-figma-muted">
        Оценку надёжности сейчас не удалось посчитать. Цифры плана ниже остаются.
      </div>
    );
  }
  return (
    <section className={`mt-[18px] rounded-[20px] px-[18px] py-[16px] ${BAND_CLASS[advice.band]}`}>
      <p className="font-extrabold text-[22px] tracking-[-0.3px]">{advice.title}</p>
      <p className="mt-[6px] text-[16px] leading-[1.35]">{advice.summary}</p>
      <p className="mt-[12px] font-semibold text-[15px]">Как улучшить</p>
      <ul className="mt-[6px] space-y-[6px] text-[15px] leading-[1.35]">
        {advice.lines.map((line) => (
          <li key={`${line.before}${line.shortId ?? ''}${line.after}`}>
            <AdviceSentence line={line} onOpenRequest={onOpenRequest} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdviceSentence({
  line,
  onOpenRequest,
}: {
  line: AdviceLine;
  onOpenRequest: (requestId: string) => void;
}) {
  return (
    <>
      {line.before}
      {line.requestId && line.shortId ? (
        <button
          type="button"
          onClick={() => onOpenRequest(line.requestId as string)}
          className="font-semibold underline decoration-current/40 underline-offset-2 hover:decoration-current"
        >
          {line.shortId}
        </button>
      ) : null}
      {line.after}
    </>
  );
}

function Recommendation({ recommendation }: { recommendation: PolicyRecommendation }) {
  return (
    <div className="col-span-2 rounded-[18px] bg-figma-soft px-[16px] py-[12px]">
      <dt className="text-[13px] text-figma-muted">Рекомендуемая политика</dt>
      <dd className="mt-[2px] font-semibold text-[20px] tracking-[-0.3px] text-figma-ink">
        {recommendation.label}
        {recommendation.sameAsActive ? (
          <span className="ml-[8px] align-middle font-medium text-[13px] text-figma-muted">
            уже включена
          </span>
        ) : null}
      </dd>
      <p className="mt-[4px] text-[14px] leading-[1.35] text-figma-muted">{recommendation.reason}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] bg-figma-soft px-[16px] py-[12px]">
      <dt className="text-[13px] text-figma-muted">{label}</dt>
      <dd className="mt-[2px] font-semibold text-[20px] tracking-[-0.3px] text-figma-ink">{value}</dd>
    </div>
  );
}

function rosterIsOffline(snapshot: DashboardSnapshot | null): boolean {
  const days = snapshot?.engineers.map((engineer) => engineer.day).filter((day) => day != null) ?? [];
  return days.length > 0 && days.every((day) => day.availability === 'offline');
}

function planTotals(plan: NonNullable<DashboardSnapshot['plan']['plan']>) {
  const unassigned = plan.assignments.filter((item) => item.status === 'unassigned').length;
  return {
    unassigned,
    engineers: plan.routes.filter((route) => route.assignedCount > 0).length,
    distanceKm: plan.routes.reduce((sum, route) => sum + route.distanceKm, 0),
    travelSec: plan.routes.reduce((sum, route) => sum + route.travelTimeSec, 0),
  };
}

function visitOrders(
  routes: NonNullable<DashboardSnapshot['plan']['plan']>['routes'],
): Record<string, string[]> {
  const orders: Record<string, string[]> = {};
  for (const route of routes) {
    const ids = route.stops
      .filter((stop) => stop.kind === 'job' && stop.requestId)
      .map((stop) => stop.requestId as string);
    if (ids.length > 0) orders[route.engineerId] = ids;
  }
  return orders;
}

function riskyRequests(snapshot: DashboardSnapshot, prediction: SituationPredictionView) {
  return Object.entries(prediction.requests).map(([requestId, row]) => ({
    requestId,
    shortId: shortRequestId(snapshot.requests.find((item) => item.id === requestId)?.id ?? requestId),
    breachProb: row.breachProb,
  }));
}

function maxBreach(prediction: SituationPredictionView | null): number {
  if (!prediction) return 0;
  return Math.max(0, ...Object.values(prediction.requests).map((row) => row.breachProb ?? 0));
}

function maxOverrun(prediction: SituationPredictionView | null): number {
  if (!prediction) return 0;
  return Math.max(0, ...Object.values(prediction.engineers).map((row) => row.overrunProb));
}

function overrunEngineers(snapshot: DashboardSnapshot, prediction: SituationPredictionView) {
  return Object.entries(prediction.engineers).map(([engineerId, row]) => ({
    name:
      snapshot.engineers.find((engineer) => engineer.id === engineerId)?.displayName ??
      (engineerId.startsWith('covering-') ? 'Резервная смена' : engineerId),
    overrunProb: row.overrunProb,
  }));
}
