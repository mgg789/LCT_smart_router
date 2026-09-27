import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { optimizePlanWithAi, predictSituation, type SituationPredictionView } from '../api/client';
import type { DashboardSnapshot, PolicyComparisonResponse } from '../api/types';
import { isNavixOffline } from '../domain/mapAvailability';
import {
  type AdviceLine,
  type PlanQualityAdvice,
  planQualityAdvice,
  unroutedPlanAdvice,
} from '../domain/planQuality';
import { t } from '../i18n';
import { formatDurationMin, formatKm } from '../lib/time';
import { FIGMA_ASSETS } from './assets';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';
import { shortRequestId } from './requestsTable';
import { TintIcon } from './TintIcon';
import { useAiExplanation } from './useAiExplanation';

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
  token,
  onOpenRequest,
  onOpenPolicyComparison,
  onClose,
}: {
  open: boolean;
  motionOn: boolean;
  snapshot: DashboardSnapshot | null;
  comparison: PolicyComparisonResponse | null;
  token: string | null;
  onOpenRequest: (requestId: string) => void;
  /** Leaves the dialog and opens the same-snapshot policy comparison workspace. */
  onOpenPolicyComparison: () => void;
  onClose: () => void;
}) {
  const [prediction, setPrediction] = useState<SituationPredictionView | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const identity = snapshot?.plan.appliedResult;
  const plan = snapshot?.plan.plan ?? null;

  // Refresh only when the applied plan identity changes, not on every poll;
  // snapshot/identity/plan are read through the closure on purpose.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity-driven refresh
  useEffect(() => {
    if (isNavixOffline() || !open || !snapshot || !token || !identity || !plan) {
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
  }, [open, token, identity?.inputHash, identity?.routerContextVersion, plan?.revision]);

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
  return (
    <ModalLayer open={open} motionOn={motionOn}>
      <ModalScrim label={t('figma-dashboard.PlanMetricsModal.e47a7a1a53')} onClose={onClose} />
      <motion.div
        role="dialog"
        aria-labelledby="plan-metrics-title"
        className="relative z-10 w-[560px] rounded-[28px] bg-white px-[28px] py-[24px] shadow-[0_22px_48px_rgba(39,41,48,0.18)]"
        initial={motionOn ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={motionOn ? { opacity: 0 } : undefined}
        transition={fade}
      >
        <div className="flex items-center justify-between gap-[12px]">
          <h2
            id="plan-metrics-title"
            className="figma-text font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
          >
            {t('figma-dashboard.PlanMetricsModal.bb25ab0a14')}
          </h2>
          <div className="flex items-center gap-[8px]">
            <button
              type="button"
              onClick={onOpenPolicyComparison}
              className="rounded-full bg-figma-soft px-[14px] py-[8px] text-[14px] font-semibold text-figma-ink transition-colors hover:bg-figma-track"
            >
              {t('figma-dashboard.PlanMetricsModal.ca95afa2b5')}
            </button>
            <button
              type="button"
              aria-label={t('figma-dashboard.PlanMetricsModal.a7a4033657')}
              onClick={onClose}
              className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110"
            >
              <span className="-rotate-45">
                <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
              </span>
            </button>
          </div>
        </div>
        <QualityCard
          advice={advice}
          pending={pending}
          failed={failed}
          hasPlan={plan !== null}
          token={isNavixOffline() ? null : token}
          context={{
            advice,
            metrics,
            prediction,
            policyId: snapshot?.policyId ?? null,
            engineers: (snapshot?.engineers ?? []).slice(0, 8).map((engineer) => ({
              name: engineer.displayName,
              availability: engineer.day?.availability ?? null,
              transport: engineer.transportType,
              skills: engineer.skills,
            })),
            routes: (plan?.routes ?? []).map((route) => ({
              assigned: route.assignedCount,
              distanceKm: route.distanceKm,
              travelMin: Math.round(route.travelTimeSec / 60),
            })),
          }}
          onOpenRequest={onOpenRequest}
        />
        {metrics ? (
          <dl className="mt-[18px] grid grid-cols-2 gap-[10px]">
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.6de28b421e')}
              value={String(metrics.unassigned)}
            />
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.3da7cc2a49')}
              value={String(metrics.engineers)}
            />
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.69cc064f06')}
              value={formatKm(metrics.distanceKm)}
            />
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.254688bbb1')}
              value={formatDurationMin(metrics.travelSec)}
            />
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.03f4a03340')}
              value={prediction ? String(prediction.expectedLate).replace('.', ',') : '…'}
            />
            <Metric
              label={t('figma-dashboard.PlanMetricsModal.f0afbef961')}
              value={prediction ? formatDurationMin(prediction.p95MaxLateSec) : '…'}
            />
            <OptimizeButton
              token={isNavixOffline() ? null : token}
              summary={JSON.stringify({ advice, metrics, prediction })}
            />
          </dl>
        ) : (
          <p className="mt-[18px] text-[16px] text-figma-muted">
            {t('figma-dashboard.PlanMetricsModal.45a9da62f0')}
          </p>
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
  token,
  context,
  onOpenRequest,
}: {
  advice: PlanQualityAdvice | null;
  pending: boolean;
  failed: boolean;
  hasPlan: boolean;
  token: string | null;
  context: unknown;
  onOpenRequest: (requestId: string) => void;
}) {
  if (!hasPlan) return null;
  if (pending && !advice) {
    return (
      <div className="mt-[18px] rounded-[20px] bg-figma-soft px-[18px] py-[16px] text-[16px] text-figma-muted">
        {t('figma-dashboard.PlanMetricsModal.c31e8f9735')}
      </div>
    );
  }
  if (failed || !advice) {
    return (
      <div className="mt-[18px] rounded-[20px] bg-figma-soft px-[18px] py-[16px] text-[16px] text-figma-muted">
        {t('figma-dashboard.PlanMetricsModal.09ef92b65f')}
      </div>
    );
  }
  return (
    <QualityBody advice={advice} token={token} context={context} onOpenRequest={onOpenRequest} />
  );
}

function QualityBody({
  advice,
  token,
  context,
  onOpenRequest,
}: {
  advice: PlanQualityAdvice;
  token: string | null;
  context: unknown;
  onOpenRequest: (requestId: string) => void;
}) {
  const reduce = useReducedMotion();
  const explainable = advice.band === 'yellow' || advice.band === 'red';
  const offline = isNavixOffline();
  const [aiOn, setAiOn] = useState(false);
  const { text: aiText, ready: aiReady } = useAiExplanation({
    enabled: aiOn,
    token,
    kind: 'plan',
    context,
  });
  return (
    <section
      className={`relative mt-[18px] rounded-[20px] px-[18px] py-[16px] ${BAND_CLASS[advice.band]}`}
    >
      {explainable ? (
        <button
          type="button"
          disabled={offline}
          aria-label={
            aiOn
              ? t('figma-dashboard.PlanMetricsModal.83290b9944')
              : t('figma-dashboard.PlanMetricsModal.f50242f50b')
          }
          title={
            aiOn
              ? t('figma-dashboard.PlanMetricsModal.83290b9944')
              : t('figma-dashboard.PlanMetricsModal.f50242f50b')
          }
          onClick={() => setAiOn((value) => !value)}
          className="absolute right-[12px] top-[12px] flex size-[36px] items-center justify-center rounded-full bg-black/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {aiOn ? (
            <TintIcon src="/figma/explain-default.svg" color="currentColor" size={18} />
          ) : (
            <span
              aria-hidden
              className="client-ai-fill block size-[18px]"
              style={{
                WebkitMaskImage: 'url(/figma/explain-ai.png)',
                maskImage: 'url(/figma/explain-ai.png)',
                WebkitMaskRepeat: 'no-repeat',
                maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskPosition: 'center',
                WebkitMaskSize: 'contain',
                maskSize: 'contain',
              }}
            />
          )}
        </button>
      ) : null}
      <p
        className={`font-extrabold text-[22px] tracking-[-0.3px] ${explainable ? 'pr-[40px]' : ''}`}
      >
        {aiOn ? t('figma-dashboard.PlanMetricsModal.979b44ea5c') : advice.title}
      </p>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={aiOn ? (aiReady ? 'ai' : 'wait') : 'plain'}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.22 }}
        >
          {aiOn ? (
            aiReady ? (
              <p className="mt-[6px] text-[16px] leading-[1.35]">
                {aiText ?? t('figma-dashboard.PlanMetricsModal.7cb144b02c')}
              </p>
            ) : (
              <div className="mt-[12px] space-y-[10px]" aria-hidden>
                {['92%', '74%', '58%'].map((width) => (
                  <div
                    key={width}
                    className="h-[12px] overflow-hidden rounded-full bg-current/10"
                    style={{ width }}
                  >
                    <div className="ai-reason-shimmer h-full w-full" />
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              <p className="mt-[6px] text-[16px] leading-[1.35]">{advice.summary}</p>
              <p className="mt-[12px] font-semibold text-[15px]">
                {t('figma-dashboard.PlanMetricsModal.6ff3cf63b8')}
              </p>
              <ul className="mt-[6px] space-y-[6px] text-[15px] leading-[1.35]">
                {advice.lines.map((line) => (
                  <li key={`${line.before}${line.shortId ?? ''}${line.after}`}>
                    <AdviceSentence line={line} onOpenRequest={onOpenRequest} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </motion.div>
      </AnimatePresence>
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

/** Reserved AI action. It does not change the plan until a model is connected. */
function OptimizeButton({ token, summary }: { token: string | null; summary: string }) {
  const offline = isNavixOffline();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={offline || !token || pending}
      title={
        offline
          ? t('common.offlineContour')
          : (note ?? t('figma-dashboard.PlanMetricsModal.202a8a5212'))
      }
      onClick={() => {
        if (!token || pending) return;
        setPending(true);
        setNote(null);
        void optimizePlanWithAi(token, summary)
          .then((picked) => {
            const already =
              picked.id === 'current' ||
              picked.label === t('figma-dashboard.PlanMetricsModal.83de91dcc0');
            setNote(
              already
                ? t('figma-dashboard.PlanMetricsModal.83de91dcc0')
                : t('figma-dashboard.PlanMetricsModal.35201dff73'),
            );
          })
          .catch(() => setNote(t('figma-dashboard.PlanMetricsModal.9db6447f15')))
          .finally(() => setPending(false));
      }}
      className="col-span-2 flex h-[52px] items-center justify-center gap-[10px] rounded-[18px] bg-figma-ink disabled:cursor-wait"
    >
      <span
        aria-hidden
        className="panel-ai-fill block size-[32px]"
        style={{
          WebkitMaskImage: 'url(/figma/pencil-ai.svg)',
          maskImage: 'url(/figma/pencil-ai.svg)',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
        }}
      />
      <span className="panel-ai-fill client-ai-text font-semibold text-[18px] tracking-[-0.3px]">
        {pending
          ? t('figma-dashboard.PlanMetricsModal.5798be2637')
          : (note ?? t('figma-dashboard.PlanMetricsModal.9b9f2f7843'))}
      </span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] bg-figma-soft px-[16px] py-[12px]">
      <dt className="text-[13px] text-figma-muted">{label}</dt>
      <dd className="mt-[2px] font-semibold text-[20px] tracking-[-0.3px] text-figma-ink">
        {value}
      </dd>
    </div>
  );
}

function rosterIsOffline(snapshot: DashboardSnapshot | null): boolean {
  const days =
    snapshot?.engineers.map((engineer) => engineer.day).filter((day) => day != null) ?? [];
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
    shortId: shortRequestId(
      snapshot.requests.find((item) => item.id === requestId)?.id ?? requestId,
    ),
    breachProb: row.breachProb,
  }));
}

function overrunEngineers(snapshot: DashboardSnapshot, prediction: SituationPredictionView) {
  return Object.entries(prediction.engineers).map(([engineerId, row]) => ({
    name:
      snapshot.engineers.find((engineer) => engineer.id === engineerId)?.displayName ??
      (engineerId.startsWith('covering-')
        ? t('figma-dashboard.PlanMetricsModal.a311a9f1ed')
        : engineerId),
    overrunProb: row.overrunProb,
  }));
}
