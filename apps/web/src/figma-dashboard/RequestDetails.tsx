import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { EngineerView, RequestView } from '../api/types';
import { isNavixOffline } from '../domain/mapAvailability';
import { t } from '../i18n';
import type { CaseExplanation } from '../lib/explanations';
import { formatDurationMin } from '../lib/time';
import { useArtboardStretch } from './artboardStretch';
import { Copyable } from './Copyable';
import { requestUrgency } from './fromSnapshot';
import { ManualRequestControls } from './ManualPlanning';
import { FigmaText } from './primitives';
import { requestEquipmentLabel } from './requestDetail';
import { shortRequestId } from './requestsTable';
import { TintIcon } from './TintIcon';
import { useAiExplanation } from './useAiExplanation';

const HEADER_LIFT = 16;
const PANEL_TOP = 154 - HEADER_LIFT;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
/** Holds the board's right edge, which a wide window puts past the drawing. */
const DETAIL_PANEL_LEFT = 1406;
const CLOSE_PANEL_SIZE = 43;
const slideEase = [0.22, 1, 0.36, 1] as const;
const FACT_ICON = {
  skills: '/figma/engineer-skills.svg',
  transport: '/figma/transport.svg',
  equipment: '/figma/equipment.svg',
  window: '/figma/time-window.svg',
  lunch: '/figma/lunch.svg',
  route: '/figma/graph-route.svg',
} as const;

/** Shows request or engineer facts, with optional AI explanation controls for requests. */
export function RequestDetails({
  mode,
  request,
  engineer,
  explanation,
  token,
  motionOn,
  onClose,
  onOpenEngineer,
}: {
  mode: 'plan' | 'request';
  request: RequestView | null;
  engineer: EngineerView | null;
  explanation: CaseExplanation | null;
  token: string | null;
  roster: ReadonlyArray<{
    name: string;
    skills: readonly string[];
    transport: string;
    availability: string | null;
  }>;
  motionOn: boolean;
  onClose: () => void;
  onOpenEngineer?: () => void;
}) {
  const offline = isNavixOffline();
  const { dx, dy } = useArtboardStretch();
  const [aiOn, setAiOn] = useState(false);
  const [largeOn, setLargeOn] = useState(false);
  const urgency = request ? requestUrgency(request) : null;
  const equipment = request
    ? request.requiredEquipment
      ? requestEquipmentLabel(request.requiredEquipment)
      : t('figma-dashboard.RequestDetails.4f0e8481b7')
    : null;
  const assignment =
    request == null
      ? null
      : request.assignmentState === 'unassigned' || request.assignmentState === 'pending'
        ? t('figma-dashboard.RequestDetails.ae6bef78e3')
        : t('figma-dashboard.RequestDetails.c5497186c4');

  return (
    <motion.aside
      className="absolute w-[484px] overflow-hidden rounded-[20px] bg-figma-ink"
      style={{ left: DETAIL_PANEL_LEFT + dx, top: PANEL_TOP, height: PANEL_HEIGHT + dy }}
      initial={motionOn ? { opacity: 0, x: 28 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={motionOn ? { opacity: 0, x: 36 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <motion.button
        type="button"
        aria-label={t('figma-dashboard.RequestDetails.bf427bdba8')}
        onClick={onClose}
        className="absolute right-[16px] top-[16px] z-20 flex items-center justify-center rounded-full bg-white"
        style={{ width: CLOSE_PANEL_SIZE, height: CLOSE_PANEL_SIZE }}
        whileHover={motionOn ? { scale: 1.12 } : undefined}
        whileTap={motionOn ? { scale: 0.94 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <X size={22} strokeWidth={2.25} className="text-figma-ink" />
      </motion.button>
      <div
        className={`absolute inset-x-0 top-0 overflow-y-auto px-[27px] pt-[24px] [scrollbar-width:thin] ${
          mode === 'plan' ? 'bottom-[110px]' : 'bottom-[24px]'
        }`}
      >
        {mode === 'request' && request ? (
          <div className="pr-[52px]">
            <FigmaText className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white">
              <span
                className={request.workCategory === 'emergency' ? 'text-figma-danger' : undefined}
              >
                {request.workTypeTitle || t('figma-dashboard.RequestDetails.77b3e0166b')}
              </span>
            </FigmaText>
            <Copyable
              value={shortRequestId(request.id)}
              label={t('figma-dashboard.RequestDetails.fd3834086e')}
              className="mt-[8px] text-left"
            >
              <p
                className="font-semibold text-[20px] tracking-[-0.34px] text-white/60"
                title={request.id}
              >
                {shortRequestId(request.id)}
              </p>
            </Copyable>
            <div className="mt-[16px] flex flex-wrap gap-[12px]">
              {assignment ? <PanelTag label={assignment} /> : null}
              {urgency ? <PanelTag label={urgency.label} tone={urgency.tone} /> : null}
              {equipment ? <PanelTag label={equipment} /> : null}
            </div>
            <Copyable
              value={request.addressText}
              label={t('figma-dashboard.RequestDetails.72a7549bb1')}
              className="mt-[16px] flex min-h-[67px] w-full items-center rounded-[20px] bg-figma-dim px-[20px] py-[16px] text-left transition-colors hover:bg-white/10"
            >
              <p className="font-medium text-[20px] leading-[24px] tracking-[-0.6px] text-white">
                {request.addressText}
              </p>
            </Copyable>
          </div>
        ) : engineer ? (
          <div className="pr-[52px]">
            <FigmaText className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white">
              {engineer.displayName}
            </FigmaText>
            <p
              className={`mt-[8px] font-semibold text-[18px] tracking-[-0.3px] ${
                engineer.email ? 'text-white/60' : 'invisible'
              }`}
              aria-hidden={engineer.email ? undefined : true}
            >
              {engineer.email || '\u00a0'}
            </p>
          </div>
        ) : (
          <div className="h-[36px]" />
        )}
        {mode === 'request' && request ? <ManualRequestControls requestId={request.id} /> : null}
        {mode === 'request' ? (
          <RequestReasons
            aiOn={aiOn}
            largeOn={largeOn}
            motionOn={motionOn}
            token={token}
            requestId={request?.id ?? null}
            explanation={explanation}
            durationLabel={request ? formatDurationMin(request.serviceDurationSec) : '—'}
            onToggleAi={() => setAiOn((value) => !value)}
            disabled={offline}
            onToggleLarge={() => setLargeOn((value) => !value)}
          />
        ) : (
          <IconFactCard
            title={t('figma-dashboard.RequestDetails.79cc865da4')}
            facts={explanation?.iconFacts ?? []}
          />
        )}
      </div>
      {mode === 'plan' && engineer ? (
        <div className="absolute inset-x-[27px] bottom-[24px] flex gap-[12px]">
          <button
            type="button"
            onClick={onOpenEngineer}
            className="h-[52px] flex-1 rounded-[16px] bg-white font-semibold text-[16px] text-figma-ink"
          >
            {t('figma-dashboard.RequestDetails.f07be04268')}
          </button>
          <button
            type="button"
            disabled
            title={t('figma-dashboard.RequestDetails.72c299e0d6')}
            className="h-[52px] flex-1 cursor-not-allowed rounded-[16px] bg-white/15 font-semibold text-[16px] text-white/45"
          >
            {t('figma-dashboard.RequestDetails.3214e286d7')}
          </button>
        </div>
      ) : null}
    </motion.aside>
  );
}

function RequestReasons({
  aiOn,
  largeOn,
  motionOn,
  token,
  requestId,
  explanation,
  durationLabel,
  onToggleAi,
  onToggleLarge,
  disabled = false,
}: {
  aiOn: boolean;
  largeOn: boolean;
  motionOn: boolean;
  token: string | null;
  requestId: string | null;
  explanation: CaseExplanation | null;
  durationLabel: string;
  onToggleAi: () => void;
  onToggleLarge: () => void;
  disabled?: boolean;
}) {
  const { text: aiText, ready: aiReady } = useAiExplanation({
    enabled: aiOn && requestId !== null,
    token,
    target: { scope: 'request', requestId: requestId ?? '' },
  });
  return (
    <div className="mt-[16px]">
      <div className="flex min-h-[216px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
        <div className="flex items-center justify-between gap-[8px]">
          <FigmaText
            className={`font-medium text-[28px] tracking-[-0.84px] ${
              aiOn ? 'panel-ai-fill client-ai-text figma-text-uncropped' : 'text-white'
            }`}
          >
            {aiOn
              ? t('figma-dashboard.RequestDetails.50d9ea142a')
              : t('figma-dashboard.RequestDetails.93096e67cb')}
          </FigmaText>
          <LayoutGroup>
            <div className="flex items-center">
              <motion.div layout={motionOn} transition={{ duration: 0.32, ease: slideEase }}>
                <ReasonIconButton
                  label={
                    aiOn
                      ? t('figma-dashboard.RequestDetails.a2270af56f')
                      : t('figma-dashboard.RequestDetails.f50242f50b')
                  }
                  motionOn={motionOn}
                  disabled={disabled}
                  onClick={onToggleAi}
                >
                  {aiOn ? (
                    <TintIcon src="/figma/explain-default.svg" color="#ffffff" size={18} />
                  ) : (
                    <AiGlyph />
                  )}
                </ReasonIconButton>
              </motion.div>
              <AnimatePresence initial={false}>
                {aiOn ? null : (
                  <motion.span
                    key="size"
                    className="inline-flex overflow-hidden"
                    initial={motionOn ? { width: 0, opacity: 0, marginLeft: 0 } : false}
                    animate={{ width: 36, opacity: 1, marginLeft: 8 }}
                    exit={motionOn ? { width: 0, opacity: 0, marginLeft: 0 } : undefined}
                    transition={{ duration: 0.32, ease: slideEase }}
                  >
                    <ReasonIconButton
                      label={
                        largeOn
                          ? t('figma-dashboard.RequestDetails.3a42d2327c')
                          : t('figma-dashboard.RequestDetails.59589fe2a5')
                      }
                      motionOn={motionOn}
                      onClick={onToggleLarge}
                    >
                      <TintIcon
                        src={largeOn ? '/figma/short-facts.svg' : '/figma/large-facts.svg'}
                        color="#ffffff"
                        size={18}
                      />
                    </ReasonIconButton>
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={aiOn ? (aiReady ? 'ai-text' : 'ai-search') : largeOn ? 'large' : 'short'}
            initial={motionOn ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={motionOn ? { opacity: 0, y: -6 } : undefined}
            transition={{ duration: 0.22 }}
          >
            {aiOn ? (
              aiReady ? (
                <p className="mt-[12px] font-medium text-[18px] leading-[24px] text-white/70">
                  {aiText ?? t('figma-dashboard.RequestDetails.3025714c55')}
                </p>
              ) : (
                <AiSearchLines />
              )
            ) : (
              <IconFactList facts={explanation?.iconFacts ?? []} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      {largeOn && !aiOn ? (
        <>
          <div className="mt-[16px] flex min-h-[160px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
            <FigmaText className="font-medium text-[28px] tracking-[-0.84px] text-white">
              {t('figma-dashboard.RequestDetails.8e70b73225')}
            </FigmaText>
            <p className="mt-[12px] font-medium text-[18px] leading-[24px] text-white/70">
              {explanation?.influence || t('figma-dashboard.RequestDetails.e2cf5d6461')}
            </p>
          </div>
          <div className="mt-[16px] flex min-h-[67px] w-full items-center rounded-[20px] bg-figma-dim px-[20px] py-[16px]">
            <p className="font-medium text-[20px] leading-[24px] text-white">
              {explanation?.result || durationLabel}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ReasonIconButton({
  label,
  motionOn,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  motionOn: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-[36px] items-center justify-center rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
      whileHover={motionOn ? { scale: 1.08, backgroundColor: 'rgba(255,255,255,0.18)' } : undefined}
      whileTap={motionOn ? { scale: 0.92 } : undefined}
      transition={{ duration: 0.16 }}
    >
      {children}
    </motion.button>
  );
}

function IconFactCard({
  title,
  facts,
}: {
  title: string;
  facts: NonNullable<CaseExplanation['iconFacts']>;
}) {
  return (
    <div className="mt-[16px] flex min-h-[216px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
      <FigmaText className="font-medium text-[28px] tracking-[-0.84px] text-white">
        {title}
      </FigmaText>
      <IconFactList facts={facts} className="mt-[22px]" />
    </div>
  );
}

/** Black sparkle painted with the same moving gradient as the client AI mark. */
function AiGlyph() {
  return (
    <span
      aria-hidden
      className="panel-ai-fill block size-[18px]"
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
  );
}

/** Placeholder bars while a write-up would still be generating. */
function AiSearchLines() {
  const widths = ['92%', '74%', '86%', '58%'];
  return (
    <div className="mt-[16px] space-y-[12px]" aria-hidden>
      {widths.map((width) => (
        <div
          key={width}
          className="h-[14px] overflow-hidden rounded-full bg-white/10"
          style={{ width }}
        >
          <div className="ai-reason-shimmer h-full w-full" />
        </div>
      ))}
    </div>
  );
}

function IconFactList({
  facts,
  className = 'mt-[12px]',
}: {
  facts: NonNullable<CaseExplanation['iconFacts']>;
  className?: string;
}) {
  if (facts.length === 0) {
    return (
      <p className={`${className} font-medium text-[18px] leading-[24px] text-white/70`}>
        {t('figma-dashboard.RequestDetails.62804d2068')}
      </p>
    );
  }
  return (
    <ul className={`${className} space-y-[10px]`}>
      {facts.map((fact) => (
        <li key={`${fact.icon}:${fact.text}`} className="flex items-center gap-[10px]">
          <TintIcon src={FACT_ICON[fact.icon]} color="#ffffff" size={20} />
          <span className="font-medium text-[18px] leading-[24px] tracking-[-0.3px] text-white/70">
            {fact.text.replace(/\.+$/u, '')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PanelTag({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'urgent' | 'emergency';
}) {
  const textClass = tone === 'emergency' ? 'text-figma-danger' : 'text-figma-ink';
  return (
    <div className="flex items-center justify-center rounded-[20px] bg-figma-track px-[20px] py-[12px]">
      <FigmaText className={`figma-nowrap font-medium text-[20px] tracking-[-0.34px] ${textClass}`}>
        {label}
      </FigmaText>
    </div>
  );
}
