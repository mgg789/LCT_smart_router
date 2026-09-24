import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight, ArrowUpRight, Info, Route, Sparkles, UserCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import { useAlerts } from '@/entities/alert';
import { useEngineers } from '@/entities/engineer';
import { useRequests } from '@/entities/request';
import { useConversation } from '@/features/ai/ask-assistant';
import { useMarkAlertSeen } from '@/features/alert/mark-seen';
import { cn, staggered, useMotionOn } from '@/shared/lib';
import type { InboxAlertCard, InboxNoticeCard } from '../model/inbox';
import { buildInbox } from '../model/inbox';

/** Icons for notices by event; anything else gets the plain information mark. */
const NOTICE_ICON: Record<string, LucideIcon> = {
  plan_rebuilt: Route,
  engineer_line_started: UserCheck,
};

/**
 * The action button of the drawing (49:5702 / 49:5704): one shape, three fills.
 * A disabled one keeps its shape and says why it is off in its title.
 */
function InboxButton({
  variant,
  children,
  onClick,
  disabledReason,
}: {
  variant: 'bee' | 'outline' | 'ink';
  children: ReactNode;
  onClick?: () => void;
  disabledReason?: string;
}) {
  const tone = {
    bee: 'bg-accent text-ink enabled:hover:brightness-105',
    outline: 'border border-ink bg-surface text-ink enabled:hover:bg-muted',
    ink: 'border border-white bg-ink text-white enabled:hover:brightness-125',
  }[variant];
  return (
    <button
      className={cn(
        'flex items-center justify-center rounded-[20px] px-8 py-4 font-semibold text-[20px] tracking-[-0.6px]',
        'transition-[transform,filter,background-color] duration-300 ease-out',
        'enabled:hover:scale-[1.02] enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45',
        tone,
      )}
      disabled={disabledReason !== undefined}
      onClick={onClick}
      title={disabledReason}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * «Разобрать в AI» under a card: asks the explain agent about this alert and
 * moves to the assistant, where the answer streams in.
 *
 * The explanation is asked for by scope and id — the screen never composes the
 * question or the reasoning, and the agent answers in one step from the stored
 * reasons and evidence.
 */
function AiLink({ tone, onExplain }: { tone: 'ink' | 'white'; onExplain: () => void }) {
  return (
    <button
      className={cn(
        'flex items-center gap-2 font-semibold text-[18px] tracking-[-0.54px]',
        'transition-opacity duration-150 hover:opacity-70',
        tone === 'white' ? 'text-white' : 'text-ink',
      )}
      onClick={onExplain}
      type="button"
    >
      Разобрать в AI
      <ArrowUpRight aria-hidden size={22} />
    </button>
  );
}

function AlertCard({
  card,
  onOpenRequest,
  onExplain,
  onWriteEngineer,
}: {
  card: InboxAlertCard;
  onOpenRequest: (id: string) => void;
  onExplain: () => void;
  onWriteEngineer: (engineerId: string) => void;
}) {
  const secondary = card.actionLabels[0];
  // «Написать» is the one decision that needs no form of its own: the chat is
  // the form. The rest still wait for a drawing.
  const writable = card.actions[0] === 'message' && card.engineerId !== null;
  return (
    <article className="flex min-h-[211px] w-full flex-col rounded-[20px] bg-surface px-[30px] pt-[19px] pb-6">
      <div className="flex flex-wrap items-center gap-4">
        <h3 className="font-bold text-[24px] text-black leading-none">{card.title}</h3>
        {card.engineerName ? (
          <>
            <span aria-hidden className="size-[5px] rounded-full bg-ink" />
            <span className="font-bold text-[24px] text-black leading-none">
              {card.engineerName}
            </span>
          </>
        ) : null}
        <span className="inline-flex h-[42px] items-center rounded-full bg-muted px-5 font-medium text-[20px] text-ink tracking-[-0.34px]">
          {card.badge}
        </span>
      </div>

      <p className="mt-4 max-w-[1234px] font-semibold text-[20px] text-ink-soft tracking-[-0.34px]">
        {card.body}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-5 pt-5">
        {card.requestId ? (
          <InboxButton onClick={() => onOpenRequest(card.requestId as string)} variant="bee">
            К заявке
          </InboxButton>
        ) : null}
        {secondary ? (
          writable ? (
            <InboxButton
              onClick={() => onWriteEngineer(card.engineerId as string)}
              variant="outline"
            >
              {secondary}
            </InboxButton>
          ) : (
            // The server names the decisions it accepts, but the rest each need a
            // form the drawing does not have yet — so the button names it and
            // stays off.
            <InboxButton
              disabledReason="Форма этого решения ещё не нарисована — принять его можно, когда появится макет"
              variant="outline"
            >
              {secondary}
            </InboxButton>
          )
        ) : null}
        <AiLink onExplain={onExplain} tone="ink" />
      </div>
    </article>
  );
}

function NoticeCard({
  card,
  hiding,
  onHide,
}: {
  card: InboxNoticeCard;
  hiding: boolean;
  onHide: () => void;
}) {
  const Icon = NOTICE_ICON[card.code] ?? Info;
  return (
    <article className="flex min-h-[211px] w-full flex-col rounded-[20px] bg-ink px-[30px] pt-[19px] pb-6">
      <div className="flex flex-wrap items-center gap-4">
        <h3 className="font-bold text-[24px] text-white leading-none">{card.title}</h3>
        <Icon aria-hidden className="text-white" size={26} />
      </div>
      <p className="mt-4 max-w-[1234px] font-semibold text-[20px] text-white tracking-[-0.34px]">
        {card.body}
      </p>
      <div className="mt-auto flex items-center gap-5 pt-5">
        <InboxButton
          disabledReason={hiding ? 'Скрываем…' : undefined}
          onClick={onHide}
          variant="ink"
        >
          Скрыть
        </InboxButton>
      </div>
    </article>
  );
}

/**
 * The Alerts section, ported from `apps/web` (Figma 49:5629 / 49:5696).
 *
 * Alerts that still wait for a decision come first, then notices — both newest
 * first, both revealed one after another. «К заявке» opens the request on the
 * day screen; «Скрыть» marks a notice seen. Deciding an alert is left off, as it
 * is in `apps/web`: the server offers the decisions, but the forms they need are
 * not in the drawing yet, so their buttons name them and stay disabled.
 */
export function AlertsPage() {
  const alertsQuery = useAlerts();
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const markSeen = useMarkAlertSeen();
  const navigate = useNavigate();
  const { ask, explain } = useConversation();
  const motionOn = useMotionOn();

  const inbox = useMemo(() => {
    const engineers = new Map(
      (engineersQuery.data?.engineers ?? []).map((engineer) => [engineer.id, engineer.displayName]),
    );
    const requests = new Map(
      (requestsQuery.data?.requests ?? []).map((request) => [request.id, request]),
    );
    return buildInbox(alertsQuery.data?.alerts ?? [], {
      engineerName: (id) => engineers.get(id) ?? null,
      request: (id) => requests.get(id) ?? null,
    });
  }, [alertsQuery.data, engineersQuery.data, requestsQuery.data]);

  const openRequest = (requestId: string) =>
    navigate(`${ROUTES.plan}?request=${encodeURIComponent(requestId)}`);

  /** Asks the explain agent about one alert, then goes where the answer appears. */
  const explainAlert = (card: InboxAlertCard) => {
    void explain({ scope: 'alert', alertId: card.id }, `Разобрать алерт: ${card.title}`);
    navigate(ROUTES.ai);
  };

  /**
   * «Разобрать все» is an ordinary question to the assistant, not a scope: the
   * explain agent answers about one object at a time, and inventing a combined
   * verdict here would be this screen reasoning on its own. The assistant reads
   * the day's alerts with its own tools and answers from them.
   */
  const explainAll = () => {
    void ask('Разбери открытые алерты дня: какие требуют решения в первую очередь и почему?');
    navigate(ROUTES.ai);
  };

  // Cards arrive one after another; a hidden notice slides away and the rest
  // close the gap behind it.
  const reveal = (index: number) => ({
    initial: motionOn ? { opacity: 0, y: 16 } : false,
    animate: { opacity: 1, y: 0 },
    exit: motionOn ? { opacity: 0, x: 48 } : undefined,
    layout: motionOn,
    transition: motionOn ? staggered(index) : { duration: 0 },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-8">
        <h1 className="font-display text-[48px] text-ink leading-none">Алерты</h1>
        <button
          className={cn(
            'flex h-[79px] w-[426px] items-center rounded-full bg-ink px-[10px]',
            'transition-transform duration-150 enabled:active:scale-[0.99] disabled:opacity-45',
          )}
          disabled={inbox.alerts.length === 0}
          onClick={explainAll}
          title={
            inbox.alerts.length === 0
              ? 'Открытых алертов нет'
              : 'Спросить ассистента об алертах дня'
          }
          type="button"
        >
          <span className="flex size-[60px] items-center justify-center rounded-full bg-accent text-ink">
            <Sparkles aria-hidden size={26} />
          </span>
          <span className="ml-[15px] font-semibold text-[#ededed] text-[18px]">
            Разобрать все в AI
          </span>
          <span className="ml-auto flex size-[63px] items-center justify-center rounded-full bg-white/10 text-white">
            <ArrowRight aria-hidden size={30} />
          </span>
        </button>
      </div>

      <div
        className="relative mt-6 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]"
        // The list passes under the header instead of being cut on a hard edge.
        style={{ maskImage: 'linear-gradient(to bottom, transparent 0, #000 40px)' }}
      >
        <div className="pt-10 pb-6">
          {alertsQuery.isPending ? (
            <p className="text-center text-[18px] text-ink-soft">Загружаем алерты…</p>
          ) : null}
          {alertsQuery.isError ? (
            <p className="text-center text-[18px] text-danger">
              Не удалось прочитать алерты. Проверьте, что System Layer запущен.
            </p>
          ) : null}
          {alertsQuery.data && inbox.alerts.length === 0 && inbox.notices.length === 0 ? (
            <p className="pt-10 text-center font-medium text-[18px] text-ink-soft">
              Открытых алертов и уведомлений нет
            </p>
          ) : null}

          <ul className="flex flex-col gap-5">
            <AnimatePresence>
              {inbox.alerts.map((card, index) => (
                <motion.li key={card.id} {...reveal(index)}>
                  <AlertCard
                    card={card}
                    onExplain={() => explainAlert(card)}
                    onOpenRequest={openRequest}
                    onWriteEngineer={(engineerId) =>
                      navigate(`${ROUTES.chats}?engineer=${encodeURIComponent(engineerId)}`)
                    }
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          {inbox.notices.length > 0 ? (
            <h2 className="mt-9 mb-4 font-bold text-[24px] text-ink">Уведомления</h2>
          ) : null}

          <ul className="flex flex-col gap-5">
            <AnimatePresence>
              {inbox.notices.map((card, index) => (
                <motion.li key={card.id} {...reveal(inbox.alerts.length + index)}>
                  <NoticeCard
                    card={card}
                    hiding={markSeen.isPending && markSeen.variables === card.id}
                    onHide={() => markSeen.mutate(card.id)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          {markSeen.isError ? (
            <p className="mt-4 text-[14px] text-danger" role="alert">
              Уведомление не скрылось: {markSeen.error.code}.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
