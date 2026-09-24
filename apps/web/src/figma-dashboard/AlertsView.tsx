import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AlertResolutionInput, DashboardSnapshot } from '../api/types';
import { AlertActions } from './AlertActions';
import { isAlertActionId } from '../domain/alerts';
import { type InboxNoticeCard, inboxFromSources } from './alertsInbox';
import { FIGMA_ASSETS } from './assets';
import { InboxAlertCardView, InboxButton, InboxNoticeCardView } from './inboxCard';
import { FigmaText } from './primitives';
import { dismissAllToasts, dismissToast, type ToastKind, type ToastNotification } from './toasts';

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
  token,
  snapshot,
  toasts,
  demoMode,
  motionOn,
  onOpenRequest,
  onMarkNoticeSeen,
  onResolve,
  writesDisabled,
}: {
  token?: string;
  snapshot: DashboardSnapshot | null;
  toasts: readonly ToastNotification[];
  demoMode: boolean;
  motionOn: boolean;
  onOpenRequest: (requestId: string) => void;
  onMarkNoticeSeen: (noticeId: string) => Promise<void>;
  onResolve: (id: string, input: AlertResolutionInput) => Promise<void>;
  writesDisabled: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const animate = motionOn && !reduceMotion;
  const inbox = inboxFromSources(snapshot, toasts, demoMode);
  const [clearing, setClearing] = useState(false);
  const [hiddenNoticeIds, setHiddenNoticeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sweptIds, setSweptIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sweeping, setSweeping] = useState(false);
  const [spotlight, setSpotlight] = useState<{ id: string; action: string | null } | null>(null);
  const [leaving, setLeaving] = useState<Readonly<Record<string, 1 | -1>>>({});
  const visibleAlerts = inbox.alerts.filter((card) => !sweptIds.has(card.id));
  const visibleNotices = inbox.notices.filter((card) => !hiddenNoticeIds.has(card.id));
  const glassArrow = visibleAlerts.length > 0;
  useEffect(() => {
    if (!sweeping) return;
    let cancelled = false;
    const queue = visibleAlerts;
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, animate ? ms : 0));
    void (async () => {
      for (const [index, card] of queue.entries()) {
        if (cancelled) return;
        const action = card.sourceAlert?.actions?.find((item) => isAlertActionId(item)) ?? null;
        setSpotlight({ id: card.id, action });
        await wait(1700);
        if (cancelled) return;
        setLeaving((current) => ({ ...current, [card.id]: index % 2 === 0 ? 1 : -1 }));
        await wait(520);
        if (cancelled) return;
        setSweptIds((current) => new Set(current).add(card.id));
        setSpotlight(null);
      }
      if (!cancelled) setSweeping(false);
    })();
    return () => {
      cancelled = true;
    };
    // The queue is the list at the moment the sweep starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweeping]);
  const listRef = useRef<HTMLDivElement>(null);
  const anchors = useRef<Array<{ id: string; offset: number }>>([]);
  function rememberScroll() {
    const list = listRef.current;
    if (!list) return;
    anchors.current = Array.from(list.querySelectorAll<HTMLElement>('[data-alert-id]'))
      .filter((node) => node.offsetTop + node.offsetHeight > list.scrollTop)
      .map((node) => ({ id: node.dataset.alertId ?? '', offset: node.offsetTop - list.scrollTop }));
  }
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-alert-id]'));
    for (const anchor of anchors.current) {
      const node = nodes.find((item) => item.dataset.alertId === anchor.id);
      if (node) {
        list.scrollTop = node.offsetTop - anchor.offset;
        break;
      }
    }
    rememberScroll();
  });

  return (
    <section className="absolute inset-0" aria-label="Алерты и уведомления">
      <FigmaText
        className="figma-nowrap absolute left-[180px] z-20 font-extrabold text-[48px] tracking-[-0.816px] text-figma-ink"
        style={{ top: TITLE_TOP }}
      >
        Алерты
      </FigmaText>
      <AiSweepSlider
        top={TITLE_TOP - 16}
        armed={glassArrow}
        engaged={sweeping}
        motionOn={animate}
        onCommit={() => {
          if (!sweeping && visibleAlerts.length > 0) setSweeping(true);
        }}
      />

      <div
        ref={listRef}
        onScroll={rememberScroll}
        className="absolute left-[180px] w-[1710px] overflow-y-auto [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ top: LIST_TOP, bottom: 28 }}
      >
        <div className="pt-[64px]">
          {inbox.alerts.length === 0 && visibleNotices.length === 0 ? (
            <p className="pt-[40px] text-center font-medium text-[18px] text-figma-muted">
              Открытых алертов и уведомлений нет
            </p>
          ) : null}

          <div className="flex flex-col gap-[20px]">
            {visibleAlerts.map((card, index) => (
              <motion.div
                key={card.id}
                data-alert-id={card.id}
                initial={animate ? { opacity: 0, y: 16 } : false}
                animate={(() => {
                  const direction = leaving[card.id];
                  return direction
                    ? { x: direction * 980, opacity: 0, rotate: direction * 2 }
                    : { opacity: 1, y: 0, x: 0 };
                })()}
                transition={
                  leaving[card.id]
                    ? { duration: animate ? 0.48 : 0, ease: fadeSoft.ease }
                    : animate
                      ? { ...fadeSoft, delay: index * 0.04 }
                      : { duration: 0 }
                }
              >
                <InboxAlertCardView
                  title={card.title}
                  engineerName={card.engineerName}
                  badge={card.badge}
                  body={card.body}
                  actions={
                    <AlertActions
                      token={token}
                      alert={card.sourceAlert}
                      snapshot={snapshot}
                      disabled={writesDisabled}
                      onResolve={onResolve}
                      spotlightAction={spotlight?.id === card.id ? spotlight.action : null}
                      leadingAction={
                        card.requestId ? (
                          <InboxButton
                            variant="outline"
                            onClick={() => card.requestId && onOpenRequest(card.requestId)}
                          >
                            <ArrowUpRight
                              size={22}
                              strokeWidth={1.8}
                              aria-hidden="true"
                              className="mr-[10px] shrink-0"
                            />
                            К заявке
                          </InboxButton>
                        ) : null
                      }
                    />
                  }
                />
              </motion.div>
            ))}
          </div>

          {visibleNotices.length > 0 ? (
            <div className="mb-[16px] mt-[36px] flex items-center gap-[12px]">
              <FigmaText className="font-bold text-[24px] text-figma-ink">Уведомления</FigmaText>
              <motion.button
                type="button"
                aria-label="Очистить уведомления"
                disabled={clearing}
                onClick={() => {
                  const cards = visibleNotices;
                  setClearing(true);
                  const flyMs = animate ? 480 + cards.length * 20 : 0;
                  window.setTimeout(() => {
                    setHiddenNoticeIds((current) => {
                      const next = new Set(current);
                      for (const card of cards) next.add(card.id);
                      return next;
                    });
                    dismissAllToasts();
                    void Promise.all(
                      cards
                        .map((card) => card.sourceNoticeId)
                        .filter((id): id is string => id !== null)
                        .map((id) => onMarkNoticeSeen(id)),
                    );
                    setClearing(false);
                  }, flyMs);
                }}
                className="flex size-[43px] items-center justify-center rounded-full bg-figma-ink text-white"
                whileHover={animate ? { scale: 1.08 } : undefined}
                whileTap={animate ? { scale: 0.9 } : undefined}
                transition={{ duration: 0.16 }}
              >
                <Trash2 size={22} strokeWidth={2} />
              </motion.button>
            </div>
          ) : null}

          <div className="flex flex-col gap-[20px] pb-[24px]">
            {visibleNotices.map((card, index) => (
              <motion.div
                key={card.id}
                initial={animate ? { opacity: 0, y: 12 } : false}
                animate={
                  clearing
                    ? { opacity: 0, x: index % 2 === 0 ? -900 : 900, rotate: index % 2 === 0 ? -8 : 8 }
                    : { opacity: 1, y: 0, x: 0, rotate: 0 }
                }
                transition={
                  clearing
                    ? { duration: 0.42, ease: fadeSoft.ease, delay: index * 0.02 }
                    : animate
                      ? { ...fadeSoft, delay: 0.04 * (inbox.alerts.length + index) }
                      : { duration: 0 }
                }
              >
                <NoticeCard card={card} onMarkSeen={onMarkNoticeSeen} />
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

function NoticeCard({
  card,
  onMarkSeen,
}: {
  card: InboxNoticeCard;
  onMarkSeen: (noticeId: string) => Promise<void>;
}) {
  return (
    <InboxNoticeCardView
      title={card.title}
      body={card.body}
      icon={NOTICE_ICON[card.toastKind]}
      onHide={() => {
        void (async () => {
          if (card.sourceNoticeId) await onMarkSeen(card.sourceNoticeId);
          dismissToast(card.id);
        })().catch(() => undefined);
      }}
    />
  );
}

const SWEEP_WIDTH = 426;
const THUMB = 63;
const TRAVEL = SWEEP_WIDTH - 20 - THUMB;

/**
 * Unlock-style control. Dragging the arrow to the sparkle, or a double tap,
 * starts a visual pass over the inbox. It does not resolve alerts.
 */
function AiSweepSlider({
  top,
  armed,
  engaged,
  motionOn,
  onCommit,
}: {
  top: number;
  armed: boolean;
  engaged: boolean;
  motionOn: boolean;
  onCommit: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [nudge, setNudge] = useState(false);
  const drag = useRef<{ x: number; progress: number } | null>(null);
  const lastTap = useRef(0);
  useEffect(() => {
    if (engaged) {
      setProgress(1);
      setNudge(false);
      return;
    }
    setProgress(0);
  }, [engaged]);
  useEffect(() => {
    if (engaged || !armed) return;
    const timer = window.setTimeout(() => setNudge(true), 3000);
    return () => window.clearTimeout(timer);
  }, [armed, engaged]);

  const commit = () => {
    if (!armed) {
      setProgress(0);
      setNudge(false);
      return;
    }
    setProgress(1);
    setNudge(false);
    onCommit();
  };

  return (
    <div
      className="absolute left-[430px] z-20 flex h-[79px] w-[426px] items-center overflow-hidden rounded-full bg-figma-ink pl-[10px] pr-[10px]"
      style={{ top }}
      onDoubleClick={() => {
        if (!engaged) commit();
      }}
    >
      <motion.button
        type="button"
        aria-label="Разобрать все в AI"
        className="absolute top-[8px] z-10 flex size-[63px] cursor-grab items-center justify-center rounded-full bg-figma-ink active:cursor-grabbing"
        style={{ left: 10, opacity: 0.28 + 0.72 * (engaged ? 1 : progress) }}
        animate={{ x: engaged ? TRAVEL : progress * TRAVEL }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        onPointerDown={(event) => {
          if (engaged) return;
          setNudge(false);
          drag.current = { x: event.clientX, progress };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const origin = drag.current;
          if (!origin) return;
          const next = Math.min(1, Math.max(0, origin.progress + (event.clientX - origin.x) / TRAVEL));
          setProgress(next);
        }}
        onPointerUp={() => {
          drag.current = null;
          if (progress > 0.82) commit();
          else setProgress(0);
          const now = Date.now();
          if (now - lastTap.current < 320) commit();
          lastTap.current = now;
        }}
      >
        <motion.span
          aria-hidden
          className="flex items-center justify-center text-white"
          animate={
            nudge && progress === 0 && !engaged && motionOn ? { x: [0, 7, 0] } : { x: 0 }
          }
          transition={
            nudge && progress === 0 && !engaged && motionOn
              ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0.2 }
          }
        >
          <ArrowRight size={28} strokeWidth={2} />
        </motion.span>
      </motion.button>
      <span
        className={`figma-nowrap pointer-events-none absolute inset-0 flex items-center justify-center font-semibold text-[18px] ${
          engaged ? 'client-ai-fill client-ai-text' : 'text-[#ededed]'
        }`}
        style={{ opacity: engaged ? 1 : 1 - progress }}
      >
        {engaged ? 'AI решает' : 'Разобрать все в AI'}
      </span>
      <span className="pointer-events-none absolute right-[10px] top-[9px] flex size-[60px] items-center justify-center rounded-full client-ai-fill">
        <span
          aria-hidden
          className="block bg-white"
          style={{
            width: 26,
            height: 26,
            WebkitMaskImage: 'url(/figma/icon-sparkles.svg)',
            maskImage: 'url(/figma/icon-sparkles.svg)',
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
          }}
        />
      </span>
    </div>
  );
}
