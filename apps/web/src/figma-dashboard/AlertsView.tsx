import { motion, useReducedMotion } from 'framer-motion';
import type { DashboardSnapshot } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import { inboxFromSources, type InboxNoticeCard } from './alertsInbox';
import { InboxAlertCardView, InboxNoticeCardView } from './inboxCard';
import { FigmaIcon, FigmaText } from './primitives';
import { dismissToast, type ToastKind, type ToastNotification } from './toasts';

const HEADER_LIFT = 16;
const TITLE_TOP = 184 - HEADER_LIFT;
/**
 * List clip sits flush under the AI pill. A single masked backdrop-filter
 * starting on that clip line leaves a 1–2px fully transparent hairline
 * (Chromium filter crop + artboard scale). The fade is two layers: an
 * unmasked solid canvas stitch that straddles the clip, then a blur that
 * starts inside the stitch so its fringe never sits over the cards.
 */
const LIST_TOP = 231;
const FADE_TUCK = 8;
const STITCH_HEIGHT = 20;
const FADE_HEIGHT = 76;
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

const NOTICE_ICON: Record<ToastKind, { src: string; width: number; height: number }> = {
  system: { src: FIGMA_ASSETS.toastSystem, width: 24, height: 24 },
  progress: { src: FIGMA_ASSETS.toastProgress, width: 24, height: 24 },
  ai: { src: FIGMA_ASSETS.toastAi, width: 28, height: 28 },
  chat: { src: FIGMA_ASSETS.toastChat, width: 25, height: 25 },
  route: { src: FIGMA_ASSETS.toastRoute, width: 24, height: 24 },
  alert: { src: FIGMA_ASSETS.toastAlert, width: 25, height: 25 },
  error: { src: FIGMA_ASSETS.toastAlert, width: 25, height: 25 },
};

/**
 * Figma ALERTS (49:5629 / 49:5696): unresolved alerts first, then notices
 * built from the same 211px card with a dark ink fill and one Hide button.
 * Below the header the list passes under a canvas-to-transparent blur gradient
 * (same trick as the toast veil) instead of clipping on a hard edge.
 */
export function AlertsView({
  snapshot,
  toasts,
  motionOn,
  onOpenRequest,
}: {
  snapshot: DashboardSnapshot | null;
  toasts: readonly ToastNotification[];
  motionOn: boolean;
  onOpenRequest: (requestId: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const animate = motionOn && !reduceMotion;
  const inbox = inboxFromSources(snapshot, toasts);
  const glassArrow = inbox.alerts.length > 0;

  return (
    <section className="absolute inset-0" aria-label="Алерты и уведомления">
      <FigmaText
        className="figma-nowrap absolute left-[180px] z-20 font-extrabold text-[48px] tracking-[-0.816px] text-figma-ink"
        style={{ top: TITLE_TOP }}
      >
        Алерты
      </FigmaText>
      <motion.button
        type="button"
        disabled
        aria-disabled
        title="Скоро"
        className="absolute left-[430px] z-20 flex h-[79px] w-[426px] cursor-not-allowed items-center rounded-full bg-figma-ink pl-[10px] pr-[10px] opacity-45"
        style={{ top: TITLE_TOP - 16 }}
      >
        <span className="flex size-[60px] items-center justify-center rounded-full bg-figma-bee">
          <FigmaIcon src={FIGMA_ASSETS.iconSparkles} alt="" width={26} height={26} />
        </span>
        <span className="figma-nowrap ml-[15px] font-semibold text-[18px] text-[#ededed]">
          Разобрать все в AI
        </span>
        <span
          className={
            glassArrow
              ? 'ml-auto flex size-[63px] items-center justify-center rounded-full bg-gradient-to-b from-white/20 to-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-8px_16px_rgba(255,255,255,0.06)] ring-1 ring-white/20 backdrop-blur-[100px]'
              : 'ml-auto flex size-[63px] items-center justify-center rounded-full bg-white/10'
          }
        >
          <FigmaIcon
            src={glassArrow ? FIGMA_ASSETS.arrowRightWhite : FIGMA_ASSETS.arrowRight}
            alt=""
            width={30}
            height={31}
          />
        </span>
      </motion.button>

      <div
        className="absolute left-[180px] w-[1710px] overflow-y-auto [scrollbar-width:thin]"
        style={{ top: LIST_TOP, bottom: 28 }}
      >
        <div className="pt-[64px]">
          {inbox.alerts.length === 0 && inbox.notices.length === 0 ? (
            <p className="pt-[40px] text-center font-medium text-[18px] text-figma-muted">
              Открытых алертов и уведомлений нет
            </p>
          ) : null}

          <div className="flex flex-col gap-[20px]">
            {inbox.alerts.map((card, index) => (
              <motion.div
                key={card.id}
                initial={animate ? { opacity: 0, y: 16 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={animate ? { ...fadeSoft, delay: index * 0.04 } : { duration: 0 }}
              >
                <InboxAlertCardView
                  title={card.title}
                  engineerName={card.engineerName}
                  badge={card.badge}
                  body={card.body}
                  primaryLabel={card.primaryLabel}
                  secondaryLabel={card.secondaryLabel}
                  onPrimary={card.requestId ? () => onOpenRequest(card.requestId!) : undefined}
                />
              </motion.div>
            ))}
          </div>

          {inbox.notices.length > 0 ? (
            <FigmaText className="mb-[16px] mt-[36px] font-bold text-[24px] text-figma-ink">
              Уведомления
            </FigmaText>
          ) : null}

          <div className="flex flex-col gap-[20px] pb-[24px]">
            {inbox.notices.map((card, index) => (
              <motion.div
                key={card.id}
                initial={animate ? { opacity: 0, y: 12 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={animate ? { ...fadeSoft, delay: 0.04 * (inbox.alerts.length + index) } : { duration: 0 }}
              >
                <NoticeCard card={card} />
              </motion.div>
            ))}
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute left-[180px] z-10 w-[1710px]"
        style={{ top: LIST_TOP - FADE_TUCK, height: FADE_TUCK + FADE_HEIGHT }}
      >
        <div
          className="absolute inset-x-0 top-0 bg-figma-canvas"
          style={{ height: STITCH_HEIGHT }}
        />
        <div
          className="absolute inset-x-0"
          style={{
            top: FADE_TUCK,
            height: FADE_HEIGHT,
            background:
              'linear-gradient(to bottom, var(--color-figma-canvas) 0, var(--color-figma-canvas) 10px, rgba(241, 241, 241, 0) 100%)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            maskImage: 'linear-gradient(to bottom, #000 0, #000 10px, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 0, #000 10px, transparent 100%)',
          }}
        />
      </div>
    </section>
  );
}

function NoticeCard({ card }: { card: InboxNoticeCard }) {
  return (
    <InboxNoticeCardView
      title={card.title}
      body={card.body}
      icon={NOTICE_ICON[card.toastKind]}
      onHide={() => dismissToast(card.id)}
    />
  );
}
