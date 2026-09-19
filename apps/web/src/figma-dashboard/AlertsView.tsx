import { motion, useReducedMotion } from 'framer-motion';
import type { DashboardSnapshot } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import { inboxFromSources, type InboxAlertCard, type InboxNoticeCard } from './alertsInbox';
import { FigmaIcon, FigmaText } from './primitives';
import { dismissToast, type ToastKind, type ToastNotification } from './toasts';

const HEADER_LIFT = 16;
const TITLE_TOP = 184 - HEADER_LIFT;
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
 * Figma ALERTS (49:5629): unresolved alerts first, then dismissible notices.
 * Alerts stay until the plan/system clears them. Notices only need an X.
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
        className="figma-nowrap absolute left-[180px] font-extrabold text-[48px] tracking-[-0.816px] text-figma-ink"
        style={{ top: TITLE_TOP }}
      >
        Алерты
      </FigmaText>
      <motion.button
        type="button"
        className="absolute left-[430px] flex h-[79px] w-[426px] items-center rounded-full bg-figma-ink pl-[10px] pr-[10px]"
        style={{ top: TITLE_TOP - 16 }}
        whileHover={animate ? { scale: 1.02 } : undefined}
        whileTap={animate ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.2 }}
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
        style={{ top: 265 - HEADER_LIFT, bottom: 28 }}
      >
        {inbox.alerts.length === 0 && inbox.notices.length === 0 ? (
          <p className="pt-[40px] text-center font-medium text-[18px] text-figma-muted">
            Открытых алертов и уведомлений нет
          </p>
        ) : null}

        <div className="flex flex-col gap-[20px]">
          {inbox.alerts.map((card, index) => (
            <motion.article
              key={card.id}
              initial={animate ? { opacity: 0, y: 16 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={animate ? { ...fadeSoft, delay: index * 0.04 } : { duration: 0 }}
            >
              <AlertCard card={card} onOpenRequest={onOpenRequest} />
            </motion.article>
          ))}
        </div>

        {inbox.notices.length > 0 ? (
          <FigmaText className="mt-[36px] mb-[16px] font-bold text-[24px] text-figma-ink">
            Уведомления
          </FigmaText>
        ) : null}

        <div className="flex flex-col gap-[16px] pb-[24px]">
          {inbox.notices.map((card, index) => (
            <motion.article
              key={card.id}
              initial={animate ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={animate ? { ...fadeSoft, delay: 0.04 * (inbox.alerts.length + index) } : { duration: 0 }}
            >
              <NoticeCard card={card} />
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}

function AlertCard({
  card,
  onOpenRequest,
}: {
  card: InboxAlertCard;
  onOpenRequest: (requestId: string) => void;
}) {
  return (
    <div className="relative min-h-[211px] overflow-hidden rounded-[20px] bg-white pl-[10px] shadow-[0_10px_28px_rgba(39,41,48,0.08)]">
      <div className="absolute inset-y-0 left-0 w-[10px] bg-figma-bee" aria-hidden />
      <div className="px-[30px] py-[24px] pr-[28px]">
        <div className="flex flex-wrap items-center gap-[16px]">
          <p className="font-bold text-[24px] leading-none text-black">{card.title}</p>
          {card.engineerName ? (
            <>
              <span className="size-[5px] rounded-full bg-figma-ink" aria-hidden />
              <p className="font-bold text-[24px] leading-none text-black">{card.engineerName}</p>
            </>
          ) : null}
          {card.badge ? (
            <span className="inline-flex items-center rounded-[20px] bg-figma-track px-[20px] py-[12px] font-medium text-[20px] tracking-[-0.34px] text-figma-ink">
              {card.badge}
            </span>
          ) : null}
        </div>
        <p className="mt-[24px] max-w-[1234px] font-semibold text-[20px] tracking-[-0.34px] text-[#727478]">
          {card.body}
        </p>
        <div className="mt-[28px] flex flex-wrap items-center gap-[20px]">
          {card.primaryLabel ? (
            <button
              type="button"
              className="rounded-[20px] bg-figma-bee px-[32px] py-[16px] font-semibold text-[20px] tracking-[-0.6px] text-figma-ink"
              onClick={() => {
                if (card.requestId) onOpenRequest(card.requestId);
              }}
            >
              {card.primaryLabel}
            </button>
          ) : null}
          {card.secondaryLabel ? (
            <button
              type="button"
              className="rounded-[20px] border border-figma-ink bg-white px-[32px] py-[16px] font-semibold text-[20px] tracking-[-0.6px] text-figma-ink"
            >
              {card.secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-[8px] font-semibold text-[18px] tracking-[-0.54px] text-figma-ink"
          >
            Разобрать в AI
            <FigmaIcon src={FIGMA_ASSETS.iconSparkles} alt="" width={20} height={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

function NoticeCard({ card }: { card: InboxNoticeCard }) {
  const icon = NOTICE_ICON[card.toastKind];
  return (
    <div className="relative min-h-[132px] overflow-hidden rounded-[20px] bg-figma-ink px-[24px] py-[20px] pr-[64px]">
      <div className="flex items-start gap-[16px]">
        <span className="flex size-[43px] shrink-0 items-center justify-center rounded-[10px]">
          <FigmaIcon src={icon.src} alt="" width={icon.width} height={icon.height} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-[20px] leading-none text-white">{card.title}</p>
          <p className="mt-[12px] font-medium text-[18px] leading-[22px] text-white/80">{card.body}</p>
        </div>
      </div>
      <button
        type="button"
        aria-label="Закрыть уведомление"
        className="absolute right-[16px] top-[13px] flex size-[29px] items-center justify-center transition-transform duration-200 hover:scale-110"
        onClick={() => dismissToast(card.id)}
      >
        <span className="-rotate-45">
          <FigmaIcon src={FIGMA_ASSETS.toastClose} alt="" width={20} height={20} />
        </span>
      </button>
    </div>
  );
}
